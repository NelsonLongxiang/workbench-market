/**
 * MCP 上传票：先申请、再直传。会话调 skill_file_put / app_files_upload 时只给文件名、大小、sha256（不带内容），
 * 拿到一个短时有效、只能用一次的上传地址；有 shell 的 agent 用 curl 把原始字节 PUT 上去（PUT /api/mcp-rest/uploads/<票>），
 * 字节不经过模型、不进 JSON-RPC。
 *
 * - 票本身就是凭据：随机 32 字节（base64url，43 个字符），这里只存它的 sha256，不存原文；
 * - 只能用一次：take() 一拿到就删，不管随后上传成没成（失败了重新申请）；
 * - 10 分钟过期；每个会话最多同时 20 张，全局最多 1000 张，满了就拒（不挤掉别人的）；
 * - 只在内存里：重启就全部作废（10 分钟的东西，不值得落库）。没有定时器，过期的在每次发票时顺手清掉。
 * 票只说「谁、往哪里、传多大、什么内容」；能不能传由路由在用票时再问一次（会话还在不在、授权还在不在）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors.ts';

export type UploadTicketKind = 'skill_file' | 'app_file';
export interface UploadTicket {
  kind: UploadTicketKind;
  /** 发票的会话名（null：网关关着时的匿名调用，用票时网关也得还关着） */
  session: string | null;
  /** app_file：传到哪个自产台 */
  slug?: string;
  name: string;
  size: number;
  sha256: string;
  mime?: string;
  createdBy?: string;
  note?: string;
  issuedAt: number;
  expiresAt: number;
}

export const UPLOAD_TICKET_TTL_MS = 10 * 60_000;
export const UPLOAD_TICKETS_PER_SESSION = 20;
export const UPLOAD_TICKETS_MAX = 1000;
/** 票的写法：base64url 的 32 字节。别的形状一律当不存在 */
export const UPLOAD_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export class UploadTickets {
  private readonly byHash = new Map<string, UploadTicket>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }

  /** 发一张票；返回票的原文（只这一次给出）和过期时刻 */
  issue(t: Omit<UploadTicket, 'issuedAt' | 'expiresAt'>): { token: string; expiresAt: number } {
    this.sweep();
    let mine = 0;
    for (const x of this.byHash.values()) if (x.session === t.session) mine++;
    if (mine >= UPLOAD_TICKETS_PER_SESSION) throw new HttpError(429, `这个会话手上已有 ${mine} 张没用的上传票（上限 ${UPLOAD_TICKETS_PER_SESSION}）：先用掉或等它们过期（10 分钟）`);
    if (this.byHash.size >= UPLOAD_TICKETS_MAX) throw new HttpError(503, '上传票发得太多，稍后再试');
    const token = randomBytes(32).toString('base64url');
    const issuedAt = this.now();
    const expiresAt = issuedAt + UPLOAD_TICKET_TTL_MS;
    this.byHash.set(hashOf(token), { ...t, issuedAt, expiresAt });
    return { token, expiresAt };
  }

  /** 用票：形状不对、没有、已过期都是 null；拿到即作废（只能用一次） */
  take(token: unknown): UploadTicket | null {
    if (typeof token !== 'string' || !UPLOAD_TICKET_RE.test(token)) return null;
    const key = hashOf(token);
    const t = this.byHash.get(key);
    if (!t) return null;
    this.byHash.delete(key);
    return this.now() < t.expiresAt ? t : null;
  }

  /** 还没用、没过期的张数（自检和测试用） */
  outstanding(): number { this.sweep(); return this.byHash.size; }

  private sweep(): void {
    const now = this.now();
    for (const [k, t] of this.byHash) if (now >= t.expiresAt) this.byHash.delete(k);
  }
}
