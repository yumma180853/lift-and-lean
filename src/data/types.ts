import type { Meal, UserGoals, WeightRecord, Workout } from '../types';

/**
 * アプリが表示に使う永続データひとまとめ。
 * 保存先（この端末 / クラウド）が変わっても、この形は変わらない。
 */
export interface AppData {
  meals: Meal[];
  workouts: Workout[];
  weights: WeightRecord[];
  goals: UserGoals;
  hiddenWorkoutDates: string[];
  customExerciseCategories: Record<string, string>;
  freezeUsedDates: string[];
  longestStreak: number;
}

export const DEFAULT_GOALS: UserGoals = { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 70 };

export const emptyAppData = (): AppData => ({
  meals: [],
  workouts: [],
  weights: [],
  goals: { ...DEFAULT_GOALS },
  hiddenWorkoutDates: [],
  customExerciseCategories: {},
  freezeUsedDates: [],
  longestStreak: 0,
});

/** 新しい食事（idは保存側が決める） */
export type NewMeal = Omit<Meal, 'id' | 'date'>;

/** プロフィール系の部分更新 */
export interface ProfilePatch {
  hiddenWorkoutDates?: string[];
  customExerciseCategories?: Record<string, string>;
  freezeUsedDates?: string[];
  longestStreak?: number;
}

/**
 * 保存先の契約。
 *
 * **どの実装も「保存が成功してから新しい状態を返す」。**
 * 先に画面を更新して後から失敗する作りにしないのは、
 * 保存できていないものを保存済みに見せないため。
 */
export interface DataStore {
  readonly mode: 'local' | 'cloud';

  load(): Promise<AppData>;

  addMeal(current: AppData, date: string, meal: NewMeal): Promise<AppData>;
  updateMeal(current: AppData, id: string, patch: Partial<Meal>): Promise<AppData>;
  deleteMeal(current: AppData, id: string): Promise<AppData>;

  /** 同じ日に2回記録したら上書き（元からの挙動） */
  saveWeight(current: AppData, date: string, weight: number): Promise<AppData>;

  addExercise(current: AppData, date: string, name: string, category?: string): Promise<AppData>;
  deleteExercise(current: AppData, exerciseId: string): Promise<AppData>;
  addSet(current: AppData, exerciseId: string, weight: number, reps: number): Promise<AppData>;
  updateSet(current: AppData, setId: string, weight: number, reps: number): Promise<AppData>;
  deleteSet(current: AppData, setId: string): Promise<AppData>;

  saveGoals(current: AppData, goals: UserGoals): Promise<AppData>;
  saveProfile(current: AppData, patch: ProfilePatch): Promise<AppData>;
}

// ---------------------------------------------------------------- 共通の小道具

export const safeUUID = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

/** 指定日の筋トレを探す */
export const findWorkoutByDate = (data: AppData, date: string): Workout | undefined =>
  data.workouts.find(workout => workout.date === date);

export const findExercise = (data: AppData, exerciseId: string) => {
  for (const workout of data.workouts) {
    const exercise = workout.exercises.find(e => e.id === exerciseId);
    if (exercise) return { workout, exercise };
  }
  return null;
};

export const findSet = (data: AppData, setId: string) => {
  for (const workout of data.workouts) {
    for (const exercise of workout.exercises) {
      const set = exercise.sets.find(s => s.id === setId);
      if (set) return { workout, exercise, set };
    }
  }
  return null;
};

/** 筋トレの中身を差し替えた新しい AppData を返す（元の配列は壊さない） */
export function replaceWorkouts(data: AppData, workouts: Workout[]): AppData {
  return { ...data, workouts };
}

export function upsertWorkoutDate(data: AppData, date: string, workoutId: string): AppData {
  if (data.workouts.some(w => w.date === date)) return data;
  return replaceWorkouts(data, [...data.workouts, { id: workoutId, date, exercises: [] }]);
}
