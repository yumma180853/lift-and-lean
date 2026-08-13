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
import { InvalidGrantError, InvalidTargetError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
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
  refreshTokens,
  revokeAccessToken,
  verifyAccessToken,
} from './oauth.js';
import { buildMcpServer, createServiceForSession } from './server.js';
import type { McpSession } from './server.js';
import type { LiftAndLeanService } from '../_core/service.js';
import type { OAuthDeps, VerifiedToken } from './oauth.js';
import type { IssuedTokens } from './tokens.js';
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
      grant_types: ['authorization_code', 'refresh_token'],
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
    // 公開クライアントなので**秘密は持たせない**。
    // SDKが用意した client_secret はここで落とす（持たせると誤って使われる）
    const { client_secret: _secret, client_secret_expires_at: _expiry, ...metadata } = client;
    return {
      ...metadata,
      client_id: encodeClientId(redirectUri),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_SCOPES.join(' '),
    };
  },
};

// ---------------------------------------------------------------- provider

/**
 * 差し替え口。テストではAppwriteに繋がず、
 * 「トークンの確かめ方」と「サービスの作り方」だけを入れ替える。
 */
export interface McpAppDeps {
  createService?: (session: McpSession) => LiftAndLeanService;
  /** 保管庫と本人確認。テストではAppwrite/KVに繋がずに差し替える */
  oauth?: OAuthDeps;
}

/** トークン応答。**ここに載るのは自分が発行した値だけ** */
const tokenResponse = (issued: IssuedTokens): OAuthTokens => ({
  access_token: issued.accessToken,
  token_type: 'Bearer',
  expires_in: issued.expiresIn,
  refresh_token: issued.refreshToken,
  scope: issued.scopes.join(' '),
});

/** 認可のエラーをOAuthの形へ。そのまま投げるとSDKが500にしてしまう */
function asOAuthError(error: unknown, fallback: string): never {
  if (error instanceof AppError) {
    if (error.code === 'invalid_target') throw new InvalidTargetError('token is not valid for the requested resource');
    if (error.status === 400 || error.status === 401) throw new InvalidGrantError(fallback);
  }
  console.error('mcp token endpoint failed:', error);
  throw new ServerError('token exchange failed');
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
    // 失敗はOAuthのエラー形式で返す。そのまま投げるとSDKが500にしてしまい、
    // クライアントは「サーバー障害」と受け取って再認可へ進めない
    const record = await (deps.oauth?.store ?? authorizationCodeStore).peek(authorizationCode);
    if (!record) throw new InvalidGrantError('authorization code is invalid or expired');
    return record.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    try {
      return tokenResponse(
        await exchangeCode(authorizationCode, codeVerifier, client.client_id, redirectUri, resource, deps.oauth),
      );
    } catch (error) {
      asOAuthError(error, 'authorization code is invalid or expired');
    }
  },

  /** 公開クライアント向けに**毎回入れ替える**。使い回しは連携ごと取り消す */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    try {
      return tokenResponse(await refreshTokens(refreshToken, resource, deps.oauth));
    } catch (error) {
      asOAuthError(error, 'refresh token is invalid or expired');
    }
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 認証の失敗は OAuth の形（401 invalid_token）で返す必要がある。
    // そのまま投げると 500 になり、クライアントが再認可へ進めない
    let verified: VerifiedToken;
    try {
      verified = await verifyAccessToken(token, deps.oauth);
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
      // 発行したときに決めた相手。SDKの型どおり、MCPの資源識別子と一致していること
      resource: new URL(verified.resource),
      expiresAt: Math.floor(verified.expiresAt / 1000),
      // **appwriteSession はサーバー側だけで使う**。
      // 応答にもログにも出さない（req.auth はレスポンスに載らない）
      extra: { userId: verified.userId, appwriteSession: verified.sessionSecret },
    };
  },

  async revokeToken(_client, request): Promise<void> {
    await revokeAccessToken(request.token, deps.oauth);
  },
});

// ---------------------------------------------------------------- express

export function createMcpApp(deps: McpAppDeps = {}) {
  const provider = buildProvider(deps);
  const makeService = deps.createService ?? createServiceForSession;
  const app = express();
  app.disable('x-powered-by');
  // Vercelのプロキシ配下で動く。これが無いと、SDKのレート制限が
  // X-Forwarded-For を見つけて設定不備として例外を投げ、認可エンドポイントが500になる
  app.set('trust proxy', 1);

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
      }, deps.oauth);
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

    // **Appwriteのセッションはトークンからサーバー側で解決する**。
    // 受け取ったBearer値をそのまま下流へ渡すこと（素通し）はしない
    const session = {
      userId: String(auth.extra?.userId ?? ''),
      sessionSecret: String(auth.extra?.appwriteSession ?? ''),
    };
    if (!session.userId || !session.sessionSecret) { res.status(401).end(); return; }
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
