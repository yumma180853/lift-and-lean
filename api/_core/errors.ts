/**
 * 利用者に見せてよいエラーと、見せてはいけないエラーを型で分ける。
 *
 * `error.message` をそのまま返してよいのは AppError の場合だけ。
 * それ以外（素のError・SDKの例外・TypeError等）は内部情報を含みうるので、
 * 呼び出し側で固定の汎用文へ置き換える。判定は偽装できない型で行う。
 */

export class AppError extends Error {
  status: number;
  code: string;
  /** 追加情報。利用者に見せてよい内容だけを入れる */
  details?: unknown;

  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation_error', 400, message, details);
    this.name = 'ValidationError';
  }
}

export class AuthError extends AppError {
  constructor(message = 'ログインが必要です。') {
    super('unauthorized', 401, message);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = '見つかりませんでした。') {
    super('not_found', 404, message);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends AppError {
  constructor(message: string) {
    super('rate_limited', 429, message);
    this.name = 'RateLimitError';
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'データベースへの接続に失敗しました。時間をおいて試してください。') {
    super('upstream_error', 502, message);
    this.name = 'UpstreamError';
  }
}

export interface ErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

/** 例外をHTTPレスポンスへ変換する。AppError以外は内容を外に出さない */
export function toErrorResponse(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof AppError) {
    const body: ErrorResponse = { error: error.message, code: error.code };
    if (error.details !== undefined) body.details = error.details;
    return { status: error.status, body };
  }
  return {
    status: 500,
    body: { error: '処理に失敗しました。時間をおいて試してください。', code: 'internal_error' },
  };
}
