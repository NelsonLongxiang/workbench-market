import { createHash, randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import {
  acceptScopedUserDelegate, checkUserScopeEcho, createUserClient,
  type OwnerAction, type PageOptions, type UserFailure, type UserResult,
} from 'market-a2a-user-sdk/sdk/user';
import { noteBlocked, outboundOff } from '../outbound-gate.ts';
import { putVaultCredential, vaultCredential, vaultAvailable } from '../vault-api.ts';
import { keyFingerprint, type A2aPeerService, type PeerRow } from './a2a-peers.ts';
import type { NodeBinding, SeatKey, TeamService } from './team.ts';

// Only the actions required by the seat conversation entry point.
const SEAT_SESSION_SCOPE: readonly OwnerAction[] = Object.freeze([
  'session.list', 'session.read', 'session.prompt', 'session.stop',
]);
const PAIR_PATH = '/__dsh_a2a/owner-delegates/pair';
const SESSION_ID = /^session-[0-9a-f][0-9a-f-]{7,63}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAIR_TTL_MS = 10 * 60_000;

type SeatOperation = { kind: 'read'; page: PageOptions }
  | { kind: 'steer' | 'queue'; text: string; requestId: string }
  | { kind: 'stop'; requestId: string };
type Pairing = { node: PeerRow; by: string; id: string; secret: string; expires: number; polling: boolean };
type PinnedPeer = Pick<PeerRow, 'id' | 'root_url' | 'key_fingerprint' | 'public_key' | 'status'>;
type JsonObject = Record<string, unknown>;
const fail = (status: number, code: string, error: string): UserFailure => ({ ok: false, status, code, error });
const object = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);
const nodeChanged = () => fail(409, 'seat_session_node_changed', '节点或席位绑定已变化，请重新打开会话');
const vaultLocked = () => fail(503, 'seat_session_vault_unavailable', '无法读取节点委托凭据，请检查市场凭据库和配对状态');
const missing = () => fail(404, 'seat_session_not_found', '当前看不到这个席位的会话');
const scopeMissing = () => fail(409, 'seat_session_node_version', '节点未返回完整动作范围，节点版本过低或配对应答不一致');

function validPin(peer: PinnedPeer | undefined): peer is PinnedPeer {
  return !!peer && peer.status === 'active' && peer.public_key !== '' && peer.key_fingerprint === keyFingerprint(peer.public_key);
}

function sameSeat(a: SeatKey, b: SeatKey): boolean {
  return a.host === b.host && a.team === b.team && a.seat === b.seat && a.seat_id === b.seat_id;
}

function credentialTitle(node: PinnedPeer): string {
  return 'Market seat sessions ' + node.id + ' ' + node.key_fingerprint;
}

function uniqueSeatSessionId(response: unknown, handle: string): string | null {
  if (!object(response) || response.ok !== true || response.truncated !== false || response.count !== 1 ||
      !Array.isArray(response.sessions) || response.sessions.length !== 1) return null;
  const row: unknown = response.sessions[0];
  if (!object(row) || row.team !== handle || row.joined !== true || row.archived !== false ||
      typeof row.id !== 'string' || !SESSION_ID.test(row.id) || row.id.slice(8, 16).toLowerCase() !== handle.split('/')[1]) return null;
  return row.id;
}

// Bound the node response before giving it to sdk/user's JSON reader.
const boundedFetch: typeof fetch = async (input, init) => {
  const reply = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(8_000) });
  const reader = reply.body?.getReader();
  if (!reader) return reply;
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('node response too large'); }
    parts.push(value);
  }
  return new Response(Buffer.concat(parts), { status: reply.status, headers: reply.headers });
};

function nodeFailure(result: UserFailure, token?: string): UserFailure {
  const validStatus = Number.isInteger(result.status) && result.status >= 400 && result.status < 600;
  const sanitize = (text: string) => (token ? text.replaceAll(token, '[redacted]') : text).slice(0, 512);
  return fail(validStatus ? result.status : 502, sanitize(result.code), sanitize(result.error));
}

export class SeatSessionService extends Service {
  private readonly pairings = new Map<string, Pairing>();

  constructor(ctx: any) {
    super(ctx, 'seatSessions');
  }

  private get peers(): A2aPeerService { return this.ctx.get('a2aPeers') as A2aPeerService; }
  private get teams(): TeamService { return this.ctx.get('teams') as TeamService; }

  private pin(node: NodeBinding): PinnedPeer | undefined {
    const peer = this.peers.byRoot(node.peer_root);
    return validPin(peer) && peer.root_url === node.peer_root && peer.key_fingerprint === node.key_fingerprint ? peer : undefined;
  }

  private current(peer: PinnedPeer): boolean {
    return this.pin({ peer_root: peer.root_url, key_fingerprint: peer.key_fingerprint })?.id === peer.id;
  }

  private async checkCard(peer: PinnedPeer): Promise<boolean> {
    try {
      const card = await this.peers.fetchVerifiedCard(peer.root_url);
      return keyFingerprint(card.publicKey) === peer.key_fingerprint && this.current(peer);
    } catch { return false; }
  }

  private async pairingRequest(peer: PinnedPeer, fields: JsonObject): Promise<UserResult<{ body: JsonObject }>> {
    try {
      const reply = await boundedFetch(peer.root_url + PAIR_PATH, {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields),
      });
      const body: unknown = await reply.json();
      if (!reply.ok || !object(body)) return fail(reply.status === 429 ? 429 : 502, 'seat_session_pairing_failed', '节点未能完成配对请求');
      return { ok: true, body };
    } catch { return fail(502, 'seat_session_pairing_failed', '节点未能完成配对请求'); }
  }

  private off(): UserFailure | undefined {
    if (!outboundOff()) return undefined;
    noteBlocked('seat-session');
    return fail(503, 'outbound_off', '对外已断开（WM_OUTBOUND=off）');
  }

  async startPairing(peerId: string, by: string) {
    const off = this.off();
    if (off) return off;
    const peer = this.peers.byId(peerId);
    if (!validPin(peer) || !await this.checkCard(peer)) return nodeChanged();
    for (const [handle, pairing] of this.pairings) if (pairing.expires <= Date.now() && !pairing.polling) this.pairings.delete(handle);
    if (this.pairings.size >= 128) return fail(429, 'seat_session_pairing_busy', '市场当前等待中的配对过多');
    const result = await this.pairingRequest(peer, { action: 'start', name: 'WorkBench Market seat sessions', scope: SEAT_SESSION_SCOPE });
    if (!result.ok) return result;
    const { body } = result;
    if (!checkUserScopeEcho(SEAT_SESSION_SCOPE, body.scope).ok) return scopeMissing();
    const expiry = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
    if (body.ok !== true || typeof body.id !== 'string' || !body.id || body.id.length > 200 ||
        typeof body.code !== 'string' || !body.code || body.code.length > 32 ||
        typeof body.secret !== 'string' || !body.secret || body.secret.length > 200 || !Number.isFinite(expiry) || expiry <= Date.now()) {
      return fail(502, 'seat_session_pairing_invalid', '节点返回了无效配对应答');
    }
    if (!this.current(peer)) return nodeChanged();
    if (this.pairings.size >= 128) return fail(429, 'seat_session_pairing_busy', '市场当前等待中的配对过多');
    const handle = randomUUID();
    const expires = Math.min(expiry, Date.now() + PAIR_TTL_MS);
    this.pairings.set(handle, { node: peer, by, id: body.id, secret: body.secret, expires, polling: false });
    return { ok: true as const, handle, code: body.code, expires_at: new Date(expires).toISOString() };
  }

  async pollPairing(handle: string, by: string) {
    const off = this.off();
    if (off) return off;
    const pending = this.pairings.get(handle);
    if (!pending || pending.by !== by || pending.expires <= Date.now()) return missing();
    if (pending.polling) return fail(409, 'seat_session_pairing_busy', '此配对已有领取请求');
    pending.polling = true;
    try {
      if (!await this.checkCard(pending.node)) return nodeChanged();
      if (!await vaultAvailable()) return vaultLocked();
      if (pending.expires <= Date.now() || !this.current(pending.node)) return nodeChanged();
      const result = await this.pairingRequest(pending.node, { action: 'poll', id: pending.id, secret: pending.secret });
      if (!result.ok) return result;
      const state = result.body.state;
      if (state === 'waiting') return { ok: true as const, state };
      this.pairings.delete(handle);
      if (state === 'denied' || state === 'expired' || state === 'not-found') return { ok: true as const, state };
      const verified = acceptScopedUserDelegate(SEAT_SESSION_SCOPE, result.body);
      if (!verified.ok) return scopeMissing();
      if (!this.current(pending.node)) return nodeChanged();
      await putVaultCredential(credentialTitle(pending.node), pending.node.key_fingerprint, verified.delegate.token, {
        scope: JSON.stringify(SEAT_SESSION_SCOPE),
      });
      return { ok: true as const, state: 'approved' as const };
    } catch { return vaultLocked(); }
    finally { pending.polling = false; }
  }

  async execute(principal: string, seat: SeatKey, op: SeatOperation): Promise<UserResult<JsonObject>> {
    const target = this.teams.resolveSeatSessionTarget(principal, seat);
    if (!target.ok) return fail(target.http, target.code, target.message);
    const audit = <T extends UserResult<JsonObject>>(result: T): T => {
      console.log(JSON.stringify({ source: 'seat-sessions', by: principal, host: target.seat.host, team: target.seat.team,
        seat: target.seat.seat, seat_id: target.seat.seat_id, action: op.kind, status: result.ok ? 200 : result.status, at: new Date().toISOString() }));
      return result;
    };
    const off = this.off();
    if (off) return audit(off);
    const node = this.pin(target.node);
    if (!node || !await this.checkCard(node)) return audit(nodeChanged());
    const stored = await vaultCredential(credentialTitle(node));
    if (!stored || stored.id !== node.key_fingerprint || stored.fields.scope !== JSON.stringify(SEAT_SESSION_SCOPE)) return audit(vaultLocked());
    const issued = acceptScopedUserDelegate(SEAT_SESSION_SCOPE, { state: 'approved', scope: SEAT_SESSION_SCOPE, token: stored.secret });
    if (!issued.ok) return audit(vaultLocked());

    // The authorization and exact roster handle may change while awaiting node or vault I/O.
    const recheck = () => {
      const current = this.teams.resolveSeatSessionTarget(principal, seat, target.node);
      return current.ok && sameSeat(current.seat, target.seat) && this.current(node) ? current : undefined;
    };
    const clientFor = (actor: typeof target.actor) => createUserClient({
      baseUrl: node.root_url, delegate: issued.delegate,
      onBehalfOf: {
        id: actor.principal.length <= 64 ? actor.principal : 'wm:' + createHash('sha256').update(actor.principal).digest('base64url'),
        name: [...actor.display_name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\[\]]/gu, '').trim()].slice(0, 32).join('') || '市场用户',
      },
      fetch: boundedFetch,
    });
    const beforeList = recheck();
    if (!beforeList) return audit(nodeChanged());
    const listed = await clientFor(beforeList.actor).sessions({ team: beforeList.seat.seat });
    if (!listed.ok) return audit(nodeFailure(listed, stored.secret));
    const id = uniqueSeatSessionId(listed, target.seat.seat);
    if (!id) return audit(missing());
    const beforeAction = recheck();
    if (!beforeAction) return audit(nodeChanged());
    const client = clientFor(beforeAction.actor);
    if (op.kind === 'read') {
      const result = await client.read(id, op.page);
      if (!result.ok) return audit(nodeFailure(result, stored.secret));
      if (!recheck()) return audit(nodeChanged());
      const { from, to, total, stale } = result;
      if (![from, to, total].every(Number.isSafeInteger) || from < 0 || to < from || total < to || typeof stale !== 'boolean' ||
          !Array.isArray(result.entries) || result.entries.length > 100 || result.entries.length !== to - from) {
        return audit(fail(502, 'seat_session_node_response', '节点返回了无效会话页'));
      }
      const entries = result.entries.filter((row, offset) => object(row) && row.i === from + offset &&
        (row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string')
        .map(row => ({ i: row.i, role: row.role, text: row.text, ...(Number.isFinite(row.time) ? { time: row.time } : {}) }));
      if (entries.length !== result.entries.length) return audit(fail(502, 'seat_session_node_response', '节点返回了无效会话条目'));
      return audit({ ok: true, entries, total, from, to, stale });
    }
    if (op.kind === 'stop') {
      const result = await client.stop(id, { requestId: op.requestId });
      if (!result.ok) return audit(nodeFailure(result, stored.secret));
      if (typeof result.stopped !== 'boolean') return audit(fail(502, 'seat_session_node_response', '节点返回了无效停止结果'));
      return audit({ ok: true, stopped: result.stopped, replayed: result.replayed === true });
    }
    const result = await client.prompt(id, { mode: op.kind, text: op.text, requestId: op.requestId });
    if (!result.ok) return audit(nodeFailure(result, stored.secret));
    const delivered = op.kind === 'steer' ? 'steered' : 'queued';
    if (result.delivered !== delivered) return audit(fail(502, 'seat_session_node_response', '节点返回了无效操作结果'));
    return audit({ ok: true, delivered, replayed: result.replayed === true });
  }
}
