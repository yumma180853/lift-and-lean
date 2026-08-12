import assert from 'node:assert/strict';
import test from 'node:test';
import { LiftAndLeanService } from '../api/_core/service.ts';
import { buildBackup } from '../src/utils/backup.ts';
import { MemoryRepository } from './support/memory-repository.ts';

const ALICE = 'alice';
const BOB = 'bob';
const NOW = new Date('2026-08-12T01:00:00Z');

function setup() {
  const repository = new MemoryRepository(ALICE);
  const service = new LiftAndLeanService({
    repository,
    clock: { now: () => NOW },
    onAuditFailure: (error) => { throw error; },
  });
  return { repository, service };
}

/** 実際の設定画面が書き出すのと同じ形のバックアップを作る */
function backupFile() {
  const store: Record<string, string> = {
    meals: JSON.stringify([
      { id: 'm1', date: '2026-08-10', name: '鶏むね', calories: 320, protein: 60, fat: 5, carbs: 2 },
      { id: 'm2', date: '2026-08-11', name: '白米', calories: 250, protein: 4, fat: 1, carbs: 55 },
    ]),
    weight_history: JSON.stringify([
      { id: 'w1', date: '2026-08-10', weight: 71.2 },
      { id: 'w2', date: '2026-08-11', weight: 70.8 },
    ]),
    workouts: JSON.stringify([
      {
        id: 'k1', date: '2026-08-10',
        exercises: [{ id: 'e1', name: 'ベンチプレス', sets: [{ id: 's1', reps: 10, weight: 60 }, { id: 's2', reps: 8, weight: 65 }] }],
      },
    ]),
    user_goals: JSON.stringify({ calories: 2200, protein: 150, fat: 60, carbs: 250, targetWeight: 68, trainerStyle: 'coach' }),
    longest_streak: JSON.stringify(12),
    custom_exercise_categories: JSON.stringify({ 'ヒップスラスト': '脚' }),
  };
  return buildBackup(key => (key in store ? store[key] : null), NOW);
}

test('バックアップJSONをそのまま移行できる', async () => {
  const { repository, service } = setup();
  const report = await service.migrateFromBackup(ALICE, backupFile());

  assert.equal(report.applied, true);
  assert.deepEqual(report.issues, []);
  assert.equal(repository.countOf('meals'), 2);
  assert.equal(repository.countOf('weights'), 2);
  assert.equal(repository.countOf('workouts'), 1);
  assert.equal(repository.countOf('workout_exercises'), 1);
  assert.equal(repository.countOf('workout_sets'), 2);
  assert.equal(repository.countOf('goals'), 1);
  assert.equal(repository.countOf('profiles'), 1);
});

test('移行は31日ルールの影響を受けない（古い記録もそのまま入る）', async () => {
  const { repository, service } = setup();
  const old = buildBackup(key => (key === 'meals'
    ? JSON.stringify([{ id: 'old', date: '2024-01-05', name: '昔の食事', calories: 400, protein: 20, fat: 10, carbs: 50 }])
    : null), NOW);

  const report = await service.migrateFromBackup(ALICE, old);
  assert.equal(report.applied, true);
  assert.equal(repository.rawRows('meals')[0].date, '2024-01-05');
});

test('同じバックアップを2回送っても重複しない', async () => {
  const { repository, service } = setup();
  await service.migrateFromBackup(ALICE, backupFile());
  const second = await service.migrateFromBackup(ALICE, backupFile());

  assert.equal(second.applied, true);
  assert.equal(repository.countOf('meals'), 2);
  assert.equal(repository.countOf('workout_sets'), 2);
  const meals = second.written.find(w => w.table === 'meals');
  assert.equal(meals?.created, 0);
  assert.equal(meals?.existed, 2);
});

test('移行後の検証が件数の一致を確認する', async () => {
  const { service } = setup();
  const backup = backupFile();
  await service.migrateFromBackup(ALICE, backup);

  const verification = await service.verifyMigration(ALICE, backup);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.issues, []);
  assert.equal(verification.stored.meals, 2);
});

test('移行後に記録が1件でも欠けていれば検証が落ちる', async () => {
  const { repository, service } = setup();
  const backup = backupFile();
  await service.migrateFromBackup(ALICE, backup);

  const meal = repository.rawRows('meals')[0];
  await repository.deleteOwnedRow('meals', ALICE, meal.$id);

  const verification = await service.verifyMigration(ALICE, backup);
  assert.equal(verification.ok, false);
  assert.equal(verification.issues.some(issue => issue.includes('食事')), true);
});

test('preview は何も書き込まずに件数だけ返す', async () => {
  const { repository, service } = setup();
  const report = await service.previewMigration(ALICE, backupFile());

  assert.equal(report.applied, false);
  assert.equal(report.counts.meals, 2);
  assert.equal(repository.countOf('meals'), 0);
});

test('移行したデータは他人から見えない', async () => {
  const { repository, service } = setup();
  await service.migrateFromBackup(ALICE, backupFile());

  const bobRepository = repository.asViewer(BOB);
  const leaked = await bobRepository.listRows('meals', ALICE, {});
  assert.deepEqual(leaked, []);
});

test('別アプリのバックアップは受け付けない', async () => {
  const { service } = setup();
  await assert.rejects(
    () => service.migrateFromBackup(ALICE, { app: 'other-app', data: {} }),
    (error: any) => error.status === 400,
  );
});

test('data直下の形（生のlocalStorage内容）も受け付ける', async () => {
  const { repository, service } = setup();
  const report = await service.migrateFromBackup(ALICE, {
    meals: [{ id: 'm1', date: '2026-08-10', name: 'x', calories: 100, protein: 1, fat: 1, carbs: 1 }],
  });
  assert.equal(report.applied, true);
  assert.equal(repository.countOf('meals'), 1);
});

test('移行のあとにアプリから記録を足しても衝突しない', async () => {
  const { repository, service } = setup();
  await service.migrateFromBackup(ALICE, backupFile());
  await service.logMeal(ALICE, { name: '追加の食事', calories: 100, protein: 1, fat: 1, carbs: 1 });

  assert.equal(repository.countOf('meals'), 3);
  const origins = repository.rawRows('meals').map(row => row.origin).sort();
  assert.deepEqual(origins, ['app', 'migration', 'migration']);
});

// ---------------------------------------------------------------- 途中で失敗したあとの再実行

test('途中のテーブルで失敗しても、直してから再実行すれば過不足なく揃う', async () => {
  const repository = new MemoryRepository(ALICE);
  const backup = backupFile();

  // 本番で起きた状況の再現: weights は書けたが meals でスキーマ不整合になる
  let mealsBroken = true;
  const original = repository.putOwnedRows.bind(repository);
  repository.putOwnedRows = async (table, ownerId, rows, mode) => {
    if (table === 'meals' && mealsBroken) {
      const error: any = new Error('Unknown attribute: "fat"');
      error.status = 503;
      error.code = 'schema_mismatch';
      throw error;
    }
    return original(table, ownerId, rows, mode);
  };

  const service = new LiftAndLeanService({
    repository, clock: { now: () => NOW }, onAuditFailure: () => {},
  });

  await assert.rejects(() => service.migrateFromBackup(ALICE, backup), (e: any) => e.code === 'schema_mismatch');

  // 体重だけ入った中途半端な状態
  assert.equal(repository.countOf('weights'), 2);
  assert.equal(repository.countOf('meals'), 0);

  // 検証は「合っていない」と正しく言う
  const beforeRepair = await service.verifyMigration(ALICE, backup);
  assert.equal(beforeRepair.ok, false);

  // スキーマを直して再実行
  mealsBroken = false;
  const report = await service.migrateFromBackup(ALICE, backup);
  assert.equal(report.applied, true);

  // 体重は重複せず、他も過不足なし
  assert.equal(repository.countOf('weights'), 2);
  assert.equal(repository.countOf('meals'), 2);
  assert.equal(repository.countOf('workout_sets'), 2);

  const afterRepair = await service.verifyMigration(ALICE, backup);
  assert.equal(afterRepair.ok, true);
  assert.deepEqual(afterRepair.issues, []);
});

test('再実行しても既存の記録を消さない（upsertは同じ行を上書きするだけ）', async () => {
  const { repository, service } = setup();
  const backup = backupFile();
  await service.migrateFromBackup(ALICE, backup);
  const idsBefore = repository.rawRows('weights').map(row => row.$id).sort();

  await service.migrateFromBackup(ALICE, backup);
  const idsAfter = repository.rawRows('weights').map(row => row.$id).sort();

  assert.deepEqual(idsAfter, idsBefore);
});
