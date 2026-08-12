import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKUP_KEYS,
  BACKUP_VERSION,
  MIGRATION_KEYS,
  buildBackup,
  buildMigrationPayload,
  summarizeBackup,
  backupFileName,
} from '../src/utils/backup.ts';

const fakeStore = (entries: Record<string, string>) => (key: string) =>
  Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;

test('保存されている全キーをバックアップに含める', () => {
  const entries: Record<string, string> = {};
  for (const key of BACKUP_KEYS) entries[key] = JSON.stringify([key]);

  const backup = buildBackup(fakeStore(entries), new Date('2026-08-11T09:00:00Z'));

  assert.equal(backup.app, 'lift-and-lean');
  assert.equal(backup.exportedAt, '2026-08-11T09:00:00.000Z');
  assert.deepEqual(Object.keys(backup.data).sort(), [...BACKUP_KEYS].sort());
  assert.deepEqual(backup.unparsed, {});
});

test('未保存のキーはバックアップに現れない（空配列を捏造しない）', () => {
  const backup = buildBackup(fakeStore({ meals: '[]' }));
  assert.deepEqual(Object.keys(backup.data), ['meals']);
});

test('壊れたJSONは落とさず生文字列として保持する', () => {
  const backup = buildBackup(fakeStore({
    meals: '[{"id":"a"',
    workouts: '[]',
  }));

  assert.equal(backup.data.meals, undefined);
  assert.equal(backup.unparsed.meals, '[{"id":"a"');
  assert.deepEqual(backup.data.workouts, []);
  assert.deepEqual(summarizeBackup(backup).unparsedKeys, ['meals']);
});

test('件数サマリが記録数とセット総数を数える', () => {
  const backup = buildBackup(fakeStore({
    meals: JSON.stringify([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]),
    weight_history: JSON.stringify([{ id: 'w1' }]),
    user_goals: JSON.stringify({ calories: 2200 }),
    workouts: JSON.stringify([
      { id: 'k1', exercises: [{ sets: [{}, {}, {}] }, { sets: [{}] }] },
      { id: 'k2', exercises: [] },
      { id: 'k3' },
    ]),
  }));

  assert.deepEqual(summarizeBackup(backup), {
    meals: 3,
    workouts: 3,
    weights: 1,
    totalSets: 4,
    hasGoals: true,
    unparsedKeys: [],
  });
});

test('ファイル名にローカル日時が入る', () => {
  const name = backupFileName(new Date(2026, 7, 11, 20, 5));
  assert.equal(name, 'lift-and-lean-backup-2026-08-11-2005.json');
});

test('クラウドへ送るのは移行対象のキーだけ（AIチャット履歴は送らない）', () => {
  const entries: Record<string, string> = {};
  for (const key of BACKUP_KEYS) entries[key] = JSON.stringify([key]);

  const payload = buildMigrationPayload(fakeStore(entries));

  assert.deepEqual(Object.keys(payload.data).sort(), [...MIGRATION_KEYS].sort());
  assert.equal('chat_messages' in payload.data, false);
  assert.equal('reminders_enabled' in payload.data, false);
});

test('移行ペイロードもバックアップと同じ形式（サーバー側が同じ経路で扱える）', () => {
  const payload = buildMigrationPayload(fakeStore({ meals: '[]' }), new Date('2026-08-12T00:00:00Z'));
  assert.equal(payload.app, 'lift-and-lean');
  assert.equal(payload.version, BACKUP_VERSION);
  assert.equal(payload.exportedAt, '2026-08-12T00:00:00.000Z');
});
