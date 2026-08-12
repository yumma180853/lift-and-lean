/**
 * テスト用のRepository実装。
 *
 * 重要: **userIdでの絞り込みではなく、行に保存された権限で読み取りを制限する。**
 * Appwriteの row-level permission と同じ振る舞いにしてあるので、
 * サービス層が誤って他人のuserIdを渡しても、他人の行は返らない。
 * 「アプリ側のフィルタに頼っていないか」をテストで検出できるようにするための作り。
 */

import { AppError, NotFoundError } from '../../api/_core/errors.ts';
import type {
  ListOptions,
  Repository,
  StoredRow,
  TableName,
  WriteMode,
  WriteResult,
  WriteRow,
} from '../../api/_core/ports.ts';

interface StoredRecord {
  id: string;
  table: TableName;
  data: Record<string, unknown>;
  permissions: string[];
  createdAt: string;
}

const readPermission = (userId: string) => `read("user:${userId}")`;
const updatePermission = (userId: string) => `update("user:${userId}")`;
const deletePermission = (userId: string) => `delete("user:${userId}")`;

export class MemoryRepository implements Repository {
  rows: Map<string, StoredRecord>;
  private sequence: number;
  /** 読み取りを行う主体。実運用ではセッションが決める */
  viewer: string | null;

  constructor(viewer: string | null = null) {
    this.rows = new Map();
    this.sequence = 0;
    this.viewer = viewer;
  }

  /** 別ユーザーとして読むリポジトリを作る（同じデータを共有する） */
  asViewer(userId: string): MemoryRepository {
    const clone = new MemoryRepository(userId);
    clone.rows = this.rows;
    return clone;
  }

  private key(table: TableName, rowId: string): string {
    return `${table}/${rowId}`;
  }

  private nextTimestamp(): string {
    this.sequence += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)).toISOString();
  }

  private toStoredRow(record: StoredRecord): StoredRow {
    return { ...record.data, $id: record.id, $createdAt: record.createdAt, $permissions: record.permissions };
  }

  async putOwnedRows(table: TableName, ownerId: string, rows: WriteRow[], mode: WriteMode): Promise<WriteResult> {
    let created = 0;
    let existed = 0;
    for (const row of rows) {
      const key = this.key(table, row.rowId);
      const current = this.rows.get(key);
      if (current && mode === 'create') {
        existed += 1;
        continue;
      }
      this.rows.set(key, {
        id: row.rowId,
        table,
        data: { ...(current?.data ?? {}), ...row.data },
        permissions: [readPermission(ownerId), updatePermission(ownerId), deletePermission(ownerId)],
        createdAt: current?.createdAt ?? this.nextTimestamp(),
      });
      created += 1;
    }
    return { created, existed };
  }

  async listRows(table: TableName, viewerId: string, options: ListOptions = {}): Promise<StoredRow[]> {
    const viewer = this.viewer ?? viewerId;
    let records = [...this.rows.values()].filter(record => record.table === table);

    // ここが要点: 読めるのは read 権限を持つ行だけ
    records = records.filter(record => record.permissions.includes(readPermission(viewer)));

    for (const [column, value] of Object.entries(options.equals ?? {})) {
      records = records.filter(record => valueOf(record, column) === value);
    }
    if (options.anyOf) {
      const allowed = new Set(options.anyOf.values.map(String));
      records = records.filter(record => allowed.has(String(valueOf(record, options.anyOf!.column))));
    }
    if (options.between) {
      const { column, from, to } = options.between;
      records = records.filter(record => {
        const value = String(valueOf(record, column) ?? '');
        return value >= from && value <= to;
      });
    }
    if (options.orderAsc) {
      const column = options.orderAsc;
      records.sort((a, b) => String(valueOf(a, column)).localeCompare(String(valueOf(b, column))));
    }
    if (options.orderDesc) {
      const column = options.orderDesc;
      records.sort((a, b) => String(valueOf(b, column)).localeCompare(String(valueOf(a, column))));
    }
    const limit = options.limit ?? 100;
    return records.slice(0, limit).map(record => this.toStoredRow(record));
  }

  private assertOwned(table: TableName, ownerId: string, rowId: string, permission: (id: string) => string): StoredRecord {
    const record = this.rows.get(this.key(table, rowId));
    // 「存在しない」と「他人のもの」を区別しない（存在の有無も漏らさない）
    if (!record || !record.permissions.includes(permission(ownerId))) {
      throw new NotFoundError('対象が見つかりませんでした。');
    }
    return record;
  }

  async patchOwnedRow(table: TableName, ownerId: string, rowId: string, data: Record<string, unknown>): Promise<void> {
    const record = this.assertOwned(table, ownerId, rowId, updatePermission);
    record.data = { ...record.data, ...data };
  }

  async deleteOwnedRow(table: TableName, ownerId: string, rowId: string): Promise<void> {
    this.assertOwned(table, ownerId, rowId, deletePermission);
    this.rows.delete(this.key(table, rowId));
  }

  async appendServerRow(table: TableName, rowId: string, data: Record<string, unknown>): Promise<void> {
    const key = this.key(table, rowId);
    if (this.rows.has(key)) return;
    this.rows.set(key, {
      id: rowId,
      table,
      data,
      permissions: [], // 誰にも行権限を与えない＝サーバー専用
      createdAt: this.nextTimestamp(),
    });
  }

  async bumpServerCounter(table: TableName, rowId: string, column: string, seed: Record<string, unknown>): Promise<number> {
    const key = this.key(table, rowId);
    const current = this.rows.get(key);
    const next = Number(current?.data[column] ?? 0) + 1;
    this.rows.set(key, {
      id: rowId,
      table,
      data: { ...seed, ...(current?.data ?? {}), [column]: next },
      permissions: [],
      createdAt: current?.createdAt ?? this.nextTimestamp(),
    });
    return next;
  }

  // ---- テスト用のヘルパー

  /** カウンタを任意の値に置く（上限到達をテストするため） */
  presetCounter(table: TableName, rowId: string, column: string, value: number): void {
    this.rows.set(this.key(table, rowId), {
      id: rowId,
      table,
      data: { [column]: value },
      permissions: [],
      createdAt: this.nextTimestamp(),
    });
  }

  countOf(table: TableName): number {
    return [...this.rows.values()].filter(record => record.table === table).length;
  }

  rawRows(table: TableName): StoredRow[] {
    return [...this.rows.values()].filter(record => record.table === table).map(record => this.toStoredRow(record));
  }
}

function valueOf(record: StoredRecord, column: string): unknown {
  if (column === '$id') return record.id;
  if (column === '$createdAt') return record.createdAt;
  return record.data[column];
}

/** 読み取りが必ず失敗するリポジトリ（未ログイン時の挙動確認用） */
export class UnauthenticatedRepository extends MemoryRepository {
  async listRows(): Promise<StoredRow[]> {
    throw new AppError('unauthorized', 401, 'ログインが必要です。');
  }
}
