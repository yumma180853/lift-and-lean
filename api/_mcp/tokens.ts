/**
 * MCP専用のアクセストークン。
 *
 * **ChatGPTへ渡すのはここで作ったトークンだけ**で、Appwriteのセッションは渡さない。
 * Appwriteのセッションは「Appwriteに対する利用者本人の資格情報」であって、
 * MCPの資源（/api/mcp）へ向けて発行されたものではない。
 * それをそのまま配ると、受け取った側がAppwriteのAPIを直接叩けてしまうし、
 * MCPの仕様が禁じている**トークンの素通し**そのものになる。
 *
 * 作りは標準のOAuth 2.1に寄せる。独自の認証手順は作らない。
 *   - ランダムな不透明トークン（中身に意味を持たせない）
 *   - 相手（resource = /api/mcp）を記録に固定し、**使うたびに一致を確かめる**
 *   - アクセストークンは短命。更新トークンは公開クライアント向けに**毎回入れ替える**
 *   - 生の値は保存しない。ハッシュを鍵にして引く
 *   - 取り消せる（連携1件ぶんをまとめて無効にする）
 *
 * Appwriteのセッションは**提示されたトークンから導いた鍵**で封をして置く。
 * 置き場所（KV）ごと抜かれても、トークンを持っていない限り開けられない。
 * 使うのは標準の道具（HKDF-SHA256 と AES-256-GCM）だけで、暗号は自作しない。
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../_core/errors.js';
import type { RecordStore } from './store.js';

/** アクセストークンの寿命。漏れたときの影響を短く抑える */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** 更新トークンの寿命。使うたびに入れ替わる */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const GRANT_TTL_SECONDS = REFRESH_TOKEN_TTL_SECONDS + 60 * 60;

// ---------------------------------------------------------------- 封をする

const SEAL_SALT = Buffer.from('lift-and-lean:mcp:v1');
const SEAL_INFO = Buffer.from('appwrite-session-seal');

/** 提示された値そのものから鍵を導く。保存側には鍵の材料が残らない */
const sealKey = (material: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), SEAL_SALT, SEAL_INFO, 32));

export function seal(material: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(material), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
}

export function unseal(material: string, sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new AppError('invalid_token', 401, 'トークンが無効です。');
  const [iv, tag, body] = parts.map(part => Buffer.from(part, 'base64url'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(material), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // 封が開かない＝トークンと保存内容の対応が壊れている
    throw new AppError('invalid_token', 401, 'トークンが無効です。');
  }
}

// ---------------------------------------------------------------- トークン

/** 生成した値は保存しない。引き当てにはハッシュを使う */
const newSecret = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const accessKey = (raw: string): string => `mcp:token:access:${tokenHash(raw)}`;
const refreshKey = (raw: string): string => `mcp:token:refresh:${tokenHash(raw)}`;
const grantKey = (grantId: string): string => `mcp:grant:${grantId}`;

/** 連携1件ぶん。取り消しはこの単位で行う */
interface GrantRecord {
  grantId: string;
  userId: string;
  resource: string;
  scopes: string[];
  /** 今有効な更新トークン。これ以外が出てきたら使い回しとみなす */
  currentRefreshHash: string;
  createdAt: number;
}

interface TokenRecord {
  grantId: string;
  userId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  /** このトークンから導いた鍵で封をしたAppwriteのセッション */
  sealedSession: string;
}

interface RefreshRecord extends TokenRecord {
  /** 入れ替え済み。これが出てきたら使い回し */
  used?: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  resource: string;
}

export interface GrantInput {
  userId: string;
  resource: string;
  scopes: string[];
  /** Lift & Leanのサーバー側だけが持つ。ChatGPTへは渡さない */
  appwriteSession: string;
}

const invalidToken = (): AppError => new AppError('invalid_token', 401, 'トークンが無効です。');
const invalidGrant = (): AppError => new AppError('invalid_grant', 400, '更新トークンが無効です。');

/** 連携を1件作り、その最初のトークン一式を発行する */
export async function issueGrant(input: GrantInput, store: RecordStore): Promise<IssuedTokens> {
  const grantId = randomBytes(16).toString('hex');
  return writeTokens(grantId, input, store, Date.now());
}

/** 同じ連携のまま、トークン一式を作り直す（更新時） */
async function writeTokens(
  grantId: string,
  input: GrantInput,
  store: RecordStore,
  createdAt: number,
): Promise<IssuedTokens> {
  const accessToken = newSecret();
  const refreshToken = newSecret();
  const now = Date.now();

  const shared = {
    grantId,
    userId: input.userId,
    resource: input.resource,
    scopes: input.scopes,
  };

  const access: TokenRecord = {
    ...shared,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    sealedSession: seal(accessToken, input.appwriteSession),
  };
  const refresh: RefreshRecord = {
    ...shared,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    sealedSession: seal(refreshToken, input.appwriteSession),
  };
  const grant: GrantRecord = {
    ...shared,
    currentRefreshHash: tokenHash(refreshToken),
    createdAt,
  };

  await store.put(grantKey(grantId), grant, GRANT_TTL_SECONDS);
  await store.put(accessKey(accessToken), access, ACCESS_TOKEN_TTL_SECONDS);
  await store.put(refreshKey(refreshToken), refresh, REFRESH_TOKEN_TTL_SECONDS);

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scopes: input.scopes,
    resource: input.resource,
  };
}

export interface ResolvedToken {
  grantId: string;
  userId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  /** サーバー側でだけ使う。応答にもログにも出さない */
  appwriteSession: string;
}

/**
 * アクセストークンを確かめる。
 *
 * ここを通らない値は一切受け付けない。
 * Appwriteのセッションを持ち込まれても、記録が無いので弾かれる。
 */
export async function resolveAccessToken(raw: string, store: RecordStore): Promise<ResolvedToken> {
  const record = await store.get<TokenRecord>(accessKey(raw));
  if (!record) throw invalidToken();
  if (record.expiresAt <= Date.now()) {
    await store.del(accessKey(raw));
    throw invalidToken();
  }
  // 連携が取り消されていれば、期限内でもここで止まる
  const grant = await store.get<GrantRecord>(grantKey(record.grantId));
  if (!grant) throw invalidToken();

  return {
    grantId: record.grantId,
    userId: record.userId,
    resource: record.resource,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    appwriteSession: unseal(raw, record.sealedSession),
  };
}

/**
 * 更新トークンを入れ替える（公開クライアント向けの必須動作）。
 *
 * 一度使った更新トークンが再び出てきたら、盗まれた可能性を優先し
 * **その連携ごと無効にする**。正規の利用者はつなぎ直すことになるが、
 * 盗んだ側だけが使い続けられる状態よりはるかにましだと考える。
 */
export async function rotateRefreshToken(
  raw: string,
  store: RecordStore,
  onRevoked?: (appwriteSession: string) => Promise<void>,
): Promise<IssuedTokens> {
  const record = await store.get<RefreshRecord>(refreshKey(raw));
  if (!record) throw invalidGrant();

  const grant = await store.get<GrantRecord>(grantKey(record.grantId));
  if (!grant) throw invalidGrant();

  const replayed = record.used === true || grant.currentRefreshHash !== tokenHash(raw);
  if (replayed) {
    console.warn('mcp refresh token replay detected; revoking grant', record.grantId);
    let session: string | undefined;
    try { session = unseal(raw, record.sealedSession); } catch { /* 開けなくても取り消しは続ける */ }
    await store.del(grantKey(record.grantId));
    await store.del(refreshKey(raw));
    if (session && onRevoked) await onRevoked(session);
    throw invalidGrant();
  }

  if (record.expiresAt <= Date.now()) {
    await store.del(refreshKey(raw));
    throw invalidGrant();
  }

  const appwriteSession = unseal(raw, record.sealedSession);

  // 使い回しを見つけられるよう、消さずに「使用済み」で残す
  await store.put(
    refreshKey(raw),
    { ...record, used: true },
    Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000)),
  );

  return writeTokens(
    record.grantId,
    { userId: record.userId, resource: record.resource, scopes: record.scopes, appwriteSession },
    store,
    grant.createdAt,
  );
}

/**
 * 連携を解除する。
 *
 * 出されたのがアクセストークンでも更新トークンでも、
 * その連携ぶんをまとめて無効にし、この連携用に作ったAppwriteのセッションも消す。
 * 本人がアプリで使っているログインには触れない。
 */
export async function revokeByToken(
  raw: string,
  store: RecordStore,
  deleteSession?: (appwriteSession: string) => Promise<void>,
): Promise<void> {
  const access = await store.get<TokenRecord>(accessKey(raw));
  const refresh = access ? null : await store.get<RefreshRecord>(refreshKey(raw));
  const record = access ?? refresh;
  if (!record) return; // 既に無効なら何もしない（OAuthの取り消しは冪等）

  await store.del(grantKey(record.grantId));
  await store.del(access ? accessKey(raw) : refreshKey(raw));

  if (deleteSession) {
    try {
      await deleteSession(unseal(raw, record.sealedSession));
    } catch (error) {
      // セッションの後始末に失敗しても、こちら側の記録は既に消えている
      console.error('mcp session cleanup failed:', error);
    }
  }
}
