/**
 * 音声で記録したものが、**手で入力したときと同じ経路**を通ることのテスト。
 *
 * 音声のときだけ別の保存経路を作ると、
 *   - 画面が通信を待つ（せっかくの local-first が効かない）
 *   - オフラインで消える
 *   - 送信待ちの数に出てこない
 * ということが起きる。ここでは
 *   発話 → Op → その場で画面へ反映 → 送信待ちに積む
 * が既存の仕組みそのままであることを固定する。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { workoutOps } from '../src/data/voiceOps.ts';
import { applyOp, enqueue, replay } from '../src/data/ops.ts';
import type { Op } from '../src/data/ops.ts';
import { emptyAppData } from '../src/data/types.ts';

const DATE = '2026-08-17';

/** 予測できる id（テストの比較用） */
function counter() {
  let n = 0;
  return () => `id-${++n}`;
}

test('音声の筋トレは、画面の操作と同じ Op になる', () => {
  const ops = workoutOps(emptyAppData(), DATE, [
    { name: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }] },
  ], counter());

  // 既存の送信経路が知っている種類しか使わない
  assert.deepEqual(ops.map(op => op.kind), ['addExercise', 'addSet', 'addSet']);
});

test('複数種目・自重と加重の混在が1回でまとまる', () => {
  const ops = workoutOps(emptyAppData(), DATE, [
    { name: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }] },
    { name: '懸垂', sets: [{ weight: 0, reps: 8 }, { weight: 0, reps: 7 }] },
  ], counter());

  const data = replay(emptyAppData(), ops);
  const day = data.workouts.find(workout => workout.date === DATE)!;

  assert.equal(day.exercises.length, 2);
  assert.equal(day.exercises[0].name, 'ベンチプレス');
  assert.deepEqual(day.exercises[1].sets.map(set => ({ weight: set.weight, reps: set.reps })), [
    { weight: 0, reps: 8 }, { weight: 0, reps: 7 },
  ]);
});

test('同じ日に同じ種目を言い直したら、種目は増やさずセットだけ足す', () => {
  const before = replay(emptyAppData(), workoutOps(emptyAppData(), DATE, [
    { name: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }] },
  ], counter()));

  const again = workoutOps(before, DATE, [
    { name: 'ベンチプレス', sets: [{ weight: 60, reps: 8 }] },
  ], counter());

  assert.deepEqual(again.map(op => op.kind), ['addSet'], '種目が二重に作られている');

  const after = replay(before, again);
  const day = after.workouts.find(workout => workout.date === DATE)!;
  assert.equal(day.exercises.length, 1);
  assert.equal(day.exercises[0].sets.length, 2);
});

test('その場で画面に出る（通信を待たない）', () => {
  const ops = workoutOps(emptyAppData(), DATE, [
    { name: 'ラットプルダウン', sets: [{ weight: 70, reps: 7 }, { weight: 65, reps: 7 }] },
  ], counter());

  // 送信は一切していないが、状態はもう出来上がっている
  const data = ops.reduce(applyOp, emptyAppData());
  const sets = data.workouts[0].exercises[0].sets;
  assert.equal(sets.length, 2);
  assert.equal(sets[1].weight, 65);
});

test('送信待ちに積める（既存の outbox にそのまま乗る）', () => {
  const ops = workoutOps(emptyAppData(), DATE, [
    { name: 'スクワット', sets: [{ weight: 100, reps: 5 }] },
  ], counter());

  let pending: Op[] = [];
  for (const op of ops) pending = enqueue(pending, op);

  assert.equal(pending.length, ops.length, '送信待ちに積まれていない');
  // 積み直しても同じ状態になる（再適用できる＝id を先に決めている）
  assert.deepEqual(replay(emptyAppData(), pending), replay(emptyAppData(), pending));
});

test('セットは種目より先に積まれない（順番が壊れていない）', () => {
  const ops = workoutOps(emptyAppData(), DATE, [
    { name: 'デッドリフト', sets: [{ weight: 120, reps: 3 }] },
  ], counter());

  const exerciseIndex = ops.findIndex(op => op.kind === 'addExercise');
  const setIndex = ops.findIndex(op => op.kind === 'addSet');
  assert.ok(exerciseIndex < setIndex, 'セットが種目より先に来ている');

  // 順番どおりなら、セットは種目にぶら下がる
  const data = replay(emptyAppData(), ops);
  assert.equal(data.workouts[0].exercises[0].sets.length, 1);
});
