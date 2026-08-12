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
 * 後始末:
 *   使い捨てユーザーを2人作り、書いた行と一緒に必ず消す。
 *   途中で失敗した場合に備え、後始末は finally で行う。
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
  const { AppwriteRepository } = await import('../../api/appwrite/repository.ts');
  const { LiftAndLeanService } = await import('../../api/core/service.ts');
  const { adminUsers, adminTables, databaseId } = await import('../../api/appwrite/client.ts');
  const { ID } = await import('node-appwrite');

  const users = adminUsers();
  const stamp = Date.now();
  const created: { userId: string; secret: string }[] = [];
  const writtenRows: { table: string; rowId: string }[] = [];

  const makeUser = async (label: string) => {
    const user = await users.create({
      userId: ID.unique(),
      email: `it-${label}-${stamp}@lift-and-lean.test`,
      password: `it-${label}-${stamp}-Passw0rd!`,
      name: `integration ${label}`,
    });
    const session = await users.createSession({ userId: user.$id });
    const entry = { userId: user.$id, secret: session.secret };
    created.push(entry);
    return entry;
  };

  try {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');

    const serviceFor = (account: { userId: string; secret: string }) => new LiftAndLeanService({
      repository: new AppwriteRepository({ sessionSecret: account.secret }),
    });

    const aliceService = serviceFor(alice);
    const bobService = serviceFor(bob);

    // アリスが記録する
    const meal = await aliceService.logMeal(alice.userId, {
      clientRequestId: `it-${stamp}`,
      name: 'integration test meal',
      calories: 100, protein: 1, fat: 1, carbs: 1,
    });
    writtenRows.push({ table: 'meals', rowId: meal.rowId });

    // 本人は読める
    const own = await aliceService.listMeals(alice.userId);
    assert.equal(own.some(row => row.$id === meal.rowId), true, 'アリス自身が自分の記録を読めること');

    // 同じ内容の再送は重複しない（Appwriteの409を冪等として扱えているか）
    const again = await aliceService.logMeal(alice.userId, {
      clientRequestId: `it-${stamp}`,
      name: 'integration test meal',
      calories: 100, protein: 1, fat: 1, carbs: 1,
    });
    assert.equal(again.rowId, meal.rowId);
    assert.equal(again.duplicated, true, '同じclientRequestIdの再送が重複扱いになること');

    // 他人は読めない（ここはAppwriteの行権限が効いているかの確認）
    const leakedByOwnList = await bobService.listMeals(bob.userId);
    assert.equal(leakedByOwnList.some(row => row.$id === meal.rowId), false, 'ボブの一覧にアリスの行が出ないこと');

    const bobRepository = new AppwriteRepository({ sessionSecret: bob.secret });
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
    assert.equal(stillThere.some(row => row.$id === meal.rowId), true, '削除の試行後もアリスの記録が残っていること');
  } finally {
    // 後始末。失敗しても残骸を残さない
    const db = adminTables();
    for (const row of writtenRows) {
      try {
        await db.deleteRow({ databaseId: databaseId(), tableId: row.table, rowId: row.rowId });
      } catch { /* 既に消えていれば良い */ }
    }
    for (const account of created) {
      try {
        await users.delete({ userId: account.userId });
      } catch { /* 手で消せる状態にしておく */ }
    }
  }
});

test('実Appwriteのスキーマが定義どおりである', options, async () => {
  const { adminTables, databaseId } = await import('../../api/appwrite/client.ts');
  const { SCHEMA } = await import('../../scripts/appwrite-setup.ts');

  const db = adminTables();
  for (const table of SCHEMA) {
    const actual = await db.getTable({ databaseId: databaseId(), tableId: table.id });
    assert.equal(actual.rowSecurity, true, `${table.id}: Row Securityが有効であること`);
    assert.deepEqual(actual.$permissions, [], `${table.id}: table-level権限が無いこと`);

    const columns = await db.listColumns({ databaseId: databaseId(), tableId: table.id });
    const keys = new Set(columns.columns.map((column: any) => column.key));
    for (const column of table.columns) {
      assert.equal(keys.has(column.key), true, `${table.id}.${column.key} が存在すること`);
    }
  }
});
