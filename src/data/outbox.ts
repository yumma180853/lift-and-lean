/**
 * 端末に置く「作業中の状態」。
 *
 * 保存するのは2つだけ:
 *   base    … 最後にサーバーから受け取ったスナップショット（＝サーバーが知っている内容）
 *   pending … まだ送れていない操作の列（outbox）
 *
 * 画面に出す状態は **replay(base, pending)** で毎回計算する。
 *
 * ## なぜ「計算後の状態」を保存しないのか
 * 計算後の状態と pending の両方を保存すると、次に開いたときに
 * 「すでに反映済みの状態」へ pending をもう一度重ねてしまう（二重計上）。
 * base と pending だけを持てば、何度読み直しても答えは同じになる。
 *
 * ## なぜ端末に残すのか
 * 送信前にアプリを閉じても記録が消えないため。電車で圏外のまま
 * ホーム画面に戻して、あとで開いたら送られている、という状態にしたい。
 *
 * ## 書き込みの重さについて
 * base は半年ぶんで 190KB ほどになる。これを操作のたびに JSON 化すると
 * 画面を動かしている糸（UIスレッド）が持っていかれる。
 * **pending は毎回すぐ書き（記録が消えては困る）、base は少し間引いて書く。**
 * base はサーバーから取り直せるので、多少古くても実害が無い。
 */

import type { AppData } from './types';
import type { IdMap, Op } from './ops';

const BASE_KEY = 'cache:cloud-snapshot:v2';
const OUTBOX_KEY = 'outbox:v1';
const LEASE_KEY = 'outbox:lease:v1';

/** 旧版（v1）の控え。移行のためだけに読む */
const LEGACY_BASE_KEY = 'cache:cloud-snapshot:v1';

interface BaseRecord {
  userId: string;
  savedAt: string;
  data: AppData;
}

export interface OutboxRecord {
  userId: string;
  ops: Op[];
  /** 端末が仮に決めた id → サーバーが決めた id */
  idMap: IdMap;
  /** 送信できないまま諦めた操作（利用者に知らせるため残す） */
  failed: { op: Op; error: string }[];
}

const emptyOutbox = (userId: string): OutboxRecord => ({ userId, ops: [], idMap: {}, failed: [] });

// ---------------------------------------------------------------- base（サーバーの内容）

export function readBase(userId: string): AppData | null {
  try {
    const raw = localStorage.getItem(BASE_KEY);
    if (raw) {
      const record = JSON.parse(raw) as BaseRecord;
      return record.userId === userId ? record.data : null;
    }
    // v1 の控えがあれば引き継ぐ（更新直後に画面が空になるのを防ぐ）
    const legacy = localStorage.getItem(LEGACY_BASE_KEY);
    if (legacy) {
      const record = JSON.parse(legacy) as BaseRecord;
      return record.userId === userId ? record.data : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeBase(userId: string, data: AppData): void {
  try {
    const record: BaseRecord = { userId, savedAt: new Date().toISOString(), data };
    localStorage.setItem(BASE_KEY, JSON.stringify(record));
  } catch {
    // 控えが書けなくても本体の動作は続く（次の起動が遅くなるだけ）
  }
}

/**
 * base の書き込みを少し待ってからまとめて行う。
 *
 * 送信待ちを連続で捌くと、そのたびに 190KB の JSON 化が走って画面が固まる。
 * 最後の1回だけ書けば十分なので、間引く。
 */
let baseTimer: ReturnType<typeof setTimeout> | null = null;
let baseQueued: { userId: string; data: AppData } | null = null;

export function writeBaseSoon(userId: string, data: AppData, delayMs = 1200): void {
  baseQueued = { userId, data };
  if (baseTimer) return;
  baseTimer = setTimeout(() => {
    baseTimer = null;
    const queued = baseQueued;
    baseQueued = null;
    if (queued) writeBase(queued.userId, queued.data);
  }, delayMs);
}

/** 画面を閉じる直前など、待っていられないときに書き切る */
export function flushBase(): void {
  if (baseTimer) { clearTimeout(baseTimer); baseTimer = null; }
  const queued = baseQueued;
  baseQueued = null;
  if (queued) writeBase(queued.userId, queued.data);
}

// ---------------------------------------------------------------- outbox（送信待ち）

export function readOutbox(userId: string): OutboxRecord {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return emptyOutbox(userId);
    const record = JSON.parse(raw) as OutboxRecord;
    // 別のアカウントで入り直したときに、前の人の送信待ちを送ってしまわない
    if (record.userId !== userId) return emptyOutbox(userId);
    return {
      userId,
      ops: Array.isArray(record.ops) ? record.ops : [],
      idMap: record.idMap ?? {},
      failed: Array.isArray(record.failed) ? record.failed : [],
    };
  } catch {
    return emptyOutbox(userId);
  }
}

/**
 * 送信待ちを書き出す。
 *
 * **ここが書けないことは「記録が消える」ことを意味する**ので、
 * 握りつぶさず呼び出し元へ返す（画面に「保存できていない」と出すため）。
 */
export function writeOutbox(record: OutboxRecord): boolean {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * まだサーバーへ送れていない記録の件数。
 *
 * ログアウトは端末の控えを消す操作なので、**黙って捨てないため**に使う。
 * 誰のものかは問わない（消える対象そのものを数える）。
 */
export function storedPendingCount(): number {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return 0;
    const record = JSON.parse(raw) as OutboxRecord;
    const ops = Array.isArray(record.ops) ? record.ops.length : 0;
    const failed = Array.isArray(record.failed) ? record.failed.length : 0;
    return ops + failed;
  } catch {
    return 0;
  }
}

export function clearStored(): void {
  if (baseTimer) { clearTimeout(baseTimer); baseTimer = null; }
  baseQueued = null;
  try {
    localStorage.removeItem(BASE_KEY);
    localStorage.removeItem(LEGACY_BASE_KEY);
    localStorage.removeItem(OUTBOX_KEY);
    localStorage.removeItem(LEASE_KEY);
  } catch {
    // 消せなくても実害はない
  }
}

// ---------------------------------------------------------------- 複数タブ

/** このタブの識別子。タブごとに違う値になればよい */
export const TAB_ID = `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

interface Lease {
  owner: string;
  expiresAt: number;
}

/**
 * 送信権の有効期間。持ち主のタブが落ちても、これだけ待てば他が引き取れる。
 *
 * 短すぎると送信中に横取りされ、長すぎると再読み込みのあと送信が止まる。
 * 送信中は1件ごとに期限を延ばすので、1往復ぶん待てれば足りる。
 */
const LEASE_TTL_MS = 8_000;

/**
 * 送信権を取りにいく。
 *
 * 同じ送信待ちを2つのタブが同時に流すと、サーバーへ二重に届く。
 * 冪等キーがあるので二重登録にはならないが、無駄な往復と紛らわしい失敗が増える。
 * **一度に送るタブは1つ**にする。
 */
export function acquireLease(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (raw) {
      const lease = JSON.parse(raw) as Lease;
      // 他のタブが持っていて、まだ期限内なら譲る
      if (lease.owner !== TAB_ID && lease.expiresAt > now) return false;
    }
    localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: TAB_ID, expiresAt: now + LEASE_TTL_MS }));
    // 書いた直後に読み直す。ほぼ同時に別のタブが書いていたら、そちらに譲る
    const confirm = localStorage.getItem(LEASE_KEY);
    if (!confirm) return false;
    return (JSON.parse(confirm) as Lease).owner === TAB_ID;
  } catch {
    // localStorage が使えない環境では、単独タブとみなして進む
    return true;
  }
}

/** 送信が続いている間、期限を延ばす */
export function renewLease(now = Date.now()): void {
  try {
    localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: TAB_ID, expiresAt: now + LEASE_TTL_MS }));
  } catch { /* 実害なし */ }
}

export function releaseLease(): void {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return;
    if ((JSON.parse(raw) as Lease).owner === TAB_ID) localStorage.removeItem(LEASE_KEY);
  } catch { /* 実害なし */ }
}

/**
 * 他のタブが送信待ちや控えを書き換えたときに知らせる。
 *
 * `storage` イベントは**書いたタブ自身には飛ばない**ので、
 * 「自分以外が変えた」だけを拾える。
 */
export function onExternalChange(callback: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === OUTBOX_KEY || event.key === BASE_KEY) callback();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
