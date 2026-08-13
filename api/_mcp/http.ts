/**
 * MCPのHTTP入口。
 *
 * - `/api/mcp` … Streamable HTTP（サーバーレスなのでセッションを持たない形で動かす）
 * - `/oauth/*` と `/.well-known/*` … OAuth 2.1（MCP SDKの標準ルーターに任せる）
 *
 * プロトコルの細部（メタデータの形・エラー形式・PKCE検証・レート制限）は
 * SDKの実装をそのまま使い、こちらは「本人確認をどうするか」だけを与える。
 */

import express from 'express';
import type { Request, Response } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { AppError, toErrorResponse } from '../_core/errors.js';
import { publicAppUrl } from '../_appwrite/client.js';
import { authorizationCodeStore } from './store.js';
import {
  MCP_SCOPES,
  exchangeCode,
  grantAuthorization,
  isAllowedRedirectUri,
  issuerUrl,
  mcpResourceUrl,
  protectedResourceMetadata,
  revokeAccessToken,
  verifyAccessToken,
} from './oauth.js';
import { buildMcpServer, createServiceForSession } from './server.js';
import type { McpSession } from './server.js';
import type { LiftAndLeanService } from '../_core/service.js';
import type { VerifiedToken } from './oauth.js';
import { renderConsentPage } from './consentPage.js';

// ---------------------------------------------------------------- クライアント

/**
 * 登録済みクライアントの管理。
 *
 * 公開クライアント＋PKCEが前提なので、識別子そのものに秘密は無い。
 * 保存を持たず、**識別子に戻り先URLを埋め込む**（戻り先は許可リストで縛る）。
 * こうするとサーバーレスでも状態を持たずに済み、登録情報の取り違えも起きない。
 */
const encodeClientId = (redirectUri: string): string => `ll-${Buffer.from(redirectUri).toString('base64url')}`;

function decodeClientId(clientId: string): string | null {
  if (!clientId.startsWith('ll-')) return null;
  try {
    const uri = Buffer.from(clientId.slice(3), 'base64url').toString('utf8');
    return isAllowedRedirectUri(uri) ? uri : null;
  } catch {
    return null;
  }
}

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const redirectUri = decodeClientId(clientId);
    if (!redirectUri) return undefined;
    return {
      client_id: clientId,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: MCP_SCOPES.join(' '),
    };
  },

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const redirectUri = client.redirect_uris?.[0];
    if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
      throw new AppError('invalid_redirect_uri', 400, '戻り先のURLが許可されていません。');
    }
    return {
      ...client,
      client_id: encodeClientId(redirectUri),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: MCP_SCOPES.join(' '),
    };
  },
};

/** 検証結果の有効期間。実際には毎回問い合わせ直すので、長く持たせる意味は無い */
const VERIFICATION_TTL_SECONDS = 60;

// ---------------------------------------------------------------- provider

/**
 * 差し替え口。テストではAppwriteに繋がず、
 * 「トークンの確かめ方」と「サービスの作り方」だけを入れ替える。
 */
export interface McpAppDeps {
  verifyToken?: (token: string) => Promise<VerifiedToken>;
  createService?: (session: McpSession) => LiftAndLeanService;
}

const buildProvider = (deps: McpAppDeps): OAuthServerProvider => ({
  get clientsStore() { return clientsStore; },

  /** 同意画面へ送る。実際のコード発行は同意画面のPOSTで行う */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      scope: (params.scopes ?? [...MCP_SCOPES]).join(' '),
    });
    if (params.state) query.set('state', params.state);
    if (params.resource) query.set('resource', params.resource.toString());
    res.redirect(`${publicAppUrl()}/oauth/consent?${query.toString()}`);
  },

  async challengeForAuthorizationCode(_client, authorizationCode: string): Promise<string> {
    const record = await authorizationCodeStore.peek(authorizationCode);
    if (!record) throw new AppError('invalid_grant', 400, '認可コードが無効か期限切れです。');
    return record.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    if (!codeVerifier) throw new AppError('invalid_request', 400, 'code_verifier がありません。');
    const result = await exchangeCode(authorizationCode, codeVerifier, client.client_id, redirectUri);
    return {
      access_token: result.accessToken,
      token_type: 'Bearer',
      scope: result.scopes.join(' '),
    };
  },

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    // 更新トークンは発行しない。失効したら本人がもう一度つなぎ直す
    throw new AppError('unsupported_grant_type', 400, 'この連携では更新トークンを使いません。');
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 認証の失敗は OAuth の形（401 invalid_token）で返す必要がある。
    // そのまま投げると 500 になり、クライアントが再認可へ進めない
    let verified: VerifiedToken;
    try {
      verified = await (deps.verifyToken ?? verifyAccessToken)(token);
    } catch (error) {
      // **この文言はHTTPヘッダ（WWW-Authenticate）に載るのでASCIIだけにする。**
      // 日本語を入れるとヘッダを組み立てられずサーバーが落ちる
      const status = (error as any)?.status;
      if (status === 401 || status === 403) {
        throw new InvalidTokenError('invalid or expired access token');
      }
      console.error('mcp token verification failed:', error);
      throw new ServerError('token verification failed');
    }
    return {
      token,
      clientId: 'lift-and-lean',
      scopes: verified.scopes,
      // **毎回Appwriteに問い合わせて確かめている**ので、この値はこのリクエストの間だけ有効。
      // 連携を解除すれば次の呼び出しで弾かれる（期限切れを待つ必要はない）
      expiresAt: Math.floor(Date.now() / 1000) + VERIFICATION_TTL_SECONDS,
      extra: { userId: verified.userId },
    };
  },

  async revokeToken(_client, request): Promise<void> {
    await revokeAccessToken(request.token);
  },
});

// ---------------------------------------------------------------- express

export function createMcpApp(deps: McpAppDeps = {}) {
  const provider = buildProvider(deps);
  const makeService = deps.createService ?? createServiceForSession;
  const app = express();
  app.disable('x-powered-by');

  // OAuthのメタデータ・authorize・token・register・revoke
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(issuerUrl()),
    baseUrl: new URL(issuerUrl()),
    resourceServerUrl: new URL(mcpResourceUrl()),
    resourceName: 'Lift & Lean',
    scopesSupported: [...MCP_SCOPES],
  }));

  // RFC 9728 の導出パス（/.well-known/oauth-protected-resource/api/mcp）は
  // 上のルーターが用意する。素のパスを見に来るクライアントにも同じ内容を返す
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(protectedResourceMetadata());
  });

  // 同意画面（本人確認はここだけで行う。ChatGPTの会話にパスワードを出さない）
  app.get('/oauth/consent', (req: Request, res: Response) => {
    const params = req.query as Record<string, string | undefined>;
    if (!params.client_id || !params.redirect_uri || !params.code_challenge) {
      res.status(400).send(renderConsentPage({ error: 'リクエストの内容が正しくありません。' }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderConsentPage({
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      state: params.state,
      scope: params.scope,
      resource: params.resource,
    }));
  });

  app.post('/oauth/consent', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const code = await grantAuthorization({
        clientId: body.client_id ?? '',
        redirectUri: body.redirect_uri ?? '',
        codeChallenge: body.code_challenge ?? '',
        scopes: (body.scope ?? '').split(' ').filter(Boolean),
        resource: body.resource,
        email: body.email ?? '',
        password: body.password ?? '',
      });
      const target = new URL(body.redirect_uri!);
      target.searchParams.set('code', code);
      if (body.state) target.searchParams.set('state', body.state);
      res.redirect(target.toString());
    } catch (error) {
      const { status, body: payload } = toErrorResponse(error);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(status).send(renderConsentPage({
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        state: body.state,
        scope: body.scope,
        resource: body.resource,
        error: payload.error,
      }));
    }
  });

  // MCP本体。サーバーレスなので接続をまたぐセッションは持たない
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(mcpResourceUrl()));
  const requireAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post('/api/mcp', express.json({ limit: '1mb' }), requireAuth, async (req: Request, res: Response) => {
    const auth = req.auth;
    if (!auth) { res.status(401).end(); return; }

    const session = { userId: String(auth.extra?.userId ?? ''), sessionSecret: auth.token };
    const server = buildMcpServer(() => ({
      service: makeService(session),
      userId: session.userId,
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // ステートレス
      enableJsonResponse: true,
    });

    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
    } catch (error) {
      console.error('mcp transport error:', error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  // ステートレスなのでサーバー起点の通知は返さない
  app.get('/api/mcp', requireAuth, (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });
  app.delete('/api/mcp', requireAuth, (_req: Request, res: Response) => res.status(204).end());

  return app;
}
