/**
 * 画面の中身を調べるための下見スクリプト。
 * 計測シナリオを書く前に、どのタブにどんな要素があるかを実ブラウザで確認する。
 */

import { launchChrome, Page, sleep } from './cdp.mjs';

const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4321';

const chrome = await launchChrome({ headless: true });
const page = await Page.attach(chrome.port);
await page.emulateIPhone();

await page.goto(`${ORIGIN}/`);
await sleep(2500);

const describe = async label => {
  const info = await page.eval(`(() => {
    const text = document.body.innerText.slice(0, 700);
    const inputs = [...document.querySelectorAll('input,textarea,select')].map(el => ({
      tag: el.tagName, type: el.type, placeholder: el.placeholder,
      value: String(el.value).slice(0, 20), inputMode: el.inputMode,
      cls: String(el.className).slice(0, 60),
    }));
    const buttons = [...document.querySelectorAll('button')].map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 24)).filter(Boolean);
    return { text, inputs, buttons };
  })()`);
  console.log(`\n================ ${label} ================`);
  console.log('[text]', JSON.stringify(info.text));
  console.log('[inputs]', JSON.stringify(info.inputs, null, 1));
  console.log('[buttons]', JSON.stringify(info.buttons));
};

await describe('dashboard (起動直後)');

const clickByText = async text => {
  const ok = await page.eval(`(() => {
    const target = [...document.querySelectorAll('button')].find(b => (b.innerText||'').includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await sleep(900);
  return ok;
};

console.log('\nnav トレーニング ->', await clickByText('トレーニング'));
await describe('workout 一覧');

console.log('\n今日のトレーニングを開く ->', await clickByText('今日のトレーニング'));
await describe('workout 詳細');

console.log('\nnav 食事 ->', await clickByText('食事'));
await describe('diet');

await page.close();
await chrome.close();
