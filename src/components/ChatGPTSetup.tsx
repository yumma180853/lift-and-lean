import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, MessageCircle } from 'lucide-react';

const MCP_URL = 'https://lift-and-lean.vercel.app/api/mcp';

export function ChatGPTSetup() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100 px-5 py-8">
      <div className="mx-auto max-w-lg space-y-6 pb-10">
        <a href="/" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white">
          <ArrowLeft size={16} /> アプリに戻る
        </a>
        <header className="space-y-3">
          <p className="ll-label text-lime-400">LIFT &amp; LEAN</p>
          <h1 className="text-2xl font-black flex items-center gap-3"><MessageCircle className="text-lime-400" />ChatGPTと連携</h1>
          <p className="text-sm leading-7 text-zinc-300">いつものチャットで、食事・体重・筋トレを記録。<br />過去の記録を見ながら相談できます。</p>
        </header>

        <section className="ll-card p-5 space-y-3" aria-labelledby="before-title">
          <h2 id="before-title" className="font-bold">はじめに</h2>
          <p className="text-sm text-zinc-300 leading-7">アプリの「設定 → クラウド同期」でログインし、メールアドレスの確認を済ませてください。ChatGPTでも同じLift &amp; Leanアカウントを使います。</p>
          <p className="text-xs text-zinc-400 leading-6">端末内だけの記録や、まだ同期できていない記録はChatGPTから見えません。以前の記録が端末内にある場合は、クラウド同期のコピー機能を使ってください。</p>
        </section>

        <section className="ll-card p-5 space-y-5" aria-labelledby="setup-title">
          <div>
            <h2 id="setup-title" className="font-bold">初回だけ、ChatGPTに追加</h2>
            <p className="text-xs text-zinc-400 mt-2 leading-6">各自のChatGPTで設定します。PCのブラウザからの操作がおすすめです。</p>
          </div>
          <ol className="list-decimal pl-5 space-y-4 text-sm leading-7 text-zinc-300">
            <li>ChatGPTの「プラグイン → 追加 → MCP アプリを作成」を開く。表示されない場合は、設定のアプリ／コネクタにある詳細設定で開発者モードを確認してください。プランや管理者設定により利用できない場合があります。</li>
            <li>名前を「Lift &amp; Lean」、認証を「OAuth」にして、下のサーバーURLを入力。</li>
            <li>内容を確認して作成し、Lift &amp; Leanのログイン画面で連携を許可。</li>
          </ol>
          <div className="ll-inset p-4 space-y-3">
            <label htmlFor="mcp-url" className="ll-label text-zinc-400">サーバーURL</label>
            <input id="mcp-url" readOnly value={MCP_URL} onFocus={event => event.currentTarget.select()} className="block w-full min-w-0 bg-transparent text-xs text-zinc-200 py-2" />
            <button type="button" onClick={copyUrl} className="flex items-center justify-center gap-2 w-full min-h-11 rounded-xl bg-zinc-800 text-sm font-bold hover:bg-zinc-700">
              {copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'コピーしました' : 'URLをコピー'}
            </button>
            <p role="status" className="text-xs text-zinc-400">{copyError ? 'コピーできませんでした。上のURLを選択してコピーしてください。' : copied ? 'ChatGPTのサーバーURL欄に貼り付けてください。' : 'OAuthのクライアントID・シークレットは手入力不要です。'}</p>
          </div>
          <a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 min-h-12 rounded-xl bg-lime-400 text-zinc-950 text-sm font-black hover:bg-lime-300">ChatGPTで設定する <ArrowUpRight size={18} /></a>
        </section>

        <section className="space-y-3" aria-labelledby="examples-title">
          <h2 id="examples-title" className="font-bold">連携したら、こんなふうに</h2>
          <div className="ll-inset p-4 space-y-3 text-sm leading-6 text-zinc-300">
            <p>「Lift &amp; Leanで、今日のタンパク質はあと何g？」</p>
            <p>「前回の筋トレを見せて」</p>
            <p>「今日のベンチ60kg、10回3セットを記録して」</p>
          </div>
          <p className="text-xs leading-6 text-zinc-400">新しいチャットで「＋」からLift &amp; Leanを選んで使います。記録するとアプリのクラウドデータに反映されます。同日の体重は上書きされるので、保存前に日付と数値を確認してください。</p>
        </section>

        <details className="ll-card p-5 text-sm">
          <summary className="cursor-pointer font-bold">共有される情報・連携の解除</summary>
          <div className="mt-4 space-y-3 text-xs leading-6 text-zinc-400">
            <p>読み取り：食事の合計・栄養目標・体重の推移・筋トレの記録。書き込み：食事・体重・筋トレの記録。削除・目標変更・アカウント操作には対応していません。</p>
            <p>取得した記録はChatGPTに送信されます。会話の保存や利用はChatGPT側のプラン・データ設定に従います。パスワードはLift &amp; Leanのログイン画面だけに入力してください。</p>
            <p>解除するときはChatGPTのプラグイン設定から接続を削除してください。過去の会話に送られた情報は、接続を削除しても自動では消えません。</p>
            <a href="/privacy" className="text-lime-400 underline">プライバシーポリシー</a>
          </div>
        </details>
      </div>
    </main>
  );
}
