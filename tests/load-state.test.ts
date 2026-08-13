/**
 * 読み込み状態と競合制御のテスト。
 *
 * 本番で「何も失敗していないのに
 * 『最新のデータを取得できていません（表示は前回の内容）』が出た」ため、
 * 「取得中」と「取得に失敗」を分けた。ここではその分離と、
 * 短時間に読み込みが重なったときの挙動を固定する。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LoadCoordinator,
  initialStatus,
  loadFailed,
  loadSucceeded,
  localReadyStatus,
  startLoad,
} from '../src/data/loadState.ts';

// ---------------------------------------------------------------- 状態の分離

test('取得を始めただけでは「失敗」にしない', () => {
  const withCache = startLoad(true);
  assert.equal(withCache.stale, false, '取得中に「取得できていません」を出さない');
  assert.equal(withCache.phase, 'ready', '控えがあるなら中身は見せ続ける');
  assert.equal(withCache.refreshing, true);
  assert.equal(withCache.error, null);
});

test('控えが無いときの取得中は「読み込み中」であって「失敗」ではない', () => {
  const withoutCache = startLoad(false);
  assert.equal(withoutCache.phase, 'loading');
  assert.equal(withoutCache.stale, false);
  assert.equal(withoutCache.error, null);
});

test('実際に失敗し、控えがあるときだけ stale にする', () => {
  const failed = loadFailed(true, '通信に失敗しました');
  assert.equal(failed.stale, true);
  assert.equal(failed.phase, 'ready', '控えの内容は見せ続ける');
  assert.equal(failed.refreshing, false);
  assert.equal(failed.error, '通信に失敗しました');
});

test('失敗して控えも無いときは読み込みエラーにする（staleではない）', () => {
  const failed = loadFailed(false, '通信に失敗しました');
  assert.equal(failed.phase, 'error');
  assert.equal(failed.stale, false, '見せる中身が無いので「前回の内容」ではない');
});

test('成功したら警告は全部消える', () => {
  const ok = loadSucceeded();
  assert.deepEqual(ok, { phase: 'ready', refreshing: false, stale: false, error: null });
});

test('端末保存モードには「取得中」も「失敗」も無い', () => {
  assert.deepEqual(localReadyStatus(), { phase: 'ready', refreshing: false, stale: false, error: null });
  assert.equal(initialStatus().phase, 'loading');
});

// ---------------------------------------------------------------- 競合制御

test('最後に始めた読み込みだけが結果を反映できる', () => {
  const coordinator = new LoadCoordinator();
  const first = coordinator.begin();
  const second = coordinator.begin();

  assert.equal(coordinator.isCurrent(first), false, '古い読み込みは捨てる');
  assert.equal(coordinator.isCurrent(second), true);
});

/** フックの loadFor と同じ手順を再現する（挙動を実物と揃えるため） */
function makeLoader() {
  const coordinator = new LoadCoordinator();
  let status = initialStatus();
  let data: string | null = null;

  return {
    get status() { return status; },
    get data() { return data; },
    async load(fetcher: () => Promise<string>, cache: string | null) {
      const token = coordinator.begin();
      if (cache !== null) data = cache;
      status = startLoad(cache !== null);
      try {
        const fresh = await fetcher();
        if (!coordinator.isCurrent(token)) return;
        data = fresh;
        status = loadSucceeded();
      } catch (error) {
        if (!coordinator.isCurrent(token)) return;
        status = loadFailed(cache !== null, String((error as Error).message));
      }
    },
  };
}

const delayed = <T>(value: T, ms: number): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), ms));

const failsAfter = (ms: number, message: string): Promise<string> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

test('連続で読み込んでも、遅れて返った古い結果で上書きされない', async () => {
  const loader = makeLoader();

  const slowOld = loader.load(() => delayed('古いデータ', 40), '控え');
  const fastNew = loader.load(() => delayed('新しいデータ', 5), '控え');

  await Promise.all([slowOld, fastNew]);

  assert.equal(loader.data, '新しいデータ');
  assert.equal(loader.status.stale, false, 'バナーが残らない');
  assert.equal(loader.status.phase, 'ready');
});

test('古い読み込みが後から失敗しても、新しい成功を打ち消さない', async () => {
  const loader = makeLoader();

  const slowFailure = loader.load(() => failsAfter(40, '通信に失敗しました'), '控え');
  const fastSuccess = loader.load(() => delayed('新しいデータ', 5), '控え');

  await Promise.all([slowFailure, fastSuccess]);

  assert.equal(loader.data, '新しいデータ');
  assert.equal(loader.status.stale, false, '古い失敗でバナーを出さない');
  assert.equal(loader.status.error, null);
});

test('短時間に何度も読み込んでもバナーが残らない', async () => {
  const loader = makeLoader();
  const runs = [50, 30, 20, 10, 1].map(ms => loader.load(() => delayed(`データ${ms}`, ms), '控え'));
  await Promise.all(runs);

  assert.equal(loader.status.stale, false);
  assert.equal(loader.status.refreshing, false);
  assert.equal(loader.data, 'データ1', '最後に始めた読み込みの結果になる');
});

test('成功 → 失敗 → 再成功でバナーが出て消える', async () => {
  const loader = makeLoader();

  await loader.load(() => delayed('1回目', 1), null);
  assert.equal(loader.status.stale, false);
  assert.equal(loader.data, '1回目');

  await loader.load(() => failsAfter(1, 'オフラインです'), '1回目');
  assert.equal(loader.status.stale, true, '失敗したので前回の内容だと伝える');
  assert.equal(loader.status.phase, 'ready');
  assert.equal(loader.data, '1回目', '中身は消さない');
  assert.equal(loader.status.error, 'オフラインです');

  await loader.load(() => delayed('3回目', 1), '1回目');
  assert.equal(loader.status.stale, false, '再取得できたらバナーは消える');
  assert.equal(loader.data, '3回目');
});

test('取得中はまだ失敗と表示しない（途中経過の確認）', async () => {
  const loader = makeLoader();
  const running = loader.load(() => delayed('データ', 20), '控え');

  // 取得の最中
  assert.equal(loader.status.refreshing, true);
  assert.equal(loader.status.stale, false, '取得中に警告を出さない');
  assert.equal(loader.data, '控え', '控えは見せておく');

  await running;
  assert.equal(loader.status.stale, false);
});
