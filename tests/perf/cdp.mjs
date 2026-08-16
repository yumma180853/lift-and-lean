/**
 * 依存なしの Chrome DevTools Protocol クライアント。
 *
 * Playwright を入れずに実ブラウザで測るための最小限の道具。
 * Node 22 以降の組み込み WebSocket を使う。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome が見つかりませんでした。');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* まだ起動していない */ }
    await sleep(120);
  }
  throw new Error('Chrome の DevTools に接続できませんでした。');
}

export async function launchChrome({ port = 9333, headless = true, mobile = true } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-perf-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,BackForwardCache',
    '--hide-scrollbars',
    '--mute-audio',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  if (mobile) args.push('--window-size=390,844');
  args.push('about:blank');

  const proc = spawn(findChrome(), args, { stdio: 'ignore', detached: false });
  await waitForDevTools(port);
  return {
    proc,
    port,
    async close() {
      try { proc.kill('SIGKILL'); } catch { /* 既に終了している */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 消せなくても実害なし */ }
    },
  };
}

/** ページ1枚ぶんの CDP セッション */
export class Page {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? null)})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  static async attach(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let target = targets.find(t => t.type === 'page');
    if (!target) {
      target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP の WebSocket に接続できませんでした。')), { once: true });
    });
    const page = new Page(ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    return page;
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP がタイムアウトしました: ${method}`));
        }
      }, 60000);
    });
  }

  /** iPhone 相当の画面と UA にする */
  async emulateIPhone() {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await this.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  /** 実機のミドルレンジ端末に近づけるための CPU 減速 */
  async throttleCpu(rate = 4) {
    await this.send('Emulation.setCPUThrottlingRate', { rate });
  }

  /**
   * ページを「フォーカスされている」扱いにする。
   *
   * headless では OS のフォーカスが無いため、`el.blur()` を呼んでも
   * blur / focusout が**一切発火しない**。入力確定を onBlur で拾う画面
   * （セットの重量・回数）は、これを入れないと「保存されていない」ように見える。
   * 実機では当然フォーカスがあるので、こちらが実態に近い。
   */
  async enableFocusEmulation() {
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  async goto(url, { waitUntil = 'load' } = {}) {
    const loaded = new Promise(resolve => {
      const handler = () => resolve();
      this.on(waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired', handler);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`ページ内でエラー: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeoutMs = 20000, intervalMs = 50, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.eval(`(() => { try { return !!(${expression}); } catch { return false; } })()`);
      if (ok) return true;
      await sleep(intervalMs);
    }
    throw new Error(`条件が満たされませんでした: ${label}`);
  }

  async clearStorage(origin) {
    await this.send('Storage.clearDataForOrigin', {
      origin, storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql,cookies',
    });
  }

  async close() {
    try { this.ws.close(); } catch { /* すでに閉じている */ }
  }
}

export { sleep };
