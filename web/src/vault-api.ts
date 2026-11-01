/** 凭据库（dsh-vault 融合）前端 API：每个请求（读也算）都带口令；423 = 已锁定，页面据此回到解锁界面。 */
import { getAdminToken } from './admin-token';

export const VAULT_KINDS = ['login', 'ssh', 'api-key', 'secret', 'oauth', 'cookie', 'card', 'custom'] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export interface VaultStatus {
  upstream: string; path: string; shared_with_dsh: boolean; exists: boolean; unlocked: boolean; env_password: boolean; idle_lock_minutes: number; count: number | null;
  /** 已解锁库的主密码低于新建库标准（只提示，不强制）；未解锁为 null */
  weak_master: boolean | null; weak_reasons: string[]; master_policy: { min_length: number; common_list: number };
}
export interface MasterCheck { ok: boolean; reasons: string[]; strength: Strength }
export interface VaultSummary {
  id: string; title: string; kind?: VaultKind; favorite?: boolean; username?: string; email?: string; phone?: string;
  host?: string; port?: string; url?: string; tags?: string[]; icon?: string; hasOtp?: boolean; updatedAt?: number; createdAt?: number;
  cardExpiry?: string; cardHolder?: string; attachmentCount?: number; cookieCount?: number; deletedAt?: number; fieldKeys?: string[];
}
export interface VaultEntry extends VaultSummary {
  password?: string; privateKey?: string; apiKey?: string; secret?: string; accessToken?: string; refreshToken?: string;
  expiresAt?: number; otpSecret?: string; cardNumber?: string; cardCvv?: string; notes?: string; sensitivity?: 'normal' | 'high';
  rotationDays?: number; fields?: Record<string, unknown>; attachments?: { name: string; size: number | null }[]; passwordHistoryCount: number;
}
export interface VaultStats { total: number; byKind: Record<string, number>; byTag: Record<string, number>; withTotp: number; trashCount: number; favoriteCount: number; expired: number }
export interface Strength { score: number; verdict: 'weak' | 'fair' | 'strong' | 'very strong'; feedback: string[]; bits: number }
export interface VaultHealth {
  weak: VaultSummary[]; reused: { count: number; entries: VaultSummary[] }[]; strength: { weak: number; fair: number; strong: number };
  no2fa: VaultSummary[]; httpSites: VaultSummary[]; score: number; verdict: 'good' | 'fair' | 'poor';
  rotation: (VaultSummary & { due: 'expired' | 'due' | 'soon'; daysLeft: number })[];
}
export interface VaultEvent { action: string; id?: string; title?: string; at: number }

export class VaultError extends Error {
  status: number;
  code?: string;
  /** vault_weak_master：新建库被拒的逐条原因 */
  reasons?: string[];
  constructor(status: number, message: string, code?: string, reasons?: string[]) { super(message); this.status = status; this.code = code; this.reasons = reasons; }
}

async function vreq<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAdminToken();
  if (token) headers['X-Admin-Token'] = token;
  const res = await fetch(url, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; code?: string; reasons?: string[] };
    throw new VaultError(res.status, b.error || `HTTP ${res.status}`, b.code, b.reasons);
  }
  return body as T;
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) });

export const vaultApi = {
  status: () => vreq<VaultStatus>('/api/vault/status'),
  unlock: (password: string) => vreq<{ unlocked: boolean; count: number; weak_master: boolean; weak_reasons: string[] }>('/api/vault/unlock', post({ password })),
  masterCheck: (password: string) => vreq<MasterCheck>('/api/vault/master-check', post({ password })),
  lock: () => vreq<{ unlocked: boolean }>('/api/vault/lock', post()),
  list: (params: Record<string, string> = {}) => vreq<{ entries: VaultSummary[]; stats: VaultStats }>(`/api/vault/entries?${new URLSearchParams(params)}`),
  get: (id: string) => vreq<VaultEntry>(`/api/vault/entries/${encodeURIComponent(id)}`),
  create: (data: Partial<VaultEntry>) => vreq<VaultEntry>('/api/vault/entries', post(data)),
  update: (id: string, data: Partial<VaultEntry>) => vreq<VaultEntry>(`/api/vault/entries/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string) => vreq<{ ok: boolean }>(`/api/vault/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  totp: (id: string) => vreq<{ code: string; period: number; remaining: number }>(`/api/vault/entries/${encodeURIComponent(id)}/totp`),
  trash: () => vreq<VaultSummary[]>('/api/vault/trash'),
  restore: (id: string) => vreq<{ ok: boolean }>(`/api/vault/trash/${encodeURIComponent(id)}/restore`, post()),
  purge: (id: string) => vreq<{ ok: boolean }>(`/api/vault/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generate: (opts: { length?: number; symbols?: boolean; passphrase?: boolean; words?: number }) => vreq<{ password: string; strength: Strength }>('/api/vault/generate', post(opts)),
  strength: (password: string) => vreq<Strength>('/api/vault/strength', post({ password })),
  health: () => vreq<VaultHealth>('/api/vault/health'),
  history: () => vreq<VaultEvent[]>('/api/vault/history'),
};
