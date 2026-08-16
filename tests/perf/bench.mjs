/**
 * 実ブラウザでの操作レイテンシ計測。
 *
 * 「サーバーの遅さが、そのまま操作の遅さになっていないか」を測る。
 * 人工遅延 0ms と 2000ms で同じ操作を回し、体感差を数字にする。
 *
 *   node tests/perf/bench.mjs --label before
 *
 * 結果は tests/perf/results/<label>.json に残す（before/after の比較用）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Page, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4321';

const argOf = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const LABEL = argOf('label') ?? 'run';
const CPU_THROTTLE = Number(argOf('cpu') ?? 4);

const lab = {
  reset: (delay, dataset = 'halfyear') =>
    fetch(`${ORIGIN}/__lab/reset?delay=${delay}&dataset=${dataset}&fail=0`).then(r => r.json()),
  /** ログを消さずに「サーバー障害」だけ切り替える */
  fail: on => fetch(`${ORIGIN}/__lab/fail?on=${on ? 1 : 0}`).then(r => r.json()),
  log: () => fetch(`${ORIGIN}/__lab/log`).then(r => r.json()),
};

/**
 * ページ内に仕込む道具。
 * fetch を包んで「いつ・何を送ったか」を**送信時点で**記録する
 * （サーバー側のログは遅延の分だけ遅れて増えるため、送信数の計測には使えない）。
 */
const PAGE_HELPERS = `
(() => {
  if (!window.__perf) {
    const calls = [];
    const longTasks = [];
    try {
      new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch {}

    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (url.includes('/api/')) calls.push({ at: Math.round(performance.now()), method, url: String(url) });
      return origFetch(input, init);
    };

    const nativeSet = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    window.__perf = {
      calls, longTasks, nativeSet,
      mark() { return calls.length; },
      since(n) { return calls.slice(n); },
      byText: (sel, text) => [...document.querySelectorAll(sel)].find(el => (el.innerText || '').includes(text)),
      nextPaint: () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))),
      sleep: ms => new Promise(r => setTimeout(r, ms)),

      /** 送信待ちの件数（改修前は outbox が無いので 0 として扱う） */
      outboxOps() {
        try { const r = JSON.parse(localStorage.getItem('outbox:v1')); return r ? r.ops.length : 0; }
        catch { return 0; }
      },

      /**
       * 「この操作が何回の書き込みになったか」を数えるために、落ち着くまで待つ。
       *
       * 決め打ちの秒数で待つと、端末が遅いときに**まだ送っていないもの**を
       * 0件と数えてしまう。送信待ちが空になり、通信も止まったことを確かめる。
       */
      async settle(maxMs = 20000) {
        const start = performance.now();
        let seen = calls.length;
        let quietSince = performance.now();
        while (performance.now() - start < maxMs) {
          await new Promise(r => setTimeout(r, 200));
          if (calls.length !== seen) { seen = calls.length; quietSince = performance.now(); }
          if (this.outboxOps() === 0 && performance.now() - quietSince > 2500) return;
        }
      },
    };
  }
  return true;
})()
`;

/** fetch の差し替えは読み込み直後に効かせたいので、ページ生成時に必ず入れる */
async function installHelpers(page) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
}

async function newPage(chrome, { throttle = CPU_THROTTLE } = {}) {
  const page = await Page.attach(chrome.port);
  await page.emulateIPhone();
  // これが無いと onBlur で確定する入力（セットの重量・回数）が測れない
  await page.enableFocusEmulation();
  if (throttle > 1) await page.throttleCpu(throttle);
  await installHelpers(page);
  return page;
}

const nav = async (page, text) => {
  await page.eval(`(() => {
    const b = [...document.querySelectorAll('nav button')].find(x => (x.innerText||'').includes(${JSON.stringify(text)}));
    if (b) b.click();
    return !!b;
  })()`);
};

/** 半年ぶんの実データが画面に出たか（空データでは出ない文字で判定） */
const REAL_DATA = `document.body.innerText.includes('日継続中')`;

async function reloadAndSettle(page, { timeoutMs = 60000 } = {}) {
  await page.send('Page.navigate', { url: `${ORIGIN}/` });
  await page.waitFor(REAL_DATA, { timeoutMs, intervalMs: 16, label: '実データ表示' });
  await page.eval(PAGE_HELPERS);
}

// ------------------------------------------------------------------ シナリオ

/** 起動から「実データが見えるまで」 */
async function measureStartup(page, { withCache, delayMs }) {
  await page.send('Storage.clearDataForOrigin', {
    origin: ORIGIN, storageTypes: 'local_storage,indexeddb,cache_storage,cookies',
  });

  if (withCache) {
    // 控えができるまで確実に待つ（実データが出てから、さらに書き込みぶん待つ）
    await page.send('Page.navigate', { url: `${ORIGIN}/` });
    await page.waitFor(REAL_DATA, { timeoutMs: 60000, intervalMs: 16, label: '控えの作成' });
    await sleep(1500);
  }

  const t0 = Date.now();
  await page.send('Page.navigate', { url: `${ORIGIN}/` });
  await page.waitFor(REAL_DATA, { timeoutMs: 60000, intervalMs: 16, label: '実データ表示' });
  const visibleMs = Date.now() - t0;

  await page.eval(PAGE_HELPERS);
  const calls = await page.eval(`window.__perf.calls.slice()`);
  const strip = url => url.replace(/^https?:\/\/[^/]+/, '');
  return { visibleMs, requestCount: calls.length, requests: calls.map(c => `${c.method} ${strip(c.url)}`) };
}

/** 設定画面の目標値。1文字ごとに書き込みが飛んでいないか／表示が巻き戻らないか */
async function measureGoalTyping(page) {
  await nav(page, '設定');
  await page.waitFor(`!!document.querySelector('input[type=number]')`, { timeoutMs: 20000, label: '設定画面' });
  await page.eval(PAGE_HELPERS);
  await sleep(600);

  return page.eval(`(async () => {
    const P = window.__perf;
    const input = document.querySelector('input[type=number]');
    if (!input) return { error: '目標値の入力欄が見つかりませんでした' };
    input.focus();

    const mark = P.mark();
    const typed = '1850';
    const samples = [];
    for (let i = 1; i <= typed.length; i++) {
      const want = typed.slice(0, i);
      const t0 = performance.now();
      P.nativeSet(input, want);
      await P.nextPaint();
      const paintMs = Math.round(performance.now() - t0);
      await P.sleep(120);                        // 実際の連続入力の間隔
      samples.push({ want, paintMs, showsAfter120ms: String(input.value) });
    }
    const typingCalls = P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url));

    input.blur();
    await P.settle();                             // 送信待ちが空になるまで待つ
    const allCalls = P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url));

    return {
      samples,
      finalShown: String(document.querySelector('input[type=number]').value),
      revertedCount: samples.filter(s => s.showsAfter120ms !== s.want).length,
      maxPaintMs: Math.max(...samples.map(s => s.paintMs)),
      writesDuringTyping: typingCalls.length,
      writesTotal: allCalls.length,
      routes: allCalls.map(c => c.method + ' ' + c.url.replace(/^https?:\\/\\/[^/]+/, '')),
    };
  })()`);
}

async function openTodayWorkout(page) {
  await nav(page, 'トレーニング');
  await page.waitFor(`document.body.innerText.includes('TRAINING LOGS')`, { timeoutMs: 20000, label: '筋トレ一覧' });
  await page.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('今日のトレーニング'));
    if (b) b.click(); return !!b;
  })()`);
  await page.waitFor(`document.querySelectorAll('input[type=number]').length > 1`, { timeoutMs: 20000, label: '筋トレ詳細' });
  await page.eval(PAGE_HELPERS);
  await sleep(700);
}

/**
 * セット重量の編集。
 *
 * 画面の VOL はローカル state から計算されるので即時に見える。
 * ここで測るのは「保存が終わるまで」と「保存の応答が入力を巻き戻さないか」。
 */
async function measureSetEdit(page) {
  return page.eval(`(async () => {
    const P = window.__perf;
    const weight = document.querySelectorAll('input[type=number]')[0];
    if (!weight) return { error: 'セットの入力欄が見つかりませんでした' };

    const mark = P.mark();
    const target = String(Number(weight.value) + 12.5);
    const t0 = performance.now();
    weight.focus();
    P.nativeSet(weight, target);
    await P.nextPaint();
    const paintMs = Math.round(performance.now() - t0);
    weight.blur();                                  // React の onBlur は focusout で発火する

    // 送信されるまで
    let sentMs = null;
    const sendDeadline = performance.now() + 8000;
    while (performance.now() < sendDeadline) {
      await P.sleep(16);
      if (P.since(mark).some(c => /\\/api\\/v1\\/sets\\//.test(c.url))) { sentMs = Math.round(performance.now() - t0); break; }
    }

    // 応答が届いて画面へ反映されるまで（入力欄が編集不能に見えないかも見る）
    await P.sleep(4000);
    const nowInput = document.querySelectorAll('input[type=number]')[0];
    return {
      paintMs, sentMs, target,
      finalShown: String(nowInput.value),
      kept: String(nowInput.value) === target,
      writes: P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url)).length,
      routes: P.since(mark).map(c => c.method + ' ' + c.url.replace(/^https?:\\/\\/[^/]+/, '')),
    };
  })()`);
}

/** 同じセットを素早く5回変える。最終値が正しく残るか／途中で巻き戻らないか */
async function measureRapidSetEdits(page) {
  return page.eval(`(async () => {
    const P = window.__perf;
    const pick = () => document.querySelectorAll('input[type=number]')[0];
    const mark = P.mark();
    const values = ['60', '62.5', '65', '67.5', '70'];

    const observed = [];
    const t0 = performance.now();
    for (const v of values) {
      const el = pick();
      el.focus();
      P.nativeSet(el, v);
      el.blur();
      await P.sleep(150);
      observed.push({ wanted: v, shows: String(pick().value) });
    }
    const inputDoneMs = Math.round(performance.now() - t0);

    // 全部の通信が終わるのを待つ
    await P.settle();
    const finalShown = String(pick().value);
    return {
      inputDoneMs,
      observed,
      revertedDuringInput: observed.filter(o => o.shows !== o.wanted).length,
      expected: '70',
      finalShown,
      correct: finalShown === '70',
      writes: P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url)).length,
    };
  })()`);
}

/** 種目の追加（カテゴリつき＝サーバーへ2往復する経路） */
async function measureAddExercise(page) {
  return page.eval(`(async () => {
    const P = window.__perf;
    const mark = P.mark();
    const addBtn = P.byText('button', '種目を追加');
    if (!addBtn) return { error: '「種目を追加」が見つかりませんでした' };
    addBtn.click();
    await P.sleep(600);

    // 候補は選択中の部位のぶんしか出ない。サイドレイズは「肩」にある
    const category = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '肩');
    if (!category) return { error: '部位「肩」が見つかりませんでした', buttons: [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim()).slice(0, 40) };
    category.click();
    await P.sleep(500);

    const chip = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '+ サイドレイズ');
    if (!chip) return { error: '種目の候補が見つかりませんでした', buttons: [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim()).slice(0, 40) };

    const t0 = performance.now();
    chip.click();
    let uiMs = null;
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      await P.nextPaint();
      if ([...document.querySelectorAll('h3')].some(h => h.innerText.includes('サイドレイズ'))) { uiMs = Math.round(performance.now() - t0); break; }
    }
    await P.sleep(3000);
    return { uiMs, writes: P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url)).length,
      routes: P.since(mark).map(c => c.method + ' ' + c.url.replace(/^https?:\\/\\/[^/]+/, '')) };
  })()`);
}

/** タブ移動が待たされないか */
async function measureTabSwitch(page) {
  await nav(page, 'ホーム');
  await sleep(1000);
  await page.eval(PAGE_HELPERS);
  return page.eval(`(async () => {
    const P = window.__perf;
    const mark = P.mark();
    const out = [];
    for (const name of ['食事', '分析', 'トレーニング', 'ホーム']) {
      const btn = [...document.querySelectorAll('nav button')].find(b => (b.innerText||'').includes(name));
      const before = document.querySelector('main').innerText.slice(0, 80);
      const t0 = performance.now();
      btn.click();
      let ms = null;
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        await P.nextPaint();
        if (document.querySelector('main').innerText.slice(0, 80) !== before) { ms = Math.round(performance.now() - t0); break; }
      }
      out.push({ tab: name, ms });
      await P.sleep(800);
    }
    return { switches: out, writes: P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url)).length };
  })()`);
}

/** 食事の手入力から一覧に出るまで */
async function measureMealAdd(page) {
  await nav(page, '食事');
  await page.waitFor(`document.body.innerText.includes('手動追加')`, { timeoutMs: 20000, label: '食事画面' });
  await page.eval(PAGE_HELPERS);
  await sleep(700);

  await page.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '手動追加');
    if (b) b.click(); return !!b;
  })()`);
  await page.waitFor(`!!document.querySelector('form #meal-name-input')`, { timeoutMs: 20000, label: '手動追加フォーム' });
  await sleep(400);

  return page.eval(`(async () => {
    const P = window.__perf;
    const form = document.querySelector('form');
    const name = form.querySelector('#meal-name-input');
    const unique = 'ベンチ飯' + Math.floor(performance.now());
    P.nativeSet(name, unique);
    P.nativeSet(form.querySelector('#calories-input'), '600');
    P.nativeSet(form.querySelector('#protein-input'), '35');
    P.nativeSet(form.querySelector('#fat-input'), '18');
    P.nativeSet(form.querySelector('#carbs-input'), '60');
    await P.sleep(300);

    const submit = form.querySelector('button[type=submit]');
    if (!submit) return { error: '保存ボタンが見つかりませんでした' };

    const mark = P.mark();
    const t0 = performance.now();
    submit.click();

    // **一覧に出たか**で判定する。
    // 「✓ 記録しました」の吹き出しは保存の成否と関係なく即座に出るので、
    // これを数えると offline でも成功に見えてしまう（一覧の行だけが実体）
    const inList = () => [...document.querySelectorAll('[role=button]')]
      .some(el => (el.innerText || '').includes(unique));
    const inToast = () => document.body.innerText.includes(unique);

    let listedMs = null;
    let toastMs = null;
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      await P.nextPaint();
      if (toastMs === null && inToast()) toastMs = Math.round(performance.now() - t0);
      if (inList()) { listedMs = Math.round(performance.now() - t0); break; }
    }
    await P.sleep(2500);
    return {
      listedMs, toastMs, unique,
      stillListed: inList(),
      writes: P.since(mark).filter(c => /\\/api\\/v1\\//.test(c.url)).length,
      routes: P.since(mark).map(c => c.method + ' ' + c.url.replace(/^https?:\\/\\/[^/]+/, '')),
    };
  })()`);
}

/**
 * サーバー障害中の記録が、**再読み込みをまたいで残り、復旧後に自動で送られる**か。
 *
 * ここが今回の肝。通信ごと切ると画面の再読み込み自体ができないので、
 * 「サーバーだけが落ちている」状態（書き込みが 503）で試す。
 *
 *   1. 書き込みを 503 にする
 *   2. 食事を1件足す → 画面には残るはず
 *   3. 再読み込み       → **送信待ちが消えていないか**
 *   4. サーバーを戻す   → 自動で送られるか
 *   5. 同じ冪等キーが2回届いていないか（二重登録の確認）
 */
async function measureDurability(page) {
  await lab.fail(true);

  const added = await measureMealAdd(page).catch(e => ({ error: String(e.message ?? e) }));
  if (added.error) { await lab.fail(false); return { error: added.error }; }

  const readOutbox = `(() => {
    try {
      const raw = localStorage.getItem('outbox:v1');
      if (!raw) return { ops: null, keys: Object.keys(localStorage).filter(k => /outbox/i.test(k)) };
      const rec = JSON.parse(raw);
      return { ops: (rec.ops || []).length, keys: Object.keys(localStorage).filter(k => /outbox/i.test(k)) };
    } catch { return { ops: null, keys: [] }; }
  })()`;

  const beforeReload = {
    listedWhileDown: added.listedMs !== null,
    outbox: await page.eval(readOutbox),
  };

  // --- 再読み込み。ここで消えたら「記録したのに無い」になる
  await reloadAndSettle(page);
  await nav(page, '食事');
  await page.waitFor(`document.body.innerText.includes('手動追加')`, { timeoutMs: 20000, label: '食事画面' });
  await sleep(1200);

  const survived = await page.eval(`(() => ({
    inList: [...document.querySelectorAll('[role=button]')].some(el => (el.innerText||'').includes(${JSON.stringify(added.unique)})),
  }))()`);
  const outboxAfterReload = await page.eval(readOutbox);

  // --- サーバーを戻して、自動で送られるか
  await lab.fail(false);
  await page.eval(`(() => { window.dispatchEvent(new Event('online')); return true; })()`);

  // **成功した**書き込みだけを数える。
  // 503 で弾かれた試行もサーバーのログには残るので、status を見ないと
  // 「失敗した送信」を「同期できた」と読み違える
  const accepted = log => log.entries.filter(
    e => e.method === 'POST' && e.path.includes('/meals') && e.name === added.unique && e.status === 200,
  );

  let syncedMs = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (accepted(await lab.log()).length > 0) { syncedMs = Date.now() - t0; break; }
    await sleep(400);
  }

  await sleep(1500);
  const finalLog = await lab.log();
  const outboxFinal = await page.eval(readOutbox);
  const acceptedPosts = accepted(finalLog).length;
  const attemptedPosts = finalLog.entries.filter(
    e => e.method === 'POST' && e.path.includes('/meals') && e.name === added.unique,
  ).length;

  return {
    unique: added.unique,
    ...beforeReload,
    survivedReload: survived.inList,
    outboxAfterReload,
    syncedMs,
    syncedAfterRecovery: syncedMs !== null,
    outboxFinal,
    attemptedPosts,
    acceptedPosts,
    /** 同じ記録が2回サーバーに通っていたら二重登録 */
    duplicateAccepted: acceptedPosts > 1,
  };
}

/** サーバーが落ちているときに新規記録を続けられるか */
async function measureOfflineWrite(page) {
  await page.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  const result = await measureMealAdd(page).catch(e => ({ error: String(e.message ?? e) }));
  const stateAfterReload = await page.eval(`(() => ({ hasOutboxKey: Object.keys(localStorage).some(k => /outbox/i.test(k)) }))()`);
  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  return { ...result, ...stateAfterReload };
}

async function collectLongTasks(page) {
  return page.eval(`(() => (window.__perf ? window.__perf.longTasks.slice() : []))()`);
}

// ------------------------------------------------------------------ 実行

async function runSuite(delayMs) {
  const out = { delayMs };
  const chrome = await launchChrome({ headless: true });

  try {
    const page = await newPage(chrome);

    await lab.reset(delayMs);
    out.coldStart = await measureStartup(page, { withCache: false, delayMs });

    await lab.reset(delayMs);
    out.warmStart = await measureStartup(page, { withCache: true, delayMs });

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    out.goalTyping = await measureGoalTyping(page);

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    await openTodayWorkout(page);
    out.setEdit = await measureSetEdit(page);

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    await openTodayWorkout(page);
    out.rapidSetEdits = await measureRapidSetEdits(page);

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    await openTodayWorkout(page);
    out.addExercise = await measureAddExercise(page);

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    out.tabSwitch = await measureTabSwitch(page);

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    out.mealAdd = await measureMealAdd(page);

    await lab.reset(delayMs);
    await reloadAndSettle(page);
    out.offlineWrite = await measureOfflineWrite(page);

    // 端末に残ったものを持ち越さない（前のシナリオの送信待ちが混ざると読めなくなる）
    await page.send('Storage.clearDataForOrigin', {
      origin: ORIGIN, storageTypes: 'local_storage,indexeddb,cache_storage',
    });
    await lab.reset(delayMs);
    await reloadAndSettle(page);
    out.durability = await measureDurability(page);

    out.longTasks = await collectLongTasks(page);
    out.snapshotBytes = (await lab.log()).snapshotBytes;
    await page.close();
  } finally {
    await chrome.close();
  }
  return out;
}

const report = { label: LABEL, cpuThrottle: CPU_THROTTLE, at: new Date().toISOString(), runs: [] };

for (const delay of [0, 2000]) {
  console.log(`\n########## 人工遅延 ${delay}ms ##########`);
  const result = await runSuite(delay);
  report.runs.push(result);
  console.log(JSON.stringify(result, null, 2));
}

fs.mkdirSync(RESULTS, { recursive: true });
const file = path.join(RESULTS, `${LABEL}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\n[bench] 結果を保存: ${file}`);
