/**
 * MCPの道具のテスト。
 *
 * ここで守りたいのは
 *   - 道具は既存のサービス層を呼ぶだけで、独自の業務ロジックを持たない
 *   - 通信の再送で二重登録しない／あとから同じ内容を記録したら別記録になる
 *   - 他人のデータが見えない
 *   - 内部ID・監査情報をChatGPTへ返さない
 *   - ChatGPTが出した栄養値をそのまま確定値にしない
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { LiftAndLeanService } from '../api/_core/service.ts';
import {
  TOOLS,
  deriveIdempotencyKey,
  getProgress,
  getRecentWorkouts,
  getTodaySummary,
  logMeal,
  logWeight,
  logWorkout,
  stableStringify,
} from '../api/_mcp/tools.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const ALICE = 'alice';
const BOB = 'bob';
const NOW = new Date('2026-08-13T01:00:00Z'); // JST 2026-08-13 10:00
const TODAY = '2026-08-13';

function setup() {
  const repository = new MemoryRepository(ALICE);
  const service = new LiftAndLeanService({
    repository, clock: { now: () => NOW }, onAuditFailure: () => {},
  });
  let clock = NOW.getTime();
  const ctx = { service, userId: ALICE, now: () => clock };
  return { repository, service, ctx, advance: (ms: number) => { clock += ms; } };
}

const mealArgs = (overrides: Record<string, unknown> = {}) => ({
  name: '鶏むね肉のサラダ', calories: 320, protein: 60, fat: 5, carbs: 2, ...overrides,
});

// ---------------------------------------------------------------- 公開する道具

test('公開する道具は6つだけで、危険な操作を含まない', () => {
  assert.deepEqual(TOOLS.map(t => t.name).sort(), [
    'get_progress', 'get_recent_workouts', 'get_today_summary',
    'log_meal', 'log_weight', 'log_workout',
  ]);

  const forbidden = ['delete', 'remove', 'account', 'admin', 'query', 'sql', 'key', 'secret', 'goal'];
  for (const tool of TOOLS) {
    for (const word of forbidden) {
      assert.equal(tool.name.includes(word), false, `${tool.name} に ${word} が含まれる`);
    }
  }
});

test('読み取り専用の道具には readOnlyHint が付き、追記は destructive ではない', () => {
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  for (const name of ['get_today_summary', 'get_recent_workouts', 'get_progress']) {
    assert.equal(byName.get(name)!.annotations.readOnlyHint, true, name);
  }
  for (const name of ['log_meal', 'log_weight', 'log_workout']) {
    const tool = byName.get(name)!;
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.equal(tool.annotations.destructiveHint, false, `${name} は追記であって破壊ではない`);
    assert.equal(tool.annotations.openWorldHint, false, `${name} は外部世界に触れない`);
  }
});

// ---------------------------------------------------------------- 書き込み

test('食事を記録できる', async () => {
  const { ctx, repository } = setup();
  const result = await logMeal(ctx, mealArgs());

  assert.match(result.text, /記録しました/);
  assert.equal(repository.countOf('meals'), 1);
  const row = repository.rawRows('meals')[0];
  assert.equal(row.name, '鶏むね肉のサラダ');
  assert.equal(row.date, TODAY);
});

test('ChatGPTが出した栄養値はそのまま確定値にしない', async () => {
  const { ctx, repository } = setup();
  await logMeal(ctx, mealArgs());

  const row = repository.rawRows('meals')[0];
  assert.equal(row.origin, 'chatgpt');
  assert.equal(row.sourceType, 'ai_estimate', '出どころ未指定なら推定として保存する');
  assert.equal(row.needsReview, true, 'あとで本人が確認できる印を付ける');
});

test('公式の成分表示だと分かっている場合は確認待ちにしない', async () => {
  const { ctx, repository } = setup();
  await logMeal(ctx, mealArgs({ sourceType: 'official', sourceLabel: '商品パッケージ' }));

  const row = repository.rawRows('meals')[0];
  assert.equal(row.sourceType, 'official');
  assert.equal(row.needsReview, false);
});

test('体重を記録でき、同じ日は上書きになる', async () => {
  const { ctx, repository } = setup();
  await logWeight(ctx, { weight: 71.2 });
  await logWeight(ctx, { weight: 70.8 });

  assert.equal(repository.countOf('weights'), 1);
  assert.equal(repository.rawRows('weights')[0].weight, 70.8);
});

test('複数種目を1回の呼び出しでまとめて記録できる', async () => {
  const { ctx, repository } = setup();
  const result = await logWorkout(ctx, {
    exercises: [
      { name: 'ラットプルダウン', sets: [{ reps: 10, weight: 50 }, { reps: 10, weight: 50 }, { reps: 10, weight: 50 }] },
      { name: 'シーテッドロー', sets: [{ reps: 12, weight: 40 }, { reps: 12, weight: 40 }, { reps: 12, weight: 40 }] },
    ],
  });

  assert.equal(repository.countOf('workouts'), 1, '1日1件にまとまる');
  assert.equal(repository.countOf('workout_exercises'), 2);
  assert.equal(repository.countOf('workout_sets'), 6);
  assert.match(result.text, /ラットプルダウン/);
  assert.equal(result.data.sets, 6);
});

// ---------------------------------------------------------------- 再送と重複

test('同じ引数の再送では二重登録しない', async () => {
  const { ctx, repository } = setup();
  const args = mealArgs();
  await logMeal(ctx, args);
  const retry = await logMeal(ctx, args);

  assert.equal(repository.countOf('meals'), 1);
  assert.equal(retry.data.alreadyRecorded, true);
  assert.match(retry.text, /すでに記録済み/);
});

test('引数の順序が違っても再送とみなす', async () => {
  const { ctx, repository } = setup();
  await logMeal(ctx, { name: 'x', calories: 100, protein: 1, fat: 1, carbs: 1 });
  await logMeal(ctx, { carbs: 1, fat: 1, protein: 1, calories: 100, name: 'x' });
  assert.equal(repository.countOf('meals'), 1);
});

test('時間をおいて同じ内容を記録したら別の記録になる', async () => {
  const { ctx, repository, advance } = setup();
  await logMeal(ctx, mealArgs());
  advance(10 * 60 * 1000); // 10分後にもう一度同じものを食べた
  await logMeal(ctx, mealArgs());

  assert.equal(repository.countOf('meals'), 2, '本人が意図して記録し直した分は別扱い');
});

test('呼び出し側が同じ clientRequestId を指定すれば必ず重複しない', async () => {
  const { ctx, repository, advance } = setup();
  await logMeal(ctx, mealArgs({ clientRequestId: 'chatgpt-call-1' }));
  advance(60 * 60 * 1000);
  const retry = await logMeal(ctx, mealArgs({ clientRequestId: 'chatgpt-call-1' }));

  assert.equal(repository.countOf('meals'), 1);
  assert.equal(retry.data.alreadyRecorded, true);
});

test('冪等キーは利用者ごとに異なる', () => {
  const args = mealArgs();
  const now = NOW.getTime();
  assert.notEqual(
    deriveIdempotencyKey(ALICE, 'log_meal', args, now),
    deriveIdempotencyKey(BOB, 'log_meal', args, now),
  );
  assert.notEqual(
    deriveIdempotencyKey(ALICE, 'log_meal', args, now),
    deriveIdempotencyKey(ALICE, 'log_weight', args, now),
  );
});

test('引数の並べ替えで同じ文字列になる', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

// ---------------------------------------------------------------- 読み取り

test('今日の記録を目標までの残りつきで返す', async () => {
  const { ctx, service } = setup();
  await service.saveGoals(ALICE, { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 68 });
  await logMeal(ctx, mealArgs({ calories: 500, protein: 40, fat: 10, carbs: 30 }));
  await logWeight(ctx, { weight: 70 });

  const result = await getTodaySummary(ctx, {});
  assert.match(result.text, /目標まで/);
  assert.equal((result.data.remaining as any).protein, 110);
  assert.equal(result.data.weight, 70);
});

test('最近の筋トレを重量つきで返す', async () => {
  const { ctx } = setup();
  await logWorkout(ctx, { exercises: [{ name: 'ベンチプレス', sets: [{ reps: 10, weight: 60 }] }] });

  const result = await getRecentWorkouts(ctx, {});
  assert.match(result.text, /ベンチプレス 60kg×10/);
});

test('推移は体重の変化と平均カロリーを返す', async () => {
  const { ctx, service } = setup();
  await service.logWeight(ALICE, { date: '2026-08-11', weight: 72 }, { channel: 'app' });
  await service.logWeight(ALICE, { date: TODAY, weight: 70.5 }, { channel: 'app' });
  await logMeal(ctx, mealArgs({ calories: 600 }));

  const result = await getProgress(ctx, { days: 7 });
  assert.equal((result.data.weight as any).changeKg, -1.5);
  assert.equal(result.data.averageCalories, 600);
});

test('記録が無くても落ちない', async () => {
  const { ctx } = setup();
  const summary = await getTodaySummary(ctx, {});
  const workouts = await getRecentWorkouts(ctx, {});
  const progress = await getProgress(ctx, {});

  assert.match(summary.text, /未記録/);
  assert.match(workouts.text, /まだありません/);
  assert.match(progress.text, /記録がありません/);
});

// ---------------------------------------------------------------- 分離と情報の出し方

test('他人のデータは読めない', async () => {
  const { repository, ctx } = setup();
  await logMeal(ctx, mealArgs({ name: 'アリスの食事', calories: 500 }));

  const bobService = new LiftAndLeanService({
    repository: repository.asViewer(BOB), clock: { now: () => NOW }, onAuditFailure: () => {},
  });
  const bobResult = await getTodaySummary({ service: bobService, userId: BOB }, {});

  assert.equal((bobResult.data.totals as any).calories, 0);
  assert.equal(bobResult.data.mealCount, 0);
});

test('内部IDや監査情報をChatGPTへ返さない', async () => {
  const { ctx } = setup();
  await logMeal(ctx, mealArgs());
  await logWeight(ctx, { weight: 70 });
  await logWorkout(ctx, { exercises: [{ name: 'ベンチ', sets: [{ reps: 5, weight: 50 }] }] });

  const results = [
    await getTodaySummary(ctx, {}),
    await getRecentWorkouts(ctx, {}),
    await getProgress(ctx, {}),
  ];

  for (const result of results) {
    const json = JSON.stringify(result);
    for (const leaked of ['$id', '$permissions', 'clientRequestId', 'userId', 'workoutId', 'exerciseId', 'needsReview', 'origin']) {
      assert.equal(json.includes(leaked), false, `${leaked} が返っている`);
    }
  }
});

test('未来の日付や範囲外の値はサービス層が拒否する', async () => {
  const { ctx } = setup();
  await assert.rejects(() => logMeal(ctx, mealArgs({ date: '2026-08-14' })), (e: any) => e.status === 400);
  await assert.rejects(() => logWeight(ctx, { weight: 999 }), (e: any) => e.status === 400);
});

test('ChatGPT経由では31日より前に遡って記録できない', async () => {
  const { ctx } = setup();
  await assert.rejects(() => logMeal(ctx, mealArgs({ date: '2026-06-01' })), (e: any) => e.status === 400);
});
