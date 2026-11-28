/**
 * 数据集退役、恢复的短期确认票（#1015 首版）：预检时发，确认时用一次。
 *
 * - 票本身就是凭据：随机 32 字节（base64url）；这里只存它的 sha256，编号 ref（rt-<8 位十六进制>）给审计，日志里不出现票；
 * - 票绑一件事：动作（retire / restore）、谁（账号标识）、哪个台（slug + 登记时刻，同名台删建后对不上）、数据集和它当时的整套上下文
 *   （身份、修订、恢复代次、状态、视图与报告绑定修订——canonical 摘要）。用票时上下文任何一项变了都对不上，回冲突要求重新预检；
 * - 有效期 5 分钟，只能用一次：take() 里同步删，并发重放拿不到第二次；
 * - 每个账号最多同时 10 张，全局 500 张，满了拒绝（不挤掉别人的）；
 * - 只在内存里，重启全部作废；没有定时器，过期的在每次发票时顺手清掉。
 * 票只说「谁、哪个台、哪个数据集、哪个动作、当时什么样」；能不能退役仍由路由在确认时再判一次权限，由台库事务再核一次围栏。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type RetireAction = 'retire' | 'restore';
export interface RetireTicketBinding { action: RetireAction; actor: string; bench: string; benchCreatedAt: number; dataset: string; contextSha256: string }
interface Stored extends RetireTicketBinding { ref: string; expiresAt: number }

export const RETIRE_TICKET_TTL_MS = 5 * 60_000;
const PER_ACTOR = 10, GLOBAL = 500;
const store = new Map<string, Stored>();
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const sweep = (now: number): void => { for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k); };

export function issueRetireTicket(b: RetireTicketBinding, now = Date.now()): { ticket: string; ref: string; expires_at: number } | null {
  sweep(now);
  if (store.size >= GLOBAL || [...store.values()].filter(t => t.actor === b.actor).length >= PER_ACTOR) return null;
  const ticket = randomBytes(32).toString('base64url'), ref = 'rt-' + randomBytes(4).toString('hex');
  store.set(sha(ticket), { ...b, ref, expiresAt: now + RETIRE_TICKET_TTL_MS });
  return { ticket, ref, expires_at: now + RETIRE_TICKET_TTL_MS };
}

/** 用票：对上就删掉并返回编号；对不上（没有、过期、绑定不同）返回 null。绑定不同的票不会被删——别人拿错票不能烧掉你的票。 */
export function takeRetireTicket(ticket: unknown, b: RetireTicketBinding, now = Date.now()): string | null {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 100) return null;
  sweep(now);
  const key = sha(ticket), t = store.get(key);
  if (!t) return null;
  const same = (['action', 'actor', 'bench', 'dataset', 'contextSha256'] as const).every(k => {
    const x = Buffer.from(String(t[k])), y = Buffer.from(String(b[k]));
    return x.length === y.length && timingSafeEqual(x, y);
  }) && t.benchCreatedAt === b.benchCreatedAt;
  if (!same) return null;
  store.delete(key);
  return t.ref;
}
export const retireTicketCount = (): number => store.size;
