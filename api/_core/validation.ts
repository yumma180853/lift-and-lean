/**
 * 入力の検証。ChatGPTから来た値もアプリから来た値も、ここを必ず通す。
 *
 * 上限値は移行ロジックと同じ `LIMITS` を使う（定義を二重に持たない）。
 */

import { z } from 'zod';
import { LIMITS, MEAL_SOURCE_TYPES, TRAINER_STYLES } from '../_migration-helpers.js';
import { ValidationError } from './errors.js';

const macro = () => z.number().finite().min(LIMITS.macro.min).max(LIMITS.macro.max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/** YYYY-MM-DD だけを受ける。実在する日かどうかは resolveWriteDate 側で確かめる */
const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD の形式で指定してください。').optional();

/** 二重POST防止のための冪等キー。呼び出し側が指定しなければサーバーが決める */
const clientRequestId = z.string().trim().min(1).max(128).optional();

export const mealInputSchema = z.object({
  clientRequestId,
  date: dateInput,
  name: z.string().trim().min(1, '食事名を入れてください。').max(100),
  calories: z.number().finite().min(LIMITS.calories.min).max(LIMITS.calories.max),
  protein: macro(),
  fat: macro(),
  carbs: macro(),
  mealType: optionalText(32),
  servingLabel: optionalText(100),
  sourceType: z.enum(MEAL_SOURCE_TYPES).optional(),
  sourceLabel: optionalText(200),
  sourceUrl: z.string().trim().url('URLの形式が正しくありません。').max(500).optional(),
  note: optionalText(500),
});

export const weightInputSchema = z.object({
  clientRequestId,
  date: dateInput,
  weight: z.number().finite().min(LIMITS.bodyWeight.min).max(LIMITS.bodyWeight.max),
});

export const setInputSchema = z.object({
  reps: z.number().int('回数は整数で指定してください。').min(LIMITS.reps.min).max(LIMITS.reps.max),
  weight: z.number().finite().min(LIMITS.liftWeight.min).max(LIMITS.liftWeight.max),
});

export const exerciseInputSchema = z.object({
  name: z.string().trim().min(1, '種目名を入れてください。').max(100),
  sets: z.array(setInputSchema).max(50, '1種目のセットは50件までです。').default([]),
});

export const workoutInputSchema = z.object({
  clientRequestId,
  date: dateInput,
  exercises: z.array(exerciseInputSchema).min(1, '種目を1つ以上指定してください。').max(30, '1日の種目は30件までです。'),
});

export const goalsInputSchema = z.object({
  calories: z.number().finite().min(LIMITS.calories.min).max(LIMITS.calories.max),
  protein: macro(),
  fat: macro(),
  carbs: macro(),
  targetWeight: z.number().finite().min(LIMITS.targetWeight.min).max(LIMITS.targetWeight.max),
  trainerStyle: z.enum(TRAINER_STYLES).optional(),
});

export const profileInputSchema = z.object({
  hiddenWorkoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(2000).optional(),
  freezeUsedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(2000).optional(),
  customExerciseCategories: z.record(z.string().max(100), z.string().max(50)).optional(),
  longestStreak: z.number().int().min(LIMITS.longestStreak.min).max(LIMITS.longestStreak.max).optional(),
});

export const credentialsSchema = z.object({
  email: z.string().trim().email('メールアドレスの形式が正しくありません。').max(320),
  // Appwriteのパスワード要件は8文字以上・256文字以内
  password: z.string().min(8, 'パスワードは8文字以上にしてください。').max(256),
  name: z.string().trim().min(1).max(128).optional(),
});

/** パスワード再設定の申し込み。登録済みかどうかは応答から分からないようにする */
export const recoveryRequestSchema = z.object({
  email: z.string().trim().email('メールアドレスの形式が正しくありません。').max(320),
});

/** メールのリンクから戻ってきたときの新パスワード設定 */
export const recoveryConfirmSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  secret: z.string().trim().min(1).max(512),
  password: z.string().min(8, 'パスワードは8文字以上にしてください。').max(256),
});

/** メール確認リンクから戻ってきたときの完了要求 */
export const verificationConfirmSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  secret: z.string().trim().min(1).max(512),
});

export type VerificationConfirm = z.infer<typeof verificationConfirmSchema>;
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type RecoveryConfirm = z.infer<typeof recoveryConfirmSchema>;

export type MealInput = z.infer<typeof mealInputSchema>;
export type WeightInput = z.infer<typeof weightInputSchema>;
export type WorkoutInput = z.infer<typeof workoutInputSchema>;
export type GoalsInput = z.infer<typeof goalsInputSchema>;
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

/** zodの結果を日本語のValidationErrorへ変換する。内部構造はそのまま外に出さない */
export function parseInput<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success && result.data !== undefined) return result.data;

  const issues = (result.error?.issues ?? []).slice(0, 5).map(issue => ({
    field: issue.path.join('.') || '(全体)',
    message: issue.message,
  }));
  const first = issues[0];
  throw new ValidationError(
    first ? `${first.field}: ${first.message}` : '入力の内容が正しくありません。',
    issues,
  );
}
