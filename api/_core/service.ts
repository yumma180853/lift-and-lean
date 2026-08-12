/**
 * ビジネスロジック。入口（PWAのREST / 将来のMCP）が何であってもここを通る。
 *
 * ここが持つ責務（.design/chatgpt-integration.md §3）:
 *   検証 / 認可 / JST正規化 / 冪等性 / rate limit / audit
 * ここが持たない責務:
 *   HTTPの形（router層） / DBの都合（repository層） / 自然文の理解（ChatGPT側）
 *
 * **userId は必ず引数で受け取る。リクエストbodyのuserIdは決して使わない。**
 */

import { randomUUID } from 'node:crypto';
import {
  deriveRowId,
  normalizeBackup,
  expectedCounts,
  planCounts,
  diffCounts,
} from '../_migration-helpers.js';
import { AppError, NotFoundError, RateLimitError, ValidationError } from './errors.js';
import { jstToday, resolveReadDate, resolveWriteDate, shiftDate, isDateString } from './dates.js';
import {
  goalsInputSchema,
  mealInputSchema,
  parseInput,
  profileInputSchema,
  weightInputSchema,
  workoutInputSchema,
  setInputSchema,
  exerciseInputSchema,
} from './validation.js';
import type { GoalsInput, MealInput, ProfileInput, WeightInput, WorkoutInput } from './validation.js';
import type { Clock, Repository, StoredRow, WriteRow } from './ports.js';
import { systemClock } from './ports.js';

/** 1日あたりの上限。userId単位で数える（端末ローカルの制限とは別物） */
export const RATE_LIMITS = {
  write: 300,
  nutrition: 10,
  migrate: 20,
} as const;

export type RateBucket = keyof typeof RATE_LIMITS;

const MAX_LIST_LIMIT = 500;

export interface ServiceOptions {
  repository: Repository;
  clock?: Clock;
  /** audit書き込みが失敗したときの通知先。既定はconsole.warn */
  onAuditFailure?: (error: unknown) => void;
}

export interface SaveOutcome {
  rowId: string;
  /** すでに保存済みだった（冪等な再送）場合 true */
  duplicated: boolean;
}

export interface DaySummary {
  date: string;
  totals: { calories: number; protein: number; fat: number; carbs: number };
  goals: { calories: number; protein: number; fat: number; carbs: number; targetWeight: number; trainerStyle?: string } | null;
  mealCount: number;
  weight: number | null;
  workout: { exercises: number; sets: number } | null;
}

export interface ProgressPoint {
  date: string;
  weight: number | null;
  calories: number;
}

export interface MigrationReport {
  applied: boolean;
  counts: ReturnType<typeof planCounts>;
  expected: ReturnType<typeof expectedCounts>;
  issues: string[];
  warnings: string[];
  written: { table: string; created: number; existed: number }[];
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** undefined の項目はDBへ送らない（列を空文字で潰さないため） */
const compact = (data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export class LiftAndLeanService {
  repository: Repository;
  clock: Clock;
  onAuditFailure: (error: unknown) => void;

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? systemClock;
    this.onAuditFailure = options.onAuditFailure ?? ((error) => console.warn('audit write failed:', error));
  }

  today(): string {
    return jstToday(this.clock.now());
  }

  // -------------------------------------------------------------- 共通

  /**
   * 1日あたりの利用回数を数える。
   * 「厳密に超えさせない」ためではなく濫用を止めるためのソフト上限で、
   * 同時実行時に数回分の誤差が出ることは許容する。
   */
  async consumeRateLimit(userId: string, bucket: RateBucket): Promise<void> {
    const limit = RATE_LIMITS[bucket];
    const windowStart = this.today();
    const rowId = deriveRowId(userId, 'rate', `${bucket}:${windowStart}`);

    let used: number;
    try {
      used = await this.repository.bumpServerCounter('rate_limits', rowId, 'count', {
        userId, bucket, windowStart,
      });
    } catch (error) {
      // 数えられないことを理由に記録を拒まない（fail open）。
      // 濫用の抑止が目的であって、正確な課金計算ではないため
      this.onAuditFailure(error);
      return;
    }

    if (used > limit) {
      throw new RateLimitError(`今日の上限（${limit}回）に達しました。明日また使えます。`);
    }
  }

  /** 監査ログ。書けなくても利用者の操作は止めない（記録の失敗で記録を失わせない） */
  async audit(userId: string, action: string, target: string, detail?: string): Promise<void> {
    try {
      await this.repository.appendServerRow('audit_log', randomUUID(), compact({
        userId,
        action,
        target,
        detail: detail ? detail.slice(0, 2000) : undefined,
        source: 'app',
        occurredAt: this.clock.now().toISOString(),
      }));
    } catch (error) {
      this.onAuditFailure(error);
    }
  }

  private clientKey(provided: string | undefined): string {
    // 指定が無ければ毎回別のキーにする。内容から導出すると
    // 「同じ食事を2回食べた」が重複と誤判定され、記録が消える
    return provided ?? randomUUID();
  }

  // -------------------------------------------------------------- 食事

  async logMeal(userId: string, rawInput: unknown): Promise<SaveOutcome> {
    const input = parseInput<MealInput>(mealInputSchema, rawInput);
    await this.consumeRateLimit(userId, 'write');

    const date = resolveWriteDate(input.date, this.today());
    const clientRequestId = this.clientKey(input.clientRequestId);
    const rowId = deriveRowId(userId, 'meal', clientRequestId);

    const result = await this.repository.putOwnedRows('meals', userId, [{
      rowId,
      data: compact({
        userId,
        clientRequestId,
        date,
        name: input.name,
        calories: input.calories,
        protein: input.protein,
        fat: input.fat,
        carbs: input.carbs,
        mealType: input.mealType,
        servingLabel: input.servingLabel,
        sourceType: input.sourceType,
        sourceLabel: input.sourceLabel,
        sourceUrl: input.sourceUrl,
        note: input.note,
        origin: 'app',
        needsReview: false,
      }),
    }], 'create');

    await this.audit(userId, 'meal.create', rowId, date);
    return { rowId, duplicated: result.existed > 0 };
  }

  async listMeals(userId: string, date?: unknown): Promise<StoredRow[]> {
    const target = resolveReadDate(date, this.today());
    return this.repository.listRows('meals', userId, {
      equals: { userId, date: target },
      orderAsc: '$createdAt',
      limit: MAX_LIST_LIMIT,
    });
  }

  async updateMeal(userId: string, rowId: string, rawInput: unknown): Promise<void> {
    const input = parseInput<MealInput>(mealInputSchema, rawInput);
    const date = resolveWriteDate(input.date, this.today());
    await this.repository.patchOwnedRow('meals', userId, rowId, compact({
      date,
      name: input.name,
      calories: input.calories,
      protein: input.protein,
      fat: input.fat,
      carbs: input.carbs,
      mealType: input.mealType,
      servingLabel: input.servingLabel,
      sourceType: input.sourceType,
      sourceLabel: input.sourceLabel,
      sourceUrl: input.sourceUrl,
      note: input.note,
      needsReview: false,
    }));
    await this.audit(userId, 'meal.update', rowId, date);
  }

  async deleteMeal(userId: string, rowId: string): Promise<void> {
    await this.repository.deleteOwnedRow('meals', userId, rowId);
    await this.audit(userId, 'meal.delete', rowId);
  }

  // -------------------------------------------------------------- 体重

  /** 同じ日に2回記録したら上書きする（既存アプリの addWeight と同じ挙動） */
  async logWeight(userId: string, rawInput: unknown): Promise<SaveOutcome> {
    const input = parseInput<WeightInput>(weightInputSchema, rawInput);
    await this.consumeRateLimit(userId, 'write');

    const date = resolveWriteDate(input.date, this.today());
    const rowId = deriveRowId(userId, 'weight', date);
    const result = await this.repository.putOwnedRows('weights', userId, [{
      rowId,
      data: {
        userId,
        clientRequestId: this.clientKey(input.clientRequestId),
        date,
        weight: input.weight,
        origin: 'app',
        needsReview: false,
      },
    }], 'upsert');

    await this.audit(userId, 'weight.upsert', rowId, date);
    return { rowId, duplicated: result.existed > 0 };
  }

  async listWeights(userId: string, from?: unknown, to?: unknown): Promise<StoredRow[]> {
    const today = this.today();
    const end = resolveReadDate(to, today);
    const start = from === undefined || from === null || from === '' ? shiftDate(end, -180) : resolveReadDate(from, today);
    return this.repository.listRows('weights', userId, {
      equals: { userId },
      between: { column: 'date', from: start, to: end },
      orderAsc: 'date',
      limit: MAX_LIST_LIMIT,
    });
  }

  // -------------------------------------------------------------- 筋トレ

  async logWorkout(userId: string, rawInput: unknown): Promise<SaveOutcome & { exercises: number; sets: number }> {
    const input = parseInput<WorkoutInput>(workoutInputSchema, rawInput);
    await this.consumeRateLimit(userId, 'write');

    const date = resolveWriteDate(input.date, this.today());
    const clientRequestId = this.clientKey(input.clientRequestId);
    const workoutRowId = deriveRowId(userId, 'workout', date);

    // 日単位の行は upsert（1日1件）。種目・セットは追記
    const workoutResult = await this.repository.putOwnedRows('workouts', userId, [{
      rowId: workoutRowId,
      data: { userId, clientRequestId, date, origin: 'app', needsReview: false },
    }], 'upsert');

    const exerciseRows: WriteRow[] = [];
    const setRows: WriteRow[] = [];
    input.exercises.forEach((exercise, i) => {
      const exerciseKey = `${clientRequestId}#e${i}`;
      const exerciseRowId = deriveRowId(userId, 'exercise', exerciseKey);
      exerciseRows.push({
        rowId: exerciseRowId,
        data: {
          userId, clientRequestId: exerciseKey, workoutId: workoutRowId,
          name: exercise.name, position: i, origin: 'app', needsReview: false,
        },
      });
      exercise.sets.forEach((set, j) => {
        const setKey = `${exerciseKey}s${j}`;
        setRows.push({
          rowId: deriveRowId(userId, 'set', setKey),
          data: {
            userId, clientRequestId: setKey, workoutId: workoutRowId, exerciseId: exerciseRowId,
            reps: set.reps, weight: set.weight, position: j, origin: 'app', needsReview: false,
          },
        });
      });
    });

    if (exerciseRows.length > 0) await this.repository.putOwnedRows('workout_exercises', userId, exerciseRows, 'create');
    if (setRows.length > 0) await this.repository.putOwnedRows('workout_sets', userId, setRows, 'create');

    await this.audit(userId, 'workout.create', workoutRowId, `${date} 種目${exerciseRows.length}`);
    return {
      rowId: workoutRowId,
      duplicated: workoutResult.existed > 0,
      exercises: exerciseRows.length,
      sets: setRows.length,
    };
  }

  async addExercise(userId: string, rawInput: unknown): Promise<SaveOutcome> {
    const body = (rawInput ?? {}) as Record<string, unknown>;
    const exercise = parseInput(exerciseInputSchema, { name: body.name, sets: body.sets ?? [] });
    const date = resolveWriteDate(body.date, this.today());
    const workoutRowId = deriveRowId(userId, 'workout', date);
    const clientRequestId = this.clientKey(typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined);
    const rowId = deriveRowId(userId, 'exercise', clientRequestId);

    await this.repository.putOwnedRows('workouts', userId, [{
      rowId: workoutRowId,
      data: { userId, clientRequestId: `w:${date}`, date, origin: 'app', needsReview: false },
    }], 'upsert');

    const existingCount = (await this.repository.listRows('workout_exercises', userId, {
      equals: { userId, workoutId: workoutRowId }, limit: MAX_LIST_LIMIT,
    })).length;

    const result = await this.repository.putOwnedRows('workout_exercises', userId, [{
      rowId,
      data: {
        userId, clientRequestId, workoutId: workoutRowId,
        name: exercise.name, position: existingCount, origin: 'app', needsReview: false,
      },
    }], 'create');

    await this.audit(userId, 'exercise.create', rowId, date);
    return { rowId, duplicated: result.existed > 0 };
  }

  async addSet(userId: string, exerciseRowId: string, rawInput: unknown): Promise<SaveOutcome> {
    const body = (rawInput ?? {}) as Record<string, unknown>;
    const set = parseInput(setInputSchema, { reps: body.reps, weight: body.weight });

    const owned = await this.repository.listRows('workout_exercises', userId, {
      equals: { userId, $id: exerciseRowId }, limit: 1,
    });
    if (owned.length === 0) throw new NotFoundError('その種目は見つかりませんでした。');

    const clientRequestId = this.clientKey(typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined);
    const rowId = deriveRowId(userId, 'set', clientRequestId);
    const existingCount = (await this.repository.listRows('workout_sets', userId, {
      equals: { userId, exerciseId: exerciseRowId }, limit: MAX_LIST_LIMIT,
    })).length;

    const result = await this.repository.putOwnedRows('workout_sets', userId, [{
      rowId,
      data: {
        userId, clientRequestId,
        workoutId: owned[0].workoutId, exerciseId: exerciseRowId,
        reps: set.reps, weight: set.weight, position: existingCount,
        origin: 'app', needsReview: false,
      },
    }], 'create');

    await this.audit(userId, 'set.create', rowId);
    return { rowId, duplicated: result.existed > 0 };
  }

  async updateSet(userId: string, rowId: string, rawInput: unknown): Promise<void> {
    const body = (rawInput ?? {}) as Record<string, unknown>;
    const set = parseInput(setInputSchema, { reps: body.reps, weight: body.weight });
    await this.repository.patchOwnedRow('workout_sets', userId, rowId, { reps: set.reps, weight: set.weight });
    await this.audit(userId, 'set.update', rowId);
  }

  async deleteSet(userId: string, rowId: string): Promise<void> {
    await this.repository.deleteOwnedRow('workout_sets', userId, rowId);
    await this.audit(userId, 'set.delete', rowId);
  }

  async deleteExercise(userId: string, rowId: string): Promise<void> {
    const sets = await this.repository.listRows('workout_sets', userId, {
      equals: { userId, exerciseId: rowId }, limit: MAX_LIST_LIMIT,
    });
    for (const set of sets) {
      await this.repository.deleteOwnedRow('workout_sets', userId, set.$id);
    }
    await this.repository.deleteOwnedRow('workout_exercises', userId, rowId);
    await this.audit(userId, 'exercise.delete', rowId, `sets=${sets.length}`);
  }

  async getWorkout(userId: string, date: string): Promise<{ date: string; rowId: string; exercises: any[] } | null> {
    const rows = await this.repository.listRows('workouts', userId, {
      equals: { userId, date }, limit: 1,
    });
    if (rows.length === 0) return null;
    const detailed = await this.attachExercises(userId, rows);
    return detailed[0];
  }

  async getRecentWorkouts(userId: string, limit = 5): Promise<any[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(num(limit)) || 5, 1), 50);
    const workouts = await this.repository.listRows('workouts', userId, {
      equals: { userId }, orderDesc: 'date', limit: safeLimit,
    });
    return this.attachExercises(userId, workouts);
  }

  /** 筋トレ・種目・セットを3クエリで組み立てる（1日ずつ引かない） */
  private async attachExercises(userId: string, workouts: StoredRow[]): Promise<any[]> {
    if (workouts.length === 0) return [];
    const workoutIds = workouts.map(w => w.$id);
    const exercises = await this.repository.listRows('workout_exercises', userId, {
      equals: { userId }, anyOf: { column: 'workoutId', values: workoutIds }, limit: MAX_LIST_LIMIT,
    });
    const exerciseIds = exercises.map(e => e.$id);
    const sets = exerciseIds.length === 0 ? [] : await this.repository.listRows('workout_sets', userId, {
      equals: { userId }, anyOf: { column: 'exerciseId', values: exerciseIds }, limit: MAX_LIST_LIMIT,
    });

    const setsByExercise = new Map<string, StoredRow[]>();
    for (const set of sets) {
      const list = setsByExercise.get(set.exerciseId) ?? [];
      list.push(set);
      setsByExercise.set(set.exerciseId, list);
    }

    return workouts.map(workout => ({
      rowId: workout.$id,
      date: workout.date,
      exercises: exercises
        .filter(e => e.workoutId === workout.$id)
        .sort((a, b) => num(a.position) - num(b.position))
        .map(exercise => ({
          rowId: exercise.$id,
          name: exercise.name,
          sets: (setsByExercise.get(exercise.$id) ?? [])
            .sort((a, b) => num(a.position) - num(b.position))
            .map(set => ({ rowId: set.$id, reps: num(set.reps), weight: num(set.weight) })),
        })),
    }));
  }

  // -------------------------------------------------------------- 目標・プロフィール

  async getGoals(userId: string): Promise<StoredRow | null> {
    const rows = await this.repository.listRows('goals', userId, { equals: { userId }, limit: 1 });
    return rows[0] ?? null;
  }

  async saveGoals(userId: string, rawInput: unknown): Promise<void> {
    const input = parseInput<GoalsInput>(goalsInputSchema, rawInput);
    await this.repository.putOwnedRows('goals', userId, [{
      rowId: deriveRowId(userId, 'goals', 'v1'),
      data: compact({ userId, ...input }),
    }], 'upsert');
    await this.audit(userId, 'goals.update', 'goals');
  }

  async getProfile(userId: string): Promise<StoredRow | null> {
    const rows = await this.repository.listRows('profiles', userId, { equals: { userId }, limit: 1 });
    return rows[0] ?? null;
  }

  async saveProfile(userId: string, rawInput: unknown): Promise<void> {
    const input = parseInput<ProfileInput>(profileInputSchema, rawInput);
    await this.repository.putOwnedRows('profiles', userId, [{
      rowId: deriveRowId(userId, 'profile', 'v1'),
      data: compact({
        userId,
        hiddenWorkoutDates: input.hiddenWorkoutDates,
        freezeUsedDates: input.freezeUsedDates,
        customExerciseCategories: input.customExerciseCategories ? JSON.stringify(input.customExerciseCategories) : undefined,
        longestStreak: input.longestStreak,
      }),
    }], 'upsert');
    await this.audit(userId, 'profile.update', 'profile');
  }

  // -------------------------------------------------------------- 集計

  async getDaySummary(userId: string, date?: unknown): Promise<DaySummary> {
    const target = resolveReadDate(date, this.today());
    const [meals, goals, workout, weights] = await Promise.all([
      this.listMeals(userId, target),
      this.getGoals(userId),
      this.getWorkout(userId, target),
      this.repository.listRows('weights', userId, { equals: { userId }, orderDesc: 'date', limit: 1 }),
    ]);

    const totals = meals.reduce<DaySummary['totals']>((acc, meal) => ({
      calories: acc.calories + num(meal.calories),
      protein: acc.protein + num(meal.protein),
      fat: acc.fat + num(meal.fat),
      carbs: acc.carbs + num(meal.carbs),
    }), { calories: 0, protein: 0, fat: 0, carbs: 0 });

    return {
      date: target,
      totals,
      goals: goals ? {
        calories: num(goals.calories), protein: num(goals.protein), fat: num(goals.fat),
        carbs: num(goals.carbs), targetWeight: num(goals.targetWeight), trainerStyle: goals.trainerStyle,
      } : null,
      mealCount: meals.length,
      weight: weights.length > 0 ? num(weights[0].weight) : null,
      workout: workout ? {
        exercises: workout.exercises.length,
        sets: workout.exercises.reduce((sum: number, e: any) => sum + e.sets.length, 0),
      } : null,
    };
  }

  async getProgress(userId: string, days = 30): Promise<ProgressPoint[]> {
    const span = Math.min(Math.max(Math.trunc(num(days)) || 30, 1), 365);
    const end = this.today();
    const start = shiftDate(end, -(span - 1));

    const [weights, meals] = await Promise.all([
      this.repository.listRows('weights', userId, {
        equals: { userId }, between: { column: 'date', from: start, to: end }, orderAsc: 'date', limit: MAX_LIST_LIMIT,
      }),
      this.repository.listRows('meals', userId, {
        equals: { userId }, between: { column: 'date', from: start, to: end }, limit: MAX_LIST_LIMIT,
      }),
    ]);

    const weightByDate = new Map<string, number>();
    for (const row of weights) weightByDate.set(row.date, num(row.weight));
    const caloriesByDate = new Map<string, number>();
    for (const row of meals) caloriesByDate.set(row.date, (caloriesByDate.get(row.date) ?? 0) + num(row.calories));

    const points: ProgressPoint[] = [];
    for (let i = 0; i < span; i++) {
      const date = shiftDate(start, i);
      points.push({
        date,
        weight: weightByDate.has(date) ? weightByDate.get(date)! : null,
        calories: caloriesByDate.get(date) ?? 0,
      });
    }
    return points;
  }

  // -------------------------------------------------------------- 移行

  /**
   * バックアップJSONをAppwriteへコピーする。
   * localStorage側は一切触らない（このAPIは読み取った結果を受け取るだけ）。
   * 同じJSONを何度送っても、決定的rowIdにより重複しない。
   */
  async migrateFromBackup(userId: string, backup: unknown): Promise<MigrationReport> {
    await this.consumeRateLimit(userId, 'migrate');

    const payload = (backup ?? {}) as Record<string, unknown>;
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
    if (payload.app !== undefined && payload.app !== 'lift-and-lean') {
      throw new ValidationError('このアプリのバックアップファイルではありません。');
    }

    const today = this.today();
    const plan = normalizeBackup(data, { userId, today });
    const expected = expectedCounts(data, today);
    const actual = planCounts(plan);
    const issues = diffCounts(expected, actual);

    if (issues.length > 0) {
      // 数が合わないまま書き込むと、あとで「何が欠けたか」を追えなくなる
      return { applied: false, counts: actual, expected, issues, warnings: plan.warnings, written: [] };
    }

    const written: { table: string; created: number; existed: number }[] = [];
    const steps: { table: 'weights' | 'meals' | 'workouts' | 'workout_exercises' | 'workout_sets'; rows: WriteRow[]; mode: 'create' | 'upsert' }[] = [
      { table: 'weights', rows: plan.weights.map(toWriteRow), mode: 'upsert' },
      { table: 'meals', rows: plan.meals.map(toWriteRow), mode: 'create' },
      { table: 'workouts', rows: plan.workouts.map(toWriteRow), mode: 'upsert' },
      { table: 'workout_exercises', rows: plan.exercises.map(toWriteRow), mode: 'create' },
      { table: 'workout_sets', rows: plan.sets.map(toWriteRow), mode: 'create' },
    ];

    for (const step of steps) {
      if (step.rows.length === 0) continue;
      const result = await this.repository.putOwnedRows(step.table, userId, step.rows, step.mode);
      written.push({ table: step.table, created: result.created, existed: result.existed });
    }

    if (plan.goals) {
      const { rowId, ...goalsData } = plan.goals;
      await this.repository.putOwnedRows('goals', userId, [{ rowId, data: goalsData }], 'upsert');
      written.push({ table: 'goals', created: 1, existed: 0 });
    }
    if (plan.profile) {
      const { rowId, ...profileData } = plan.profile;
      await this.repository.putOwnedRows('profiles', userId, [{
        rowId,
        data: { ...profileData, migratedAt: this.clock.now().toISOString() },
      }], 'upsert');
      written.push({ table: 'profiles', created: 1, existed: 0 });
    }

    await this.audit(userId, 'migrate.apply', 'backup', JSON.stringify(actual));
    return { applied: true, counts: actual, expected, issues: [], warnings: plan.warnings, written };
  }

  /** 書き込まずに、何件になるかだけを返す（移行前の確認用） */
  async previewMigration(userId: string, backup: unknown): Promise<MigrationReport> {
    const payload = (backup ?? {}) as Record<string, unknown>;
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
    const today = this.today();
    const plan = normalizeBackup(data, { userId, today });
    const expected = expectedCounts(data, today);
    const actual = planCounts(plan);
    return { applied: false, counts: actual, expected, issues: diffCounts(expected, actual), warnings: plan.warnings, written: [] };
  }

  /** 移行後の突き合わせ。DBに実際に入っている件数を数え直す */
  async verifyMigration(userId: string, backup: unknown): Promise<{ ok: boolean; issues: string[]; stored: Record<string, number> }> {
    const payload = (backup ?? {}) as Record<string, unknown>;
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
    const expected = expectedCounts(data, this.today());

    const [meals, weights, workouts, exercises, sets] = await Promise.all([
      this.repository.listRows('meals', userId, { equals: { userId }, limit: MAX_LIST_LIMIT }),
      this.repository.listRows('weights', userId, { equals: { userId }, limit: MAX_LIST_LIMIT }),
      this.repository.listRows('workouts', userId, { equals: { userId }, limit: MAX_LIST_LIMIT }),
      this.repository.listRows('workout_exercises', userId, { equals: { userId }, limit: MAX_LIST_LIMIT }),
      this.repository.listRows('workout_sets', userId, { equals: { userId }, limit: MAX_LIST_LIMIT }),
    ]);

    const stored = {
      meals: meals.length,
      weights: weights.length,
      workouts: workouts.length,
      exercises: exercises.length,
      sets: sets.length,
      totalCalories: meals.reduce((sum, m) => sum + num(m.calories), 0),
      latestWeight: weights.length === 0 ? null : num([...weights].sort((a, b) => String(a.date).localeCompare(String(b.date))).pop()!.weight),
    };
    const issues = diffCounts(expected, stored as any);
    return { ok: issues.length === 0, issues, stored: stored as any };
  }
}

function toWriteRow(row: Record<string, any>): WriteRow {
  const { rowId, ...data } = row;
  return { rowId, data: compact(data) };
}

export { AppError, ValidationError, isDateString };
