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

export const migrationApi = {
  preview: (backup: unknown) => post<MigrationReport>('/migrate/preview', backup),
  apply: (backup: unknown) => post<MigrationReport>('/migrate', backup),
  verify: (backup: unknown) => post<{ ok: boolean; issues: string[]; stored: Record<string, number> }>('/migrate/verify', backup),
};
