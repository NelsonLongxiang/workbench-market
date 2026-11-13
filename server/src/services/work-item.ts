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
import { afterStartup } from '../startup-gate.ts';

export const STATES = ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked', 'done', 'failed', 'dropped', 'cancelled'] as const;
export type WorkItemState = typeof STATES[number];
export const TERMINAL: readonly WorkItemState[] = ['done', 'failed', 'dropped', 'cancelled'];
/**
 * 会「停太久」的状态：已经交出去、还在往下走的。draft、held（有过目条目）、ready（有验收条目）和终态不算；
 * 有在等答复的提问的另有席位提问条目，由「关注」那边再剔掉
 */
export const STUCK_STATES: readonly WorkItemState[] = ['delivered', 'accepted', 'progress', 'waiting', 'blocked'];
/** 停多久算停太久（小时）：WM_WORK_ITEM_STUCK_HOURS，缺省 24，1～720 的整数；别的值返回 null（启动时拒绝）。只按自然时间算 */
export function workItemStuckHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.WM_WORK_ITEM_STUCK_HOURS ?? '');
  if (raw === '') return 24;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 720 ? n : null;
}
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
 *   note      只记录的备注：note = 'unrouted'（没有目标团队）/ 'untrusted'（提交方未验证，收到但未采信）
 *             / 'undispatched'（8f-2：事件 dispatch:false，只通知、不派发——没有回写通道，不进「已转交」，停在草稿）
 *
 * 8b 接来源时补的标记：others_alive（同一事件还有别的投递活着）、none_sent（这个事件的投递一次都没发出去）。
 */
export type Fact = {
  kind: 'submit' | 'release' | 'withdraw' | 'delivery' | 'eval' | 'report' | 'ask' | 'receipt' | 'verify' | 'return' | 'answer' | 'note';
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
  note?: 'unrouted' | 'untrusted' | 'undispatched' | 'followup' | 'followup-reply' | 'progress';
  /** 阶段七 R2：note=followup 时席位发来的跟进原文（前 500 字），只用于显示，不参与任何判断 */
  text?: string;
  others_alive?: boolean;
  /** 阶段七 R3：同一事件里有别的投递还活着或已经接手（回执的拒绝、放弃只在没有时才推终态） */
  others_engaged?: boolean;
  none_sent?: boolean;
  action?: string;
  /** 阶段七：回执信封里的 by（谁在做）——「名字 · 句柄」或句柄；带了就更新事项的 seat（承接席位），只用于显示 */
  seat?: string;
  /** 阶段七：回执信封里的 artifacts（cleanArtifacts 洗过）；带了就并进事项的 outputs */
  artifacts?: { kind: string; id: string }[];
};

type Row = { from: readonly WorkItemState[]; fact: Fact['kind']; when: (f: Fact) => boolean; to: WorkItemState; note: string };
const is = <K extends keyof Fact>(k: K, v: Fact[K]) => (f: Fact) => f[k] === v;
const hasReason = (f: Fact) => typeof f.reason === 'string' && f.reason.trim() !== '';

/**
 * 阶段七 R3：「对方说不干了」的回执结局和它推到的终态。所有这类行都只在 lastTeamStanding 成立时迁移：
 * 别的团队已接手或还活着时，一个团队的失败、拒绝、放弃不能把事项判死（ready 时也一样：只有接手的那个投递自己说才算）。
 */
export const GIVE_UP_OUTCOMES: readonly string[] = ['failed', 'rejected', 'abandoned'];
const GIVE_UP_TO: Record<string, WorkItemState> = { failed: 'failed', rejected: 'failed', abandoned: 'dropped' };
const GIVE_UP_NOTE: Record<string, string> = { failed: '没办成', rejected: '对方拒绝', abandoned: '放弃（回执即放弃要的那条回执）' };
/** 说不干了的这个投递是不是最后一个还在场的：别的投递里没有活着的（held / pending / sent）、也没有已接手的 */
export const lastTeamStanding = (f: Fact): boolean => f.others_engaged !== true;

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
  // 补定（规格附录 8b）：接单前就可以提问，成对补两行
  { from: ['delivered'], fact: 'ask', when: () => true, to: 'blocked', note: '接单前提问：已转交时来提问' },
  { from: ['blocked'], fact: 'eval', when: is('verdict', 'accept'), to: 'accepted', note: '先问后接：在问你时来接单' },
  // 8b 复验补：先问后拒——没有别的投递活着时，在问你时来拒接 → 没办成（还有活着的，走只记录的表）
  { from: ['blocked'], fact: 'eval', when: (f) => ['stop', 'ignore', 'unavailable'].includes(f.verdict ?? '') && hasReason(f) && f.others_alive !== true, to: 'failed', note: '先问后拒：在问你时来拒接' },
  // 实现时补定（8b）：排了队、一次都没发出去就撤回，等同于还没转交
  { from: ['delivered'], fact: 'withdraw', when: is('none_sent', true), to: 'cancelled', note: '排队中还没发出就撤回' },
  { from: NON_TERMINAL, fact: 'report', when: is('status', 'failed'), to: 'failed', note: '席位 report：failed' },
  // 对方说不干了（回执 failed / rejected / abandoned）：统一走 lastTeamStanding——别的投递里还有活着的或已接手的，只记录（见 RECORDS）
  ...GIVE_UP_OUTCOMES.map((o) => ({ from: NON_TERMINAL, fact: 'receipt' as const, when: (f: Fact) => f.outcome === o && lastTeamStanding(f), to: GIVE_UP_TO[o], note: `回执 outcome=${o}：${GIVE_UP_NOTE[o]}（别的投递没有活着或已接手的）` })),
  { from: NON_TERMINAL, fact: 'report', when: (f) => f.status === 'dropped' && typeof f.receipt?.outcome === 'string' && f.receipt.outcome !== '', to: 'dropped', note: '席位 report：dropped（同时有回执）' },
  // 阶段七 R3：席位的 A2A 回执（superagent 不发 report，只发回执）。没先收到接单回执就直接来结果的，视同接单后完成
  { from: ['delivered', 'accepted', 'progress', 'waiting', 'blocked'], fact: 'receipt', when: is('outcome', 'completed'), to: 'ready', note: '回执 outcome=completed：做完，等验收' },
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
  // 8b：一个事件投给多个团队
  { from: ['accepted', 'progress', 'waiting', 'ready'], fact: 'eval', when: (f) => ['accept', 'stop', 'ignore', 'unavailable'].includes(f.verdict ?? ''), note: '已有团队接手之后，别的团队再来接或拒' },
  { from: ['delivered', 'blocked'], fact: 'eval', when: (f) => ['stop', 'ignore', 'unavailable'].includes(f.verdict ?? '') && f.others_alive === true, note: '一个团队拒接，还有别的投递活着' },
  { from: ['delivered'], fact: 'delivery', when: (f) => f.outcome === 'dead' && f.others_alive === true, note: '一个投递 dead，还有别的投递活着' },
  // 阶段七 R3：一个团队说不干了（回执 failed / rejected / abandoned），别的投递还活着或已接手——只记录
  { from: NON_TERMINAL, fact: 'receipt', when: (f) => GIVE_UP_OUTCOMES.includes(f.outcome ?? '') && !lastTeamStanding(f), note: '一个团队回执说不干了（failed / rejected / abandoned），别的投递还活着或已接手' },
  { from: ['accepted', 'progress', 'waiting', 'blocked', 'ready'], fact: 'delivery', when: is('outcome', 'dead'), note: '已有团队接手之后，别的投递 dead' },
  // 8b：未路由、未采信
  { from: NON_TERMINAL, fact: 'note', when: (f) => f.note === 'unrouted' || f.note === 'untrusted' || f.note === 'undispatched', note: '未路由 / 收到但未采信 / 未派发' },
  // 阶段七 R2：席位在回执之后发来的自由文本跟进——只记录；终态之后对方也可能再说明一句，一并收下
  // 阶段七 PR-A：席位的进展回执（progress-<task>-<n>）——不结清、不推状态，只记录；终态之后到的拒（标晚到）
  { from: NON_TERMINAL, fact: 'note', when: (f) => f.note === 'progress', note: '席位的进展（只记录）' },
  { from: [...NON_TERMINAL, ...TERMINAL], fact: 'note', when: (f) => f.note === 'followup' || f.note === 'followup-reply', note: '席位发来的消息、人的回复（只记录）；「看过」只留在事件日志和消息状态里，不进事项时间线' },
];

export type ApplyResult =
  | { ok: true; state: WorkItemState; from: WorkItemState; duplicate: boolean; recorded?: boolean; late?: boolean; seatFilled?: boolean }
  | { ok: false; reason: 'bad_fact' | 'unknown_item' | 'terminal' | 'not_allowed'; state?: WorkItemState; duplicate?: boolean };

export type NewWorkItem = {
  title: string; created_by: string; source_kind: SourceKind; source_ref?: string;
  /** 8e：建立人的主体标识。只有认出了人、来源已验证时才给；不给就是空（没有「建立人」，只有管理员能处理） */
  creator_principal?: string | null;
  context?: Record<string, unknown>; event_id?: number | null; target_team?: string; seat?: string; object?: string; phase?: string;
  /** 规范 14 第 2 步：交给方式、等谁过目、指名的席位（seatId） */
  handoff?: Handoff; review_by?: ReviewBy; directed_seat_id?: string;
  /** 从哪个驾驶舱安排的：只在建的时候记，之后不改 */
  cockpit_id?: number | null;
};

export type WorkItemRow = {
  id: string; title: string; created_at: string; created_by: string; creator_principal: string | null; source_kind: SourceKind; source_ref: string; context: string;
  event_id: number | null; task_ids: string; target_team: string; seat: string; eval: string; eval_reason: string; state: WorkItemState;
  handoff: Handoff; review_by: ReviewBy; directed_seat_id: string; seat_id: string; seat_at: string; cockpit_id: number | null;
  progress_summary: string; progress_at: string; open_asks: string; receipt_outcome: string; receipt_at: string;
  outputs: string; evidence: string; object: string; phase: string; updated_at: string;
};
export type WorkItemLogRow = {
  seq: number; item_id: string; fact: string; fact_source: string; fact_id: string; from_state: WorkItemState; to_state: WorkItemState;
  actor: string; detail: string; at: string; rejected: '' | 'not_allowed' | 'terminal';
};

const KINDS: readonly Fact['kind'][] = ['submit', 'release', 'withdraw', 'delivery', 'eval', 'report', 'ask', 'receipt', 'verify', 'return', 'answer', 'note'];
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

/** 回执的 outcome 不分大小写（8a 验收提出、8b 定）：入口统一去空白、转小写。 */
function normalize(fact: Fact): Fact {
  const f = { ...fact };
  if (typeof f.outcome === 'string') f.outcome = f.outcome.trim().toLowerCase();
  if (f.receipt && typeof f.receipt.outcome === 'string') f.receipt = { ...f.receipt, outcome: f.receipt.outcome.trim().toLowerCase() };
  return f;
}

/**
 * 事务：已经在来源的事务里（8b 的监听器就是），用保存点，和来源同生同灭；不在事务里，自己开一个。
 * fn 返回 false 表示没有要留下的改动，回滚。
 */
let savepoints = 0;
function inTx<T>(fn: () => T, keep: (out: T) => boolean = () => true): T {
  if (db.isTransaction) {
    const name = `work_item_${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      if (!keep(out)) db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw e; }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec(keep(out) ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- 8b：从 workbench-events 的事实推进事项 ----------

export const EVENT_FACT_SOURCE = 'workbench-events';
/** 一个事件对应一个事项；id 由事件 id 定，回填和实时建出来的是同一个。 */
export const itemIdForEvent = (eventId: string) => `wi_${eventId}`;

export type EventRow = {
  id: number; event_id: string; source: string; workbench: string; item: string; context_id: string;
  submitter_kind: 'human' | 'agent' | 'unverified'; submitter: string; routed: string; created_at: string;
  /** 1 = 派发，0 = 只通知（app-data）。8f-2 之前的调用方可能没带，按派发算 */
  dispatch?: number;
};
/** 规范 14 第 2 步：事项是怎么交出去的（字段名和取值和阶段七对齐过：阶段七的指名派工也经事件层 recorded 写这几项） */
export const HANDOFFS = ['team', 'own-seat', 'lead-directed'] as const;
export type Handoff = (typeof HANDOFFS)[number];
export const REVIEW_BY = ['', 'lead', 'requester'] as const;
export type ReviewBy = (typeof REVIEW_BY)[number];
const SEAT_ID = /^seat-[0-9a-f]{8}$/;
/** 从 recorded 那一行的 detail 里取交给方式（只在新建时取）；取值不认得的一律当没写：交给团队、不过目、没有指名 */
/** 驾驶舱的 id：正整数才认，别的（坏的 detail、没有）当没有 */
export const COCKPIT_ID_MAX = 2_147_483_647;
function cockpitOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= COCKPIT_ID_MAX ? v : null;
}

function handoffOf(rec: { handoff?: unknown; review_by?: unknown; directed_seat_id?: unknown }): { handoff: Handoff; review_by: ReviewBy; directed_seat_id: string } {
  const handoff = (HANDOFFS as readonly unknown[]).includes(rec.handoff) ? rec.handoff as Handoff : 'team';
  const review_by = (REVIEW_BY as readonly unknown[]).includes(rec.review_by) ? rec.review_by as ReviewBy : '';
  const directed_seat_id = typeof rec.directed_seat_id === 'string' && SEAT_ID.test(rec.directed_seat_id) ? rec.directed_seat_id : '';
  return { handoff, review_by, directed_seat_id };
}

/**
 * 列表的视角圈出来的范围（scopeWhere）。
 * seats 的每一段是一个席位的一段分配：席位按完整的键认——有 seat_id 的按（节点, seat_id），seat_id 为空的旧席位按（节点, 团队, 句柄）；
 * 节点用名册里的根地址 root 表示（事项的投递地址在它下面）。from、to 是这段分配换成 seat_at 写法（UTC「YYYY-MM-DD hh:mm:ss」）的边界，
 * 由 work-item-access.ts 的 segmentBound 算（和详情的 ownerAt 同一个左闭右开口径）；to 为 null 是这段还在
 */
export type ViewScope =
  | { kind: 'all' }
  | { kind: 'mine'; principal: string }
  | { kind: 'seats'; segments: { root: string; team: string; seat: string; seat_id: string; from: string; to: string | null }[] }
  | { kind: 'team'; teams: { root: string; team: string }[] };

export type EventLogRow = { id: number; delivery_id: number | null; actor: string; action: string; detail: string };

/** 事件的来源坐标（「task-center · task-center · task:1」）：没有更好的标题时的退路，也用来认出「标题还是自动起的」 */
const coordTitle = (e: Pick<EventRow, 'source' | 'workbench' | 'item'>) => `${e.source} · ${e.workbench} · ${e.item}`.slice(0, 500);

/**
 * 建事项时从事件推出来的两样：标题、派给。
 *   标题：任务中心发布的取任务标题（tasks.title，发布时从录入的 title 步骤来）；取不到（不是任务中心、任务没了、标题空）退到来源坐标。
 *   派给：这个事件每个投递的目标团队（投递行在记事件时就建好，held 的也算；一个事件对一个团队只有一行），按投递顺序用「, 」连起来；
 *   没有投递（unrouted）是空串。
 * 只读，两种库都认的写法。tasks 表不在的进程（只装了事项服务的测试）当取不到。
 */
function derivedOf(e: Pick<EventRow, 'event_id' | 'source' | 'workbench' | 'item'>): { title: string; target_team: string } {
  let title = '';
  const m = e.source === 'task-center' ? /^task:([1-9]\d{0,15})$/.exec(e.item) : null;
  if (m) {
    try {
      const t = db.prepare('SELECT title FROM tasks WHERE id = ?').get(Number(m[1])) as { title: unknown } | undefined;
      if (typeof t?.title === 'string') title = t.title.replace(/\s+/g, ' ').trim().slice(0, 500);
    } catch { /* 没有 tasks 表 */ }
  }
  const teams = (db.prepare("SELECT target_team FROM workbench_event_deliveries WHERE event_id = ? AND target_team <> '' ORDER BY id").all(e.event_id) as { target_team: string }[]).map((r) => r.target_team);
  return { title: title || coordTitle(e), target_team: teams.join(', ').slice(0, 500) };
}

const PERSON_PRINCIPAL = /^user:[^\s]+$/;

/**
 * 8e：这件事项是不是这个主体建立的。「是不是他的」全部只认这一个函数：建立人的验收入口（creatorCheck）、
 * 「关注」里事项这个来源、事项页的读，用的都是它。只比主体标识；created_by（显示名）不看。
 * 建立人主体是空的事项，谁都不是它的建立人。
 */
export function isCreator(item: Pick<WorkItemRow, 'creator_principal'> | undefined | null, principal: string): boolean {
  const owner = item?.creator_principal;
  return typeof owner === 'string' && PERSON_PRINCIPAL.test(owner) && owner === principal;
}

/**
 * 8e/8f：从事件确定建立人的主体。只认事件层自己写的「recorded」那一行里记下的提需求人（requester：建录入时经身份服务认出来的），
 * 不认发布人（publisher，只留痕）；8e 那一版记的 principal 是发布人，也不认。
 * 认的是「服务端验过之后写下的 requester」：事件的提交方是已验证的，或者 recorded 里写着 via:"ticket"
 * （8f-2：台页面带回的提交人票据由服务端验过；对外的 submitter_kind 照旧是 unverified，不拿它来判断）。别的一律 null。
 * 判断只读主体字段；不按提交方自填的名字（submitter）去猜，也不去对主体表。
 */
export function creatorPrincipalOf(event: Pick<EventRow, 'submitter_kind'>, recorded: EventLogRow | undefined): string | null {
  if (!recorded || recorded.actor !== 'market') return null;
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(recorded.detail || '{}') as Record<string, unknown>; } catch { return null; }
  if (event.submitter_kind === 'unverified' && detail?.via !== 'ticket') return null;
  const p = detail?.requester;
  return typeof p === 'string' && PERSON_PRINCIPAL.test(p) ? p : null;
}

type DeliveryStatus = 'held' | 'pending' | 'sent' | 'dead' | 'cancelled' | 'accepted' | 'declined';
const DELIVERY_AFTER: Record<string, DeliveryStatus> = {
  held: 'held', queued: 'pending', released: 'pending', retry: 'pending', sent: 'sent', 'sent-after-withdraw': 'sent',
  dead: 'dead', cancelled: 'cancelled', 'decision:accept': 'accepted', 'decision:decline': 'declined',
  // 阶段七 R3：回执表达的投递结局
  'receipt:acknowledged': 'accepted', 'receipt:completed': 'accepted', 'receipt:rejected': 'declined', 'receipt:failed': 'declined', 'receipt:abandoned': 'declined',
};
/** 阶段七 R3：采信的 A2A 回执种类（receipt-inbound.ts 写的事件日志 action） */
const RECEIPT_OUTCOME_ACTIONS = ['receipt:completed', 'receipt:failed', 'receipt:rejected', 'receipt:abandoned'];
const ALIVE: readonly DeliveryStatus[] = ['held', 'pending', 'sent'];

/**
 * 事件日志的第 i 行对到哪条事实（null = 不是事实，例如 sent、retry）。纯函数，只看这一行和它之前的行：
 * 实时和回填按同一份来源日志算，结果一样。
 *   · held / queued → submit（开关没全开 / 全开）；released → release；cancelled → withdraw（none_sent：一次都没发出去）
 *   · dead → delivery（others_alive：同一事件还有别的投递活着）
 *   · decision:accept → eval accept；decision:decline → eval stop（理由为空记「未写理由」）；decision:ask → ask
 *   · 提交方未验证的事件：本来是事实的，都只记「收到但未采信」
 */
/**
 * 事项的 outputs（以及回执信封里的 artifacts）只有这一处定义：[{ kind, id }]，kind、id 都是非空字符串、各 ≤200 字（去控制字符），
 * 最多 16 项；只存标识，不存 url、标题、正文。kind 目前约定 sop-run（id = <slug>/<runId>）、table、file，别的值原样存。
 * 上游（a2a-net receipt-envelope-fields）只说「kind such as table, file, sop-run」，id 是需求方系统里的标识，节点不校验存在与否。
 */
export const OUTPUTS_MAX = 16;
export function cleanArtifacts(v: unknown): { kind: string; id: string }[] {
  if (!Array.isArray(v)) return [];
  const str = (x: unknown) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '');
  const seen = new Set<string>();
  const out: { kind: string; id: string }[] = [];
  for (const a of v) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const kind = str((a as Record<string, unknown>).kind), id = str((a as Record<string, unknown>).id);
    if (kind === '' || id === '' || seen.has(`${kind}\u0000${id}`)) continue;
    seen.add(`${kind}\u0000${id}`);
    out.push({ kind, id });
    if (out.length >= OUTPUTS_MAX) break;
  }
  return out;
}

/**
 * 承接席位：事项上只显示实际干活的成员，不显示总工。上游宿主取 by 的规则是「工单有成员就填成员，否则填总工」，
 * 所以确认、还没派给成员的进展里的 by 可能是总工。按上游的口径（A2A团队构建优化 2026-11-11）：
 *   · by.role（上游只增字段，dsh-open-a2a-net#611）是 member 或 observer 的，任何一类在做的回执都取；是 router 的一律不取；
 *   · 没有 role 时（过渡期）：只取提问（attention）和做完（completed）结果的 by，确认和进展的 by 不取；
 *   · 进展里 tickets 中在做（working / waiting / blocked）那一项的 seat 是成员，可以取；
 *   · 说不干了的结果（failed / rejected / abandoned）不改承接——可能是别的团队，也不再是「在做」。
 * 只存句柄（<zone>/<id8>）：名字是对端自报的会话标题，只当显示用，留在日志的 detail.by.name 里。取不到返回 ''。
 */
export function seatOfReceipt(action: string, detail: Record<string, unknown>): string {
  const by = detail.by && typeof detail.by === 'object' ? detail.by as { seat?: unknown; name?: unknown; role?: unknown } : null;
  const show = (seat: unknown, _name?: unknown) => typeof seat === 'string' && seat !== '' ? seat.slice(0, 200) : '';
  const working = action === 'receipt:acknowledged' || action === 'receipt:attention' || action === 'receipt:progress' || action === 'receipt:completed';
  if (!working || !by && action !== 'receipt:progress') return '';
  if (by?.role === 'router') return action === 'receipt:progress' ? ticketSeat(detail) : '';
  if (by?.role === 'member' || by?.role === 'observer') return show(by.seat, by.name);
  if (action === 'receipt:attention' || action === 'receipt:completed') return show(by?.seat, by?.name);
  return action === 'receipt:progress' ? ticketSeat(detail) : '';
}
function ticketSeat(detail: Record<string, unknown>): string {
  // 只取在做的子项（working / waiting / blocked）：queued 时还没派给成员，seat 可能是总工；ended 的已经不在做
  const t = Array.isArray(detail.tickets) ? (detail.tickets as { seat?: unknown; state?: unknown }[]).find((x) => x && ['working', 'waiting', 'blocked'].includes(String(x.state)) && typeof x.seat === 'string' && x.seat !== '') : undefined;
  return typeof t?.seat === 'string' ? t.seat.slice(0, 200) : '';
}

export function factFromEventLog(event: EventRow, rows: readonly EventLogRow[], i: number): Fact | null {
  const row = rows[i];
  const detail = (() => { try { return JSON.parse(row.detail || '{}') as Record<string, unknown>; } catch { return {}; } })();
  const base = { source: EVENT_FACT_SOURCE, id: String(row.id), actor: row.actor, action: row.action };
  let fact: Fact | null = null;
  const seat = seatOfReceipt(row.action, detail);
  // 8f-2：dispatch:false 的事件（只通知、不派发）没有回写通道，排上的投递不映射成「已转交」：停在草稿，日志记一行「未派发」。
  // 事实 id 和原来那条 submit 相同：存量里已经应用过的照旧按（来源、id）跳过，回填重跑结果不变
  if ((row.action === 'held' || row.action === 'queued') && Number(event.dispatch) === 0) return { ...base, kind: 'note', note: 'undispatched' };
  if (row.action === 'held' || row.action === 'queued') fact = { ...base, kind: 'submit', dispatch_open: row.action === 'queued' };
  // 代办放行（团队没有负责人时管理层代办）：事件日志那一行的 detail 记着 acting_for，原样带进事项日志，时间线照它写「代某某办」
  else if (row.action === 'released') fact = { ...base, kind: 'release', ...(typeof detail.acting_for === 'string' && detail.acting_for ? { acting_for: detail.acting_for.slice(0, 64) } : {}) };
  else if (row.action === 'cancelled') fact = { ...base, kind: 'withdraw', none_sent: !rows.slice(0, i + 1).some((r) => r.action === 'sent' || r.action === 'sent-after-withdraw') };
  else if (row.action === 'receipt:untrusted' || row.action === 'receipt:unaccepted') fact = { ...base, kind: 'note', note: 'untrusted' };
  else if (row.action === 'receipt:progress') fact = { ...base, kind: 'note', note: 'progress', text: typeof detail.summary === 'string' ? detail.summary : '' };
  else if (row.action === 'followup') fact = { ...base, kind: 'note', note: 'followup', text: typeof detail.text === 'string' ? detail.text : '' };
  // 代建立人回复（持管理层授予的人）：同放行，acting_for 原样带进事项日志
  else if (row.action === 'followup-replied') fact = { ...base, kind: 'note', note: 'followup-reply', text: typeof detail.text === 'string' ? detail.text : '', ...(typeof detail.acting_for === 'string' && detail.acting_for ? { acting_for: detail.acting_for.slice(0, 64) } : {}) };
  else if (row.action === 'receipt:attention') fact = { ...base, kind: 'ask', question: typeof detail.summary === 'string' ? detail.summary : '' };
  else if (row.action === 'dead' || row.action.startsWith('decision:') || row.action === 'receipt:acknowledged' || RECEIPT_OUTCOME_ACTIONS.includes(row.action)) {
    const status = new Map<number, DeliveryStatus>();
    for (const r of rows.slice(0, i)) if (r.delivery_id !== null && DELIVERY_AFTER[r.action]) status.set(r.delivery_id, DELIVERY_AFTER[r.action]);
    const others_alive = [...status].some(([d, st]) => d !== row.delivery_id && ALIVE.includes(st));
    const others_engaged = [...status].some(([d, st]) => d !== row.delivery_id && (ALIVE.includes(st) || st === 'accepted'));
    if (row.action === 'dead') fact = { ...base, kind: 'delivery', outcome: 'dead', others_alive };
    else if (row.action === 'decision:accept') fact = { ...base, kind: 'eval', verdict: 'accept', others_alive };
    else if (row.action === 'decision:decline') {
      const reason = typeof detail.reason === 'string' && detail.reason.trim() !== '' ? detail.reason : '未写理由';
      fact = { ...base, kind: 'eval', verdict: 'stop', reason, others_alive };
    } else if (row.action === 'decision:ask') fact = { ...base, kind: 'ask', question: typeof detail.reason === 'string' ? detail.reason : '' };
    else if (row.action === 'receipt:acknowledged') fact = { ...base, kind: 'eval', verdict: 'accept', others_alive };
    else if (RECEIPT_OUTCOME_ACTIONS.includes(row.action)) {
      const outcome = row.action.slice('receipt:'.length);
      fact = { ...base, kind: 'receipt', outcome, others_alive, others_engaged, ...(outcome === 'rejected' ? { reason: '对方拒绝' } : {}) };
    }
  }
  if (fact && event.submitter_kind === 'unverified') return { ...base, kind: 'note', note: 'untrusted' };
  if (fact && seat !== '') fact = { ...fact, seat };
  // 采信的回执带的产物：并进事项的 outputs（只记录类的回执、终态之后晚到的也并：产物是事实，不是状态）
  const artifacts = row.action.startsWith('receipt:') && row.action !== 'receipt:untrusted' && row.action !== 'receipt:unaccepted' ? cleanArtifacts(detail.artifacts) : [];
  if (fact && artifacts.length > 0) fact = { ...fact, artifacts };
  return fact;
}

/**
 * 回填版本号：迁移表、事实映射、建事项的规则改了，就加一。版本号变了就从头全量核一遍。
 * 版本没变时每次启动只做增量：从上次记下的事件日志水位往后核（没装事项服务的进程——比如回滚到旧版本期间——
 * 写进来的事件和事实，靠它补回来）。监听器漏过事实（dirty）也从头全量核。
 */
export const BACKFILL_VERSION = 7; // 2：阶段七 R2 加了跟进、回复、看过的映射（#546）；3：进展回执的映射（PR-A）；4：回执的 by 记成承接席位；5：承接只取成员、重复事实补写承接（4 已被试联实例用过），终态事项承接空着的也补；6：承接只存句柄、进展只取在做的子项、回填按顺序最后一条为准；7：回执的 artifacts 并进 outputs
/** 后台回填每一片最多占用事件循环的时长（毫秒），之后让出，好让请求得到应答 */
const BACKFILL_SLICE_MS = 25;
/** 每次取的行数（取出来的一批跨片接着用，用完再取） */
const BACKFILL_FETCH = 50;
/** 进度记账（游标）最多隔多久写一次库：第一片之后记一次，之后按时间节流，跑完照记。进程中途被杀，重启最多重核最后这 1 秒处理过的事件，事实按（来源、id）去重，终态不变 */
const BACKFILL_MARK_MS = 1000;

export type BackfillStatus = {
  /** pending = 还没开始；running = 在跑；done = 跑完（全量或增量）；failed = 这一轮出错停下（下次启动接着跑） */
  state: 'pending' | 'running' | 'done' | 'failed';
  version: number;
  /** full = 全量核（按事件行号）；incremental = 增量核（按事件日志行号，从上次的水位往后） */
  phase?: 'full' | 'incremental';
  /** 游标：全量时是事件行号，增量时是事件日志行号；batches = 跑到第几批；events = 这一轮已核对的事件数 */
  cursor: number; batches: number; events: number;
  /** 这一轮从哪个游标之后开始（全量从头是 0；上次跑到一半就是那时记下的游标；增量是上次的水位） */
  from?: number;
};

type BackfillMark = { version: number; status: string; phase: string; cursor: number; batches: number; events: number; log_mark: number; dirty: number };

/** 一条事项日志给人看的那句话：进展摘要、提问、答复、理由、备注……取第一个有的；都没有就空串 */
function logText(l: WorkItemLogRow): string {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(l.detail || '{}') as Record<string, unknown>; } catch { return ''; }
  for (const k of ['summary', 'text', 'question', 'answer', 'reason', 'note', 'status', 'verdict', 'outcome']) {
    const v = d[k];
    if (typeof v === 'string' && v.trim() !== '') return v.slice(0, 500);
  }
  return '';
}

export class WorkItemService extends Service {
  constructor(ctx: any) {
    super(ctx, 'workItems');
    // 8b：workbench-events 每写一行事件日志就发一个事件（在它自己的事务里）。随插件卸载自动撤销。
    ctx.on('workbench-event/logged', (row: { event_id: string; action: string }) => this.onLogged(row));
    // 回填不挡启动：在后台分批跑（每一片让出事件循环），期间事项照常可读、随回填逐步补齐。随插件卸载停下。
    // 服务进程里等启动自检通过再开始（startup-gate.ts）：不和自检的请求抢事件循环；自检没过不开始
    ctx.effect(() => {
      let stopped = false;
      // 后台回填出任何错都不能拖垮服务：记下、停在这里，下次启动接着跑
      const cancel = afterStartup(() => {
        if (stopped) return;
        // 存量事项补标题和派给：出错只记下，不挡回填
        try { const n = this.fillDerivedAll(); if (n) console.log(`[work-items] 补了 ${n} 件存量事项的标题或派给`); } catch (e) {
          console.error(`[work-items] 补存量事项的标题、派给没成（不影响服务，下次启动再补）：${(e as Error)?.message ?? e}`);
        }
        try { this.runBackground(() => stopped); } catch (e) {
          this.progress = { ...this.progress, state: 'failed' };
          console.error(`[work-items] 后台回填没能开始（不影响服务，下次启动再试，或手动 backfill()）：${(e as Error)?.message ?? e}`);
        }
      });
      return () => { stopped = true; cancel(); };
    }, 'workItems.backfill');
  }

  private progress: BackfillStatus = { state: 'pending', version: BACKFILL_VERSION, cursor: 0, batches: 0, events: 0 };
  /** 就绪检查里报的回填状态（不影响就绪与否）。匿名只给 state，细节给管理员（index.ts 决定） */
  backfillStatus(): BackfillStatus {
    return { ...this.progress };
  }

  private readBackfillMark(): BackfillMark | undefined {
    return db.prepare('SELECT version, status, phase, cursor, batches, events, log_mark, dirty FROM work_item_backfill WHERE id = 1').get() as never;
  }
  /** 时间由代码生成后传进 SQL；ON CONFLICT … DO UPDATE 两种库都认。dirty 不在这里改（见 markDirty / 全量开跑时清零） */
  private saveBackfillMark(m: { status: 'running' | 'done' | 'stale'; phase: 'full' | 'incremental'; cursor: number; batches: number; events: number; log_mark: number }): void {
    db.prepare(`INSERT INTO work_item_backfill (id, version, status, phase, cursor, batches, events, log_mark, dirty, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT (id) DO UPDATE SET version = excluded.version, status = excluded.status, phase = excluded.phase, cursor = excluded.cursor,
        batches = excluded.batches, events = excluded.events, log_mark = excluded.log_mark, updated_at = excluded.updated_at`)
      .run(BACKFILL_VERSION, m.status, m.phase, m.cursor, m.batches, m.events, m.log_mark, new Date().toISOString());
  }
  private setDirty(on: boolean): void {
    db.prepare('UPDATE work_item_backfill SET dirty = ?, updated_at = ? WHERE id = 1').run(on ? 1 : 0, new Date().toISOString());
  }
  private hasEvents(): boolean {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workbench_events'").get());
  }
  /** 事件日志现在的最大行号（水位） */
  private logHigh(): number {
    if (!this.hasEvents()) return 0;
    return (db.prepare('SELECT MAX(id) AS m FROM workbench_event_log').get() as { m: number | null }).m ?? 0;
  }

  /**
   * 后台回填，分三种：
   *   · 全量：版本号变了、从没跑完过、或者监听器漏过事实（dirty）。按事件行号从头核（上次跑到一半就从游标接着跑）。
   *   · 增量：这个版本全量跑完过。从上次记下的事件日志水位往后，把有新日志行的事件核一遍——不在场的进程写进来的也补得回来。
   *   · 每一片最多占 BACKFILL_SLICE_MS，游标在每一片结束时记下；进程中途被杀，重启接着跑，终态与一次跑完相同
   *     （每个事件的事实按（来源、id）去重，重核不会多写）。期间新来的事实由监听器实时应用，回填再核到同一条时跳过。
   * 跑完时记下新的水位；如果这一轮里监听器漏过事实（dirty 又被置上），记成 stale，下次启动从头全量核。
   */
  private runBackground(stopped: () => boolean): void {
    const row = this.readBackfillMark();
    const sameVersion = row?.version === BACKFILL_VERSION;
    let phase: 'full' | 'incremental', cursor: number, batches = 0, events = 0, logMark = row?.log_mark ?? 0;
    if (sameVersion && row.status === 'running' && !row.dirty) {
      // 上次跑到一半：同一阶段从游标接着跑
      phase = row.phase === 'incremental' ? 'incremental' : 'full'; cursor = row.cursor; batches = row.batches; events = row.events;
    } else if (sameVersion && row.status === 'done' && !row.dirty) {
      phase = 'incremental'; cursor = row.log_mark;
    } else {
      phase = 'full'; cursor = 0;
      if (row) this.setDirty(false); // 这一轮从头核；之后再出错会重新置上
    }
    this.saveBackfillMark({ status: 'running', phase, cursor, batches, events, log_mark: logMark });
    const from = cursor;
    this.progress = { state: 'running', version: BACKFILL_VERSION, phase, cursor, batches, events, from };
    // 取出来的一批跨片接着用（不每片重取）；增量阶段这一轮核过的事件跨片记着：一个事件的日志行切在两片里也只核一次。
    // 核一个事件时它在库里的事实都会追上，之后新来的由监听器实时应用，所以这一轮里不用再核第二遍
    // seen 的上界：这一轮有新日志行的事件数（全量阶段不用它）；进程重启后这一轮从记下的游标重新开始，seen 也从空开始
    let queue: { id: number; event_id: string }[] = [];
    let qi = 0;
    const seen = new Set<string>();
    let lastMark = 0;
    // 回填自己这一段从第一片开始算（不含启动、不含等自检），跑完时写进完成那一行日志，量吞吐用
    const startedAt = Date.now();
    const slice = () => {
      if (stopped()) return;
      try {
        const t0 = Date.now();
        // 每处理一个事件看一次表：一片最多超出时间表一个事件的工夫
        const overtime = () => Date.now() - t0 >= BACKFILL_SLICE_MS;
        let finished = false;
        do {
          if (qi >= queue.length) {
            // 新库上事件表可能还没建（任务中心初始化时才建）：那就没有可回填的
            if (!this.hasEvents()) { finished = true; break; }
            queue = (phase === 'full'
              ? db.prepare('SELECT id, event_id FROM workbench_events WHERE id > ? ORDER BY id LIMIT ?')
              : db.prepare('SELECT id, event_id FROM workbench_event_log WHERE id > ? ORDER BY id LIMIT ?')).all(cursor, BACKFILL_FETCH) as { id: number; event_id: string }[];
            qi = 0;
            if (queue.length === 0) { finished = true; break; }
          }
          const { id, event_id } = queue[qi++];
          if (phase === 'full') { this.syncEvent(event_id); events++; }
          else if (!seen.has(event_id)) { seen.add(event_id); this.syncEvent(event_id); events++; }
          cursor = id;
        } while (!overtime());
        batches++;
        if (finished) {
          const dirty = Boolean(this.readBackfillMark()?.dirty);
          const high = this.logHigh();
          this.saveBackfillMark({ status: dirty ? 'stale' : 'done', phase, cursor, batches, events, log_mark: high });
          if (dirty) this.setDirty(true); // saveBackfillMark 不动 dirty；这里显式留着，下次启动从头全量核
          this.progress = { state: 'done', version: BACKFILL_VERSION, phase, cursor, batches, events, from };
          console.log(`[work-items] 后台回填完成（${phase === 'full' ? '全量' : '增量'}）：核对 ${events} 个事件，${batches} 批，用时 ${Date.now() - startedAt} 毫秒（从第一片到跑完）${dirty ? '；期间监听器漏过事实，下次启动从头全量核' : ''}`);
          return;
        }
        // 进度记账节流：第一片之后记一次，之后最多隔 BACKFILL_MARK_MS 记一次（每片写一次库的固定开销在慢盘上会拖慢回填）
        if (lastMark === 0 || Date.now() - lastMark >= BACKFILL_MARK_MS) { this.saveBackfillMark({ status: 'running', phase, cursor, batches, events, log_mark: logMark }); lastMark = Date.now(); }
        this.progress = { state: 'running', version: BACKFILL_VERSION, phase, cursor, batches, events, from };
        setImmediate(slice);
      } catch (e) {
        this.progress = { ...this.progress, state: 'failed' };
        console.error(`[work-items] 后台回填停在游标 ${cursor} 之后（不影响服务，下次启动接着跑，或手动 backfill()）：${(e as Error)?.message ?? e}`);
      }
    };
    slice();
  }

  /** 监听器出错不影响来源：回滚自己的保存点、打日志、按事实种类计数；漏掉的由回填补上。 */
  private readonly failures = new Map<string, number>();
  failureCounts(): Record<string, number> {
    return Object.fromEntries(this.failures);
  }

  onLogged(row: { event_id: string; action: string }): void {
    try {
      this.syncEvent(row.event_id);
    } catch (e) {
      const key = String(row?.action ?? 'unknown');
      const count = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, count);
      console.error(`[work-items] 事件 ${row?.event_id} 的事实（${key}）没推进到事项（这种事实累计 ${count} 次），下次启动的回填会补上：${(e as Error)?.message ?? e}`);
      // 漏过事实：不管回填处在什么状态都记下（dirty），下次启动从头全量核。正在跑的这一轮跑完时看到它，记成 stale
      try { this.setDirty(true); } catch { /* 记不下也不影响来源 */ }
    }
  }

  /** 按来源日志把这个事件的事项追到最新：没有就建，已经应用过的事实按（来源、id）跳过。可以重复跑。 */
  syncEvent(eventId: string): void {
    inTx(() => this.syncLocked(eventId));
  }

  /** 回填（手动入口，同步跑完）：从现有的事件表和事件日志把存量事项建出来、追到最新。可以重复跑，结果相同。
   *  跑完记下「这个版本全量跑完过」和事件日志的水位（之后启动从水位往后增量核）。 */
  backfill(): { events: number; created: number } {
    // 新库上事件表可能还没建（任务中心初始化时才建）：那就没有可回填的
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workbench_events'").get()) return { events: 0, created: 0 };
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM work_items').get() as { n: number }).n;
    const before = count();
    const ids = db.prepare('SELECT event_id FROM workbench_events ORDER BY id').all() as { event_id: string }[];
    for (const { event_id } of ids) this.syncEvent(event_id);
    const last = (db.prepare('SELECT MAX(id) AS m FROM workbench_events').get() as { m: number | null }).m ?? 0;
    this.saveBackfillMark({ status: 'done', phase: 'full', cursor: last, batches: 1, events: ids.length, log_mark: this.logHigh() });
    if (this.progress.state !== 'running') this.progress = { state: 'done', version: BACKFILL_VERSION, phase: 'full', cursor: last, batches: 1, events: ids.length };
    return { events: ids.length, created: count() - before };
  }

  /**
   * 补存量事项的标题和派给：标题仍是来源坐标（自动起的）而现在能取到任务标题的，换成任务标题；派给空着而事件有投递的，写上。
   * 条件更新（WHERE 带上旧值），并发或重复跑结果相同。不写事项日志：这两项是从事件推出来的显示信息，不是事实。
   */
  private fillDerived(w: Pick<WorkItemRow, 'id' | 'title' | 'target_team'>, e: Pick<EventRow, 'event_id' | 'source' | 'workbench' | 'item'>): boolean {
    const coord = coordTitle(e);
    if (w.title !== coord && w.target_team !== '') return false;
    const d = derivedOf(e);
    let changed = false;
    if (w.title === coord && d.title !== coord) changed = Number(db.prepare('UPDATE work_items SET title = ? WHERE id = ? AND title = ?').run(d.title, w.id, coord).changes) > 0 || changed;
    if (w.target_team === '' && d.target_team !== '') changed = Number(db.prepare("UPDATE work_items SET target_team = ? WHERE id = ? AND target_team = ''").run(d.target_team, w.id).changes) > 0 || changed;
    return changed;
  }

  /**
   * 启动时补一遍存量（不随回填版本走，也不全量核事件）：只挑派给空着、或任务中心来的事项，逐件按 fillDerived 补。
   * 补过的不再是候选；任务中心里标题已经换过的，fillDerived 第一行就跳过。返回补了几件。
   */
  fillDerivedAll(): number {
    const rows = db.prepare(`SELECT w.id AS id, w.title AS title, w.target_team AS target_team, e.event_id AS event_id, e.source AS source, e.workbench AS workbench, e.item AS item
      FROM work_items w JOIN workbench_events e ON e.id = w.event_id WHERE w.target_team = '' OR w.source_kind = 'task-center'`).all() as (Pick<WorkItemRow, 'id' | 'title' | 'target_team'> & Pick<EventRow, 'event_id' | 'source' | 'workbench' | 'item'>)[];
    let n = 0;
    for (const r of rows) if (this.fillDerived(r, r)) n++;
    return n;
  }

  private syncLocked(eventId: string): void {
    const event = db.prepare('SELECT id, event_id, source, workbench, item, context_id, submitter_kind, submitter, routed, created_at, dispatch FROM workbench_events WHERE event_id = ?')
      .get(eventId) as EventRow | undefined;
    if (!event) return;
    const rows = db.prepare('SELECT id, delivery_id, actor, action, detail FROM workbench_event_log WHERE event_id = ? ORDER BY id').all(eventId) as EventLogRow[];
    const recorded = rows.find((r) => r.action === 'recorded');
    if (!recorded) return;
    const itemId = itemIdForEvent(eventId);
    const creator = creatorPrincipalOf(event, recorded);
    const existing = this.get(itemId);
    // 存量事项：建立人主体还空着、而事件能确定已验证主体的，补上（只补空的；确定不了的照旧空着）。重复跑结果相同
    if (existing && existing.creator_principal === null && creator !== null) db.prepare('UPDATE work_items SET creator_principal = ? WHERE id = ? AND creator_principal IS NULL').run(creator, itemId);
    // 存量事项：标题还是自动起的来源坐标、派给还空着的，按同一个规则补上（只补自动的缺省值，不碰别的）。重复跑结果相同
    if (existing) this.fillDerived(existing, event);
    if (!existing) {
      const who = String(event.submitter ?? '').replace(/\s+/g, '_').slice(0, 200);
      // 显示用的建立人：认出来的提需求人优先（和建立人主体同一个人），认不出才用事件上自填的名字。
      // 不拿发布的人顶替（8f：发布的人只留痕，不当建立人，显示也不当）。以前任务中心来的都是 human:<自填的 published_by>。只影响新建的事项
      const createdBy = creator ?? (event.submitter_kind !== 'unverified' && /^[^:\s]+:\S/.test(who) ? who : `${event.submitter_kind}:${who || 'unknown'}`);
      const derived = derivedOf(event);
      // 「安排一件事」：挂在哪条线、哪一步，记在 recorded 那一行里（只在新建时取，存量没有这两项）
      let rec: { object?: unknown; phase?: unknown; handoff?: unknown; review_by?: unknown; directed_seat_id?: unknown; cockpit_id?: unknown } = {};
      try { rec = JSON.parse(recorded.detail || '{}'); } catch { /* 坏的 detail 当没有 */ }
      const tag = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
      this.insertItem(itemId, {
        title: derived.title, target_team: derived.target_team, created_by: createdBy, creator_principal: creator, object: tag(rec.object), phase: tag(rec.phase),
        ...handoffOf(rec), cockpit_id: cockpitOf(rec.cockpit_id),
        source_kind: event.source as SourceKind, source_ref: event.event_id, event_id: event.id,
        context: { workbench: event.workbench, item: event.item, context_id: event.context_id, submitter_kind: event.submitter_kind, ...(creator && event.submitter_kind === 'unverified' ? { submitter_via: 'ticket' } : {}) },
      }, { source: EVENT_FACT_SOURCE, id: String(recorded.id) }, event.created_at);
      if (event.routed === 'unrouted') this.applyLocked(itemId, { kind: 'note', note: 'unrouted', source: EVENT_FACT_SOURCE, id: `${recorded.id}:unrouted`, actor: 'market' });
    }
    for (let i = 0; i < rows.length; i++) {
      const fact = factFromEventLog(event, rows, i);
      if (!fact) continue;
      // 一个投递在事件层只有一栏决定：再问一次、或作出决定，它先前的提问就不再等答复（事件层也不再算）。
      // 先把这个投递之前的提问都记一行答复合上，再应用这一条。已经合上的，答复按「答过」返回、不再写
      if ((fact.kind === 'eval' || fact.kind === 'ask' || (fact.kind === 'receipt' && rows[i].action.startsWith('receipt:'))) && rows[i].delivery_id !== null) {
        const state = this.get(itemId)?.state;
        for (const asked of rows.slice(0, i).filter((r) => r.delivery_id === rows[i].delivery_id && (r.action === 'decision:ask' || r.action === 'receipt:attention'))) {
          // 只合上那时还开着的：事项已经结束（合上也只会被拒，每条晚到的回执各留一行）、或这条提问已经有过答复（答过、合上过、被拒过）的，跳过
          if (state === undefined || TERMINAL.includes(state)) break;
          if (db.prepare("SELECT 1 FROM work_item_log WHERE item_id = ? AND fact = 'answer' AND json_extract(detail, '$.ask_id') = ? LIMIT 1").get(itemId, String(asked.id))) continue;
          this.applyLocked(itemId, {
            kind: 'answer', source: EVENT_FACT_SOURCE, id: `${rows[i].id}:closes-ask:${asked.id}`, ask_id: String(asked.id), actor: rows[i].actor,
            answer: fact.kind === 'ask' ? '（同一个接单节点又问了一次，这条提问换成新的那条）' : fact.kind === 'receipt' ? '（同一个接单节点随后发来了结果回执，这条提问不再等答复）' : '（同一个接单节点随后作出了决定，这条提问不再等答复）',
          });
        }
      }
      this.applyLocked(itemId, normalize(fact));
    }
  }

  /** 新建一件事项：一律从 draft 开始，第一行日志是「建立」。 */
  create(input: NewWorkItem): WorkItemRow {
    if (!text(input?.title, 500)) throw new Error('事项要有标题');
    if (!/^[^:\s]+:\S/.test(String(input.created_by ?? ''))) throw new Error('created_by 要是主体标识（如 user:<名>）');
    if (!SOURCE_KINDS.includes(input.source_kind)) throw new Error('不认识的来源类别');
    if (input.creator_principal != null && !PERSON_PRINCIPAL.test(String(input.creator_principal))) throw new Error('creator_principal 要是人的主体标识（user:<名>）或者不给');
    const id = `wi_${randomUUID().replace(/-/g, '')}`;
    inTx(() => this.insertItem(id, input, { source: 'market', id }));
    return this.get(id)!;
  }

  private insertItem(id: string, input: NewWorkItem, by: { source: string; id: string }, createdAt?: string): void {
    db.prepare(`INSERT INTO work_items (id, title, created_by, creator_principal, source_kind, source_ref, context, event_id, target_team, seat, object, phase, handoff, review_by, directed_seat_id, cockpit_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`).run(
      id, input.title, input.created_by, input.creator_principal ?? null, input.source_kind, input.source_ref ?? '', JSON.stringify(input.context ?? {}),
      input.event_id ?? null, input.target_team ?? '', input.seat ?? '', input.object ?? '', input.phase ?? '',
      input.handoff ?? 'team', input.review_by ?? '', input.directed_seat_id ?? '', input.cockpit_id ?? null, createdAt ?? null, createdAt ?? null);
    db.prepare(`INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, actor, detail)
      VALUES (?, 'create', ?, ?, 'draft', 'draft', ?, '{}')`).run(id, by.source, by.id, input.created_by);
  }

  get(id: string): WorkItemRow | undefined {
    return db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as WorkItemRow | undefined;
  }

  /**
   * 8e：建立人本人能不能对这件事项拍板（验收、退回）。不看状态（状态在应用事实时由迁移表判）。
   *   · 事项不存在、或这个主体不是它的建立人（isCreator：只比建立人主体，不看显示名；建立人主体空着的事项谁都不是）
   *     → not_found（不说有没有这件事项）
   *   · 事项来自未验证的提交方 → not_eligible：只能由管理员处理（建事项时这种不会记建立人主体，这里再挡一道）
   */
  creatorCheck(id: string, principal: string): 'ok' | 'not_found' | 'not_eligible' {
    const item = this.get(id);
    if (!item || !isCreator(item, principal)) return 'not_found';
    let submitterKind = '', via = '';
    try {
      const c = JSON.parse(item.context || '{}') as { submitter_kind?: unknown; submitter_via?: unknown };
      submitterKind = String(c.submitter_kind ?? ''); via = String(c.submitter_via ?? '');
    } catch { /* 坏的 context 当没写 */ }
    // 来源未验证、又不是服务端验过票据认出的人：只能由管理员处理
    if (submitterKind === 'unverified' && via !== 'ticket') return 'not_eligible';
    return 'ok';
  }

  /** 事项最近一次「进入」这几个状态之一的那一行日志的 seq（状态真的变过去的那一行）；没进过返回 null。
   *  「关注」记账用它分开每一轮待决：退回之后再进 ready 是新的一轮 */
  lastEntrySeq(id: string, states: readonly WorkItemState[]): number | null {
    const row = db.prepare(`SELECT seq FROM work_item_log WHERE item_id = ? AND from_state <> to_state AND to_state IN (${states.map(() => '?').join(', ')}) ORDER BY seq DESC LIMIT 1`)
      .get(id, ...states) as { seq: number } | undefined;
    return row?.seq ?? null;
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

  /**
   * 一个视角圈出来的事项范围（规范 14 第九节第 4 条，只有这一处拼条件）：
   *   all   全部（管理层）
   *   mine  我是建立人（isCreator 同一个口径：按建立人主体）
   *   seats 承接席位在接手那一刻（seat_at）分配给我的：有 seatId 的分配段按（节点, seat_id）配，seat_id 为空的旧席位按（节点, 团队, 句柄）三项全等配；
   *         空串的 seat_id 不参加匹配，不做子串，不跨节点。节点、团队从事项事件的投递来（和 itemTeams 同一个口径：画布团队、根地址在名册里）
   *   team  交给我负责的团队：事项的事件有一条投递，目标团队和根地址对得上
   * SQL 只用两种库都认的写法。
   */
  private scopeWhere(scope: ViewScope): { where: string; args: (string | number)[] } {
    if (scope.kind === 'all') return { where: '1 = 1', args: [] };
    if (scope.kind === 'mine') return PERSON_PRINCIPAL.test(scope.principal) ? { where: 'creator_principal = ?', args: [scope.principal] } : { where: '1 = 0', args: [] };
    if (scope.kind === 'seats') {
      const parts: string[] = [], args: (string | number)[] = [];
      for (const g of scope.segments) {
        const range = g.to === null ? 'seat_at >= ?' : 'seat_at >= ? AND seat_at < ?';
        const times = g.to === null ? [g.from] : [g.from, g.to];
        // 事项投到这个节点（根地址）上的画布团队；旧席位还要团队相等
        const onHost = "EXISTS (SELECT 1 FROM workbench_event_deliveries d WHERE d.event_id = work_items.source_ref AND d.target_team LIKE '%/canvas/%' AND (d.target_url = ? OR d.target_url LIKE ?)";
        if (g.seat_id) { parts.push(`(seat_id = ? AND seat_at <> '' AND ${range} AND ${onHost}))`); args.push(g.seat_id, ...times, g.root, g.root + '/%'); }
        else if (g.seat) { parts.push(`(seat_id = '' AND seat = ? AND seat_at <> '' AND ${range} AND ${onHost} AND d.target_team = ?))`); args.push(g.seat, ...times, g.root, g.root + '/%', g.team); }
      }
      return parts.length ? { where: `(${parts.join(' OR ')})`, args } : { where: '1 = 0', args: [] };
    }
    const parts: string[] = [], args: (string | number)[] = [];
    for (const t of scope.teams) { parts.push('(d.target_team = ? AND (d.target_url = ? OR d.target_url LIKE ?))'); args.push(t.team, t.root, t.root + '/%'); }
    if (!parts.length) return { where: '1 = 0', args: [] };
    return { where: `EXISTS (SELECT 1 FROM workbench_event_deliveries d WHERE d.event_id = work_items.source_ref AND (${parts.join(' OR ')}))`, args };
  }

  /** 一个视角里有几件（不按状态、对象筛）：列表应答的 views 用 */
  private stuckHours = 24;
  setStuckHours(h: number): void { this.stuckHours = h; }
  /** 停多久算停太久（小时，启动时由 WM_WORK_ITEM_STUCK_HOURS 设） */
  stuckThresholdHours(): number { return this.stuckHours; }

  /**
   * 停在某一步太久的候选：在 STUCK_STATES 里、最后一次变动（updated_at，每应用一条事实都会更新）早于 now 减阈值。
   * 按停得最久的排，最多 limit 条。走 (state, updated_at) 那个索引（idx_work_items_state），不全表扫；时间在代码里算
   */
  stuckCandidates(now: number, limit: number): WorkItemRow[] {
    const cutoff = new Date(now - this.stuckHours * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    return db.prepare(`SELECT * FROM work_items WHERE state IN (${STUCK_STATES.map(() => '?').join(', ')}) AND updated_at < ? ORDER BY updated_at, id LIMIT ?`)
      .all(...STUCK_STATES, cutoff, limit) as WorkItemRow[];
  }

  countIn(scope: ViewScope): number {
    const w = this.scopeWhere(scope);
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE ${w.where}`).get(...w.args) as { n: number }).n);
  }

  /** 事项的事件发往哪些团队（投递的目标团队和投递地址）：认事项属于哪个团队用 */
  deliveryTargets(eventId: string): { team: string; url: string }[] {
    return db.prepare('SELECT target_team AS team, target_url AS url FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id').all(eventId) as { team: string; url: string }[];
  }

  /**
   * 列表一页（给事项列表的读接口）：按 updated_at、id 倒序，游标翻页；同时给这个视角里按状态的计数。
   * 范围由 scope 定（scopeWhere）；看不到的不出现，也不计数。每行带最后一条事项日志（谁、做了什么、什么时候）。
   */
  page(opts: { scope: ViewScope; state?: WorkItemState; object?: string; phase?: string; seat?: string; cockpit?: number; limit: number; after?: { updated_at: string; id: string } }): {
    items: (WorkItemRow & { last_log: { actor: string; fact: string; text: string; at: string } | null })[];
    counts: Record<WorkItemState, number>; total: number; next: { updated_at: string; id: string } | null;
  } {
    const counts = Object.fromEntries(STATES.map((st) => [st, 0])) as Record<WorkItemState, number>;
    const sc = this.scopeWhere(opts.scope);
    const filt: string[] = [sc.where], filtArgs: (string | number)[] = [...sc.args];
    const extra: string[] = [], extraArgs: (string | number)[] = [];
    for (const k of ['object', 'phase'] as const) if (typeof opts[k] === 'string') { extra.push(`${k} = ?`); extraArgs.push(opts[k]!); }
    // 按席位筛：给的是 seatId 就按 seat_id，否则按句柄（seat_id 为空的旧席位）
    if (typeof opts.seat === 'string') { extra.push("(seat_id = ? OR (seat_id = '' AND seat = ?))"); extraArgs.push(opts.seat, opts.seat); }
    // 按驾驶舱筛：只在视角里面收窄；驾驶舱不存在就是没有命中，不报错
    if (typeof opts.cockpit === 'number') { extra.push('cockpit_id = ?'); extraArgs.push(opts.cockpit); }
    // 计数：这个视角里、按 object、phase 筛过（不按 state 筛）之后按状态分组
    for (const r of db.prepare(`SELECT state, COUNT(*) AS n FROM work_items WHERE ${[...filt, ...extra].join(' AND ')} GROUP BY state`).all(...filtArgs, ...extraArgs) as { state: WorkItemState; n: number }[]) {
      if (r.state in counts) counts[r.state] = Number(r.n);
    }
    const page = [...filt, ...extra], pageArgs: (string | number)[] = [...filtArgs, ...extraArgs];
    if (typeof opts.state === 'string') { page.push('state = ?'); pageArgs.push(opts.state); }
    if (opts.after) { page.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); pageArgs.push(opts.after.updated_at, opts.after.updated_at, opts.after.id); }
    const rows = db.prepare(`SELECT * FROM work_items WHERE ${page.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...pageArgs, opts.limit + 1) as WorkItemRow[];
    const more = rows.length > opts.limit;
    // 「我安排的」再按同一个判断函数过一遍（SQL 那一道之外的纵深）
    const scope = opts.scope;
    const visible = rows.slice(0, opts.limit).filter((w) => scope.kind !== 'mine' || isCreator(w, scope.principal));
    const last = new Map<string, WorkItemLogRow>();
    if (visible.length) {
      const ids = visible.map((w) => w.id);
      const logs = db.prepare(`SELECT * FROM work_item_log WHERE seq IN (SELECT MAX(seq) FROM work_item_log WHERE item_id IN (${ids.map(() => '?').join(', ')}) GROUP BY item_id)`).all(...ids) as WorkItemLogRow[];
      for (const l of logs) last.set(l.item_id, l);
    }
    const items = visible.map((w) => {
      const l = last.get(w.id);
      return { ...w, last_log: l ? { actor: l.actor, fact: l.fact, text: logText(l), at: l.at } : null };
    });
    const tail = rows[opts.limit - 1];
    return { items, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), next: more && tail ? { updated_at: tail.updated_at, id: tail.id } : null };
  }

  /**
   * 这些任务中心任务里，哪些已经有对应的事项（任务发布时记的事件建出了事项）。「关注」聚合统一待办时剔掉它们：
   * 同一件事在「等你拍板」里只出现一次，以事项为准（事项的过目、验收是它的入口）。
   */
  taskIdsWithItems(taskIds: number[]): Set<number> {
    if (!taskIds.length) return new Set();
    const rows = db.prepare(`SELECT e.item AS item FROM workbench_events e JOIN work_items w ON w.event_id = e.id
      WHERE e.source = 'task-center' AND e.item IN (${taskIds.map(() => '?').join(', ')})`).all(...taskIds.map((n) => `task:${n}`)) as { item: string }[];
    return new Set(rows.map((r) => Number(r.item.slice(5))));
  }

  /** 唯一的改状态入口。 */
  apply(itemId: string, fact: Fact): ApplyResult {
    if (factProblem(fact)) return { ok: false, reason: 'bad_fact' };
    // 被拒的（not_allowed、terminal）也写了一行留痕，要提交；形式不对的、重复的什么都没写
    return inTx(() => this.applyLocked(itemId, normalize(fact)), (out) => (!out.duplicate && (out.ok || out.reason === 'not_allowed' || out.reason === 'terminal')) || (out.ok && out.seatFilled === true));
  }

  private applyLocked(itemId: string, fact: Fact): ApplyResult {
    const item = db.prepare('SELECT state, open_asks FROM work_items WHERE id = ?').get(itemId) as { state: WorkItemState; open_asks: string } | undefined;
    if (!item) return { ok: false, reason: 'unknown_item' };
    const seen = db.prepare('SELECT from_state, to_state, rejected FROM work_item_log WHERE item_id = ? AND fact_source = ? AND fact_id = ?')
      .get(itemId, fact.source, fact.id) as { from_state: WorkItemState; to_state: WorkItemState; rejected: '' | 'not_allowed' | 'terminal' } | undefined;
    // 同一条事实再来：照第一次的结果答（第一次被拒的，还是被拒），不再写
    if (seen?.rejected) return { ok: false, reason: seen.rejected, state: item.state, duplicate: true };
    if (seen) {
      // 回填按版本号从头再核时，存量里已经应用过的事实照第一次的结果答；承接席位是后来才从事实里取的，这里补上
      // （只是显示用的一列）。走到这里的是已经应用过的历史事实——回填按事件日志顺序重放——所以不分终态，最后一条取得到席位的为准，
      // 不先写先占；终态之后才到的新回执走的是只记录那条路，那里照旧不改承接——所以第一次应用时事项已经是终态的（from_state 是终态），
      // 重放时也不改承接，和实时一致
      const seatChanged = typeof fact.seat === 'string' && fact.seat !== '' && !TERMINAL.includes(seen.from_state)
        && Number(db.prepare('UPDATE work_items SET seat = ? WHERE id = ? AND seat <> ?').run(fact.seat, itemId, fact.seat).changes) === 1;
      // 产物也一样：后来才从事实里取的，回填再核时补上（终态之后也补：产物是事实）
      const outputsChanged = this.mergeOutputs(itemId, fact.artifacts);
      const seatFilled = seatChanged || outputsChanged;
      return { ok: true, state: item.state, from: seen.from_state, duplicate: true, ...(seatFilled ? { seatFilled: true } : {}) };
    }

    // 只记录的事实：查第二张表。终态之后只有回执能走到这里。
    const record = RECORDS.find((r) => r.fact === fact.kind && r.from.includes(item.state) && r.when(fact));
    if (record) return this.recordLocked(itemId, item, fact);
    if (TERMINAL.includes(item.state)) return this.rejectLocked(itemId, item.state, fact, 'terminal');
    const to = nextState(item.state, fact);
    if (!to) return this.rejectLocked(itemId, item.state, fact, 'not_allowed');

    const { kind, source, id, actor, ...detail } = fact;
    this.writeLog(itemId, fact, item.state, to, detail);
    const set: string[] = ['state = ?', "updated_at = datetime('now')"], args: (string | number | null)[] = [to];
    if (kind === 'eval') { set.push('eval = ?', 'eval_reason = ?'); args.push(fact.verdict ?? '', fact.reason ?? ''); }
    if (typeof fact.seat === 'string' && fact.seat !== '') { set.push('seat = ?'); args.push(fact.seat); }
    this.mergeOutputs(itemId, fact.artifacts);
    if (kind === 'report' && typeof fact.summary === 'string') { set.push('progress_summary = ?', "progress_at = datetime('now')"); args.push(fact.summary); }
    if (kind === 'ask') { const asks = JSON.parse(item.open_asks || '[]'); asks.push({ id, source, question: fact.question ?? '' }); set.push('open_asks = ?'); args.push(JSON.stringify(asks)); }
    const receipt = kind === 'receipt' ? fact.outcome : fact.receipt?.outcome;
    if (typeof receipt === 'string' && receipt !== '') { set.push('receipt_outcome = ?', "receipt_at = datetime('now')"); args.push(receipt); }
    db.prepare(`UPDATE work_items SET ${set.join(', ')} WHERE id = ?`).run(...args, itemId);
    return { ok: true, state: to, from: item.state, duplicate: false };
  }

  /**
   * 被拒的事实也留痕（规格 f8d07a9）：状态不动，记一行 from = to「收到，未采信」，带原因。
   * 按事实自己的（来源、id）写，所以同一条再来时按去重答第一次的结果，不会每次同步都重试一遍。
   */
  private rejectLocked(itemId: string, state: WorkItemState, fact: Fact, reason: 'not_allowed' | 'terminal'): ApplyResult {
    const { kind, source, id, actor, ...detail } = fact;
    this.writeLog(itemId, fact, state, state, { ...detail, note: '收到，未采信' }, reason);
    return { ok: false, reason, state };
  }

  /** rejected 只由事项服务自己给；调用方事实里夹的同名字段从 detail 里剥掉，不进日志 */
  private writeLog(itemId: string, fact: Fact, from: WorkItemState, to: WorkItemState, detail: object, rejected: '' | 'not_allowed' | 'terminal' = ''): void {
    const { rejected: _drop, ...clean } = detail as Record<string, unknown>;
    db.prepare(`INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, actor, detail, rejected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, fact.kind, fact.source, fact.id, from, to, fact.actor ?? '', JSON.stringify(clean), rejected);
  }

  /** 把产物并进 outputs：按 kind+id 去重、保持先后、最多 OUTPUTS_MAX 项；改到了返回 true */
  private mergeOutputs(itemId: string, artifacts: { kind: string; id: string }[] | undefined): boolean {
    if (!artifacts || artifacts.length === 0) return false;
    const row = db.prepare('SELECT outputs FROM work_items WHERE id = ?').get(itemId) as { outputs: string } | undefined;
    let cur: unknown = [];
    try { cur = JSON.parse(row?.outputs || '[]'); } catch { cur = []; }
    const before = cleanArtifacts(cur);
    const merged = cleanArtifacts([...before, ...artifacts]);
    if (merged.length === before.length) return false;
    db.prepare('UPDATE work_items SET outputs = ? WHERE id = ?').run(JSON.stringify(merged), itemId);
    return true;
  }

  /** 只记录、不改状态：写一行 from = to 的日志，更新摘要字段。 */
  private recordLocked(itemId: string, item: { state: WorkItemState; open_asks: string }, fact: Fact): ApplyResult {
    const { kind, source, id, actor, ...detail } = fact;
    if (kind === 'answer') {
      const askId = String(fact.ask_id); // RECORDS 那一行已要求它是非空字符串
      // 被拒的提问、被拒的答复都留了一行（rejected 列不空），不算问过、不算答过
      const asked = db.prepare("SELECT 1 FROM work_item_log WHERE item_id = ? AND fact = 'ask' AND fact_id = ? AND rejected = ''").get(itemId, askId);
      if (!asked) return this.rejectLocked(itemId, item.state, fact, 'not_allowed');
      const first = db.prepare("SELECT from_state FROM work_item_log WHERE item_id = ? AND fact = 'answer' AND json_extract(detail, '$.ask_id') = ? AND rejected = '' ORDER BY seq LIMIT 1")
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
    // 承接席位：进展、只记录的回执带了 by 也更新（成员换人时）；终态之后晚到的不改
    if (!late && typeof fact.seat === 'string' && fact.seat !== '') db.prepare('UPDATE work_items SET seat = ? WHERE id = ?').run(fact.seat, itemId);
    this.mergeOutputs(itemId, fact.artifacts);
    return { ok: true, state: item.state, from: item.state, duplicate: false, recorded: true, late };
  }
}
