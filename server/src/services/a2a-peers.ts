/**
 * 对端登记表（Cordis 服务 `a2aPeers`）：一个节点（DSH 实例，经 a2a 插件接入）一行，钉住它名片上的公钥，按对端看健康。
 *
 *   · 登记：取一次名片（不跟随重定向、5 秒超时、64 KiB 上限）、用上游 verifyCard 验签，钉住完整公钥和指纹。
 *   · 名片上的公钥变了（noteCardSeen / 管理员刷新）：不自动接受。状态改成 key_changed、新公钥记进 pending_*，等管理员确认；
 *     canDeliver 对它答「不能发」；停用的也一样。投递（事件投递、回给团队的消息）发之前问 peerCanDeliver，不能发的挂起不判死；
 *     入站（回执、跟进、名册）验过签之后问 pinnedVerdict：active 的只认钉住的那把公钥，key_changed、disabled 的一律不收。
 *     没登记、待登记（pending_registration，还没有钉住的键）的照旧（不挡），等登记了再按钉住的认。
 *   · 停用是粘住的：只有管理员显式 enable 才回到 active（或按情况回到 key_changed、pending_registration）；
 *     刷新、再登记、升级回填、绑定时就地登记等自动路径都不会把停用的行改回去。
 *   · 升级回填：从现有绑定和投递用到的根地址建对端行（registered_by = system:migration）。取得到名片的钉住公钥、active；
 *     取不到的记成 pending_registration（不挡投递，页面上标出来）。已有的行不动：重跑结果相同。
 *   · 健康：只读算出来，不新造探活——投递（成功、失败、在途）、回执、名片最近一次取到的时间。
 * 时间由代码生成后传进 SQL；id 由代码生成。SQL 只用两种库都认的写法。
 */
import { createHash, randomBytes } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { verifyMarketCard } from '../a2a.ts';
import { originOf } from '../a2a-direct-sig.ts';
import { noteBlocked, outboundOff } from '../outbound-gate.ts';

export type PeerStatus = 'active' | 'pending_registration' | 'key_changed' | 'disabled';
export type PeerRow = {
  id: string; root_url: string; zone: string; name: string; public_key: string; key_fingerprint: string;
  card_capabilities: string; card_version: string; status: PeerStatus; pending_public_key: string; pending_fingerprint: string;
  registered_by: string; registered_at: string; updated_at: string; disabled_by: string; disabled_at: string; disabled_reason: string;
  card_fetched_at: string; card_error: string;
};
/** 验过签的名片里登记要用的几项 */
export type SeenCard = { publicKey: string; team: string; name?: string; capabilities?: unknown };
export type PeerHealth = {
  last_sent_at: string; last_failure_at: string; last_failure_reason: string; last_receipt_at: string; in_flight: number; card_fetched_at: string;
};
export type CanDeliver = { ok: true } | { ok: false; reason: 'peer_key_changed' | 'peer_disabled' | 'peer_unknown' };

export const MIGRATION_ACTOR = 'system:migration';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

/** 公钥（名片上的 base64 SPKI DER）的指纹：sha256 十六进制 */
export function keyFingerprint(publicKey: string): string {
  return 'sha256:' + createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
}
/** 根地址规范成 origin（只认 http(s)，别的返回 ''） */
export function peerRootOf(url: string): string {
  return originOf(String(url ?? '').trim());
}
const now = () => new Date().toISOString();
const newId = () => 'peer_' + randomBytes(6).toString('hex');

export type CardFetcher = (root: string) => Promise<string>;
async function defaultFetchCard(root: string): Promise<string> {
  const r = await fetch(root + '/.well-known/agent-card.json', { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (r.status !== 200) { await r.body?.cancel(); throw new Error('名片 HTTP ' + r.status); }
  if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) { await r.body?.cancel(); throw new Error('名片超过 64 KiB'); }
  const reader = r.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BYTES) { await reader.cancel(); throw new Error('名片超过 64 KiB'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 发之前问（事件投递、回给团队的消息）：active、pending_registration 能发；key_changed、disabled 不能（调用方挂起、不判死、不计次数）；
 * 没登记的答 peer_unknown——调用方照旧发（登记表是后加的，存量的投递地址由升级回填登记，就地登记也在绑定时做）。不经服务容器，直接读表
 */
export function peerCanDeliver(url: string): CanDeliver {
  const root = peerRootOf(url);
  const p = root ? db.prepare('SELECT status FROM a2a_peers WHERE root_url = ?').get(root) as { status: PeerStatus } | undefined : undefined;
  if (!p) return { ok: false, reason: 'peer_unknown' };
  if (p.status === 'active' || p.status === 'pending_registration') return { ok: true };
  return { ok: false, reason: p.status === 'key_changed' ? 'peer_key_changed' : 'peer_disabled' };
}

/**
 * 入站验过签之后问：签名用的这把公钥认不认（回执、跟进、名册都经 verifyReceiptSigner 走到这里）。
 *   ok         对端 active，签名用的就是钉住的那把
 *   unpinned   没登记、待登记（还没有钉住的键）：照旧收
 *   blocked    key_changed（名片换了键，等管理员确认）、disabled：不收、不推进任何状态
 *   mismatch   对端 active，但签名用的不是钉住的那把（名片换了键还没经管理员确认，或者别的键）：不收
 */
export function pinnedVerdict(url: string, publicKey: string): 'ok' | 'unpinned' | 'blocked' | 'mismatch' {
  const root = peerRootOf(url);
  const p = root ? db.prepare('SELECT status, public_key FROM a2a_peers WHERE root_url = ?').get(root) as { status: PeerStatus; public_key: string } | undefined : undefined;
  if (!p || p.status === 'pending_registration') return 'unpinned';
  if (p.status !== 'active') return 'blocked';
  return p.public_key !== '' && p.public_key === publicKey ? 'ok' : 'mismatch';
}

/**
 * 对端名片上（登记表里钉住、验过签的那份）是否声明了某个能力位：capabilities[name] === true。
 * 没登记、不是 active、名片还没取到或没声明，都是 false——调用方按「对端不支持」处理。不经服务容器，直接读表（发送路径上用）。
 */
export function peerDeclares(url: string, name: string): boolean {
  const root = peerRootOf(url);
  if (!root) return false;
  const p = db.prepare('SELECT status, card_capabilities FROM a2a_peers WHERE root_url = ?').get(root) as { status: string; card_capabilities: string } | undefined;
  if (!p || p.status !== 'active') return false;
  try { const c = JSON.parse(p.card_capabilities || '{}') as Record<string, unknown>; return c?.[name] === true; } catch { return false; }
}

export class PeerRegisterError extends Error {
  readonly reason: 'bad_root' | 'card_unreachable' | 'card_invalid';
  constructor(reason: 'bad_root' | 'card_unreachable' | 'card_invalid', message: string) { super(message); this.reason = reason; }
}

export class A2aPeerService extends Service {
  private fetchCard: CardFetcher = defaultFetchCard;

  constructor(ctx: any) {
    super(ctx, 'a2aPeers');
    // 升级回填在后台跑（要取名片，有网络往返），不挡启动；随插件卸载停下
    ctx.effect(() => {
      let stopped = false;
      const timer = setImmediate(() => {
        if (stopped) return;
        // 对外断开（WM_OUTBOUND=off）：不取名片、不建行——否则副本里的对端会被都记成待登记，card_error 写成「对外已断开」
        if (outboundOff()) { noteBlocked('peer-migrate'); return; }
        this.migrate(() => stopped).catch((e) => console.error(`[a2a-peers] 升级回填没跑完（不影响服务，下次启动再跑）：${(e as Error)?.message ?? e}`));
      });
      return () => { stopped = true; clearImmediate(timer); };
    }, 'a2aPeers.migrate');
  }

  /** 测试用：换取名片的函数 */
  setCardFetcher(f: CardFetcher | null): void { this.fetchCard = f ?? defaultFetchCard; }

  list(filter: { registered_by?: string; status?: PeerStatus } = {}): PeerRow[] {
    const where: string[] = [], args: string[] = [];
    if (filter.registered_by) { where.push('registered_by = ?'); args.push(filter.registered_by); }
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    return db.prepare(`SELECT * FROM a2a_peers${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY root_url`).all(...args) as PeerRow[];
  }
  byId(id: string): PeerRow | undefined {
    return db.prepare('SELECT * FROM a2a_peers WHERE id = ?').get(id) as PeerRow | undefined;
  }
  byRoot(url: string): PeerRow | undefined {
    const root = peerRootOf(url);
    if (!root) return undefined;
    return db.prepare('SELECT * FROM a2a_peers WHERE root_url = ?').get(root) as PeerRow | undefined;
  }

  /** 投递前问：对这个根地址能不能发（见 peerCanDeliver） */
  /**
   * 对端名片上（登记表里钉住、验过签的那份）是否声明了某个能力位：capabilities[name] === true。
   * 没登记、名片还没取到、不是 active、或者没声明，都是 false——调用方按「对端不支持」处理（指名、打回派工行退回旧写法并留痕）。
   */
  declares(url: string, name: string): boolean { return peerDeclares(url, name); }

  canDeliver(url: string): CanDeliver { return peerCanDeliver(url); }

  /** 取一次名片、验签。失败抛 PeerRegisterError（不分细节地说清是取不到还是验不过） */
  async fetchVerifiedCard(root: string): Promise<SeenCard> {
    let text: string;
    try { text = await this.fetchCard(root); } catch (e) { throw new PeerRegisterError('card_unreachable', `取不到 ${root} 的名片：${(e as Error)?.message ?? e}`); }
    let v: { ok: boolean; card?: { publicKey?: unknown; team?: unknown; name?: unknown; capabilities?: unknown }; reason?: string };
    try { v = verifyMarketCard(JSON.parse(text), Date.now()) as never; } catch { throw new PeerRegisterError('card_invalid', `${root} 的名片不是合法的 JSON`); }
    const c = v.card;
    if (!v.ok || !c || typeof c.publicKey !== 'string' || c.publicKey === '' || typeof c.team !== 'string') throw new PeerRegisterError('card_invalid', `${root} 的名片验签不过（${v.reason ?? '缺公钥或团队'}）`);
    return { publicKey: c.publicKey, team: c.team, name: typeof c.name === 'string' ? c.name : '', capabilities: c.capabilities };
  }

  /**
   * 登记一个对端：取名片、验签、钉公钥。已经登记过的：active 原样返回（名片公钥变了的走 noteCardSeen，改成 key_changed）；
   * pending_registration 的补钉公钥、改成 active（登记人保留原来的）。停用的不在这里复活（用 enable）。
   */
  async register(url: string, by: string): Promise<{ peer: PeerRow; created: boolean }> {
    const root = peerRootOf(url);
    if (!root) throw new PeerRegisterError('bad_root', '根地址必须是 http(s)://主机[:端口]');
    const card = await this.fetchVerifiedCard(root);
    const existing = this.byRoot(root);
    if (existing) { this.noteCardSeen(root, card); return { peer: this.byRoot(root)!, created: false }; }
    const t = now(), id = newId();
    db.prepare(`INSERT INTO a2a_peers (id, root_url, zone, name, public_key, key_fingerprint, card_capabilities, card_version, status, registered_by, registered_at, updated_at, card_fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(id, root, card.team, card.name ?? '', card.publicKey, keyFingerprint(card.publicKey), capsText(card.capabilities), versionOf(card.capabilities), by, t, t, t);
    return { peer: this.byId(id)!, created: true };
  }

  /**
   * 名片被取到了（登记、刷新、投递前取卡都调它）：记下最近取到的时间。公钥和钉住的不一样——不自动接受：
   * 状态改成 key_changed、新公钥记进 pending_*；一样的话，之前挂着的 pending 清掉。pending_registration 的补钉公钥、改成 active。
   * 停用是粘住的：停用的行在这里只记下看到的公钥（没钉过的钉上，钉过而不同的记进 pending_*），状态一律保持 disabled；
   * 只有管理员显式 enable 才离开停用，enable 按钉没钉、有没有待确认回到对应的状态。
   */
  noteCardSeen(url: string, card: SeenCard): PeerRow | undefined {
    const p = this.byRoot(url);
    if (!p) return undefined;
    const t = now(), fp = keyFingerprint(card.publicKey);
    const disabled = p.status === 'disabled';
    if (p.status === 'pending_registration' || p.public_key === '') {
      // 没钉过公钥的：钉上。停用的保持停用（条件更新：并发的 disable 赢）
      db.prepare(`UPDATE a2a_peers SET zone = ?, name = ?, public_key = ?, key_fingerprint = ?, card_capabilities = ?, card_version = ?, status = ?,
        card_fetched_at = ?, card_error = '', updated_at = ? WHERE id = ? AND status = ?`)
        .run(card.team, card.name ?? '', card.publicKey, fp, capsText(card.capabilities), versionOf(card.capabilities), disabled ? 'disabled' : 'active', t, t, p.id, p.status);
    } else if (fp !== p.key_fingerprint) {
      // 停用的保持停用（只记下看到的新公钥）；别的改成 key_changed 等确认
      db.prepare(`UPDATE a2a_peers SET status = ?, pending_public_key = ?, pending_fingerprint = ?, card_fetched_at = ?, card_error = '', updated_at = ? WHERE id = ?`)
        .run(disabled ? 'disabled' : 'key_changed', card.publicKey, fp, t, t, p.id);
    } else {
      db.prepare(`UPDATE a2a_peers SET zone = ?, name = ?, card_capabilities = ?, card_version = ?, pending_public_key = '', pending_fingerprint = '',
        status = ?, card_fetched_at = ?, card_error = '', updated_at = ? WHERE id = ?`)
        .run(card.team, card.name ?? '', capsText(card.capabilities), versionOf(card.capabilities), p.status === 'key_changed' ? 'active' : p.status, t, t, p.id);
    }
    return this.byId(p.id);
  }

  /** 管理员刷新一次名片（排查、重试待登记的）：取到就走 noteCardSeen；取不到记下原因，状态不动 */
  async refresh(id: string): Promise<PeerRow | undefined> {
    const p = this.byId(id);
    if (!p) return undefined;
    try { const card = await this.fetchVerifiedCard(p.root_url); return this.noteCardSeen(p.root_url, card); } catch (e) {
      db.prepare('UPDATE a2a_peers SET card_error = ?, updated_at = ? WHERE id = ?').run(String((e as Error)?.message ?? e).slice(0, 300), now(), id);
      return this.byId(id);
    }
  }

  /** 管理员确认新公钥：要带上他看到的指纹，和 pending 的对得上才换 */
  confirmKey(id: string, fingerprint: string, by: string): { ok: true; peer: PeerRow } | { ok: false; reason: 'not_found' | 'not_pending' | 'fingerprint_mismatch' } {
    const p = this.byId(id);
    if (!p) return { ok: false, reason: 'not_found' };
    if (p.status !== 'key_changed' || p.pending_public_key === '') return { ok: false, reason: 'not_pending' };
    if (fingerprint !== p.pending_fingerprint) return { ok: false, reason: 'fingerprint_mismatch' };
    db.prepare(`UPDATE a2a_peers SET public_key = pending_public_key, key_fingerprint = pending_fingerprint, pending_public_key = '', pending_fingerprint = '',
      status = 'active', updated_at = ? WHERE id = ? AND status = 'key_changed'`).run(now(), id);
    console.log(JSON.stringify({ source: 'a2a-peers', event: 'confirm-key', id, root: p.root_url, from: p.key_fingerprint, to: fingerprint, by, at: now() }));
    return { ok: true, peer: this.byId(id)! };
  }

  disable(id: string, by: string, reason: string): PeerRow | undefined {
    const t = now();
    const changed = db.prepare(`UPDATE a2a_peers SET status = 'disabled', disabled_by = ?, disabled_at = ?, disabled_reason = ?, updated_at = ? WHERE id = ? AND status <> 'disabled'`).run(by, t, reason, t, id).changes;
    if (Number(changed) > 0) console.log(JSON.stringify({ source: 'a2a-peers', event: 'disable', id, by, reason, at: t }));
    return this.byId(id);
  }
  /** 重新启用：回到停用前该有的状态——钉着公钥、而看到过不同的新公钥的，回到 key_changed；没钉公钥的回到 pending_registration */
  enable(id: string, by: string): PeerRow | undefined {
    const p = this.byId(id);
    if (!p || p.status !== 'disabled') return p;
    const back: PeerStatus = p.public_key === '' ? 'pending_registration' : p.pending_public_key !== '' ? 'key_changed' : 'active';
    db.prepare(`UPDATE a2a_peers SET status = ?, disabled_by = '', disabled_at = '', disabled_reason = '', updated_at = ? WHERE id = ?`).run(back, now(), id);
    console.log(JSON.stringify({ source: 'a2a-peers', event: 'enable', id, by, to: back, at: now() }));
    return this.byId(id);
  }

  /** 按对端的健康：只读，从投递、事件日志、回执、名片取到的时间算出来。表还没建的当没有 */
  health(p: PeerRow): PeerHealth {
    const like = p.root_url.replace(/[\\%_]/g, (c) => '\\' + c) + '/%';
    const match = "(d.target_url = ? OR d.target_url LIKE ? ESCAPE '\\')";
    const one = <T>(sql: string, ...a: unknown[]): T | undefined => { try { return db.prepare(sql).get(...(a as never[])) as T; } catch { return undefined; } };
    const sent = one<{ t: string | null }>(`SELECT MAX(d.sent_at) AS t FROM workbench_event_deliveries d WHERE ${match} AND d.sent_at <> ''`, p.root_url, like);
    const failed = one<{ at: string; action: string; reason: string }>(`SELECT l.at AS at, l.action AS action, d.last_error AS reason FROM workbench_event_log l
      JOIN workbench_event_deliveries d ON d.id = l.delivery_id WHERE ${match} AND l.action IN ('retry', 'dead') ORDER BY l.id DESC LIMIT 1`, p.root_url, like);
    const inflight = one<{ n: number }>(`SELECT COUNT(*) AS n FROM workbench_event_deliveries d WHERE ${match} AND d.status IN ('held', 'pending')`, p.root_url, like);
    const receipt = one<{ t: string | null }>('SELECT MAX(r.received_at) AS t FROM a2a_inbound_receipts r JOIN a2a_sent_tasks s ON s.task_id = r.task_id WHERE s.peer_root = ?', p.root_url);
    return {
      last_sent_at: sent?.t ?? '', last_failure_at: failed?.at ?? '', last_failure_reason: failed ? `${failed.action}：${failed.reason || '（没记原因）'}` : '',
      last_receipt_at: receipt?.t ?? '', in_flight: Number(inflight?.n ?? 0), card_fetched_at: p.card_fetched_at,
    };
  }

  /** 升级回填用到的根地址：现有（没撤销的）绑定的 notify_url，和投递用过的 target_url */
  migrationRoots(): string[] {
    const urls: string[] = [];
    try { for (const r of db.prepare("SELECT notify_url AS u FROM bindings WHERE revoked_at = '' AND notify_url <> ''").all() as { u: string }[]) urls.push(r.u); } catch { /* 没有绑定表 */ }
    try { for (const r of db.prepare('SELECT DISTINCT target_url AS u FROM workbench_event_deliveries').all() as { u: string }[]) urls.push(r.u); } catch { /* 投递表还没建 */ }
    return [...new Set(urls.map(peerRootOf).filter(Boolean))].sort();
  }

  /** 升级回填：还没登记的根地址建对端行。取得到名片的钉公钥、active；取不到的 pending_registration。已有的不动 */
  async migrate(stopped: () => boolean = () => false): Promise<{ created: number; pending: number }> {
    let created = 0, pending = 0;
    for (const root of this.migrationRoots()) {
      if (stopped()) break;
      if (this.byRoot(root)) continue;
      let card: SeenCard | null = null, error = '';
      try { card = await this.fetchVerifiedCard(root); } catch (e) { error = String((e as Error)?.message ?? e).slice(0, 300); }
      if (stopped() || this.byRoot(root)) continue; // 取卡期间别处登记了
      const t = now();
      if (card) {
        db.prepare(`INSERT INTO a2a_peers (id, root_url, zone, name, public_key, key_fingerprint, card_capabilities, card_version, status, registered_by, registered_at, updated_at, card_fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(newId(), root, card.team, card.name ?? '', card.publicKey, keyFingerprint(card.publicKey), capsText(card.capabilities), versionOf(card.capabilities), MIGRATION_ACTOR, t, t, t);
        created++;
      } else {
        db.prepare(`INSERT INTO a2a_peers (id, root_url, status, registered_by, registered_at, updated_at, card_error) VALUES (?, ?, 'pending_registration', ?, ?, ?, ?)`)
          .run(newId(), root, MIGRATION_ACTOR, t, t, error);
        pending++;
      }
    }
    if (created || pending) console.log(`[a2a-peers] 升级回填：登记 ${created} 个对端，${pending} 个取不到名片、记成待登记`);
    return { created, pending };
  }
}

function capsText(c: unknown): string {
  try { const s = JSON.stringify(c ?? {}); return s.length > 8000 ? s.slice(0, 8000) : s; } catch { return '{}'; }
}
function versionOf(c: unknown): string {
  const v = (c && typeof c === 'object' ? (c as Record<string, unknown>).version : undefined);
  return typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 64) : '';
}
