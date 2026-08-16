import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Loader2, X, Undo2, Check, HelpCircle, Square, Keyboard } from 'lucide-react';
import { ApiError, commandApi, voiceApi } from '../utils/api';
import type { CommandPlan, CommandResponse } from '../utils/api';
import { VoiceRecorder, bytesToBase64, detectRecorderSupport } from '../utils/recorder';
import type { RecorderFailure } from '../utils/recorder';
import type { NewMeal } from '../data/types';

/**
 * 話して記録する入口。
 *
 * ## 緑のマイクを1タップ → そのまま喋れる
 * 以前は「文字入力欄に focus → iOS のキーボードのマイクキー」だった。
 * キーボードが開く時点で求めていた体験ではないので、
 * **PWA 自身が `getUserMedia` + `MediaRecorder` で録る**ようにした。
 * 文字起こしは鍵のあるサーバー側で行う（画面は音を送るだけ）。
 *
 * 流れ:
 *   タップ（＝許可を求めてよい合図）
 *   → 録音（「聞いています…」）→ 無音で自動停止 / 停止ボタン
 *   → サーバーで文字起こし → 振り分け
 *   → **記録は端末側で即反映**（既存の local-first / outbox 経路）
 *
 * ## 文字入力は「直すため」に残す
 * 聞き間違いは必ず起きるので、聞き取った文字は見せて直せるようにする。
 * ただし **開いた時点では focus しない**（勝手にキーボードを出さない）。
 *
 * ## マイクは必ず離す
 * 停止・失敗・画面を閉じる、のどの経路でも `VoiceRecorder` が
 * `MediaStreamTrack.stop()` まで面倒をみる。
 */

type Phase = 'idle' | 'recording' | 'transcribing' | 'thinking';

/** この画面が使う記録操作だけを受け取る（画面から直接 API は呼ばない） */
export interface VoiceCommandActions {
  addMeal(date: string, meal: NewMeal): Promise<string>;
  saveWeight(date: string, weight: number): Promise<void>;
  logWorkout(date: string, exercises: { name: string; sets: { weight: number; reps: number }[] }[]): Promise<void>;
  deleteMeal(id: string): Promise<void>;
}

export interface VoiceCommandProps {
  open: boolean;
  onClose(): void;
  actions: VoiceCommandActions;
  /** サーバー側で実行された記録があったときだけ読み直す */
  onRecorded(): void;
}

const EXAMPLES = [
  'ベンチ60キロ10回3セット',
  '体重72.4キロ',
  '昼に牛丼並',
  '今日タンパク質あと何グラム？',
];

/** 失敗の種類 → 画面に出す一文。内部の文言は出さない */
const RECORDER_MESSAGES: Record<RecorderFailure, string> = {
  'permission-denied': 'マイクの使用を許可すると音声で記録できます。',
  unsupported: 'この端末では録音が使えません。下の入力欄から文字で送れます。',
  failed: '録音できませんでした。もう一度試してください。',
};

export function VoiceCommand({ open, onClose, actions, onRecorded }: VoiceCommandProps) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState(false);
  const [result, setResult] = useState<CommandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoMealId, setUndoMealId] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  /** 送信中に二重で走らせない（自動送信と手動送信がぶつかる） */
  const busyRef = useRef(false);

  const canRecord = detectRecorderSupport().supported;
  const busy = phase !== 'idle';

  const stopRecorder = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
  }, []);

  // 開くたびに初期化する。**focus はしない**（キーボードを出さないため）
  useEffect(() => {
    if (open) {
      setText(''); setResult(null); setError(null); setUndone(false);
      setUndoMealId(null); setPhase('idle'); setHeard(false);
      return;
    }
    stopRecorder();
    setPhase('idle');
  }, [open, stopRecorder]);

  useEffect(() => () => stopRecorder(), [stopRecorder]);

  // ------------------------------------------------------------ 記録する

  /** サーバーが決めた内容を、**既存の local-first 経路**へ流す */
  const applyPlan = useCallback(async (plan: CommandPlan): Promise<void> => {
    if (plan.kind === 'weight') {
      await actions.saveWeight(plan.date, plan.weight);
      return;
    }
    if (plan.kind === 'workout') {
      await actions.logWorkout(plan.date, plan.exercises);
      return;
    }
    const mealId = await actions.addMeal(plan.date, plan.meal as NewMeal);
    setUndoMealId(mealId);
  }, [actions]);

  const send = useCallback(async (said: string): Promise<void> => {
    const trimmed = said.trim();
    if (!trimmed || busyRef.current) return;
    busyRef.current = true;
    setPhase('thinking'); setError(null); setResult(null); setUndone(false); setUndoMealId(null);

    try {
      const response = await commandApi.run(trimmed);
      setResult(response);

      if (response.status === 'plan' && response.plan) {
        await applyPlan(response.plan);
        setText('');
      } else if (response.status === 'done') {
        // 読み取り（今日の合計など）はサーバーが答える。記録が動いていれば読み直す
        setText('');
        if (response.intent?.startsWith('log_')) onRecorded();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '送信に失敗しました。時間をおいて試してください。');
    } finally {
      busyRef.current = false;
      setPhase('idle');
    }
  }, [applyPlan, onRecorded]);

  // ------------------------------------------------------------ 録音する

  const transcribe = useCallback(async (audio: Blob, mimeType: string): Promise<void> => {
    setPhase('transcribing');
    try {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const { text: said } = await voiceApi.transcribe(bytesToBase64(bytes), mimeType);
      setText(said);
      await send(said);
    } catch (e) {
      setPhase('idle');
      setError(e instanceof ApiError ? e.message : '聞き取れませんでした。もう一度お願いします。');
    }
  }, [send]);

  /**
   * **タップの流れの中で**呼ぶこと（iOS は user gesture から離れると許可を求められない）。
   */
  const startRecording = useCallback(() => {
    if (busy) return;
    setError(null); setResult(null); setUndone(false); setUndoMealId(null); setHeard(false);

    const instance = new VoiceRecorder({
      onStart: () => setPhase('recording'),
      onLevel: (_level, hasSpoken) => { if (hasSpoken) setHeard(true); },
      onStop: (audio, mimeType) => {
        recorder.current = null;
        void transcribe(audio, mimeType);
      },
      onError: failure => {
        recorder.current = null;
        setPhase('idle');
        setError(RECORDER_MESSAGES[failure]);
      },
    });
    recorder.current = instance;
    setPhase('recording');
    void instance.start();
  }, [busy, transcribe]);

  const stopRecording = useCallback(() => {
    recorder.current?.stop();
  }, []);

  // ------------------------------------------------------------ 取り消す

  const undo = useCallback(async () => {
    if (!undoMealId) return;
    await actions.deleteMeal(undoMealId);
    setUndone(true);
    setUndoMealId(null);
  }, [actions, undoMealId]);

  if (!open) return null;

  const statusLabel = phase === 'recording'
    ? (heard ? '聞いています…' : '話してください…')
    : phase === 'transcribing' ? '聞き取っています…'
    : phase === 'thinking' ? '記録しています…'
    : null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center">
      <div onClick={() => { stopRecorder(); onClose(); }} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      <div className="relative w-full max-w-md bg-zinc-950 border-t border-zinc-800 rounded-t-3xl p-5 pb-8 space-y-4"
        style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black text-white uppercase italic tracking-wider flex items-center gap-2">
            <Mic size={16} className="text-lime-400" /> 話して記録
          </h2>
          <button type="button" onClick={() => { stopRecorder(); onClose(); }} className="p-1.5 text-zinc-500 hover:text-white rounded-lg">
            <X size={18} />
          </button>
        </div>

        {/* --- 本命の入口。1タップで録音が始まり、キーボードは出ない */}
        {canRecord && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={phase === 'recording' ? stopRecording : startRecording}
              disabled={phase === 'transcribing' || phase === 'thinking'}
              className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-sm font-black transition-all active:scale-95 disabled:opacity-60 ${
                phase === 'recording'
                  ? 'bg-lime-400/15 border-2 border-lime-400 text-lime-300'
                  : 'bg-lime-400 border-2 border-lime-400 text-black'
              }`}
            >
              {phase === 'recording'
                ? <><Square size={16} className="fill-current" /> 停止する</>
                : phase === 'idle'
                  ? <><Mic size={18} /> マイクで話す</>
                  : <><Loader2 size={18} className="animate-spin" /> お待ちください</>}
            </button>

            {statusLabel && (
              <p className="flex items-center justify-center gap-2 text-xs font-bold text-lime-300">
                <span className={phase === 'recording' ? 'w-2 h-2 rounded-full bg-lime-400 animate-pulse' : 'hidden'} />
                {statusLabel}
              </p>
            )}
            {phase === 'recording' && (
              <p className="text-center text-[10px] text-zinc-600">
                話し終わると自動で止まります。止まらないときは「停止する」。
              </p>
            )}
          </div>
        )}

        {/* --- 直すための入力欄。**開いた時点では focus しない** */}
        <form onSubmit={e => { e.preventDefault(); void send(text); }} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={e => setText(e.target.value)}
            enterKeyHint="send"
            autoComplete="off"
            placeholder={canRecord ? '聞き取りを直す・文字で送る' : 'ここに入力（キーボードの🎤も使えます）'}
            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-3 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-lime-400/50"
          />
          <button
            type="submit"
            disabled={!text.trim() || busy}
            className="shrink-0 bg-zinc-800 text-white font-black text-xs px-4 rounded-xl disabled:opacity-40 active:scale-95 transition-all"
          >
            {phase === 'thinking' ? <Loader2 size={16} className="animate-spin" /> : '送信'}
          </button>
        </form>

        {!canRecord && (
          <p className="flex items-start gap-1.5 text-[10px] text-zinc-500">
            <Keyboard size={12} className="shrink-0 mt-0.5" />
            この端末では直接録音が使えません。キーボードのマイクキーで音声入力できます。
          </p>
        )}

        {/* --- 結果 */}
        {result && (
          <div
            className={`rounded-2xl px-4 py-3 text-xs font-bold leading-relaxed border ${
              result.status === 'done' || result.status === 'plan'
                ? 'bg-lime-400/10 border-lime-400/25 text-lime-300'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            }`}
          >
            <div className="flex items-start gap-2">
              {result.status === 'done' || result.status === 'plan'
                ? <Check size={14} className="shrink-0 mt-0.5" />
                : <HelpCircle size={14} className="shrink-0 mt-0.5" />}
              <div className="min-w-0">
                <p className="break-words">{undone ? '取り消しました。' : result.message}</p>
                <p className="text-[10px] font-medium text-zinc-500 mt-1 break-words">
                  聞き取り：{result.transcript}
                </p>
              </div>
            </div>

            {undoMealId && !undone && (
              <button
                type="button"
                onClick={() => void undo()}
                className="mt-2 flex items-center gap-1 text-[11px] text-zinc-300 underline"
              >
                <Undo2 size={11} /> 取り消す
              </button>
            )}
          </div>
        )}

        {error && (
          <p className="text-[11px] font-bold text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        {!result && !error && phase === 'idle' && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-wider">例</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map(example => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setText(example)}
                  className="text-[11px] bg-zinc-900 border border-zinc-800 text-zinc-400 px-2.5 py-1.5 rounded-lg active:scale-95 transition-all"
                >
                  {example}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-600 pt-1">
              記録と確認だけができます。削除や設定の変更は画面から操作してください。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
