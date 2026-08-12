/**
 * 認証。ブラウザは Appwrite に直接アクセスせず、必ずこのサーバーを経由する。
 *
 * 理由（.design/chatgpt-integration.md §8.1）:
 *   Appwriteのclient SDKはproject IDだけで到達できるため、
 *   フロントから直接叩ける経路を残さない設計にしている。
 *
 * セッションの実体（secret）は **HttpOnly Cookie** に入れ、JavaScriptから読めなくする。
 */

import { AppwriteException, ID } from 'node-appwrite';
import { AppError, AuthError, UpstreamError } from '../_core/errors.js';
import type { AuthenticatedUser } from '../_core/ports.js';
import { guestAccount, loadConfig, sessionAccount } from './client.js';

export const SESSION_COOKIE = 'll_session';

export interface SessionResult {
  user: AuthenticatedUser;
  secret: string;
  expiresAt: string;
}

function mapAuthError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof AppwriteException) {
    if (error.type === 'user_already_exists' || error.code === 409) {
      throw new AppError('email_taken', 409, 'このメールアドレスはすでに登録されています。');
    }
    if (error.type === 'user_invalid_credentials' || error.code === 401) {
      throw new AuthError('メールアドレスかパスワードが違います。');
    }
    if (error.type === 'password_personal_data') {
      throw new AppError('weak_password', 400, 'パスワードにメールアドレスや名前を含めないでください。');
    }
    if (error.code === 429) {
      throw new AppError('rate_limited', 429, '試行回数が多すぎます。しばらく待ってから試してください。');
    }
    console.error('appwrite auth error:', error.code, error.type);
    throw new UpstreamError('認証サーバーへの接続に失敗しました。時間をおいて試してください。');
  }
  console.error('appwrite auth unexpected error:', error);
  throw new UpstreamError('認証サーバーへの接続に失敗しました。時間をおいて試してください。');
}

export async function signUp(email: string, password: string, name?: string): Promise<SessionResult> {
  try {
    await guestAccount().create({ userId: ID.unique(), email, password, name });
  } catch (error) {
    mapAuthError(error);
  }
  return logIn(email, password);
}

export async function logIn(email: string, password: string): Promise<SessionResult> {
  try {
    const session = await guestAccount().createEmailPasswordSession({ email, password });
    return {
      user: { userId: session.userId },
      secret: session.secret,
      expiresAt: session.expire,
    };
  } catch (error) {
    mapAuthError(error);
  }
}

/** セッションを削除する。連携解除時はこれでJWTも即失効する */
export async function logOut(secret: string): Promise<void> {
  try {
    await sessionAccount(secret).deleteSession({ sessionId: 'current' });
  } catch (error) {
    if (error instanceof AppwriteException && (error.code === 401 || error.code === 404)) return;
    mapAuthError(error);
  }
}

/** Cookieのセッションから userId を解決する。ここで解決した値だけを信用する */
export async function resolveUser(secret: string | undefined): Promise<AuthenticatedUser> {
  // サーバー側が未設定なら「未ログイン」ではなく「まだ使えない」を返す
  // （ログイン画面を出しても必ず失敗するため）
  loadConfig();
  if (!secret) throw new AuthError();
  try {
    const account = await sessionAccount(secret).get();
    return { userId: account.$id, email: account.email, name: account.name };
  } catch (error) {
    if (error instanceof AppwriteException && (error.code === 401 || error.code === 404)) {
      throw new AuthError('ログインの有効期限が切れました。もう一度ログインしてください。');
    }
    mapAuthError(error);
  }
}

// ---------------------------------------------------------------- Cookie

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * HTTPSで配信されているか。
 * `Secure` 付きcookieはhttpでは保存されないため、ローカル開発では外す必要がある。
 * 本番（Vercel）では必ず付ける。
 */
export function isSecureContext(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

export function buildSessionCookie(secret: string, expiresAt: string, secure = isSecureContext()): string {
  const maxAge = Math.max(Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000), 0);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.splice(2, 0, 'Secure');
  return parts.join('; ');
}

export function buildClearedSessionCookie(secure = isSecureContext()): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`;
}
