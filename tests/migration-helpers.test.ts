import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveRowId,
  isValidDate,
  jstDateString,
  normalizeBackup,
  expectedCounts,
  planCounts,
  diffCounts,
} from '../api/_migration-helpers.ts';

const USER = 'user-abc';
const TODAY = '2026-08-11';

const sample = () => ({
  meals: [
    { id: 'm1', date: '2026-08-10', name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2 },
    { id: 'm2', name: '日付なしの古い記録', calories: 500, protein: 20, fat: 15, carbs: 60 },
  ],
  weight_history: [
    { id: 'w1', date: '2026-08-09', weight: 71.2 },
    { id: 'w2', date: '2026-08-10', weight: 70.8 },
  ],
  workouts: [
    {
      id: 'k1',
      date: '2026-08-10',
      exercises: [
        { id: 'e1', name: 'ベンチプレス', sets: [{ id: 's1', reps: 10, weight: 60 }, { id: 's2', reps: 8, weight: 65 }] },
      ],
    },
    { id: 'k2', date: '2026-08-09', exercises: [] },
  ],
  user_goals: { calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 68, trainerStyle: 'coach' },
  hidden_workout_dates: ['2026-07-01'],
  custom_exercise_categories: { 'ヒップスラスト': '脚' },
  freeze_used_dates: ['2026-08-05'],
  longest_streak: 12,
});

// ---------------------------------------------------------------- rowId

test('rowIdはAppwriteの制約（36文字以内・英数字始まり）を満たす', () => {
  const id = deriveRowId(USER, 'meal', 'm1');
  assert.equal(id.length, 33);
  assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
});

test('同じ入力からは必ず同じrowIdになる（再実行しても重複しない）', () => {
  assert.equal(deriveRowId(USER, 'meal', 'm1'), deriveRowId(USER, 'meal', 'm1'));
});

test('ユーザー・種別・キーのどれが変わってもrowIdは変わる', () => {
  const base = deriveRowId(USER, 'meal', 'm1');
  assert.notEqual(base, deriveRowId('user-xyz', 'meal', 'm1'));
  assert.notEqual(base, deriveRowId(USER, 'weight', 'm1'));
  assert.notEqual(base, deriveRowId(USER, 'meal', 'm2'));
});

// ---------------------------------------------------------------- 日付

test('日付の妥当性を実在する日で判定する', () => {
  assert.equal(isValidDate('2026-08-11'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-8-1'), false);
  assert.equal(isValidDate(undefined), false);
});

test('JSTの日付境界を跨いでも日本の日付になる', () => {
  // UTC 2026-08-10T16:00Z = JST 2026-08-11 01:00
  assert.equal(jstDateString(new Date('2026-08-10T16:00:00Z')), '2026-08-11');
  assert.equal(jstDateString(new Date('2026-08-10T14:59:00Z')), '2026-08-10');
});

// ---------------------------------------------------------------- 変換

test('通常データをそのまま行へ変換する', () => {
  const plan = normalizeBackup(sample(), { userId: USER, today: TODAY });

  assert.equal(plan.meals.length, 2);
  assert.equal(plan.weights.length, 2);
  assert.equal(plan.workouts.length, 1);
  assert.equal(plan.exercises.length, 1);
  assert.equal(plan.sets.length, 2);
  assert.equal(plan.goals?.trainerStyle, 'coach');
  assert.equal(plan.profile?.longestStreak, 12);
  assert.equal(plan.profile?.customExerciseCategories, '{"ヒップスラスト":"脚"}');
});

test('localStorageのidはrowIdではなくclientRequestIdに入る', () => {
  const plan = normalizeBackup(sample(), { userId: USER, today: TODAY });
  const meal = plan.meals[0];
  assert.equal(meal.clientRequestId, 'm1');
  assert.equal(meal.rowId, deriveRowId(USER, 'meal', 'm1'));
  assert.notEqual(meal.rowId, 'm1');
});

test('date欠損の古い食事は実行日で補完し要確認にする', () => {
  const plan = normalizeBackup(sample(), { userId: USER, today: TODAY });
  const meal = plan.meals.find(m => m.clientRequestId === 'm2')!;
  assert.equal(meal.date, TODAY);
  assert.equal(meal.needsReview, true);
  assert.equal(plan.warnings.some(w => w.includes('補完')), true);
});

test('体重は日付ごとに1件へ集約し、同日は最後の値を採用する', () => {
  const plan = normalizeBackup({
    weight_history: [
      { id: 'a', date: '2026-08-10', weight: 70 },
      { id: 'b', date: '2026-08-10', weight: 69.5 },
    ],
  }, { userId: USER, today: TODAY });

  assert.equal(plan.weights.length, 1);
  assert.equal(plan.weights[0].weight, 69.5);
  assert.equal(plan.weights[0].rowId, deriveRowId(USER, 'weight', '2026-08-10'));
});

test('0種目の筋トレは移行しない', () => {
  const plan = normalizeBackup(sample(), { userId: USER, today: TODAY });
  assert.equal(plan.workouts.some(w => w.date === '2026-08-09'), false);
});

test('同じ日に複数の筋トレがあれば1件へ統合し、種目は全部残す', () => {
  const plan = normalizeBackup({
    workouts: [
      { id: 'k1', date: '2026-08-10', exercises: [{ id: 'e1', name: 'スクワット', sets: [{ reps: 5, weight: 100 }] }] },
      {
        id: 'k2',
        date: '2026-08-10',
        exercises: [
          { id: 'e2', name: 'デッドリフト', sets: [] },
          { id: 'e3', name: 'レッグプレス', sets: [] },
        ],
      },
    ],
  }, { userId: USER, today: TODAY });

  assert.equal(plan.workouts.length, 1);
  assert.equal(plan.workouts[0].needsReview, true);
  assert.deepEqual(plan.exercises.map(e => e.name), ['デッドリフト', 'レッグプレス', 'スクワット']);
  assert.equal(plan.sets.length, 1);
  // 種目・セットは統合後の筋トレ行にぶら下がる
  assert.equal(plan.exercises.every(e => e.workoutId === plan.workouts[0].rowId), true);
  assert.equal(plan.sets[0].exerciseId, plan.exercises.find(e => e.name === 'スクワット')!.rowId);
});

test('異常な数値は範囲内へ丸めて要確認にする（記録自体は捨てない）', () => {
  const plan = normalizeBackup({
    meals: [{ id: 'm1', date: TODAY, name: 'x', calories: 999999, protein: NaN, fat: -5, carbs: '80' }],
    workouts: [{ id: 'k1', date: TODAY, exercises: [{ id: 'e1', name: 'ベンチ', sets: [{ id: 's1', reps: 0, weight: 9999 }] }] }],
  }, { userId: USER, today: TODAY });

  const meal = plan.meals[0];
  assert.equal(meal.calories, 20000);
  assert.equal(meal.protein, 0);
  assert.equal(meal.fat, 0);
  assert.equal(meal.carbs, 80);
  assert.equal(meal.needsReview, true);

  assert.equal(plan.sets[0].reps, 1);
  assert.equal(plan.sets[0].weight, 500);
  assert.equal(plan.sets[0].needsReview, true);
});

test('不正なsourceTypeは捨てて他の項目は保持する', () => {
  const plan = normalizeBackup({
    meals: [{ id: 'm1', date: TODAY, name: 'x', calories: 100, sourceType: 'guess', sourceLabel: '松屋' }],
  }, { userId: USER, today: TODAY });

  assert.equal(plan.meals[0].sourceType, undefined);
  assert.equal(plan.meals[0].sourceLabel, '松屋');
});

test('壊れた形の入力でも例外を投げない', () => {
  const plan = normalizeBackup({
    meals: 'not-an-array',
    workouts: [null, { date: TODAY, exercises: [null] }],
    weight_history: [undefined],
    user_goals: 'broken',
  } as unknown as Record<string, unknown>, { userId: USER, today: TODAY });

  assert.equal(plan.meals.length, 0);
  assert.equal(plan.goals, null);
  assert.equal(plan.exercises.length, 1);
  assert.equal(plan.exercises[0].name, '種目なし');
});

test('移行対象が無ければprofile行を作らない', () => {
  const plan = normalizeBackup({}, { userId: USER, today: TODAY });
  assert.equal(plan.profile, null);
  assert.equal(plan.goals, null);
});

test('同じ入力を2回変換しても同じrowIdの集合になる（冪等）', () => {
  const a = normalizeBackup(sample(), { userId: USER, today: TODAY });
  const b = normalizeBackup(sample(), { userId: USER, today: TODAY });
  assert.deepEqual(a.meals.map(m => m.rowId), b.meals.map(m => m.rowId));
  assert.deepEqual(a.sets.map(s => s.rowId), b.sets.map(s => s.rowId));
});

// ---------------------------------------------------------------- 検証

test('移行前後の件数が一致する', () => {
  const data = sample();
  const plan = normalizeBackup(data, { userId: USER, today: TODAY });
  const issues = diffCounts(expectedCounts(data, TODAY), planCounts(plan));
  assert.deepEqual(issues, []);
});

test('件数がズレたら日本語で理由を返す', () => {
  const expected = { meals: 10, weights: 3, workouts: 2, exercises: 4, sets: 12, totalCalories: 5000, latestWeight: 70 };
  const actual = { meals: 9, weights: 3, workouts: 2, exercises: 4, sets: 12, totalCalories: 4800, latestWeight: 70 };
  const issues = diffCounts(expected, actual);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /食事: 移行前 10 \/ 移行後 9/);
});
