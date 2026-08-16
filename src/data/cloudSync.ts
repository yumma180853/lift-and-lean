/**
 * 送信待ちの操作を、裏で順番にサーバーへ送る。
 *
 * 画面はこの結果を待たない。ここが失敗しても記録は端末に残っているので、
 * 電波が戻ってから続きを送る。
 *
 * ## 失敗の扱いを2つに分ける
 *   直せる見込みがある（圏外・サーバーの一時的な不調・混雑）
 *       → 間隔を空けて何度でもやり直す。記録は送信待ちのまま残す。
 *   直せない（内容が不正・権限が無い・対象がもう無い）
 *       → やり直しても同じなので諦め、**利用者に知らせる**。
 *         黙って捨てると「記録したのに無い」になる。
 */

import type { Meal } from '../types';
import { ApiError, dataApi } from '../utils/api';
import type { AppData } from './types';
import type { IdMap, Op } from './ops';

/** サーバーは部分更新でも全項目を検証するため、いまの内容を合成して送る */
const mealPayload = (meal: Partial<Meal>, date: string): Record<string, unknown> => ({
  date,
  name: meal.name ?? '',
  calories: Number(meal.calories) || 0,
  protein: Number(meal.protein) || 0,
  fat: Number(meal.fat) || 0,
  carbs: Number(meal.carbs) || 0,
  mealType: meal.mealType,
  servingLabel: meal.servingLabel,
  sourceType: meal.sourceType,
  sourceLabel: meal.sourceLabel,
  sourceUrl: meal.sourceUrl,
  note: meal.note,
});

/**
 * 操作を1件送る。サーバーが id を決めるものは「仮 id → 本物の id」を返す。
 *
 * `data` は**送信時点の画面の状態**。食事の部分更新のように、
 * サーバーが全項目を要求するものを組み立てるために要る。
 */
export async function sendOp(op: Op, data: AppData): Promise<IdMap> {
  switch (op.kind) {
    case 'addMeal': {
      // 仮 id をそのまま冪等キーにする。再送しても二重に増えない
      const { rowId } = await dataApi.addMeal({
        ...mealPayload(op.meal, op.date),
        clientRequestId: op.mealId,
      });
      return rowId && rowId !== op.mealId ? { [op.mealId]: rowId } : {};
    }

    case 'updateMeal': {
      const existing = data.meals.find(m => m.id === op.mealId);
      if (!existing) return {}; // もう無いものは送らない
      await dataApi.updateMeal(op.mealId, mealPayload(existing, existing.date));
      return {};
    }

    case 'deleteMeal':
      await dataApi.deleteMeal(op.mealId);
      return {};

    case 'saveWeight': {
      const { rowId } = await dataApi.saveWeight(op.weight, op.date);
      return rowId && rowId !== op.weightId ? { [op.weightId]: rowId } : {};
    }

    case 'addExercise': {
      const { rowId } = await dataApi.addExercise(op.date, op.name);
      return rowId && rowId !== op.exerciseId ? { [op.exerciseId]: rowId } : {};
    }

    case 'deleteExercise':
      await dataApi.deleteExercise(op.exerciseId);
      return {};

    case 'addSet': {
      const { rowId } = await dataApi.addSet(op.exerciseId, op.reps, op.weight);
      return rowId && rowId !== op.setId ? { [op.setId]: rowId } : {};
    }

    case 'updateSet':
      await dataApi.updateSet(op.setId, op.reps, op.weight);
      return {};

    case 'deleteSet':
      await dataApi.deleteSet(op.setId);
      return {};

    case 'saveGoals':
      await dataApi.saveGoals({ ...op.goals });
      return {};

    case 'saveProfile':
      await dataApi.saveProfile({ ...op.patch });
      return {};

    default:
      return {};
  }
}

// ---------------------------------------------------------------- 失敗の見分け

const isDelete = (op: Op): boolean =>
  op.kind === 'deleteMeal' || op.kind === 'deleteSet' || op.kind === 'deleteExercise';

/**
 * やり直す価値があるか。
 *
 * 圏外(0) / 混雑(429) / サーバー側の不調(5xx) はやり直す。
 * 内容が不正(400) や権限が無い(401/403) は何度送っても同じなので諦める。
 */
export function shouldRetry(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // 想定外は一応やり直す
  if (error.status === 0) return true;           // 通信そのものが失敗
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  return false;
}

/** 消そうとしたものが既に無い、は成功と同じ扱いでよい */
export const isAlreadyGone = (op: Op, error: unknown): boolean =>
  isDelete(op) && error instanceof ApiError && error.status === 404;

export const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '保存に失敗しました。時間をおいて試してください。';
};

/** やり直しの間隔。最初は短く、続くほど長く（最大30秒） */
export const backoffMs = (attempts: number): number =>
  Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempts - 1)));
