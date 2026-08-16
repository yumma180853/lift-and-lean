/**
 * 遅延実験用のサーバー（latency lab）。
 *
 * 本番の Appwrite は使わない。`/api/v1/*` を**人工遅延つき**で再現し、
 * 「サーバーが遅いとき、画面がどれだけ待たされるか」だけを取り出して測る。
 *
 * - `LAB_DELAY_MS`  … すべての API 応答に足す遅延（既定 0）
 * - `LAB_PORT`      … 待ち受けポート（既定 4321）
 * - `LAB_DATASET`   … `small` | `halfyear`（既定 halfyear）
 *
 * 制御用エンドポイント:
 *   GET  /__lab/reset?delay=2000&dataset=halfyear   実験のやり直し
 *   GET  /__lab/reset?fail=1                        書き込みだけ 503 にする
 *   GET  /__lab/log                                 受けたリクエストの一覧
 *
 * `fail=1` は「サーバーだけが落ちている」状態を作るためのもの。
 * 通信ごと切ると画面の再読み込み自体ができないので、
 * **再読み込みしても送信待ちが残るか**を試すにはこちらを使う。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../dist');

const PORT = Number(process.env.LAB_PORT ?? 4321);

const state = {
  delayMs: Number(process.env.LAB_DELAY_MS ?? 0),
  dataset: process.env.LAB_DATASET ?? 'halfyear',
  /** true の間、書き込み系の API だけ 503 を返す（サーバー障害の再現） */
  failWrites: false,
  log: [],
  data: null,
};

// ------------------------------------------------------------------ データ生成

const pad = n => String(n).padStart(2, '0');
const dayString = (base, offset) => {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const EXERCISES = ['ベンチプレス', 'インクラインダンベルプレス', 'ラットプルダウン', 'スクワット', 'ショルダープレス', 'アームカール'];
const MEALS = ['牛丼 並', '鶏むね肉 200g', 'プロテイン', '白米 200g', 'サラダチキン', '納豆定食'];

/** 半年ぶんの現実的な量。実機で重くなるのはこのくらいから */
function buildDataset(kind) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = kind === 'small' ? 7 : 180;

  const meals = [];
  const weights = [];
  const workouts = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = dayString(today, -i);

    for (let m = 0; m < 3; m++) {
      meals.push({
        id: `meal-${i}-${m}`,
        date,
        name: MEALS[(i + m) % MEALS.length],
        calories: 400 + ((i * 7 + m * 31) % 500),
        protein: 20 + ((i * 3 + m) % 40),
        fat: 8 + ((i + m * 5) % 25),
        carbs: 40 + ((i * 5 + m * 11) % 80),
        mealType: ['breakfast', 'lunch', 'dinner'][m],
        servingLabel: '1人前',
        sourceType: 'manual',
      });
    }

    if (i % 3 !== 0) {
      weights.push({ id: `w-${i}`, date, weight: Math.round((72 + Math.sin(i / 9) * 1.8) * 10) / 10 });
    }

    // 週4回くらい筋トレ
    if (i % 7 < 4) {
      const exercises = [];
      const count = 3 + (i % 3);
      for (let e = 0; e < count; e++) {
        const sets = [];
        const setCount = 3 + (e % 2);
        for (let s = 0; s < setCount; s++) {
          sets.push({ id: `set-${i}-${e}-${s}`, weight: 40 + ((i + e * 5 + s * 2) % 60), reps: 6 + ((i + s) % 7) });
        }
        exercises.push({ id: `ex-${i}-${e}`, name: EXERCISES[(i + e) % EXERCISES.length], sets });
      }
      workouts.push({ id: `day-${i}`, date, exercises });
    }
  }

  return {
    meals,
    weights,
    workouts,
    goals: { calories: 2400, protein: 160, fat: 65, carbs: 260, targetWeight: 70, trainerStyle: 'buddy' },
    profile: {
      hiddenWorkoutDates: [],
      freezeUsedDates: [],
      customExerciseCategories: { 'ベンチプレス': '胸', 'スクワット': '脚' },
      longestStreak: 42,
    },
    today: dayString(today, 0),
  };
}

state.data = buildDataset(state.dataset);

// ------------------------------------------------------------------ 応答の道具

const sleep = ms => new Promise(r => setTimeout(r, ms));

let rowSeq = 0;
const nextRowId = () => `srv-${Date.now().toString(36)}-${++rowSeq}`;

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA なので不明なパスは index.html
    const index = path.join(DIST, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(500).end('dist/index.html がありません。先に `npx vite build` を実行してください。');
      return;
    }
    const body = fs.readFileSync(index);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
    res.end(body);
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve({ raw, json: raw ? JSON.parse(raw) : null }); }
      catch { resolve({ raw, json: null }); }
    });
  });
}

// ------------------------------------------------------------------ API

async function handleApi(req, res, url) {
  const started = Date.now();
  const { raw, json } = await readBody(req);
  const route = url.pathname.replace('/api/v1', '');
  const entry = {
    at: started,
    method: req.method,
    path: url.pathname,
    requestBytes: Buffer.byteLength(raw),
    clientRequestId: json?.clientRequestId ?? null,
    // どの記録が届いたかを名前で追えるようにする（再接続後の自動送信の確認用）
    name: typeof json?.name === 'string' ? json.name : null,
  };

  await sleep(state.delayMs);

  const reply = (status, body) => {
    entry.status = status;
    entry.responseBytes = Buffer.byteLength(JSON.stringify(body));
    entry.durationMs = Date.now() - started;
    state.log.push(entry);
    sendJson(res, status, body);
  };

  if (route === '/auth/me') {
    return reply(200, { userId: 'lab-user-1', email: 'lab@example.com', name: 'Lab', emailVerified: true });
  }
  if (route === '/auth/logout') return reply(200, { ok: true });
  if (route === '/snapshot') return reply(200, state.data);

  // ここから先は書き込み。サーバー障害の再現中は一律で失敗させる
  if (state.failWrites && req.method !== 'GET') {
    return reply(503, { error: 'lab: server unavailable', code: 'unavailable' });
  }

  /**
   * 音声・文字の指示。実験では言語モデルを呼ばず、決め打ちで振り分ける。
   * 画面の配線（送る→結果が出る→取り消せる）だけを確かめるためのもの。
   */
  if (route === '/command' && req.method === 'POST') {
    const said = String(json?.text ?? '');
    if (/削除|消して/.test(said)) {
      return reply(200, {
        status: 'unsupported',
        message: '音声からは記録と確認だけができます。削除や設定変更は画面から操作してください。',
        transcript: said,
      });
    }
    if (/^\d+キロ\d+回$/.test(said) || said === '60キロ10回') {
      return reply(200, { status: 'clarify', message: '種目は何ですか？', transcript: said });
    }
    if (/体重/.test(said)) {
      return reply(200, {
        status: 'done', intent: 'log_weight',
        message: '体重 72.4kg を記録しました。同じ日に再度記録すると上書きされます。',
        data: { recorded: true }, transcript: said,
      });
    }
    if (/牛丼|食べ|昼|朝|夜/.test(said)) {
      return reply(200, {
        status: 'done', intent: 'log_meal',
        message: '牛丼 並 を記録しました（635kcal / P20g F20g C90g）。',
        data: { recorded: true, rowId: 'lab-meal-1' },
        undo: { kind: 'meal', rowId: 'lab-meal-1' },
        transcript: said,
      });
    }
    return reply(200, {
      status: 'done', intent: 'log_workout',
      message: 'ベンチプレス を記録しました（1種目 / 3セット）。',
      data: { exercises: 1, sets: 3 }, transcript: said,
    });
  }

  if (route === '/meals' && req.method === 'POST') return reply(200, { rowId: nextRowId() });
  if (/^\/meals\/[^/]+$/.test(route)) return reply(200, { ok: true });
  if (route === '/weights' && req.method === 'POST') return reply(200, { rowId: nextRowId() });
  if (route === '/exercises' && req.method === 'POST') return reply(200, { rowId: nextRowId() });
  if (/^\/exercises\/[^/]+\/sets$/.test(route) && req.method === 'POST') return reply(200, { rowId: nextRowId() });
  if (/^\/exercises\/[^/]+$/.test(route)) return reply(200, { ok: true });
  if (/^\/sets\/[^/]+$/.test(route)) return reply(200, { ok: true });
  if (route === '/goals') return reply(200, { ok: true });
  if (route === '/profile') return reply(200, { ok: true });

  return reply(404, { error: 'not found', code: 'not_found' });
}

// ------------------------------------------------------------------ サーバー

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/__lab/reset') {
    state.log = [];
    if (url.searchParams.has('delay')) state.delayMs = Number(url.searchParams.get('delay'));
    if (url.searchParams.has('fail')) state.failWrites = url.searchParams.get('fail') === '1';
    if (url.searchParams.has('dataset')) {
      state.dataset = url.searchParams.get('dataset');
      state.data = buildDataset(state.dataset);
    }
    return sendJson(res, 200, {
      ok: true, delayMs: state.delayMs, dataset: state.dataset, failWrites: state.failWrites,
    });
  }
  /** ログを消さずに障害の有無だけ切り替える（再接続の検証で使う） */
  if (url.pathname === '/__lab/fail') {
    state.failWrites = url.searchParams.get('on') === '1';
    return sendJson(res, 200, { ok: true, failWrites: state.failWrites });
  }
  if (url.pathname === '/__lab/log') {
    // 同じ冪等キーを2回受け取っていたら、それは二重登録になりうる送信
    const byKey = {};
    for (const e of state.log) {
      if (!e.clientRequestId) continue;
      byKey[e.clientRequestId] = (byKey[e.clientRequestId] ?? 0) + 1;
    }
    const duplicated = Object.entries(byKey).filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, times: n }));
    return sendJson(res, 200, {
      delayMs: state.delayMs,
      dataset: state.dataset,
      failWrites: state.failWrites,
      count: state.log.length,
      writeCount: state.log.filter(e => e.method !== 'GET').length,
      duplicated,
      snapshotBytes: Buffer.byteLength(JSON.stringify(state.data)),
      entries: state.log,
    });
  }

  if (url.pathname.startsWith('/api/v1/')) return handleApi(req, res, url);

  // 実験に関係ない API は素通りさせる（画面が壊れないように）
  if (url.pathname.startsWith('/api/')) {
    await readBody(req);
    return sendJson(res, 200, { ok: true });
  }

  serveStatic(res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[lab] http://127.0.0.1:${PORT}  delay=${state.delayMs}ms dataset=${state.dataset}`);
  console.log(`[lab] snapshot bytes = ${Buffer.byteLength(JSON.stringify(state.data))}`);
});
