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

const { AppwriteRepository, WRITE_CONCURRENCY } = await import('../api/_appwrite/repository.ts');
const { AppwriteException } = await import('node-appwrite');
const {
  parseCookies,
  buildSessionCookie,
  buildClearedSessionCookie,
} = await import('../api/_appwrite/auth.ts');

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

  await repository.appendServerRow('audit_log', 'a1', { userId: 'alice', action: 'meal.create' });
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

// ---------------------------------------------------------------- 最小権限

test('API keyでは一切読み取りを行わない（rows.readが要らないことの担保）', async () => {
  const { gateways, adminCalls, sessionCalls } = fakeGateways({ rows: [{ $id: 'r1', userId: 'alice' }] });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  // 実運用で通る書き込み経路を一通り呼ぶ
  await repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: {} }], 'create');
  await repository.putOwnedRows('weights', 'alice', [{ rowId: 'r2', data: {} }], 'upsert');
  await repository.patchOwnedRow('meals', 'alice', 'r1', { name: 'y' });
  await repository.deleteOwnedRow('meals', 'alice', 'r1');
  await repository.appendServerRow('audit_log', 'a1', {});
  await repository.bumpServerCounter('rate_limits', 'c1', 'count', { userId: 'alice' });

  const readMethods = ['getRow', 'listRows', 'listTables', 'listColumns', 'getTable'];
  const adminReads = adminCalls.filter(call => readMethods.includes(call.method));
  assert.deepEqual(adminReads, [], 'API keyで読み取りAPIを呼んでいないこと');
  // 読み取りは必ずユーザーのセッション側に出る
  assert.equal(sessionCalls.every(call => call.method === 'listRows'), true);
});

test('カウンタは読まずに増分操作で進める', async () => {
  const { gateways, adminCalls } = fakeGateways();
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await repository.bumpServerCounter('rate_limits', 'c1', 'count', { userId: 'alice' });

  assert.deepEqual(adminCalls.map(call => call.method), ['incrementRowColumn']);
  assert.equal(adminCalls[0].params.column, 'count');
  assert.equal(adminCalls[0].params.value, 1);
});

test('カウンタ行が無ければ作ってから数え始める', async () => {
  const missing = new AppwriteException('not found', 404, 'row_not_found');
  const adminCalls: Call[] = [];
  let firstIncrement = true;
  const gateways = {
    admin: () => ({
      async incrementRowColumn(params: any) {
        adminCalls.push({ method: 'incrementRowColumn', params });
        if (firstIncrement) { firstIncrement = false; throw missing; }
        return { count: 2 };
      },
      async createRow(params: any) {
        adminCalls.push({ method: 'createRow', params });
        return { $id: params.rowId };
      },
    }),
    session: () => ({}),
  };

  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });
  const value = await repository.bumpServerCounter('rate_limits', 'c1', 'count', { userId: 'alice', bucket: 'write' });

  assert.equal(value, 1);
  assert.deepEqual(adminCalls.map(call => call.method), ['incrementRowColumn', 'createRow']);
  assert.equal(adminCalls[1].params.data.count, 1);
  assert.equal(adminCalls[1].params.data.bucket, 'write');
  assert.deepEqual(adminCalls[1].params.permissions, []);
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
  const cookie = buildSessionCookie('secret-value', new Date(Date.now() + 3600_000).toISOString(), true);
  assert.match(cookie, /^ll_session=secret-value;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=3[0-9]{3}/);
});

test('本番（HTTPS）ではSecureを必ず付ける', () => {
  const original = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    assert.match(buildSessionCookie('s', new Date(Date.now() + 1000).toISOString()), /Secure/);
    assert.match(buildClearedSessionCookie(), /Secure/);
  } finally {
    if (original === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = original;
  }
});

test('ローカル開発（HTTP）ではSecureを外す（付けるとcookieが保存されない）', () => {
  assert.equal(/Secure/.test(buildSessionCookie('s', new Date(Date.now() + 1000).toISOString(), false)), false);
  assert.equal(/Secure/.test(buildClearedSessionCookie(false)), false);
});

test('ログアウト用のcookieは即時失効させる', () => {
  assert.match(buildClearedSessionCookie(true), /Max-Age=0/);
});

test('Cookieヘッダから値を取り出す', () => {
  const cookies = parseCookies('other=1; ll_session=abc%20def; empty=');
  assert.equal(cookies.ll_session, 'abc def');
  assert.equal(cookies.other, '1');
  assert.deepEqual(parseCookies(undefined), {});
});

// ---------------------------------------------------------------- 並行書き込み

test('大量の行を上限つきで並行に書く（移行が実行時間上限に当たらないように）', async () => {
  let inFlight = 0;
  let peak = 0;
  const writes: string[] = [];
  const gateways = {
    admin: () => ({
      async createRow(params: any) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        writes.push(params.rowId);
        inFlight--;
        return { $id: params.rowId };
      },
    }),
    session: () => ({}),
  };

  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });
  const rows = Array.from({ length: 50 }, (_, i) => ({ rowId: `r${i}`, data: {} }));
  const result = await repository.putOwnedRows('meals', 'alice', rows, 'create');

  assert.equal(result.created, 50, '全ての行が書かれること');
  assert.equal(writes.length, 50);
  assert.equal(peak > 1, true, '並行に走っていること');
  assert.equal(peak <= WRITE_CONCURRENCY, true, `同時実行数が上限(${WRITE_CONCURRENCY})を超えないこと`);
});

test('並行書き込みでも成功と重複を正しく数える', async () => {
  const conflict = new AppwriteException('already exists', 409, 'row_already_exists');
  const gateways = {
    admin: () => ({
      async createRow(params: any) {
        // 偶数番目だけ「既にある」扱いにする
        if (Number(params.rowId.slice(1)) % 2 === 0) throw conflict;
        return { $id: params.rowId };
      },
    }),
    session: () => ({}),
  };

  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });
  const rows = Array.from({ length: 20 }, (_, i) => ({ rowId: `r${i}`, data: {} }));
  const result = await repository.putOwnedRows('meals', 'alice', rows, 'create');

  assert.deepEqual(result, { created: 10, existed: 10 });
});

test('並行書き込みの途中で本当のエラーが出たら握りつぶさない', async () => {
  const failure = new AppwriteException('boom', 500, 'general_error');
  const gateways = {
    admin: () => ({
      async createRow(params: any) {
        if (params.rowId === 'r5') throw failure;
        return { $id: params.rowId };
      },
    }),
    session: () => ({}),
  };

  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });
  const rows = Array.from({ length: 20 }, (_, i) => ({ rowId: `r${i}`, data: {} }));
  await assert.rejects(
    () => repository.putOwnedRows('meals', 'alice', rows, 'create'),
    (error: any) => error.status === 502,
  );
});

// ---------------------------------------------------------------- エラーの切り分け

test('スキーマ不整合を「接続失敗」と言わない（原因を探せなくなるため）', async () => {
  const schemaError = new AppwriteException(
    'Invalid document structure: Unknown attribute: "fat"', 400, 'row_invalid_structure',
  );
  const { gateways } = fakeGateways({ failWith: schemaError });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await assert.rejects(
    () => repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: {} }], 'create'),
    (error: any) => error.code === 'schema_mismatch' && error.status === 503
      // 列名・テーブル名は利用者に出さない
      && !/fat/.test(error.message) && !/meals/.test(error.message),
  );
});

test('APIキーのscope不足も「接続失敗」と区別する', async () => {
  const scopeError = new AppwriteException('missing scope', 401, 'general_unauthorized_scope');
  const { gateways } = fakeGateways({ failWith: scopeError });
  const repository = new AppwriteRepository({ sessionSecret: 's', gateways });

  await assert.rejects(
    () => repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: {} }], 'create'),
    (error: any) => error.code === 'not_configured' && error.status === 503,
  );
});

test('サーバーログにはどのテーブルの何で失敗したかを残す', async () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const schemaError = new AppwriteException('Unknown attribute: "fat"', 400, 'row_invalid_structure');
    const { gateways } = fakeGateways({ failWith: schemaError });
    const repository = new AppwriteRepository({ sessionSecret: 's', gateways });
    await repository.putOwnedRows('meals', 'alice', [{ rowId: 'r1', data: {} }], 'create').catch(() => {});
  } finally {
    console.error = original;
  }

  assert.equal(lines.some(line => line.includes('meals.create') && line.includes('fat')), true);
});
