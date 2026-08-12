import assert from 'node:assert/strict';
import test from 'node:test';
import { LiftAndLeanService, RATE_LIMITS } from '../api/core/service.ts';
import { deriveRowId } from '../api/migration-helpers.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const ALICE = 'alice';
const BOB = 'bob';
const NOW = new Date('2026-08-12T01:00:00Z'); // JST 2026-08-12 10:00
const TODAY = '2026-08-12';

function setup(now: Date = NOW) {
  const repository = new MemoryRepository(ALICE);
  const service = new LiftAndLeanService({
    repository,
    clock: { now: () => now },
    onAuditFailure: (error) => { throw error; },
  });
  return { repository, service };
}

/** 同じデータを別ユーザーの視点で読むサービス */
function asUser(repository: MemoryRepository, userId: string, now: Date = NOW) {
  return new LiftAndLeanService({
    repository: repository.asViewer(userId),
    clock: { now: () => now },
    onAuditFailure: (error) => { throw error; },
  });
}

const meal = (overrides: Record<string, unknown> = {}) => ({
  name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2, ...overrides,
});

// ---------------------------------------------------------------- 基本

test('食事を記録するとJSTの当日で保存される', async () => {
  const { repository, service } = setup();
  const result = await service.logMeal(ALICE, meal());

  const rows = repository.rawRows('meals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, TODAY);
  assert.equal(rows[0].userId, ALICE);
  assert.equal(rows[0].origin, 'app');
  assert.equal(result.duplicated, false);
});

test('同じ clientRequestId の再送は重複しない（冪等）', async () => {
  const { repository, service } = setup();
  const first = await service.logMeal(ALICE, meal({ clientRequestId: 'req-1' }));
  const second = await service.logMeal(ALICE, meal({ clientRequestId: 'req-1' }));

  assert.equal(first.rowId, second.rowId);
  assert.equal(second.duplicated, true);
  assert.equal(repository.countOf('meals'), 1);
});

test('clientRequestId が無ければ同じ内容でも別の記録として残す（勝手に消さない）', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, meal());
  await service.logMeal(ALICE, meal());
  assert.equal(repository.countOf('meals'), 2);
});

test('bodyのuserIdは無視し、セッションで解決したユーザーを所有者にする', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, { ...meal(), userId: BOB, origin: 'migration', needsReview: true });

  const row = repository.rawRows('meals')[0];
  assert.equal(row.userId, ALICE);
  assert.equal(row.origin, 'app');
  assert.equal(row.needsReview, false);
  assert.equal(row.$permissions.includes(`read("user:${ALICE}")`), true);
  assert.equal(row.$permissions.some((p: string) => p.includes(BOB)), false);
});

test('体重は同じ日なら上書きする（1日1件）', async () => {
  const { repository, service } = setup();
  await service.logWeight(ALICE, { weight: 71.2 });
  await service.logWeight(ALICE, { weight: 70.8 });

  const rows = repository.rawRows('weights');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 70.8);
  assert.equal(rows[0].$id, deriveRowId(ALICE, 'weight', TODAY));
});

test('筋トレは日単位1件・種目とセットはぶら下がる', async () => {
  const { repository, service } = setup();
  const result = await service.logWorkout(ALICE, {
    clientRequestId: 'w-1',
    exercises: [
      { name: 'ベンチプレス', sets: [{ reps: 10, weight: 60 }, { reps: 8, weight: 65 }] },
      { name: 'スクワット', sets: [{ reps: 5, weight: 100 }] },
    ],
  });

  assert.equal(result.exercises, 2);
  assert.equal(result.sets, 3);
  assert.equal(repository.countOf('workouts'), 1);
  assert.equal(repository.countOf('workout_exercises'), 2);
  assert.equal(repository.countOf('workout_sets'), 3);

  const workout = await service.getWorkout(ALICE, TODAY);
  assert.equal(workout?.exercises.length, 2);
  assert.equal(workout?.exercises[0].name, 'ベンチプレス');
  assert.equal(workout?.exercises[0].sets.length, 2);
});

test('同じ筋トレの再送は種目もセットも増えない', async () => {
  const { repository, service } = setup();
  const payload = { clientRequestId: 'w-1', exercises: [{ name: 'ベンチプレス', sets: [{ reps: 10, weight: 60 }] }] };
  await service.logWorkout(ALICE, payload);
  await service.logWorkout(ALICE, payload);

  assert.equal(repository.countOf('workouts'), 1);
  assert.equal(repository.countOf('workout_exercises'), 1);
  assert.equal(repository.countOf('workout_sets'), 1);
});

// ---------------------------------------------------------------- 検証

test('未来の日付は拒否する', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.logMeal(ALICE, meal({ date: '2026-08-13' })),
    (error: any) => error.status === 400 && /未来/.test(error.message),
  );
});

test('31日より前の日付は拒否する', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.logMeal(ALICE, meal({ date: '2026-06-01' })),
    (error: any) => error.status === 400,
  );
});

test('範囲外の数値は保存せず400で返す（丸めない）', async () => {
  const { repository, service } = setup();
  await assert.rejects(() => service.logMeal(ALICE, meal({ calories: 99999 })), (e: any) => e.status === 400);
  await assert.rejects(() => service.logWeight(ALICE, { weight: 999 }), (e: any) => e.status === 400);
  assert.equal(repository.countOf('meals'), 0);
});

test('エラーの中身は利用者に見せてよい形になっている', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.logMeal(ALICE, { name: '', calories: 1, protein: 1, fat: 1, carbs: 1 }),
    (error: any) => error.code === 'validation_error' && Array.isArray(error.details),
  );
});

// ---------------------------------------------------------------- ユーザー分離

test('他人の記録は一覧に出ない', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, meal({ name: 'アリスの食事' }));

  const bob = asUser(repository, BOB);
  await bob.logMeal(BOB, meal({ name: 'ボブの食事' }));

  const aliceMeals = await service.listMeals(ALICE);
  const bobMeals = await bob.listMeals(BOB);

  assert.deepEqual(aliceMeals.map(m => m.name), ['アリスの食事']);
  assert.deepEqual(bobMeals.map(m => m.name), ['ボブの食事']);
});

test('他人のuserIdを指定しても、その人の行は読めない', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, meal({ name: 'アリスの食事' }));

  // ボブのセッションで「userId=alice」を指定して読もうとする
  const bobRepository = repository.asViewer(BOB);
  const leaked = await bobRepository.listRows('meals', ALICE, { equals: { userId: ALICE } });
  assert.deepEqual(leaked, []);
});

test('rowIdを知っていても他人の記録は更新・削除できない', async () => {
  const { repository, service } = setup();
  const { rowId } = await service.logMeal(ALICE, meal({ clientRequestId: 'req-1' }));

  // rowIdは決定的なので、userIdさえ分かれば第三者にも計算できる
  assert.equal(rowId, deriveRowId(ALICE, 'meal', 'req-1'));

  const bob = asUser(repository, BOB);
  await assert.rejects(() => bob.updateMeal(BOB, rowId, meal({ name: '書き換え' })), (e: any) => e.status === 404);
  await assert.rejects(() => bob.deleteMeal(BOB, rowId), (e: any) => e.status === 404);

  const rows = repository.rawRows('meals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '鶏むね');
});

test('他人の種目にセットを足せない', async () => {
  const { repository, service } = setup();
  await service.logWorkout(ALICE, { clientRequestId: 'w-1', exercises: [{ name: 'ベンチプレス', sets: [] }] });
  const exerciseId = repository.rawRows('workout_exercises')[0].$id;

  const bob = asUser(repository, BOB);
  await assert.rejects(() => bob.addSet(BOB, exerciseId, { reps: 10, weight: 60 }), (e: any) => e.status === 404);
  assert.equal(repository.countOf('workout_sets'), 0);
});

test('監査ログは本人にも読めない（サーバー専用）', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, meal());

  const visible = await repository.listRows('audit_log', ALICE, { equals: { userId: ALICE } });
  assert.deepEqual(visible, []);
  assert.equal(repository.countOf('audit_log') > 0, true);
});

// ---------------------------------------------------------------- rate limit

test('1日の書き込み上限を超えると429になる', async () => {
  const { repository, service } = setup();
  const rowId = deriveRowId(ALICE, 'rate', `write:${TODAY}`);
  await repository.putServerRow('rate_limits', rowId, {
    userId: ALICE, bucket: 'write', windowStart: TODAY, count: RATE_LIMITS.write,
  }, 'upsert');

  await assert.rejects(() => service.logMeal(ALICE, meal()), (error: any) => error.status === 429);
  assert.equal(repository.countOf('meals'), 0);
});

test('日付が変わると上限はリセットされる', async () => {
  const { repository, service } = setup();
  const rowId = deriveRowId(ALICE, 'rate', `write:${TODAY}`);
  await repository.putServerRow('rate_limits', rowId, {
    userId: ALICE, bucket: 'write', windowStart: TODAY, count: RATE_LIMITS.write,
  }, 'upsert');

  const tomorrow = new LiftAndLeanService({
    repository,
    clock: { now: () => new Date('2026-08-13T01:00:00Z') },
    onAuditFailure: () => {},
  });
  await tomorrow.logMeal(ALICE, meal());
  assert.equal(repository.countOf('meals'), 1);
});

// ---------------------------------------------------------------- 集計

test('その日のサマリを合計する', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, meal({ calories: 300, protein: 30, fat: 10, carbs: 20 }));
  await service.logMeal(ALICE, meal({ calories: 500, protein: 20, fat: 15, carbs: 60 }));
  await service.logWeight(ALICE, { weight: 70.5 });
  await service.saveGoals(ALICE, { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 68 });
  await service.logWorkout(ALICE, { clientRequestId: 'w-1', exercises: [{ name: 'ベンチ', sets: [{ reps: 10, weight: 60 }] }] });

  const summary = await service.getDaySummary(ALICE);
  assert.equal(summary.date, TODAY);
  assert.deepEqual(summary.totals, { calories: 800, protein: 50, fat: 25, carbs: 80 });
  assert.equal(summary.mealCount, 2);
  assert.equal(summary.weight, 70.5);
  assert.equal(summary.goals?.calories, 2200);
  assert.deepEqual(summary.workout, { exercises: 1, sets: 1 });
  assert.equal(repository.countOf('goals'), 1);
});

test('推移は欠けた日も日付の連続として返す', async () => {
  const { service } = setup();
  await service.logWeight(ALICE, { weight: 70 });
  const points = await service.getProgress(ALICE, 3);

  assert.deepEqual(points.map(p => p.date), ['2026-08-10', '2026-08-11', '2026-08-12']);
  assert.deepEqual(points.map(p => p.weight), [null, null, 70]);
});

test('サマリは他人の記録を混ぜない', async () => {
  const { repository, service } = setup();
  await service.logMeal(ALICE, meal({ calories: 300 }));
  const bob = asUser(repository, BOB);
  await bob.logMeal(BOB, meal({ calories: 1000 }));

  const summary = await service.getDaySummary(ALICE);
  assert.equal(summary.totals.calories, 300);
});
