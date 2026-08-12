/**
 * Appwriteアダプタの検証。
 * ネットワークには出ず、SDKの呼び出し方（特に「どの資格情報で叩いたか」）を見る。
 *
 * ここでの最重要チェックは **読み取りにAPI keyを使っていないこと**。
 * 読み取りをadminで行うと権限チェックをバイパスし、
 * アプリ層のバグがそのまま他人のデータの露出になる。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// 実際のAppwriteへは接続しない。設定の読み込みを通すためのダミー値
process.env.APPWRITE_PROJECT_ID = 'test-project';
process.env.APPWRITE_API_KEY = 'test-key-not-a-secret';
process.env.APPWRITE_DATABASE_ID = 'testdb';
process.env.APPWRITE_ENDPOINT = 'https://example.invalid/v1';

const { AppwriteRepository } = await import('../api/appwrite/repository.ts');
const { AppwriteException } = await import('node-appwrite');
const {
  parseCookies,
  buildSessionCookie,
  buildClearedSessionCookie,
} = await import('../api/appwrite/auth.ts');

interface Call { method: string; params: any }

function fakeGateways(options: { rows?: any[]; failWith?: any } = {}) {
  const adminCalls: Call[] = [];
  const sessionCalls: Call[] = [];
  const record = (sink: Call[]) => new Proxy({}, {
    get: (_target, method: string) => async (params: any) => {
      sink.push({ method, params });
      if (options.failWith) throw options.failWith;
      if (method === 'listRows') return { rows: options.rows ?? [], total: (options.rows ?? []).length };
      if (method === 'getRow') return options.rows?.[0] ?? {};
      return { $id: params?.rowId };
    },
  });

  return {
    adminCalls,
    sessionCalls,
    gateways: {
      admin: () => record(adminCalls),
      session: (_secret: string) => record(sessionCalls),
    },
  };
}

// ---------------------------------------------------------------- 権限

test('行の権限は本人のread/update/deleteだけを与える', async () => {
  const { gateways, adminCalls } = fakeGateways();
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: { name: 'x' } }], 'create');

  assert.equal(adminCalls.length, 1);
  assert.deepEqual(adminCalls[0].params.permissions, [
    'read("user:alice")',
    'update("user:alice")',
    'delete("user:alice")',
  ]);
});

test('サーバー専用テーブルには行権限を一切与えない', async () => {
  const { gateways, adminCalls } = fakeGateways();
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.putServerRow('audit_log', 'a1', { userId: 'alice', action: 'meal.create' }, 'create');
  assert.deepEqual(adminCalls[0].params.permissions, []);
});

// ---------------------------------------------------------------- 資格情報の使い分け

test('書き込みはAPI key、読み取りはセッションで行う', async () => {
  const { gateways, adminCalls, sessionCalls } = fakeGateways({ rows: [{ $id: 'r1', userId: 'alice' }] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: {} }], 'create');
  await repository.listRows('meals', 'alice', { equals: { userId: 'alice' } });

  assert.deepEqual(adminCalls.map(c => c.method), ['createRow']);
  assert.deepEqual(sessionCalls.map(c => c.method), ['listRows']);
});

test('セッションが無いときは読み取りを拒否する（API keyで代替しない）', async () => {
  const { gateways, adminCalls } = fakeGateways();
  const repository = new AppwriteRepository({ gateways });

  await assert.rejects(() => repository.listRows('meals', 'alice', {}), (error: any) => error.status === 401);
  assert.deepEqual(adminCalls, []);
});

test('更新・削除は所有者確認をセッションで行ってから実行する', async () => {
  const { gateways, adminCalls, sessionCalls } = fakeGateways({ rows: [{ $id: 'r1', userId: 'alice' }] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.patchOwnedRow('meals', 'alice', 'r1', { name: 'y' });

  assert.deepEqual(sessionCalls.map(c => c.method), ['listRows']);
  assert.deepEqual(adminCalls.map(c => c.method), ['updateRow']);
});

test('セッションで読めない行はadminでも触らせない', async () => {
  const { gateways, adminCalls } = fakeGateways({ rows: [] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await assert.rejects(() => repository.deleteOwnedRow('meals', 'bob', 'r1'), (error: any) => error.status === 404);
  assert.deepEqual(adminCalls, []);
});

test('読めても他人のuserIdの行なら触らせない', async () => {
  const { gateways, adminCalls } = fakeGateways({ rows: [{ $id: 'r1', userId: 'alice' }] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await assert.rejects(() => repository.patchOwnedRow('meals', 'bob', 'r1', {}), (error: any) => error.status === 404);
  assert.deepEqual(adminCalls, []);
});

// ---------------------------------------------------------------- 冪等性・エラー

test('409（既に存在）はエラーにせず existed として数える', async () => {
  const conflict = new AppwriteException('already exists', 409, 'row_already_exists');
  const { gateways } = fakeGateways({ failWith: conflict });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  const result = await repository.putOwnedRows('meals', 'alice', [
    { rowId: 'r1', data: {} },
    { rowId: 'r2', data: {} },
  ], 'create');

  assert.deepEqual(result, { created: 0, existed: 2 });
});

test('Appwriteの生のエラー文言は利用者へ返さない', async () => {
  const failure = new AppwriteException('Unknown column "secret_internal_name"', 500, 'general_error');
  const { gateways } = fakeGateways({ failWith: failure });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await assert.rejects(
    () => repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: {} }], 'create'),
    (error: any) => error.status === 502 && !/secret_internal_name/.test(error.message),
  );
});

test('存在しない行の取得は例外ではなくnull', async () => {
  const missing = new AppwriteException('not found', 404, 'row_not_found');
  const { gateways } = fakeGateways({ failWith: missing });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  assert.equal(await repository.getServerRow('rate_limits', 'r1'), null);
});

// ---------------------------------------------------------------- クエリ

test('検索条件がAppwriteのqueryへ変換される', async () => {
  const { gateways, sessionCalls } = fakeGateways({ rows: [] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.listRows('meals', 'alice', {
    equals: { userId: 'alice' },
    between: { column: 'date', from: '2026-08-01', to: '2026-08-12' },
    orderDesc: 'date',
    limit: 10,
  });

  const queries: string[] = sessionCalls[0].params.queries;
  assert.equal(queries.some(q => q.includes('"userId"') && q.includes('alice')), true);
  assert.equal(queries.some(q => q.includes('between')), true);
  assert.equal(queries.some(q => q.includes('orderDesc')), true);
  assert.equal(queries.some(q => q.includes('limit')), true);
});

test('取得件数には必ず上限を付ける', async () => {
  const { gateways, sessionCalls } = fakeGateways({ rows: [] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.listRows('meals', 'alice', { limit: 100000 });
  const queries: string[] = sessionCalls[0].params.queries;
  assert.equal(queries.some(q => q.includes('limit') && q.includes('500')), true);
});

// ---------------------------------------------------------------- Cookie

test('セッションcookieはJSから読めない形にする', () => {
  const cookie = buildSessionCookie('secret-value', new Date(Date.now() + 3600_000).toISOString());
  assert.match(cookie, /^ll_session=secret-value;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=3[0-9]{3}/);
});

test('ログアウト用のcookieは即時失効させる', () => {
  assert.match(buildClearedSessionCookie(), /Max-Age=0/);
});

test('Cookieヘッダから値を取り出す', () => {
  const cookies = parseCookies('other=1; ll_session=abc%20def; empty=');
  assert.equal(cookies.ll_session, 'abc def');
  assert.equal(cookies.other, '1');
  assert.deepEqual(parseCookies(undefined), {});
});
