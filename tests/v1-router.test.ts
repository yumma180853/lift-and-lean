import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../api/core/errors.ts';
import { LiftAndLeanService } from '../api/core/service.ts';
import { createV1Router } from '../api/v1/router.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const NOW = new Date('2026-08-12T01:00:00Z');
const TODAY = '2026-08-12';

/** セッションsecret → userId の対応を持つ偽の認証 */
function fakeAuth(sessions: Map<string, string>) {
  return {
    async signUp(email: string) {
      const userId = `user-${email.split('@')[0]}`;
      sessions.set(`secret-${userId}`, userId);
      return { user: { userId }, secret: `secret-${userId}`, expiresAt: '2026-09-12T00:00:00.000Z' };
    },
    async logIn(email: string, password: string) {
      if (password !== 'correct-horse') throw new AuthError('メールアドレスかパスワードが違います。');
      const userId = `user-${email.split('@')[0]}`;
      sessions.set(`secret-${userId}`, userId);
      return { user: { userId }, secret: `secret-${userId}`, expiresAt: '2026-09-12T00:00:00.000Z' };
    },
    async logOut(secret: string) { sessions.delete(secret); },
    async resolveUser(secret: string | undefined) {
      const userId = secret ? sessions.get(secret) : undefined;
      if (!userId) throw new AuthError();
      return { userId };
    },
  };
}

function setup() {
  const repository = new MemoryRepository();
  const sessions = new Map<string, string>();
  const cookies = new Map<string, string>();

  const handle = createV1Router({
    auth: fakeAuth(sessions),
    createService: (secret: string) => new LiftAndLeanService({
      repository: repository.asViewer(sessions.get(secret) ?? '(unknown)'),
      clock: { now: () => NOW },
      onAuditFailure: () => {},
    }),
    readCookie: (req: any) => req.sessionSecret,
    setSessionCookie: (res: any, secret: string) => { cookies.set('ll_session', secret); res.cookieSet = secret; },
    clearSessionCookie: (res: any) => { cookies.delete('ll_session'); res.cookieCleared = true; },
  });

  async function call(method: string, url: string, options: { body?: unknown; secret?: string } = {}) {
    const req: any = { method, url, body: options.body, sessionSecret: options.secret, headers: {} };
    const res: any = {
      statusCode: 0,
      payload: undefined,
      headers: {} as Record<string, unknown>,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.payload = body; return this; },
      setHeader(name: string, value: unknown) { this.headers[name] = value; },
      getHeader(name: string) { return this.headers[name]; },
    };
    const handled = await handle(req, res);
    return { handled, status: res.statusCode, body: res.payload as any, res };
  }

  return { call, repository, sessions, cookies };
}

// ---------------------------------------------------------------- 経路

test('/api/v1 以外のURLには触らない', async () => {
  const { call } = setup();
  const result = await call('POST', '/api/estimate-meal');
  assert.equal(result.handled, false);
  assert.equal(result.status, 0);
});

test('未ログインでデータAPIを叩くと401', async () => {
  const { call } = setup();
  const result = await call('GET', '/api/v1/summary');
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'unauthorized');
});

test('存在しないエンドポイントは404', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'a@example.jp', password: 'correct-horse' } });
  const result = await call('GET', '/api/v1/unknown', { secret: signup.res.cookieSet });
  assert.equal(result.status, 404);
});

test('許可していないメソッドは405', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'a@example.jp', password: 'correct-horse' } });
  const result = await call('DELETE', '/api/v1/summary', { secret: signup.res.cookieSet });
  assert.equal(result.status, 405);
});

// ---------------------------------------------------------------- 認証

test('サインアップでセッションcookieを発行する', async () => {
  const { call, cookies } = setup();
  const result = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });

  assert.equal(result.status, 201);
  assert.equal(result.body.userId, 'user-yuma');
  assert.equal(cookies.get('ll_session'), 'secret-user-yuma');
});

test('パスワードが違えば401でcookieを発行しない', async () => {
  const { call, cookies } = setup();
  const result = await call('POST', '/api/v1/auth/login', { body: { email: 'yuma@example.jp', password: 'wrong-password' } });

  assert.equal(result.status, 401);
  assert.equal(cookies.has('ll_session'), false);
});

test('入力が不正ならAppwriteへ届く前に400で止まる', async () => {
  const { call } = setup();
  const result = await call('POST', '/api/v1/auth/signup', { body: { email: 'not-an-email', password: 'short' } });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'validation_error');
});

test('ログアウトでセッションを捨てる', async () => {
  const { call, sessions } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  const result = await call('POST', '/api/v1/auth/logout', { secret });
  assert.equal(result.status, 200);
  assert.equal(sessions.has(secret), false);

  const after = await call('GET', '/api/v1/auth/me', { secret });
  assert.equal(after.status, 401);
});

// ---------------------------------------------------------------- データ

test('記録から読み出しまで一連で動く', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  const created = await call('POST', '/api/v1/meals', {
    secret,
    body: { name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2, clientRequestId: 'req-1' },
  });
  assert.equal(created.status, 201);

  const list = await call('GET', `/api/v1/meals?date=${TODAY}`, { secret });
  assert.equal(list.status, 200);
  assert.equal(list.body.meals.length, 1);

  const summary = await call('GET', '/api/v1/summary', { secret });
  assert.equal(summary.body.totals.calories, 320);
});

test('bodyのuserIdを詐称しても、ログイン中の本人として保存される', async () => {
  const { call, repository } = setup();
  const alice = await call('POST', '/api/v1/auth/signup', { body: { email: 'alice@example.jp', password: 'correct-horse' } });
  const bob = await call('POST', '/api/v1/auth/signup', { body: { email: 'bob@example.jp', password: 'correct-horse' } });

  await call('POST', '/api/v1/meals', {
    secret: bob.res.cookieSet,
    body: { userId: 'user-alice', name: 'なりすまし', calories: 100, protein: 1, fat: 1, carbs: 1 },
  });

  const aliceMeals = await call('GET', '/api/v1/meals', { secret: alice.res.cookieSet });
  assert.deepEqual(aliceMeals.body.meals, []);

  const stored = repository.rawRows('meals');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].userId, 'user-bob');
});

test('他人のセッションで他人の記録を消せない', async () => {
  const { call, repository } = setup();
  const alice = await call('POST', '/api/v1/auth/signup', { body: { email: 'alice@example.jp', password: 'correct-horse' } });
  const bob = await call('POST', '/api/v1/auth/signup', { body: { email: 'bob@example.jp', password: 'correct-horse' } });

  const created = await call('POST', '/api/v1/meals', {
    secret: alice.res.cookieSet,
    body: { name: 'アリスの食事', calories: 100, protein: 1, fat: 1, carbs: 1 },
  });

  const result = await call('DELETE', `/api/v1/meals/${created.body.rowId}`, { secret: bob.res.cookieSet });
  assert.equal(result.status, 404);
  assert.equal(repository.countOf('meals'), 1);
});

test('移行APIは preview / 本実行 / 検証 の3つが揃っている', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;
  const backup = {
    app: 'lift-and-lean',
    version: 1,
    data: { meals: [{ id: 'm1', date: '2026-08-10', name: 'x', calories: 100, protein: 1, fat: 1, carbs: 1 }] },
  };

  const preview = await call('POST', '/api/v1/migrate/preview', { secret, body: backup });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.counts.meals, 1);

  const applied = await call('POST', '/api/v1/migrate', { secret, body: backup });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true);

  const verified = await call('POST', '/api/v1/migrate/verify', { secret, body: backup });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.ok, true);
});

test('目標とプロフィールを保存して読み戻せる', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  await call('PUT', '/api/v1/goals', {
    secret,
    body: { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 68, trainerStyle: 'stoic' },
  });
  await call('PUT', '/api/v1/profile', {
    secret,
    body: { hiddenWorkoutDates: ['2026-07-01'], longestStreak: 12, customExerciseCategories: { 'ヒップスラスト': '脚' } },
  });

  const goals = await call('GET', '/api/v1/goals', { secret });
  const profile = await call('GET', '/api/v1/profile', { secret });

  assert.equal(goals.body.goals.trainerStyle, 'stoic');
  assert.equal(profile.body.profile.longestStreak, 12);
  assert.equal(profile.body.profile.customExerciseCategories, '{"ヒップスラスト":"脚"}');
});
