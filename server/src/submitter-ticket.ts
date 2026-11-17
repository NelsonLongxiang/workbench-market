/**
 * 提交人票据（阶段八 8f-2）。台页面跑在沙箱里（不透明源），提交时带不上登录；服务端出台页面 HTML 的那一刻知道是谁，
 * 认得出是启用的人，就在页面里放一张票据，提交时放在信封的 submitter_ticket 里带回。
 *
 * 票据只有一个用处：在「这个台」的提交上记下「这个人」。别的入口一律不认它，换不出登录、会话或任何权限。
 *   · 服务端密钥签名（HMAC-SHA256，密钥单独一把，存在数据目录、权限 600，不和台令牌共用）；
 *   · 绑定主体标识、台 slug、签发时间、过期时间；有效期两小时，不续期（页面重新加载拿新的）；
 *   · 验：形状、签名、没过期、签发时间不在将来、有效期就是两小时、台一致。主体还是不是启用的人由调用方每次现查。
 * 票据不进日志、不进事件、不进导出；这里也不打印它。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { svc } from './context.ts';
import type { PrincipalService } from './services/principal.ts';
import { countSubmitterTicket } from './services/submission-counts.ts';

export const SUBMITTER_TICKET_TTL_SECONDS = 2 * 60 * 60;
const VERSION = 'st1';
const DOMAIN = 'wm-submitter-ticket/v1\n';
const SKEW_SECONDS = 60;
const PRINCIPAL = /^user:[^\s]{1,200}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SHAPE = /^st1\.[A-Za-z0-9_-]{1,700}\.[A-Za-z0-9_-]{43}$/;

let key: Buffer | null = null;
/** 启动自检没过：票据关掉（不出、不认） */
let disabled = false;

/** 启动时调一次：读数据目录里的密钥，没有就生成一把（原子写、600）。写不进去就用进程内随机密钥（重启后旧票据作废，可接受） */
export function initSubmitterTickets(dataDir: string): void {
  const file = join(dataDir, '.wm-submitter-ticket.key');
  try {
    const hex = String(readFileSync(file, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(hex)) { key = Buffer.from(hex, 'hex'); return; }
  } catch { /* 第一次 */ }
  const fresh = randomBytes(32).toString('hex');
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, fresh, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    console.warn('[submitter-ticket] 密钥写不进数据目录，本进程用随机密钥（重启后旧票据作废）');
  }
  key = Buffer.from(fresh, 'hex');
}

/**
 * 启动自检（每次启动跑一遍，读密钥之后）：同一张票据在本台验得过；换个台、改一个字节、过期了都验不过。
 * 任一项不对就关掉票据（不出、不认——台的提交照今天一样留空），并打一行告警。只记过没过，不记票据。
 */
export function selfCheckSubmitterTickets(): boolean {
  const now = Date.now();
  let ok = false;
  try {
    const t = issueSubmitterTicket('user:wm-self-check', 'wm-self-check', now);
    const i = t.length - 5;
    const tampered = t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1);
    ok = verifySubmitterTicket(t, 'wm-self-check', now) === 'user:wm-self-check'
      && verifySubmitterTicket(t, 'wm-self-check-other', now) === null
      && verifySubmitterTicket(tampered, 'wm-self-check', now) === null
      && verifySubmitterTicket(t, 'wm-self-check', now + (SUBMITTER_TICKET_TTL_SECONDS + 1) * 1000) === null;
  } catch { ok = false; }
  disabled = !ok;
  console.log(JSON.stringify({ source: 'submitter-ticket', event: 'self-check', verdict: ok ? 'pass' : 'fail', ...(ok ? {} : { effect: '票据已关闭：不出、不认' }) }));
  return ok;
}

function sign(payload: string): string {
  if (!key) throw new Error('提交人票据的密钥还没初始化');
  return createHmac('sha256', key).update(DOMAIN + payload).digest('base64url');
}

/** 给这个人、这个台签一张票据。principal 要是人的主体标识 */
export function issueSubmitterTicket(principal: string, slug: string, nowMs = Date.now()): string {
  if (disabled) throw new Error('提交人票据已关闭（启动自检没过）');
  if (!PRINCIPAL.test(principal) || !SLUG.test(slug)) throw new Error('票据的主体或台不对');
  const iat = Math.floor(nowMs / 1000);
  const payload = [principal, slug, String(iat), String(iat + SUBMITTER_TICKET_TTL_SECONDS)].join('\n');
  return `${VERSION}.${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
}

/** 验票：通过就返回票据上的主体，否则 null（不分原因）。主体是否仍启用由调用方现查 */
export function verifySubmitterTicket(ticket: unknown, slug: string, nowMs = Date.now()): string | null {
  try {
    if (disabled || typeof ticket !== 'string' || !SHAPE.test(ticket) || !key) return null;
    const [, body, sig] = ticket.split('.');
    const payload = Buffer.from(body, 'base64url').toString('utf8');
    if (Buffer.from(payload, 'utf8').toString('base64url') !== body) return null; // 非规范编码
    const want = Buffer.from(sign(payload)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const parts = payload.split('\n');
    if (parts.length !== 4) return null;
    const [principal, boundSlug, iatText, expText] = parts;
    if (!/^\d{1,12}$/.test(iatText) || !/^\d{1,12}$/.test(expText)) return null;
    const iat = Number(iatText), exp = Number(expText), now = Math.floor(nowMs / 1000);
    if (exp - iat !== SUBMITTER_TICKET_TTL_SECONDS || iat > now + SKEW_SECONDS || exp <= now) return null;
    if (!PRINCIPAL.test(principal) || boundSlug !== slug) return null;
    return principal;
  } catch { return null; }
}

/**
 * 台的提交上带来的票据：验得过、主体现在还是启用的人，才返回主体；否则 null。
 * 带了却验不过的记一笔「票据无效」的计数（不记原因、不记票据）；没带不记。
 */
export function submitterFromTicket(ticket: unknown, slug: string): string | null {
  if (ticket === undefined || ticket === null || ticket === '') return null;
  const principal = verifySubmitterTicket(ticket, slug);
  let ok = false;
  if (principal) {
    try {
      const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string } | null;
      ok = Boolean(p && p.kind === 'person' && p.status === 'active');
    } catch { ok = false; }
  }
  countSubmitterTicket(ok ? 'valid' : 'invalid');
  return ok ? principal : null;
}
