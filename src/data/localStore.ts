/**
 * この端末に保存する実装（未ログイン時）。
 *
 * **移行前と同じ挙動をそのまま持たせている。**
 * ログインしていない人にとってはこれまでどおり動くべきなので、
 * キーも保存の仕方も変えていない。
 */

import type { Meal, UserGoals, WeightRecord, Workout } from '../types';
import {
  DEFAULT_GOALS,
  emptyAppData,
  findExercise,
  findSet,
  replaceWorkouts,
  safeUUID,
  upsertWorkoutDate,
} from './types';
import type { AppData, DataStore, NewMeal, ProfilePatch } from './types';

/** 記録データのキー。クラウドへ移したあとも**消さずに残す**（バックアップとして） */
export const LOCAL_KEYS = {
  meals: 'meals',
  workouts: 'workouts',
  weights: 'weight_history',
  goals: 'user_goals',
  hiddenWorkoutDates: 'hidden_workout_dates',
  customExerciseCategories: 'custom_exercise_categories',
  freezeUsedDates: 'freeze_used_dates',
  longestStreak: 'longest_streak',
} as const;

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // 容量超過などで書けないことがある。握りつぶすと「保存できた」と誤解させる
    throw new Error('この端末に保存できませんでした。ブラウザの空き容量を確認してください。');
  }
};

export function loadLocalData(): AppData {
  const base = emptyAppData();
  return {
    meals: read<Meal[]>(LOCAL_KEYS.meals, base.meals),
    workouts: read<Workout[]>(LOCAL_KEYS.workouts, base.workouts),
    weights: read<WeightRecord[]>(LOCAL_KEYS.weights, base.weights),
    goals: { ...DEFAULT_GOALS, ...read<Partial<UserGoals>>(LOCAL_KEYS.goals, {}) },
    hiddenWorkoutDates: read<string[]>(LOCAL_KEYS.hiddenWorkoutDates, base.hiddenWorkoutDates),
    customExerciseCategories: read<Record<string, string>>(LOCAL_KEYS.customExerciseCategories, base.customExerciseCategories),
    freezeUsedDates: read<string[]>(LOCAL_KEYS.freezeUsedDates, base.freezeUsedDates),
    longestStreak: read<number>(LOCAL_KEYS.longestStreak, base.longestStreak),
  };
}

/** 全キーを書き戻す（移行前と同じやり方） */
function persist(data: AppData): AppData {
  write(LOCAL_KEYS.meals, data.meals);
  write(LOCAL_KEYS.workouts, data.workouts);
  write(LOCAL_KEYS.weights, data.weights);
  write(LOCAL_KEYS.goals, data.goals);
  write(LOCAL_KEYS.hiddenWorkoutDates, data.hiddenWorkoutDates);
  write(LOCAL_KEYS.customExerciseCategories, data.customExerciseCategories);
  write(LOCAL_KEYS.freezeUsedDates, data.freezeUsedDates);
  write(LOCAL_KEYS.longestStreak, data.longestStreak);
  return data;
}

export const localStore: DataStore = {
  mode: 'local',

  async load() {
    return loadLocalData();
  },

  async addMeal(current, date, meal) {
    return persist({ ...current, meals: [...current.meals, { ...meal, id: safeUUID(), date }] });
  },

  async updateMeal(current, id, patch) {
    return persist({ ...current, meals: current.meals.map(m => m.id === id ? { ...m, ...patch } : m) });
  },

  async deleteMeal(current, id) {
    return persist({ ...current, meals: current.meals.filter(m => m.id !== id) });
  },

  async saveWeight(current, date, weight) {
    const index = current.weights.findIndex(w => w.date === date);
    const record: WeightRecord = { id: safeUUID(), date, weight };
    const weights = index > -1
      ? current.weights.map((w, i) => i === index ? record : w)
      : [...current.weights, record];
    return persist({ ...current, weights });
  },

  async addExercise(current, date, name, category) {
    const withDay = upsertWorkoutDate(current, date, safeUUID());
    const workouts = withDay.workouts.map(workout => workout.date !== date ? workout : {
      ...workout,
      exercises: [...workout.exercises, { id: safeUUID(), name, sets: [] }],
    });
    const next = replaceWorkouts(withDay, workouts);
    return persist(category
      ? { ...next, customExerciseCategories: { ...next.customExerciseCategories, [name]: category } }
      : next);
  },

  async deleteExercise(current, exerciseId) {
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.filter(e => e.id !== exerciseId),
    }));
    return persist(replaceWorkouts(current, workouts));
  },

  async addSet(current, exerciseId, weight, reps) {
    const found = findExercise(current, exerciseId);
    if (!found) throw new Error('その種目は見つかりませんでした。');
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => exercise.id !== exerciseId ? exercise : {
        ...exercise,
        sets: [...exercise.sets, { id: safeUUID(), weight, reps }],
      }),
    }));
    return persist(replaceWorkouts(current, workouts));
  },

  async updateSet(current, setId, weight, reps) {
    if (!findSet(current, setId)) throw new Error('そのセットは見つかりませんでした。');
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => ({
        ...exercise,
        sets: exercise.sets.map(set => set.id !== setId ? set : { ...set, weight, reps }),
      })),
    }));
    return persist(replaceWorkouts(current, workouts));
  },

  async deleteSet(current, setId) {
    const workouts = current.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => ({
        ...exercise,
        sets: exercise.sets.filter(set => set.id !== setId),
      })),
    }));
    return persist(replaceWorkouts(current, workouts));
  },

  async saveGoals(current, goals) {
    return persist({ ...current, goals });
  },

  async saveProfile(current, patch: ProfilePatch) {
    return persist({ ...current, ...patch });
  },
};

export type { AppData, DataStore, NewMeal, ProfilePatch };
