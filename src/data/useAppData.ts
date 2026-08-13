import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meal, UserGoals } from '../types';
import { ApiError, authApi } from '../utils/api';
import type { AccountInfo } from '../utils/api';
import { cloudStore } from './cloudStore';
import { loadLocalData, localStore } from './localStore';
import { emptyAppData } from './types';
import type { AppData, DataStore, NewMeal, ProfilePatch } from './types';

/**
 * 保存先を決めて、読み込みと書き込みをまとめて面倒みる。
 *
 * 保存先の決め方:
 *   ログイン済み かつ メール確認済み → **クラウドが正本**
 *   それ以外                        → この端末（従来どおり）
 *
 * クラウドが正本のとき、端末の旧データには**書き込まない**（消しもしない）。
 * どちらが新しいか分からなくなるのを避けるため、片方だけを正本にする。
 */

export type DataMode = 'local' | 'cloud';
export type LoadState = 'loading' | 'ready' | 'error';

const CACHE_KEY = 'cache:cloud-snapshot:v1';

interface CachedSnapshot {
  userId: string;
  savedAt: string;
  data: AppData;
}

/** 起動直後の白画面とオフライン時の空表示を避けるための控え。正本ではない */
function readCache(userId: string): AppData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedSnapshot;
    return cached.userId === userId ? cached.data : null;
  } catch {
    return null;
  }
}

function writeCache(userId: string, data: AppData): void {
  try {
    const payload: CachedSnapshot = { userId, savedAt: new Date().toISOString(), data };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // 控えが書けなくても本体の動作には影響しない
  }
}

export function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // 消せなくても実害はない
  }
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
  /** クラウドが正本なのに最新を取れていない（控えを表示している）状態 */
  stale: boolean;
  data: AppData;
  account: AccountInfo | null;
  /** 直近の保存失敗。画面に出して「保存できていない」ことを伝える */
  saveError: string | null;
  clearSaveError(): void;
  loadError: string | null;
  reload(): Promise<void>;
  /** ログイン・ログアウト・メール確認のあとに呼ぶ */
  refreshAccount(): Promise<void>;
  actions: AppDataActions;
}

export function useAppData(): UseAppData {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [mode, setMode] = useState<DataMode>('local');
  const [state, setState] = useState<LoadState>('loading');
  const [stale, setStale] = useState(false);
  const [data, setData] = useState<AppData>(emptyAppData);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 書き込みは常に「今の状態」から始める。二重クリックや連打で
  // 古い状態を元に上書きしてしまわないよう、refで最新を持ち、順番に流す
  const latest = useRef<AppData>(data);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const storeRef = useRef<DataStore>(localStore);

  const apply = useCallback((next: AppData, forMode: DataMode, userId?: string) => {
    latest.current = next;
    setData(next);
    if (forMode === 'cloud' && userId) writeCache(userId, next);
  }, []);

  const loadFor = useCallback(async (info: AccountInfo | null) => {
    const useCloud = Boolean(info && info.emailVerified);
    const store = useCloud ? cloudStore : localStore;
    storeRef.current = store;
    setMode(store.mode);
    setLoadError(null);

    if (!useCloud) {
      const local = loadLocalData();
      apply(local, 'local');
      setStale(false);
      setState('ready');
      return;
    }

    const cached = readCache(info!.userId);
    if (cached) {
      apply(cached, 'cloud', info!.userId);
      setStale(true);
      setState('ready'); // 控えでも先に見せる（白画面にしない）
    } else {
      setState('loading');
    }

    try {
      const fresh = await store.load();
      apply(fresh, 'cloud', info!.userId);
      setStale(false);
      setState('ready');
    } catch (error) {
      setLoadError(messageOf(error));
      // 控えがあるなら見せ続ける。無ければ読み込み失敗として扱う
      setState(cached ? 'ready' : 'error');
      setStale(true);
    }
  }, [apply]);

  const refreshAccount = useCallback(async () => {
    let info: AccountInfo | null = null;
    try {
      info = await authApi.me();
    } catch {
      info = null; // 未ログイン・サーバー未設定はどちらも「この端末に保存」
    }
    setAccount(info);
    await loadFor(info);
  }, [loadFor]);

  useEffect(() => {
    void refreshAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    await loadFor(account);
  }, [account, loadFor]);

  /**
   * 保存を1件ずつ順番に流す。
   * 失敗したら状態は**変えない**（保存できていないものを保存済みに見せない）。
   */
  const run = useCallback((operation: (store: DataStore, current: AppData) => Promise<AppData>) => {
    const task = queue.current.then(async () => {
      try {
        const next = await operation(storeRef.current, latest.current);
        apply(next, storeRef.current.mode, account?.userId);
        setSaveError(null);
      } catch (error) {
        setSaveError(messageOf(error));
        throw error;
      }
    });
    // 1件失敗しても後続を止めない
    queue.current = task.catch(() => undefined);
    return task.catch(() => undefined);
  }, [apply, account?.userId]);

  const actions: AppDataActions = {
    addMeal: (date, meal) => run((store, current) => store.addMeal(current, date, meal)),
    updateMeal: (id, patch) => run((store, current) => store.updateMeal(current, id, patch)),
    deleteMeal: (id) => run((store, current) => store.deleteMeal(current, id)),
    saveWeight: (date, weight) => run((store, current) => store.saveWeight(current, date, weight)),
    addExercise: (date, name, category) => run((store, current) => store.addExercise(current, date, name, category)),
    deleteExercise: (exerciseId) => run((store, current) => store.deleteExercise(current, exerciseId)),
    addSet: (exerciseId, weight, reps) => run((store, current) => store.addSet(current, exerciseId, weight, reps)),
    updateSet: (setId, weight, reps) => run((store, current) => store.updateSet(current, setId, weight, reps)),
    deleteSet: (setId) => run((store, current) => store.deleteSet(current, setId)),
    saveGoals: (goals) => run((store, current) => store.saveGoals(current, goals)),
    saveProfile: (patch) => run((store, current) => store.saveProfile(current, patch)),
  };

  return {
    mode, state, stale, data, account, saveError,
    clearSaveError: () => setSaveError(null),
    loadError, reload, refreshAccount, actions,
  };
}
