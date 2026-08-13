/**
 * MCP用のOAuth 2.1。
 *
 * 方針:
 *   - 本人確認は**既存のLift & Leanアカウント**（Appwrite Auth）で行う。
 *     ChatGPTの会話にパスワードを書かせない／APIキーを配らない／共通の合言葉を作らない
 *   - アクセストークンは**この連携専用に作ったAppwriteセッション**そのもの。
 *     独自のトークン形式を作らない。取り消しはセッションを消すだけで済み、
 *     アプリ側のログインには影響しない
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
import { authorizationCodeStore } from './store.js';
import type { AuthorizationCodeRecord } from './store.js';

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
 */
export async function grantAuthorization(input: ConsentInput): Promise<string> {
  if (!isAllowedRedirectUri(input.redirectUri)) {
    throw new AppError('invalid_redirect', 400, '戻り先のURLが許可されていません。');
  }

  const session = await logIn(input.email, input.password);
  const user = await resolveUser(session.secret);
  if (!user.emailVerified) {
    // 連携専用に作ったセッションは、使えないと分かった時点で片付ける
    await logOut(session.secret).catch(() => undefined);
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
    resource: input.resource,
    sessionSecret: session.secret,
    userId: user.userId,
    expiresAt: Date.now() + 120_000,
  };
  await authorizationCodeStore.save(code, record);
  return code;
}

export interface ExchangeResult {
  accessToken: string;
  scopes: string[];
  userId: string;
}

/** 認可コードをアクセストークンに交換する（1回だけ使える） */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri?: string,
): Promise<ExchangeResult> {
  const record = await authorizationCodeStore.take(code);
  if (!record) throw new AppError('invalid_grant', 400, '認可コードが無効か期限切れです。');
  if (record.clientId !== clientId) throw new AppError('invalid_grant', 400, '認可コードが無効です。');
  if (redirectUri && record.redirectUri !== redirectUri) {
    throw new AppError('invalid_grant', 400, '認可コードが無効です。');
  }
  if (!verifyPkce(record.codeChallenge, codeVerifier)) {
    throw new AppError('invalid_grant', 400, '認可コードが無効です。');
  }

  return { accessToken: record.sessionSecret, scopes: record.scopes, userId: record.userId };
}

// ---------------------------------------------------------------- トークンの検証

export interface VerifiedToken {
  userId: string;
  sessionSecret: string;
  scopes: string[];
}

/**
 * アクセストークン（= 連携用のAppwriteセッション）を確かめる。
 *
 * 失効・取り消し済み・メール未確認はすべてここで弾く。
 * **userIdはトークンからしか決まらない**（引数やbodyのuserIdは一切見ない）。
 */
export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  const user = await resolveUser(token); // 無効なら AuthError
  if (!user.emailVerified) {
    throw new AuthError('メールアドレスの確認が済んでいません。');
  }
  return { userId: user.userId, sessionSecret: token, scopes: [...MCP_SCOPES] };
}

/** 連携の解除。この連携用に作ったセッションだけを消す */
export async function revokeAccessToken(token: string): Promise<void> {
  await logOut(token).catch(() => undefined);
}

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
