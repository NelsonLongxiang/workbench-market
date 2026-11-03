/**
 * /a2a/direct 入站签名校验（WM_A2A_DIRECT_SIG=require|accept|off，缺省 accept；WM_LOGIN_GATE=enforce 时强制 require）。
 *
 * 认的信封与上游 dsh-open-a2a-net src/origin-claim.ts 的绑定形式（v2）逐字节一致：
 *   X-A2A-Caller（裸 zone）/ -Url / -Ts / -Aud / -Sig2，Sig2 签
 *   JSON.stringify(['a2a-origin-claim/2', caller, callerUrl, ts, audience, METHOD, path])。
 * 不绑定形式（v1，只签 [caller, callerUrl, ts]）不绑路由，这里一律不认。
 * 上游信封不签 body，所以另认一个市场扩展：X-WM-Body-Sha256（原始 body 的 sha256，base64url）+ X-WM-Body-Sig 签
 *   JSON.stringify(['wm-a2a-direct-body/1', caller, callerUrl, ts, audience, METHOD, path, bodySha256])。
 * 带了 body 签名就只验它（篡改 body 必拒）；WM_A2A_DIRECT_SIG_BODY=require 时只认它（缺省 accept：现有 DSH 节点只发 Sig2）。
 *
 * 公钥来源：只取市场侧人工登记的绑定地址（bindings.notify_url，agent_node = caller_session），
 * 绝不用请求里的 X-A2A-Caller-Url 或任何自带公钥。取卡不跟随重定向、5 秒超时、64 KiB 上限；卡片按官方 verifyCard 验签。
 * 身份：卡片 team === X-A2A-Caller === caller_session 的 zone 段。
 * 防重放：时间戳 ±5 分钟；验过的签名摘要落库到有效期结束，同一签名第二次一律拒。
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { verifyCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { db } from './db.ts';

export type DirectSigMode = 'require' | 'accept' | 'off';
export type DirectSigBodyMode = 'require' | 'accept';

/** 取开关；值不合法返回 null（调用方拒绝启动） */
export function directSigMode(env: NodeJS.ProcessEnv = process.env): DirectSigMode | null {
  const raw = String(env.WM_A2A_DIRECT_SIG ?? '');
  if (raw === '') return 'accept';
  return raw === 'require' || raw === 'accept' || raw === 'off' ? raw : null;
}
export function directSigBodyMode(env: NodeJS.ProcessEnv = process.env): DirectSigBodyMode | null {
  const raw = String(env.WM_A2A_DIRECT_SIG_BODY ?? '');
  if (raw === '') return 'accept';
  return raw === 'require' || raw === 'accept' ? raw : null;
}

export const SIG_SKEW_MS = 5 * 60_000;
export const ORIGIN_CLAIM_BOUND_TAG = 'a2a-origin-claim/2';
export const BODY_SIG_TAG = 'wm-a2a-direct-body/1';
const CARD_TTL_MS = 10 * 60_000;
/** 签名验不过时最多这么久重取一次卡（密钥轮换），防止拿坏签名放大成对端取卡流量 */
const CARD_REFRESH_MS = 30_000;
const CARD_TIMEOUT_MS = 5000;
const CARD_MAX_BYTES = 64 * 1024;
const MAX_SOURCES = 3;

export type SigRefusal = 'absent' | 'unbound-only' | 'body-sig-required' | 'bad-shape' | 'bad-ts' | 'wrong-audience'
  | 'identity-mismatch' | 'unregistered' | 'no-card' | 'not-derivable' | 'bad-body-digest' | 'bad-sig' | 'replay';
export type SigVerdict = { ok: true; caller: string; form: 'route' | 'body' } | { ok: false; reason: SigRefusal };

const CALLER_SHAPE = /^[a-z0-9-]+$/i;

export function boundCanonical(caller: string, callerUrl: string, ts: number, audience: string, method: string, path: string): string {
  return JSON.stringify([ORIGIN_CLAIM_BOUND_TAG, caller, callerUrl, ts, audience, method.toUpperCase(), path]);
}
export function bodyCanonical(caller: string, callerUrl: string, ts: number, audience: string, method: string, path: string, bodySha256: string): string {
  return JSON.stringify([BODY_SIG_TAG, caller, callerUrl, ts, audience, method.toUpperCase(), path, bodySha256]);
}
export function bodyDigest(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('base64url');
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}

/** 本机应答的受众：配置的对外地址 + 请求实际到达的本端地址（同上游 requestAudiences，发送方选不了 socket 本端） */
function audiencesOf(req: IncomingMessage, configured: string[]): Set<string> {
  const out = new Set<string>();
  for (const url of configured) { const o = originOf(url); if (o) out.add(o); }
  const socket = req.socket as (TLSSocket & { encrypted?: boolean }) | undefined;
  const local = socket?.localAddress;
  const port = socket?.localPort;
  if (local !== undefined && port !== undefined) {
    const scheme = socket?.encrypted === true ? 'https' : 'http';
    const plain = local.startsWith('::ffff:') ? local.slice(7) : local;
    const host = plain.includes(':') ? `[${plain}]` : plain;
    const loopback = host === '[::1]' || /^127\./.test(host);
    for (const name of loopback ? [host, '127.0.0.1', 'localhost', '[::1]'] : [host]) {
      const o = originOf(`${scheme}://${name}:${port}`);
      if (o) out.add(o);
    }
  }
  return out;
}

type Card = { team: string; publicKey: string; expiresAt: number };
type CacheEntry = { card: Card | null; at: number };

export function createDirectSigVerifier(deps: {
  /** 市场对外地址（MARKET_PUBLIC_URL） */
  audiences: () => string[];
  /** 取卡（测试可替换）；缺省走全局 fetch，不跟随重定向 */
  fetchText?: (url: string) => Promise<string>;
  now?: () => number;
  bodyMode?: DirectSigBodyMode;
}) {
  const now = deps.now ?? Date.now;
  const cards = new Map<string, CacheEntry>();

  async function defaultFetch(url: string): Promise<string> {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(CARD_TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (r.status !== 200) { await r.body?.cancel(); throw new Error('card fetch HTTP ' + r.status); }
    if (Number(r.headers.get('content-length') ?? 0) > CARD_MAX_BYTES) { await r.body?.cancel(); throw new Error('card too large'); }
    const reader = r.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > CARD_MAX_BYTES) { await reader.cancel(); throw new Error('card too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const fetchText = deps.fetchText ?? defaultFetch;

  /** 登记的取卡地址：该 caller_session 的有效准入绑定上人填的根地址（去重，最多 3 个） */
  function registeredSources(callerSession: string): string[] {
    const rows = db.prepare("SELECT DISTINCT notify_url FROM bindings WHERE agent_node = ? AND target_type = 'sop' AND direction IN ('admits','both') AND revoked_at = '' AND notify_url != '' ORDER BY id").all(callerSession) as { notify_url: string }[];
    return rows.map((r) => r.notify_url).filter((u) => originOf(u) !== '').slice(0, MAX_SOURCES);
  }

  async function loadCard(source: string, fresh: boolean): Promise<Card | null> {
    const hit = cards.get(source);
    const t = now();
    const usable = hit && hit.card && t - hit.at < CARD_TTL_MS && hit.card.expiresAt > t;
    if (usable && !fresh) return hit.card;
    if (hit && t - hit.at < CARD_REFRESH_MS) return usable ? hit.card : null; // 刚取过：不再打对端
    let card: Card | null = null;
    try {
      const url = source.replace(/\/+$/, '') + '/.well-known/agent-card.json';
      const v = verifyCard(JSON.parse(await fetchText(url)), t) as { ok: boolean; card?: Card };
      if (v.ok && v.card && typeof v.card.publicKey === 'string') card = { team: v.card.team, publicKey: v.card.publicKey, expiresAt: v.card.expiresAt };
    } catch { card = null; }
    cards.set(source, { card, at: t });
    if (cards.size > 500) cards.delete(cards.keys().next().value as string);
    return card;
  }

  function verifies(card: Card, canonical: string, sig: string): boolean {
    try {
      const key = createPublicKey({ key: Buffer.from(card.publicKey, 'base64'), format: 'der', type: 'spki' });
      return edVerify(undefined, Buffer.from(canonical, 'utf8'), key, Buffer.from(sig, 'base64'));
    } catch { return false; }
  }

  /** 验过的签名只认一次（落库，原子插入） */
  function claimOnce(sig: string, ts: number): boolean {
    const t = now();
    db.prepare('DELETE FROM a2a_sig_seen WHERE expires_at < ?').run(t);
    const r = db.prepare('INSERT OR IGNORE INTO a2a_sig_seen (sig_hash, expires_at) VALUES (?, ?)')
      .run(createHash('sha256').update(sig, 'utf8').digest('hex'), ts + SIG_SKEW_MS + 60_000) as unknown as { changes: number };
    return r.changes === 1;
  }

  /** 有签名头吗（Sig2 或 body 签名；只带 v1 Sig 返回 'unbound'） */
  function presence(req: IncomingMessage): 'signed' | 'unbound' | 'none' {
    const h = req.headers;
    if (h['x-a2a-caller-sig2'] !== undefined || h['x-wm-body-sig'] !== undefined) return 'signed';
    if (h['x-a2a-caller-sig'] !== undefined) return 'unbound';
    return 'none';
  }

  async function verify(req: IncomingMessage & { originalUrl?: string }, raw: Buffer, callerSession: string): Promise<SigVerdict> {
    const header = (n: string): string => { const v = req.headers[n]; return Array.isArray(v) ? '' : String(v ?? ''); };
    const caller = header('x-a2a-caller');
    const callerUrl = header('x-a2a-caller-url');
    const ts = Number(header('x-a2a-caller-ts'));
    const audience = header('x-a2a-caller-aud');
    const routeSig = header('x-a2a-caller-sig2');
    const bodySig = header('x-wm-body-sig');
    const claimedDigest = header('x-wm-body-sha256');
    if (routeSig === '' && bodySig === '') return { ok: false, reason: presence(req) === 'unbound' ? 'unbound-only' : 'absent' };
    if (bodySig === '' && deps.bodyMode === 'require') return { ok: false, reason: 'body-sig-required' };
    if (!CALLER_SHAPE.test(caller) || callerUrl === '' || !Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad-shape' };
    if (Math.abs(now() - ts) > SIG_SKEW_MS) return { ok: false, reason: 'bad-ts' };
    if (!audiencesOf(req, deps.audiences()).has(originOf(audience))) return { ok: false, reason: 'wrong-audience' };
    // 签名身份 = caller_session 的 zone 段（区限定句柄 <zone>/<id8> 或画布队 <zone>/canvas/<name>）
    if (callerSession.split('/')[0] !== caller || !callerSession.includes('/')) return { ok: false, reason: 'identity-mismatch' };
    let digest = '';
    if (bodySig !== '') {
      digest = bodyDigest(raw);
      if (claimedDigest !== digest) return { ok: false, reason: 'bad-body-digest' };
    }
    const method = String(req.method ?? '');
    let path = '';
    try { path = new URL(String(req.originalUrl ?? req.url ?? ''), 'http://x').pathname; } catch { path = ''; }
    const canonical = bodySig !== '' ? bodyCanonical(caller, callerUrl, ts, audience, method, path, digest) : boundCanonical(caller, callerUrl, ts, audience, method, path);
    const sig = bodySig !== '' ? bodySig : routeSig;
    const sources = registeredSources(callerSession);
    if (sources.length === 0) return { ok: false, reason: 'unregistered' };
    let sawCard = false;
    let sawTeam = false;
    for (const source of sources) {
      for (const fresh of [false, true]) {
        const card = await loadCard(source, fresh);
        if (!card) continue;
        sawCard = true;
        if (card.team !== caller) break; // 这个地址上的卡不是这个身份
        sawTeam = true;
        if (verifies(card, canonical, sig)) {
          if (!claimOnce(sig, ts)) return { ok: false, reason: 'replay' };
          return { ok: true, caller, form: bodySig !== '' ? 'body' : 'route' };
        }
      }
    }
    return { ok: false, reason: !sawCard ? 'no-card' : !sawTeam ? 'not-derivable' : 'bad-sig' };
  }

  return { verify, presence };
}
