/**
 * REST入口。HTTPの形をサービス層の呼び出しに変換するだけで、ここに判断を置かない。
 *
 * 不変条件:
 *   - userId は **必ずセッションから解決する**。body/query の userId は読まない
 *   - 例外は AppError だけが利用者へ文言を返す（それ以外は固定の汎用文）
 *   - 認証が要らないのは /auth/signup / /auth/login / パスワード再設定 / メール確認の完了
 *   - **メール未確認のユーザーはデータAPIを一切使えない**（403）
 *
 * 将来のMCPサーバーは同じサービス層を呼ぶ。ここを経由しないので、
 * ChatGPT側の仕様が変わってもこのファイルは影響を受けない。
 */

import { AppError, AuthError, toErrorResponse } from '../_core/errors.js';
import { credentialsSchema, parseInput, recoveryConfirmSchema, recoveryRequestSchema, verificationConfirmSchema } from '../_core/validation.js';
import type { Credentials, RecoveryConfirm, RecoveryRequest, VerificationConfirm } from '../_core/validation.js';
import type { AuthenticatedUser } from '../_core/ports.js';
import type { LiftAndLeanService } from '../_core/service.js';

export const V1_PREFIX = '/api/v1';

export interface AuthGateway {
  signUp(email: string, password: string, name?: string): Promise<{ user: AuthenticatedUser; secret: string; expiresAt: string }>;
  logIn(email: string, password: string): Promise<{ user: AuthenticatedUser; secret: string; expiresAt: string }>;
  logOut(secret: string): Promise<void>;
  resolveUser(secret: string | undefined): Promise<AuthenticatedUser>;
  requestPasswordRecovery(email: string): Promise<void>;
  completePasswordRecovery(userId: string, secret: string, password: string): Promise<void>;
  sendEmailVerification(sessionSecret: string): Promise<void>;
  completeEmailVerification(userId: string, secret: string, sessionSecret?: string): Promise<void>;
}

export interface RouterDeps {
  auth: AuthGateway;
  /** セッションごとにサービスを作る（読み取りはそのユーザーの権限で行うため） */
  createService(sessionSecret: string): LiftAndLeanService;
  readCookie(req: any): string | undefined;
  setSessionCookie(res: any, secret: string, expiresAt: string): void;
  clearSessionCookie(res: any): void;
}

interface RequestContext {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function send(res: any, status: number, body: unknown): void {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(status).json(body);
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: any): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  if (typeof req.body === 'string' && req.body.trim() !== '') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof req.on !== 'function') return {};
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createV1Router(deps: RouterDeps) {
  /** 処理したら true、対象外のURLなら false を返す */
  return async function handleV1(req: any, res: any): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(`${V1_PREFIX}/`) && url.pathname !== V1_PREFIX) return false;

    const context: RequestContext = {
      method: (req.method ?? 'GET').toUpperCase(),
      segments: url.pathname.slice(V1_PREFIX.length).split('/').filter(Boolean),
      query: url.searchParams,
      body: {},
    };
    if (context.method !== 'GET' && context.method !== 'DELETE') {
      context.body = await readBody(req);
    }

    try {
      await route(deps, req, res, context);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      if (status >= 500) console.error('v1 handler error:', error);
      send(res, status, body);
    }
    return true;
  };
}

async function route(deps: RouterDeps, req: any, res: any, ctx: RequestContext): Promise<void> {
  const [resource, second, third] = ctx.segments;

  // ---- 認証（ここだけ未ログインで呼べる）
  if (resource === 'auth') {
    if (second === 'signup' && ctx.method === 'POST') {
      const input = parseInput<Credentials>(credentialsSchema, ctx.body);
      const result = await deps.auth.signUp(input.email, input.password, input.name);
      deps.setSessionCookie(res, result.secret, result.expiresAt);
      return send(res, 201, { userId: result.user.userId });
    }
    if (second === 'login' && ctx.method === 'POST') {
      const input = parseInput<Credentials>(credentialsSchema, ctx.body);
      const result = await deps.auth.logIn(input.email, input.password);
      deps.setSessionCookie(res, result.secret, result.expiresAt);
      return send(res, 200, { userId: result.user.userId });
    }
    if (second === 'logout' && ctx.method === 'POST') {
      const secret = deps.readCookie(req);
      if (secret) await deps.auth.logOut(secret);
      deps.clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }
    if (second === 'me' && ctx.method === 'GET') {
      const secret = deps.readCookie(req);
      const user = await deps.auth.resolveUser(secret);
      return send(res, 200, {
        userId: user.userId, email: user.email, name: user.name, emailVerified: user.emailVerified,
      });
    }
    // メール確認は**未確認のままでも呼べる**（そうでないと確認しようがない）
    if (second === 'verification' && ctx.method === 'POST') {
      if (third === 'confirm') {
        const input = parseInput<VerificationConfirm>(verificationConfirmSchema, ctx.body);
        await deps.auth.completeEmailVerification(input.userId, input.secret, deps.readCookie(req));
        return send(res, 200, { ok: true });
      }
      // 再送。ログイン中の本人しか呼べないので、列挙には使えない
      const secret = deps.readCookie(req);
      if (!secret) throw new AuthError();
      await deps.auth.resolveUser(secret);
      await deps.auth.sendEmailVerification(secret);
      return send(res, 200, { ok: true });
    }
    if (second === 'recovery' && ctx.method === 'POST') {
      if (third === 'confirm') {
        const input = parseInput<RecoveryConfirm>(recoveryConfirmSchema, ctx.body);
        await deps.auth.completePasswordRecovery(input.userId, input.secret, input.password);
        return send(res, 200, { ok: true });
      }
      const input = parseInput<RecoveryRequest>(recoveryRequestSchema, ctx.body);
      await deps.auth.requestPasswordRecovery(input.email);
      // 登録済みかどうかに関わらず同じ応答にする（アカウント列挙を助長しない）
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: '不明なエンドポイントです。', code: 'not_found' });
  }

  // ---- ここから先は必ずログインが要る
  const secret = deps.readCookie(req);
  if (!secret) throw new AuthError();
  const user = await deps.auth.resolveUser(secret);

  // **メールアドレスの所有確認が済むまで、クラウドのデータには一切触らせない。**
  // 画面側でも隠しているが、APIを直接叩かれても同じように止める
  if (!user.emailVerified) {
    throw new AppError(
      'email_not_verified',
      403,
      'メールアドレスの確認が済んでいません。届いた確認メールのリンクを開いてください。',
    );
  }

  const service = deps.createService(secret);
  const userId = user.userId; // bodyのuserIdは読まない

  // アプリ本人の操作。過去日の編集を許す（ChatGPT経由とは扱いを変える）
  const asApp = { channel: 'app' as const };

  switch (resource) {
    case 'snapshot':
      requireMethod(ctx, 'GET');
      return send(res, 200, await service.getSnapshot(userId));

    case 'summary':
      requireMethod(ctx, 'GET');
      return send(res, 200, await service.getDaySummary(userId, ctx.query.get('date') ?? undefined));

    case 'progress':
      requireMethod(ctx, 'GET');
      return send(res, 200, { points: await service.getProgress(userId, Number(ctx.query.get('days') ?? 30)) });

    case 'meals':
      if (ctx.method === 'GET') {
        return send(res, 200, { meals: await service.listMeals(userId, ctx.query.get('date') ?? undefined) });
      }
      if (ctx.method === 'POST') {
        return send(res, 201, await service.logMeal(userId, ctx.body, asApp));
      }
      if (ctx.method === 'PATCH' && second) {
        await service.updateMeal(userId, second, ctx.body, asApp);
        return send(res, 200, { ok: true });
      }
      if (ctx.method === 'DELETE' && second) {
        await service.deleteMeal(userId, second);
        return send(res, 200, { ok: true });
      }
      break;

    case 'weights':
      if (ctx.method === 'GET') {
        return send(res, 200, {
          weights: await service.listWeights(userId, ctx.query.get('from') ?? undefined, ctx.query.get('to') ?? undefined),
        });
      }
      if (ctx.method === 'POST') {
        return send(res, 201, await service.logWeight(userId, ctx.body, asApp));
      }
      break;

    case 'workouts':
      if (ctx.method === 'GET' && second) {
        const workout = await service.getWorkout(userId, second);
        return send(res, 200, { workout });
      }
      if (ctx.method === 'GET') {
        return send(res, 200, { workouts: await service.getRecentWorkouts(userId, Number(ctx.query.get('limit') ?? 5)) });
      }
      if (ctx.method === 'POST') {
        return send(res, 201, await service.logWorkout(userId, ctx.body, asApp));
      }
      break;

    case 'exercises':
      if (ctx.method === 'POST' && second && third === 'sets') {
        return send(res, 201, await service.addSet(userId, second, ctx.body));
      }
      if (ctx.method === 'POST' && !second) {
        return send(res, 201, await service.addExercise(userId, ctx.body, asApp));
      }
      if (ctx.method === 'DELETE' && second) {
        await service.deleteExercise(userId, second);
        return send(res, 200, { ok: true });
      }
      break;

    case 'sets':
      if (ctx.method === 'PATCH' && second) {
        await service.updateSet(userId, second, ctx.body);
        return send(res, 200, { ok: true });
      }
      if (ctx.method === 'DELETE' && second) {
        await service.deleteSet(userId, second);
        return send(res, 200, { ok: true });
      }
      break;

    case 'goals':
      if (ctx.method === 'GET') return send(res, 200, { goals: await service.getGoals(userId) });
      if (ctx.method === 'PUT') {
        await service.saveGoals(userId, ctx.body);
        return send(res, 200, { ok: true });
      }
      break;

    case 'profile':
      if (ctx.method === 'GET') return send(res, 200, { profile: await service.getProfile(userId) });
      if (ctx.method === 'PUT') {
        await service.saveProfile(userId, ctx.body);
        return send(res, 200, { ok: true });
      }
      break;

    case 'migrate':
      requireMethod(ctx, 'POST');
      if (second === 'preview') {
        return send(res, 200, await service.previewMigration(userId, ctx.body));
      }
      if (second === 'verify') {
        return send(res, 200, await service.verifyMigration(userId, ctx.body));
      }
      if (!second) {
        const report = await service.migrateFromBackup(userId, ctx.body);
        return send(res, report.applied ? 200 : 409, report);
      }
      break;
  }

  return send(res, 404, { error: '不明なエンドポイントです。', code: 'not_found' });
}

function requireMethod(ctx: RequestContext, method: string): void {
  if (ctx.method !== method) {
    throw new AppError('method_not_allowed', 405, `このエンドポイントは ${method} のみ受け付けます。`);
  }
}
