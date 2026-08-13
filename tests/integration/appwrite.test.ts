/**
 * 実Appwriteに対する統合テスト。**普段のテストでは動かない。**
 *
 *   実行条件（すべて揃ったときだけ動く）:
 *     APPWRITE_PROJECT_ID / APPWRITE_API_KEY が設定されている
 *     APPWRITE_ALLOW_INTEGRATION_TESTS=1 が明示されている
 *
 *   実行方法:
 *     APPWRITE_ALLOW_INTEGRATION_TESTS=1 npm run test:integration
 *
 * 何を確かめるか:
 *   単体テストは「我々のコードが正しい権限を渡しているか」までしか見られない。
 *   ここでは **Appwriteが実際に他人の行を返さないこと** をプラットフォームに対して確かめる。
 *
 * 使うAPIについて:
 *   テストユーザーの作成・ログインは **本番と同じ Account API**（project IDだけで叩ける）で行う。
 *   Users API（管理者向け）は使わないので、**本番APIキーのscopeを増やさずに実行できる**。
 *   アカウントは固定の2つを使い回す（2回目以降は既存アカウントへログインする）。
 *   書いた行はテストの最後に必ず消す。アカウントは残るが、増え続けることはない。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Boolean(
  process.env.APPWRITE_PROJECT_ID &&
  process.env.APPWRITE_API_KEY &&
  process.env.APPWRITE_ALLOW_INTEGRATION_TESTS === '1',
);

const options = enabled ? {} : { skip: '実Appwriteの認証情報とAPPWRITE_ALLOW_INTEGRATION_TESTS=1が必要です' };

test('実Appwriteで他人のデータが読めない・消せない', options, async () => {
  const { AppwriteRepository } = await import('../../api/_appwrite/repository.ts');
  const { LiftAndLeanService } = await import('../../api/_core/service.ts');
  const { logIn, signUp } = await import('../../api/_appwrite/auth.ts');

  /** 固定のテストアカウント。無ければ作り、あればログインする */
  const account = async (label: string) => {
    const email = `integration-${label}@lift-and-lean.test`;
    const password = `Integration-${label}-2026!`;
    try {
      return await signUp(email, password, `integration ${label}`);
    } catch (error: any) {
      if (error?.code !== 'email_taken') throw error;
      return await logIn(email, password);
    }
  };

  const written: { table: 'meals'; rowId: string; owner: { userId: string; secret: string } }[] = [];

  try {
    const aliceSession = await account('alice');
    const bobSession = await account('bob');
    const alice = { userId: aliceSession.user.userId, secret: aliceSession.secret };
    const bob = { userId: bobSession.user.userId, secret: bobSession.secret };
    assert.notEqual(alice.userId, bob.userId, 'テストユーザーが2人分あること');

    const serviceFor = (session: { secret: string }) => new LiftAndLeanService({
      repository: new AppwriteRepository({ sessionSecret: session.secret }),
    });
    const aliceService = serviceFor(alice);
    const bobService = serviceFor(bob);

    // アリスが記録する
    const stamp = Date.now();
    const meal = await aliceService.logMeal(alice.userId, {
      clientRequestId: `it-${stamp}`,
      name: 'integration test meal',
      calories: 100, protein: 1, fat: 1, carbs: 1,
    });
    written.push({ table: 'meals', rowId: meal.rowId, owner: alice });

    // 本人は読める
    const own = await aliceService.listMeals(alice.userId);
    assert.equal(own.some(row => row.id === meal.rowId), true, 'アリス自身が自分の記録を読めること');

    // 同じ内容の再送は重複しない（Appwriteの409を冪等として扱えているか）
    const again = await aliceService.logMeal(alice.userId, {
      clientRequestId: `it-${stamp}`,
      name: 'integration test meal',
      calories: 100, protein: 1, fat: 1, carbs: 1,
    });
    assert.equal(again.rowId, meal.rowId);
    assert.equal(again.duplicated, true, '同じclientRequestIdの再送が重複扱いになること');

    // 他人は読めない（Appwriteの行権限が効いているかの確認）
    const bobRepository = new AppwriteRepository({ sessionSecret: bob.secret });

    const bobList = await bobService.listMeals(bob.userId);
    assert.equal(bobList.some(row => row.id === meal.rowId), false, 'ボブの一覧にアリスの行が出ないこと');

    const leakedByUserId = await bobRepository.listRows('meals', bob.userId, { equals: { userId: alice.userId } });
    assert.deepEqual(leakedByUserId, [], 'アリスのuserIdを指定してもボブには返らないこと');

    const leakedById = await bobRepository.listRows('meals', bob.userId, { equals: { $id: meal.rowId } });
    assert.deepEqual(leakedById, [], 'rowIdを直接指定してもボブには返らないこと');

    // 他人は消せない
    await assert.rejects(
      () => bobService.deleteMeal(bob.userId, meal.rowId),
      (error: any) => error.status === 404,
      'ボブがアリスの記録を消せないこと',
    );

    const stillThere = await aliceService.listMeals(alice.userId);
    assert.equal(stillThere.some(row => row.id === meal.rowId), true, '削除の試行後もアリスの記録が残っていること');
  } finally {
    // 後始末。所有者本人のサービス経由で消す（ここもAPIキーの読み取りを使わない）
    for (const row of written) {
      try {
        const service = new LiftAndLeanService({
          repository: new AppwriteRepository({ sessionSecret: row.owner.secret }),
        });
        await service.deleteMeal(row.owner.userId, row.rowId);
      } catch { /* 既に消えていれば良い */ }
    }
  }
});

/**
 * 本番APIキーに `rows.write` だけを付けた状態で、実運用で通る全ての書き込み経路が
 * 動くことを実物で確かめる。scopeを削りすぎていないかの答え合わせ。
 *
 * ここが通れば「本番キーは rows.write のみでよい」が実測で裏づけられる。
 * どこかで 401 unauthorized_scope が出たら、その操作が必要とする scope を足す。
 */
test('本番APIキーは rows.write だけで全ての書き込み経路が動く', options, async () => {
  const { AppwriteRepository } = await import('../../api/_appwrite/repository.ts');
  const { LiftAndLeanService } = await import('../../api/_core/service.ts');
  const { logIn, signUp } = await import('../../api/_appwrite/auth.ts');
  const { deriveRowId } = await import('../../api/_migration-helpers.ts');

  const email = 'integration-alice@lift-and-lean.test';
  const password = 'Integration-alice-2026!';
  const session = await signUp(email, password).catch(async (error: any) => {
    if (error?.code !== 'email_taken') throw error;
    return logIn(email, password);
  });

  const repository = new AppwriteRepository({ sessionSecret: session.secret });
  const service = new LiftAndLeanService({ repository });
  const userId = session.user.userId;
  const stamp = Date.now();
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const cleanup: (() => Promise<unknown>)[] = [];
  try {
    // createRow（追記系）
    const meal = await service.logMeal(userId, {
      clientRequestId: `scope-${stamp}`,
      name: 'scope check', calories: 100, protein: 1, fat: 1, carbs: 1,
    });
    cleanup.push(() => service.deleteMeal(userId, meal.rowId));

    // updateRow（部分更新）
    await service.updateMeal(userId, meal.rowId, {
      name: 'scope check updated', calories: 120, protein: 2, fat: 1, carbs: 1,
    });

    // upsertRow（1日1件の上書き）
    const weight = await service.logWeight(userId, { weight: 70 });
    await service.logWeight(userId, { weight: 70.5 });
    cleanup.push(() => repository.deleteOwnedRow('weights', userId, weight.rowId));

    // 行権限なしの追記（audit_log）
    await repository.appendServerRow('audit_log', deriveRowId(userId, 'audit', `scope-${stamp}`), {
      userId, action: 'integration.check', source: 'system', occurredAt: new Date().toISOString(),
    });

    // 増分（rate_limits）。読み取りscopeなしで数えられること
    const counterId = deriveRowId(userId, 'rate', `integration:${today}`);
    const seed = { userId, bucket: 'integration', windowStart: today };
    const first = await repository.bumpServerCounter('rate_limits', counterId, 'count', seed);
    const second = await repository.bumpServerCounter('rate_limits', counterId, 'count', seed);
    assert.equal(second, first + 1, 'カウンタが増分操作で進むこと');

    // 読み取りはセッション側で成立していること
    const meals = await service.listMeals(userId, today);
    assert.equal(meals.some(row => row.id === meal.rowId), true);
  } finally {
    for (const remove of cleanup) {
      try { await remove(); } catch { /* 残っても手で消せる */ }
    }
  }
});
