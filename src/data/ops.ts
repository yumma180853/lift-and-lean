/**
 * 記録の変更を「操作（Op）」という値にして、画面の状態計算と送信を切り離す。
 *
 * これまでは「サーバーに保存できてから画面を書き換える」作りだった。
 * 電波が悪いと1文字打つたびに数秒待たされ、遅れて返ってきた応答が
 * 入力中の値を巻き戻すことがあった。
 *
 * ここでは
 *   1. 操作を **その場で** 画面の状態へ適用する（applyOp）
 *   2. 同じ操作を送信待ちの列（outbox）に積む
 *   3. 送信は裏でやる
 * という形にする。そのために、状態計算は**通信を一切しない純粋な関数**にしてある。
 *
 * ## 再適用できることが要件
 * サーバーから新しいスナップショットが届いたら
 * 「スナップショット + まだ送れていない操作」を計算し直して画面に出す。
 * つまり **同じ操作を何度適用しても同じ結果になる**必要がある。
 * だから id は適用時に採番せず、**操作を作った時点で決めて Op に持たせる**。
 */

import type { Meal, UserGoals, WeightRecord } from '../types';
import { findExercise, findSet, replaceWorkouts, upsertWorkoutDate } from './types';
import type { AppData, NewMeal, ProfilePatch } from './types';

export type Op =
  | { kind: 'addMeal'; mealId: string; date: string; meal: NewMeal }
  | { kind: 'updateMeal'; mealId: string; patch: Partial<Meal> }
  | { kind: 'deleteMeal'; mealId: string }
  | { kind: 'saveWeight'; weightId: string; date: string; weight: number }
  | { kind: 'addExercise'; exerciseId: string; workoutId: string; date: string; name: string }
  | { kind: 'deleteExercise'; exerciseId: string }
  | { kind: 'addSet'; setId: string; exerciseId: string; weight: number; reps: number }
  | { kind: 'updateSet'; setId: string; weight: number; reps: number }
  | { kind: 'deleteSet'; setId: string }
  | { kind: 'saveGoals'; goals: UserGoals }
  | { kind: 'saveProfile'; patch: ProfilePatch };

export type OpKind = Op['kind'];

/**
 * 操作を状態へ適用する。**例外を投げない。**
 *
 * 対象が見つからない操作（すでに消えた食事の更新など）は「何もしない」で通す。
 * 再適用のたびに例外が飛ぶと、画面全体が落ちてしまうため。
 * 入力時の妥当性チェックは操作を作る側（useAppData）でやる。
 */
export function applyOp(data: AppData, op: Op): AppData {
  switch (op.kind) {
    case 'addMeal': {
      if (data.meals.some(m => m.id === op.mealId)) return data; // 二重適用を防ぐ
      return { ...data, meals: [...data.meals, { ...op.meal, id: op.mealId, date: op.date } as Meal] };
    }

    case 'updateMeal': {
      if (!data.meals.some(m => m.id === op.mealId)) return data;
      return { ...data, meals: data.meals.map(m => m.id === op.mealId ? { ...m, ...op.patch } : m) };
    }

    case 'deleteMeal':
      return { ...data, meals: data.meals.filter(m => m.id !== op.mealId) };

    case 'saveWeight': {
      // 同じ日に2回記録したら上書き（元からの挙動）
      const record: WeightRecord = { id: op.weightId, date: op.date, weight: op.weight };
      const index = data.weights.findIndex(w => w.date === op.date);
      const weights = index > -1
        ? data.weights.map((w, i) => i === index ? { ...record, id: w.id } : w)
        : [...data.weights, record];
      return { ...data, weights };
    }

    case 'addExercise': {
      if (findExercise(data, op.exerciseId)) return data; // 二重適用を防ぐ
      const withDay = upsertWorkoutDate(data, op.date, op.workoutId);
      const workouts = withDay.workouts.map(workout => workout.date !== op.date ? workout : {
        ...workout,
        exercises: [...workout.exercises, { id: op.exerciseId, name: op.name, sets: [] }],
      });
      return replaceWorkouts(withDay, workouts);
    }

    case 'deleteExercise': {
      const workouts = data.workouts.map(workout => ({
        ...workout,
        exercises: workout.exercises.filter(e => e.id !== op.exerciseId),
      }));
      return replaceWorkouts(data, workouts);
    }

    case 'addSet': {
      if (!findExercise(data, op.exerciseId)) return data;
      if (findSet(data, op.setId)) return data; // 二重適用を防ぐ
      const workouts = data.workouts.map(workout => ({
        ...workout,
        exercises: workout.exercises.map(exercise => exercise.id !== op.exerciseId ? exercise : {
          ...exercise,
          sets: [...exercise.sets, { id: op.setId, weight: op.weight, reps: op.reps }],
        }),
      }));
      return replaceWorkouts(data, workouts);
    }

    case 'updateSet': {
      if (!findSet(data, op.setId)) return data;
      const workouts = data.workouts.map(workout => ({
        ...workout,
        exercises: workout.exercises.map(exercise => ({
          ...exercise,
          sets: exercise.sets.map(set => set.id !== op.setId ? set : { ...set, weight: op.weight, reps: op.reps }),
        })),
      }));
      return replaceWorkouts(data, workouts);
    }

    case 'deleteSet': {
      const workouts = data.workouts.map(workout => ({
        ...workout,
        exercises: workout.exercises.map(exercise => ({
          ...exercise,
          sets: exercise.sets.filter(set => set.id !== op.setId),
        })),
      }));
      return replaceWorkouts(data, workouts);
    }

    case 'saveGoals':
      return { ...data, goals: op.goals };

    case 'saveProfile':
      return { ...data, ...op.patch };

    default: {
      const never: never = op;
      return data && never;
    }
  }
}

/** スナップショット + 未送信の操作 = いま画面に出すべき状態 */
export const replay = (base: AppData, ops: Op[]): AppData => ops.reduce(applyOp, base);

// ---------------------------------------------------------------- id の張り替え

/**
 * 端末が仮に決めた id を、サーバーが決めた id に読み替える。
 *
 * オフラインで「種目を足す → セットを足す」をやると、セットの操作は
 * まだ存在しない仮の種目 id を指している。種目の送信が通って本物の id が
 * 分かった時点で、後続の操作を張り替えてから送る必要がある。
 */
export type IdMap = Record<string, string>;

const swap = (id: string, map: IdMap): string => map[id] ?? id;

export function remapOp(op: Op, map: IdMap): Op {
  if (Object.keys(map).length === 0) return op;
  switch (op.kind) {
    case 'updateMeal':
    case 'deleteMeal':
      return { ...op, mealId: swap(op.mealId, map) };
    case 'deleteExercise':
      return { ...op, exerciseId: swap(op.exerciseId, map) };
    case 'addSet':
      return { ...op, exerciseId: swap(op.exerciseId, map) };
    case 'updateSet':
    case 'deleteSet':
      return { ...op, setId: swap(op.setId, map) };
    default:
      return op;
  }
}

/**
 * 状態の中の仮 id を本物の id に置き換える。
 * 送信が通ったあと、画面が持っている仮 id を本物に合わせるために使う。
 */
export function remapData(data: AppData, map: IdMap): AppData {
  if (Object.keys(map).length === 0) return data;
  return {
    ...data,
    meals: data.meals.map(m => map[m.id] ? { ...m, id: map[m.id] } : m),
    weights: data.weights.map(w => map[w.id] ? { ...w, id: map[w.id] } : w),
    workouts: data.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => ({
        ...(map[exercise.id] ? { ...exercise, id: map[exercise.id] } : exercise),
        sets: exercise.sets.map(set => map[set.id] ? { ...set, id: map[set.id] } : set),
      })),
    })),
  };
}

// ---------------------------------------------------------------- まとめ書き

/**
 * 送信待ちの列に新しい操作を足す。**同じものへの連続した変更はまとめる。**
 *
 * 目標値を「1850」と打つと onChange が4回走る。素直に積むと4回送ることになるが、
 * 送られていない古い値には意味がない。最後の1回だけ残す。
 *
 * `inFlight` は「もう送信を始めてしまった件数」。送信中のものを書き換えると
 * サーバーと食い違うので、そこには触らない。
 */
export function enqueue(pending: Op[], next: Op, inFlight = 0): Op[] {
  const lastIndex = pending.length - 1;
  const last = lastIndex >= inFlight ? pending[lastIndex] : undefined;

  if (last) {
    if (next.kind === 'saveGoals' && last.kind === 'saveGoals') {
      return [...pending.slice(0, lastIndex), next];
    }
    if (next.kind === 'saveProfile' && last.kind === 'saveProfile') {
      return [...pending.slice(0, lastIndex), { kind: 'saveProfile', patch: { ...last.patch, ...next.patch } }];
    }
    if (next.kind === 'updateSet' && last.kind === 'updateSet' && last.setId === next.setId) {
      return [...pending.slice(0, lastIndex), next];
    }
    if (next.kind === 'updateMeal' && last.kind === 'updateMeal' && last.mealId === next.mealId) {
      return [...pending.slice(0, lastIndex), { kind: 'updateMeal', mealId: next.mealId, patch: { ...last.patch, ...next.patch } }];
    }
  }

  return [...pending, next];
}
