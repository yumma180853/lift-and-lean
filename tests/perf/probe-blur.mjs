/**
 * セット編集が送信されない理由の切り分け。
 *
 *   仮説A: プログラムからの blur() では React の onBlur が動いていない
 *   仮説B: onBlur は動いているが、保存側でエラーになっている（画面に警告が出る）
 *
 *   node tests/perf/probe-blur.mjs
 */

import { launchChrome, Page, sleep } from './cdp.mjs';

const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4321';

const chrome = await launchChrome({ headless: true });
const page = await Page.attach(chrome.port);
await page.emulateIPhone();
await page.enableFocusEmulation();

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
      banner: () => {
        const t = document.body.innerText;
        const i = t.indexOf('保存できませんでした');
        return i === -1 ? null : t.slice(i, i + 90);
      },
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
await click('トレーニング');
await click('今日のトレーニング');
await sleep(1200);

// 仮説A: onBlur が発火しているかを、直接 listener を付けて確かめる
const attach = await page.eval(`(() => {
  const el = document.querySelectorAll('input[type=number]')[0];
  window.__seen = { blur: 0, focusout: 0, change: 0 };
  el.addEventListener('blur', () => window.__seen.blur++);
  el.addEventListener('focusout', () => window.__seen.focusout++);
  el.addEventListener('change', () => window.__seen.change++);
  return true;
})()`);
console.log('listener 設置 ->', attach);

const A = await page.eval(`(async () => {
  const P = window.__probe;
  const el = document.querySelectorAll('input[type=number]')[0];
  const before = String(el.value);
  const mark = P.mark();
  el.focus();
  P.nativeSet(el, String(Number(before) + 12.5));
  await P.sleep(120);
  el.blur();
  await P.sleep(3000);
  return {
    before,
    events: { ...window.__seen },
    calls: P.since(mark),
    banner: P.banner(),
    shown: String(document.querySelectorAll('input[type=number]')[0].value),
  };
})()`);
console.log('\n[A: focus/blur]', JSON.stringify(A, null, 1));

// 仮説A の裏取り: 実キーボードの Enter（handleKeyDown -> blur）でどうなるか
const B = await page.eval(`(() => {
  const el = document.querySelectorAll('input[type=number]')[1];
  el.focus();
  return { focused: document.activeElement === el, value: String(el.value) };
})()`);
console.log('\n[B: 2つ目にfocus]', JSON.stringify(B));

await page.eval(`(() => {
  const P = window.__probe;
  window.__markB = P.mark();
  const el = document.querySelectorAll('input[type=number]')[1];
  P.nativeSet(el, '9');
  return true;
})()`);
await sleep(150);
// 本物のキー入力として Enter を送る
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(3000);
const Bres = await page.eval(`(() => ({
  calls: window.__probe.since(window.__markB),
  banner: window.__probe.banner(),
  shown: String(document.querySelectorAll('input[type=number]')[1].value),
}))()`);
console.log('[B: Enterで確定]', JSON.stringify(Bres, null, 1));

await page.close();
await chrome.close();
