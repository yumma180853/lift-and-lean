/**
 * 連携の認可（OAuth 2.1）のテスト。
 *
 * 守りたいこと:
 *   - 戻り先URLは許可したものだけ
 *   - PKCE(S256)を必ず検証する
 *   - 認可コードは1回だけ・短命
 *   - メール未確認では連携させない
 *   - ChatGPTの会話にパスワードを出させない設計であること（同意画面が唯一の入力箇所）
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';

process.env.APPWRITE_PROJECT_ID = 'test-project';
process.env.APPWRITE_API_KEY = 'test-key-not-a-secret';
process.env.APPWRITE_DATABASE_ID = 'testdb';
process.env.APPWRITE_ENDPOINT = 'https://example.invalid/v1';
process.env.APP_PUBLIC_URL = 'https://lift-and-lean.example';

const oauth = await import('../api/_mcp/oauth.ts');
const { renderConsentPage } = await import('../api/_mcp/consentPage.ts');

// ---------------------------------------------------------------- 戻り先

test('戻り先はChatGPTの受け口と検証用ローカルだけ許可する', () => {
  const allowed = [
    'https://chatgpt.com/connector/oauth/abc123',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'http://localhost:6274/oauth/callback',
    'http://127.0.0.1:3000/callback',
  ];
  for (const uri of allowed) {
    assert.equal(oauth.isAllowedRedirectUri(uri), true, uri);
  }

  const denied = [
    'https://evil.example/steal',
    'https://chatgpt.com.evil.example/connector/oauth/x',
    'https://chatgpt.com/other/path',
    'http://chatgpt.com/connector/oauth/x',      // httpは不可
    'javascript:alert(1)',
    'https://sub.chatgpt.com/connector/oauth/x',
  ];
  for (const uri of denied) {
    assert.equal(oauth.isAllowedRedirectUri(uri), false, uri);
  }
});

// ---------------------------------------------------------------- PKCE

test('PKCEはS256で検証する', () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  assert.equal(oauth.verifyPkce(challenge, verifier), true);
  assert.equal(oauth.verifyPkce(challenge, 'wrong-verifier'), false);
  // plain（無変換）は通さない
  assert.equal(oauth.verifyPkce(verifier, verifier), false);
});

// ---------------------------------------------------------------- メタデータ

test('保護リソースのメタデータがMCPの要求を満たす', () => {
  const metadata = oauth.protectedResourceMetadata();
  assert.equal(metadata.resource, 'https://lift-and-lean.example/api/mcp');
  assert.deepEqual(metadata.authorization_servers, ['https://lift-and-lean.example/']);
  assert.deepEqual(metadata.scopes_supported, ['data:read', 'log:write']);
});

test('401の案内はどこで認可を受ければよいか示す', () => {
  const header = oauth.wwwAuthenticateHeader();
  assert.match(header, /^Bearer /);
  assert.match(header, /resource_metadata="https:\/\/lift-and-lean\.example\/\.well-known\/oauth-protected-resource"/);
  // ヘッダに載るのでASCIIだけ
  assert.equal(/^[\x20-\x7E]*$/.test(header), true, 'ヘッダはASCIIのみ');
});

// ---------------------------------------------------------------- 同意画面

test('同意画面は許可する操作と、しない操作の両方を書く', () => {
  const html = renderConsentPage({
    clientId: 'll-abc', redirectUri: 'https://chatgpt.com/connector/oauth/x', codeChallenge: 'ch',
  });

  assert.match(html, /記録する/);
  assert.match(html, /読む/);
  assert.match(html, /削除・目標の変更はできません/);
  assert.match(html, /アカウント操作・支払いはできません/);
  assert.match(html, /type="password"/, 'パスワードはこの画面だけで入力する');
  assert.match(html, /noindex/);
  assert.match(html, /ChatGPT 側で接続を削除/, '解除の方法を実際にできる形で書く');
  assert.match(html, /アプリのログインには影響しません/);
});

test('同意画面は入力値をそのままHTMLに埋めない', () => {
  const html = renderConsentPage({
    clientId: '"><script>alert(1)</script>',
    redirectUri: 'https://chatgpt.com/connector/oauth/x',
    codeChallenge: 'ch',
    error: '<img src=x onerror=alert(1)>',
  });

  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('<img src=x onerror'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('必要な値が無ければ同意画面はフォームを出さない', () => {
  const html = renderConsentPage({ error: 'リクエストの内容が正しくありません。' });
  assert.equal(html.includes('type="password"'), false);
  assert.match(html, /リクエストの内容が正しくありません/);
});
