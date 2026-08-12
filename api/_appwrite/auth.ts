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
import { adminAccount, guestAccount, loadConfig, publicAppUrl, sessionAccount } from './client.js';

export const SESSION_COOKIE = 'll_session';

/**
 * Account APIの取得口。テストで差し替えて、実際のAppwriteに繋がずに
 * 「どの資格情報で呼んだか」「エラーをどう変換したか」を検証する。
 */
export interface AccountGateways {
  guest(): any;
  admin(): any;
  session(secret: string): any;
}

const realGateways: AccountGateways = {
  guest: () => guestAccount(),
  admin: () => adminAccount(),
  session: (secret: string) => sessionAccount(secret),
};

let gateways: AccountGateways = realGateways;

/** テスト専用。戻り値を呼ぶと元に戻る */
export function __setAccountGatewaysForTest(next: Partial<AccountGateways>): () => void {
  const previous = gateways;
  gateways = { ...gateways, ...next };
  return () => { gateways = previous; };
}

export interface SessionResult {
  user: AuthenticatedUser;
  secret: string;
  expiresAt: string;
}

/**
 * Appwriteのエラーを利用者向けの案内に変換する。
 *
 * **判定は必ず `type` を先に見る。** HTTPコードだけで分けると、
 * 同じ409を返す `user_already_exists` と `user_password_reset_required` を
 * 取り違え、「パスワード再設定が必要」な人に「すでに登録されています」と
 * 案内してしまう（実際にこの取り違えが起きていた）。
 */
function mapAuthError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (!(error instanceof AppwriteException)) {
    console.error('appwrite auth unexpected error:', error);
    throw new UpstreamError('認証サーバーへの接続に失敗しました。時間をおいて試してください。');
  }

  switch (error.type) {
    case 'user_already_exists':
    case 'user_email_already_exists':
      throw new AppError('email_taken', 409, 'このメールアドレスはすでに登録されています。ログインするか、パスワードを再設定してください。');
    case 'user_password_reset_required':
      throw new AppError('password_reset_required', 409, 'パスワードの再設定が必要です。「パスワードをお忘れですか？」から手続きしてください。');
    case 'user_invalid_credentials':
    case 'user_not_found':
      // 存在の有無を漏らさないため、未登録でも同じ文言にする
      throw new AuthError('メールアドレスかパスワードが違います。');
    case 'password_personal_data':
      throw new AppError('weak_password', 400, 'パスワードにメールアドレスや名前を含めないでください。');
    case 'general_argument_invalid':
      // 再設定リンクの宛先がAppwriteのPlatformに未登録なときにここへ来る
      console.error('appwrite auth argument error:', error.message);
      throw new AppError('not_configured', 503, 'メール送信の設定が未完了です。時間をおいて試してください。');
    case 'general_unauthorized_scope':
      // APIキーのscope不足。401だが**利用者の入力は正しい**ので、
      // 「パスワードが違います」と表示してはいけない（原因を探せなくなる）
      console.error('appwrite auth scope error: API key is missing a required scope');
      throw new AppError('not_configured', 503, 'ログイン処理の設定が未完了です。時間をおいて試してください。');
  }

  // typeで判別できないものはHTTPコードで最低限だけ分ける
  if (error.code === 409) {
    throw new AppError('email_taken', 409, 'このメールアドレスはすでに登録されています。ログインするか、パスワードを再設定してください。');
  }
  if (error.code === 401) throw new AuthError('メールアドレスかパスワードが違います。');
  if (error.code === 429) {
    throw new AppError('rate_limited', 429, '試行回数が多すぎます。1時間ほど待ってから試してください。');
  }

  console.error('appwrite auth error:', error.code, error.type);
  throw new UpstreamError('認証サーバーへの接続に失敗しました。時間をおいて試してください。');
}

export async function signUp(email: string, password: string, name?: string): Promise<SessionResult> {
  try {
    await gateways.guest().create({ userId: ID.unique(), email, password, name });
  } catch (error) {
    mapAuthError(error);
  }

  // ここから先で失敗しても**アカウントは作成済み**。
  // 「登録に失敗した」と誤解させると、別のパスワードで登録し直そうとして
  // 「すでに登録されています」の袋小路に入る。作成済みだと明示する。
  let session: SessionResult;
  try {
    session = await logIn(email, password);
  } catch (error) {
    const detail = error instanceof AppError ? error.message : '';
    throw new AppError(
      'signup_session_failed',
      502,
      `アカウントは作成できましたが、自動ログインに失敗しました。「ログイン」から同じパスワードでお試しください。${detail ? `（${detail}）` : ''}`,
    );
  }

  // 確認メールの送信に失敗しても登録自体は成立させる。
  // 未確認のままでもデータには触れない（routerで止める）し、画面から再送できる
  try {
    await sendEmailVerification(session.secret);
  } catch (error) {
    console.error('failed to send verification email on signup:', error);
  }
  return session;
}

export async function logIn(email: string, password: string): Promise<SessionResult> {
  try {
    // **APIキー付きのクライアントで発行する必要がある。**
    // Appwriteはブラウザ向けにはセッションをCookieで返す設計のため、
    // APIキー無し（guest）で呼ぶと `secret` が空文字で返る。
    // 空のsecretをCookieに入れると「ログインできたのに毎回未ログイン」になる。
    const session = await gateways.admin().createEmailPasswordSession({ email, password });
    if (!session.secret) {
      // scope不足（`sessions.write`）でここに来る。黙って壊れるより落とす
      console.error('appwrite session secret is empty: API key needs the sessions.write scope');
      throw new AppError('session_unavailable', 503, 'ログイン処理の設定が未完了です。時間をおいて試してください。');
    }
    return {
      // 確認済みかどうかは resolveUser で毎回取り直す（ここでは未確認扱いで返す）
      user: { userId: session.userId, emailVerified: false },
      secret: session.secret,
      expiresAt: session.expire,
    };
  } catch (error) {
    mapAuthError(error);
  }
}

/**
 * パスワード再設定メールを送る。
 *
 * **メールアドレスが登録済みかどうかを応答から判別できないようにする。**
 * 未登録でも成功と同じ結果を返す（アカウント列挙を助長しない）。
 */
export async function requestPasswordRecovery(email: string): Promise<void> {
  const url = `${publicAppUrl()}/reset-password`;
  try {
    await gateways.guest().createRecovery({ email, url });
  } catch (error) {
    // 未登録のメールアドレス。存在しないことを応答から悟らせない
    if (error instanceof AppwriteException && (error.code === 404 || error.type === 'user_not_found')) return;
    // それ以外（レート制限・設定不備）は本人にも起きうるので素直に伝える
    mapAuthError(error);
  }
}

/**
 * メールのリンクから戻ってきたユーザーの新しいパスワードを設定する。
 *
 * リンクが壊れている理由（期限切れ / 使用済み / userIdが存在しない）は
 * **区別せず同じ案内にする**。区別すると「そのuserIdは実在するか」を
 * 外から確かめられてしまう。利用者の次の行動もどれも同じ（やり直す）。
 */
export async function completePasswordRecovery(userId: string, secret: string, password: string): Promise<void> {
  try {
    await gateways.guest().updateRecovery({ userId, secret, password });
  } catch (error) {
    if (error instanceof AppwriteException && [400, 401, 404].includes(error.code)) {
      throw new AppError(
        'recovery_invalid',
        400,
        'このリンクは期限切れか、すでに使用済みです。もう一度「パスワードをお忘れですか？」からやり直してください。',
      );
    }
    mapAuthError(error);
  }
}

/**
 * メールアドレスの所有確認メールを送る。
 *
 * **ログイン中のユーザー本人としてしか呼べない**（Appwriteの Account API）。
 * そのため「このアドレスは登録済みか」を外から探る用途には使えず、
 * 列挙対策として追加の細工は要らない。
 */
export async function sendEmailVerification(sessionSecret: string): Promise<void> {
  const url = `${publicAppUrl()}/verify-email`;
  try {
    await gateways.session(sessionSecret).createVerification({ url });
  } catch (error) {
    mapAuthError(error);
  }
}

/**
 * メールのリンクから戻ってきた確認を完了する。
 *
 * リンクは別のブラウザで開かれることがある（スマホのメールアプリなど）ため、
 * **セッションが無くても完了できる経路を先に試す**。
 * 失敗した場合だけ、手元のセッションで再挑戦する。
 */
export async function completeEmailVerification(userId: string, secret: string, sessionSecret?: string): Promise<void> {
  try {
    await gateways.guest().updateVerification({ userId, secret });
    return;
  } catch (error) {
    const needsSession = error instanceof AppwriteException && error.code === 401 && Boolean(sessionSecret);
    if (!needsSession) {
      // 期限切れ・使用済み・userId不在は区別せず同じ案内にする
      if (error instanceof AppwriteException && [400, 401, 404].includes(error.code)) {
        throw new AppError('verification_invalid', 400, VERIFICATION_INVALID_MESSAGE);
      }
      mapAuthError(error);
    }
  }

  try {
    await gateways.session(sessionSecret!).updateVerification({ userId, secret });
  } catch (error) {
    if (error instanceof AppwriteException && [400, 401, 404].includes(error.code)) {
      throw new AppError('verification_invalid', 400, VERIFICATION_INVALID_MESSAGE);
    }
    mapAuthError(error);
  }
}

const VERIFICATION_INVALID_MESSAGE =
  'このリンクは期限切れか、すでに使用済みです。アプリの設定画面から確認メールを送り直してください。';

/** セッションを削除する。連携解除時はこれでJWTも即失効する */
export async function logOut(secret: string): Promise<void> {
  try {
    await gateways.session(secret).deleteSession({ sessionId: 'current' });
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
    const account = await gateways.session(secret).get();
    return {
      userId: account.$id,
      email: account.email,
      name: account.name,
      emailVerified: Boolean(account.emailVerification),
    };
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
