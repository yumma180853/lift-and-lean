import { useEffect, useRef, useState } from 'react';
import { Mic, Loader2, X, Undo2, Check, HelpCircle } from 'lucide-react';
import { ApiError, commandApi, dataApi } from '../utils/api';
import type { CommandResponse } from '../utils/api';

/**
 * 話して記録する入口。
 *
 * ## 音声の取り方（2026年8月時点の iPhone の実情に合わせる）
 *
 * `webkitSpeechRecognition` は **Safari のタブでは動くが、ホーム画面に
 * 追加した PWA では動かない**。Lift & Lean の主戦場は後者なので、
 * ここに頼り切ると「iPhone だけ喋れない」ことになる。
 *
 * そこで入口を2つ用意する:
 *   1. **文字入力欄（本命）** … 開くと同時にキーボードを出す。
 *      iOS のキーボードにあるマイクキーで、そのまま声で入力できる。
 *      permission も課金も要らず、PWA でも確実に動く。
 *   2. 音声認識ボタン（使える端末だけ） … 使える環境では1タップで喋れる。
 *
 * どちらも最後は同じ文字列になり、同じ `/api/v1/command` へ送る。
 *
 * ## 何を送っているか必ず見せる
 * 聞き間違いは必ず起きる。**送った文字列と結果を画面に出し、
 * 食事はその場で取り消せる**ようにしてある。
 */

type Recognition = any;

/** この端末で音声認識が使えるか（使えなくても文字入力で完結する） */
function getRecognitionCtor(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
}

/** ホーム画面から起動した PWA か */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window.navigator as any).standalone
    || window.matchMedia?.('(display-mode: standalone)').matches,
  );
}

export interface VoiceCommandProps {
  open: boolean;
  onClose(): void;
  /** 記録が増えたので読み直してほしい */
  onRecorded(): void;
}

const EXAMPLES = [
  'ベンチ60キロ10回3セット',
  '体重72.4キロ',
  '昼に牛丼並',
  '今日タンパク質あと何グラム？',
];

export function VoiceCommand({ open, onClose, onRecorded }: VoiceCommandProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [result, setResult] = useState<CommandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const recognition = useRef<Recognition>(null);

  // 開いたらすぐ書ける（＝キーボードのマイクがすぐ押せる）状態にする
  useEffect(() => {
    if (!open) return;
    setText(''); setResult(null); setError(null); setUndone(false);
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => () => { try { recognition.current?.stop(); } catch { /* 実害なし */ } }, []);

  const canListen = Boolean(getRecognitionCtor()) && !isStandalone();

  const startListening = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      recognition.current = rec;
      rec.lang = 'ja-JP';
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (event: any) => {
        let said = '';
        for (let i = 0; i < event.results.length; i++) said += event.results[i][0].transcript;
        setText(said);
      };
      rec.onerror = () => { setListening(false); setError('聞き取れませんでした。文字で入力してください。'); };
      rec.onend = () => setListening(false);
      setError(null);
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
      setError('この端末では音声認識が使えません。キーボードのマイクをお使いください。');
    }
  };

  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    try { recognition.current?.stop(); } catch { /* 実害なし */ }

    setBusy(true); setError(null); setResult(null); setUndone(false);
    try {
      const response = await commandApi.run(said);
      setResult(response);
      if (response.status === 'done') {
        setText('');
        onRecorded();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '送信に失敗しました。時間をおいて試してください。');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!result?.undo) return;
    setBusy(true);
    try {
      await dataApi.deleteMeal(result.undo.rowId);
      setUndone(true);
      onRecorded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '取り消しに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center">
      <div onClick={onClose} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      <div className="relative w-full max-w-md bg-zinc-950 border-t border-zinc-800 rounded-t-3xl p-5 pb-8 space-y-4"
        style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black text-white uppercase italic tracking-wider flex items-center gap-2">
            <Mic size={16} className="text-lime-400" /> 話して記録
          </h2>
          <button type="button" onClick={onClose} className="p-1.5 text-zinc-500 hover:text-white rounded-lg">
            <X size={18} />
          </button>
        </div>

        <form
          onSubmit={e => { e.preventDefault(); void send(); }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={e => setText(e.target.value)}
            enterKeyHint="send"
            autoComplete="off"
            placeholder="キーボードの🎤か、ここに入力"
            className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-3 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-lime-400/50"
          />
          <button
            type="submit"
            disabled={!text.trim() || busy}
            className="shrink-0 bg-lime-400 text-black font-black text-xs px-4 rounded-xl disabled:opacity-40 active:scale-95 transition-all"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : '送信'}
          </button>
        </form>

        {canListen && (
          <button
            type="button"
            onClick={startListening}
            disabled={listening || busy}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold border transition-all active:scale-95 ${
              listening
                ? 'bg-lime-400/15 border-lime-400/40 text-lime-300'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400'
            }`}
          >
            <Mic size={14} className={listening ? 'animate-pulse' : ''} />
            {listening ? '聞いています…' : '音声で入力'}
          </button>
        )}

        {/* --- 結果 */}
        {result && (
          <div
            className={`rounded-2xl px-4 py-3 text-xs font-bold leading-relaxed border ${
              result.status === 'done'
                ? 'bg-lime-400/10 border-lime-400/25 text-lime-300'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            }`}
          >
            <div className="flex items-start gap-2">
              {result.status === 'done'
                ? <Check size={14} className="shrink-0 mt-0.5" />
                : <HelpCircle size={14} className="shrink-0 mt-0.5" />}
              <div className="min-w-0">
                <p className="break-words">{undone ? '取り消しました。' : result.message}</p>
                <p className="text-[10px] font-medium text-zinc-500 mt-1 break-words">
                  聞き取り：{result.transcript}
                </p>
              </div>
            </div>

            {result.undo && !undone && (
              <button
                type="button"
                onClick={() => void undo()}
                disabled={busy}
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

        {!result && !error && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-zinc-600 uppercase tracking-wider">例</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map(example => (
                <button
                  key={example}
                  type="button"
                  onClick={() => { setText(example); inputRef.current?.focus(); }}
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
