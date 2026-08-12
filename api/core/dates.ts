/**
 * 日付はすべて JST（Asia/Tokyo）の YYYY-MM-DD で扱う。
 * サーバーのタイムゾーン設定に依存させない（Vercelの実行環境はUTC）。
 */

import { ValidationError } from './errors.ts';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 記録できる過去の幅。これより古い日付はChatGPT経由の書き込みでは受け付けない */
export const MAX_BACKDATE_DAYS = 31;

export function jstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * 書き込み用の日付を確定する。
 * ChatGPTが解決した相対日付をそのまま信じず、サーバー側でもう一度検証する。
 */
export function resolveWriteDate(input: unknown, today: string): string {
  if (input === undefined || input === null || input === '') return today;
  if (!isDateString(input)) {
    throw new ValidationError('日付は YYYY-MM-DD の形式で指定してください。');
  }
  if (input > today) {
    throw new ValidationError('未来の日付には記録できません。');
  }
  if (daysBetween(input, today) > MAX_BACKDATE_DAYS) {
    throw new ValidationError(`${MAX_BACKDATE_DAYS}日より前の日付には記録できません。アプリから直接編集してください。`);
  }
  return input;
}

/** 読み取り用の日付。過去の制限は掛けない（グラフや履歴は昔まで見られてよい） */
export function resolveReadDate(input: unknown, today: string): string {
  if (input === undefined || input === null || input === '') return today;
  if (!isDateString(input)) {
    throw new ValidationError('日付は YYYY-MM-DD の形式で指定してください。');
  }
  return input;
}
