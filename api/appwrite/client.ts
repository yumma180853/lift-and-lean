/**
 * Appwriteクライアントの組み立て。環境変数を読むのはこのファイルだけ。
 *
 * 資格情報を2種類に分ける（.design/chatgpt-integration.md §8.2）:
 *   - API key クライアント … 書き込み専用。userIdと行権限をサーバーが権威的に決める
 *   - セッションクライアント … 読み取り専用。Appwriteが行権限を強制する
 *
 * **API key を読み取りに使わない。** アプリ層にバグがあっても他人の行が返らない
 * ようにするための多層防御なので、横着して1つにまとめない。
 */

import { Client, TablesDB, Account, Users } from 'node-appwrite';
import { AppError } from '../core/errors.ts';

export interface AppwriteConfig {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId: string;
}

let cached: AppwriteConfig | null = null;

export function isConfigured(): boolean {
  return Boolean(process.env.APPWRITE_PROJECT_ID && process.env.APPWRITE_API_KEY);
}

export function loadConfig(): AppwriteConfig {
  if (cached) return cached;
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  if (!projectId || !apiKey) {
    throw new AppError('not_configured', 503, 'サーバーの設定が未完了です。時間をおいて試してください。');
  }
  cached = {
    endpoint: process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1',
    projectId,
    apiKey,
    databaseId: process.env.APPWRITE_DATABASE_ID || 'liftandlean',
  };
  return cached;
}

/** テスト・設定変更時にキャッシュを捨てる */
export function resetConfigCache(): void {
  cached = null;
}

function baseClient(): Client {
  const config = loadConfig();
  return new Client().setEndpoint(config.endpoint).setProject(config.projectId);
}

/** admin権限。書き込みとサーバー専用テーブルにのみ使う */
export function adminClient(): Client {
  return baseClient().setKey(loadConfig().apiKey);
}

/** ログイン中ユーザーの権限。読み取りに使う */
export function sessionClient(sessionSecret: string): Client {
  return baseClient().setSession(sessionSecret);
}

/** 未ログインの操作（サインアップ・ログイン）用 */
export function guestClient(): Client {
  return baseClient();
}

export const adminTables = (): TablesDB => new TablesDB(adminClient());
export const sessionTables = (secret: string): TablesDB => new TablesDB(sessionClient(secret));
export const sessionAccount = (secret: string): Account => new Account(sessionClient(secret));
export const guestAccount = (): Account => new Account(guestClient());
export const adminUsers = (): Users => new Users(adminClient());
export const databaseId = (): string => loadConfig().databaseId;
