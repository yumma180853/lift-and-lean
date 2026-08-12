/**
 * Repository契約のAppwrite実装。Appwrite固有の知識はこのファイルに閉じる。
 *
 * 行の権限は書き込み時にサーバーが本人だけへ与える:
 *   read / update / delete = Role.user(ownerId)
 * create権限はテーブルにもクライアントにも与えない（サーバー経由でしか作れない）。
 */

import { AppwriteException, Permission, Query, Role } from 'node-appwrite';
import { AppError, NotFoundError, UpstreamError } from '../_core/errors.js';
import type { ListOptions, Repository, StoredRow, TableName, WriteMode, WriteResult, WriteRow } from '../_core/ports.js';
import { adminTables, databaseId, sessionTables } from './client.js';

const CONFLICT = 409;
const NOT_FOUND = 404;

/**
 * 同時に投げる書き込みの数。
 * 上げすぎるとAppwrite側で詰まり、下げすぎると移行が実行時間上限に当たる。
 */
export const WRITE_CONCURRENCY = 8;

/** 上限つきの並行実行。1件でも失敗したらその例外を投げる（成否を握りつぶさない） */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(lanes);
}

const ownerPermissions = (ownerId: string): string[] => [
  Permission.read(Role.user(ownerId)),
  Permission.update(Role.user(ownerId)),
  Permission.delete(Role.user(ownerId)),
];

function buildQueries(options: ListOptions = {}): string[] {
  const queries: string[] = [];
  for (const [column, value] of Object.entries(options.equals ?? {})) {
    queries.push(Query.equal(column, value as any));
  }
  if (options.anyOf && options.anyOf.values.length > 0) {
    queries.push(Query.equal(options.anyOf.column, options.anyOf.values as any));
  }
  if (options.between) {
    queries.push(Query.between(options.between.column, options.between.from, options.between.to));
  }
  if (options.orderAsc) queries.push(Query.orderAsc(options.orderAsc));
  if (options.orderDesc) queries.push(Query.orderDesc(options.orderDesc));
  queries.push(Query.limit(Math.min(options.limit ?? 100, 500)));
  return queries;
}

/**
 * Appwriteのエラーをアプリのエラーへ変換する。
 *
 * `context`（どのテーブルの何をしていたか）を**必ずログに出す**。
 * 本番で `Unknown attribute: "fat"` が出たとき、どのテーブルか分からず
 * 切り分けに時間がかかったため、文脈をログに残す。
 * 利用者向けの文言にはテーブル名・列名を出さない。
 */
function wrap(error: unknown, context: string): never {
  if (error instanceof AppError) throw error;
  if (error instanceof AppwriteException) {
    if (error.code === NOT_FOUND) throw new NotFoundError();

    // スキーマ不整合。「接続に失敗」と言うと原因を探せなくなる
    if (error.type === 'row_invalid_structure' || error.type === 'document_invalid_structure') {
      console.error(`appwrite schema error [${context}]:`, error.code, error.type, error.message);
      throw new AppError(
        'schema_mismatch',
        503,
        'サーバー側のデータ定義が最新ではありません。復旧までお待ちください。',
      );
    }
    if (error.type === 'general_unauthorized_scope') {
      console.error(`appwrite scope error [${context}]: API key is missing a required scope`);
      throw new AppError('not_configured', 503, 'サーバーの設定が未完了です。時間をおいて試してください。');
    }

    console.error(`appwrite error [${context}]:`, error.code, error.type, error.message);
    throw new UpstreamError();
  }
  console.error(`appwrite unexpected error [${context}]:`, error);
  throw new UpstreamError();
}

/**
 * TablesDBの取得口。テストではここに偽物を差し込み、
 * 「読み取りにadminを使っていないか」まで検証できるようにする。
 */
export interface TableGateways {
  admin(): any;
  session(secret: string): any;
}

const defaultGateways: TableGateways = {
  admin: () => adminTables(),
  session: (secret: string) => sessionTables(secret),
};

export interface AppwriteRepositoryOptions {
  /** 読み取りに使うログイン中ユーザーのセッション。無い場合は読み取りができない */
  sessionSecret?: string;
  gateways?: TableGateways;
}

export class AppwriteRepository implements Repository {
  sessionSecret?: string;
  gateways: TableGateways;

  constructor(options: AppwriteRepositoryOptions = {}) {
    this.sessionSecret = options.sessionSecret;
    this.gateways = options.gateways ?? defaultGateways;
  }

  private reader() {
    if (!this.sessionSecret) {
      // API keyで読むと権限チェックをバイパスしてしまうため、代替はしない
      throw new AppError('unauthorized', 401, 'ログインが必要です。');
    }
    return this.gateways.session(this.sessionSecret);
  }

  async putOwnedRows(table: TableName, ownerId: string, rows: WriteRow[], mode: WriteMode): Promise<WriteResult> {
    const db = this.gateways.admin();
    const permissions = ownerPermissions(ownerId);
    let created = 0;
    let existed = 0;

    const writeOne = async (row: WriteRow): Promise<void> => {
      try {
        if (mode === 'upsert') {
          await db.upsertRow({ databaseId: databaseId(), tableId: table, rowId: row.rowId, data: row.data, permissions });
        } else {
          await db.createRow({ databaseId: databaseId(), tableId: table, rowId: row.rowId, data: row.data, permissions });
        }
        created++;
      } catch (error) {
        // 決定的rowIdなので、同じデータの再送は必ずここに来る。エラーにしない
        if (error instanceof AppwriteException && error.code === CONFLICT) {
          existed++;
          return;
        }
        wrap(error, `${table}.${mode}`);
      }
    };

    // 1行ずつ直列に書くと、移行のような数千行でVercelの実行時間上限（60秒）を超える。
    // 行どうしに依存が無いので、上限つきで並行に書く。
    await runWithConcurrency(rows, WRITE_CONCURRENCY, writeOne);
    return { created, existed };
  }

  async listRows(table: TableName, _viewerId: string, options: ListOptions = {}): Promise<StoredRow[]> {
    try {
      const result = await this.reader().listRows({
        databaseId: databaseId(),
        tableId: table,
        queries: buildQueries(options),
      });
      return result.rows as StoredRow[];
    } catch (error) {
      wrap(error, `${table}.list`);
    }
  }

  /**
   * 所有者を確かめてから更新する。
   * rowIdは決定的で推測できるため、「IDを知っている＝触れてよい」にはしない。
   * 確認はユーザーのセッションで読む（Appwriteが行権限を強制する）。
   */
  private async assertOwned(table: TableName, ownerId: string, rowId: string): Promise<void> {
    const rows = await this.listRows(table, ownerId, { equals: { $id: rowId }, limit: 1 });
    if (rows.length === 0) throw new NotFoundError('対象が見つかりませんでした。');
    if (rows[0].userId !== ownerId) throw new NotFoundError('対象が見つかりませんでした。');
  }

  async patchOwnedRow(table: TableName, ownerId: string, rowId: string, data: Record<string, unknown>): Promise<void> {
    await this.assertOwned(table, ownerId, rowId);
    try {
      await this.gateways.admin().updateRow({ databaseId: databaseId(), tableId: table, rowId, data });
    } catch (error) {
      wrap(error, `${table}.update`);
    }
  }

  async deleteOwnedRow(table: TableName, ownerId: string, rowId: string): Promise<void> {
    await this.assertOwned(table, ownerId, rowId);
    try {
      await this.gateways.admin().deleteRow({ databaseId: databaseId(), tableId: table, rowId });
    } catch (error) {
      wrap(error, `${table}.delete`);
    }
  }

  /** 行権限を一切与えない＝誰にも読めない行として追記する */
  async appendServerRow(table: TableName, rowId: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.gateways.admin().createRow({ databaseId: databaseId(), tableId: table, rowId, data, permissions: [] });
    } catch (error) {
      if (error instanceof AppwriteException && error.code === CONFLICT) return;
      wrap(error, `${table}.append`);
    }
  }

  /**
   * 増分操作でカウンタを進める。**読み取りAPIは使わない。**
   * 返ってくるのは「自分が今書いた結果」なので、APIキーに読み取り権限は要らない。
   */
  async bumpServerCounter(table: TableName, rowId: string, column: string, seed: Record<string, unknown>): Promise<number> {
    const db = this.gateways.admin();
    const increment = async (): Promise<number> => {
      const row = await db.incrementRowColumn({
        databaseId: databaseId(), tableId: table, rowId, column, value: 1,
      });
      return Number(row?.[column] ?? 0);
    };

    try {
      return await increment();
    } catch (error) {
      if (!(error instanceof AppwriteException) || error.code !== NOT_FOUND) wrap(error, `${table}.increment`);
    }

    // 初回はカウンタ行が無い。作ってから数え始める
    try {
      await db.createRow({
        databaseId: databaseId(), tableId: table, rowId,
        data: { ...seed, [column]: 1 }, permissions: [],
      });
      return 1;
    } catch (error) {
      // 同時に作られた場合は既にあるので、もう一度増やす
      if (error instanceof AppwriteException && error.code === CONFLICT) return increment();
      wrap(error, `${table}.seed`);
    }
  }
}
