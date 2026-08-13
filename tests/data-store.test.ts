/**
 * 保存先の切り替えで壊れやすいところを固定する。
 *
 * - 未ログイン時は移行前と同じ形で端末に保存される（キーも中身も変えない）
 * - クラウドが正本のときは端末の記録キーに**書かない**（どちらが新しいか分からなくしない）
 * - 保存に失敗したら状態を変えない（保存できていないものを保存済みに見せない）
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
  keys() { return [...this.map.keys()]; }
}

const storage = new MemoryStorage();
(globalThis as any).localStorage = storage;

const { localStore, loadLocalData, LOCAL_KEYS } = await import('../src/data/localStore.ts');
const { cloudStore } = await import('../src/data/cloudStore.ts');
const { emptyAppData } = await import('../src/data/types.ts');
const { dataApi } = await import('../src/utils/api.ts');

const TODAY = '2026-08-13';
const meal = { name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2 };

// ---------------------------------------------------------------- 端末に保存（未ログイン）

test('端末に保存するときのキーは移行前と同じ', async () => {
  storage.clear();
  let data = emptyAppData();
  data = await localStore.addMeal(data, TODAY, meal);

  assert.deepEqual(
    storage.keys().sort(),
    Object.values(LOCAL_KEYS).sort(),
    '書き出すキーは従来どおり',
  );
  const stored = JSON.parse(storage.getItem('meals')!);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, '鶏むね');
  assert.equal(stored[0].date, TODAY);
});

test('端末に保存したものを読み戻せる', async () => {
  storage.clear();
  let data = emptyAppData();
  data = await localStore.addMeal(data, TODAY, meal);
  data = await localStore.saveWeight(data, TODAY, 70.5);
  data = await localStore.addExercise(data, TODAY, 'ベンチプレス', '胸');
  const exerciseId = data.workouts[0].exercises[0].id;
  data = await localStore.addSet(data, exerciseId, 60, 10);

  const reloaded = loadLocalData();
  assert.equal(reloaded.meals.length, 1);
  assert.equal(reloaded.weights[0].weight, 70.5);
  assert.equal(reloaded.workouts[0].exercises[0].sets[0].reps, 10);
  assert.deepEqual(reloaded.customExerciseCategories, { 'ベンチプレス': '胸' });
});

test('同じ日の体重は上書きする（元からの挙動）', async () => {
  storage.clear();
  let data = emptyAppData();
  data = await localStore.saveWeight(data, TODAY, 71);
  data = await localStore.saveWeight(data, TODAY, 70.2);
  assert.equal(data.weights.length, 1);
  assert.equal(data.weights[0].weight, 70.2);
});

// ---------------------------------------------------------------- クラウドが正本

/** dataApi を差し替えて、呼び出しだけを記録する */
function stubApi(overrides: Record<string, (...args: any[]) => Promise<any>> = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const original: Record<string, any> = {};
  const defaults: Record<string, (...args: any[]) => Promise<any>> = {
    addMeal: async () => ({ rowId: 'meal-1' }),
    updateMeal: async () => ({ ok: true }),
    deleteMeal: async () => ({ ok: true }),
    saveWeight: async () => ({ rowId: 'weight-1' }),
    addExercise: async () => ({ rowId: 'exercise-1' }),
    deleteExercise: async () => ({ ok: true }),
    addSet: async () => ({ rowId: 'set-1' }),
    updateSet: async () => ({ ok: true }),
    deleteSet: async () => ({ ok: true }),
    saveGoals: async () => ({ ok: true }),
    saveProfile: async () => ({ ok: true }),
    snapshot: async () => ({ meals: [], weights: [], workouts: [], goals: null, profile: null, today: TODAY }),
  };
  for (const [name, fn] of Object.entries({ ...defaults, ...overrides })) {
    original[name] = (dataApi as any)[name];
    (dataApi as any)[name] = async (...args: any[]) => {
      calls.push({ method: name, args });
      return fn(...args);
    };
  }
  const restore = () => {
    for (const [name, fn] of Object.entries(original)) (dataApi as any)[name] = fn;
  };
  return { calls, restore };
}

test('クラウドが正本のときは端末の記録キーに書かない', async () => {
  storage.clear();
  const { restore } = stubApi();
  try {
    let data = emptyAppData();
    data = await cloudStore.addMeal(data, TODAY, meal);
    data = await cloudStore.saveWeight(data, TODAY, 70);
    data = await cloudStore.saveGoals(data, data.goals);
  } finally {
    restore();
  }

  for (const key of Object.values(LOCAL_KEYS)) {
    assert.equal(storage.getItem(key), null, `${key} に書き込んでいない`);
  }
});

test('サーバーが返したidを使う（端末側でidを作らない）', async () => {
  const { restore } = stubApi();
  try {
    let data = emptyAppData();
    data = await cloudStore.addMeal(data, TODAY, meal);
    assert.equal(data.meals[0].id, 'meal-1');

    data = await cloudStore.addExercise(data, TODAY, 'ベンチプレス');
    assert.equal(data.workouts[0].exercises[0].id, 'exercise-1');

    data = await cloudStore.addSet(data, 'exercise-1', 60, 10);
    assert.equal(data.workouts[0].exercises[0].sets[0].id, 'set-1');
  } finally {
    restore();
  }
});

test('保存に失敗したら状態を変えない', async () => {
  const { restore } = stubApi({
    addMeal: async () => { throw new Error('ネットワークに繋がりません'); },
  });
  try {
    const data = emptyAppData();
    await assert.rejects(() => cloudStore.addMeal(data, TODAY, meal));
    assert.deepEqual(data.meals, [], '呼び出し元の状態はそのまま');
  } finally {
    restore();
  }
});

test('食事の部分更新でも全項目を送る（サーバーが全項目を検証するため）', async () => {
  const { calls, restore } = stubApi();
  try {
    let data = emptyAppData();
    data = await cloudStore.addMeal(data, TODAY, meal);
    await cloudStore.updateMeal(data, 'meal-1', { name: '鶏むね（大盛り）' });
  } finally {
    restore();
  }

  const update = calls.find(c => c.method === 'updateMeal')!;
  const payload = update.args[1];
  assert.equal(payload.name, '鶏むね（大盛り）');
  assert.equal(payload.calories, 320, '触っていない項目も送る');
  assert.equal(payload.date, TODAY);
});

test('スナップショットをアプリの形へ変換する', async () => {
  const { restore } = stubApi({
    snapshot: async () => ({
      meals: [{ id: 'm1', date: TODAY, name: 'x', calories: 1, protein: 1, fat: 1, carbs: 1 }],
      weights: [{ id: 'w1', date: TODAY, weight: 70 }],
      workouts: [{ id: 'k1', date: TODAY, exercises: [{ id: 'e1', name: 'ベンチ', sets: [{ id: 's1', reps: 5, weight: 50 }] }] }],
      goals: { calories: 2000, protein: 140, fat: 55, carbs: 240, targetWeight: 68, trainerStyle: 'coach' },
      profile: { hiddenWorkoutDates: ['2026-07-01'], freezeUsedDates: [], customExerciseCategories: { 'ヒップスラスト': '脚' }, longestStreak: 12 },
      today: TODAY,
    }),
  });
  try {
    const data = await cloudStore.load();
    assert.equal(data.meals[0].id, 'm1');
    assert.equal(data.workouts[0].exercises[0].sets[0].reps, 5);
    assert.equal(data.goals.trainerStyle, 'coach');
    assert.deepEqual(data.hiddenWorkoutDates, ['2026-07-01']);
    assert.equal(data.longestStreak, 12);
  } finally {
    restore();
  }
});

test('目標が未設定でも既定値で埋める（画面が壊れない）', async () => {
  const { restore } = stubApi();
  try {
    const data = await cloudStore.load();
    assert.equal(data.goals.calories > 0, true);
    assert.equal(data.goals.targetWeight > 0, true);
  } finally {
    restore();
  }
});
