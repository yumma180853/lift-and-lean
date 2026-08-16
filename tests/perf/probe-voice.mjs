/**
 * 話して記録する入口の配線を、実ブラウザで確かめる。
 *
 * 言語モデルは呼ばない（lab-server が決め打ちで返す）。ここで見るのは
 *   - ホームから1タップで開くか
 *   - 送ると結果が出るか／聞き取った文字が出るか
 *   - 食事は取り消せるか
 *   - 消す指示が断られるか
 *   - 曖昧なときに聞き返すか
 *
 *   LAB_ORIGIN=http://127.0.0.1:4322 node tests/perf/probe-voice.mjs
 */

import { launchChrome, Page, sleep } from './cdp.mjs';

const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4322';

await fetch(`${ORIGIN}/__lab/reset?delay=0&fail=0`);

const chrome = await launchChrome({ headless: true });
const page = await Page.attach(chrome.port);
await page.emulateIPhone();
await page.enableFocusEmulation();

await page.goto(`${ORIGIN}/`);
await page.waitFor(`document.body.innerText.includes('日継続中')`, { timeoutMs: 60000, label: '実データ' });
await sleep(800);

const nativeSet = `(el, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

const openSheet = async () => {
  const ok = await page.eval(`(() => {
    const b = document.querySelector('button[aria-label="話して記録"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(500);
  return ok;
};

const say = async phrase => {
  await page.eval(`(() => {
    const set = ${nativeSet};
    const input = document.querySelector('input[placeholder*="キーボード"]');
    if (!input) return false;
    set(input, ${JSON.stringify(phrase)});
    return true;
  })()`);
  await sleep(250);
  await page.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '送信');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1200);
  return page.eval(`(() => {
    const text = document.body.innerText;
    return {
      shows: text.includes('聞き取り：'),
      transcript: (text.match(/聞き取り：(.+)/) || [])[1] || null,
      message: (text.match(/([^\\n]*記録しました[^\\n]*)/) || [])[1]
        || (text.match(/([^\\n]*種目は何ですか[^\\n]*)/) || [])[1]
        || (text.match(/([^\\n]*記録と確認だけ[^\\n]*)/) || [])[1] || null,
      hasUndo: [...document.querySelectorAll('button')].some(b => (b.innerText||'').includes('取り消す')),
    };
  })()`);
};

const close = async () => {
  await page.eval(`(() => {
    const svgBtns = [...document.querySelectorAll('button')];
    const x = svgBtns.find(b => b.className.includes('text-zinc-500') && b.querySelector('svg'));
    if (x) x.click();
    return true;
  })()`);
  await sleep(400);
};

console.log('ホームから1タップで開く ->', await openSheet());

console.log('\n[体重]', JSON.stringify(await say('体重72.4キロ'), null, 1));

await close(); await openSheet();
console.log('\n[食事・取り消しあり]', JSON.stringify(await say('昼に牛丼並'), null, 1));

// 取り消しを押す
const undoResult = await page.eval(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').includes('取り消す'));
  if (!btn) return { clicked: false };
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  return { clicked: true, shows: document.body.innerText.includes('取り消しました') };
})()`);
console.log('[取り消し]', JSON.stringify(undoResult));

await close(); await openSheet();
console.log('\n[曖昧]', JSON.stringify(await say('60キロ10回'), null, 1));

await close(); await openSheet();
console.log('\n[削除は断る]', JSON.stringify(await say('今日の食事を全部削除して'), null, 1));

await page.close();
await chrome.close();
