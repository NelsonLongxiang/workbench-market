/**
 * 事项域（阶段八 8a）：事项表与只增不改的事项日志。规格见产品化文档 02「概念模型」第二、三、四节和附录 8a。
 *
 * 三条约束：
 *   · 事项是索引，不是第二份真相：只存 id 和摘要，原件各回各家。
 *   · 状态只由事实推进：唯一的改状态入口是 apply(事实)。查迁移表得到新状态，写一行日志；表里没有的一律拒绝。
 *     没有「直接设状态」的接口；库里也拦着——work_items.state 只能改成日志最近一行的 to_state（见 db.ts 的触发器）。
 *   · 身份只认已验证来源：8b 接来源时处理，8a 不接任何来源、不注册任何路由。
 *
 * 去重：每条事实带来源（source）和来源自己的 id，按（事项、来源、id）唯一。同一条送两次，第二次原样返回、不再写。
 * 终态（done / failed / dropped / cancelled）之后不再接受任何新事实。
 */
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export const STATES = ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked', 'done', 'failed', 'dropped', 'cancelled'] as const;
export type WorkItemState = typeof STATES[number];
export const TERMINAL: readonly WorkItemState[] = ['done', 'failed', 'dropped', 'cancelled'];
const NON_TERMINAL = STATES.filter((s) => !TERMINAL.includes(s));

export const SOURCE_KINDS = ['task-center', 'app-data', 'agent', 'cockpit'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

/**
 * 事实：kind 决定查迁移表的哪几行；source + id 是来源自己的标识（去重用）；其余字段按 kind 取用，原样记进日志的 detail。
 *   submit    提交。dispatch_open 表示派发开关是否全开
 *   release   管理员放行
 *   withdraw  撤回
 *   delivery  投递结果；outcome = 'dead'（重试耗尽或终止码）
 *   eval      席位的接单判断；verdict = accept / stop / ignore / unavailable，后三种必须带 reason
 *   report    席位上报；status = progress / waiting / blocked / ready / failed / dropped。dropped 必须同时带 receipt
 *   ask       席位发来提问
 *   receipt   终态回执；outcome
 *   verify    人在关注队列里验收
 *   return    人退回
 *   answer    人答了席位的提问；ask_id 是那条 ask 事实的 id
 */
export type Fact = {
  kind: 'submit' | 'release' | 'withdraw' | 'delivery' | 'eval' | 'report' | 'ask' | 'receipt' | 'verify' | 'return' | 'answer';
  source: string;
  id: string;
  actor?: string;
  dispatch_open?: boolean;
  outcome?: string;
  verdict?: 'accept' | 'stop' | 'ignore' | 'unavailable';
  reason?: string;
  status?: 'progress' | 'waiting' | 'blocked' | 'ready' | 'failed' | 'dropped';
  summary?: string;
  receipt?: { outcome: string };
  question?: string;
  ask_id?: string;
  answer?: string;
};

type Row = { from: readonly WorkItemState[]; fact: Fact['kind']; when: (f: Fact) => boolean; to: WorkItemState; note: string };
const is = <K extends keyof Fact>(k: K, v: Fact[K]) => (f: Fact) => f[k] === v;
const hasReason = (f: Fact) => typeof f.reason === 'string' && f.reason.trim() !== '';

/** 迁移表：第三节那张表逐行照抄。表里没有的（状态，事实）组合一律拒绝。 */
export const TRANSITIONS: readonly Row[] = [
  { from: ['draft'], fact: 'submit', when: is('dispatch_open', false), to: 'held', note: '提交，派发开关没全开' },
  { from: ['draft', 'held'], fact: 'submit', when: is('dispatch_open', true), to: 'delivered', note: '提交且开关全开' },
  { from: ['draft', 'held'], fact: 'release', when: () => true, to: 'delivered', note: '管理员 release' },
  { from: ['draft', 'held'], fact: 'withdraw', when: () => true, to: 'cancelled', note: '撤回' },
  { from: ['delivered'], fact: 'delivery', when: is('outcome', 'dead'), to: 'failed', note: '投递 dead（重试耗尽或终止码）' },
  { from: ['delivered'], fact: 'eval', when: is('verdict', 'accept'), to: 'accepted', note: '席位 report：eval=accept' },
  { from: ['delivered'], fact: 'eval', when: (f) => ['stop', 'ignore', 'unavailable'].includes(f.verdict ?? '') && hasReason(f), to: 'failed', note: '席位 report：eval=stop / ignore / unavailable（带理由）' },
  { from: ['accepted', 'waiting', 'blocked'], fact: 'report', when: is('status', 'progress'), to: 'progress', note: '席位 report：progress' },
  { from: ['accepted', 'progress'], fact: 'report', when: is('status', 'waiting'), to: 'waiting', note: '席位 report：waiting' },
  { from: ['accepted', 'progress', 'waiting'], fact: 'report', when: is('status', 'blocked'), to: 'blocked', note: '席位 report：blocked' },
  { from: ['accepted', 'progress', 'waiting'], fact: 'ask', when: () => true, to: 'blocked', note: '席位发来 ask' },
  { from: ['progress', 'waiting', 'blocked'], fact: 'report', when: is('status', 'ready'), to: 'ready', note: '席位 report：ready（做完，等验收）' },
  { from: ['ready'], fact: 'verify', when: () => true, to: 'done', note: '人在关注队列里验收' },
  { from: ['ready'], fact: 'return', when: () => true, to: 'progress', note: '人退回' },
  // 补定（规格附录 8a）：原地重复的上报算合法——状态不变，记一行日志，更新进展摘要
  { from: ['progress'], fact: 'report', when: is('status', 'progress'), to: 'progress', note: '原地：progress 时又报 progress' },
  { from: ['waiting'], fact: 'report', when: is('status', 'waiting'), to: 'waiting', note: '原地：waiting 时又报 waiting' },
  { from: ['blocked'], fact: 'ask', when: () => true, to: 'blocked', note: '原地：blocked 时又来一个提问' },
  { from: NON_TERMINAL, fact: 'report', when: is('status', 'failed'), to: 'failed', note: '席位 report：failed' },
  { from: NON_TERMINAL, fact: 'receipt', when: is('outcome', 'failed'), to: 'failed', note: '终态回执 outcome=failed' },
  { from: NON_TERMINAL, fact: 'report', when: (f) => f.status === 'dropped' && typeof f.receipt?.outcome === 'string' && f.receipt.outcome !== '', to: 'dropped', note: '席位 report：dropped（同时有回执）' },
];

/** 查表：这个状态下这条事实能到哪。查不到返回 null。 */
export function nextState(state: WorkItemState, fact: Fact): WorkItemState | null {
  const row = TRANSITIONS.find((r) => r.fact === fact.kind && r.from.includes(state) && r.when(fact));
  return row ? row.to : null;
}

/**
 * 只记录、不改状态的事实（规格附录 8a 补定）。终态之后只开回执这一个口子，别的事实一律拒绝。
 *   answer：只在非终态、且答的是一条还没答过的提问时接受（同一条提问再答一次，返回第一次的结果）
 *   回执（outcome 不是 failed）：在 ready 和任一终态都接受；终态之后到的在日志里标「晚到」。
 *     事项上的回执摘要只在原来为空时填，不被后到的覆盖
 */
export const RECORDS: readonly { from: readonly WorkItemState[]; fact: Fact['kind']; when: (f: Fact) => boolean; note: string }[] = [
  { from: NON_TERMINAL, fact: 'answer', when: (f) => typeof f.ask_id === 'string' && f.ask_id !== '', note: '人答了席位的提问' },
  { from: ['ready', ...TERMINAL], fact: 'receipt', when: (f) => typeof f.outcome === 'string' && f.outcome !== '' && f.outcome !== 'failed', note: '回执（outcome 不是 failed）' },
];

export type ApplyResult =
  | { ok: true; state: WorkItemState; from: WorkItemState; duplicate: boolean; recorded?: boolean; late?: boolean }
  | { ok: false; reason: 'bad_fact' | 'unknown_item' | 'terminal' | 'not_allowed'; state?: WorkItemState };

export type NewWorkItem = {
  title: string; created_by: string; source_kind: SourceKind; source_ref?: string;
  context?: Record<string, unknown>; event_id?: number | null; target_team?: string; seat?: string; object?: string; phase?: string;
};

export type WorkItemRow = {
  id: string; title: string; created_at: string; created_by: string; source_kind: SourceKind; source_ref: string; context: string;
  event_id: number | null; task_ids: string; target_team: string; seat: string; eval: string; eval_reason: string; state: WorkItemState;
  progress_summary: string; progress_at: string; open_asks: string; receipt_outcome: string; receipt_at: string;
  outputs: string; evidence: string; object: string; phase: string; updated_at: string;
};
export type WorkItemLogRow = {
  seq: number; item_id: string; fact: string; fact_source: string; fact_id: string; from_state: WorkItemState; to_state: WorkItemState;
  actor: string; detail: string; at: string;
};

const KINDS: readonly Fact['kind'][] = ['submit', 'release', 'withdraw', 'delivery', 'eval', 'report', 'ask', 'receipt', 'verify', 'return', 'answer'];
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const MAX_DETAIL = 16 * 1024;

function factProblem(fact: Fact): string {
  if (!fact || typeof fact !== 'object') return '事实不是对象';
  if (!KINDS.includes(fact.kind)) return '不认识的事实种类';
  if (!text(fact.source, 200) || !text(fact.id, 200)) return '事实要带来源和来源自己的 id';
  if (fact.actor !== undefined && typeof fact.actor !== 'string') return 'actor 要是字符串';
  if (JSON.stringify(fact).length > MAX_DETAIL) return '事实太大';
  return '';
}

export class WorkItemService extends Service {
  constructor(ctx: any) {
    super(ctx, 'workItems');
  }

  /** 新建一件事项：一律从 draft 开始，第一行日志是「建立」。 */
  create(input: NewWorkItem): WorkItemRow {
    if (!text(input?.title, 500)) throw new Error('事项要有标题');
    if (!/^[^:\s]+:\S/.test(String(input.created_by ?? ''))) throw new Error('created_by 要是主体标识（如 user:<名>）');
    if (!SOURCE_KINDS.includes(input.source_kind)) throw new Error('不认识的来源类别');
    const id = `wi_${randomUUID().replace(/-/g, '')}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO work_items (id, title, created_by, source_kind, source_ref, context, event_id, target_team, seat, object, phase)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.title, input.created_by, input.source_kind, input.source_ref ?? '', JSON.stringify(input.context ?? {}),
        input.event_id ?? null, input.target_team ?? '', input.seat ?? '', input.object ?? '', input.phase ?? '');
      db.prepare(`INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, actor, detail)
        VALUES (?, 'create', 'market', ?, 'draft', 'draft', ?, '{}')`).run(id, id, input.created_by);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return this.get(id)!;
  }

  get(id: string): WorkItemRow | undefined {
    return db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined;
  }

  log(id: string): WorkItemLogRow[] {
    return db.prepare('SELECT * FROM work_item_log WHERE item_id = ? ORDER BY seq').all(id) as WorkItemLogRow[];
  }

  /** 按对象、阶段筛（观测层给的不透明标识，只按相等比较）。 */
  list(filter: { state?: WorkItemState; object?: string; phase?: string } = {}): WorkItemRow[] {
    const where: string[] = [], args: string[] = [];
    for (const k of ['state', 'object', 'phase'] as const) if (typeof filter[k] === 'string') { where.push(`${k} = ?`); args.push(filter[k]!); }
    return db.prepare(`SELECT * FROM work_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`).all(...args) as WorkItemRow[];
  }

  /** 唯一的改状态入口。 */
  apply(itemId: string, fact: Fact): ApplyResult {
    if (factProblem(fact)) return { ok: false, reason: 'bad_fact' };
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = this.applyLocked(itemId, fact);
      db.exec(out.ok && !out.duplicate ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  private applyLocked(itemId: string, fact: Fact): ApplyResult {
    const item = db.prepare('SELECT state, open_asks FROM work_items WHERE id = ?').get(itemId) as { state: WorkItemState; open_asks: string } | undefined;
    if (!item) return { ok: false, reason: 'unknown_item' };
    const seen = db.prepare('SELECT from_state, to_state FROM work_item_log WHERE item_id = ? AND fact_source = ? AND fact_id = ?')
      .get(itemId, fact.source, fact.id) as { from_state: WorkItemState; to_state: WorkItemState } | undefined;
    if (seen) return { ok: true, state: item.state, from: seen.from_state, duplicate: true };

    // 只记录的事实：查第二张表。终态之后只有回执能走到这里。
    const record = RECORDS.find((r) => r.fact === fact.kind && r.from.includes(item.state) && r.when(fact));
    if (record) return this.recordLocked(itemId, item, fact);
    if (TERMINAL.includes(item.state)) return { ok: false, reason: 'terminal', state: item.state };
    const to = nextState(item.state, fact);
    if (!to) return { ok: false, reason: 'not_allowed', state: item.state };

    const { kind, source, id, actor, ...detail } = fact;
    this.writeLog(itemId, fact, item.state, to, detail);
    const set: string[] = ['state = ?', "updated_at = datetime('now')"], args: (string | number | null)[] = [to];
    if (kind === 'eval') { set.push('eval = ?', 'eval_reason = ?'); args.push(fact.verdict ?? '', fact.reason ?? ''); }
    if (kind === 'report' && typeof fact.summary === 'string') { set.push('progress_summary = ?', "progress_at = datetime('now')"); args.push(fact.summary); }
    if (kind === 'ask') { const asks = JSON.parse(item.open_asks || '[]'); asks.push({ id, source, question: fact.question ?? '' }); set.push('open_asks = ?'); args.push(JSON.stringify(asks)); }
    const receipt = kind === 'receipt' ? fact.outcome : fact.receipt?.outcome;
    if (typeof receipt === 'string' && receipt !== '') { set.push('receipt_outcome = ?', "receipt_at = datetime('now')"); args.push(receipt); }
    db.prepare(`UPDATE work_items SET ${set.join(', ')} WHERE id = ?`).run(...args, itemId);
    return { ok: true, state: to, from: item.state, duplicate: false };
  }

  private writeLog(itemId: string, fact: Fact, from: WorkItemState, to: WorkItemState, detail: object): void {
    db.prepare(`INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, actor, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, fact.kind, fact.source, fact.id, from, to, fact.actor ?? '', JSON.stringify(detail));
  }

  /** 只记录、不改状态：写一行 from = to 的日志，更新摘要字段。 */
  private recordLocked(itemId: string, item: { state: WorkItemState; open_asks: string }, fact: Fact): ApplyResult {
    const { kind, source, id, actor, ...detail } = fact;
    if (kind === 'answer') {
      const askId = String(fact.ask_id); // RECORDS 那一行已要求它是非空字符串
      const asked = db.prepare("SELECT 1 FROM work_item_log WHERE item_id = ? AND fact = 'ask' AND fact_id = ?").get(itemId, askId);
      if (!asked) return { ok: false, reason: 'not_allowed', state: item.state };
      const first = db.prepare("SELECT from_state FROM work_item_log WHERE item_id = ? AND fact = 'answer' AND json_extract(detail, '$.ask_id') = ? ORDER BY seq LIMIT 1")
        .get(itemId, askId) as { from_state: WorkItemState } | undefined;
      // 同一条提问再答一次：返回第一次的结果，不再写
      if (first) return { ok: true, state: item.state, from: first.from_state, duplicate: true, recorded: true };
      this.writeLog(itemId, fact, item.state, item.state, detail);
      const asks = (JSON.parse(item.open_asks || '[]') as { id: string }[]).filter((a) => a.id !== askId);
      db.prepare("UPDATE work_items SET open_asks = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(asks), itemId);
      return { ok: true, state: item.state, from: item.state, duplicate: false, recorded: true };
    }
    const late = TERMINAL.includes(item.state);
    this.writeLog(itemId, fact, item.state, item.state, late ? { ...detail, late: true } : detail);
    // 摘要只在原来没有回执时填：晚到的回执不覆盖终态时记下的那一份（全量在日志里）
    db.prepare("UPDATE work_items SET receipt_outcome = ?, receipt_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND receipt_outcome = ''").run(fact.outcome ?? '', itemId);
    return { ok: true, state: item.state, from: item.state, duplicate: false, recorded: true, late };
  }
}
