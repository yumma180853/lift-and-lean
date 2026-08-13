/**
 * OAuthの途中経過（認可コード）の置き場所。
 *
 * 認可コードは**数分だけ**生きる一時データで、利用者の記録とは性質が違う。
 * Appwriteに置くとAPIキーに読み取り権限が必要になり、
 * 「本番APIキーは利用者のデータを読めない」という性質を壊してしまうため、
 * 別の置き場所（Vercel KV）を使う。
 */

import { kv } from '@vercel/kv';
import { AppError } from '../_core/errors.js';

/** 認可コードの有効期間。OAuth 2.1 の推奨（短命・1回だけ）に合わせる */
export const AUTH_CODE_TTL_SECONDS = 120;

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  /** 交換後にアクセストークンとして渡すAppwriteのセッション */
  sessionSecret: string;
  userId: string;
  expiresAt: number;
}

const codeKey = (code: string): string => `mcp:oauth:code:${code}`;

function unavailable(error: unknown): never {
  console.error('oauth state store unavailable:', error);
  throw new AppError(
    'not_configured',
    503,
    '連携の設定が未完了です。時間をおいて試してください。',
  );
}

export const authorizationCodeStore = {
  async save(code: string, record: AuthorizationCodeRecord): Promise<void> {
    try {
      await kv.set(codeKey(code), JSON.stringify(record), { ex: AUTH_CODE_TTL_SECONDS });
    } catch (error) {
      unavailable(error);
    }
  },

  /** 取り出したら消す（同じコードを2回使えないようにする） */
  async take(code: string): Promise<AuthorizationCodeRecord | null> {
    let raw: unknown;
    try {
      raw = await kv.get(codeKey(code));
      if (raw !== null && raw !== undefined) await kv.del(codeKey(code));
    } catch (error) {
      unavailable(error);
    }
    if (raw === null || raw === undefined) return null;

    const record = typeof raw === 'string' ? JSON.parse(raw) as AuthorizationCodeRecord : raw as AuthorizationCodeRecord;
    if (record.expiresAt < Date.now()) return null;
    return record;
  },

  /** 交換せずに中身だけ見る（PKCEの検証で使う） */
  async peek(code: string): Promise<AuthorizationCodeRecord | null> {
    let raw: unknown;
    try {
      raw = await kv.get(codeKey(code));
    } catch (error) {
      unavailable(error);
    }
    if (raw === null || raw === undefined) return null;
    const record = typeof raw === 'string' ? JSON.parse(raw) as AuthorizationCodeRecord : raw as AuthorizationCodeRecord;
    return record.expiresAt < Date.now() ? null : record;
  },
};

export type AuthorizationCodeStore = typeof authorizationCodeStore;
