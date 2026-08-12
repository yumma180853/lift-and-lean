/**
 * 本番用の配線。router（HTTPの形）と Appwrite（DBと認証）をここで結ぶ。
 * テストはこのファイルを使わず、router に偽の依存を差し込む。
 */

import { AppwriteRepository } from '../appwrite/repository.ts';
import {
  SESSION_COOKIE,
  buildClearedSessionCookie,
  buildSessionCookie,
  logIn,
  logOut,
  parseCookies,
  resolveUser,
  signUp,
} from '../appwrite/auth.ts';
import { LiftAndLeanService } from '../core/service.ts';
import { createV1Router } from './router.ts';

function appendHeader(res: any, name: string, value: string): void {
  const existing = typeof res.getHeader === 'function' ? res.getHeader(name) : undefined;
  const next = existing ? (Array.isArray(existing) ? [...existing, value] : [existing, value]) : value;
  res.setHeader(name, next);
}

export const handleV1 = createV1Router({
  auth: { signUp, logIn, logOut, resolveUser },
  createService: (sessionSecret: string) => new LiftAndLeanService({
    repository: new AppwriteRepository({ sessionSecret }),
  }),
  readCookie: (req: any) => parseCookies(req.headers?.cookie)[SESSION_COOKIE],
  setSessionCookie: (res: any, secret: string, expiresAt: string) => {
    appendHeader(res, 'Set-Cookie', buildSessionCookie(secret, expiresAt));
  },
  clearSessionCookie: (res: any) => {
    appendHeader(res, 'Set-Cookie', buildClearedSessionCookie());
  },
});

export { SESSION_COOKIE };
