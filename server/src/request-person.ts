/**
 * 这个请求是哪个人（阶段八 8f）：只经身份服务认请求带的登录凭据（cookie），认出的主体还要是启用的人。
 * 请求体、查询串里自报的任何名字都不看。认不出、出错都返回 principal: null——调用方照常放行，只是不记人。
 * 口令、本机命令行、席位的会话令牌都不是人，这里认不出。
 */
import type express from 'express';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import type { PrincipalService } from './services/principal.ts';

export type RequestPerson = { hasCredential: boolean; principal: string | null };

export async function requestPerson(req: express.Request): Promise<RequestPerson> {
  const cookie = String(req.headers.cookie ?? '');
  const hasCredential = hasLoginCredential(req);
  if (!hasCredential) return { hasCredential, principal: null };
  try {
    const who = await identity().resolveViewer(cookie);
    if (!who.ok) return { hasCredential, principal: null };
    const p = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | null;
    return { hasCredential, principal: p && p.kind === 'person' && p.status === 'active' ? who.viewer.sub : null };
  } catch { return { hasCredential, principal: null }; }
}

/** 请求有没有带登录凭据（登录提供方的会话，或市场会话；只看有没有，不去认是谁） */
export function hasLoginCredential(req: express.Request): boolean {
  const cookie = String(req.headers.cookie ?? '');
  if (!cookie) return false;
  try { return Boolean(identity().credentialOf(cookie)) || identity().hasSession(cookie); } catch { return false; }
}
