/**
 * 音声で記録するときの、**発話 → 操作** の部分のテスト。
 *
 * ここで固定したいのは、実機で実際に起きた次の失敗が二度と出ないこと:
 *
 *   「懸垂8回と7回」など自重種目を言うと
 *   `Invalid input: expected number, received undefined` が画面に出ていた。
 *
 * 守る条件:
 *   - 複数種目・自重と加重の混在・セットごとに違う重量/回数を1発話で扱える
 *   - 足りない値は**推測して保存しない**。足りない点だけ聞き返す
 *   - 内部（zod）の文言は**絶対に画面へ出さない**
 *   - 書き込みは画面側の local-first 経路へ渡す（サーバーはここで保存しない）
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { LiftAndLeanService } from '../api/_core/service.ts';
import { runCommand, buildPrompt } from '../api/_v1/command.ts';
import { normalizeWorkoutArgs, explainIssue, toNumber, isBodyweightExercise } from '../api/_v1/normalize.ts';
import { TOOLS } from '../api/_mcp/tools.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const ALICE = 'alice';
const NOW = new Date('2026-08-17T01:00:00Z'); // JST 2026-08-17 10:00
const TODAY = '2026-08-17';

function setup() {
  const repository = new MemoryRepository(ALICE);
  const service = new LiftAndLeanService({
    repository, clock: { now: () => NOW }, onAuditFailure: () => {},
  });
  return { repository, service, ctx: { service, userId: ALICE } };
}

function fakeParser(reply: unknown) {
  const calls: { text: string }[] = [];
  return {
    calls,
    parse: async (text: string) => { calls.push({ text }); return reply; },
    today: () => TODAY,
  };
}

/** 画面に出してよい文か。英語の内部文言が混ざっていたら落とす */
function assertNoInternalLeak(message: string) {
  for (const forbidden of ['Invalid input', 'expected', 'received', 'undefined', 'zod', 'ZodError', 'Error:']) {
    assert.equal(
      message.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `内部の文言が画面へ漏れている: ${message}`,
    );
  }
}

// ---------------------------------------------------------------- 正規化（再現した失敗そのもの）

test('自重種目で weight が無くても 0 として通る（懸垂8回と7回）', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{ name: '懸垂', sets: [{ reps: 8 }, { reps: 7 }] }],
  });

  assert.equal(result.outcome, 'ready');
  const exercises = (result as any).args.exercises;
  assert.deepEqual(exercises[0].sets, [{ weight: 0, reps: 8 }, { weight: 0, reps: 7 }]);
});

test('自重と加重が混ざっていても1発話で扱える', () => {
  const result = normalizeWorkoutArgs({
    exercises: [
      { name: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }] },
      { name: '腹筋', sets: [{ reps: 30 }, { reps: 30 }] },
    ],
  });

  assert.equal(result.outcome, 'ready');
  const exercises = (result as any).args.exercises;
  assert.equal(exercises.length, 2);
  assert.deepEqual(exercises[1].sets, [{ weight: 0, reps: 30 }, { weight: 0, reps: 30 }]);
});

test('セットごとに重量・回数が違っても展開できる', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{
      name: 'ラットプルダウン',
      sets: [{ weight: 70, reps: 7 }, { weight: 70, reps: 7 }, { weight: 65, reps: 7 }, { weight: 65, reps: 7 }],
    }],
  });

  assert.equal(result.outcome, 'ready');
  assert.equal((result as any).args.exercises[0].sets.length, 4);
});

test('「同じ内容を3セット」の省略形を展開する', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{ name: 'ベンチプレス', sets: [{ weight: 60, reps: 10, sets: 3 }] }],
  });

  assert.equal(result.outcome, 'ready');
  const sets = (result as any).args.exercises[0].sets;
  assert.equal(sets.length, 3);
  assert.deepEqual(sets[2], { weight: 60, reps: 10 });
});

test('セット数だけが数値で返ってきても展開する', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{ name: 'スクワット', weight: 100, reps: 5, sets: 5 }],
  });

  assert.equal(result.outcome, 'ready');
  assert.equal((result as any).args.exercises[0].sets.length, 5);
});

test('同じ種目で重量が省かれた続きのセットは、直前の重量を引き継ぐ', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{ name: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }, { reps: 8 }, { reps: 6 }] }],
  });

  assert.equal(result.outcome, 'ready');
  assert.deepEqual((result as any).args.exercises[0].sets, [
    { weight: 60, reps: 10 }, { weight: 60, reps: 8 }, { weight: 60, reps: 6 },
  ]);
});

test('回数が無いときは推測せず、その点だけ聞き返す', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{
      name: 'ラットプルダウン',
      sets: [{ weight: 70, reps: 7 }, { weight: 70, reps: 7 }, { weight: 65 }, { weight: 65 }],
    }],
  });

  assert.equal(result.outcome, 'ask');
  const clarify = (result as any).clarify as string;
  assert.match(clarify, /ラットプルダウン65kg/);
  assert.match(clarify, /何回/);
  assertNoInternalLeak(clarify);
});

test('加重種目で重量が分からないときは 0 にせず聞き返す', () => {
  const result = normalizeWorkoutArgs({
    exercises: [{ name: 'ラットプルダウン', sets: [{ reps: 7 }] }],
  });

  assert.equal(result.outcome, 'ask');
  assert.match((result as any).clarify, /ラットプルダウン.*何kg/);
});

test('種目が分からないときは、分かっている手がかりを添えて聞き返す', () => {
  const result = normalizeWorkoutArgs({ exercises: [{ sets: [{ weight: 60, reps: 10 }] }] });

  assert.equal(result.outcome, 'ask');
  assert.equal((result as any).clarify, '60kgはどの種目ですか？');
});

test('文字列の数値・全角も読める', () => {
  assert.equal(toNumber('70kg'), 70);
  assert.equal(toNumber('７回'), 7);
  assert.equal(toNumber('72.4'), 72.4);
  assert.equal(toNumber('たくさん'), undefined);
  assert.equal(isBodyweightExercise('懸垂'), true);
  assert.equal(isBodyweightExercise('ラットプルダウン'), false);
});

// ---------------------------------------------------------------- 内部文言を出さない

test('検証の指摘は日本語へ言い換えられる（英語を出さない）', () => {
  const cases = [
    ['log_workout', { code: 'invalid_type', path: ['exercises', 0, 'sets', 1, 'reps'] }],
    ['log_workout', { code: 'too_big', path: ['exercises', 0, 'sets', 0, 'weight'] }],
    ['log_weight', { code: 'invalid_type', path: ['weight'] }],
    ['log_meal', { code: 'invalid_type', path: ['calories'] }],
    ['get_today_summary', { code: 'invalid_type', path: ['date'] }],
  ] as const;

  for (const [intent, issue] of cases) {
    const message = explainIssue(intent, issue as any);
    assert.ok(message.length > 0);
    assertNoInternalLeak(message);
  }
});

test('schema を外れた値でも、画面へ出るのは日本語の聞き返しだけ', async () => {
  const { ctx, service } = setup();
  // 重量 999kg は schema の範囲外（LIMITS.liftWeight.max = 500）
  const deps = fakeParser({
    intent: 'log_workout',
    args: { exercises: [{ name: 'ベンチプレス', sets: [{ weight: 999, reps: 10 }] }] },
  });

  const result = await runCommand(ctx, deps, { text: 'ベンチ999キロ10回' });

  assert.equal(result.status, 'clarify');
  assertNoInternalLeak(result.message);
  assert.equal((await service.getRecentWorkouts(ALICE)).length, 0, '範囲外の値が保存されている');
});

test('言語モデルが出鱈目な形を返しても内部文言は漏れない', async () => {
  const { ctx } = setup();
  const shapes = [
    { intent: 'log_workout', args: { exercises: 'ベンチ' } },
    { intent: 'log_workout', args: {} },
    { intent: 'log_meal', args: { name: '牛丼' } },
    { intent: 'log_weight', args: {} },
  ];

  for (const reply of shapes) {
    const result = await runCommand(ctx, fakeParser(reply), { text: 'なにか' });
    assert.equal(result.status, 'clarify', JSON.stringify(reply));
    assertNoInternalLeak(result.message);
  }
});

// ---------------------------------------------------------------- 足りなければ保存しない

test('足りない発話では1件も保存しない', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({
    intent: 'log_workout',
    args: { exercises: [{ name: 'ラットプルダウン', sets: [{ weight: 65 }] }] },
  });

  const result = await runCommand(ctx, deps, { text: 'ラットプル65キロ' }, );

  assert.equal(result.status, 'clarify');
  assert.match(result.message, /何回/);
  assert.equal((await service.getRecentWorkouts(ALICE)).length, 0, '推測して保存している');
});

// ---------------------------------------------------------------- 画面側で保存する（local-first）

test('体重：サーバーは保存せず、画面が保存する内容を返す', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 72.4 } });

  const result = await runCommand(ctx, deps, { text: '体重72.4キロ', apply: 'client' });

  assert.equal(result.status, 'plan');
  assert.deepEqual(result.plan, { kind: 'weight', date: TODAY, weight: 72.4 });
  assert.equal((await service.listWeights(ALICE)).length, 0, 'サーバーが先に書いてしまっている');
});

test('筋トレ：複数種目をまとめて画面へ渡す', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({
    intent: 'log_workout',
    args: {
      exercises: [
        { name: 'ベンチプレス', sets: [{ weight: 60, reps: 10, sets: 3 }] },
        { name: '懸垂', sets: [{ reps: 8 }, { reps: 7 }] },
        { name: 'ラットプルダウン', sets: [{ weight: 70, reps: 7 }, { weight: 70, reps: 7 }, { weight: 65, reps: 7 }, { weight: 65, reps: 7 }] },
      ],
    },
  });

  const result = await runCommand(ctx, deps, {
    text: 'ベンチ60キロ10回3セット、懸垂8回と7回、ラットプル70キロ7回2セット65キロ7回2セット',
    apply: 'client',
  });

  assert.equal(result.status, 'plan');
  const plan = result.plan as any;
  assert.equal(plan.kind, 'workout');
  assert.equal(plan.exercises.length, 3);
  assert.equal(plan.exercises[1].sets[0].weight, 0, '自重が0になっていない');
  assert.equal(plan.exercises.reduce((n: number, e: any) => n + e.sets.length, 0), 9);
  assert.match(result.message, /3種目 \/ 9セット/);
  assert.equal((await service.getRecentWorkouts(ALICE)).length, 0, 'サーバーが先に書いてしまっている');
});

test('食事：栄養の値を添えて画面へ渡す', async () => {
  const { ctx } = setup();
  const deps = fakeParser({
    intent: 'log_meal',
    args: { name: '牛丼 並', calories: 635, protein: 20, fat: 20, carbs: 90, sourceType: 'ai_estimate' },
  });

  const result = await runCommand(ctx, deps, { text: '昼に牛丼並', apply: 'client' });

  assert.equal(result.status, 'plan');
  const plan = result.plan as any;
  assert.equal(plan.kind, 'meal');
  assert.equal(plan.meal.calories, 635);
  assert.equal(plan.meal.sourceType, 'ai_estimate');
  assert.equal(plan.date, TODAY);
});

test('読み取りの指示は今までどおりサーバーが答える', async () => {
  const { ctx, service } = setup();
  await service.logMeal(ALICE, { name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2 }, { channel: 'app' });

  const deps = fakeParser({ intent: 'get_today_summary', args: {} });
  const result = await runCommand(ctx, deps, { text: '今日タンパク質あと何グラム？', apply: 'client' });

  assert.equal(result.status, 'done');
  assert.equal(result.plan, undefined);
  assert.match(result.message, /320|60/);
});

test('apply を付けなければ今までどおりサーバーが保存する（ChatGPT経由・古い画面）', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 72.4 } });

  const result = await runCommand(ctx, deps, { text: '体重72.4キロ' });

  assert.equal(result.status, 'done');
  assert.equal((await service.listWeights(ALICE))[0].weight, 72.4);
});

// ---------------------------------------------------------------- 指示文

test('指示文に、実機で失敗した言い回しの決まりが入っている', () => {
  const prompt = buildPrompt(TODAY, TOOLS);
  assert.match(prompt, /自重/, '自重種目の決まりが無い');
  assert.match(prompt, /複数の種目/, '複数種目の決まりが無い');
  assert.match(prompt, /セットごとに/, 'セットごとの違いの決まりが無い');
});
