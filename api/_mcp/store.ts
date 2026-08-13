/**
 * 連携の途中経過と、発行したトークンの置き場所。
 *
 * ここに置くのは**数分〜数十日で消える一時データ**で、利用者の記録とは性質が違う。
 * Appwriteに置くとAPIキーに読み取り権限が必要になり、
 * 「本番APIキーは利用者のデータを読めない」という性質を壊してしまうため、
 * 別の置き場所（Vercel KV）を使う。
 *
 * **生の値はここに置かない**。トークンはハッシュを鍵にして引き、
 * Appwriteのセッションは提示された値から導いた鍵で封をしてから置く（tokens.ts）。
 * 置き場所ごと抜かれても、それだけでは何も使えない状態にしておく。
 */

import { kv } from '@vercel/kv';
import { AppError } from '../_core/errors.js';

/** 認可コードの有効期間。OAuth 2.1 の推奨（短命・1回だけ）に合わせる */
export const AUTH_CODE_TTL_SECONDS = 120;

// ---------------------------------------------------------------- 置き場所

export interface RecordStore {
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
}

function unavailable(error: unknown): never {
  console.error('mcp state store unavailable:', error);
  throw new AppError(
    'not_configured',
    503,
    '連携の設定が未完了です。時間をおいて試してください。',
  );
}

const parse = <T>(raw: unknown): T | null => {
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? JSON.parse(raw) as T : raw as T;
};

export const kvRecordStore: RecordStore = {
  async put(key, value, ttlSeconds) {
    try {
      await kv.set(key, JSON.stringify(value), { ex: ttlSeconds });
    } catch (error) {
      unavailable(error);
    }
  },

  async get<T>(key: string): Promise<T | null> {
    try {
      return parse<T>(await kv.get(key));
    } catch (error) {
      unavailable(error);
    }
  },

  async del(key) {
    try {
      await kv.del(key);
    } catch (error) {
      unavailable(error);
    }
  },
};

/** テスト用。KVに繋がずに同じ振る舞いをする（期限切れも再現する） */
export function createMemoryRecordStore(): RecordStore {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  return {
    async put(key, value, ttlSeconds) {
      rows.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async get<T>(key: string): Promise<T | null> {
      const row = rows.get(key);
      if (!row) return null;
      if (row.expiresAt <= Date.now()) { rows.delete(key); return null; }
      return JSON.parse(row.value) as T;
    },
    async del(key) { rows.delete(key); },
  };
}

// ---------------------------------------------------------------- 認可コード

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  /** このコードで発行するトークンを結びつける相手（正規化済み） */
  resource: string;
  /** **認可コードそのものから導いた鍵で封をした**Appwriteのセッション */
  sealedSession: string;
  userId: string;
  expiresAt: number;
}

const codeKey = (code: string): string => `mcp:oauth:code:${code}`;

export interface AuthorizationCodeStore {
  save(code: string, record: AuthorizationCodeRecord): Promise<void>;
  /** 取り出したら消す（同じコードを2回使えないようにする） */
  take(code: string): Promise<AuthorizationCodeRecord | null>;
  /** 交換せずに中身だけ見る（PKCEの検証で使う） */
  peek(code: string): Promise<AuthorizationCodeRecord | null>;
}

export function createAuthorizationCodeStore(store: RecordStore): AuthorizationCodeStore {
  const live = (record: AuthorizationCodeRecord | null): AuthorizationCodeRecord | null =>
    record && record.expiresAt > Date.now() ? record : null;

  return {
    async save(code, record) {
      await store.put(codeKey(code), record, AUTH_CODE_TTL_SECONDS);
    },
    async take(code) {
      const record = await store.get<AuthorizationCodeRecord>(codeKey(code));
      if (record) await store.del(codeKey(code));
      return live(record);
    },
    async peek(code) {
      return live(await store.get<AuthorizationCodeRecord>(codeKey(code)));
    },
  };
}

export const authorizationCodeStore = createAuthorizationCodeStore(kvRecordStore);
