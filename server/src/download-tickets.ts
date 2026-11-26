/**
 * MCP 附件短时下载票：会话对某台的某份附件有读取权限时，向 app_files_list 申请一张只读的下载票，
 * 取件工具（一般是 shell 里的 curl）凭票 GET /api/mcp-rest/downloads/<票> 取回这一份文件，全程不碰会话令牌。
 *
 * - 票本身就是凭据：随机 32 字节（base64url，43 个字符）；这里只存它的 sha256，不存原文。另有一个不保密的编号 ref（dt-<8 位十六进制>），
 *   给撤销和审计用——审计、日志里只出现编号，不出现票；
 * - 票只绑一件事：发票的会话（编号和名字）、台（slug、台的编号和建台时刻）、文件（编号、大小、sha256、落盘位置）、只读。
 *   同名台删了重建、文件被换掉，票都对不上；
 * - 短有效期（2 分钟）、明确的使用次数（默认 1 次，最多 5 次，给 Range 断点续传用）。次数在 take() 里同步扣：
 *   一个线程里 take 之间没有 await，并发的请求也各扣各的，超过上限的一律拿不到；有条件请求（If-None-Match、Range）也各算一次；
 * - 每会话最多同时 20 张，全局最多 1000 张，满了就拒（不挤掉别人的）；
 * - 只在内存里：重启就全部作废。没有定时器，过期的在每次发票时顺手清掉。
 * 票只说「谁、哪个台、哪份文件、只读」；能不能取，由路由在用票时再问一次（会话还在不在、授权还在不在、台和文件还是不是原来的）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors.ts';

export interface DownloadTicket {
  /** 不保密的编号，撤销和审计用 */
  ref: string;
  /** 发票的会话（编号 + 名字；null：网关关着时的匿名调用，用票时网关也得还关着） */
  sessionId: number | null;
  session: string | null;
  slug: string;
  /** 台在 apps 表里的编号和建台时刻：同名台重建就都变了 */
  appId: number;
  appCreatedAt: string;
  fileId: number;
  size: number;
  sha256: string;
  storagePath: string;
  maxUses: number;
  uses: number;
  issuedAt: number;
  expiresAt: number;
}

export const DOWNLOAD_TICKET_TTL_MS = 2 * 60_000;
export const DOWNLOAD_TICKET_USES_DEFAULT = 1;
export const DOWNLOAD_TICKET_USES_MAX = 5;
export const DOWNLOAD_TICKETS_PER_SESSION = 20;
export const DOWNLOAD_TICKETS_MAX = 1000;
/** 票的写法：base64url 的 32 字节。别的形状一律当不存在 */
export const DOWNLOAD_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
/** 编号的写法 */
export const DOWNLOAD_TICKET_REF_RE = /^dt-[0-9a-f]{8}$/;

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export class DownloadTickets {
  private readonly byHash = new Map<string, DownloadTicket>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }

  /** 发一张票；返回票的原文（只这一次给出）、编号和过期时刻 */
  issue(t: Omit<DownloadTicket, 'ref' | 'uses' | 'issuedAt' | 'expiresAt'>): { token: string; ref: string; expiresAt: number } {
    this.sweep();
    if (!Number.isSafeInteger(t.maxUses) || t.maxUses < 1 || t.maxUses > DOWNLOAD_TICKET_USES_MAX) throw new HttpError(400, `max_uses 是 1 到 ${DOWNLOAD_TICKET_USES_MAX} 的整数`);
    let mine = 0;
    for (const x of this.byHash.values()) if (x.sessionId === t.sessionId && x.session === t.session) mine++;
    if (mine >= DOWNLOAD_TICKETS_PER_SESSION) throw new HttpError(429, `这个会话手上已有 ${mine} 张没用完的下载票（上限 ${DOWNLOAD_TICKETS_PER_SESSION}）：先用掉、撤销或等它们过期（${Math.round(DOWNLOAD_TICKET_TTL_MS / 60000)} 分钟）`);
    if (this.byHash.size >= DOWNLOAD_TICKETS_MAX) throw new HttpError(503, '下载票发得太多，稍后再试');
    const token = randomBytes(32).toString('base64url');
    const ref = `dt-${randomBytes(4).toString('hex')}`;
    const issuedAt = this.now();
    const expiresAt = issuedAt + DOWNLOAD_TICKET_TTL_MS;
    this.byHash.set(hashOf(token), { ...t, ref, uses: 0, issuedAt, expiresAt });
    return { token, ref, expiresAt };
  }

  /**
   * 用票：形状不对、没有、已过期、次数用完都是 null。拿到就扣一次（这一步是同步的，并发的请求也各扣各的）；扣到上限当场删掉。
   * 返回的是扣过之后的快照。
   */
  take(token: unknown): DownloadTicket | null {
    if (typeof token !== 'string' || !DOWNLOAD_TICKET_RE.test(token)) return null;
    const key = hashOf(token);
    const t = this.byHash.get(key);
    if (!t) return null;
    if (this.now() >= t.expiresAt) { this.byHash.delete(key); return null; }
    t.uses += 1;
    if (t.uses >= t.maxUses) this.byHash.delete(key);
    return { ...t };
  }

  /** 作废这一张（用票时发现发票的会话没了、授权收回、台或文件对不上）：后面再来的也拿不到 */
  drop(token: unknown): void {
    if (typeof token === 'string' && DOWNLOAD_TICKET_RE.test(token)) this.byHash.delete(hashOf(token));
  }

  /** 撤销：只有发票的会话能撤自己的票。编号不对、不是自己的、已经用完或过期，都是 false（不说是哪一种） */
  revoke(ref: unknown, sessionId: number | null, session: string | null): boolean {
    if (typeof ref !== 'string' || !DOWNLOAD_TICKET_REF_RE.test(ref)) return false;
    this.sweep();
    for (const [k, t] of this.byHash) {
      if (t.ref === ref && t.sessionId === sessionId && t.session === session) { this.byHash.delete(k); return true; }
    }
    return false;
  }

  /** 还没用完、没过期的张数（自检和测试用） */
  outstanding(): number { this.sweep(); return this.byHash.size; }

  private sweep(): void {
    const now = this.now();
    for (const [k, t] of this.byHash) if (now >= t.expiresAt) this.byHash.delete(k);
  }
}
