/**
 * Appwrite TablesDB のスキーマをコードで定義し、実際のプロジェクトへ反映する。
 *
 *   npm run db:setup    … 足りないデータベース・テーブル・列・indexを作る（何度実行してもよい）
 *   npm run db:verify   … 何も作らず、定義と実物の差分だけを表示する（差分があれば exit 1）
 *
 * 設計の根拠は .design/db-migration-plan.md §2 と .design/chatgpt-integration.md §8。
 * 要点:
 *   - 全テーブルで Row Security を有効にする
 *   - table-level 権限は誰にも与えない（付けると「そのテーブルの全行」に到達できてしまう）
 *   - 行の権限は書き込み時にサーバーが本人だけに付与する
 *   - audit_log / rate_limits は行権限も与えない＝APIキーを持つサーバー専用
 */

import 'dotenv/config';
import { Client, TablesDB, AppwriteException, TablesDBIndexType, Query } from 'node-appwrite';

// ---------------------------------------------------------------- スキーマ定義

type ColumnDef =
  | { key: string; type: 'string'; size: number; required?: boolean; array?: boolean }
  | { key: string; type: 'integer'; required?: boolean; min?: number; max?: number; default?: number }
  | { key: string; type: 'float'; required?: boolean; min?: number; max?: number; default?: number }
  | { key: string; type: 'boolean'; required?: boolean; default?: boolean }
  | { key: string; type: 'enum'; elements: string[]; required?: boolean }
  | { key: string; type: 'datetime'; required?: boolean };

interface IndexDef {
  key: string;
  type: 'unique' | 'key';
  columns: string[];
}

interface TableDef {
  id: string;
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
}

const ORIGIN_VALUES = ['app', 'chatgpt', 'migration'] as const;

/** すべての記録テーブルが共通で持つ列 */
const recordColumns = (): ColumnDef[] => [
  { key: 'userId', type: 'string', size: 64, required: true },
  { key: 'clientRequestId', type: 'string', size: 128, required: true },
  { key: 'origin', type: 'enum', elements: [...ORIGIN_VALUES] },
  { key: 'needsReview', type: 'boolean', default: false },
];

export const SCHEMA: TableDef[] = [
  {
    id: 'profiles',
    name: 'Profiles',
    columns: [
      { key: 'userId', type: 'string', size: 64, required: true },
      { key: 'hiddenWorkoutDates', type: 'string', size: 10, array: true },
      { key: 'customExerciseCategories', type: 'string', size: 8000 },
      { key: 'freezeUsedDates', type: 'string', size: 10, array: true },
      { key: 'longestStreak', type: 'integer', min: 0, max: 100000, default: 0 },
      { key: 'migratedAt', type: 'datetime' },
    ],
    indexes: [{ key: 'idx_profiles_user', type: 'unique', columns: ['userId'] }],
  },
  {
    id: 'goals',
    name: 'Goals',
    columns: [
      { key: 'userId', type: 'string', size: 64, required: true },
      { key: 'calories', type: 'integer', min: 0, max: 20000 },
      { key: 'protein', type: 'float', min: 0, max: 2000 },
      { key: 'fat', type: 'float', min: 0, max: 2000 },
      { key: 'carbs', type: 'float', min: 0, max: 2000 },
      { key: 'targetWeight', type: 'float', min: 20, max: 300 },
      { key: 'trainerStyle', type: 'enum', elements: ['buddy', 'coach', 'stoic', 'cheer'] },
    ],
    indexes: [{ key: 'idx_goals_user', type: 'unique', columns: ['userId'] }],
  },
  {
    id: 'meals',
    name: 'Meals',
    columns: [
      ...recordColumns(),
      { key: 'date', type: 'string', size: 10, required: true },
      { key: 'name', type: 'string', size: 100, required: true },
      { key: 'calories', type: 'float', min: 0, max: 20000 },
      { key: 'protein', type: 'float', min: 0, max: 2000 },
      { key: 'fat', type: 'float', min: 0, max: 2000 },
      { key: 'carbs', type: 'float', min: 0, max: 2000 },
      { key: 'mealType', type: 'string', size: 32 },
      { key: 'servingLabel', type: 'string', size: 100 },
      { key: 'sourceType', type: 'enum', elements: ['official', 'web', 'ai_estimate'] },
      { key: 'sourceLabel', type: 'string', size: 200 },
      { key: 'sourceUrl', type: 'string', size: 500 },
      { key: 'note', type: 'string', size: 500 },
    ],
    indexes: [
      { key: 'idx_meals_client', type: 'unique', columns: ['userId', 'clientRequestId'] },
      { key: 'idx_meals_date', type: 'key', columns: ['userId', 'date'] },
    ],
  },
  {
    id: 'weights',
    name: 'Weights',
    columns: [
      ...recordColumns(),
      { key: 'date', type: 'string', size: 10, required: true },
      { key: 'weight', type: 'float', min: 20, max: 300 },
    ],
    // 体重は1日1件。日付のunique制約が既存アプリの挙動をDB側でも保証する
    indexes: [{ key: 'idx_weights_date', type: 'unique', columns: ['userId', 'date'] }],
  },
  {
    id: 'workouts',
    name: 'Workouts',
    columns: [
      ...recordColumns(),
      { key: 'date', type: 'string', size: 10, required: true },
    ],
    indexes: [{ key: 'idx_workouts_date', type: 'unique', columns: ['userId', 'date'] }],
  },
  {
    id: 'workout_exercises',
    name: 'Workout Exercises',
    columns: [
      ...recordColumns(),
      { key: 'workoutId', type: 'string', size: 36, required: true },
      { key: 'name', type: 'string', size: 100, required: true },
      { key: 'position', type: 'integer', min: 0, max: 1000, default: 0 },
    ],
    indexes: [
      { key: 'idx_exercises_client', type: 'unique', columns: ['userId', 'clientRequestId'] },
      { key: 'idx_exercises_workout', type: 'key', columns: ['userId', 'workoutId'] },
    ],
  },
  {
    id: 'workout_sets',
    name: 'Workout Sets',
    columns: [
      ...recordColumns(),
      { key: 'workoutId', type: 'string', size: 36, required: true },
      { key: 'exerciseId', type: 'string', size: 36, required: true },
      { key: 'reps', type: 'integer', min: 1, max: 1000 },
      { key: 'weight', type: 'float', min: 0, max: 500 },
      { key: 'position', type: 'integer', min: 0, max: 1000, default: 0 },
    ],
    indexes: [
      { key: 'idx_sets_client', type: 'unique', columns: ['userId', 'clientRequestId'] },
      { key: 'idx_sets_exercise', type: 'key', columns: ['userId', 'exerciseId'] },
    ],
  },
  {
    // サーバー専用。行権限も与えないので本人からも読めない
    id: 'audit_log',
    name: 'Audit Log',
    columns: [
      { key: 'userId', type: 'string', size: 64, required: true },
      { key: 'action', type: 'string', size: 64, required: true },
      { key: 'target', type: 'string', size: 64 },
      { key: 'detail', type: 'string', size: 2000 },
      { key: 'source', type: 'enum', elements: ['app', 'chatgpt', 'system'] },
      { key: 'occurredAt', type: 'datetime' },
    ],
    indexes: [{ key: 'idx_audit_user', type: 'key', columns: ['userId'] }],
  },
  {
    // サーバー専用。userId単位のレート制限カウンタ
    id: 'rate_limits',
    name: 'Rate Limits',
    columns: [
      { key: 'userId', type: 'string', size: 64, required: true },
      { key: 'bucket', type: 'string', size: 64, required: true },
      { key: 'windowStart', type: 'string', size: 32, required: true },
      { key: 'count', type: 'integer', min: 0, max: 1000000, default: 0 },
    ],
    indexes: [{ key: 'idx_rate_window', type: 'unique', columns: ['userId', 'bucket', 'windowStart'] }],
  },
];


// ---------------------------------------------------------------- 書き込みで確かめる

/**
 * **`status` を信じない。実際に1行書いて確かめる。**
 *
 * 本番で「`db:verify` は定義どおりと言うのに、書き込みが `Unknown attribute` で
 * 落ちる」状態が実際に起きた。列の一覧・statusと、書き込み経路から見えるスキーマが
 * 食い違うことがあるため、**本番と同じ経路（行の作成）で検査する**。
 *
 * 検査用の行はすぐ消す。誰にも読めないよう権限は空で作る。
 */
const PROBE_USER_ID = 'schemaprobe';

export function sampleValue(column: ColumnDef): unknown {
  switch (column.type) {
    case 'string': {
      const value = column.key === 'date' ? '1970-01-01' : PROBE_USER_ID;
      const trimmed = value.slice(0, column.size);
      return column.array ? [trimmed] : trimmed;
    }
    case 'integer':
    case 'float':
      return column.min ?? 0;
    case 'boolean':
      return false;
    case 'enum':
      return column.elements[0];
    case 'datetime':
      return new Date(0).toISOString();
  }
}

export function unknownAttributeOf(error: unknown): string | null {
  if (!(error instanceof AppwriteException)) return null;
  const match = /Unknown attribute:\s*"?([^"\s]+)"?/.exec(error.message ?? '');
  return match ? match[1] : null;
}

/** 書き込みから見えない列のキーを全部返す（空なら書き込みに使える） */
export async function probeWritableColumns(db: TablesDB, table: TableDef): Promise<string[]> {
  const rowId = `probe${table.id}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 36);
  const data: Record<string, unknown> = {};
  for (const column of table.columns) data[column.key] = sampleValue(column);

  const unknown: string[] = [];
  for (let attempt = 0; attempt <= table.columns.length; attempt++) {
    try {
      await db.createRow({ databaseId: DATABASE_ID, tableId: table.id, rowId, data, permissions: [] });
      return unknown;
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 409) return unknown; // 前回の残り
      const key = unknownAttributeOf(error);
      if (!key) throw error;
      unknown.push(key);
      delete data[key]; // 次の未知の列を見つけるために外して再試行
    } finally {
      try {
        await db.deleteRow({ databaseId: DATABASE_ID, tableId: table.id, rowId });
      } catch { /* 作れていなければ消すものも無い */ }
    }
  }
  return unknown;
}

/** 書き込みから見えない列を作り直す */
async function repairColumns(db: TablesDB, table: TableDef, keys: string[]): Promise<void> {
  for (const key of keys) {
    const column = table.columns.find(c => c.key === key);
    if (!column) {
      log(`! ${table.id}.${key} は定義に無い列です。Appwriteコンソールで確認してください`);
      missing.push(`${table.id}.${key}（定義に無い）`);
      continue;
    }
    log(`! ${table.id}.${key} は書き込みから見えません → 作り直します`);
    try {
      await db.deleteColumn({ databaseId: DATABASE_ID, tableId: table.id, key });
      await waitForColumnGone(db, table.id, key);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await createColumn(db, table.id, column);
    created.push(`${table.id}.${key}（作り直し）`);
  }
  if (keys.length > 0) await waitForColumns(db, table, keys);
}

async function ensureWritable(db: TablesDB, table: TableDef): Promise<void> {
  let unknown = await probeWritableColumns(db, table);
  if (unknown.length === 0) {
    log(`✓ ${table.id} は書き込みに使えます`);
    return;
  }

  if (verifyOnly) {
    for (const key of unknown) {
      const detail = `${table.id}.${key} が書き込みから見えない`;
      missing.push(detail);
      log(`✗ ${detail}`);
    }
    return;
  }

  // 直しては再確認する。1回の作り直しで別の列が現れることがある
  for (let round = 0; round < 5 && unknown.length > 0; round++) {
    await repairColumns(db, table, unknown);
    unknown = await probeWritableColumns(db, table);
  }
  if (unknown.length > 0) {
    for (const key of unknown) {
      missing.push(`${table.id}.${key} が直りません`);
      log(`✗ ${table.id}.${key} が直りません`);
    }
  } else {
    log(`✓ ${table.id} は書き込みに使えるようになりました`);
  }
}

// ---------------------------------------------------------------- 実行

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || 'liftandlean';
const DATABASE_NAME = 'Lift & Lean';

const verifyOnly = process.argv.includes('--verify-only');
const missing: string[] = [];
const created: string[] = [];

const log = (message: string) => console.log(message);

const isNotFound = (error: unknown): boolean =>
  error instanceof AppwriteException && (error.code === 404 || error.type === 'database_not_found' || error.type === 'table_not_found');

const isDuplicate = (error: unknown): boolean =>
  error instanceof AppwriteException && error.code === 409;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`環境変数 ${name} が未設定です。.env.example を参考に .env を作ってください。`);
    process.exit(1);
  }
  return value;
}

function buildClient(): TablesDB {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(requireEnv('APPWRITE_PROJECT_ID'))
    .setKey(requireEnv('APPWRITE_API_KEY'));
  return new TablesDB(client);
}

async function ensureDatabase(db: TablesDB): Promise<void> {
  try {
    await db.get({ databaseId: DATABASE_ID });
    log(`✓ database ${DATABASE_ID}`);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (verifyOnly) {
    missing.push(`database ${DATABASE_ID}`);
    log(`✗ database ${DATABASE_ID} がありません`);
    return;
  }
  await db.create({ databaseId: DATABASE_ID, name: DATABASE_NAME });
  created.push(`database ${DATABASE_ID}`);
  log(`+ database ${DATABASE_ID} を作成しました`);
}

async function ensureTable(db: TablesDB, table: TableDef): Promise<boolean> {
  try {
    const existing = await db.getTable({ databaseId: DATABASE_ID, tableId: table.id });
    if (!existing.rowSecurity) {
      // 行権限が効かない状態は他人のデータが見える状態と同義なので必ず直す
      if (verifyOnly) {
        missing.push(`${table.id}: Row Security が無効`);
        log(`✗ ${table.id}: Row Security が無効です`);
      } else {
        await db.updateTable({ databaseId: DATABASE_ID, tableId: table.id, name: table.name, permissions: [], rowSecurity: true });
        log(`! ${table.id}: Row Security を有効化しました`);
      }
    }
    if (existing.$permissions.length > 0) {
      missing.push(`${table.id}: table-level 権限が付いている（${existing.$permissions.join(', ')}）`);
      log(`✗ ${table.id}: table-level 権限が付いています。Appwriteコンソールから削除してください`);
    }
    return true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (verifyOnly) {
    missing.push(`table ${table.id}`);
    log(`✗ table ${table.id} がありません`);
    return false;
  }
  await db.createTable({
    databaseId: DATABASE_ID,
    tableId: table.id,
    name: table.name,
    permissions: [], // table-level 権限は誰にも与えない
    rowSecurity: true,
  });
  created.push(`table ${table.id}`);
  log(`+ table ${table.id} を作成しました`);
  return true;
}

async function createColumn(db: TablesDB, tableId: string, column: ColumnDef): Promise<void> {
  const base = { databaseId: DATABASE_ID, tableId, key: column.key };
  switch (column.type) {
    case 'string':
      await db.createStringColumn({ ...base, size: column.size, required: column.required ?? false, array: column.array ?? false });
      return;
    case 'integer':
      await db.createIntegerColumn({ ...base, required: column.required ?? false, min: column.min, max: column.max, xdefault: column.required ? undefined : column.default });
      return;
    case 'float':
      await db.createFloatColumn({ ...base, required: column.required ?? false, min: column.min, max: column.max, xdefault: column.required ? undefined : column.default });
      return;
    case 'boolean':
      await db.createBooleanColumn({ ...base, required: column.required ?? false, xdefault: column.required ? undefined : column.default });
      return;
    case 'enum':
      await db.createEnumColumn({ ...base, elements: column.elements, required: column.required ?? false });
      return;
    case 'datetime':
      await db.createDatetimeColumn({ ...base, required: column.required ?? false });
      return;
  }
}

/**
 * 列の一覧を状態つきで取得する。
 *
 * **列は「存在する」だけでは使えない。** Appwriteの列作成は非同期で、
 * `status` が `available` になるまで書き込みに使えず、`failed` になることもある。
 * 一覧に出るかどうかだけを見ていると、
 * 「スキーマは定義どおり」と表示されるのに書き込みが
 * `Unknown attribute` で失敗する状態を見逃す（実際に本番で起きた）。
 */
async function readColumnStatus(db: TablesDB, tableId: string): Promise<Map<string, { status: string; error: string }>> {
  const list = await db.listColumns({ databaseId: DATABASE_ID, tableId, queries: [Query.limit(100)] });
  return new Map(list.columns.map((column: any) => [column.key, { status: column.status, error: column.error }]));
}

async function ensureColumns(db: TablesDB, table: TableDef): Promise<void> {
  const existing = await readColumnStatus(db, table.id);

  for (const column of table.columns) {
    const current = existing.get(column.key);

    // 使える状態なら何もしない
    if (current && current.status === 'available') continue;

    // 一覧には出るが使えない（失敗・停止）。作り直しが要る
    if (current && (current.status === 'failed' || current.status === 'stuck')) {
      const detail = `${table.id}.${column.key} が ${current.status}${current.error ? `（${current.error}）` : ''}`;
      if (verifyOnly) {
        missing.push(detail);
        log(`✗ ${detail}`);
        continue;
      }
      log(`! ${detail} → 作り直します`);
      // 作成に失敗した列にデータは入っていないので、消して作り直して問題ない
      try {
        await db.deleteColumn({ databaseId: DATABASE_ID, tableId: table.id, key: column.key });
        await waitForColumnGone(db, table.id, column.key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    } else if (current && current.status === 'processing') {
      log(`… ${table.id}.${column.key} は作成中です`);
      if (verifyOnly) {
        missing.push(`${table.id}.${column.key} が作成中`);
        continue;
      }
      continue; // 待つのはindex作成前のwaitForColumnsに任せる
    } else if (current) {
      // status が想定外の値。verify で黙って作成へ落ちないよう明示的に扱う
      const detail = `${table.id}.${column.key} の状態が不明（${current.status}）`;
      missing.push(detail);
      log(`✗ ${detail}`);
      if (verifyOnly) continue;
    } else if (verifyOnly) {
      missing.push(`${table.id}.${column.key}`);
      log(`✗ ${table.id}.${column.key} がありません`);
      continue;
    }

    try {
      await createColumn(db, table.id, column);
      created.push(`${table.id}.${column.key}`);
      log(`+ ${table.id}.${column.key} (${column.type})`);
    } catch (error) {
      if (isDuplicate(error)) continue;
      throw error;
    }
  }
}

async function waitForColumnGone(db: TablesDB, tableId: string, key: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const columns = await readColumnStatus(db, tableId);
    if (!columns.has(key)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** index は列が available になってからでないと作れない */
async function waitForColumns(db: TablesDB, table: TableDef, keys: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const columns = await readColumnStatus(db, table.id);
    const pending = keys.filter(key => columns.get(key)?.status !== 'available');
    if (pending.length === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function ensureIndexes(db: TablesDB, table: TableDef): Promise<void> {
  const list = await db.listIndexes({ databaseId: DATABASE_ID, tableId: table.id });
  const existing = new Set(list.indexes.map(i => i.key));

  for (const index of table.indexes) {
    if (existing.has(index.key)) continue;
    if (verifyOnly) {
      missing.push(`${table.id}:${index.key}`);
      log(`✗ index ${table.id}.${index.key} がありません`);
      continue;
    }
    const ready = await waitForColumns(db, table, index.columns);
    if (!ready) {
      log(`! index ${table.id}.${index.key} は列の準備待ちで作れませんでした。もう一度 npm run db:setup を実行してください`);
      missing.push(`${table.id}:${index.key}`);
      continue;
    }
    try {
      await db.createIndex({
        databaseId: DATABASE_ID,
        tableId: table.id,
        key: index.key,
        type: index.type === 'unique' ? TablesDBIndexType.Unique : TablesDBIndexType.Key,
        columns: index.columns,
      });
      created.push(`${table.id}:${index.key}`);
      log(`+ index ${table.id}.${index.key} (${index.type})`);
    } catch (error) {
      if (isDuplicate(error)) continue;
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const db = buildClient();
  log(verifyOnly ? '--- Appwrite スキーマ検証 ---' : '--- Appwrite スキーマ反映 ---');
  log(`database: ${DATABASE_ID}`);

  await ensureDatabase(db);
  if (verifyOnly && missing.length > 0) {
    log('\nデータベースが無いため、テーブルの検証はできません。');
    process.exit(1);
  }

  for (const table of SCHEMA) {
    const ready = await ensureTable(db, table);
    if (!ready) continue;
    await ensureColumns(db, table);
    await ensureIndexes(db, table);
    // 最後に「本番と同じ経路で本当に書けるか」を確かめる
    await ensureWritable(db, table);
  }

  log('');
  if (verifyOnly) {
    if (missing.length === 0) {
      log('✓ 定義どおりです。');
      return;
    }
    log(`✗ ${missing.length}件の差分があります:`);
    for (const item of missing) log(`  - ${item}`);
    process.exit(1);
  }

  log(created.length === 0 ? '変更はありませんでした（すでに定義どおりです）。' : `${created.length}件を作成しました。`);
  if (missing.length > 0) {
    log('\n未完了があります。もう一度 npm run db:setup を実行してください:');
    for (const item of missing) log(`  - ${item}`);
    process.exit(1);
  }
  log('\n次は npm run db:verify で定義どおりか確認してください。');
}

// SCHEMA を他所から import しても実行されないよう、直接起動されたときだけ動かす
const executedDirectly = Boolean(process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ' '));

if (executedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof AppwriteException) {
      console.error(`Appwrite エラー (${error.code} ${error.type}): ${error.message}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
