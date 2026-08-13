/**
 * サービス層がDBに求める契約。ここにAppwrite固有のものは一切出さない。
 *
 * Appwriteから別のDBへ移っても、差し替えるのはこの契約の実装だけで、
 * サービス層（検証・認可・JST・冪等性・rate limit・audit）は変更しない。
 */

export type TableName =
  | 'profiles'
  | 'goals'
  | 'meals'
  | 'weights'
  | 'workouts'
  | 'workout_exercises'
  | 'workout_sets'
  | 'audit_log'
  | 'rate_limits';

export interface WriteRow {
  /** 決定的に導出したID。同じデータからは必ず同じIDになる */
  rowId: string;
  data: Record<string, unknown>;
}

export interface WriteResult {
  /** 新規に作られた行数 */
  created: number;
  /** すでに存在していた行数（冪等な再送） */
  existed: number;
}

export interface ListOptions {
  equals?: Record<string, string | number | boolean>;
  /** IN条件。指定した値のいずれかに一致する行 */
  anyOf?: { column: string; values: (string | number)[] };
  between?: { column: string; from: string; to: string };
  orderAsc?: string;
  orderDesc?: string;
  limit?: number;
}

export type StoredRow = Record<string, any>;

/**
 * 書き込みモード。
 *  - `create`: すでに在れば触らない（追記系。二重POSTを無視する）
 *  - `upsert`: すでに在れば上書き（1日1件の体重・目標など）
 */
export type WriteMode = 'create' | 'upsert';

export interface Repository {
  /**
   * 本人だけが read/update/delete できる行として書き込む。
   * 所有者は **呼び出し側の申告ではなくサーバーが解決した userId** を渡すこと。
   */
  putOwnedRows(table: TableName, ownerId: string, rows: WriteRow[], mode: WriteMode): Promise<WriteResult>;

  /**
   * そのユーザーの権限で読む。
   * 実装は「アプリ側のフィルタ」ではなく「プラットフォームの権限」で他人の行を除外すること。
   */
  listRows(table: TableName, viewerId: string, options?: ListOptions): Promise<StoredRow[]>;

  /**
   * 条件に合う行を**全部**返す（内部でページングする）。
   * 一覧の上限で黙って打ち切ると「移行したのに一部だけ見えない」になるため、
   * 全件が要る用途ではこちらを使う。
   */
  listAllRows(table: TableName, viewerId: string, options?: Omit<ListOptions, 'limit'>): Promise<StoredRow[]>;

  /**
   * 既存の行を部分更新する。
   * 実装は「その行の所有者が ownerId であること」を必ず確かめること
   * （rowIdは決定的で推測可能なため、IDを知っているだけでは触れてはいけない）。
   */
  patchOwnedRow(table: TableName, ownerId: string, rowId: string, data: Record<string, unknown>): Promise<void>;

  /** 所有者チェックの上で削除する */
  deleteOwnedRow(table: TableName, ownerId: string, rowId: string): Promise<void>;

  /**
   * 行権限を誰にも与えないサーバー専用行に**追記**する（audit_log）。
   * 読み出す手段は用意しない。読めない＝APIキーに読み取り権限が要らない。
   */
  appendServerRow(table: TableName, rowId: string, data: Record<string, unknown>): Promise<void>;

  /**
   * サーバー専用カウンタを1つ増やし、**増やした後の値**を返す（rate_limits）。
   *
   * 「読んでから書く」ではなく増分操作にしてあるのは2つの理由による:
   *   1. 同時実行でも数え漏らさない
   *   2. APIキーに読み取り権限を持たせずに済む（自分が書いた結果を受け取るだけ）
   */
  bumpServerCounter(table: TableName, rowId: string, column: string, seed: Record<string, unknown>): Promise<number>;
}

/** 認証済みユーザー。userId は必ずサーバーが解決した値 */
export interface AuthenticatedUser {
  userId: string;
  email?: string;
  name?: string;
  /**
   * メールアドレスの所有確認が済んでいるか。
   * **クラウドのデータに触れるのはこれが true のときだけ**（router で強制する）。
   */
  emailVerified: boolean;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
