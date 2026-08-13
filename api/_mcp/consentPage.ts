/**
 * 連携の同意画面。
 *
 * **パスワードを入れる場所はここだけ**（ChatGPTの会話には出さない）。
 * 何を許可するのかを日本語で書き、許可しない操作も明示する。
 */

export interface ConsentPageParams {
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  state?: string;
  scope?: string;
  resource?: string;
  error?: string;
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ));

const hidden = (name: string, value?: string): string =>
  value === undefined || value === '' ? '' : `<input type="hidden" name="${name}" value="${escape(value)}">`;

export function renderConsentPage(params: ConsentPageParams): string {
  const canSubmit = Boolean(params.clientId && params.redirectUri && params.codeChallenge);
  const errorBlock = params.error
    ? `<p class="error">${escape(params.error)}</p>`
    : '';

  const form = canSubmit ? `
      <form method="post" action="/oauth/consent" autocomplete="on">
        ${hidden('client_id', params.clientId)}
        ${hidden('redirect_uri', params.redirectUri)}
        ${hidden('code_challenge', params.codeChallenge)}
        ${hidden('state', params.state)}
        ${hidden('scope', params.scope)}
        ${hidden('resource', params.resource)}
        <label for="email">メールアドレス</label>
        <input id="email" name="email" type="email" autocomplete="email" required>
        <label for="password">パスワード</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required minlength="8">
        <button type="submit">ログインして連携を許可する</button>
      </form>` : '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Lift &amp; Lean と ChatGPT の連携</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
    background:#000; color:#e4e4e7; font-family:system-ui,-apple-system,'Hiragino Sans',sans-serif; padding:24px; }
  .card { width:100%; max-width:380px; background:#0f0f11; border:1px solid #27272a; border-radius:20px; padding:24px; }
  h1 { font-size:15px; margin:0 0 4px; color:#a3e635; letter-spacing:.04em; }
  .lead { font-size:12px; color:#a1a1aa; line-height:1.7; margin:0 0 18px; }
  ul { margin:0 0 18px; padding-left:18px; font-size:12px; color:#d4d4d8; line-height:1.9; }
  ul.deny { color:#a1a1aa; }
  label { display:block; font-size:10px; font-weight:700; color:#71717a; margin:14px 0 4px; letter-spacing:.08em; }
  input { width:100%; box-sizing:border-box; background:#18181b; border:1px solid #27272a; border-radius:12px;
    padding:11px 12px; color:#fff; font-size:15px; }
  button { width:100%; margin-top:20px; background:#a3e635; color:#000; border:0; border-radius:12px;
    padding:12px; font-size:14px; font-weight:800; cursor:pointer; }
  .error { background:rgba(244,63,94,.12); border:1px solid rgba(244,63,94,.4); color:#fda4af;
    border-radius:12px; padding:10px 12px; font-size:12px; line-height:1.7; margin:0 0 16px; }
  .note { font-size:10px; color:#52525b; line-height:1.8; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>LIFT &amp; LEAN</h1>
    <p class="lead">ChatGPT からあなたの記録を読み書きできるようにします。</p>
    ${errorBlock}
    <ul>
      <li>食事・体重・筋トレを<strong>記録する</strong></li>
      <li>その日の合計や最近の記録を<strong>読む</strong></li>
    </ul>
    <ul class="deny">
      <li>記録の削除・目標の変更はできません</li>
      <li>アカウント操作・支払いはできません</li>
    </ul>
    ${form}
    <p class="note">
      パスワードを入力するのはこの画面だけです。ChatGPT の会話には保存されません。<br>
      連携はアプリの設定画面からいつでも解除できます。
    </p>
  </div>
</body>
</html>`;
}
