/**
 * 本番用の配線。router（HTTPの形）と Appwrite（DBと認証）をここで結ぶ。
 * テストはこのファイルを使わず、router に偽の依存を差し込む。
 */

import { AppwriteRepository } from '../_appwrite/repository.js';
import {
  SESSION_COOKIE,
  buildClearedSessionCookie,
  buildSessionCookie,
  completeEmailVerification,
  completePasswordRecovery,
  logIn,
  logOut,
  parseCookies,
  requestPasswordRecovery,
  resolveUser,
  sendEmailVerification,
  signUp,
} from '../_appwrite/auth.js';
import { LiftAndLeanService } from '../_core/service.js';
import { createV1Router } from './router.js';
import { parseCommandWithLLM } from './commandParser.js';
import { openAiTranscriber } from './transcribe.js';

function appendHeader(res: any, name: string, value: string): void {
  const existing = typeof res.getHeader === 'function' ? res.getHeader(name) : undefined;
  const next = existing ? (Array.isArray(existing) ? [...existing, value] : [existing, value]) : value;
  res.setHeader(name, next);
}

export const handleV1 = createV1Router({
  auth: {
    signUp, logIn, logOut, resolveUser,
    requestPasswordRecovery, completePasswordRecovery,
    sendEmailVerification, completeEmailVerification,
  },
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
  parseCommand: parseCommandWithLLM,
  transcribe: openAiTranscriber,
});

export { SESSION_COOKIE };
