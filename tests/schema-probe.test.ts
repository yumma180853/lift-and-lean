/**
 * スキーマ検査のテスト。
 *
 * 本番で「`db:verify` は定義どおりと言うのに、書き込みが `Unknown attribute` で落ちる」
 * 状態が実際に起きた（weights.needsReview と meals.fat が別々に見えなくなっていた）。
 * 列の一覧やstatusではなく、**本番と同じ経路で1行書いて確かめる**検査を固定する。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.APPWRITE_PROJECT_ID = 'test-project';
process.env.APPWRITE_API_KEY = 'test-key-not-a-secret';
process.env.APPWRITE_DATABASE_ID = 'testdb';

const { SCHEMA, probeWritableColumns, unknownAttributeOf, sampleValue } = await import('../scripts/appwrite-setup.ts');
const { AppwriteException } = await import('node-appwrite');

const mealsTable = SCHEMA.find(t => t.id === 'meals')!;
const weightsTable = SCHEMA.find(t => t.id === 'weights')!;

/** 指定した列だけ「存在しない」ふりをするAppwrite */
function fakeDb(brokenColumns: string[]) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      async createRow(params: any) {
        calls.push('createRow');
        const missing = Object.keys(params.data).find(key => brokenColumns.includes(key));
        if (missing) {
          throw new AppwriteException(
            `Invalid document structure: Unknown attribute: "${missing}"`, 400, 'row_invalid_structure',
          );
        }
        return { $id: params.rowId };
      },
      async deleteRow() { calls.push('deleteRow'); return {}; },
    } as any,
  };
}

test('Appwriteのメッセージから列名を取り出す', () => {
  const error = new AppwriteException('Invalid document structure: Unknown attribute: "fat"', 400, 'row_invalid_structure');
  assert.equal(unknownAttributeOf(error), 'fat');
  assert.equal(unknownAttributeOf(new AppwriteException('other', 500, 'general_error')), null);
});

test('書き込みに使える状態なら何も報告しない', async () => {
  const { db } = fakeDb([]);
  assert.deepEqual(await probeWritableColumns(db, mealsTable), []);
});

test('書き込みから見えない列を全部見つける（1回に1つしか返らないため繰り返す）', async () => {
  const { db } = fakeDb(['fat', 'needsReview']);
  const unknown = await probeWritableColumns(db, mealsTable);
  assert.deepEqual(unknown.sort(), ['fat', 'needsReview']);
});

test('本番で起きた組み合わせを再現できる', async () => {
  assert.deepEqual(await probeWritableColumns(fakeDb(['fat']).db, mealsTable), ['fat']);
  assert.deepEqual(await probeWritableColumns(fakeDb(['needsReview']).db, weightsTable), ['needsReview']);
});

test('検査用の行は必ず消す（成功しても失敗しても）', async () => {
  const ok = fakeDb([]);
  await probeWritableColumns(ok.db, mealsTable);
  assert.equal(ok.calls.filter(c => c === 'deleteRow').length, 1);

  const broken = fakeDb(['fat']);
  await probeWritableColumns(broken.db, mealsTable);
  assert.equal(broken.calls.filter(c => c === 'deleteRow').length, 2, '失敗した試行の分も消す');
});

test('検査用の値は列の制約を満たす', () => {
  for (const table of SCHEMA) {
    for (const column of table.columns) {
      const value = sampleValue(column);
      if (column.type === 'string') {
        const text = column.array ? (value as string[])[0] : value as string;
        assert.equal(typeof text, 'string', `${table.id}.${column.key}`);
        assert.equal(text.length <= column.size, true, `${table.id}.${column.key} は size 以内`);
      }
      if (column.type === 'integer' || column.type === 'float') {
        const n = value as number;
        if (column.min !== undefined) assert.equal(n >= column.min, true, `${table.id}.${column.key} は min 以上`);
        if (column.max !== undefined) assert.equal(n <= column.max, true, `${table.id}.${column.key} は max 以下`);
      }
      if (column.type === 'enum') {
        assert.equal(column.elements.includes(value as string), true, `${table.id}.${column.key}`);
      }
    }
  }
});

test('実在ユーザーの行と衝突しない値を使う', () => {
  // weights は (userId, date) が unique。検査用の userId は実在しない形にしておく
  const userId = SCHEMA.flatMap(t => t.columns).find(c => c.key === 'userId')!;
  assert.equal(sampleValue(userId), 'schemaprobe');
});
