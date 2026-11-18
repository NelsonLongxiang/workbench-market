/**
 * 市场会话（cookie wm_session）的期限：一次登录持续保持。
 *
 *   · 滑动续期：WM_SESSION_IDLE_DAYS（缺省 30 天）——这么久没来过才掉；来过就往后顺延，但离上次续期满一天才续一次（库里写一次、发一次 Set-Cookie）。
 *   · 绝对上限：WM_SESSION_MAX_DAYS（缺省 365 天）——从登录那一刻算，怎么续也不超过它，到点要重新登录。
 *   · cookie 是持久的（带 Max-Age，浏览器关了再开还在），库里只存随机值的哈希，没有按启动生成的密钥：重启、重建容器、重新部署之后照样有效。
 *   · 改密码、停用、解绑、登出立即失效（会话那一行记 revoked_at，或者认人时连着主体、外部身份现查）；续期只续还算数的，失效的续不回来。
 *     收回授予：授予每次认人现查，收回后下一个请求就没有那份权限；会话本身照旧（人还是那个人）。
 *
 * 旧变量 WM_SESSION_TTL_MIN（分钟，15～10080）还兼容一个版本：只设了它、两个新变量都没设时，它当作绝对上限（滑动窗口取 30 天和它的较小者），
 * 效果和以前一样（到点就掉、不续）；启动时打一行弃用警告。和新变量一起设时以新变量为准，它被忽略，也打一行警告。
 *
 * 口令登录的 wm_login（管理口令换来的 cookie）不归这里管，照旧 12 小时。
 */
import type express from 'express';
import { defineConfig } from './config.ts';
import { identity, SESSION_COOKIE } from './identity.ts';
import { svc } from './context.ts';
import type { LoginSessionService } from './services/login-session.ts';

const DAY_MS = 86_400_000;
/** 离上次续期满这么久才续一次 */
export const RENEW_EVERY_MS = DAY_MS;

export type SessionLife = { idleMs: number; maxMs: number };

const intIn = (name: string, raw: string, lo: number, hi: number): number => {
  const n = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} 只接受 ${lo}～${hi} 的整数`);
  return n;
};

/** 读三个变量，算出会话期限；不合法抛错（启动时拒绝启动）。warnings 是要在启动时打出来的弃用提示 */
export const Config = defineConfig((env) => {
  const idleRaw = String(env.WM_SESSION_IDLE_DAYS ?? '').trim();
  const maxRaw = String(env.WM_SESSION_MAX_DAYS ?? '').trim();
  const ttlRaw = String(env.WM_SESSION_TTL_MIN ?? '').trim();
  const warnings: string[] = [];
  if (idleRaw === '' && maxRaw === '' && ttlRaw !== '') {
    const min = intIn('WM_SESSION_TTL_MIN', ttlRaw, 15, 10080);
    const maxMs = min * 60_000;
    warnings.push('WM_SESSION_TTL_MIN 已弃用：这次按它当绝对上限（到点就掉、不续期），请改用 WM_SESSION_IDLE_DAYS / WM_SESSION_MAX_DAYS');
    return { life: { idleMs: Math.min(30 * DAY_MS, maxMs), maxMs }, warnings };
  }
  const idleDays = idleRaw === '' ? 30 : intIn('WM_SESSION_IDLE_DAYS', idleRaw, 1, 3650);
  const maxDays = maxRaw === '' ? 365 : intIn('WM_SESSION_MAX_DAYS', maxRaw, 1, 3650);
  if (idleDays > maxDays) throw new Error(`WM_SESSION_IDLE_DAYS（${idleDays}）不能大于 WM_SESSION_MAX_DAYS（${maxDays}）`);
  if (ttlRaw !== '') warnings.push('WM_SESSION_TTL_MIN 已弃用，和 WM_SESSION_IDLE_DAYS / WM_SESSION_MAX_DAYS 一起设时被忽略');
  return { life: { idleMs: idleDays * DAY_MS, maxMs: maxDays * DAY_MS }, warnings };
});

const secure = (req: express.Request): boolean => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

/** 发、续 wm_session 用同一套属性：持久（Max-Age）、HttpOnly、SameSite=Lax、Path=/，https 时带 Secure，不带 Domain */
export function setSessionCookie(req: express.Request, res: express.Response, token: string, expiresAt: number, now = Date.now()): void {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure: secure(req), maxAge: Math.max(0, expiresAt - now) });
}

/**
 * 滑动续期：带着市场会话来的 /api/ 请求，会话还算数、离上次续期满一天，就往后顺延（不超过绝对上限），并重发 cookie。
 * 只看 /api/（页面和静态文件的应答不带 Set-Cookie，免得被缓存）；续不上（失效了、还不到一天、库出错）什么都不做，认人照旧由后面的关口判。
 */
export function sessionRenewal(life: SessionLife): express.RequestHandler {
  return function sessionRenewal(req, res, next) {
    try {
      if (req.path.startsWith('/api/')) {
        const token = identity().sessionToken(String(req.headers.cookie ?? ''));
        if (token) {
          const renewed = svc<LoginSessionService>('loginSessions').renewSession(token, life);
          if (renewed) setSessionCookie(req, res, token, renewed.expiresAt);
        }
      }
    } catch { /* 续不上不挡请求 */ }
    next();
  };
}
