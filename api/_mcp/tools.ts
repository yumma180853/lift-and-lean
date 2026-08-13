/**
 * ChatGPT（MCP）から使える道具の定義。
 *
 * **ここには業務ロジックを置かない。** 引数を組み替えて `LiftAndLeanService` を
 * 呼ぶだけにする。検証・認可・JST・冪等性・rate limit・保存は全てサービス層の責務で、
 * PWAのRESTと同じ経路を通る。OpenAI側の仕様が変わってもこのファイルを差し替えれば済む。
 *
 * 返す内容には Appwrite の内部ID・監査情報・他人のデータを一切含めない。
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LIMITS, MEAL_SOURCE_TYPES } from '../_migration-helpers.js';
import type { LiftAndLeanService } from '../_core/service.js';

/** ChatGPT経由の書き込みであることをサービス層へ伝える */
const CHANNEL = { channel: 'chatgpt' as const };

/**
 * 通信の再送で二重登録しないための鍵。
 *
 * MCPクライアントは同じ呼び出しを再送しうる。引数が同じなら同じ鍵になるので、
 * サービス層の決定的rowIdがそのまま重複を防ぐ。
 * 一方で**あとから本人が同じ内容をもう一度記録した場合は別の記録にしたい**ため、
 * 時間帯（既定5分）を鍵に混ぜて、時間が経てば別の記録になるようにしている。
 */
const RETRY_WINDOW_MS = 5 * 60 * 1000;

export function deriveIdempotencyKey(
  userId: string,
  tool: string,
  args: unknown,
  now: number,
): string {
  const bucket = Math.floor(now / RETRY_WINDOW_MS);
  const material = `${userId}:${tool}:${stableStringify(args)}:${bucket}`;
  return `mcp-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/** 引数の順序が変わっても同じ鍵になるように並べ替えて文字列化する */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------- 入力の形

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('記録する日付（YYYY-MM-DD、日本時間）。省略すると今日。')
  .optional();

const clientRequestIdArg = z.string().min(1).max(128)
  .describe('この記録を一意に表す値。同じ呼び出しを再送するときは同じ値を使う。')
  .optional();

export const logMealInput = {
  name: z.string().min(1).max(100).describe('食べたものの名前。例: 鶏むね肉のサラダ'),
  calories: z.number().min(LIMITS.calories.min).max(LIMITS.calories.max).describe('カロリー(kcal)'),
  protein: z.number().min(LIMITS.macro.min).max(LIMITS.macro.max).describe('タンパク質(g)'),
  fat: z.number().min(LIMITS.macro.min).max(LIMITS.macro.max).describe('脂質(g)'),
  carbs: z.number().min(LIMITS.macro.min).max(LIMITS.macro.max).describe('炭水化物(g)'),
  date: dateArg,
  mealType: z.string().max(32).describe('朝食 / 昼食 / 夕食 / 間食 など').optional(),
  servingLabel: z.string().max(100).describe('分量の表記。例: 1人前、200g').optional(),
  sourceType: z.enum(MEAL_SOURCE_TYPES)
    .describe('数値の出どころ。official=商品の成分表示、web=公式サイトの栄養成分、ai_estimate=推定')
    .optional(),
  sourceLabel: z.string().max(200).describe('出どころの名前。例: 松屋 公式サイト').optional(),
  sourceUrl: z.string().url().max(500).describe('出どころのURL').optional(),
  note: z.string().max(500).optional(),
  clientRequestId: clientRequestIdArg,
};

export const logWeightInput = {
  weight: z.number().min(LIMITS.bodyWeight.min).max(LIMITS.bodyWeight.max).describe('体重(kg)'),
  date: dateArg,
  clientRequestId: clientRequestIdArg,
};

export const logWorkoutInput = {
  exercises: z.array(z.object({
    name: z.string().min(1).max(100).describe('種目名。例: ベンチプレス'),
    sets: z.array(z.object({
      reps: z.number().int().min(LIMITS.reps.min).max(LIMITS.reps.max).describe('回数'),
      weight: z.number().min(LIMITS.liftWeight.min).max(LIMITS.liftWeight.max).describe('重量(kg)。自重なら0'),
    })).max(50).describe('セット。同じ内容を3セットなら同じ要素を3つ並べる'),
  })).min(1).max(30).describe('その日に行った種目。複数種目をまとめて1回で記録する'),
  date: dateArg,
  clientRequestId: clientRequestIdArg,
};

export const getTodaySummaryInput = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('調べたい日付（省略すると今日）').optional(),
};

export const getRecentWorkoutsInput = {
  limit: z.number().int().min(1).max(20).describe('さかのぼる日数分の件数（既定5）').optional(),
};

export const getProgressInput = {
  days: z.number().int().min(1).max(365).describe('さかのぼる日数（既定30）').optional(),
};

// ---------------------------------------------------------------- 返す形

const round = (value: number): number => Math.round(value * 10) / 10;

export interface ToolResult {
  text: string;
  data: Record<string, unknown>;
}

export interface ToolContext {
  service: LiftAndLeanService;
  userId: string;
  now?: () => number;
}

const idempotencyFor = (ctx: ToolContext, tool: string, args: any): string =>
  args.clientRequestId ?? deriveIdempotencyKey(ctx.userId, tool, args, (ctx.now ?? Date.now)());

// ---------------------------------------------------------------- 書き込み

export async function logMeal(ctx: ToolContext, args: any): Promise<ToolResult> {
  const outcome = await ctx.service.logMeal(ctx.userId, {
    ...args,
    clientRequestId: idempotencyFor(ctx, 'log_meal', args),
  }, CHANNEL);

  return {
    text: outcome.duplicated
      ? `${args.name} はすでに記録済みです（重複して登録していません）。`
      : `${args.name} を記録しました（${args.calories}kcal / P${args.protein}g F${args.fat}g C${args.carbs}g）。`,
    data: { recorded: !outcome.duplicated, alreadyRecorded: outcome.duplicated },
  };
}

export async function logWeight(ctx: ToolContext, args: any): Promise<ToolResult> {
  await ctx.service.logWeight(ctx.userId, {
    ...args,
    clientRequestId: idempotencyFor(ctx, 'log_weight', args),
  }, CHANNEL);

  return {
    text: `体重 ${args.weight}kg を記録しました。同じ日に再度記録すると上書きされます。`,
    data: { recorded: true },
  };
}

export async function logWorkout(ctx: ToolContext, args: any): Promise<ToolResult> {
  const outcome = await ctx.service.logWorkout(ctx.userId, {
    ...args,
    clientRequestId: idempotencyFor(ctx, 'log_workout', args),
  }, CHANNEL);

  const names = args.exercises.map((e: any) => e.name).join('、');
  return {
    text: outcome.duplicated && outcome.exercises === 0
      ? 'この内容はすでに記録済みです（重複して登録していません）。'
      : `${names} を記録しました（${outcome.exercises}種目 / ${outcome.sets}セット）。`,
    data: { exercises: outcome.exercises, sets: outcome.sets, alreadyRecorded: outcome.duplicated },
  };
}

// ---------------------------------------------------------------- 読み取り

export async function getTodaySummary(ctx: ToolContext, args: any): Promise<ToolResult> {
  const summary = await ctx.service.getDaySummary(ctx.userId, args?.date);
  const { totals, goals } = summary;

  const remaining = goals ? {
    calories: round(goals.calories - totals.calories),
    protein: round(goals.protein - totals.protein),
    fat: round(goals.fat - totals.fat),
    carbs: round(goals.carbs - totals.carbs),
  } : null;

  const lines = [
    `${summary.date} の記録`,
    `食事 ${summary.mealCount}件：${round(totals.calories)}kcal / P${round(totals.protein)}g F${round(totals.fat)}g C${round(totals.carbs)}g`,
  ];
  if (goals) {
    lines.push(`目標まで：${remaining!.calories}kcal / P${remaining!.protein}g F${remaining!.fat}g C${remaining!.carbs}g`);
  }
  lines.push(summary.weight === null ? '体重：未記録' : `体重：${summary.weight}kg`);
  lines.push(summary.workout ? `筋トレ：${summary.workout.exercises}種目 ${summary.workout.sets}セット` : '筋トレ：未記録');

  return {
    text: lines.join('\n'),
    data: {
      date: summary.date,
      totals: { calories: round(totals.calories), protein: round(totals.protein), fat: round(totals.fat), carbs: round(totals.carbs) },
      goals,
      remaining,
      mealCount: summary.mealCount,
      weight: summary.weight,
      workout: summary.workout,
    },
  };
}

export async function getRecentWorkouts(ctx: ToolContext, args: any): Promise<ToolResult> {
  const workouts = await ctx.service.getRecentWorkouts(ctx.userId, args?.limit ?? 5);

  // 内部IDは返さない（ChatGPTには不要）
  const data = workouts.map(workout => ({
    date: workout.date,
    exercises: workout.exercises.map(exercise => ({
      name: exercise.name,
      sets: exercise.sets.map(set => ({ reps: set.reps, weight: set.weight })),
    })),
  }));

  const text = data.length === 0
    ? '筋トレの記録がまだありません。'
    : data.map(workout => {
        const detail = workout.exercises
          .map(e => `${e.name} ${e.sets.map(s => `${s.weight}kg×${s.reps}`).join(', ')}`)
          .join(' / ');
        return `${workout.date}：${detail || '種目なし'}`;
      }).join('\n');

  return { text, data: { workouts: data } };
}

export async function getProgress(ctx: ToolContext, args: any): Promise<ToolResult> {
  const days = args?.days ?? 30;
  const points = await ctx.service.getProgress(ctx.userId, days);

  const weighed = points.filter(point => point.weight !== null);
  const withMeals = points.filter(point => point.calories > 0);
  const first = weighed[0];
  const last = weighed[weighed.length - 1];
  const averageCalories = withMeals.length === 0
    ? null
    : round(withMeals.reduce((sum, point) => sum + point.calories, 0) / withMeals.length);

  const lines = [`直近${days}日の推移`];
  if (first && last) {
    const diff = round(last.weight! - first.weight!);
    const direction = diff === 0 ? '横ばい' : diff > 0 ? `+${diff}kg` : `${diff}kg`;
    lines.push(`体重：${first.date} ${first.weight}kg → ${last.date} ${last.weight}kg（${direction}）`);
  } else {
    lines.push('体重：記録がありません');
  }
  lines.push(averageCalories === null
    ? '食事：記録がありません'
    : `食事：記録のあった${withMeals.length}日で平均 ${averageCalories}kcal`);

  return {
    text: lines.join('\n'),
    data: {
      days,
      weight: first && last
        ? { from: { date: first.date, weight: first.weight }, to: { date: last.date, weight: last.weight }, changeKg: round(last.weight! - first.weight!) }
        : null,
      averageCalories,
      daysWithMeals: withMeals.length,
      points,
    },
  };
}

// ---------------------------------------------------------------- 一覧

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputShape: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run(ctx: ToolContext, args: any): Promise<ToolResult>;
}

/**
 * 公開する道具はこれだけ。
 * 削除・目標変更・アカウント操作・任意クエリは**意図的に公開しない**
 * （そもそも対応するtoolを存在させない）。
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'log_meal',
    title: '食事を記録する',
    description:
      '食べたものをLift & Leanに記録する。カロリーとPFCは呼び出し側が調べて渡す。'
      + '商品の成分表示や公式サイトの値が分かるときは sourceType と sourceLabel も渡すこと。'
      + '分からないまま推定した値は sourceType=ai_estimate として扱われ、あとで本人が確認できるよう印が付く。',
    inputShape: logMealInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: logMeal,
  },
  {
    name: 'log_weight',
    title: '体重を記録する',
    description: '体重を記録する。同じ日に2回記録した場合は上書きされる（1日1件）。',
    inputShape: logWeightInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: logWeight,
  },
  {
    name: 'log_workout',
    title: '筋トレを記録する',
    description:
      'その日の筋トレを記録する。複数の種目をまとめて1回で渡すこと。'
      + '「ベンチ60kg10回3セット」のように同じ内容を繰り返す場合は、同じセットを回数分並べる。',
    inputShape: logWorkoutInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: logWorkout,
  },
  {
    name: 'get_today_summary',
    title: '今日の記録を見る',
    description: '指定日（既定は今日）の食事の合計・目標までの残り・体重・筋トレの有無を返す。',
    inputShape: getTodaySummaryInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: getTodaySummary,
  },
  {
    name: 'get_recent_workouts',
    title: '最近の筋トレを見る',
    description: '直近の筋トレを新しい順に返す。前回の重量や回数を調べるときに使う。',
    inputShape: getRecentWorkoutsInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: getRecentWorkouts,
  },
  {
    name: 'get_progress',
    title: '推移を見る',
    description: '直近の体重の変化と、食事を記録した日の平均カロリーを返す。',
    inputShape: getProgressInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: getProgress,
  },
];
