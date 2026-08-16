import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, AuthError } from '../api/_core/errors.ts';
import { LiftAndLeanService } from '../api/_core/service.ts';
import { createV1Router } from '../api/_v1/router.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const NOW = new Date('2026-08-12T01:00:00Z');
const TODAY = '2026-08-12';

/** セッションsecret → userId の対応を持つ偽の認証 */
function fakeAuth(
  sessions: Map<string, string>,
  recovery: { requested: string[]; confirmed: any[] } = { requested: [], confirmed: [] },
  verification: { verified: Set<string>; sent: string[] } = { verified: new Set(), sent: [] },
) {
  return {
    recovery,
    verification,
    async sendEmailVerification(sessionSecret: string) {
      verification.sent.push(sessionSecret);
    },
    async completeEmailVerification(userId: string, secret: string) {
      if (secret !== 'valid-verification') {
        throw new AppError('verification_invalid', 400, 'このリンクは期限切れか、すでに使用済みです。');
      }
      verification.verified.add(userId);
    },
    async requestPasswordRecovery(email: string) {
      // 実装と同じく、未登録でも何も起きない（呼び出し側からは区別できない）
      recovery.requested.push(email);
    },
    async completePasswordRecovery(userId: string, secret: string, password: string) {
      if (secret !== 'valid-secret') {
        throw new AppError('recovery_invalid', 400, 'このリンクは期限切れか、すでに使用済みです。もう一度「パスワードをお忘れですか？」からやり直してください。');
      }
      recovery.confirmed.push({ userId, password });
    },
    async signUp(email: string) {
      const userId = `user-${email.split('@')[0]}`;
      sessions.set(`secret-${userId}`, userId);
      return { user: { userId, emailVerified: false }, secret: `secret-${userId}`, expiresAt: '2026-09-12T00:00:00.000Z' };
    },
    async logIn(email: string, password: string) {
      if (password !== 'correct-horse') throw new AuthError('メールアドレスかパスワードが違います。');
      const userId = `user-${email.split('@')[0]}`;
      sessions.set(`secret-${userId}`, userId);
      return { user: { userId, emailVerified: false }, secret: `secret-${userId}`, expiresAt: '2026-09-12T00:00:00.000Z' };
    },
    async logOut(secret: string) { sessions.delete(secret); },
    async resolveUser(secret: string | undefined) {
      const userId = secret ? sessions.get(secret) : undefined;
      if (!userId) throw new AuthError();
      return { userId, emailVerified: verification.verified.has(userId) };
    },
  };
}

function setup(extra: Record<string, any> = {}) {
  const repository = new MemoryRepository();
  const sessions = new Map<string, string>();
  const cookies = new Map<string, string>();
  const recovery = { requested: [] as string[], confirmed: [] as any[] };
  const verification = { verified: new Set<string>(), sent: [] as string[] };

  const handle = createV1Router({
    auth: fakeAuth(sessions, recovery, verification),
    createService: (secret: string) => new LiftAndLeanService({
      repository: repository.asViewer(sessions.get(secret) ?? '(unknown)'),
      clock: { now: () => NOW },
      onAuditFailure: () => {},
    }),
    readCookie: (req: any) => req.sessionSecret,
    setSessionCookie: (res: any, secret: string) => { cookies.set('ll_session', secret); res.cookieSet = secret; },
    clearSessionCookie: (res: any) => { cookies.delete('ll_session'); res.cookieCleared = true; },
    ...extra,
  });

    /** メール確認を済ませた状態にする（実機ではメールのリンクで行われる） */
  function markVerified(userId: string) {
    verification.verified.add(userId);
  }

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

  return { call, markVerified, repository, sessions, cookies, recovery, verification };
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
  const { call, markVerified } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'a@example.jp', password: 'correct-horse' } });
  markVerified(signup.body.userId);
  const result = await call('GET', '/api/v1/unknown', { secret: signup.res.cookieSet });
  assert.equal(result.status, 404);
});

test('許可していないメソッドは405', async () => {
  const { call, markVerified } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'a@example.jp', password: 'correct-horse' } });
  markVerified(signup.body.userId);
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
  const { call, markVerified } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  markVerified(signup.body.userId);
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
  const { call, markVerified, repository } = setup();
  const alice = await call('POST', '/api/v1/auth/signup', { body: { email: 'alice@example.jp', password: 'correct-horse' } });
  const bob = await call('POST', '/api/v1/auth/signup', { body: { email: 'bob@example.jp', password: 'correct-horse' } });
  markVerified(alice.body.userId);
  markVerified(bob.body.userId);

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
  const { call, markVerified, repository } = setup();
  const alice = await call('POST', '/api/v1/auth/signup', { body: { email: 'alice@example.jp', password: 'correct-horse' } });
  const bob = await call('POST', '/api/v1/auth/signup', { body: { email: 'bob@example.jp', password: 'correct-horse' } });
  markVerified(alice.body.userId);
  markVerified(bob.body.userId);

  const created = await call('POST', '/api/v1/meals', {
    secret: alice.res.cookieSet,
    body: { name: 'アリスの食事', calories: 100, protein: 1, fat: 1, carbs: 1 },
  });

  const result = await call('DELETE', `/api/v1/meals/${created.body.rowId}`, { secret: bob.res.cookieSet });
  assert.equal(result.status, 404);
  assert.equal(repository.countOf('meals'), 1);
});

test('移行APIは preview / 本実行 / 検証 の3つが揃っている', async () => {
  const { call, markVerified } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  markVerified(signup.body.userId);
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
  const { call, markVerified } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  markVerified(signup.body.userId);
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
  assert.deepEqual(profile.body.profile.customExerciseCategories, { 'ヒップスラスト': '脚' });
});

// ---------------------------------------------------------------- パスワード再設定

test('再設定の申し込みは、登録済みでも未登録でも同じ応答にする（列挙を助長しない）', async () => {
  const { call, recovery } = setup();
  await call('POST', '/api/v1/auth/signup', { body: { email: 'known@example.jp', password: 'correct-horse' } });

  const known = await call('POST', '/api/v1/auth/recovery', { body: { email: 'known@example.jp' } });
  const unknown = await call('POST', '/api/v1/auth/recovery', { body: { email: 'nobody@example.jp' } });

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.deepEqual(recovery.requested, ['known@example.jp', 'nobody@example.jp']);
});

test('再設定はログイン不要で呼べる', async () => {
  const { call } = setup();
  const result = await call('POST', '/api/v1/auth/recovery', { body: { email: 'a@example.jp' } });
  assert.equal(result.status, 200);
});

test('メールのリンクから新しいパスワードを設定できる', async () => {
  const { call, recovery } = setup();
  const result = await call('POST', '/api/v1/auth/recovery/confirm', {
    body: { userId: 'user-1', secret: 'valid-secret', password: 'brand-new-password' },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(recovery.confirmed, [{ userId: 'user-1', password: 'brand-new-password' }]);
});

test('期限切れ・使用済みのリンクは400で案内する', async () => {
  const { call } = setup();
  const result = await call('POST', '/api/v1/auth/recovery/confirm', {
    body: { userId: 'user-1', secret: 'expired', password: 'brand-new-password' },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /やり直/);
});

test('再設定の入力も検証する（短いパスワードはAppwriteへ届く前に弾く）', async () => {
  const { call } = setup();
  const result = await call('POST', '/api/v1/auth/recovery/confirm', {
    body: { userId: 'user-1', secret: 'valid-secret', password: 'short' },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'validation_error');
});

// ---------------------------------------------------------------- メール確認の強制

test('メール未確認ではデータAPIを一切使えない（403）', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  const endpoints: [string, string, unknown?][] = [
    ['GET', '/api/v1/summary'],
    ['GET', '/api/v1/meals'],
    ['POST', '/api/v1/meals', { name: 'x', calories: 1, protein: 1, fat: 1, carbs: 1 }],
    ['POST', '/api/v1/weights', { weight: 70 }],
    ['GET', '/api/v1/goals'],
    ['POST', '/api/v1/migrate', { app: 'lift-and-lean', data: {} }],
    ['POST', '/api/v1/migrate/preview', { app: 'lift-and-lean', data: {} }],
  ];

  for (const [method, url, body] of endpoints) {
    const result = await call(method, url, { secret, body });
    assert.equal(result.status, 403, `${method} ${url}`);
    assert.equal(result.body.code, 'email_not_verified', `${method} ${url}`);
  }
});

test('メール未確認でも、確認に必要な操作だけはできる', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  const me = await call('GET', '/api/v1/auth/me', { secret });
  assert.equal(me.status, 200);
  assert.equal(me.body.emailVerified, false);

  const resend = await call('POST', '/api/v1/auth/verification', { secret });
  assert.equal(resend.status, 200);

  const logout = await call('POST', '/api/v1/auth/logout', { secret });
  assert.equal(logout.status, 200);
});

test('確認メールの再送はログイン中の本人しか呼べない（列挙に使えない）', async () => {
  const { call, verification } = setup();
  const result = await call('POST', '/api/v1/auth/verification');
  assert.equal(result.status, 401);
  assert.deepEqual(verification.sent, []);
});

test('メール確認を完了するとデータAPIが使えるようになる', async () => {
  const { call } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  const blocked = await call('GET', '/api/v1/summary', { secret });
  assert.equal(blocked.status, 403);

  const confirm = await call('POST', '/api/v1/auth/verification/confirm', {
    body: { userId: signup.body.userId, secret: 'valid-verification' },
  });
  assert.equal(confirm.status, 200);

  const allowed = await call('GET', '/api/v1/summary', { secret });
  assert.equal(allowed.status, 200);
});

test('確認の完了はセッションが無くても呼べる（別ブラウザでリンクを開くため）', async () => {
  const { call, verification } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });

  const confirm = await call('POST', '/api/v1/auth/verification/confirm', {
    body: { userId: signup.body.userId, secret: 'valid-verification' },
  });
  assert.equal(confirm.status, 200);
  assert.equal(verification.verified.has(signup.body.userId), true);
});

test('壊れた確認リンクは400で案内する', async () => {
  const { call } = setup();
  const result = await call('POST', '/api/v1/auth/verification/confirm', {
    body: { userId: 'u1', secret: 'expired' },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'verification_invalid');
});

// ---------------------------------------------------------------- HTTPキャッシュ方針

test('利用者ごとの応答は共有キャッシュに載せない（全応答 no-store）', async () => {
  const { call, markVerified } = setup();
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'yuma@example.jp', password: 'correct-horse' } });
  const secret = signup.res.cookieSet;

  // 成功・認証エラー・権限エラー・入力エラー・不明な経路 のどれも同じ方針にする
  const cases: { label: string; result: any }[] = [
    { label: 'signup(201)', result: signup },
    { label: 'me(200)', result: await call('GET', '/api/v1/auth/me', { secret }) },
    { label: 'snapshot(403 未確認)', result: await call('GET', '/api/v1/snapshot', { secret }) },
    { label: 'snapshot(401 未ログイン)', result: await call('GET', '/api/v1/snapshot') },
    { label: 'login(401 資格情報違い)', result: await call('POST', '/api/v1/auth/login', { body: { email: 'a@example.jp', password: 'wrong-password' } }) },
    { label: 'login(400 入力不正)', result: await call('POST', '/api/v1/auth/login', { body: { email: 'bad', password: 'short' } }) },
    { label: 'unknown(404)', result: await call('GET', '/api/v1/unknown', { secret }) },
    { label: 'method(405)', result: await call('DELETE', '/api/v1/summary', { secret }) },
  ];

  for (const { label, result } of cases) {
    assert.equal(result.res.headers['Cache-Control'], 'no-store', label);
  }

  markVerified(signup.body.userId);
  const snapshot = await call('GET', '/api/v1/snapshot', { secret });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.res.headers['Cache-Control'], 'no-store', 'snapshot(200 確認済み)');
});

// ---------------------------------------------------------------- 音声の入口

/** ログイン済み・メール確認済みの状態を作る */
async function signedIn(call: any, markVerified: any) {
  const signup = await call('POST', '/api/v1/auth/signup', { body: { email: 'a@example.jp', password: 'correct-horse' } });
  markVerified(signup.body.userId);
  return signup.res.cookieSet as string;
}

test('音声の文字起こしはログインしていないと使えない', async () => {
  const { call } = setup({ transcribe: { transcribe: async () => 'ベンチプレス' } });
  const result = await call('POST', '/api/v1/transcribe', { body: { audio: 'AAA=' } });
  assert.equal(result.status, 401);
});

test('文字起こしを差し込んでいなければ 503（鍵が無い環境）', async () => {
  const { call, markVerified } = setup();
  const secret = await signedIn(call, markVerified);
  const result = await call('POST', '/api/v1/transcribe', { body: { audio: 'AAA=' }, secret });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, '音声入力は今は使えません。');
});

test('録音を送ると文字だけが返る（音声は返さない・保存しない）', async () => {
  const seen: any[] = [];
  const { call, markVerified } = setup({
    transcribe: {
      transcribe: async (audio: Buffer, extension: string, mimeType: string) => {
        seen.push({ size: audio.length, extension, mimeType });
        return 'ベンチプレス60キロ10回3セット';
      },
    },
  });
  const secret = await signedIn(call, markVerified);

  const audio = Buffer.from('fake-audio-bytes').toString('base64');
  const result = await call('POST', '/api/v1/transcribe', { body: { audio, mimeType: 'audio/mp4' }, secret });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { text: 'ベンチプレス60キロ10回3セット' });
  assert.equal(seen[0].extension, 'mp4', 'iPhone の形式が通っていない');
});

test('文字起こしの失敗は決まった一文で返る（内部理由を出さない）', async () => {
  const { call, markVerified } = setup({
    transcribe: { transcribe: async () => { throw new Error('OpenAI 500 internal'); } },
  });
  const secret = await signedIn(call, markVerified);

  const audio = Buffer.from('fake').toString('base64');
  const result = await call('POST', '/api/v1/transcribe', { body: { audio, mimeType: 'audio/webm' }, secret });

  assert.equal(result.status, 502);
  assert.equal(result.body.error, '聞き取れませんでした。もう一度お願いします。');
});

test('話して記録は、サーバーで保存せず画面へ内容を返せる', async () => {
  const { call, markVerified } = setup({
    parseCommand: async () => ({ intent: 'log_weight', args: { weight: 72.4 } }),
  });
  const secret = await signedIn(call, markVerified);

  const result = await call('POST', '/api/v1/command', { body: { text: '体重72.4キロ', apply: 'client' }, secret });

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'plan');
  assert.equal(result.body.plan.weight, 72.4);

  // サーバーはまだ書いていない（画面側の local-first が書く）
  const weights = await call('GET', '/api/v1/weights', { secret });
  assert.equal(weights.body.weights.length, 0);
});
