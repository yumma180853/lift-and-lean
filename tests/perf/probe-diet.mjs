import { launchChrome, Page, sleep } from './cdp.mjs';

const ORIGIN = process.env.LAB_ORIGIN ?? 'http://127.0.0.1:4321';
const chrome = await launchChrome({ headless: true });
const page = await Page.attach(chrome.port);
await page.emulateIPhone();
await page.goto(`${ORIGIN}/`);
await sleep(2500);

await page.eval(`(() => { [...document.querySelectorAll('nav button')].find(b => (b.innerText||'').includes('食事')).click(); return true; })()`);
await sleep(1500);

const info = await page.eval(`(() => ({
  text: document.body.innerText.slice(0, 1800),
  inputs: [...document.querySelectorAll('input,textarea')].map(el => ({ tag: el.tagName, type: el.type, ph: el.placeholder, val: String(el.value).slice(0,12) })),
  buttons: [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,20)).filter(Boolean),
  forms: document.querySelectorAll('form').length,
}))()`);
console.log('=== DIET ===');
console.log(info.text);
console.log('inputs:', JSON.stringify(info.inputs, null, 1));
console.log('buttons:', JSON.stringify(info.buttons));
console.log('forms:', info.forms);

// 手入力タブを探して押す
const pressed = await page.eval(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /手入力|自分で|マニュアル/.test(x.innerText||''));
  if (b) { b.click(); return b.innerText.trim(); }
  return null;
})()`);
console.log('\npressed:', pressed);
await sleep(1200);

const after = await page.eval(`(() => ({
  text: document.body.innerText.slice(0, 1200),
  inputs: [...document.querySelectorAll('input,textarea')].map(el => ({ type: el.type, ph: el.placeholder, val: String(el.value).slice(0,12) })),
  buttons: [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,20)).filter(Boolean),
}))()`);
console.log('=== AFTER ===');
console.log(after.text);
console.log('inputs:', JSON.stringify(after.inputs, null, 1));
console.log('buttons:', JSON.stringify(after.buttons));

await page.close();
await chrome.close();
