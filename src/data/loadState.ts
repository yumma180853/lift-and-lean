/**
 * 「読み込み中」と「読み込みに失敗」を混同しないための状態。
 *
 * 以前は取得を**始めた時点**で「最新のデータを取得できていません」を立てていたため、
 * 何も失敗していないのに警告が出ていた。ここでは
 *   取得中          … refreshing
 *   取得に失敗した  … stale（控えがある場合）/ error（控えが無い場合）
 * をはっきり分ける。
 */

export type LoadPhase = 'loading' | 'ready' | 'error';

export interface LoadStatus {
  phase: LoadPhase;
  /** 取得が進行中。控えを見せながらでも起こりうる */
  refreshing: boolean;
  /** **最新の取得に失敗して**、前回の内容を見せている */
  stale: boolean;
  error: string | null;
}

export const initialStatus = (): LoadStatus => ({
  phase: 'loading', refreshing: false, stale: false, error: null,
});

/** 端末保存モード。取得は同期なので迷う状態が無い */
export const localReadyStatus = (): LoadStatus => ({
  phase: 'ready', refreshing: false, stale: false, error: null,
});

/**
 * 取得を始めた。
 * 控えがあるなら中身を見せたまま裏で取りに行く（この時点では失敗扱いにしない）。
 */
export const startLoad = (hasCache: boolean): LoadStatus => ({
  phase: hasCache ? 'ready' : 'loading',
  refreshing: true,
  stale: false,
  error: null,
});

export const loadSucceeded = (): LoadStatus => ({
  phase: 'ready', refreshing: false, stale: false, error: null,
});

/** 控えがあれば見せ続ける（stale）。無ければ読み込み失敗として扱う */
export const loadFailed = (hasCache: boolean, message: string): LoadStatus => ({
  phase: hasCache ? 'ready' : 'error',
  refreshing: false,
  stale: hasCache,
  error: message,
});

/**
 * 読み込みの世代管理。
 *
 * 短い間に何度も読み込みが走ると、**遅れて返ってきた古い結果**が
 * 新しい結果を上書きしてしまう。最後に始めたものだけが状態を更新できるようにする。
 */
export class LoadCoordinator {
  private generation = 0;

  /** 新しい読み込みを開始し、その世代番号を返す */
  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  /** その世代が今も最新か（古ければ結果を捨てる） */
  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}
