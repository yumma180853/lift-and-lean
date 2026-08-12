import React, { useEffect, useState } from 'react';
import { MailCheck, CheckCircle2 } from 'lucide-react';
import { ApiError, authApi } from '../utils/api';

/**
 * メールアドレス確認画面（`/verify-email`）。
 *
 * Appwriteの確認メールは `userId` と `secret` を付けてここへ戻してくる。
 * リンクは別のブラウザ（メールアプリの内蔵ブラウザなど）で開かれることがあるため、
 * **ログインしていなくても完了できる**設計にしてある。
 */

const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : '処理に失敗しました。時間をおいて試してください。';

type Phase = 'working' | 'done' | 'failed' | 'badLink';

export function VerifyEmail() {
  const [phase, setPhase] = useState<Phase>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const userId = params.get('userId') ?? '';
    const secret = params.get('secret') ?? '';
    if (userId === '' || secret === '') {
      setPhase('badLink');
      return;
    }

    let cancelled = false;
    authApi.confirmVerification(userId, secret)
      .then(() => {
        if (cancelled) return;
        setPhase('done');
        // secret を含むURLを履歴に残さない
        window.history.replaceState(null, '', '/verify-email');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(messageOf(e));
        setPhase('failed');
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-dvh bg-black text-zinc-100 font-sans flex items-start justify-center px-5 py-16">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center gap-2 text-lime-400 font-black italic text-xl uppercase tracking-wider">
          <MailCheck size={22} />
          <span>VERIFY EMAIL</span>
        </div>

        <div className="ll-card p-5 space-y-3">
          {phase === 'working' && (
            <p className="text-sm font-bold text-white">確認しています…</p>
          )}

          {phase === 'done' && (
            <>
              <div className="flex items-center gap-2 text-lime-400">
                <CheckCircle2 size={18} />
                <p className="text-sm font-bold">メールアドレスを確認しました</p>
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                アプリに戻って設定画面を開くと、クラウド同期が使えます。
              </p>
            </>
          )}

          {phase === 'badLink' && (
            <>
              <p className="text-sm font-bold text-white">リンクが正しくありません</p>
              <p className="text-xs text-zinc-500 leading-relaxed">
                メールに届いたリンクをそのまま開いてください。
                うまくいかない場合は、アプリの設定画面から確認メールを送り直せます。
              </p>
            </>
          )}

          {phase === 'failed' && (
            <>
              <p className="text-sm font-bold text-white">確認できませんでした</p>
              <p className="text-[11px] text-rose-400 font-bold leading-relaxed">{error}</p>
            </>
          )}

          <a
            href="/"
            className={`block w-full text-center py-2.5 rounded-xl font-bold text-sm ${
              phase === 'done' ? 'bg-lime-400 text-black' : 'bg-zinc-800 text-white'
            }`}
          >
            アプリに戻る
          </a>
        </div>
      </div>
    </div>
  );
}
