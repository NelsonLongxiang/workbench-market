/**
 * 对端名片（阶段七 R3）：按根地址取 `/.well-known/agent-card.json`，用上游 verifyCard 验签（经 a2a.ts 的 verifyMarketCard，不另开一处 a2a-net 引用）。
 * 投递时记下对端是谁（名片 team）、回执到达时用同一地址上的名片验签名——两处读的是同一个身份。
 * 不跟随重定向、5 秒超时、64 KiB 上限；成功的结果缓存 10 分钟，失败的 30 秒内不重打对端。
 */
import { verifyMarketCard } from '../a2a.ts';
import { originOf } from '../a2a-direct-sig.ts';

export type PeerCard = { team: string; publicKey: string; expiresAt: number };

const TTL_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const cache = new Map<string, { card: PeerCard | null; at: number }>();

export type FetchText = (url: string) => Promise<string>;

async function defaultFetch(url: string): Promise<string> {
  const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (r.status !== 200) { await r.body?.cancel(); throw new Error('card fetch HTTP ' + r.status); }
  if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) { await r.body?.cancel(); throw new Error('card too large'); }
  const reader = r.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BYTES) { await reader.cancel(); throw new Error('card too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

let fetchText: FetchText = defaultFetch;
/** 测试用：换取卡函数、清缓存 */
export function setPeerCardFetch(f: FetchText | null): void { fetchText = f ?? defaultFetch; cache.clear(); }

/** 根地址规范成 origin（只认 http(s)，其余返回 ''） */
export function peerRoot(url: string): string { return originOf(url); }

/** fresh=true 时绕过成功缓存（验签失败后重取一次，应对密钥轮换），仍受 30 秒冷却约束 */
export async function peerCard(baseUrl: string, fresh = false, now = Date.now()): Promise<PeerCard | null> {
  const root = peerRoot(baseUrl);
  if (root === '') return null;
  const hit = cache.get(root);
  const usable = hit?.card && now - hit.at < TTL_MS && hit.card.expiresAt > now;
  if (usable && !fresh) return hit!.card;
  if (hit && now - hit.at < RETRY_MS) return usable ? hit.card : null;
  let card: PeerCard | null = null;
  try {
    const v = verifyMarketCard(JSON.parse(await fetchText(root + '/.well-known/agent-card.json')), now) as { ok: boolean; card?: PeerCard };
    if (v.ok && v.card && typeof v.card.team === 'string' && typeof v.card.publicKey === 'string') card = { team: v.card.team, publicKey: v.card.publicKey, expiresAt: v.card.expiresAt };
  } catch { card = null; }
  cache.set(root, { card, at: now });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return card;
}
