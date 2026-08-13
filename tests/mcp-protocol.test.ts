/**
 * MCPのプロトコルレベルE2E。
 *
 * 実際にHTTPサーバーを立て、**本物のMCPクライアント**で接続して確かめる。
 * ChatGPTのUIに繋ぐ前に、UI無しで確認できることをここで全部済ませる。
 *
 * Appwriteには繋がない（トークンの確かめ方とデータの置き場所だけ差し替える）。
 * 本番の実データは一切使わない。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.APPWRITE_PROJECT_ID = 'test-project';
process.env.APPWRITE_API_KEY = 'test-key-not-a-secret';
process.env.APPWRITE_DATABASE_ID = 'testdb';
process.env.APPWRITE_ENDPOINT = 'https://example.invalid/v1';
process.env.APP_PUBLIC_URL = 'http://127.0.0.1';

const { createMcpApp } = await import('../api/_mcp/http.ts');
const { LiftAndLeanService } = await import('../api/_core/service.ts');
const { MemoryRepository } = await import('./support/memory-repository.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const NOW = new Date('2026-08-13T01:00:00Z'); // JST 2026-08-13 10:00
const TODAY = '2026-08-13';

const TOKENS: Record<string, string> = {
  'token-alice': 'alice',
  'token-bob': 'bob',
  'token-unverified': 'carol',
};

/** テスト用のサーバーを立てる。トークン→利用者の対応だけ差し替える */
async function startServer() {
  const repository = new MemoryRepository();
  const services = new Map<string, InstanceType<typeof LiftAndLeanService>>();

  // 認可コードの保管庫（本番はVercel KV）
  const codes = new Map<string, any>();
  const store = {
    async save(code: string, record: any) { codes.set(code, record); },
    async take(code: string) { const r = codes.get(code); codes.delete(code); return r ?? null; },
    async peek(code: string) { return codes.get(code) ?? null; },
  };

  const app = createMcpApp({
    oauth: {
      store: store as any,
      async authenticate(email: string, password: string) {
        if (password !== 'correct-horse') {
          const error: any = new Error('メールアドレスかパスワードが違います。');
          error.status = 401;
          throw error;
        }
        const verified = email !== 'unverified@example.jp';
        return { sessionSecret: verified ? 'token-alice' : 'token-unverified', userId: verified ? 'alice' : 'carol', emailVerified: verified };
      },
    },
    async verifyToken(token: string) {
      const userId = TOKENS[token];
      if (!userId) {
        const error: any = new Error('ログインが必要です。');
        error.status = 401;
        error.code = 'unauthorized';
        throw error;
      }
      if (userId === 'carol') {
        const error: any = new Error('メールアドレスの確認が済んでいません。');
        error.status = 401;
        error.code = 'unauthorized';
        throw error;
      }
      return { userId, sessionSecret: token, scopes: ['data:read', 'log:write'] };
    },
    createService(session) {
      const existing = services.get(session.userId);
      if (existing) return existing;
      const service = new LiftAndLeanService({
        repository: repository.asViewer(session.userId),
        clock: { now: () => NOW },
        onAuditFailure: () => {},
      });
      services.set(session.userId, service);
      return service;
    },
  });

  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    repository,
    codes,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { await new Promise<void>(resolve => { server.close(() => resolve()); }); },
  };
}

/** 本物のMCPクライアントで接続する */
async function connect(baseUrl: string, token: string) {
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

const textOf = (result: any): string =>
  (result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

// ---------------------------------------------------------------- 接続と発見

test('initialize が成功し、サーバー情報を返す', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');
    const info = client.getServerVersion();
    assert.equal(info?.name, 'lift-and-lean');
    assert.equal(typeof client.getInstructions(), 'string');
    await close();
  } finally {
    await server.close();
  }
});

test('tools/list で6つの道具が見つかり、注記が付いている', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map(t => t.name).sort(), [
      'get_progress', 'get_recent_workouts', 'get_today_summary',
      'log_meal', 'log_weight', 'log_workout',
    ]);

    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string', `${tool.name} に説明がある`);
      assert.equal(typeof tool.inputSchema, 'object', `${tool.name} に入力スキーマがある`);
      const annotations = tool.annotations as any;
      assert.equal(typeof annotations?.readOnlyHint, 'boolean', `${tool.name} に readOnlyHint がある`);
      assert.equal(typeof annotations?.destructiveHint, 'boolean', `${tool.name} に destructiveHint がある`);
      assert.equal(typeof annotations?.openWorldHint, 'boolean', `${tool.name} に openWorldHint がある`);
    }

    const readOnly = tools.filter(t => (t.annotations as any)?.readOnlyHint).map(t => t.name).sort();
    assert.deepEqual(readOnly, ['get_progress', 'get_recent_workouts', 'get_today_summary']);
    await close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- 認証

test('トークン無しでは接続できず、認可の入口を案内する', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    assert.equal(response.status, 401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /^Bearer/);
    assert.match(challenge, /resource_metadata=/, 'どこで認可を受ければよいか示す');
  } finally {
    await server.close();
  }
});

test('無効なトークンは拒否される', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('メール未確認の利用者は拒否される', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer token-unverified',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('取り消されたトークンはその時点から使えない', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');
    await client.listTools();
    await close();

    delete TOKENS['token-alice']; // 連携解除に相当
    const response = await fetch(`${server.baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer token-alice',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);
  } finally {
    TOKENS['token-alice'] = 'alice';
    await server.close();
  }
});

// ---------------------------------------------------------------- 発見用メタデータ

test('保護リソースのメタデータが公開されている（RFC 9728の導出パスと素のパス）', async () => {
  const server = await startServer();
  try {
    for (const path of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(`${server.baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      const body = await response.json() as any;
      assert.equal(typeof body.resource, 'string', path);
      assert.equal(Array.isArray(body.authorization_servers), true, path);
      assert.deepEqual([...body.scopes_supported].sort(), ['data:read', 'log:write'], path);
    }
  } finally {
    await server.close();
  }
});

test('401の案内が示すメタデータの場所が実在する', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const challenge = response.headers.get('www-authenticate') ?? '';
    const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    assert.equal(typeof url, 'string');

    const path = new URL(url!).pathname;
    const metadata = await fetch(`${server.baseUrl}${path}`);
    assert.equal(metadata.status, 200, `案内された ${path} が実在する`);
  } finally {
    await server.close();
  }
});

test('認可サーバーのメタデータがPKCEに対応し、保護リソースと同じissuerを指す', async () => {
  const server = await startServer();
  try {
    const asResponse = await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(asResponse.status, 200);
    const as = await asResponse.json() as any;
    assert.deepEqual(as.code_challenge_methods_supported, ['S256'], 'PKCEはS256のみ');

    const prm = await (await fetch(`${server.baseUrl}/.well-known/oauth-protected-resource/api/mcp`)).json() as any;
    assert.deepEqual(prm.authorization_servers, [as.issuer], '表記が違うと認可サーバーを見つけられない');

    // 広告しているエンドポイントが実際に届く場所にあること
    for (const endpoint of [as.authorization_endpoint, as.token_endpoint]) {
      const path = new URL(endpoint).pathname;
      const probe = await fetch(`${server.baseUrl}${path}`, { method: 'POST' });
      assert.notEqual(probe.status, 404, `${path} が存在する`);
    }
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- 書き込み

test('食事・体重・筋トレを記録できる', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');

    const meal = await client.callTool({
      name: 'log_meal',
      arguments: { name: '鶏むね肉', calories: 320, protein: 60, fat: 5, carbs: 2 },
    });
    assert.equal(meal.isError, undefined);
    assert.match(textOf(meal), /記録しました/);

    const weight = await client.callTool({ name: 'log_weight', arguments: { weight: 70.5 } });
    assert.match(textOf(weight), /70.5kg/);

    const workout = await client.callTool({
      name: 'log_workout',
      arguments: {
        exercises: [
          { name: 'ラットプルダウン', sets: [{ reps: 10, weight: 50 }, { reps: 10, weight: 50 }, { reps: 10, weight: 50 }] },
          { name: 'シーテッドロー', sets: [{ reps: 12, weight: 40 }, { reps: 12, weight: 40 }, { reps: 12, weight: 40 }] },
        ],
      },
    });
    assert.match(textOf(workout), /2種目/);
    assert.equal((workout.structuredContent as any).sets, 6);

    assert.equal(server.repository.countOf('meals'), 1);
    assert.equal(server.repository.countOf('weights'), 1);
    assert.equal(server.repository.countOf('workout_sets'), 6);
    await close();
  } finally {
    await server.close();
  }
});

test('同じ呼び出しの再送で二重登録しない', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');
    const args = { name: 'プロテイン', calories: 120, protein: 24, fat: 1, carbs: 3 };

    await client.callTool({ name: 'log_meal', arguments: args });
    const retry = await client.callTool({ name: 'log_meal', arguments: args });

    assert.equal(server.repository.countOf('meals'), 1);
    assert.match(textOf(retry), /すでに記録済み/);
    await close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- 読み取り

test('今日の状態・最近の筋トレ・推移を読める', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');
    await client.callTool({ name: 'log_meal', arguments: { name: '昼', calories: 700, protein: 40, fat: 20, carbs: 80 } });
    await client.callTool({ name: 'log_weight', arguments: { weight: 70 } });
    await client.callTool({
      name: 'log_workout',
      arguments: { exercises: [{ name: 'ベンチプレス', sets: [{ reps: 10, weight: 60 }] }] },
    });

    const summary = await client.callTool({ name: 'get_today_summary', arguments: {} });
    assert.match(textOf(summary), new RegExp(TODAY));
    assert.equal((summary.structuredContent as any).totals.calories, 700);

    const workouts = await client.callTool({ name: 'get_recent_workouts', arguments: {} });
    assert.match(textOf(workouts), /ベンチプレス 60kg×10/);

    const progress = await client.callTool({ name: 'get_progress', arguments: { days: 7 } });
    assert.equal((progress.structuredContent as any).averageCalories, 700);
    await close();
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- 分離

test('他人のデータは読めない・書き換えられない', async () => {
  const server = await startServer();
  try {
    const alice = await connect(server.baseUrl, 'token-alice');
    await alice.client.callTool({
      name: 'log_meal',
      arguments: { name: 'アリスの食事', calories: 500, protein: 30, fat: 10, carbs: 50 },
    });
    await alice.close();

    const bob = await connect(server.baseUrl, 'token-bob');
    const summary = await bob.client.callTool({ name: 'get_today_summary', arguments: {} });
    assert.equal((summary.structuredContent as any).totals.calories, 0, 'ボブにアリスの食事は見えない');
    assert.equal((summary.structuredContent as any).mealCount, 0);

    const workouts = await bob.client.callTool({ name: 'get_recent_workouts', arguments: {} });
    assert.match(textOf(workouts), /まだありません/);
    await bob.close();

    // アリス側は無傷
    assert.equal(server.repository.countOf('meals'), 1);
    assert.equal(server.repository.rawRows('meals')[0].userId, 'alice');
  } finally {
    await server.close();
  }
});

test('引数にuserIdを混ぜても、トークンの本人として扱われる', async () => {
  const server = await startServer();
  try {
    const bob = await connect(server.baseUrl, 'token-bob');
    await bob.client.callTool({
      name: 'log_meal',
      arguments: {
        userId: 'alice', // なりすましの試み
        name: 'なりすまし', calories: 100, protein: 1, fat: 1, carbs: 1,
      },
    });
    await bob.close();

    const rows = server.repository.rawRows('meals');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'bob', 'トークンの本人として保存される');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- 不正な入力

test('壊れた入力は道具のエラーとして返り、何も保存されない', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');

    // 必須項目が足りない
    const missing = await client.callTool({ name: 'log_meal', arguments: { name: 'x' } });
    assert.equal(missing.isError, true, '必須項目の不足はエラーとして返る');

    // 範囲外の値
    const outOfRange = await client.callTool({
      name: 'log_meal',
      arguments: { name: 'x', calories: 999999, protein: 1, fat: 1, carbs: 1 },
    });
    assert.equal(outOfRange.isError, true, '範囲外はエラーとして返る');

    // 未来の日付
    const future = await client.callTool({
      name: 'log_weight',
      arguments: { weight: 70, date: '2026-08-14' },
    });
    assert.equal(future.isError, true, '未来の日付はエラーとして返る');
    assert.match(textOf(future), /未来/);

    // 型が違う
    const wrongType = await client.callTool({
      name: 'log_weight',
      arguments: { weight: 'seventy' },
    });
    assert.equal(wrongType.isError, true, '型違いはエラーとして返る');

    assert.equal(server.repository.countOf('meals'), 0, '不正な入力では何も保存しない');
    assert.equal(server.repository.countOf('weights'), 0);

    // エラーのあとも接続は生きている
    const summary = await client.callTool({ name: 'get_today_summary', arguments: {} });
    assert.equal(summary.isError, undefined);
    await close();
  } finally {
    await server.close();
  }
});

test('公開していない道具は呼べない', async () => {
  const server = await startServer();
  try {
    const { client, close } = await connect(server.baseUrl, 'token-alice');
    for (const name of ['delete_all_data', 'update_goals', 'run_query']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, `${name} は呼べない`);
    }
    await close();
  } finally {
    await server.close();
  }
});

test('プロキシ配下でも認可エンドポイントが落ちない', async () => {
  const server = await startServer();
  try {
    // Vercelが付ける転送ヘッダを再現する
    const response = await fetch(`${server.baseUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': '203.0.113.10',
        Forwarded: 'for=203.0.113.10;proto=https',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'does-not-exist',
        client_id: 'll-aHR0cHM6Ly9jaGF0Z3B0LmNvbS9jb25uZWN0b3Ivb2F1dGgvcHJvYmU',
        code_verifier: 'abcdefghijklmnopqrstuvwxyz1234567890abcd',
        redirect_uri: 'https://chatgpt.com/connector/oauth/probe',
      }).toString(),
    });

    assert.notEqual(response.status, 500, '設定不備で500になっていない');
    const body = await response.json() as any;
    assert.equal(typeof body.error, 'string', 'OAuthのエラー形式で返る');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------- 認可の一連

const pkce = () => {
  const verifier = Buffer.from(randomBytes(32)).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const CLIENT_ID = `ll-${Buffer.from('https://chatgpt.com/connector/oauth/probe').toString('base64url')}`;
const REDIRECT = 'https://chatgpt.com/connector/oauth/probe';

test('同意 → コード発行 → トークン交換 → MCP接続 が通る', async () => {
  const server = await startServer();
  try {
    const { verifier, challenge } = pkce();

    // 同意画面から許可する（パスワードを入れるのはここだけ）
    const consent = await fetch(`${server.baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge,
        state: 'xyz', scope: 'data:read log:write',
        email: 'yuma@example.jp', password: 'correct-horse',
      }).toString(),
    });

    assert.equal(consent.status, 302);
    const location = new URL(consent.headers.get('location')!);
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get('state'), 'xyz');
    const code = location.searchParams.get('code');
    assert.equal(typeof code, 'string');

    // コードをトークンに交換する
    const tokenResponse = await fetch(`${server.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code!, client_id: CLIENT_ID,
        code_verifier: verifier, redirect_uri: REDIRECT,
      }).toString(),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as any;
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(typeof tokens.access_token, 'string');

    // もらったトークンでMCPが使える
    const { client, close } = await connect(server.baseUrl, tokens.access_token);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    await close();
  } finally {
    await server.close();
  }
});

test('PKCEの検証子が違えばトークンを出さない', async () => {
  const server = await startServer();
  try {
    const { challenge } = pkce();
    const consent = await fetch(`${server.baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge,
        email: 'yuma@example.jp', password: 'correct-horse',
      }).toString(),
    });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;

    const response = await fetch(`${server.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: CLIENT_ID,
        code_verifier: 'a-completely-different-verifier-0123456789', redirect_uri: REDIRECT,
      }).toString(),
    });
    assert.notEqual(response.status, 200);
  } finally {
    await server.close();
  }
});

test('認可コードは1回しか使えない', async () => {
  const server = await startServer();
  try {
    const { verifier, challenge } = pkce();
    const consent = await fetch(`${server.baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge,
        email: 'yuma@example.jp', password: 'correct-horse',
      }).toString(),
    });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const exchange = () => fetch(`${server.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: CLIENT_ID,
        code_verifier: verifier, redirect_uri: REDIRECT,
      }).toString(),
    });

    assert.equal((await exchange()).status, 200);
    assert.notEqual((await exchange()).status, 200, '2回目は通らない');
  } finally {
    await server.close();
  }
});

test('パスワードが違えば同意画面から先へ進めない', async () => {
  const server = await startServer();
  try {
    const { challenge } = pkce();
    const response = await fetch(`${server.baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge,
        email: 'yuma@example.jp', password: 'wrong-password',
      }).toString(),
    });

    assert.notEqual(response.status, 302, 'リダイレクトしない');
    assert.equal(server.codes.size, 0, 'コードを発行しない');
  } finally {
    await server.close();
  }
});

test('メール未確認では連携できない', async () => {
  const server = await startServer();
  try {
    const { challenge } = pkce();
    const response = await fetch(`${server.baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: challenge,
        email: 'unverified@example.jp', password: 'correct-horse',
      }).toString(),
    });

    assert.notEqual(response.status, 302);
    assert.equal(server.codes.size, 0);
  } finally {
    await server.close();
  }
});

test('許可していない戻り先にはコードを渡さない', async () => {
  const server = await startServer();
  try {
    const { challenge } = pkce();
    const response = await fetch(`${server.baseUrl}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: 'https://evil.example/steal',
        code_challenge: challenge, email: 'yuma@example.jp', password: 'correct-horse',
      }).toString(),
    });

    assert.notEqual(response.status, 302);
    assert.equal(server.codes.size, 0);
  } finally {
    await server.close();
  }
});
