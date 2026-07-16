export interface Set {
  id: string;
  reps: number;
  weight: number;
}

export interface Exercise {
  id: string;
  name: string;
  sets: Set[];
}

export interface Workout {
  id: string;
  date: string;
  exercises: Exercise[];
}

export interface Meal {
  id: string;
  date: string;
  name: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  mealType?: string;
  servingLabel?: string;
  sourceType?: 'official' | 'web' | 'ai_estimate';
  sourceLabel?: string;
  sourceUrl?: string;
  note?: string;
}

export interface WeightRecord {
  id: string;
  date: string;
  weight: number;
}

export interface UserGoals {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  targetWeight: number;
  trainerStyle?: 'buddy' | 'coach' | 'stoic' | 'cheer';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
  exercises?: { name: string; reps: number; sets: number }[];
  timestamp: string;
}

export type Tab = 'dashboard' | 'workout' | 'diet' | 'analysis' | 'aitrainer' | 'settings';

export interface StreakData {
  currentStreak: number;
  lastRecordedDate: string;
  freezeUsedDates: string[];
  longestStreak: number;
  status: 'active' | 'ongoing' | 'freeze_used' | 'new';
}
