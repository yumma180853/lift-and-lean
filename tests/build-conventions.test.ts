/**
 * デプロイ時にだけ壊れる種類のミスを、ローカルで落とすためのテスト。
 *
 * ここで守っている2つの規約は、どちらも過去に本番障害になった／なりかけたもの:
 *
 *  1. `api/` 配下の相対importに `.ts` 拡張子を書かない
 *     → Vercelは各.tsを.jsへコンパイルするが、**import文の拡張子は書き換えない**。
 *       `.ts` のまま書くと本番で ERR_MODULE_NOT_FOUND になり全APIが500になる。
 *       `.js` と書けば、TypeScriptは.tsへ解決し、実行時は.jsへ解決する。
 *
 *  2. `api/` 直下のディレクトリ名は `_` で始める
 *     → Vercelは `api/` 配下の各ファイルを個別のServerless Functionにする。
 *       `_` で始まる名前は関数化されない。守らないと関数が十数個に増え、
 *       Hobbyプランの上限（12個）に当たってデプロイが失敗する。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// パスに空白が含まれても壊れないよう fileURLToPath を使う
const API_DIR = fileURLToPath(new URL('../api/', import.meta.url));

function collectTsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

test('api/ 配下の相対importに .ts 拡張子を使っていない', () => {
  const offenders: string[] = [];
  for (const file of collectTsFiles(API_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']*)'|import\(\s*["'](\.[^"']*)["']/g)) {
      const specifier = match[1] ?? match[2];
      if (specifier.endsWith('.ts')) {
        offenders.push(`${file.replace(API_DIR, 'api/')}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], '本番で ERR_MODULE_NOT_FOUND になるため .js 拡張子で書くこと');
});

/**
 * 拡張子を**書き忘れた**場合も同じ壊れ方をする。
 *
 * tsconfig の moduleResolution は "bundler" なので、拡張子が無くても
 * 型検査は通ってしまう。しかし本番の実行時（Node の ESM）は拡張子を
 * 補完しないため ERR_MODULE_NOT_FOUND になり、**全APIが500になる**。
 * 実際に一度この形で本番を落としたので、ここで落とす。
 */
test('api/ 配下の相対importには .js 拡張子が付いている', () => {
  const offenders: string[] = [];
  for (const file of collectTsFiles(API_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']*)'|import\(\s*["'](\.[^"']*)["']/g)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.endsWith('.js')) {
        offenders.push(`${file.replace(API_DIR, 'api/')}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], '本番で ERR_MODULE_NOT_FOUND になるため .js 拡張子まで書くこと');
});

test('api/ 直下のディレクトリは _ で始まる（Serverless Function化されない）', () => {
  const exposed = readdirSync(API_DIR)
    .filter(entry => statSync(join(API_DIR, entry)).isDirectory())
    .filter(entry => !entry.startsWith('_'));

  assert.deepEqual(exposed, [], 'Vercelの関数上限に当たるため、共有モジュールは _ 付きに置くこと');
});

test('Serverless Functionになるファイルは意図したものだけ', () => {
  // `_` で始まらないファイルはそれぞれ1つの関数になる。
  // 増やすときは関数上限（Hobbyは12）を意識して意図的に足すこと。
  const functions = readdirSync(API_DIR)
    .filter(entry => entry.endsWith('.ts') && !entry.startsWith('_'))
    .sort();

  assert.deepEqual(functions, ['meal-estimate-helpers.ts', 'server.ts']);
});
