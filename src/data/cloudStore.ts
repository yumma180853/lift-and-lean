/**
 * クラウド（Appwrite）に保存する実装。ログイン済み・メール確認済みのときに使う。
 *
 * **Appwriteのことは何も知らない。** `/api/v1/*` を呼ぶだけで、
 * 権限もuserIdもサーバーが決める。将来ChatGPT/MCPが同じサービス層を使っても、
 * ここと同じデータが同じ規則で読み書きされる。
 *
 * 保存の成否は**サーバーの応答で判断する**。
 * 先に画面を書き換えてから送るやり方はしていない
 * （失敗したときに、保存できていないものを保存済みに見せてしまうため）。
 */

import type { Meal, UserGoals, WeightRecord, Workout } from '../types';
import { dataApi } from '../utils/api';
import type { SnapshotResponse } from '../utils/api';
import { DEFAULT_GOALS, emptyAppData, findExercise, findSet, replaceWorkouts } from './types';
import type { AppData, DataStore, NewMeal, ProfilePatch } from './types';

function toAppData(snapshot: SnapshotResponse): AppData {
  const base = emptyAppData();
  return {
    meals: (snapshot.meals ?? []) as Meal[],
    workouts: (snapshot.workouts ?? []) as Workout[],
    weights: (snapshot.weights ?? []) as WeightRecord[],
    goals: { ...DEFAULT_GOALS, ...(snapshot.goals ?? {}) } as UserGoals,
    hiddenWorkoutDates: snapshot.profile?.hiddenWorkoutDates ?? base.hiddenWorkoutDates,
    customExerciseCategories: snapshot.profile?.customExerciseCategories ?? base.customExerciseCategories,
    freezeUsedDates: snapshot.profile?.freezeUsedDates ?? base.freezeUsedDates,
    longestStreak: snapshot.profile?.longestStreak ?? base.longestStreak,
  };
}

/** サーバーへ送る食事の形（サーバー側のschemaが要求する項目を必ず埋める） */
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

export const cloudStore: DataStore = {
  mode: 'cloud',

  async load() {
    return toAppData(await dataApi.snapshot());
  },

  async addMeal(current, date, meal: NewMeal) {
    const { rowId } = await dataApi.addMeal({ ...mealPayload(meal, date), clientRequestId: undefined });
    return { ...current, meals: [...current.meals, { ...meal, id: rowId, date } as Meal] };
  },

  async updateMeal(current, id, patch) {
    const existing = current.meals.find(m => m.id === id);
    if (!existing) throw new Error('その食事は見つかりませんでした。');
    const merged = { ...existing, ...patch };
    // 部分更新でもサーバーは全項目を検証するため、いまの内容を合成して送る
    await dataApi.updateMeal(id, mealPayload(merged, merged.date));
    return { ...current, meals: current.meals.map(m => m.id === id ? merged : m) };
  },

  async deleteMeal(current, id) {
    await dataApi.deleteMeal(id);
    return { ...current, meals: current.meals.filter(m => m.id !== id) };
  },

  async saveWeight(current, date, weight) {
    const { rowId } = await dataApi.saveWeight(weight, date);
    const record: WeightRecord = { id: rowId, date, weight };
    const index = current.weights.findIndex(w => w.date === date);
    const weights = index > -1
      ? current.weights.map((w, i) => i === index ? record : w)
      : [...current.weights, record];
    return { ...current, weights };
  },

  async addExercise(current, date, name, category) {
    // サーバー側で「その日の筋トレ」が無ければ作られる
    const { rowId } = await dataApi.addExercise(date, name);

    const existing = current.workouts.find(w => w.date === date);
    const workouts = existing
      ? current.workouts.map(workout => workout.date !== date ? workout : {
          ...workout,
          exercises: [...workout.exercises, { id: rowId, name, sets: [] }],
        })
      : [...current.workouts, { id: `day:${date}`, date, exercises: [{ id: rowId, name, sets: [] }] }];

    let next = replaceWorkouts(current, workouts);
    if (category) {
      const categories = { ...next.customExerciseCategories, [name]: category };
      await dataApi.saveProfile({ customExerciseCategories: categories });
      next = { ...next, customExerciseCategories: categories };
    }
    return next;
  },

  async deleteExercise(current, exerciseId) {
    await dataApi.deleteExercise(exerciseId);
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.filter(e => e.id !== exerciseId),
    }));
    return replaceWorkouts(current, workouts);
  },

  async addSet(current, exerciseId, weight, reps) {
    if (!findExercise(current, exerciseId)) throw new Error('その種目は見つかりませんでした。');
    const { rowId } = await dataApi.addSet(exerciseId, reps, weight);
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => exercise.id !== exerciseId ? exercise : {
        ...exercise,
        sets: [...exercise.sets, { id: rowId, weight, reps }],
      }),
    }));
    return replaceWorkouts(current, workouts);
  },

  async updateSet(current, setId, weight, reps) {
    if (!findSet(current, setId)) throw new Error('そのセットは見つかりませんでした。');
    await dataApi.updateSet(setId, reps, weight);
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => ({
        ...exercise,
        sets: exercise.sets.map(set => set.id !== setId ? set : { ...set, weight, reps }),
      })),
    }));
    return replaceWorkouts(current, workouts);
  },

  async deleteSet(current, setId) {
    await dataApi.deleteSet(setId);
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => ({
        ...exercise,
        sets: exercise.sets.filter(set => set.id !== setId),
      })),
    }));
    return replaceWorkouts(current, workouts);
  },

  async saveGoals(current, goals: UserGoals) {
    await dataApi.saveGoals({ ...goals });
    return { ...current, goals };
  },

  async saveProfile(current, patch: ProfilePatch) {
    await dataApi.saveProfile({ ...patch });
    return { ...current, ...patch };
  },
};
