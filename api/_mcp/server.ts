/**
 * MCPサーバーの組み立て。
 *
 * 道具の中身は `tools.ts`、実際の処理は `LiftAndLeanService`。
 * ここは「MCPの形に載せる」だけで、業務の判断は一切しない。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppError } from '../_core/errors.js';
import { LiftAndLeanService } from '../_core/service.js';
import { AppwriteRepository } from '../_appwrite/repository.js';
import { TOOLS } from './tools.js';
import type { ToolContext, ToolResult } from './tools.js';

export const MCP_SERVER_INFO = {
  name: 'lift-and-lean',
  title: 'Lift & Lean',
  version: '1.0.0',
} as const;

/** 利用者1人分の文脈。アクセストークンから解決した値だけを渡す */
export interface McpSession {
  userId: string;
  /** 本人のセッション。読み取りはこの権限で行う（APIキーで代替しない） */
  sessionSecret: string;
}

export function createServiceForSession(session: McpSession): LiftAndLeanService {
  return new LiftAndLeanService({
    repository: new AppwriteRepository({ sessionSecret: session.sessionSecret }),
  });
}

/**
 * 失敗をChatGPTに伝える形へ変換する。
 * 利用者に見せてよい文言だけを返し、内部の詳細は出さない。
 */
function toToolError(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = error instanceof AppError
    ? error.message
    : '処理に失敗しました。時間をおいて試してください。';
  if (!(error instanceof AppError)) console.error('mcp tool error:', error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function buildMcpServer(makeContext: () => ToolContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      'Lift & Lean は本人の食事・体重・筋トレを記録するアプリです。'
      + '記録の追加は log_ で始まる道具、状況の確認は get_ で始まる道具を使ってください。'
      + '日付は日本時間で扱われ、省略すると今日になります。'
      + '同じ内容を続けて送り直す必要がある場合は、同じ clientRequestId を付けてください。',
  });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: any) => {
        try {
          const result: ToolResult = await tool.run(makeContext(), args ?? {});
          return {
            content: [{ type: 'text' as const, text: result.text }],
            structuredContent: result.data,
          };
        } catch (error) {
          return toToolError(error);
        }
      },
    );
  }

  return server;
}
