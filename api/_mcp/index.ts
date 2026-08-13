/**
 * 本番用の配線。expressアプリを1つだけ作って使い回す。
 *
 * expressを使うのはMCP SDKの標準ルーターがexpress前提のため。
 * ここで完結させ、既存のハンドラ（通知・cron・AI推定）には触れない。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpApp } from './http.js';

let app: ReturnType<typeof createMcpApp> | null = null;

export function handleMcp(req: IncomingMessage, res: ServerResponse): void {
  if (!app) app = createMcpApp();
  app(req as any, res as any);
}
