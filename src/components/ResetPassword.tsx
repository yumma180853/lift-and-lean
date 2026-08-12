import React, { useState } from 'react';
import { KeyRound, CheckCircle2 } from 'lucide-react';
import { ApiError, authApi } from '../utils/api';

/**
 * パスワード再設定画面（`/reset-password`）。
 *
 * メールのリンクには Appwrite が `userId` と `secret` を付けて戻してくる。
 * この2つが揃っていなければ、リンクが壊れているものとして案内する。
 * secret は URL に載るため、**画面にも履歴にも残さない**（送信後は入力欄ごと畳む）。
 */

const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : '処理に失敗しました。時間をおいて試してください。';

export function ResetPassword() {
  const params = new URLSearchParams(window.location.search);
  const userId = params.get('userId') ?? '';
  const secret = params.get('secret') ?? '';
  const linkOk = userId !== '' && secret !== '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('確認用のパスワードが一致しません。');
      return;
    }
    setBusy(true);
    try {
      await authApi.confirmPasswordReset(userId, secret, password);
      setPassword('');
      setConfirm('');
      setDone(true);
      // secret を含むURLを履歴に残さない
      window.history.replaceState(null, '', '/reset-password');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-black text-zinc-100 font-sans flex items-start justify-center px-5 py-16">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2 text-lime-400 font-black italic text-xl uppercase tracking-wider">
          <KeyRound size={22} />
          <span>RESET PASSWORD</span>
        </div>

        {!linkOk && (
          <div className="ll-card p-5 space-y-3">
            <p className="text-sm font-bold text-white">リンクが正しくありません</p>
            <p className="text-xs text-zinc-500 leading-relaxed">
              メールに届いたリンクをそのまま開いてください。時間が経っている場合は、
              アプリの設定画面から「パスワードをお忘れですか？」をもう一度お試しください。
            </p>
            <a href="/" className="block w-full text-center bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm">
              アプリに戻る
            </a>
          </div>
        )}

        {linkOk && done && (
          <div className="ll-card p-5 space-y-3">
            <div className="flex items-center gap-2 text-lime-400">
              <CheckCircle2 size={18} />
              <p className="text-sm font-bold">新しいパスワードを設定しました</p>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              アプリの設定画面から、新しいパスワードでログインしてください。
            </p>
            <a href="/" className="block w-full text-center bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm">
              アプリに戻る
            </a>
          </div>
        )}

        {linkOk && !done && (
          <form onSubmit={submit} className="ll-card p-5 space-y-4">
            <p className="text-xs text-zinc-500 leading-relaxed">
              新しいパスワードを決めてください（8文字以上）。設定するとこのリンクは使えなくなります。
            </p>
            <div className="ll-inset px-4 py-2.5">
              <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="new-password">新しいパスワード</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-transparent text-white text-sm outline-none"
              />
            </div>
            <div className="ll-inset px-4 py-2.5">
              <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="new-password-confirm">確認のためもう一度</label>
              <input
                id="new-password-confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                className="w-full bg-transparent text-white text-sm outline-none"
              />
            </div>
            {error && <p className="text-[11px] text-rose-400 font-bold leading-relaxed">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 active:scale-95 transition-all"
            >
              {busy ? '設定中…' : 'このパスワードにする'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
