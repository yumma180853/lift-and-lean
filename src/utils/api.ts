/**
 * /api/v1 への薄いクライアント。
 *
 * セッションはHttpOnly Cookieで運ぶため、ここではトークンを扱わない。
 * ブラウザは Appwrite へ直接アクセスしない（必ずこのサーバー経由）。
 */

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network_error', '通信に失敗しました。電波の良い場所で試してください。');
  }

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.code ?? 'error',
      payload?.error ?? '処理に失敗しました。時間をおいて試してください。',
    );
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export interface AccountInfo {
  userId: string;
  email?: string;
  name?: string;
  /** メールアドレスの所有確認が済んでいるか。false の間はクラウドのデータに触れない */
  emailVerified: boolean;
}

export const authApi = {
  signUp: (email: string, password: string) => post<{ userId: string }>('/auth/signup', { email, password }),
  logIn: (email: string, password: string) => post<{ userId: string }>('/auth/login', { email, password }),
  logOut: () => post<{ ok: boolean }>('/auth/logout'),
  me: () => request<AccountInfo>('/auth/me'),
  /** 再設定メールの送信。登録済みかどうかに関わらず同じ結果が返る */
  requestPasswordReset: (email: string) => post<{ ok: boolean }>('/auth/recovery', { email }),
  /** 確認メールの再送。ログイン中の本人しか呼べない */
  resendVerification: () => post<{ ok: boolean }>('/auth/verification'),
  /** メールのリンクから戻ってきたあとの確認完了 */
  confirmVerification: (userId: string, secret: string) =>
    post<{ ok: boolean }>('/auth/verification/confirm', { userId, secret }),
  /** メールのリンクから戻ってきたあとの新パスワード設定 */
  confirmPasswordReset: (userId: string, secret: string, password: string) =>
    post<{ ok: boolean }>('/auth/recovery/confirm', { userId, secret, password }),
};

export interface MigrationCounts {
  meals: number;
  weights: number;
  workouts: number;
  exercises: number;
  sets: number;
  totalCalories: number;
  latestWeight: number | null;
}

export interface MigrationReport {
  applied: boolean;
  counts: MigrationCounts;
  expected: MigrationCounts;
  issues: string[];
  warnings: string[];
  written: { table: string; created: number; existed: number }[];
}

// ---------------------------------------------------------------- データ

export interface SnapshotResponse {
  meals: any[];
  weights: any[];
  workouts: any[];
  goals: any | null;
  profile: {
    hiddenWorkoutDates: string[];
    freezeUsedDates: string[];
    customExerciseCategories: Record<string, string>;
    longestStreak: number;
  } | null;
  today: string;
}

const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

const remove = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const dataApi = {
  /** 起動時にまとめて読む（画面ごとの往復を増やさない） */
  snapshot: () => request<SnapshotResponse>('/snapshot'),

  addMeal: (meal: Record<string, unknown>) => post<{ rowId: string }>('/meals', meal),
  updateMeal: (id: string, meal: Record<string, unknown>) => patch<{ ok: boolean }>(`/meals/${encodeURIComponent(id)}`, meal),
  deleteMeal: (id: string) => remove<{ ok: boolean }>(`/meals/${encodeURIComponent(id)}`),

  saveWeight: (weight: number, date?: string) => post<{ rowId: string }>('/weights', { weight, date }),

  addExercise: (date: string, name: string) => post<{ rowId: string }>('/exercises', { date, name }),
  deleteExercise: (id: string) => remove<{ ok: boolean }>(`/exercises/${encodeURIComponent(id)}`),
  addSet: (exerciseId: string, reps: number, weight: number) =>
    post<{ rowId: string }>(`/exercises/${encodeURIComponent(exerciseId)}/sets`, { reps, weight }),
  updateSet: (setId: string, reps: number, weight: number) =>
    patch<{ ok: boolean }>(`/sets/${encodeURIComponent(setId)}`, { reps, weight }),
  deleteSet: (setId: string) => remove<{ ok: boolean }>(`/sets/${encodeURIComponent(setId)}`),

  saveGoals: (goals: Record<string, unknown>) => put<{ ok: boolean }>('/goals', goals),
  saveProfile: (profile: Record<string, unknown>) => put<{ ok: boolean }>('/profile', profile),
};

export interface CommandResponse {
  /** done=実行した / clarify=聞き返す / unsupported=対象外 */
  status: 'done' | 'clarify' | 'unsupported';
  message: string;
  intent?: string;
  data?: Record<string, unknown>;
  /** 取り消しに使う情報（食事のみ） */
  undo?: { kind: 'meal'; rowId: string };
  /** 何と聞き取ったか */
  transcript: string;
}

/**
 * 話しことば・打ちことばの入口。
 * **判断はサーバー側**（鍵を画面に置かないため）。ここは投げて受け取るだけ。
 */
export const commandApi = {
  run: (text: string) => post<CommandResponse>('/command', { text }),
};

export const migrationApi = {
  preview: (backup: unknown) => post<MigrationReport>('/migrate/preview', backup),
  apply: (backup: unknown) => post<MigrationReport>('/migrate', backup),
  verify: (backup: unknown) => post<{ ok: boolean; issues: string[]; stored: Record<string, number> }>('/migrate/verify', backup),
};
