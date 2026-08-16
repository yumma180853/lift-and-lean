/**
 * 音声・文字の指示を操作へ振り分けるところのテスト。
 *
 * ここで守りたいのは
 *   - 振り分け先は MCP と同じ道具・同じ入力schema（二重管理しない）
 *   - **推測すると間違えるときは実行せず聞き返す**
 *   - 消す・設定を変える指示は受け付けない
 *   - 言語モデルが出鱈目を返しても、schema で止まる
 *   - 言語モデルの呼び出しは1つの指示につき1回だけ
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { LiftAndLeanService } from '../api/_core/service.ts';
import { runCommand, buildPrompt, normalizeParsed } from '../api/_v1/command.ts';
import { TOOLS } from '../api/_mcp/tools.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const ALICE = 'alice';
const NOW = new Date('2026-08-13T01:00:00Z'); // JST 2026-08-13 10:00
const TODAY = '2026-08-13';

function setup() {
  const repository = new MemoryRepository(ALICE);
  const service = new LiftAndLeanService({
    repository, clock: { now: () => NOW }, onAuditFailure: () => {},
  });
  return { repository, service, ctx: { service, userId: ALICE } };
}

/** 言語モデルの代わり。何回呼ばれたかも数える */
function fakeParser(reply: unknown) {
  const calls: { text: string }[] = [];
  return {
    calls,
    parse: async (text: string) => { calls.push({ text }); return reply; },
    today: () => TODAY,
  };
}

// ---------------------------------------------------------------- 記録

test('「体重72.4キロ」で体重が記録される', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 72.4 } });

  const result = await runCommand(ctx, deps, { text: '体重72.4キロ' });

  assert.equal(result.status, 'done');
  assert.equal(result.intent, 'log_weight');
  assert.equal(deps.calls.length, 1, '言語モデルを2回以上呼んでいる');

  const weights = await service.listWeights(ALICE);
  assert.equal(weights.length, 1);
  assert.equal(weights[0].weight, 72.4);
});

test('「ベンチ60キロ10回3セット」で3セット記録される', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({
    intent: 'log_workout',
    args: {
      exercises: [{
        name: 'ベンチプレス',
        sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }, { weight: 60, reps: 10 }],
      }],
    },
  });

  const result = await runCommand(ctx, deps, { text: 'ベンチ60キロ10回3セット' });

  assert.equal(result.status, 'done');
  assert.equal(result.data?.sets, 3);

  const workouts = await service.getRecentWorkouts(ALICE);
  assert.equal(workouts[0].exercises[0].name, 'ベンチプレス');
  assert.equal(workouts[0].exercises[0].sets.length, 3);
});

test('食事は取り消せるように rowId を返す', async () => {
  const { ctx } = setup();
  const deps = fakeParser({
    intent: 'log_meal',
    args: { name: '牛丼 並', calories: 635, protein: 20, fat: 20, carbs: 90, sourceType: 'ai_estimate' },
  });

  const result = await runCommand(ctx, deps, { text: '昼に牛丼並' });

  assert.equal(result.status, 'done');
  assert.equal(result.undo?.kind, 'meal');
  assert.ok(result.undo?.rowId, '取り消しに使うidが無い');
});

test('聞き取った内容をそのまま返す（取り違えに気づけるように）', async () => {
  const { ctx } = setup();
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 72.4 } });
  const result = await runCommand(ctx, deps, { text: '体重72.4キロ' });
  assert.equal(result.transcript, '体重72.4キロ');
});

// ---------------------------------------------------------------- 読み取り

test('「今日タンパク質あと何g？」で今日の記録を返す', async () => {
  const { ctx, service } = setup();
  await service.logMeal(ALICE, { name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2 }, { channel: 'app' });

  const deps = fakeParser({ intent: 'get_today_summary', args: {} });
  const result = await runCommand(ctx, deps, { text: '今日タンパク質あと何g？' });

  assert.equal(result.status, 'done');
  assert.match(result.message, /320|60/);
});

// ---------------------------------------------------------------- 聞き返す

test('種目が分からないときは記録せずに聞き返す', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({ intent: 'clarify', clarify: '種目は何ですか？' });

  const result = await runCommand(ctx, deps, { text: '60キロ10回' });

  assert.equal(result.status, 'clarify');
  assert.equal(result.message, '種目は何ですか？');
  assert.equal((await service.getRecentWorkouts(ALICE)).length, 0, '推測して記録してしまっている');
});

test('clarify が入っていれば intent があっても実行しない', async () => {
  const { ctx, service } = setup();
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 72 }, clarify: '体重で合っていますか？' });

  const result = await runCommand(ctx, deps, { text: '72' });

  assert.equal(result.status, 'clarify');
  assert.equal((await service.listWeights(ALICE)).length, 0);
});

// ---------------------------------------------------------------- 受け付けない

test('消す指示は受け付けない', async () => {
  const { ctx } = setup();
  const deps = fakeParser({ intent: 'unsupported' });

  const result = await runCommand(ctx, deps, { text: '今日の食事を全部削除して' });

  assert.equal(result.status, 'unsupported');
});

test('削除の道具はそもそも存在しない', () => {
  const names = TOOLS.map(t => t.name);
  for (const forbidden of ['delete_meal', 'delete_workout', 'set_goals', 'delete_weight']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} が公開されている`);
  }
  assert.equal(TOOLS.every(t => t.annotations.destructiveHint === false), true);
});

// ---------------------------------------------------------------- 出鱈目に耐える

test('知らない intent は聞き返しにする', async () => {
  const { ctx } = setup();
  const deps = fakeParser({ intent: 'make_coffee', args: {} });
  const result = await runCommand(ctx, deps, { text: 'コーヒーいれて' });
  assert.equal(result.status, 'clarify');
});

test('引数が schema に合わなければ実行しない', async () => {
  const { ctx, service } = setup();
  // 体重 999kg は schema の範囲外
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 999 } });

  const result = await runCommand(ctx, deps, { text: '体重999キロ' });

  assert.equal(result.status, 'clarify');
  assert.equal((await service.listWeights(ALICE)).length, 0, '範囲外の値が保存されている');
});

test('言語モデルが JSON を返さなくても落ちない', async () => {
  const { ctx } = setup();
  const deps = fakeParser(null);
  const result = await runCommand(ctx, deps, { text: 'ばー' });
  assert.equal(result.status, 'clarify');
});

test('空文字や長すぎる指示は断る', async () => {
  const { ctx } = setup();
  const deps = fakeParser({ intent: 'log_weight', args: { weight: 70 } });

  await assert.rejects(() => runCommand(ctx, deps, { text: '' }));
  await assert.rejects(() => runCommand(ctx, deps, { text: 'あ'.repeat(400) }));
});

// ---------------------------------------------------------------- 指示文

test('指示文には道具の説明が入っていて、二重管理していない', () => {
  const prompt = buildPrompt(TODAY, TOOLS);
  for (const tool of TOOLS) {
    assert.ok(prompt.includes(tool.name), `${tool.name} が指示文に無い`);
  }
  // 説明は tools.ts の .describe() を使う（ここで書き直さない）
  assert.ok(prompt.includes('体重(kg)'), 'schema の説明が使われていない');
  assert.ok(prompt.includes(TODAY), '今日の日付が渡っていない');
});

test('冪等キーは言語モデルに決めさせない', () => {
  const prompt = buildPrompt(TODAY, TOOLS);
  assert.equal(prompt.includes('clientRequestId'), false);
});

test('壊れた応答は聞き返しに正規化される', () => {
  assert.equal(normalizeParsed(undefined).intent, 'clarify');
  assert.equal(normalizeParsed({ nope: 1 }).intent, 'clarify');
  assert.equal(normalizeParsed({ intent: 'log_weight' }).intent, 'log_weight');
});
