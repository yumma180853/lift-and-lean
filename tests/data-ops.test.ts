/**
 * 端末が先・通信はあとの土台を固定する。
 *
 * ここが崩れると「記録したのに無い」「入力が巻き戻る」「二重に登録される」
 * のどれかが起きる。壊れやすいのは次の4つ:
 *
 *   - 同じ操作を何度重ねても結果が変わらないこと（再適用できること）
 *   - 新しいスナップショットが来ても、未送信の操作が消えないこと
 *   - 連続入力を1件にまとめても、最後の値が正しく残ること
 *   - 送信が通って id が変わったとき、後続の操作が迷子にならないこと
 */

import assert from 'node:assert/strict';
import test from 'node:test';

/** localStorage の最小限の代用 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
}

const storage = new MemoryStorage();
(globalThis as any).localStorage = storage;

const { applyOp, replay, enqueue, remapOp, remapData } = await import('../src/data/ops.ts');
type Op = import('../src/data/ops.ts').Op;
const { emptyAppData } = await import('../src/data/types.ts');
const outbox = await import('../src/data/outbox.ts');

/**
 * 別タブぶんの実体を読み込む。
 * 同じモジュールでも URL が違えば別インスタンスになるので、TAB_ID が別になる。
 * （指定子を変数にしているのは、型検査に実在しないパスを解決させないため）
 */
const openAnotherTab = (tag: string): Promise<typeof outbox> => {
  const specifier = `../src/data/outbox.ts?${tag}`;
  return import(specifier) as Promise<typeof outbox>;
};

const TODAY = '2026-08-17';
const meal = { name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2 };

/** 種目1つ・セット1つを持った状態 */
function withOneSet() {
  let data = emptyAppData();
  data = applyOp(data, { kind: 'addExercise', exerciseId: 'ex-1', workoutId: `day:${TODAY}`, date: TODAY, name: 'ベンチプレス' });
  data = applyOp(data, { kind: 'addSet', setId: 'set-1', exerciseId: 'ex-1', weight: 60, reps: 10 });
  return data;
}

// ---------------------------------------------------------------- 再適用できること

test('同じ操作を2回重ねても増えない（再適用しても壊れない）', () => {
  const op: Op = { kind: 'addMeal', mealId: 'm-1', date: TODAY, meal };
  const once = applyOp(emptyAppData(), op);
  const twice = applyOp(once, op);
  assert.equal(once.meals.length, 1);
  assert.deepEqual(twice.meals, once.meals);
});

test('種目とセットも二重に増えない', () => {
  const data = withOneSet();
  const again = applyOp(
    applyOp(data, { kind: 'addExercise', exerciseId: 'ex-1', workoutId: `day:${TODAY}`, date: TODAY, name: 'ベンチプレス' }),
    { kind: 'addSet', setId: 'set-1', exerciseId: 'ex-1', weight: 60, reps: 10 },
  );
  assert.equal(again.workouts[0].exercises.length, 1);
  assert.equal(again.workouts[0].exercises[0].sets.length, 1);
});

test('対象が無い操作は例外を投げずに素通りする（画面を落とさない）', () => {
  const data = emptyAppData();
  assert.doesNotThrow(() => applyOp(data, { kind: 'updateMeal', mealId: '無い', patch: { calories: 1 } }));
  assert.doesNotThrow(() => applyOp(data, { kind: 'updateSet', setId: '無い', weight: 1, reps: 1 }));
  assert.deepEqual(applyOp(data, { kind: 'deleteMeal', mealId: '無い' }), data);
});

// ---------------------------------------------------------------- 未送信が消えないこと

test('新しいスナップショットが来ても、未送信の操作は画面に残る', () => {
  const pending: Op[] = [{ kind: 'addMeal', mealId: 'local-1', date: TODAY, meal }];

  // サーバーから来た、まだこの食事を知らない状態
  const serverSnapshot = emptyAppData();
  const shown = replay(serverSnapshot, pending);

  assert.equal(shown.meals.length, 1, '未送信の食事が消えている');
  assert.equal(shown.meals[0].id, 'local-1');
});

test('古いスナップショットが新しい入力を上書きしない', () => {
  // サーバーは目標 2400 のまま。手元では 1850 に変えた直後
  const server = { ...emptyAppData(), goals: { ...emptyAppData().goals, calories: 2400 } };
  const pending: Op[] = [{ kind: 'saveGoals', goals: { ...emptyAppData().goals, calories: 1850 } }];

  assert.equal(replay(server, pending).goals.calories, 1850);
});

// ---------------------------------------------------------------- まとめ書き

test('連続入力は1件にまとまり、最後の値が残る', () => {
  let queue: Op[] = [];
  for (const calories of [1, 18, 185, 1850]) {
    queue = enqueue(queue, { kind: 'saveGoals', goals: { ...emptyAppData().goals, calories } });
  }
  assert.equal(queue.length, 1, '打鍵のたびに送る形になっている');
  assert.equal((queue[0] as any).goals.calories, 1850);
});

test('同じセットへの連続変更は1件にまとまる', () => {
  let queue: Op[] = [];
  for (const weight of [60, 62.5, 65, 67.5, 70]) {
    queue = enqueue(queue, { kind: 'updateSet', setId: 'set-1', weight, reps: 10 });
  }
  assert.equal(queue.length, 1);
  assert.equal((queue[0] as any).weight, 70);
});

test('別のセットへの変更はまとめない', () => {
  let queue: Op[] = [];
  queue = enqueue(queue, { kind: 'updateSet', setId: 'set-1', weight: 60, reps: 10 });
  queue = enqueue(queue, { kind: 'updateSet', setId: 'set-2', weight: 40, reps: 12 });
  assert.equal(queue.length, 2);
});

test('プロフィールの部分更新はまとめても項目が消えない', () => {
  let queue: Op[] = [];
  queue = enqueue(queue, { kind: 'saveProfile', patch: { longestStreak: 3 } });
  queue = enqueue(queue, { kind: 'saveProfile', patch: { hiddenWorkoutDates: ['2026-08-01'] } });
  assert.equal(queue.length, 1);
  assert.deepEqual((queue[0] as any).patch, { longestStreak: 3, hiddenWorkoutDates: ['2026-08-01'] });
});

test('送信中の先頭は書き換えない（サーバーと食い違わせない）', () => {
  const inFlight: Op[] = [{ kind: 'saveGoals', goals: { ...emptyAppData().goals, calories: 1000 } }];
  const next = enqueue(inFlight, { kind: 'saveGoals', goals: { ...emptyAppData().goals, calories: 2000 } }, 1);
  assert.equal(next.length, 2, '送信中のものを差し替えてしまっている');
  assert.equal((next[0] as any).goals.calories, 1000);
});

// ---------------------------------------------------------------- id の張り替え

test('仮の種目idが本物になったら、後続のセット操作も張り替わる', () => {
  const op: Op = { kind: 'addSet', setId: 'set-tmp', exerciseId: 'ex-tmp', weight: 60, reps: 10 };
  const swapped = remapOp(op, { 'ex-tmp': 'srv-ex-9' });
  assert.equal((swapped as any).exerciseId, 'srv-ex-9');
});

test('画面の状態の中の仮idも本物に置き換わる', () => {
  let data = emptyAppData();
  data = applyOp(data, { kind: 'addExercise', exerciseId: 'ex-tmp', workoutId: `day:${TODAY}`, date: TODAY, name: 'ベンチプレス' });
  data = applyOp(data, { kind: 'addSet', setId: 'set-tmp', exerciseId: 'ex-tmp', weight: 60, reps: 10 });

  const fixed = remapData(data, { 'ex-tmp': 'srv-ex-9', 'set-tmp': 'srv-set-9' });
  assert.equal(fixed.workouts[0].exercises[0].id, 'srv-ex-9');
  assert.equal(fixed.workouts[0].exercises[0].sets[0].id, 'srv-set-9');
});

test('オフラインで「種目を足す→セットを足す」をしても、順に送れば繋がる', () => {
  // 種目の送信が通って id が確定した、という想定
  const idMap = { 'ex-tmp': 'srv-ex-1' };
  const rest: Op[] = [{ kind: 'addSet', setId: 'set-tmp', exerciseId: 'ex-tmp', weight: 60, reps: 10 }];
  const remapped = rest.map(op => remapOp(op, idMap));

  // 本物の id を持つ状態に対して適用できる
  let server = emptyAppData();
  server = applyOp(server, { kind: 'addExercise', exerciseId: 'srv-ex-1', workoutId: `day:${TODAY}`, date: TODAY, name: 'ベンチプレス' });
  const after = replay(server, remapped);
  assert.equal(after.workouts[0].exercises[0].sets.length, 1, 'セットが迷子になっている');
});

// ---------------------------------------------------------------- 端末に残すもの

test('別のアカウントの送信待ちは読み込まない', () => {
  storage.clear();
  outbox.writeOutbox({ userId: 'userA', ops: [{ kind: 'deleteMeal', mealId: 'm-1' }], idMap: {}, failed: [] });

  assert.equal(outbox.readOutbox('userA').ops.length, 1);
  assert.equal(outbox.readOutbox('userB').ops.length, 0, '他人の送信待ちを送ろうとしている');
});

test('別のアカウントの控えは表示に使わない', () => {
  storage.clear();
  const data = applyOp(emptyAppData(), { kind: 'addMeal', mealId: 'm-1', date: TODAY, meal });
  outbox.writeBase('userA', data);

  assert.equal(outbox.readBase('userA')?.meals.length, 1);
  assert.equal(outbox.readBase('userB'), null, '他人の控えが見えている');
});

test('ログアウトで消える未送信の件数が分かる', () => {
  storage.clear();
  assert.equal(outbox.storedPendingCount(), 0);

  outbox.writeOutbox({
    userId: 'userA',
    ops: [{ kind: 'deleteMeal', mealId: 'm-1' }],
    idMap: {},
    failed: [{ op: { kind: 'deleteMeal', mealId: 'm-2' }, error: 'だめでした' }],
  });
  assert.equal(outbox.storedPendingCount(), 2, '送信待ちと諦めたぶんの両方を数える');
});

test('ログアウトで端末の控えと送信待ちを消す', () => {
  storage.clear();
  outbox.writeBase('userA', emptyAppData());
  outbox.writeOutbox({ userId: 'userA', ops: [{ kind: 'deleteMeal', mealId: 'm-1' }], idMap: {}, failed: [] });

  outbox.clearStored();
  assert.equal(outbox.readBase('userA'), null);
  assert.equal(outbox.readOutbox('userA').ops.length, 0);
});

// ---------------------------------------------------------------- 複数タブ

test('送信権は1つのタブしか取れない', async () => {
  storage.clear();
  assert.equal(outbox.acquireLease(), true);

  const otherTab = await openAnotherTab('tab=2');
  assert.notEqual(otherTab.TAB_ID, outbox.TAB_ID);
  assert.equal(otherTab.acquireLease(), false, '2つのタブが同時に送ろうとしている');

  // 手放せば別のタブが取れる
  outbox.releaseLease();
  assert.equal(otherTab.acquireLease(), true);
});

test('持ち主のタブが落ちても、期限が切れれば引き取れる', async () => {
  storage.clear();
  const otherTab = await openAnotherTab('tab=3');

  // 別タブが取ったまま落ちた（＝解放されない）
  assert.equal(otherTab.acquireLease(), true);
  assert.equal(outbox.acquireLease(), false);

  // 期限（15秒）を過ぎた時刻から見れば取れる
  assert.equal(outbox.acquireLease(Date.now() + 20_000), true);
});
