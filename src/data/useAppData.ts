import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Meal, UserGoals } from '../types';
import { ApiError, authApi } from '../utils/api';
import type { AccountInfo } from '../utils/api';
import { cloudStore } from './cloudStore';
import { loadLocalData, persistLocalData } from './localStore';
import { emptyAppData, findExercise, findSet, safeUUID } from './types';
import {
  LoadCoordinator,
  loadFailed,
  loadSucceeded,
  localReadyStatus,
  startLoad,
} from './loadState';
import type { LoadPhase, LoadStatus } from './loadState';
import { applyOp, enqueue, remapData, remapOp, replay } from './ops';
import type { IdMap, Op } from './ops';
import {
  readBase, readOutbox, writeBaseSoon, flushBase, writeOutbox, clearStored,
  acquireLease, renewLease, releaseLease, onExternalChange,
} from './outbox';
import { backoffMs, errorMessage, isAlreadyGone, sendOp, shouldRetry } from './cloudSync';
import type { AppData, NewMeal, ProfilePatch } from './types';

/**
 * 記録の読み書きをまとめて面倒みる。
 *
 * 保存先の決め方:
 *   ログイン済み かつ メール確認済み → **クラウドが正本**
 *   それ以外                        → この端末（従来どおり）
 *
 * ## 端末が先、通信はあと（local-first）
 *
 * 以前は「サーバーに保存できてから画面を書き換える」作りだった。
 * 電波が悪いと1操作ごとに往復ぶん待たされ、遅れて返ってきた応答が
 * 入力中の値を巻き戻していた（目標値を打つと最初の1文字に戻る、など）。
 *
 * いまは
 *   1. 操作を**その場で**画面に反映する
 *   2. 同じ操作を送信待ちの列（outbox）に積んで端末に残す
 *   3. 送信は裏でやる。失敗したら間隔を空けてやり直す
 * という順番にした。画面が通信を待つことはない。
 *
 * 画面に出す状態は常に **replay(base, pending)**。
 *   base    … サーバーが知っている内容
 *   pending … まだ送れていない操作
 * 新しいスナップショットが届いても、未送信の操作はその上に載せ直すので、
 * **入力中の値がサーバーの応答で消えることはない。**
 */

export type DataMode = 'local' | 'cloud';
export type LoadState = LoadPhase;

/**
 * 連続して書き換わる操作。手が止まってからまとめて送る。
 * （送信待ちの列でも1件にまとまるので、送るのは常に最後の値）
 */
const COALESCING_KINDS = new Set<Op['kind']>(['saveGoals', 'saveProfile', 'updateSet', 'updateMeal']);

/** 手が止まったと判断するまでの待ち時間。長くすると保存が遅れるので短く保つ */
const WRITE_DEBOUNCE_MS = 500;

/** 前回どのアカウントで使っていたか。控えを**通信を待たずに**出すために要る */
const ACCOUNT_KEY = 'account:last:v1';

interface RememberedAccount {
  userId: string;
  emailVerified: boolean;
}

function readRemembered(): RememberedAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedAccount;
    return parsed && typeof parsed.userId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeRemembered(info: AccountInfo | null): void {
  try {
    if (!info) localStorage.removeItem(ACCOUNT_KEY);
    else localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ userId: info.userId, emailVerified: info.emailVerified }));
  } catch {
    // 覚えられなくても、次の起動が少し遅くなるだけ
  }
}

/** ログアウトで消えてしまう「まだ送れていない記録」の件数 */
export { storedPendingCount } from './outbox';

/** ログアウト時に端末の控えを消す */
export function clearCache(): void {
  clearStored();
  try { localStorage.removeItem(ACCOUNT_KEY); } catch { /* 実害なし */ }
}

const messageOf = (error: unknown): string => {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '保存に失敗しました。時間をおいて試してください。';
};

export interface AppDataActions {
  addMeal(date: string, meal: NewMeal): Promise<void>;
  updateMeal(id: string, patch: Partial<Meal>): Promise<void>;
  deleteMeal(id: string): Promise<void>;
  saveWeight(date: string, weight: number): Promise<void>;
  addExercise(date: string, name: string, category?: string): Promise<void>;
  deleteExercise(exerciseId: string): Promise<void>;
  addSet(exerciseId: string, weight: number, reps: number): Promise<void>;
  updateSet(setId: string, weight: number, reps: number): Promise<void>;
  deleteSet(setId: string): Promise<void>;
  saveGoals(goals: UserGoals): Promise<void>;
  saveProfile(patch: ProfilePatch): Promise<void>;
}

export interface UseAppData {
  mode: DataMode;
  state: LoadState;
  /** **最新の取得に失敗して**控えを表示している状態（取得中は含まない） */
  stale: boolean;
  /** 取得が進行中。控えを見せながらでも起こりうる */
  refreshing: boolean;
  data: AppData;
  account: AccountInfo | null;
  /** まだサーバーへ送れていない操作の件数 */
  pendingCount: number;
  /** 送信を諦めた操作。利用者に知らせて消してもらう */
  failedCount: number;
  /** 送信を試している最中か */
  syncing: boolean;
  /** 直近の送信失敗。**記録は端末に残っている**ので「消えた」ではない */
  saveError: string | null;
  clearSaveError(): void;
  /** 諦めた操作をもう一度送る */
  retryFailed(): void;
  /** 諦めた操作を捨てる（利用者が了解したとき） */
  dismissFailed(): void;
  loadError: string | null;
  reload(): Promise<void>;
  /** ログイン・ログアウト・メール確認のあとに呼ぶ */
  refreshAccount(): Promise<void>;
  actions: AppDataActions;
}

export function useAppData(): UseAppData {
  /**
   * 最初の描画で使うもの。**通信を一切待たずに**決める。
   * 前回クラウドを使っていたなら、控えをそのまま画面に出す。
   */
  const boot = useMemo(() => {
    const remembered = readRemembered();
    if (remembered?.emailVerified) {
      const cached = readBase(remembered.userId);
      const outbox = readOutbox(remembered.userId);
      return {
        mode: 'cloud' as DataMode,
        userId: remembered.userId,
        base: cached ?? emptyAppData(),
        hasCache: Boolean(cached),
        pending: outbox.ops,
        idMap: outbox.idMap,
        failed: outbox.failed,
      };
    }
    return {
      mode: 'local' as DataMode,
      userId: null as string | null,
      base: loadLocalData(),
      hasCache: true,
      pending: [] as Op[],
      idMap: {} as IdMap,
      failed: [] as { op: Op; error: string }[],
    };
  }, []);

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [mode, setMode] = useState<DataMode>(boot.mode);
  const [status, setStatus] = useState<LoadStatus>(
    boot.mode === 'local' ? localReadyStatus() : startLoad(boot.hasCache),
  );
  const [base, setBase] = useState<AppData>(boot.base);
  const [pending, setPending] = useState<Op[]>(boot.pending);
  const [failed, setFailed] = useState<{ op: Op; error: string }[]>(boot.failed);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // 非同期の送信ループから触るので、最新値は ref で持つ（state は描画用の写し）
  const baseRef = useRef(boot.base);
  const pendingRef = useRef<Op[]>(boot.pending);
  const idMapRef = useRef<IdMap>(boot.idMap);
  const failedRef = useRef(boot.failed);
  const modeRef = useRef<DataMode>(boot.mode);
  const userIdRef = useRef<string | null>(boot.userId);
  const attemptsRef = useRef(0);
  const drainingRef = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loads = useRef(new LoadCoordinator());

  /** 画面に出す状態。サーバーの内容に、まだ送れていない操作を載せたもの */
  const data = useMemo(() => replay(base, pending), [base, pending]);

  /** ref を正として state と端末保存を揃える */
  const commit = useCallback((next: {
    base?: AppData;
    pending?: Op[];
    idMap?: IdMap;
    failed?: { op: Op; error: string }[];
  }) => {
    if (next.base) { baseRef.current = next.base; setBase(next.base); }
    if (next.pending) { pendingRef.current = next.pending; setPending(next.pending); }
    if (next.idMap) { idMapRef.current = next.idMap; }
    if (next.failed) { failedRef.current = next.failed; setFailed(next.failed); }

    const userId = userIdRef.current;
    if (modeRef.current === 'cloud' && userId) {
      // 控えは少し間引いて書く（190KB の JSON 化を毎回やると画面が固まる）。
      // 送信待ちは記録そのものなので、必ずその場で書く
      if (next.base) writeBaseSoon(userId, baseRef.current);
      if (next.pending || next.idMap || next.failed) {
        const ok = writeOutbox({
          userId,
          ops: pendingRef.current,
          idMap: idMapRef.current,
          failed: failedRef.current,
        });
        // 端末にも残せないなら、それは本当に「保存できていない」
        if (!ok) setSaveError('この端末に保存できませんでした。ブラウザの空き容量を確認してください。');
      }
    }
  }, []);

  // ------------------------------------------------------------ 送信（裏方）

  const scheduleRetry = useCallback((delay: number) => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      void drain();
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 「手が止まったら送る」ための待ち。
   *
   * 目標値を 1850 と打つと onChange が4回走る。送信待ちの列では
   * まとめられるが、サーバーが速いと1文字ごとに送り切ってしまい、
   * 結局4回の書き込みになる。**少しだけ待ってから**送る。
   */
  const scheduleWrite = useCallback(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      writeTimer.current = null;
      void drain();
    }, WRITE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 送信待ちを先頭から順に送る。
   * 画面はこれを待たない。失敗しても記録は端末に残っている。
   */
  const drain = useCallback(async (): Promise<void> => {
    if (drainingRef.current) return;
    if (modeRef.current !== 'cloud') return;
    if (pendingRef.current.length === 0) return;

    // 同じ送信待ちを複数のタブが同時に流さない。
    // 取れなかったときは少し待ってやり直す。持ち主のタブが閉じられていても
    // ここで諦めてしまうと、次の操作があるまで送信が止まってしまう
    if (!acquireLease()) { scheduleRetry(3000); return; }

    drainingRef.current = true;
    setSyncing(true);
    try {
      while (pendingRef.current.length > 0) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
        renewLease();

        const op = pendingRef.current[0];
        const snapshot = replay(baseRef.current, pendingRef.current);

        try {
          const delta = await sendOp(op, snapshot);
          // 送れたぶんは base に畳み込む。仮 id は本物の id に張り替える
          commit({
            base: remapData(applyOp(baseRef.current, op), delta),
            pending: pendingRef.current.slice(1).map(rest => remapOp(rest, delta)),
            idMap: { ...idMapRef.current, ...delta },
          });
          attemptsRef.current = 0;
          setSaveError(null);
        } catch (error) {
          if (isAlreadyGone(op, error)) {
            // 消そうとしたものが既に無い。目的は果たせているので進む
            commit({
              base: applyOp(baseRef.current, op),
              pending: pendingRef.current.slice(1),
            });
            continue;
          }

          if (!shouldRetry(error)) {
            // 何度送っても同じ。諦めて利用者に知らせる
            commit({
              base: applyOp(baseRef.current, op),
              pending: pendingRef.current.slice(1),
              failed: [...failedRef.current, { op, error: errorMessage(error) }],
            });
            setSaveError(errorMessage(error));
            continue;
          }

          attemptsRef.current += 1;
          setSaveError(errorMessage(error));
          scheduleRetry(backoffMs(attemptsRef.current));
          break;
        }
      }
    } finally {
      drainingRef.current = false;
      setSyncing(false);
      releaseLease();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit, scheduleRetry]);

  // ------------------------------------------------------------ 読み込み

  const applyFresh = useCallback((fresh: AppData) => {
    // **未送信の操作はそのまま残す。** 新しいスナップショットの上に載せ直すので、
    // 入力中の値がサーバーの応答で巻き戻ることはない（commit が端末にも書く）
    commit({ base: fresh });
    setStatus(loadSucceeded());
  }, [commit]);

  const loadFor = useCallback(async (info: AccountInfo | null) => {
    const token = loads.current.begin();
    const useCloud = Boolean(info && info.emailVerified);

    if (!useCloud) {
      modeRef.current = 'local';
      userIdRef.current = null;
      setMode('local');
      commit({ base: loadLocalData(), pending: [], idMap: {}, failed: [] });
      setStatus(localReadyStatus());
      return;
    }

    const userId = info!.userId;
    const switchedAccount = userIdRef.current !== null && userIdRef.current !== userId;
    modeRef.current = 'cloud';
    userIdRef.current = userId;
    setMode('cloud');

    const cached = readBase(userId);
    if (switchedAccount || pendingRef.current.length === 0) {
      const outbox = readOutbox(userId);
      commit({
        base: cached ?? emptyAppData(),
        pending: outbox.ops,
        idMap: outbox.idMap,
        failed: outbox.failed,
      });
    }
    setStatus(startLoad(Boolean(cached)));

    try {
      const fresh = await cloudStore.load();
      if (!loads.current.isCurrent(token)) return; // 新しい読み込みが始まっている
      applyFresh(fresh);
      void drain();
    } catch (error) {
      if (!loads.current.isCurrent(token)) return;
      setStatus(loadFailed(Boolean(cached), messageOf(error)));
      void drain(); // 読めなくても、送るほうは試す価値がある
    }
  }, [applyFresh, commit, drain]);

  const refreshAccount = useCallback(async () => {
    let info: AccountInfo | null = null;
    try {
      info = await authApi.me();
    } catch {
      info = null; // 未ログイン・サーバー未設定はどちらも「この端末に保存」
    }
    setAccount(info);
    writeRemembered(info);
    await loadFor(info);
  }, [loadFor]);

  /**
   * 起動時。**本人確認とスナップショット取得を同時に始める。**
   *
   * 順番にやると往復2回ぶん待つことになる（電波が悪いと体感で倍）。
   * 前回クラウドで使っていたことは端末が覚えているので、
   * 確認を待たずに取りに行ってよい。人が違っていたら捨てて取り直す。
   */
  useEffect(() => {
    const accountPromise = authApi.me().then(
      info => ({ ok: true as const, info }),
      () => ({ ok: false as const, info: null }),
    );
    // 目印は文字列にしてある。この tsconfig は strictNullChecks が無いため、
    // 真偽値の目印だと else 側の型が絞り込まれない
    type SnapshotResult =
      | { outcome: 'loaded'; fresh: AppData }
      | { outcome: 'failed'; error: unknown };
    const snapshotPromise: Promise<SnapshotResult> | null = boot.mode === 'cloud'
      ? cloudStore.load().then(
          (fresh): SnapshotResult => ({ outcome: 'loaded', fresh }),
          (error: unknown): SnapshotResult => ({ outcome: 'failed', error }),
        )
      : null;

    void (async () => {
      const { info } = await accountPromise;
      setAccount(info);
      writeRemembered(info);

      const stillSameCloudUser = Boolean(
        snapshotPromise && info && info.emailVerified && info.userId === boot.userId,
      );
      if (!stillSameCloudUser) {
        // 覚えていた相手と違った（ログアウト済み・別アカウント）。ふつうに読み直す
        await loadFor(info);
        return;
      }

      modeRef.current = 'cloud';
      userIdRef.current = info!.userId;
      setMode('cloud');

      const token = loads.current.begin();
      const result = await snapshotPromise!;
      if (!loads.current.isCurrent(token)) return;
      if (result.outcome === 'loaded') applyFresh(result.fresh);
      else setStatus(loadFailed(boot.hasCache, messageOf(result.error)));
      void drain();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 電波が戻ったとき・画面に戻ってきたときに送り直す。
   * 画面を離れるときは、間引いていた控えの書き込みを終わらせる。
   */
  useEffect(() => {
    const kick = () => { attemptsRef.current = 0; void drain(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') kick();
      else flushBase();
    };
    /**
     * 画面を離れるとき。控えを書き切り、**送信権を手放す。**
     * 手放さないまま再読み込みすると、次に開いた画面は
     * 期限が切れるまで送信できない（＝しばらく保存されない）。
     */
    const onLeave = () => {
      // 待っている書き込みがあるなら、離れる前に送りにいく
      if (writeTimer.current) { clearTimeout(writeTimer.current); writeTimer.current = null; void drain(); }
      flushBase();
      releaseLease();
    };
    window.addEventListener('online', kick);
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', kick);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (writeTimer.current) clearTimeout(writeTimer.current);
      flushBase();
      releaseLease();
    };
  }, [drain]);

  /**
   * 他のタブが送信待ちや控えを書き換えたら、こちらもそれに合わせる。
   *
   * 送信待ちは全タブで共有の1本なので、片方が送り終えたのに
   * もう片方が古い列を持ったままだと、同じ操作をもう一度積んでしまう。
   * ここでは**端末に書かれている内容を読み直すだけ**（書き戻さない）。
   */
  useEffect(() => onExternalChange(() => {
    const userId = userIdRef.current;
    if (modeRef.current !== 'cloud' || !userId) return;

    const cached = readBase(userId);
    if (cached) { baseRef.current = cached; setBase(cached); }

    const outbox = readOutbox(userId);
    pendingRef.current = outbox.ops;
    idMapRef.current = outbox.idMap;
    failedRef.current = outbox.failed;
    setPending(outbox.ops);
    setFailed(outbox.failed);
  }), []);

  const reload = useCallback(async () => {
    await loadFor(account);
  }, [account, loadFor]);

  // ------------------------------------------------------------ 書き込み

  /**
   * 操作を1件受け付ける。
   *
   * **その場で画面へ反映し、送信は裏に回す。** 呼び出し側は待たなくてよいが、
   * これまでの呼び出し方（await できる）を壊さないよう Promise を返す。
   */
  const submit = useCallback((op: Op): Promise<void> => {
    if (modeRef.current === 'local') {
      const next = applyOp(baseRef.current, op);
      try {
        persistLocalData(next);
        setSaveError(null);
      } catch (error) {
        setSaveError(messageOf(error));
        return Promise.resolve();
      }
      commit({ base: next });
      return Promise.resolve();
    }

    // 送信中の先頭には触らない
    const inFlight = drainingRef.current ? 1 : 0;
    commit({ pending: enqueue(pendingRef.current, op, inFlight) });

    if (COALESCING_KINDS.has(op.kind)) {
      // 打ちながら1文字ごとに送らない。**手が止まってから**まとめて1回送る。
      // 記録はこの時点で既に端末へ書けているので、待っても失われない
      scheduleWrite();
    } else {
      void drain();
    }
    return Promise.resolve();
  }, [commit, drain, scheduleWrite]);

  const actions: AppDataActions = useMemo(() => ({
    addMeal: (date, meal) => submit({ kind: 'addMeal', mealId: safeUUID(), date, meal }),

    updateMeal: (id, patch) => {
      if (!replay(baseRef.current, pendingRef.current).meals.some(m => m.id === id)) {
        setSaveError('その食事は見つかりませんでした。');
        return Promise.resolve();
      }
      return submit({ kind: 'updateMeal', mealId: id, patch });
    },

    deleteMeal: id => submit({ kind: 'deleteMeal', mealId: id }),

    saveWeight: (date, weight) => submit({ kind: 'saveWeight', weightId: safeUUID(), date, weight }),

    addExercise: (date, name, category) => {
      const result = submit({
        kind: 'addExercise', exerciseId: safeUUID(), workoutId: `day:${date}`, date, name,
      });
      if (category) {
        // 種目の分類はプロフィール側の情報。別の操作として積む
        const categories = { ...replay(baseRef.current, pendingRef.current).customExerciseCategories, [name]: category };
        void submit({ kind: 'saveProfile', patch: { customExerciseCategories: categories } });
      }
      return result;
    },

    deleteExercise: exerciseId => submit({ kind: 'deleteExercise', exerciseId }),

    addSet: (exerciseId, weight, reps) => {
      if (!findExercise(replay(baseRef.current, pendingRef.current), exerciseId)) {
        setSaveError('その種目は見つかりませんでした。');
        return Promise.resolve();
      }
      return submit({ kind: 'addSet', setId: safeUUID(), exerciseId, weight, reps });
    },

    updateSet: (setId, weight, reps) => {
      if (!findSet(replay(baseRef.current, pendingRef.current), setId)) {
        setSaveError('そのセットは見つかりませんでした。');
        return Promise.resolve();
      }
      return submit({ kind: 'updateSet', setId, weight, reps });
    },

    deleteSet: setId => submit({ kind: 'deleteSet', setId }),

    saveGoals: goals => submit({ kind: 'saveGoals', goals }),

    saveProfile: patch => submit({ kind: 'saveProfile', patch }),
  }), [submit]);

  const retryFailed = useCallback(() => {
    if (failedRef.current.length === 0) return;
    const again = failedRef.current.map(entry => entry.op);
    commit({ pending: [...pendingRef.current, ...again], failed: [] });
    attemptsRef.current = 0;
    setSaveError(null);
    void drain();
  }, [commit, drain]);

  const dismissFailed = useCallback(() => {
    commit({ failed: [] });
    setSaveError(null);
  }, [commit]);

  return {
    mode,
    state: status.phase,
    stale: status.stale,
    refreshing: status.refreshing,
    data,
    account,
    pendingCount: pending.length,
    failedCount: failed.length,
    syncing,
    saveError,
    clearSaveError: () => setSaveError(null),
    retryFailed,
    dismissFailed,
    loadError: status.error,
    reload,
    refreshAccount,
    actions,
  };
}
