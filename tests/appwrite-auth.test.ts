/**
 * 認証フローの検証。実際のAppwriteには繋がず、
 * 「どの資格情報で呼んだか」「Appwriteのエラーをどう変換したか」を見る。
 *
 * 本番で実際に起きた不具合を再発させないためのテストが中心:
 *   - APIキー無しで session を作ると `secret` が空で返り、
 *     「登録できたのに毎回未ログイン」になっていた
 *   - その結果アカウントだけが残り、次の登録が「すでに登録されています」になった
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.APPWRITE_PROJECT_ID = 'test-project';
process.env.APPWRITE_API_KEY = 'test-key-not-a-secret';
process.env.APPWRITE_DATABASE_ID = 'testdb';
process.env.APPWRITE_ENDPOINT = 'https://example.invalid/v1';
process.env.APP_PUBLIC_URL = 'https://lift-and-lean.example';

const auth = await import('../api/_appwrite/auth.ts');
const { AppwriteException } = await import('node-appwrite');

interface Call { via: 'guest' | 'admin' | 'session'; method: string; params: any }

/** 呼び出しを記録する偽のAccount API */
function fakeAccounts(handlers: Record<string, (params: any) => any> = {}) {
  const calls: Call[] = [];
  const make = (via: Call['via']) => new Proxy({}, {
    get: (_target, method: string) => async (params: any) => {
      calls.push({ via, method, params });
      const handler = handlers[method];
      if (handler) return handler(params);
      return {};
    },
  });
  return {
    calls,
    gateways: { guest: () => make('guest'), admin: () => make('admin'), session: () => make('session') },
  };
}

const validSession = () => ({
  userId: 'user-1',
  secret: 'session-secret-value',
  expire: new Date(Date.now() + 86400_000).toISOString(),
});

// ---------------------------------------------------------------- 本番不具合の再発防止

test('セッションはAPIキー付きクライアントで発行する（guestだとsecretが空で返るため）', async () => {
  const { calls, gateways } = fakeAccounts({ createEmailPasswordSession: validSession });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    const result = await auth.logIn('a@example.jp', 'password-1234');
    assert.equal(result.secret, 'session-secret-value');
  } finally {
    restore();
  }

  const sessionCall = calls.find(call => call.method === 'createEmailPasswordSession');
  assert.equal(sessionCall?.via, 'admin', 'guestではなくadmin（APIキー付き）で発行すること');
});

test('secretが空で返ってきたら、黙って壊れず503で止める', async () => {
  const { gateways } = fakeAccounts({
    createEmailPasswordSession: () => ({ ...validSession(), secret: '' }),
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await assert.rejects(
      () => auth.logIn('a@example.jp', 'password-1234'),
      (error: any) => error.status === 503 && error.code === 'session_unavailable',
    );
  } finally {
    restore();
  }
});

test('空のsecretをCookieに載せない（載せると毎回未ログインになる）', () => {
  // logIn が止めるので通常は到達しないが、Cookie側でも空文字は無意味だと分かるようにしておく
  const cookie = auth.buildSessionCookie('', new Date(Date.now() + 1000).toISOString(), true);
  assert.match(cookie, /^ll_session=;/, '空のsecretは空のCookieになる＝セッションとして機能しない');
});

test('登録は成功したがセッション発行に失敗したら、アカウントが残っていることを伝える', async () => {
  const { gateways } = fakeAccounts({
    create: () => ({ $id: 'user-1' }),
    createEmailPasswordSession: () => { throw new AppwriteException('boom', 500, 'general_error'); },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await assert.rejects(
      () => auth.signUp('a@example.jp', 'password-1234'),
      (error: any) => error.code === 'signup_session_failed'
        && /アカウントは作成できました/.test(error.message)
        && /ログイン/.test(error.message),
    );
  } finally {
    restore();
  }
});

test('アカウント作成に失敗した場合は「作成できました」と言わない', async () => {
  const { gateways } = fakeAccounts({
    create: () => { throw new AppwriteException('exists', 409, 'user_already_exists'); },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await assert.rejects(
      () => auth.signUp('a@example.jp', 'password-1234'),
      (error: any) => error.code === 'email_taken' && !/作成できました/.test(error.message),
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- エラー変換

test('Appwriteのエラー種別を利用者向けの案内に変換する', async () => {
  const cases: { type: string; code: number; expectCode: string; expect: RegExp }[] = [
    { type: 'user_already_exists', code: 409, expectCode: 'email_taken', expect: /すでに登録されています/ },
    { type: 'user_email_already_exists', code: 409, expectCode: 'email_taken', expect: /すでに登録されています/ },
    { type: 'user_password_reset_required', code: 409, expectCode: 'password_reset_required', expect: /再設定/ },
    { type: 'user_invalid_credentials', code: 401, expectCode: 'unauthorized', expect: /メールアドレスかパスワードが違います/ },
    { type: 'password_personal_data', code: 400, expectCode: 'weak_password', expect: /含めないで/ },
    { type: 'general_rate_limit_exceeded', code: 429, expectCode: 'rate_limited', expect: /試行回数/ },
    // scope不足は401で返るが、利用者の入力は正しい。パスワード違いと表示してはいけない
    { type: 'general_unauthorized_scope', code: 401, expectCode: 'not_configured', expect: /設定が未完了/ },
  ];

  for (const testCase of cases) {
    const { gateways } = fakeAccounts({
      createEmailPasswordSession: () => { throw new AppwriteException('x', testCase.code, testCase.type); },
    });
    const restore = auth.__setAccountGatewaysForTest(gateways);
    try {
      await assert.rejects(
        () => auth.logIn('a@example.jp', 'password-1234'),
        (error: any) => error.code === testCase.expectCode && testCase.expect.test(error.message),
        testCase.type,
      );
    } finally {
      restore();
    }
  }
});

test('「登録済みかどうか」をログインの応答から判別できない', async () => {
  const messages: string[] = [];
  for (const type of ['user_invalid_credentials', 'user_not_found']) {
    const { gateways } = fakeAccounts({
      createEmailPasswordSession: () => { throw new AppwriteException('x', 401, type); },
    });
    const restore = auth.__setAccountGatewaysForTest(gateways);
    try {
      await auth.logIn('a@example.jp', 'password-1234');
    } catch (error: any) {
      messages.push(error.message);
    } finally {
      restore();
    }
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1], '未登録でも間違いでも同じ文言にすること');
});

test('Appwriteの生のエラー文言は利用者へ返さない', async () => {
  const { gateways } = fakeAccounts({
    createEmailPasswordSession: () => {
      throw new AppwriteException('Unknown column "internal_secret_table"', 500, 'general_error');
    },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await assert.rejects(
      () => auth.logIn('a@example.jp', 'password-1234'),
      (error: any) => error.status === 502 && !/internal_secret_table/.test(error.message),
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- パスワード再設定

test('再設定メールのリンク先は設定値から作る（Hostヘッダを信用しない）', async () => {
  const { calls, gateways } = fakeAccounts();
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await auth.requestPasswordRecovery('a@example.jp');
  } finally {
    restore();
  }

  const call = calls.find(c => c.method === 'createRecovery');
  assert.equal(call?.params.url, 'https://lift-and-lean.example/reset-password');
  assert.equal(call?.via, 'guest', '再設定の申し込みにAPIキーは要らない');
});

test('未登録のメールアドレスでも成功と区別がつかない', async () => {
  const { gateways } = fakeAccounts({
    createRecovery: () => { throw new AppwriteException('not found', 404, 'user_not_found'); },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    // 例外を投げない＝呼び出し側からは成功と同じ
    await auth.requestPasswordRecovery('nobody@example.jp');
  } finally {
    restore();
  }
});

test('レート制限は隠さずに伝える（本人にも起きるため）', async () => {
  const { gateways } = fakeAccounts({
    createRecovery: () => { throw new AppwriteException('too many', 429, 'general_rate_limit_exceeded'); },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await assert.rejects(
      () => auth.requestPasswordRecovery('a@example.jp'),
      (error: any) => error.status === 429,
    );
  } finally {
    restore();
  }
});

test('Platform未登録（URL拒否）はサーバー側の設定不備として扱う', async () => {
  const { gateways } = fakeAccounts({
    createRecovery: () => {
      throw new AppwriteException('Invalid `url` param', 400, 'general_argument_invalid');
    },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await assert.rejects(
      () => auth.requestPasswordRecovery('a@example.jp'),
      (error: any) => error.status === 503 && error.code === 'not_configured',
    );
  } finally {
    restore();
  }
});

test('新しいパスワードの設定はuserIdとsecretをそのまま渡す', async () => {
  const { calls, gateways } = fakeAccounts();
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await auth.completePasswordRecovery('user-1', 'mail-secret', 'brand-new-password');
  } finally {
    restore();
  }

  const call = calls.find(c => c.method === 'updateRecovery');
  assert.deepEqual(call?.params, { userId: 'user-1', secret: 'mail-secret', password: 'brand-new-password' });
});

test('壊れたリンクは理由を問わず同じ案内にする（userIdの実在も漏らさない）', async () => {
  const messages: string[] = [];
  // 400=不正な値 / 401=secretが違う / 404=userIdが存在しない
  for (const [code, type] of [[400, 'general_argument_invalid'], [401, 'user_invalid_token'], [404, 'user_not_found']] as const) {
    const { gateways } = fakeAccounts({
      updateRecovery: () => { throw new AppwriteException('bad', code as number, type as string); },
    });
    const restore = auth.__setAccountGatewaysForTest(gateways);
    try {
      await auth.completePasswordRecovery('user-1', 'stale', 'brand-new-password');
      assert.fail(`${type} で例外が投げられていない`);
    } catch (error: any) {
      assert.equal(error.status, 400, type);
      assert.match(error.message, /やり直/, type);
      messages.push(error.message);
    } finally {
      restore();
    }
  }
  assert.equal(new Set(messages).size, 1, '理由によって文言を変えないこと');
});

// ---------------------------------------------------------------- セッションの扱い

test('ログアウトはユーザーのセッションで現在のセッションを消す', async () => {
  const { calls, gateways } = fakeAccounts();
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await auth.logOut('secret-value');
  } finally {
    restore();
  }

  const call = calls.find(c => c.method === 'deleteSession');
  assert.equal(call?.via, 'session');
  assert.deepEqual(call?.params, { sessionId: 'current' });
});

test('すでに失効しているセッションのログアウトはエラーにしない', async () => {
  const { gateways } = fakeAccounts({
    deleteSession: () => { throw new AppwriteException('gone', 401, 'user_unauthorized'); },
  });
  const restore = auth.__setAccountGatewaysForTest(gateways);
  try {
    await auth.logOut('secret-value');
  } finally {
    restore();
  }
});
