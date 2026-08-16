import { useEffect, useRef, useState } from 'react';
import { Check, CloudOff, Loader2, RefreshCw, X } from 'lucide-react';

/**
 * 保存の状況を控えめに知らせる。
 *
 * 記録はまず端末に残り、送信は裏で進む。だから普段は何も出さなくてよい。
 * ただし **送れていないものを「保存済み」と見せない**ことだけは守る。
 *
 *   送信中          … 「保存中」
 *   送り終えた直後  … 「保存済み」を少しだけ
 *   送れずに残った  … 「未同期 N件・通信が戻ると自動で保存します」
 *   諦めたものがある… 赤で知らせ、やり直すか捨てるかを選べるようにする
 *
 * どの状態でも入力は止めない。
 */

export interface SyncStatusProps {
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
  /** 端末にも書けなかったときだけ入る。これは本当に「保存できていない」 */
  saveError: string | null;
  onRetry(): void;
  onDismissFailed(): void;
  onClearError(): void;
}

export function SyncStatus({
  pendingCount, failedCount, syncing, saveError, onRetry, onDismissFailed, onClearError,
}: SyncStatusProps) {
  const [open, setOpen] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const wasBusy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 送信待ちが片付いた瞬間だけ「保存済み」を出す（出しっぱなしにしない）
  useEffect(() => {
    const busy = syncing || pendingCount > 0;
    if (wasBusy.current && !busy && failedCount === 0) {
      setJustSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setJustSaved(false), 1800);
    }
    wasBusy.current = busy;
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [syncing, pendingCount, failedCount]);

  const hasTrouble = failedCount > 0 || Boolean(saveError);
  const stuck = pendingCount > 0 && !syncing;

  if (!hasTrouble && !stuck && !syncing && !justSaved) return null;

  // --- 諦めた記録がある。ここだけは赤で、選んでもらう
  if (hasTrouble) {
    return (
      <div className="fixed inset-x-0 bottom-20 z-[60] mx-5">
        <div className="rounded-2xl bg-rose-500/15 border border-rose-500/40 px-4 py-3 text-[11px] font-bold text-rose-300 leading-relaxed">
          {saveError && !failedCount ? (
            <>
              保存できませんでした：{saveError}
              <button type="button" onClick={onClearError} className="ml-2 underline">閉じる</button>
            </>
          ) : (
            <>
              送れなかった記録が {failedCount} 件あります。
              <span className="block text-rose-200/80 font-medium mt-0.5">
                記録はこの端末に残っています。
              </span>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex items-center gap-1 bg-rose-500/25 border border-rose-400/40 px-2.5 py-1 rounded-lg active:scale-95 transition-all"
                >
                  <RefreshCw size={11} /> もう一度送る
                </button>
                <button
                  type="button"
                  onClick={onDismissFailed}
                  className="flex items-center gap-1 text-rose-200/70 px-2 py-1 rounded-lg active:scale-95 transition-all"
                >
                  <X size={11} /> 捨てる
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // --- 通常時。小さく状況だけ
  const label = syncing
    ? '保存中'
    : stuck
      ? `未同期 ${pendingCount}件`
      : '保存済み';

  const Icon = syncing ? Loader2 : stuck ? CloudOff : Check;

  return (
    <div className="fixed inset-x-0 bottom-20 z-[55] flex justify-center pointer-events-none">
      <button
        type="button"
        onClick={() => stuck && setOpen(v => !v)}
        className={`pointer-events-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold transition-all ${
          stuck
            ? 'bg-amber-500/15 border-amber-500/35 text-amber-300 active:scale-95'
            : 'bg-zinc-900/90 border-zinc-800 text-zinc-400'
        }`}
      >
        <Icon size={11} className={syncing ? 'animate-spin' : ''} />
        {label}
      </button>
      {open && stuck && (
        <div className="pointer-events-auto absolute bottom-9 mx-5 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2 text-[10px] text-zinc-400 font-medium max-w-xs text-center">
          通信が戻ると自動で保存します。
          <button type="button" onClick={onRetry} className="ml-2 underline text-amber-300">今すぐ試す</button>
        </div>
      )}
    </div>
  );
}
