import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, LogOut, MailWarning, ShieldCheck } from 'lucide-react';
import { ApiError, authApi, migrationApi } from '../utils/api';
import type { AccountInfo, MigrationReport } from '../utils/api';
import { buildMigrationPayload } from '../utils/backup';

/**
 * クラウド同期（移行の第2工程）。
 *
 * 「この端末のデータをクラウドへコピーする」までを担当する。
 * **localStorage は読むだけ**で、消しも書き換えもしない。
 * アプリの表示元は引き続き端末内のデータ（切り替えは検証がすべて通ったあと）。
 */

type Phase = 'checking' | 'unavailable' | 'signedOut' | 'unverified' | 'signedIn';

const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : '処理に失敗しました。時間をおいて試してください。';

export function CloudSync() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [preview, setPreview] = useState<MigrationReport | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    authApi.me()
      .then(info => { if (!cancelled) { setAccount(info); setPhase(info.emailVerified ? 'signedIn' : 'unverified'); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 401 = 未ログイン。それ以外（未設定・障害）はカードごと隠す
        setPhase(e instanceof ApiError && e.status === 401 ? 'signedOut' : 'unavailable');
      });
    return () => { cancelled = true; };
  }, []);

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const call = mode === 'signup' ? authApi.signUp : authApi.logIn;
      await call(email.trim(), password);
      const info = await authApi.me();
      setAccount(info);
      setPhase(info.emailVerified ? 'signedIn' : 'unverified');
      setPassword('');
      if (!info.emailVerified) {
        setNotice('確認メールを送りました。メール内のリンクを開くとクラウド同期が使えます。');
      }
    } catch (e) {
      setError(messageOf(e));
      // すでに登録済みなら、ログインタブへ寄せて袋小路にしない
      if (e instanceof ApiError && (e.code === 'email_taken' || e.code === 'signup_session_failed')) {
        setMode('login');
      }
    } finally {
      setBusy(false);
    }
  };

  const sendPasswordReset = async () => {
    const target = email.trim();
    if (target === '') {
      setError('メールアドレスを入力してから押してください。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await authApi.requestPasswordReset(target);
      // 登録の有無を問わず同じ案内にする（アカウント列挙を助長しない）
      setNotice('登録済みのメールアドレスであれば、再設定用のリンクを送りました。メールをご確認ください（1時間有効）。');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await authApi.resendVerification();
      setNotice('確認メールを送り直しました。メール内のリンクを開いてください。');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  /** メールのリンクを別画面で開いたあと、この画面を最新の状態にする */
  const recheckVerification = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await authApi.me();
      setAccount(info);
      setPhase(info.emailVerified ? 'signedIn' : 'unverified');
      setNotice(info.emailVerified ? null : 'まだ確認が済んでいません。メール内のリンクを開いてください。');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await authApi.logOut();
    } catch {
      // ログアウトはローカル状態を戻せれば十分
    } finally {
      setAccount(null);
      setPhase('signedOut');
      setMode('login');
      setPreview(null);
      setResult(null);
      setVerified(null);
      setNotice(null);
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setVerified(null);
    try {
      setPreview(await migrationApi.preview(buildMigrationPayload()));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const runMigration = async () => {
    setBusy(true);
    setError(null);
    try {
      const backup = buildMigrationPayload();
      const report = await migrationApi.apply(backup);
      if (!report.applied) {
        setError(`件数が合わないため中止しました：${report.issues.join(' / ')}`);
        return;
      }
      const check = await migrationApi.verify(backup);
      setVerified(check.ok);
      setResult(check.ok
        ? 'クラウドへコピーし、件数の一致も確認できました。'
        : `コピーしましたが検証で差分が出ました：${check.issues.join(' / ')}`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'checking') return null;

  if (phase === 'unavailable') {
    return (
      <div className="ll-card p-5 space-y-2">
        <div className="flex items-center gap-2 text-zinc-500">
          <CloudOff size={16} />
          <h3 className="ll-label text-zinc-500 text-xs">クラウド同期</h3>
        </div>
        <p className="text-xs text-zinc-600 leading-relaxed">
          まだ利用できません。記録はこれまで通りこの端末に保存されています。
        </p>
      </div>
    );
  }

  return (
    <div className="ll-card p-5 space-y-4">
      <div>
        <div className="flex items-center gap-2 text-zinc-400">
          <Cloud size={16} className={phase === 'signedIn' ? 'text-lime-400' : ''} />
          <h3 className="ll-label text-zinc-400 text-xs">クラウド同期（ベータ）</h3>
        </div>
        <p className="text-xs text-zinc-600 mt-1 leading-relaxed">
          端末の記録をクラウドへコピーします。<span className="text-zinc-400">端末のデータは消えません。</span>
        </p>
      </div>

      {phase === 'signedOut' && (
        <form onSubmit={submitCredentials} className="space-y-3">
          <div className="flex gap-1.5">
            {([
              { value: 'login', label: 'ログイン' },
              { value: 'signup', label: '新規登録' },
            ] as const).map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => { setMode(option.value); setError(null); setNotice(null); }}
                className={`flex-1 text-[11px] font-bold px-3 py-1.5 rounded-full border ${
                  mode === option.value
                    ? 'bg-lime-400/10 border-lime-400/40 text-lime-400'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="ll-inset px-4 py-2.5">
            <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="cloud-email">メールアドレス</label>
            <input
              id="cloud-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-transparent text-white text-sm outline-none"
            />
          </div>
          <div className="ll-inset px-4 py-2.5">
            <label className="text-[9px] font-bold text-zinc-500 uppercase" htmlFor="cloud-password">パスワード（8文字以上）</label>
            <input
              id="cloud-password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-transparent text-white text-sm outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 active:scale-95 transition-all"
          >
            {busy ? '通信中…' : mode === 'signup' ? 'アカウントを作る' : 'ログイン'}
          </button>
          <button
            type="button"
            onClick={sendPasswordReset}
            disabled={busy}
            className="w-full text-[11px] font-bold text-zinc-500 hover:text-lime-400 transition-colors py-1 disabled:opacity-50"
          >
            パスワードをお忘れですか？
          </button>
          {notice && <p className="text-[11px] text-lime-400 font-bold leading-relaxed">{notice}</p>}
        </form>
      )}

      {phase === 'unverified' && (
        <div className="space-y-3">
          <div className="ll-inset px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-amber-400">
              <MailWarning size={16} />
              <p className="text-xs font-black">メールアドレスの確認が必要です</p>
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              <span className="text-zinc-300">{account?.email}</span> に送った確認メールのリンクを開いてください。
              確認が済むまでクラウドへのコピーはできません。
            </p>
          </div>
          <button
            type="button"
            onClick={recheckVerification}
            disabled={busy}
            className="w-full bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 active:scale-95 transition-all"
          >
            {busy ? '確認中…' : '確認できたか調べる'}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resendVerification}
              disabled={busy}
              className="flex-1 text-[11px] font-bold text-zinc-500 hover:text-lime-400 transition-colors py-1 disabled:opacity-50"
            >
              確認メールを送り直す
            </button>
            <button
              type="button"
              onClick={signOut}
              disabled={busy}
              className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-zinc-500 hover:text-white px-2 py-1"
            >
              <LogOut size={12} /> ログアウト
            </button>
          </div>
          {notice && <p className="text-[11px] text-lime-400 font-bold leading-relaxed">{notice}</p>}
        </div>
      )}

      {phase === 'signedIn' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between ll-inset px-4 py-3">
            <div className="min-w-0">
              <div className="text-[9px] font-bold text-zinc-500 uppercase">ログイン中</div>
              <div className="text-xs font-bold text-white truncate">{account?.email ?? account?.userId}</div>
            </div>
            <button
              type="button"
              onClick={signOut}
              disabled={busy}
              className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-zinc-400 hover:text-white px-2 py-1"
            >
              <LogOut size={12} /> ログアウト
            </button>
          </div>

          {!preview && (
            <button
              type="button"
              onClick={runPreview}
              disabled={busy}
              className="w-full bg-zinc-800 text-white py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 active:scale-95 transition-all"
            >
              {busy ? '確認中…' : 'コピーする内容を確認する'}
            </button>
          )}

          {preview && (
            <div className="space-y-3">
              <div className="ll-inset px-4 py-3 space-y-1">
                <div className="text-[9px] font-bold text-zinc-500 uppercase">コピーされる件数</div>
                <div className="text-xs text-zinc-300 leading-relaxed">
                  食事 {preview.counts.meals}件 / 体重 {preview.counts.weights}件 /
                  筋トレ {preview.counts.workouts}日（{preview.counts.sets}セット）
                </div>
                {preview.warnings.length > 0 && (
                  <details className="pt-1">
                    <summary className="text-[10px] text-amber-400 font-bold cursor-pointer">
                      補正した記録が{preview.warnings.length}件あります
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {preview.warnings.slice(0, 20).map((warning, index) => (
                        <li key={index} className="text-[10px] text-zinc-500 leading-relaxed">・{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              {preview.issues.length > 0 ? (
                <p className="text-[11px] text-rose-400 font-bold leading-relaxed">
                  件数が合わないためコピーできません：{preview.issues.join(' / ')}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={runMigration}
                  disabled={busy}
                  className="w-full bg-lime-400 text-black py-2.5 rounded-xl font-bold text-sm disabled:opacity-50 active:scale-95 transition-all"
                >
                  {busy ? 'コピー中…' : 'クラウドへコピーする'}
                </button>
              )}
            </div>
          )}

          {result && (
            <p className={`text-[11px] font-bold leading-relaxed flex items-start gap-1.5 ${verified ? 'text-lime-400' : 'text-amber-400'}`}>
              {verified && <ShieldCheck size={14} className="shrink-0 mt-0.5" />}
              <span>{result}</span>
            </p>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-rose-400 font-bold leading-relaxed">{error}</p>}
    </div>
  );
}
