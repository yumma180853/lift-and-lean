/**
 * before / after を並べて読む。
 *
 *   node tests/perf/compare.mjs
 *
 * 「サーバーの遅さが、そのまま操作の遅さになっていないか」を見る表。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = label => JSON.parse(fs.readFileSync(path.join(HERE, 'results', `${label}.json`), 'utf8'));

const before = load('before');
const after = load('after');

const runOf = (report, delay) => report.runs.find(r => r.delayMs === delay);

const yes = v => (v ? '○' : '×');
const ms = v => (v === null || v === undefined ? '—' : `${v}ms`);

const ROWS = [
  ['起動（控えなし）', r => ms(r.coldStart.visibleMs)],
  ['起動（控えあり）', r => ms(r.warmStart.visibleMs)],
  ['目標値: 打鍵中の書き込み', r => `${r.goalTyping.writesDuringTyping}回`],
  ['目標値: 送信合計', r => `${r.goalTyping.writesTotal}回`],
  ['目標値: 表示が巻き戻った回数', r => `${r.goalTyping.revertedCount}回`],
  ['目標値: 最終表示（正=1850）', r => r.goalTyping.finalShown],
  ['セット編集: 反映まで', r => ms(r.setEdit.paintMs)],
  ['セット編集: 値が残る', r => yes(r.setEdit.kept)],
  ['セット5連打: 最終値が正しい', r => yes(r.rapidSetEdits.correct)],
  ['セット5連打: 送信数', r => `${r.rapidSetEdits.writes}回`],
  ['種目追加: 画面に出るまで', r => ms(r.addExercise.uiMs)],
  ['種目追加: 送信数', r => `${r.addExercise.writes}回`],
  ['食事追加: 一覧に出るまで', r => ms(r.mealAdd.listedMs)],
  ['タブ移動（最大）', r => ms(Math.max(...r.tabSwitch.switches.map(s => s.ms)))],
  ['圏外で追加: 一覧に残る', r => yes(r.offlineWrite.listedMs !== null)],
  ['障害中に追加: 画面に残る', r => yes(r.durability.listedWhileDown)],
  ['障害中に追加: 再読込後も残る', r => yes(r.durability.survivedReload)],
  ['復旧後: 自動で保存された', r => yes(r.durability.syncedAfterRecovery)],
  ['復旧後: 二重登録なし', r => yes(!r.durability.duplicateAccepted)],
  ['サーバーに通った件数（正=1）', r => `${r.durability.acceptedPosts}件`],
];

for (const delay of [0, 2000]) {
  const b = runOf(before, delay);
  const a = runOf(after, delay);
  if (!b || !a) continue;

  console.log(`\n${'='.repeat(74)}`);
  console.log(`人工遅延 ${delay}ms（サーバーの応答を ${delay / 1000} 秒遅らせた状態）`);
  console.log('='.repeat(74));
  console.log(`${'項目'.padEnd(30)} ${'改修前'.padStart(14)} ${'改修後'.padStart(14)}`);
  console.log('-'.repeat(74));
  for (const [label, pick] of ROWS) {
    let bv; let av;
    try { bv = String(pick(b)); } catch { bv = '—'; }
    try { av = String(pick(a)); } catch { av = '—'; }
    const mark = bv === av ? ' ' : '*';
    console.log(`${mark}${label.padEnd(29)} ${bv.padStart(14)} ${av.padStart(14)}`);
  }
}

console.log(`\nスナップショットの大きさ: ${runOf(before, 0).snapshotBytes.toLocaleString()} バイト（同じデータで比較）`);
console.log('* = 改修前後で値が変わった項目');
