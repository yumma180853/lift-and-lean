/**
 * バックアップJSON（localStorage の中身）を Appwrite TablesDB の行へ変換する純粋関数群。
 *
 * 設計は .design/db-migration-plan.md に対応する:
 *  - rowId は userId + 種別 + 自然キー から決定的に導出する（§3.1）
 *    → 同じデータを何度importしても同じ rowId になるので重複しない
 *  - localStorage の id は rowId に使わず clientRequestId 列に保存する（§3.2）
 *  - 異常値は捨てずに丸めて needsReview を立て、warnings に何をしたか残す（§3.3）
 *
 * Appwrite への接続はここでは行わない。DBに触らないので単体テストで全部検証できる。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- 制限値

export const LIMITS = {
  /** 食事1件あたり */
  calories: { min: 0, max: 20000 },
  macro: { min: 0, max: 2000 },
  /** 体重計の値 */
  bodyWeight: { min: 20, max: 300 },
  /** 挙上重量 */
  liftWeight: { min: 0, max: 500 },
  reps: { min: 1, max: 1000 },
  targetWeight: { min: 20, max: 300 },
  longestStreak: { min: 0, max: 100000 },
} as const;

export const MEAL_SOURCE_TYPES = ['official', 'web', 'ai_estimate'] as const;
export const TRAINER_STYLES = ['buddy', 'coach', 'stoic', 'cheer'] as const;

const MAX_NAME_LENGTH = 100;
const MAX_LABEL_LENGTH = 200;
const MAX_URL_LENGTH = 500;
const MAX_NOTE_LENGTH = 500;
const MAX_CATEGORIES_LENGTH = 8000;

// ---------------------------------------------------------------- 行の型

interface BaseRow {
  rowId: string;
  userId: string;
  clientRequestId: string;
  origin: 'migration';
  needsReview: boolean;
}

export interface MealRow extends BaseRow {
  date: string;
  name: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  mealType?: string;
  servingLabel?: string;
  sourceType?: (typeof MEAL_SOURCE_TYPES)[number];
  sourceLabel?: string;
  sourceUrl?: string;
  note?: string;
}

export interface WeightRow extends BaseRow {
  date: string;
  weight: number;
}

export interface WorkoutRow extends BaseRow {
  date: string;
}

export interface ExerciseRow extends BaseRow {
  workoutId: string;
  name: string;
  position: number;
}

export interface SetRow extends BaseRow {
  workoutId: string;
  exerciseId: string;
  reps: number;
  weight: number;
  position: number;
}

export interface GoalsRow {
  rowId: string;
  userId: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  targetWeight: number;
  trainerStyle?: (typeof TRAINER_STYLES)[number];
}

export interface ProfileRow {
  rowId: string;
  userId: string;
  hiddenWorkoutDates: string[];
  customExerciseCategories: string;
  freezeUsedDates: string[];
  longestStreak: number;
}

export interface MigrationPlan {
  meals: MealRow[];
  weights: WeightRow[];
  workouts: WorkoutRow[];
  exercises: ExerciseRow[];
  sets: SetRow[];
  goals: GoalsRow | null;
  profile: ProfileRow | null;
  /** 丸めた・補完した・統合した内容の記録。移行後に人が読んで確認するためのもの */
  warnings: string[];
}

export interface MigrationCounts {
  meals: number;
  weights: number;
  workouts: number;
  exercises: number;
  sets: number;
  totalCalories: number;
  latestWeight: number | null;
}

// ---------------------------------------------------------------- rowId

const ROW_ID_BODY_LENGTH = 32;

/**
 * rowId を決定的に導出する。
 * Appwrite の rowId 制約（36文字以内・先頭は英数字・限られた文字種）を必ず満たす。
 */
export function deriveRowId(userId: string, kind: string, naturalKey: string): string {
  const digest = createHash('sha256').update(`${userId}:${kind}:${naturalKey}`).digest('hex');
  const body = BigInt(`0x${digest}`).toString(36).slice(0, ROW_ID_BODY_LENGTH);
  return `r${body.padStart(ROW_ID_BODY_LENGTH, '0')}`;
}

// ---------------------------------------------------------------- 変換の道具

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** JSTでの YYYY-MM-DD。サーバーのタイムゾーンに依存させない */
export function jstDateString(at: Date = new Date()): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const trimTo = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

interface NumberResult {
  value: number;
  adjusted: boolean;
}

const toNumber = (raw: unknown, range: { min: number; max: number }, fallback: number): NumberResult => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { value: fallback, adjusted: true };
  if (n < range.min) return { value: range.min, adjusted: true };
  if (n > range.max) return { value: range.max, adjusted: true };
  return { value: n, adjusted: false };
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const stringArray = (value: unknown): string[] =>
  asArray(value).filter((v): v is string => typeof v === 'string');

/** localStorage の id が欠けている壊れたデータでも、位置から安定したキーを作る */
const clientKey = (raw: unknown, fallback: string): string =>
  typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;

// ---------------------------------------------------------------- 本体

export interface NormalizeOptions {
  userId: string;
  /** date 欠損時の補完に使う日付（JST）。省略時は実行時のJST日付 */
  today?: string;
}

/**
 * バックアップJSONの `data` 部分を、そのまま書き込める行の集合へ変換する。
 * 入力は信用しない（型が何であっても落ちない）。
 */
export function normalizeBackup(data: Record<string, unknown>, options: NormalizeOptions): MigrationPlan {
  const userId = options.userId;
  const today = options.today ?? jstDateString();
  const warnings: string[] = [];

  const resolveDate = (raw: unknown, label: string): { date: string; adjusted: boolean } => {
    if (isValidDate(raw)) {
      if (raw > today) {
        warnings.push(`${label}: 未来の日付 ${raw} をそのまま保存し、要確認にしました`);
        return { date: raw, adjusted: true };
      }
      return { date: raw, adjusted: false };
    }
    warnings.push(`${label}: 日付が無い/不正なため ${today} で補完しました`);
    return { date: today, adjusted: true };
  };

  // ---- 食事
  const meals: MealRow[] = [];
  const seenMealKeys = new Set<string>();
  asArray(data.meals).forEach((raw, index) => {
    const meal = (raw ?? {}) as Record<string, unknown>;
    const clientRequestId = clientKey(meal.id, `meal-${index}`);
    if (seenMealKeys.has(clientRequestId)) {
      warnings.push(`食事[${index}]: id ${clientRequestId} が重複しているため後勝ちで統合しました`);
    }
    seenMealKeys.add(clientRequestId);

    const label = `食事[${index}]`;
    const { date, adjusted: dateAdjusted } = resolveDate(meal.date, label);
    const calories = toNumber(meal.calories, LIMITS.calories, 0);
    const protein = toNumber(meal.protein, LIMITS.macro, 0);
    const fat = toNumber(meal.fat, LIMITS.macro, 0);
    const carbs = toNumber(meal.carbs, LIMITS.macro, 0);
    const numbersAdjusted = calories.adjusted || protein.adjusted || fat.adjusted || carbs.adjusted;
    if (numbersAdjusted) warnings.push(`${label}: 数値を範囲内へ丸めました`);

    const sourceTypeRaw = meal.sourceType;
    const sourceType = MEAL_SOURCE_TYPES.find(t => t === sourceTypeRaw);

    const row: MealRow = {
      rowId: deriveRowId(userId, 'meal', clientRequestId),
      userId,
      clientRequestId,
      origin: 'migration',
      needsReview: dateAdjusted || numbersAdjusted,
      date,
      name: trimTo(meal.name, MAX_NAME_LENGTH) ?? '名称なし',
      calories: calories.value,
      protein: protein.value,
      fat: fat.value,
      carbs: carbs.value,
      mealType: trimTo(meal.mealType, 32),
      servingLabel: trimTo(meal.servingLabel, MAX_NAME_LENGTH),
      sourceType,
      sourceLabel: trimTo(meal.sourceLabel, MAX_LABEL_LENGTH),
      sourceUrl: trimTo(meal.sourceUrl, MAX_URL_LENGTH),
      note: trimTo(meal.note, MAX_NOTE_LENGTH),
    };
    // 同じ rowId は後勝ち（再実行時の挙動と揃える）
    const existing = meals.findIndex(m => m.rowId === row.rowId);
    if (existing >= 0) meals[existing] = row;
    else meals.push(row);
  });

  // ---- 体重（1日1件。同日は配列の最後を採用＝既存 addWeight と同じ挙動）
  const weightByDate = new Map<string, WeightRow>();
  asArray(data.weight_history).forEach((raw, index) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const label = `体重[${index}]`;
    const { date, adjusted: dateAdjusted } = resolveDate(record.date, label);
    const weight = toNumber(record.weight, LIMITS.bodyWeight, LIMITS.bodyWeight.min);
    if (weight.adjusted) warnings.push(`${label}: 体重を範囲内へ丸めました`);
    if (weightByDate.has(date)) warnings.push(`体重: ${date} に複数の記録があるため最後の値を採用しました`);

    weightByDate.set(date, {
      rowId: deriveRowId(userId, 'weight', date),
      userId,
      clientRequestId: clientKey(record.id, `weight-${index}`),
      origin: 'migration',
      needsReview: dateAdjusted || weight.adjusted,
      date,
      weight: weight.value,
    });
  });
  const weights = [...weightByDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ---- 筋トレ（1日1件。同日は種目数が多いものを基準に残りをマージ）
  const workoutsByDate = new Map<string, Record<string, unknown>[]>();
  asArray(data.workouts).forEach((raw, index) => {
    const workout = (raw ?? {}) as Record<string, unknown>;
    const exercises = asArray(workout.exercises);
    if (exercises.length === 0) return; // 既存UIも0種目の日は表示しない
    const { date } = resolveDate(workout.date, `筋トレ[${index}]`);
    const bucket = workoutsByDate.get(date);
    if (bucket) bucket.push(workout);
    else workoutsByDate.set(date, [workout]);
  });

  const workouts: WorkoutRow[] = [];
  const exerciseRows: ExerciseRow[] = [];
  const setRows: SetRow[] = [];

  for (const date of [...workoutsByDate.keys()].sort()) {
    const candidates = workoutsByDate.get(date)!;
    const ordered = [...candidates].sort(
      (a, b) => asArray(b.exercises).length - asArray(a.exercises).length,
    );
    if (ordered.length > 1) {
      warnings.push(`筋トレ: ${date} に${ordered.length}件の記録があるため1件へ統合しました`);
    }

    const base = ordered[0];
    const clientRequestId = clientKey(base.id, `workout-${date}`);
    const workoutRowId = deriveRowId(userId, 'workout', date);
    const mergedExercises = ordered.flatMap(w => asArray(w.exercises));

    workouts.push({
      rowId: workoutRowId,
      userId,
      clientRequestId,
      origin: 'migration',
      needsReview: ordered.length > 1,
      date,
    });

    mergedExercises.forEach((exerciseRaw, i) => {
      const exercise = (exerciseRaw ?? {}) as Record<string, unknown>;
      const exerciseKey = `${clientRequestId}#e${i}`;
      const exerciseRowId = deriveRowId(userId, 'exercise', exerciseKey);
      exerciseRows.push({
        rowId: exerciseRowId,
        userId,
        clientRequestId: exerciseKey,
        origin: 'migration',
        needsReview: false,
        workoutId: workoutRowId,
        name: trimTo(exercise.name, MAX_NAME_LENGTH) ?? '種目なし',
        position: i,
      });

      asArray(exercise.sets).forEach((setRaw, j) => {
        const set = (setRaw ?? {}) as Record<string, unknown>;
        const reps = toNumber(set.reps, LIMITS.reps, LIMITS.reps.min);
        const weight = toNumber(set.weight, LIMITS.liftWeight, 0);
        if (reps.adjusted || weight.adjusted) {
          warnings.push(`筋トレ ${date} の${i + 1}種目目 ${j + 1}セット目: 数値を範囲内へ丸めました`);
        }
        const setKey = `${exerciseKey}s${j}`;
        setRows.push({
          rowId: deriveRowId(userId, 'set', setKey),
          userId,
          clientRequestId: setKey,
          origin: 'migration',
          needsReview: reps.adjusted || weight.adjusted,
          workoutId: workoutRowId,
          exerciseId: exerciseRowId,
          reps: reps.value,
          weight: weight.value,
          position: j,
        });
      });
    });
  }

  // ---- 目標
  let goals: GoalsRow | null = null;
  if (data.user_goals && typeof data.user_goals === 'object') {
    const g = data.user_goals as Record<string, unknown>;
    const calories = toNumber(g.calories, LIMITS.calories, 2200);
    const protein = toNumber(g.protein, LIMITS.macro, 150);
    const fat = toNumber(g.fat, LIMITS.macro, 60);
    const carbs = toNumber(g.carbs, LIMITS.macro, 250);
    const targetWeight = toNumber(g.targetWeight, LIMITS.targetWeight, 70);
    if (calories.adjusted || protein.adjusted || fat.adjusted || carbs.adjusted || targetWeight.adjusted) {
      warnings.push('目標: 数値を範囲内へ丸めました');
    }
    goals = {
      rowId: deriveRowId(userId, 'goals', 'v1'),
      userId,
      calories: calories.value,
      protein: protein.value,
      fat: fat.value,
      carbs: carbs.value,
      targetWeight: targetWeight.value,
      trainerStyle: TRAINER_STYLES.find(s => s === g.trainerStyle),
    };
  }

  // ---- UI状態
  const hiddenWorkoutDates = stringArray(data.hidden_workout_dates);
  const freezeUsedDates = stringArray(data.freeze_used_dates);
  const categoriesRaw = data.custom_exercise_categories;
  const categories = categoriesRaw && typeof categoriesRaw === 'object' ? categoriesRaw : {};
  let customExerciseCategories = JSON.stringify(categories);
  if (customExerciseCategories.length > MAX_CATEGORIES_LENGTH) {
    warnings.push('種目カテゴリ: 上限を超えたため保存しませんでした（アプリで再設定できます）');
    customExerciseCategories = '{}';
  }
  const longestStreak = toNumber(data.longest_streak, LIMITS.longestStreak, 0);

  const hasProfileData =
    hiddenWorkoutDates.length > 0 ||
    freezeUsedDates.length > 0 ||
    customExerciseCategories !== '{}' ||
    longestStreak.value > 0;

  const profile: ProfileRow | null = hasProfileData
    ? {
        rowId: deriveRowId(userId, 'profile', 'v1'),
        userId,
        hiddenWorkoutDates,
        freezeUsedDates,
        customExerciseCategories,
        longestStreak: longestStreak.value,
      }
    : null;

  return { meals, weights, workouts, exercises: exerciseRows, sets: setRows, goals, profile, warnings };
}

// ---------------------------------------------------------------- 検証

/**
 * 移行前のデータから期待される件数を、normalizeBackup とは別経路で数える。
 * 同じ関数の出力どうしを比べても検証にならないため、あえて素朴に実装している。
 */
export function expectedCounts(data: Record<string, unknown>, today: string): MigrationCounts {
  // id が重複した食事は後勝ちで1件になる（移行側と同じ数え方にする）
  const mealCalories = new Map<string, number>();
  asArray(data.meals).forEach((raw, index) => {
    const meal = (raw ?? {}) as Record<string, unknown>;
    const n = Number(meal.calories);
    const value = Number.isFinite(n)
      ? Math.min(Math.max(n, LIMITS.calories.min), LIMITS.calories.max)
      : 0;
    mealCalories.set(clientKey(meal.id, `meal-${index}`), value);
  });
  const totalCalories = [...mealCalories.values()].reduce((sum, n) => sum + n, 0);

  const weightDates = new Map<string, number>();
  asArray(data.weight_history).forEach(raw => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const date = isValidDate(record.date) ? record.date : today;
    const n = Number(record.weight);
    const value = Number.isFinite(n)
      ? Math.min(Math.max(n, LIMITS.bodyWeight.min), LIMITS.bodyWeight.max)
      : LIMITS.bodyWeight.min;
    weightDates.set(date, value);
  });
  const latestDate = [...weightDates.keys()].sort().pop();

  const workoutDates = new Set<string>();
  let exercises = 0;
  let sets = 0;
  asArray(data.workouts).forEach(raw => {
    const workout = (raw ?? {}) as Record<string, unknown>;
    const list = asArray(workout.exercises);
    if (list.length === 0) return;
    workoutDates.add(isValidDate(workout.date) ? workout.date : today);
    exercises += list.length;
    for (const exercise of list) {
      sets += asArray((exercise as Record<string, unknown>)?.sets).length;
    }
  });

  return {
    meals: mealCalories.size,
    weights: weightDates.size,
    workouts: workoutDates.size,
    exercises,
    sets,
    totalCalories,
    latestWeight: latestDate === undefined ? null : weightDates.get(latestDate)!,
  };
}

export function planCounts(plan: MigrationPlan): MigrationCounts {
  const latest = plan.weights.length > 0 ? plan.weights[plan.weights.length - 1].weight : null;
  return {
    meals: plan.meals.length,
    weights: plan.weights.length,
    workouts: plan.workouts.length,
    exercises: plan.exercises.length,
    sets: plan.sets.length,
    totalCalories: plan.meals.reduce((sum, m) => sum + m.calories, 0),
    latestWeight: latest,
  };
}

/** 一致しなかった項目を日本語で返す。空配列なら検証OK */
export function diffCounts(expected: MigrationCounts, actual: MigrationCounts): string[] {
  const labels: Record<keyof MigrationCounts, string> = {
    meals: '食事',
    weights: '体重',
    workouts: '筋トレ',
    exercises: '種目',
    sets: 'セット',
    totalCalories: '合計カロリー',
    latestWeight: '最新の体重',
  };
  const issues: string[] = [];
  for (const key of Object.keys(labels) as (keyof MigrationCounts)[]) {
    const a = expected[key];
    const b = actual[key];
    const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b;
    if (!same) issues.push(`${labels[key]}: 移行前 ${a} / 移行後 ${b}`);
  }
  return issues;
}
