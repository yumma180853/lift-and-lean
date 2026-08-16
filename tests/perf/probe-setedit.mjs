/**
 * セット編集と種目追加の下見。
 *
 * before 計測で
 *   - setEdit の書き込みが 0 件だった
 *   - 種目追加が「候補が見つからない」で失敗した
 * ため、実ブラウザで何が起きているかを確かめる。
 *
 *   node tests/perf/probe-setedit.mjs
 */

import { launchChrome, Page, sleep } from './cdp.mjs';

const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4321';

const chrome = await launchChrome({ headless: true });
const page = await Page.attach(chrome.port);
await page.emulateIPhone();

const HELPERS = `
(() => {
  if (!window.__probe) {
    const calls = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (url.includes('/api/')) calls.push({ method, url: String(url) });
      return origFetch(input, init);
    };
    window.__probe = {
      calls,
      mark: () => calls.length,
      since: n => calls.slice(n).map(c => c.method + ' ' + c.url.replace(/^https?:\\/\\/[^/]+/, '')),
      nativeSet: (el, value) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      sleep: ms => new Promise(r => setTimeout(r, ms)),
    };
  }
  return true;
})()
`;

await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
await page.goto(`${ORIGIN}/`);
await page.waitFor(`document.body.innerText.includes('日継続中')`, { timeoutMs: 60000, label: '実データ' });
await page.eval(HELPERS);

const click = async text => {
  const ok = await page.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes(${JSON.stringify(text)}));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(900);
  return ok;
};

console.log('nav トレーニング ->', await click('トレーニング'));
console.log('今日のトレーニング ->', await click('今日のトレーニング'));
await sleep(1200);

// --- いまの画面の入力欄を全部見る
const inputs = await page.eval(`(() => [...document.querySelectorAll('input[type=number]')].map((el, i) => ({
  i, value: String(el.value), step: el.step,
  card: (el.closest('.ll-card')?.querySelector('h3')?.innerText || '').slice(0, 20),
})))()`);
console.log('\n[number inputs]', JSON.stringify(inputs, null, 1));

// --- セット編集：focus → 値変更 → blur で本当に送信されるか
const setEdit = await page.eval(`(async () => {
  const P = window.__probe;
  const el = document.querySelectorAll('input[type=number]')[0];
  if (!el) return { error: 'input なし' };
  const before = String(el.value);
  const target = String(Number(before) + 12.5);

  const mark = P.mark();
  el.focus();
  const focusedAfterFocus = document.activeElement === el;
  P.nativeSet(el, target);
  await P.sleep(100);
  const valueAfterSet = String(document.querySelectorAll('input[type=number]')[0].value);
  el.blur();
  const focusedAfterBlur = document.activeElement === el;
  await P.sleep(3000);

  return {
    before, target, valueAfterSet,
    focusedAfterFocus, focusedAfterBlur,
    finalShown: String(document.querySelectorAll('input[type=number]')[0].value),
    callsAfter: P.since(mark),
    hasFocusDoc: document.hasFocus(),
  };
})()`);
console.log('\n[setEdit]', JSON.stringify(setEdit, null, 1));

// --- 種目追加：カテゴリを切り替えて候補が出るか
const addEx = await page.eval(`(async () => {
  const P = window.__probe;
  const addBtn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').includes('種目を追加'));
  if (!addBtn) return { error: '「種目を追加」なし' };
  addBtn.click();
  await P.sleep(700);

  const catButtons = [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim());
  const shoulder = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '肩');
  if (!shoulder) return { error: '肩カテゴリなし', catButtons };
  shoulder.click();
  await P.sleep(700);

  const chips = [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(t => t.startsWith('+ '));
  const target = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '+ サイドレイズ');
  if (!target) return { error: 'サイドレイズなし', chips };

  const mark = P.mark();
  target.click();
  let uiMs = null;
  const t0 = performance.now();
  const deadline = t0 + 12000;
  while (performance.now() < deadline) {
    await P.sleep(30);
    if ([...document.querySelectorAll('h3')].some(h => h.innerText.includes('サイドレイズ'))) { uiMs = Math.round(performance.now() - t0); break; }
  }
  await P.sleep(2500);
  return { chips, uiMs, callsAfter: P.since(mark) };
})()`);
console.log('\n[addExercise]', JSON.stringify(addEx, null, 1));

await page.close();
await chrome.close();
