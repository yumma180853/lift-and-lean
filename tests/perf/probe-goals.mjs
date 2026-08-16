/**
 * 目標値を打ったあと、いつ送信されるかを長めに観察する。
 *
 * ベンチでは「2秒遅延のとき4.5秒待っても1件も送られない」ように見えた。
 * 送信権（lease）が前のページから残っていて詰まっている疑いを確かめる。
 *
 *   LAB_ORIGIN=http://127.0.0.1:4322 node tests/perf/probe-goals.mjs
 */

import { launchChrome, Page, sleep } from './cdp.mjs';

const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4322';
const DELAY = Number(process.env.DELAY ?? 2000);

const HELPERS = `
(() => {
  if (!window.__p) {
    const calls = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (url.includes('/api/')) calls.push({ at: Math.round(performance.now()), method, url: String(url).replace(/^https?:\\/\\/[^/]+/, '') });
      return origFetch(input, init);
    };
    window.__p = {
      calls,
      nativeSet: (el, value) => {
        const proto = HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      snap: () => ({
        outbox: (() => { try { const r = JSON.parse(localStorage.getItem('outbox:v1')); return r ? r.ops.length : null; } catch { return null; } })(),
        lease: (() => { try { return JSON.parse(localStorage.getItem('outbox:lease:v1')); } catch { return null; } })(),
        now: Date.now(),
      }),
    };
  }
  return true;
})()
`;

await fetch(`${ORIGIN}/__lab/reset?delay=${DELAY}&fail=0`);

const chrome = await launchChrome({ headless: true });
const page = await Page.attach(chrome.port);
await page.emulateIPhone();
await page.enableFocusEmulation();
// ベンチと同じ条件にする（CPU 4分の1）
if (Number(process.env.CPU ?? 4) > 1) await page.throttleCpu(Number(process.env.CPU ?? 4));
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });

// 1回目：控えを作る
await page.goto(`${ORIGIN}/`);
await page.waitFor(`document.body.innerText.includes('日継続中')`, { timeoutMs: 60000, label: '実データ' });
await sleep(2500);

console.log('--- 1回目のあとの状態 ---', JSON.stringify(await page.eval(`window.__p.snap()`)));

// 2回目：ベンチと同じく、読み込み直してから設定画面で打つ
await page.send('Page.navigate', { url: `${ORIGIN}/` });
await page.waitFor(`document.body.innerText.includes('日継続中')`, { timeoutMs: 60000, label: '実データ' });
await page.eval(HELPERS);

console.log('--- 再読み込み直後 ---', JSON.stringify(await page.eval(`window.__p.snap()`)));

await page.eval(`(() => {
  const b = [...document.querySelectorAll('nav button')].find(x => (x.innerText||'').includes('設定'));
  if (b) b.click(); return !!b;
})()`);
await page.waitFor(`!!document.querySelector('input[type=number]')`, { timeoutMs: 20000, label: '設定画面' });
await sleep(600);
await page.eval(HELPERS);

const result = await page.eval(`(async () => {
  const P = window.__p;
  const input = document.querySelector('input[type=number]');
  input.focus();
  const before = P.calls.length;
  for (const v of ['1', '18', '185', '1850']) {
    P.nativeSet(input, v);
    await P.sleep(120);
  }
  input.blur();

  // 20秒かけて、いつ送られるかを見る
  const timeline = [];
  for (let i = 0; i < 20; i++) {
    await P.sleep(1000);
    const s = P.snap();
    timeline.push({
      sec: i + 1,
      outboxOps: s.outbox,
      leaseOwner: s.lease ? s.lease.owner.slice(0, 12) : null,
      leaseExpiresInMs: s.lease ? s.lease.expiresAt - s.now : null,
      newCalls: P.calls.slice(before).map(c => c.method + ' ' + c.url),
    });
  }
  return { shown: String(document.querySelector('input[type=number]').value), timeline };
})()`);

console.log('\n最終表示:', result.shown);
for (const t of result.timeline) {
  console.log(`${String(t.sec).padStart(2)}s  outbox=${t.outboxOps}  lease=${t.leaseOwner ?? '-'} (${t.leaseExpiresInMs ?? '-'}ms)  calls=${JSON.stringify(t.newCalls)}`);
}

await page.close();
await chrome.close();
