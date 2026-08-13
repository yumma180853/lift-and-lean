/**
 * MCP用のOAuth 2.1。
 *
 * 方針:
 *   - 本人確認は**既存のLift & Leanアカウント**（Appwrite Auth）で行う。
 *     ChatGPTの会話にパスワードを書かせない／APIキーを配らない／共通の合言葉を作らない
 *   - ChatGPTへ渡すのは**Lift & Lean が /api/mcp 向けに発行した専用トークン**だけ。
 *     Appwriteのセッションはサーバー側にとどめ、外へは一切出さない。
 *     他所向けの資格情報をそのまま渡す（素通し）のは仕様で禁じられている
 *   - トークンは相手（resource）を記録に固定し、**使うたびに一致を確かめる**
 *   - クライアント登録は保存を持たず、**戻り先URLの許可リスト**で守る。
 *     公開クライアント＋PKCE(S256)が前提なので、識別子そのものに秘密は無い
 *
 * 仕様の根拠: MCP authorization（RFC 9728 / RFC 8414 / RFC 8707 / PKCE S256）。
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { AppError, AuthError } from '../_core/errors.js';
import { logIn, logOut, resolveUser } from '../_appwrite/auth.js';
import { publicAppUrl } from '../_appwrite/client.js';
import { authorizationCodeStore, kvRecordStore } from './store.js';
import type { AuthorizationCodeRecord, AuthorizationCodeStore, RecordStore } from './store.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  issueGrant,
  resolveAccessToken,
  revokeByToken,
  rotateRefreshToken,
  seal,
  unseal,
} from './tokens.js';
import type { IssuedTokens } from './tokens.js';

/** 差し替え口。テストではAppwriteにもKVにも繋がずに一連の流れを確かめる */
export interface OAuthDeps {
  /** 認可コードの保管庫 */
  store?: AuthorizationCodeStore;
  /** 発行したトークンの保管庫 */
  tokens?: RecordStore;
  /** 同意画面での本人確認 */
  authenticate?: (email: string, password: string) => Promise<{ sessionSecret: string; userId: string; emailVerified: boolean }>;
  /** 保持しているAppwriteセッションがまだ生きているかの確認 */
  resolveSession?: (appwriteSession: string) => Promise<{ userId: string; emailVerified: boolean }>;
  /** 連携解除時のAppwriteセッション削除 */
  deleteSession?: (appwriteSession: string) => Promise<void>;
}

const defaultAuthenticate = async (email: string, password: string) => {
  const session = await logIn(email, password);
  const user = await resolveUser(session.secret);
  return { sessionSecret: session.secret, userId: user.userId, emailVerified: user.emailVerified };
};

const defaultResolveSession = async (appwriteSession: string) => {
  const user = await resolveUser(appwriteSession);
  return { userId: user.userId, emailVerified: user.emailVerified };
};

const defaultDeleteSession = async (appwriteSession: string) => {
  await logOut(appwriteSession).catch(() => undefined);
};

const codeStoreOf = (deps: OAuthDeps): AuthorizationCodeStore => deps.store ?? authorizationCodeStore;
const tokenStoreOf = (deps: OAuthDeps): RecordStore => deps.tokens ?? kvRecordStore;

export const MCP_SCOPES = ['data:read', 'log:write'] as const;

/** 戻り先として許可するURL。ChatGPTの受け口と、検証用のローカルだけ */
const ALLOWED_REDIRECT_PATTERNS: RegExp[] = [
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/,
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chat\.openai\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/,
  // MCP Inspector などローカルの検証クライアント
  /^http:\/\/localhost:\d+\/[A-Za-z0-9/_-]*$/,
  /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9/_-]*$/,
];

export function isAllowedRedirectUri(uri: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some(pattern => pattern.test(uri));
}

export const mcpResourceUrl = (): string => `${publicAppUrl()}/api/mcp`;

/**
 * 認可サーバーの識別子。
 * **保護リソース側と認可サーバー側で同じ表記でなければならない**
 * （食い違うとクライアントの発見処理が失敗する）ので、URLの正規形に揃える。
 */
export const issuerUrl = (): string => new URL(publicAppUrl()).href;

// ---------------------------------------------------------------- 相手の固定

/**
 * RFC 8707 の資源識別子を比べられる形に揃える。
 * 綴りの揺れ（大文字小文字・末尾のスラッシュ・#以降）で
 * 一致判定が緩くならないようにする。
 */
export function canonicalResource(value: string | URL): string {
  const url = new URL(String(value));
  url.hash = '';
  url.search = '';
  let text = url.href;
  if (text.endsWith('/') && url.pathname !== '/') text = text.slice(0, -1);
  return text;
}

/** このサーバーが受け付ける唯一の相手かどうか */
export function isMcpResource(value: string | URL | undefined): boolean {
  if (value === undefined) return false;
  try {
    return canonicalResource(value) === canonicalResource(mcpResourceUrl());
  } catch {
    return false;
  }
}

const invalidTarget = (): AppError =>
  new AppError('invalid_target', 400, 'このトークンの発行先が正しくありません。');

/**
 * 要求された相手を確かめて、記録に残す値を決める。
 * 指定が無いときは**このMCPサーバー自身**に固定する（他所へは使えない）。
 */
function resolveRequestedResource(requested: string | URL | undefined): string {
  if (requested === undefined || requested === '') return canonicalResource(mcpResourceUrl());
  if (!isMcpResource(requested)) throw invalidTarget();
  return canonicalResource(requested);
}

// ---------------------------------------------------------------- PKCE

export function verifyPkce(codeChallenge: string, codeVerifier: string): boolean {
  const digest = createHash('sha256').update(codeVerifier).digest('base64url');
  return digest === codeChallenge;
}

// ---------------------------------------------------------------- 認可コード

const newCode = (): string => randomBytes(32).toString('base64url');

export interface ConsentInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  email: string;
  password: string;
}

/**
 * 本人確認をして認可コードを発行する。
 *
 * ここで**この連携専用のセッションを新しく作る**ので、
 * あとで連携を解除しても本人のアプリのログインは切れない。
 * そのセッションは**認可コードから導いた鍵で封をして**置く。
 * 保管庫を覗いただけでは取り出せない。
 */
export async function grantAuthorization(input: ConsentInput, deps: OAuthDeps = {}): Promise<string> {
  if (!isAllowedRedirectUri(input.redirectUri)) {
    throw new AppError('invalid_redirect', 400, '戻り先のURLが許可されていません。');
  }
  const resource = resolveRequestedResource(input.resource);

  const user = await (deps.authenticate ?? defaultAuthenticate)(input.email, input.password);
  if (!user.emailVerified) {
    // 連携専用に作ったセッションは、使えないと分かった時点で片付ける
    await (deps.deleteSession ?? defaultDeleteSession)(user.sessionSecret).catch(() => undefined);
    throw new AppError(
      'email_not_verified',
      403,
      'メールアドレスの確認が済んでいません。アプリで確認を済ませてから連携してください。',
    );
  }

  const code = newCode();
  const record: AuthorizationCodeRecord = {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: input.scopes.length > 0 ? input.scopes : [...MCP_SCOPES],
    resource,
    sealedSession: seal(code, user.sessionSecret),
    userId: user.userId,
    expiresAt: Date.now() + 120_000,
  };
  await codeStoreOf(deps).save(code, record);
  return code;
}

/**
 * 認可コードをアクセストークンに交換する（1回だけ使える）。
 *
 * ここで返すのは**このMCPサーバー向けに発行した専用トークン**。
 * Appwriteのセッションは封を開けてサーバー側の記録に移し替えるだけで、外へは出さない。
 *
 * PKCEの照合は呼び出し元（MCP SDKのtokenハンドラ）が
 * `challengeForAuthorizationCode` の値を使って済ませている。
 * 検証子が渡された場合だけ、ここでも念のため照合する。
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string | undefined,
  clientId: string,
  redirectUri?: string,
  requestedResource?: string | URL,
  deps: OAuthDeps = {},
): Promise<IssuedTokens> {
  const record = await codeStoreOf(deps).take(code);
  if (!record) throw new AppError('invalid_grant', 400, '認可コードが無効か期限切れです。');
  if (record.clientId !== clientId) throw new AppError('invalid_grant', 400, '認可コードが無効です。');
  if (redirectUri && record.redirectUri !== redirectUri) {
    throw new AppError('invalid_grant', 400, '認可コードが無効です。');
  }
  if (codeVerifier !== undefined && !verifyPkce(record.codeChallenge, codeVerifier)) {
    throw new AppError('invalid_grant', 400, '認可コードが無効です。');
  }
  // 認可時に決めた相手と、交換時に求められた相手が食い違うトークンは出さない
  if (requestedResource !== undefined && canonicalResource(requestedResource) !== record.resource) {
    throw invalidTarget();
  }

  return issueGrant({
    userId: record.userId,
    resource: record.resource,
    scopes: record.scopes,
    appwriteSession: unseal(code, record.sealedSession),
  }, tokenStoreOf(deps));
}

/** 更新トークンを入れ替える（公開クライアントでは毎回入れ替えるのが必須） */
export async function refreshTokens(
  refreshToken: string,
  requestedResource?: string | URL,
  deps: OAuthDeps = {},
): Promise<IssuedTokens> {
  const issued = await rotateRefreshToken(
    refreshToken,
    tokenStoreOf(deps),
    deps.deleteSession ?? defaultDeleteSession,
  );
  if (requestedResource !== undefined && canonicalResource(requestedResource) !== issued.resource) {
    // 別の相手向けに求められたら、出した分ごと取り消す
    await revokeByToken(issued.accessToken, tokenStoreOf(deps));
    throw invalidTarget();
  }
  return issued;
}

// ---------------------------------------------------------------- トークンの検証

export interface VerifiedToken {
  userId: string;
  /** サーバー側だけで使うAppwriteのセッション。応答にもログにも出さない */
  sessionSecret: string;
  scopes: string[];
  resource: string;
  /** 秒。SDKの検証がそのまま使う */
  expiresAt: number;
}

/**
 * アクセストークンを確かめる。
 *
 * 1. **自分が出したトークンか**（保管庫に記録があるか）
 * 2. **自分向けに出したものか**（resourceが /api/mcp と一致するか）
 * 3. 期限内か・取り消されていないか
 * 4. 裏で持っているAppwriteセッションがまだ生きていて、メール確認済みか
 *
 * **userIdはトークンからしか決まらない**（引数やbodyのuserIdは一切見ない）。
 * Appwriteのセッションを直接持ち込まれても、1で弾かれる。
 */
export async function verifyAccessToken(token: string, deps: OAuthDeps = {}): Promise<VerifiedToken> {
  const record = await resolveAccessToken(token, tokenStoreOf(deps));

  // 相手の確認。仕様上ここは必須で、他所向けのトークンを受け取ってはいけない
  if (!isMcpResource(record.resource)) {
    throw new AuthError('このトークンはこのサーバー向けに発行されていません。');
  }

  const user = await (deps.resolveSession ?? defaultResolveSession)(record.appwriteSession);
  if (user.userId !== record.userId) {
    throw new AuthError('トークンが無効です。');
  }
  if (!user.emailVerified) {
    throw new AuthError('メールアドレスの確認が済んでいません。');
  }

  return {
    userId: record.userId,
    sessionSecret: record.appwriteSession,
    scopes: record.scopes,
    resource: record.resource,
    expiresAt: record.expiresAt,
  };
}

/** 連携の解除。この連携用に作ったセッションだけを消す */
export async function revokeAccessToken(token: string, deps: OAuthDeps = {}): Promise<void> {
  await revokeByToken(token, tokenStoreOf(deps), deps.deleteSession ?? defaultDeleteSession);
}

export { ACCESS_TOKEN_TTL_SECONDS };

// ---------------------------------------------------------------- メタデータ

export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [issuerUrl()],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Lift & Lean',
    resource_documentation: `${publicAppUrl()}/privacy`,
  };
}

/** 401のときに返す challenge（どこで認可を受ければよいか示す） */
export function wwwAuthenticateHeader(error?: string, description?: string): string {
  const parts = [`Bearer resource_metadata="${publicAppUrl()}/.well-known/oauth-protected-resource"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

/** express のレスポンスへ認可エラーをリダイレクトで返す */
export function redirectWithError(res: Response, redirectUri: string, error: string, state?: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}
