/**
 * localStorage の全データを1つのJSONにまとめてダウンロードする。
 *
 * 移行計画（.design/db-migration-plan.md §4）の第1条件。
 * 「移行が何を壊してもここから復元できる」状態を、DB移行に着手する前に作る。
 *
 * このファイルは localStorage を読むだけで、書き込み・削除は一切しない。
 */

export const BACKUP_VERSION = 1;

/** バックアップに含める localStorage キー。キーを増やしたらここにも足す */
export const BACKUP_KEYS = [
  'meals',
  'workouts',
  'weight_history',
  'user_goals',
  'hidden_workout_dates',
  'custom_exercise_categories',
  'freeze_used_dates',
  'longest_streak',
  'reminders_enabled',
] as const;

export type BackupKey = (typeof BACKUP_KEYS)[number];

export interface BackupFile {
  app: 'lift-and-lean';
  version: number;
  /** 書き出した時刻（ISO 8601） */
  exportedAt: string;
  /** JSON.parse に成功したデータ */
  data: Partial<Record<BackupKey, unknown>>;
  /**
   * JSON.parse に失敗した生文字列。
   * 壊れたデータでもバックアップからは絶対に落とさない（復元時に人力で確認できる）。
   */
  unparsed: Partial<Record<BackupKey, string>>;
}

export interface BackupSummary {
  meals: number;
  workouts: number;
  weights: number;
  totalSets: number;
  hasGoals: boolean;
  unparsedKeys: BackupKey[];
}

type ReadItem = (key: string) => string | null;

const defaultRead: ReadItem = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * localStorage の内容からバックアップオブジェクトを作る。
 * 読み取り関数を差し替えられるようにしてあるのはテストのため。
 */
export function buildBackup(read: ReadItem = defaultRead, now: Date = new Date()): BackupFile {
  const data: Partial<Record<BackupKey, unknown>> = {};
  const unparsed: Partial<Record<BackupKey, string>> = {};

  for (const key of BACKUP_KEYS) {
    const raw = read(key);
    if (raw === null || raw === undefined) continue;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      unparsed[key] = raw;
    }
  }

  return {
    app: 'lift-and-lean',
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    data,
    unparsed,
  };
}

const countArray = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** バックアップの中身を1行で示すための件数サマリ。ダウンロード前の確認に使う */
export function summarizeBackup(backup: BackupFile): BackupSummary {
  const workouts = Array.isArray(backup.data.workouts) ? backup.data.workouts : [];
  let totalSets = 0;
  for (const workout of workouts) {
    const exercises = (workout as { exercises?: unknown })?.exercises;
    if (!Array.isArray(exercises)) continue;
    for (const exercise of exercises) {
      totalSets += countArray((exercise as { sets?: unknown })?.sets);
    }
  }

  return {
    meals: countArray(backup.data.meals),
    workouts: workouts.length,
    weights: countArray(backup.data.weight_history),
    totalSets,
    hasGoals: backup.data.user_goals !== undefined,
    unparsedKeys: Object.keys(backup.unparsed) as BackupKey[],
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 端末のローカル時刻でファイル名を作る（どの日のバックアップか本人が分かるように） */
export function backupFileName(now: Date = new Date()): string {
  return `lift-and-lean-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

/**
 * バックアップJSONをダウンロードする（ブラウザ専用）。
 * 成功したらサマリを返す。
 */
export function downloadBackup(): BackupSummary {
  const now = new Date();
  const backup = buildBackup(defaultRead, now);
  const blob = new Blob([serializeBackup(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFileName(now);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Safari は revoke が早すぎるとダウンロードに失敗するため次のタスクで解放する
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return summarizeBackup(backup);
}
