/**
 * 团队的决策卡（观察者落地 T8，第 18 篇第七节；方案在统筹笔记 t8-decision-cards-proposal.md，信封 v1）。
 *
 * 宿主（dsh-open-a2a-net 的 superagent）在总工、观察者提的卡建立、定了、丢弃时，经 /a2a/direct 推一个
 * `[A2A decision-card] v1` 信封过来（入站分流在 a2a/decision-card-inbound.ts：只认绑定正文的签名、钉住的公钥、
 * 团队在签名宿主的名册里）。这里只管：信封的形状、落库的规矩、给「关注」列出还在等的卡。
 *
 *   · 只收总工、观察者的卡（proposer_kind = router / observer）：成员在单上的提问属于那张单，市场派的单已经经提问回执进了「席位的提问」。
 *   · 文件只存名字、大小、摘要，不存内容（文件留在宿主的文件通道里）。
 *   · rev 只收更大的；state 只往前走，decided / dropped 是终态，终态之后再来 created 不复活（不管 rev 多大）。
 *   · rev 相同：内容也相同算重复（duplicate），内容不同算过时（stale），都不改库。
 * 第一期市场只展示、不拍板（拍板要宿主上浏览器里登录的属主，设计稿 C5）：条目给 decide_at，不给答复地址。
 * SQL 都在这里；时间由调用方传入。
 */
import { createHash } from 'node:crypto';
import { db } from '../db.ts';

export const DECISION_CARD_HEAD = '[A2A decision-card] v1';
/** 整条信封文本的上限：问题 2000 字、选项 6×300、理由、16 个文件名，再留余量 */
export const DECISION_CARD_TEXT_MAX = 32 * 1024;
const LEVELS = ['P0', 'P1', 'P2', 'P3'] as const;
const PROPOSERS = ['router', 'observer'] as const;
const EVENTS = { created: 'waiting', decided: 'decided', dropped: 'dropped' } as const;
const QUESTION_MAX = 2000, OPTION_MAX = 300, OPTIONS_MIN = 2, OPTIONS_MAX = 6, REASON_MAX = 2000, FILES_MAX = 16, NAME_MAX = 200;
const CARD_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** 一个团队同时在等的卡最多这么多（宿主那边每个提的人最多开 10 张；总工加几个观察者，50 足够）：再多的新卡不收，免得一台宿主把属主的清单刷满 */
export const WAITING_PER_TEAM_MAX = 50;
const TEAM_RE = /^([a-z0-9-]+)\/canvas\/([^/\s]{1,128})$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type CardState = (typeof EVENTS)[keyof typeof EVENTS];
export type DecisionCardDoc = {
  state: CardState; rev: number;
  card: {
    id: string; team: string; proposer_kind: (typeof PROPOSERS)[number]; level: (typeof LEVELS)[number];
    question: string; options: string[]; recommended: string; reason: string;
    files: { name: string; size: number; sha256: string }[];
    created_at: string; decided_at: string; decided_option: string | null;
  };
  decide_at: string;
};

// 控制符换成空格；方向控制符（会把页面上的文字倒过来显示、伪装成别的意思）直接去掉
const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
/** 团队写成画布地址（区/canvas/名字）；区和 canvas 段转小写，画布名原样（和名册入站同一种写法） */
export const teamKey = (t: string): string | null => { const m = TEAM_RE.exec(t); return m ? `${m[1].toLowerCase()}/canvas/${m[2]}` : null; };

/** 信封正文（首行之后那段 JSON）的形状。不合格返回原因（代号），不抛 */
export function parseDecisionCardDoc(raw: unknown): { ok: true; doc: DecisionCardDoc } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-object' };
  const o = raw as Record<string, unknown>;
  const state = typeof o.event === 'string' ? (EVENTS as Record<string, CardState>)[o.event] : undefined;
  if (!state) return { ok: false, reason: 'event' };
  if (typeof o.rev !== 'number' || !Number.isSafeInteger(o.rev) || o.rev < 1) return { ok: false, reason: 'rev' };
  const c = o.card;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, reason: 'card' };
  const k = c as Record<string, unknown>;
  if (typeof k.id !== 'string' || !CARD_ID_RE.test(k.id)) return { ok: false, reason: 'card.id' };
  const team = typeof k.team === 'string' ? teamKey(k.team) : null;
  if (!team) return { ok: false, reason: 'card.team' };
  if (!(PROPOSERS as readonly unknown[]).includes(k.proposer_kind)) return { ok: false, reason: 'card.proposer_kind' };
  if (!(LEVELS as readonly unknown[]).includes(k.level)) return { ok: false, reason: 'card.level' };
  const question = typeof k.question === 'string' ? clean(k.question) : '';
  if (question === '' || question.length > QUESTION_MAX) return { ok: false, reason: 'card.question' };
  if (!Array.isArray(k.options) || k.options.length < OPTIONS_MIN || k.options.length > OPTIONS_MAX) return { ok: false, reason: 'card.options' };
  const options = k.options.map((x) => (typeof x === 'string' ? clean(x) : ''));
  if (options.some((x) => x === '' || x.length > OPTION_MAX) || new Set(options).size !== options.length) return { ok: false, reason: 'card.options' };
  const recommended = typeof k.recommended === 'string' ? clean(k.recommended) : '';
  if (!options.includes(recommended)) return { ok: false, reason: 'card.recommended' };
  const reason = typeof k.reason === 'string' ? clean(k.reason) : '';
  if (reason.length > REASON_MAX) return { ok: false, reason: 'card.reason' };
  const filesRaw = k.files === undefined ? [] : k.files;
  if (!Array.isArray(filesRaw) || filesRaw.length > FILES_MAX) return { ok: false, reason: 'card.files' };
  const files: DecisionCardDoc['card']['files'] = [];
  for (const f of filesRaw) {
    const x = (f && typeof f === 'object' && !Array.isArray(f) ? f : {}) as Record<string, unknown>;
    const name = typeof x.name === 'string' ? clean(x.name) : '';
    if (name === '' || name.length > NAME_MAX || typeof x.size !== 'number' || !Number.isSafeInteger(x.size) || x.size < 0 || typeof x.sha256 !== 'string' || !SHA256_RE.test(x.sha256)) return { ok: false, reason: 'card.files' };
    files.push({ name, size: x.size, sha256: x.sha256 });
  }
  const created_at = iso(k.created_at);
  if (!created_at) return { ok: false, reason: 'card.created_at' };
  let decided_at = '', decided_option: string | null = null;
  if (state === 'decided') {
    const d = iso(k.decided_at);
    if (!d) return { ok: false, reason: 'card.decided_at' };
    decided_at = d;
    // 属主自己写的决定（不在选项里）给 null；给了就得是选项之一
    if (k.decided_option !== undefined && k.decided_option !== null) {
      const opt = typeof k.decided_option === 'string' ? clean(k.decided_option) : '';
      if (!options.includes(opt)) return { ok: false, reason: 'card.decided_option' };
      decided_option = opt;
    }
  }
  // 拍板页面只给宿主上的路径（市场拼宿主名片上的地址）：不收完整 URL，免得把属主引到别处
  const decide_at = typeof o.decide_at === 'string' ? o.decide_at : '';
  // 宿主的面都在 /__dsh_a2a 开头的路径下（/__dsh_a2a/…、/__dsh_a2a_nexus/…）
  if (decide_at !== '' && !/^\/__dsh_a2a[a-z_]*\/[A-Za-z0-9/_.?=&%-]{0,300}$/.test(decide_at)) return { ok: false, reason: 'decide_at' };
  return { ok: true, doc: { state, rev: o.rev, card: { id: k.id, team, proposer_kind: k.proposer_kind as DecisionCardDoc['card']['proposer_kind'], level: k.level as DecisionCardDoc['card']['level'], question, options, recommended, reason, files, created_at, decided_at, decided_option }, decide_at } };
}

/** 这个团队在不在签名宿主此刻有效的名册里（名册视图已经排除了停用、换钥匙、同号冲突的宿主） */
export function teamInSignerRoster(team: string, peerRoot: string, keyFingerprint: string): boolean {
  // 席位按（根地址、钥匙完整指纹）存（a2a_roster_node_seats）；再连名册视图，宿主停用、换钥匙、同号冲突时就不算
  return Boolean(db.prepare(`SELECT 1 FROM a2a_roster_node_seats s JOIN a2a_rosters_live r ON r.peer_root = s.peer_root AND r.key_fingerprint = s.key_fingerprint
    WHERE s.team = ? AND s.peer_root = ? AND s.key_fingerprint = ? AND s.peer_root <> '' AND s.key_fingerprint <> '' LIMIT 1`).get(team, peerRoot, keyFingerprint));
}

const TERMINAL: readonly CardState[] = ['decided', 'dropped'];
/** 落库：stored 改了库；duplicate 同一版重复；stale 过时或想复活终态，都不改库 */
export function applyDecisionCard(signer: { peerRoot: string; keyFingerprint: string }, doc: DecisionCardDoc, now: number): 'stored' | 'duplicate' | 'stale' | 'limited' {
  const c = doc.card;
  const sha = createHash('sha256').update(JSON.stringify({ state: doc.state, rev: doc.rev, card: c, decide_at: doc.decide_at })).digest('hex');
  const key = [signer.peerRoot, signer.keyFingerprint, c.team, c.id];
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db.prepare('SELECT rev, state, doc_sha256 FROM a2a_decision_cards WHERE peer_root = ? AND key_fingerprint = ? AND team = ? AND card_id = ?').get(...key) as { rev: number; state: CardState; doc_sha256: string } | undefined;
    let out: 'stored' | 'duplicate' | 'stale' | 'limited';
    if (cur && doc.rev === cur.rev) out = sha === cur.doc_sha256 ? 'duplicate' : 'stale';
    else if (cur && (doc.rev < cur.rev || (TERMINAL.includes(cur.state) && doc.state === 'waiting'))) out = 'stale';
    else if (!cur && doc.state === 'waiting' && Number((db.prepare("SELECT COUNT(*) AS n FROM a2a_decision_cards WHERE peer_root = ? AND key_fingerprint = ? AND team = ? AND state = 'waiting'").get(signer.peerRoot, signer.keyFingerprint, c.team) as { n: number }).n) >= WAITING_PER_TEAM_MAX) out = 'limited';
    else {
      db.prepare(`INSERT INTO a2a_decision_cards (peer_root, key_fingerprint, team, card_id, rev, state, doc_sha256, proposer_kind, level, question, options, recommended, reason, files, decide_at, created_at, decided_at, decided_option, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (peer_root, key_fingerprint, team, card_id) DO UPDATE SET rev = excluded.rev, state = excluded.state, doc_sha256 = excluded.doc_sha256,
          proposer_kind = excluded.proposer_kind, level = excluded.level, question = excluded.question, options = excluded.options, recommended = excluded.recommended,
          reason = excluded.reason, files = excluded.files, decide_at = excluded.decide_at, created_at = excluded.created_at, decided_at = excluded.decided_at,
          decided_option = excluded.decided_option, received_at = excluded.received_at`)
        .run(...key, doc.rev, doc.state, sha, c.proposer_kind, c.level, c.question, JSON.stringify(c.options), c.recommended, c.reason, JSON.stringify(c.files), doc.decide_at, c.created_at, c.decided_at, c.decided_option, now);
      out = 'stored';
    }
    db.exec('COMMIT');
    return out;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export type WaitingCard = {
  peer_root: string; key_fingerprint: string; team: string; card_id: string; proposer_kind: string; level: string;
  question: string; options: string[]; recommended: string; reason: string; files: { name: string; size: number }[];
  decide_at: string; created_at: string; host_name: string;
};
const parseJson = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
/** 还在等属主的卡（「关注」用），按等级再按建立时间。只列团队此刻还在签名宿主名册里的：宿主停用、换钥匙之后，它的卡不再显示 */
export function waitingDecisionCards(limit = 200): WaitingCard[] {
  // 按名册过滤放在 SQL 里（和 teamInSignerRoster 同一个口径）：宿主停用、换钥匙、同号冲突、团队不在它名册里的卡都不取
  const rows = db.prepare(`SELECT c.*, p.name AS host_name FROM a2a_decision_cards c LEFT JOIN a2a_peers p ON p.root_url = c.peer_root
    WHERE c.state = 'waiting' AND EXISTS (SELECT 1 FROM a2a_roster_node_seats s JOIN a2a_rosters_live r ON r.peer_root = s.peer_root AND r.key_fingerprint = s.key_fingerprint
      WHERE s.team = c.team AND s.peer_root = c.peer_root AND s.key_fingerprint = c.key_fingerprint)
    ORDER BY c.level, c.created_at LIMIT ?`).all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    peer_root: String(r.peer_root), key_fingerprint: String(r.key_fingerprint), team: String(r.team), card_id: String(r.card_id),
    proposer_kind: String(r.proposer_kind), level: String(r.level), question: String(r.question), options: parseJson<string[]>(String(r.options), []),
    recommended: String(r.recommended), reason: String(r.reason),
    files: parseJson<{ name: string; size: number }[]>(String(r.files), []).map((f) => ({ name: f.name, size: f.size })),
    decide_at: String(r.decide_at), created_at: String(r.created_at), host_name: r.host_name === null || r.host_name === undefined ? '' : String(r.host_name),
  }));
}
