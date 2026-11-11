#!/usr/bin/env node
/**
 * 事项服务的单测（阶段八 8a）：状态机、事项日志只增不改、终态、去重。
 * 进程内，开一个临时数据目录里的库；不起服务，不访问任何外部系统。
 *
 * 期望值是对着规格（产品化文档 02 第三节，加上附录 8a 补定的三处）手抄的一张表，不取服务里的迁移表——服务抄错一行，这里就对不上。
 * 每个非终态 × 每种事实都试一遍：表里有的必须到对的状态，表里没有的必须被拒、状态和日志都不动。
 *
 *   node scripts/work-item-service-test.mjs              测本仓库
 *   node scripts/work-item-service-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-service-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e?.message ?? e) || 'threw'; } };

const NON_TERMINAL = ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked'];
const TERMINAL = ['done', 'failed', 'dropped', 'cancelled'];

/** 事实的各种写法。名字只用来出报告。 */
const VARIANTS = {
  'submit·开关没全开': { kind: 'submit', dispatch_open: false },
  'submit·开关全开': { kind: 'submit', dispatch_open: true },
  'submit·没说开关': { kind: 'submit' },
  release: { kind: 'release', actor: 'user:admin' },
  withdraw: { kind: 'withdraw', actor: 'user:alice' },
  'delivery·dead': { kind: 'delivery', outcome: 'dead' },
  'delivery·delivered': { kind: 'delivery', outcome: 'delivered' },
  'eval·accept': { kind: 'eval', verdict: 'accept' },
  'eval·stop 带理由': { kind: 'eval', verdict: 'stop', reason: '超出范围' },
  'eval·ignore 带理由': { kind: 'eval', verdict: 'ignore', reason: '重复' },
  'eval·unavailable 带理由': { kind: 'eval', verdict: 'unavailable', reason: '席位离线' },
  'eval·stop 没理由': { kind: 'eval', verdict: 'stop' },
  'eval·stop 理由是空白': { kind: 'eval', verdict: 'stop', reason: '  ' },
  'eval·写错的判断': { kind: 'eval', verdict: 'maybe', reason: 'x' },
  'report·progress': { kind: 'report', status: 'progress', summary: '做了一半' },
  'report·waiting': { kind: 'report', status: 'waiting' },
  'report·blocked': { kind: 'report', status: 'blocked' },
  'report·ready': { kind: 'report', status: 'ready' },
  'report·failed': { kind: 'report', status: 'failed' },
  'report·dropped 带回执': { kind: 'report', status: 'dropped', receipt: { outcome: 'dropped' } },
  'report·dropped 没回执': { kind: 'report', status: 'dropped' },
  'report·done（席位不能自己说做完）': { kind: 'report', status: 'done' },
  ask: { kind: 'ask', question: '要哪个店铺？' },
  'receipt·failed': { kind: 'receipt', outcome: 'failed' },
  'receipt·done': { kind: 'receipt', outcome: 'done' },
  verify: { kind: 'verify', actor: 'user:alice' },
  return: { kind: 'return', actor: 'user:alice' },
  'answer·没带 ask_id': { kind: 'answer', answer: '店铺 A' },
  // 8b 补的写法
  'withdraw·一次都没发出去': { kind: 'withdraw', none_sent: true },
  'eval·stop 带理由·还有别的投递活着': { kind: 'eval', verdict: 'stop', reason: '不接', others_alive: true },
  'delivery·dead·还有别的投递活着': { kind: 'delivery', outcome: 'dead', others_alive: true },
  'note·未路由': { kind: 'note', note: 'unrouted' },
  'note·未采信': { kind: 'note', note: 'untrusted' },
  'note·写错的备注': { kind: 'note', note: 'whatever' },
  'answer·答一条没问过的提问': { kind: 'answer', ask_id: 'no-such-ask', answer: '店铺 A' },
};

/** 规格第三节的表，手抄：事实写法 → { 从哪些状态: 到哪个状态 } */
const ALL = Object.fromEntries(NON_TERMINAL.map((s) => [s, null]));
const to = (target, ...from) => Object.fromEntries(from.map((s) => [s, target]));
const SPEC = {
  'submit·开关没全开': to('held', 'draft'),
  'submit·开关全开': to('delivered', 'draft', 'held'),
  release: to('delivered', 'draft', 'held'),
  withdraw: to('cancelled', 'draft', 'held'),
  // 8b 实现时补定：排了队、一次都没发出去就撤回
  'withdraw·一次都没发出去': to('cancelled', 'draft', 'held', 'delivered'),
  'delivery·dead': to('failed', 'delivered'),
  // 附录 8b：先问后接
  'eval·accept': to('accepted', 'delivered', 'blocked'),
  // 8b 复验补：先问后拒
  'eval·stop 带理由': to('failed', 'delivered', 'blocked'),
  'eval·stop 带理由·还有别的投递活着': {},
  'eval·ignore 带理由': to('failed', 'delivered', 'blocked'),
  'eval·unavailable 带理由': to('failed', 'delivered', 'blocked'),
  // 附录 8a 补定：原地重复的上报（progress→progress、waiting→waiting、blocked 时又来提问）算合法
  'report·progress': to('progress', 'accepted', 'waiting', 'blocked', 'progress'),
  'report·waiting': to('waiting', 'accepted', 'progress', 'waiting'),
  'report·blocked': to('blocked', 'accepted', 'progress', 'waiting'),
  // 附录 8b：接单前就可以提问
  ask: to('blocked', 'delivered', 'accepted', 'progress', 'waiting', 'blocked'),
  'report·ready': to('ready', 'progress', 'waiting', 'blocked'),
  verify: to('done', 'ready'),
  return: to('progress', 'ready'),
  'report·failed': Object.fromEntries(Object.keys(ALL).map((s) => [s, 'failed'])),
  'receipt·failed': Object.fromEntries(Object.keys(ALL).map((s) => [s, 'failed'])),
  'report·dropped 带回执': Object.fromEntries(Object.keys(ALL).map((s) => [s, 'dropped'])),
};

/** 附录 8a 补定的「只记录」：状态不变、记一行日志。回执（outcome 不是 failed）在 ready 和任一终态都接受，终态之后的标「晚到」。
 *  answer 要答一条真问过的提问，单独在第四节之后测。 */
const AFTER_ACCEPT = ['accepted', 'progress', 'waiting', 'ready'];
const RECORD = {
  'receipt·done': ['ready', 'done', 'failed', 'dropped', 'cancelled'],
  // 附录 8b：一个事件投给多个团队——已有团队接手之后别的团队的决定、别的投递 dead；还有别的投递活着时的拒接和 dead
  'eval·accept': AFTER_ACCEPT, 'eval·stop 带理由': AFTER_ACCEPT, 'eval·ignore 带理由': AFTER_ACCEPT, 'eval·unavailable 带理由': AFTER_ACCEPT,
  'eval·stop 没理由': AFTER_ACCEPT, 'eval·stop 理由是空白': AFTER_ACCEPT,
  'eval·stop 带理由·还有别的投递活着': ['delivered', 'blocked', ...AFTER_ACCEPT],
  'delivery·dead': ['accepted', 'progress', 'waiting', 'blocked', 'ready'],
  'delivery·dead·还有别的投递活着': ['delivered', 'accepted', 'progress', 'waiting', 'blocked', 'ready'],
  // 附录 8b：未路由、收到但未采信
  'note·未路由': ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked'],
  'note·未采信': ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'ready', 'blocked'],
};

/** 走到某个状态的合法路径（每步都是表里的一行） */
const PATH = {
  draft: [],
  held: ['submit·开关没全开'],
  delivered: ['submit·开关全开'],
  accepted: ['submit·开关全开', 'eval·accept'],
  progress: ['submit·开关全开', 'eval·accept', 'report·progress'],
  waiting: ['submit·开关全开', 'eval·accept', 'report·waiting'],
  blocked: ['submit·开关全开', 'eval·accept', 'report·blocked'],
  ready: ['submit·开关全开', 'eval·accept', 'report·progress', 'report·ready'],
  done: ['submit·开关全开', 'eval·accept', 'report·progress', 'report·ready', 'verify'],
  failed: ['submit·开关全开', 'delivery·dead'],
  dropped: ['submit·开关全开', 'eval·accept', 'report·dropped 带回执'],
  cancelled: ['withdraw'],
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { db } = await import(at('server/src/db.ts'));
  const { root } = await import(at('server/src/root-context.ts'));
  const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
  await root.plugin(WorkItemService);
  const items = root.get('workItems');
  check(Boolean(items), '事项服务装上之后能按名字 workItems 取到');

  let seq = 0;
  const fact = (name, extra = {}) => ({ ...VARIANTS[name], source: 'test', id: `f${++seq}`, ...extra });
  const fresh = (patch = {}) => items.create({ title: '一件事', created_by: 'user:alice', source_kind: 'task-center', source_ref: `t${++seq}`, ...patch });
  const reach = (state) => {
    const it = fresh();
    for (const step of PATH[state]) {
      const r = items.apply(it.id, fact(step));
      if (!r.ok) throw new Error(`走到 ${state} 时 ${step} 被拒：${show(r)}`);
    }
    if (items.get(it.id).state !== state) throw new Error(`没走到 ${state}`);
    return it.id;
  };
  const logCount = (id) => items.log(id).length;
  /** 按 f8d07a9：形式良好但被拒的事实留一行 from = to 的日志，原因记在单独的 rejected 列（不在调用方能写的 detail 里）；同一条再送一次，不再多一行。返回不对的地方（空串 = 对） */
  const rejectedOnce = (id, f, r, state, before, reason) => {
    const last = items.log(id).at(-1), d = JSON.parse(last.detail);
    if (!(r.ok === false && r.reason === reason && items.get(id).state === state && logCount(id) === before + 1 && last.fact === f.kind && last.fact_id === f.id && last.from_state === state && last.to_state === state && last.rejected === reason && d.rejected === undefined))
      return `应被拒（${reason}）并留一行，得到 ${show(r)}，日志 ${before} → ${logCount(id)}，最后一行 ${show(last)}`;
    const again = items.apply(id, { ...f });
    if (!(again.ok === false && again.reason === reason && again.duplicate && logCount(id) === before + 1 && items.get(id).state === state)) return `被拒的那条再送一次，不该再多一行：${show(again)}，日志 ${logCount(id)}`;
    return '';
  };

  // ---------- 一、新建 ----------
  {
    const it = fresh({ context: { shop: 's1' }, object: 'obj-1', phase: 'ph-a' });
    const log = items.log(it.id);
    check(it.state === 'draft' && log.length === 1 && log[0].fact === 'create' && log[0].to_state === 'draft', '新建的事项从 draft 开始，第一行日志是「建立」', show({ state: it.state, log }));
    check(/标题/.test(throws(() => items.create({ title: '', created_by: 'user:a', source_kind: 'agent' }))), '没有标题建不出来');
    check(/主体标识/.test(throws(() => items.create({ title: 't', created_by: 'alice', source_kind: 'agent' }))), 'created_by 不是主体标识建不出来');
    check(/来源类别/.test(throws(() => items.create({ title: 't', created_by: 'user:a', source_kind: 'email' }))), '来源类别不在四种之内建不出来');
  }

  // ---------- 二、状态机：每个非终态 × 每种事实 ----------
  {
    const wrong = [];
    let allowed = 0, refused = 0, recorded = 0;
    for (const state of NON_TERMINAL) {
      for (const name of Object.keys(VARIANTS)) {
        const id = reach(state);
        const before = logCount(id);
        const expect = SPEC[name]?.[state] ?? null;
        const sent = fact(name);
        const r = items.apply(id, sent);
        const now = items.get(id).state, after = logCount(id);
        if (RECORD[name]?.includes(state)) {
          recorded++;
          const last = items.log(id).at(-1);
          if (!(r.ok && r.recorded && !r.late && now === state && after === before + 1 && last.from_state === state && last.to_state === state && !JSON.parse(last.detail).late))
            wrong.push(`${state} + ${name}：应只记录、不改状态，得到 ${show(r)}，表里是 ${now}，日志 ${before} → ${after}`);
        } else if (expect) {
          allowed++;
          const last = items.log(id).at(-1);
          if (!(r.ok && r.state === expect && now === expect && after === before + 1 && last.from_state === state && last.to_state === expect && last.fact === VARIANTS[name].kind))
            wrong.push(`${state} + ${name}：应到 ${expect}，得到 ${show(r)}，表里是 ${now}，日志 ${before} → ${after}`);
        } else {
          refused++;
          const bad = rejectedOnce(id, sent, r, state, before, 'not_allowed');
          if (bad) wrong.push(`${state} + ${name}：表里没有，${bad}`);
        }
      }
    }
    check(wrong.length === 0, `第三节的表（含补定的原地行）逐行做正例（${allowed} 例到了对的状态、各写一行日志），只记录的事实 ${recorded} 例状态不变、记一行，表外的迁移逐个做反例（${refused} 例被拒：状态不动，按 f8d07a9 留一行「收到，未采信」带原因，再送一次不再多一行）`, wrong.slice(0, 6).join('；'));
  }

  // ---------- 三、终态之后不再接受任何事实 ----------
  {
    const wrong = [];
    let lateOk = 0;
    for (const state of TERMINAL) {
      for (const name of Object.keys(VARIANTS)) {
        const id = reach(state);
        const before = logCount(id);
        const sent = fact(name);
        const r = items.apply(id, sent);
        if (RECORD[name]?.includes(state)) {
          const last = items.log(id).at(-1);
          if (!(r.ok && r.recorded && r.late && items.get(id).state === state && logCount(id) === before + 1 && last.to_state === state && JSON.parse(last.detail).late === true)) wrong.push(`${state} + ${name}：应作为晚到的回执记一行，得到 ${show(r)}`);
          else lateOk++;
        } else { const bad = rejectedOnce(id, sent, r, state, before, 'terminal'); if (bad) wrong.push(`${state} + ${name}：${bad}`); }
      }
    }
    check(wrong.length === 0, `四个终态 × ${Object.keys(VARIANTS).length} 种事实：只有不是 failed 的回执能进来（${lateOk} 例，日志标「晚到」、状态不变），其余全部被拒：状态不动，日志留一行带原因 terminal，再送一次不再多一行`, wrong.slice(0, 6).join('；'));
  }

  // ---------- 四、同一条事实送两次 ----------
  {
    const id = reach('accepted');
    const f = fact('report·progress');
    const a = items.apply(id, f), n1 = logCount(id);
    const b = items.apply(id, { ...f });
    check(a.ok && !a.duplicate && b.ok && b.duplicate && b.state === 'progress' && logCount(id) === n1, '同一条事实（来源和 id 都相同）送两次：状态和日志都只变一次', show({ a, b }));
    items.apply(id, fact('report·waiting'));
    const late = items.apply(id, { ...f });
    check(late.ok && late.duplicate && items.get(id).state === 'waiting', '状态往前走了之后，晚到的重复事实不把状态往回拉', show(late));
    const other = items.apply(id, { ...f, source: 'other-source' });
    check(other.ok && !other.duplicate && other.state === 'progress', '对照：id 相同但来源不同，是另一条事实', show(other));
    const term = reach('done'), dupLog = items.log(term).at(-1);
    const again = items.apply(term, { kind: 'verify', source: dupLog.fact_source, id: dupLog.fact_id });
    check(again.ok && again.duplicate && items.get(term).state === 'done', '终态之后再送一遍进终态的那条事实：按重复返回，不报拒绝', show(again));
    check(/UNIQUE|只增不改/i.test(throws(() => db.prepare("INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state) VALUES (?, 'report', 'test', ?, 'progress', 'progress')").run(id, f.id))), '库这一层也拦着：同一条事实写不进第二行');
    // 阶段七：承接席位是后来才从事实里取的——回填按新版本号从头再核时，已应用过的事实（第一次没带 seat）再来带了 seat，要补上
    const sid = reach('accepted');
    const noted = { kind: 'note', note: 'progress', source: 'seat-test', id: 'p1', text: '在做' };
    items.apply(sid, noted);
    const n2 = logCount(sid);
    const again2 = items.apply(sid, { ...noted, seat: '成员甲 · lab/a1b2c3d4' });
    check(again2.duplicate && items.get(sid).seat === '成员甲 · lab/a1b2c3d4' && logCount(sid) === n2, '同一条事实再来、这次带了承接席位：补上 seat，日志不加行', show({ again2, seat: items.get(sid).seat }));
    const doneId = reach('done'), dl = items.log(doneId).at(-1);
    items.apply(doneId, { kind: dl.fact, source: dl.fact_source, id: dl.fact_id, seat: '成员甲 · lab/a1b2c3d4' });
    check(items.get(doneId).seat === '成员甲 · lab/a1b2c3d4', '终态事项承接还空着：回填再核时同一条事实带 seat 来，补上', show(items.get(doneId).seat));
    items.apply(doneId, { kind: dl.fact, source: dl.fact_source, id: dl.fact_id, seat: 'lab/ffffffff' });
    check(items.get(doneId).seat === 'lab/ffffffff', '回填重放历史事实：按顺序最后一条为准，不先写先占（终态事项也一样）', show(items.get(doneId).seat));
    // 对照：终态之后才到的新回执（只记录那条路）不改承接
    items.apply(doneId, { kind: 'receipt', source: 'seat-test', id: 'late-1', outcome: 'completed', seat: 'lab/99999999' });
    check(items.get(doneId).seat === 'lab/ffffffff', '对照：终态之后才到的新回执不改承接', show(items.get(doneId).seat));
  }

  // ---------- 四·补、答复（只记录）：答一条真问过、还没答过的提问 ----------
  {
    const id = reach('accepted');
    const askF = fact('ask');
    items.apply(id, askF);
    const before = logCount(id);
    const ans = items.apply(id, fact('answer·答一条没问过的提问', { ask_id: askF.id, actor: 'user:alice' }));
    const row = items.get(id), last = items.log(id).at(-1);
    check(ans.ok && ans.recorded && !ans.duplicate && row.state === 'blocked' && logCount(id) === before + 1 && last.fact === 'answer' && last.from_state === 'blocked' && last.to_state === 'blocked' && JSON.parse(row.open_asks).length === 0,
      '答一条真问过的提问：状态不变，记一行日志，从未答列表里拿掉', show({ ans, state: row.state, open_asks: row.open_asks }));
    const n = logCount(id);
    const again = items.apply(id, fact('answer·答一条没问过的提问', { ask_id: askF.id, actor: 'user:bob', answer: '店铺 B' }));
    check(again.ok && again.duplicate && again.recorded && logCount(id) === n, '同一条提问再答一次（换一个人、换一个答案）：返回第一次的结果，不再记', show(again));
    const stranger = reach('accepted'), other = fact('ask'); items.apply(stranger, other);
    const crossF = fact('answer·答一条没问过的提问', { ask_id: other.id });
    const cross = items.apply(id, crossF);
    const crossBad = rejectedOnce(id, crossF, cross, 'blocked', n, 'not_allowed');
    check(crossBad === '', '答的是别的事项的提问：拒绝，留一行被拒记录', crossBad);
    const notAsk = items.apply(id, fact('answer·答一条没问过的提问', { ask_id: items.log(id).find((l) => l.fact === 'eval').fact_id }));
    check(notAsk.ok === false && notAsk.reason === 'not_allowed', '答的 id 是一条事实、但不是提问：拒绝', show(notAsk));
    const h = reach('held'), hAsk = fact('ask');
    items.apply(h, hAsk);
    const hN = logCount(h), hAnsF = fact('answer·答一条没问过的提问', { ask_id: hAsk.id });
    const hAns = items.apply(h, hAnsF);
    const hBad = rejectedOnce(h, hAnsF, hAns, 'held', hN, 'not_allowed');
    check(hBad === '', '答一条被拒的提问（held 时来的 ask 被拒、只留了一行被拒记录）：不算问过，答复也被拒', hBad);
    const t = reach('blocked'), tAsk = fact('ask'); items.apply(t, tAsk); items.apply(t, fact('report·failed'));
    const lateF = fact('answer·答一条没问过的提问', { ask_id: tAsk.id }), lateN = logCount(t);
    const late = items.apply(t, lateF);
    check(rejectedOnce(t, lateF, late, 'failed', lateN, 'terminal') === '' && JSON.parse(items.get(t).open_asks).length === 1, '终态之后答提问：拒绝（终态之后只开回执这一个口子）', show(late));
    const dropped = reach('accepted');
    items.apply(dropped, fact('report·dropped 带回执', { receipt: { outcome: 'x' } }));
    const atDrop = items.get(dropped);
    const lateDone = items.apply(dropped, fact('receipt·done'));
    const afterLate = items.get(dropped);
    check(lateDone.ok && lateDone.late && afterLate.receipt_outcome === 'x' && afterLate.receipt_at === atDrop.receipt_at && items.log(dropped).at(-1).fact === 'receipt',
      '晚到的回执只写日志，不覆盖终态时记下的回执摘要', show({ lateDone, before: atDrop.receipt_outcome, after: afterLate.receipt_outcome }));
    const failedNoReceipt = reach('delivered');
    items.apply(failedNoReceipt, fact('delivery·dead'));
    items.apply(failedNoReceipt, fact('receipt·done'));
    check(items.get(failedNoReceipt).receipt_outcome === 'done', '对照：终态时还没有回执摘要，晚到的回执填上');
    const ready = reach('ready');
    const failedReceipt = items.apply(ready, fact('receipt·failed'));
    const lateFailed = items.apply(ready, fact('receipt·failed'));
    check(failedReceipt.ok && failedReceipt.state === 'failed' && lateFailed.ok === false && lateFailed.reason === 'terminal', '对照：outcome=failed 的回执在 ready 是迁移（到 failed），终态之后再来被拒', show({ failedReceipt, lateFailed }));
  }

  // ---------- 五、事项日志只增不改（库这一层） ----------
  {
    const id = reach('progress');
    const rows = items.log(id);
    check(/只增不改/.test(throws(() => db.prepare("UPDATE work_item_log SET to_state = 'done' WHERE seq = ?").run(rows.at(-1).seq))), '改写日志的一行：被库拒绝');
    check(/只增不改/.test(throws(() => db.prepare("UPDATE work_item_log SET detail = '{}' WHERE item_id = ?").run(id))), '改写日志的任何一列：被库拒绝');
    check(/只增不改/.test(throws(() => db.prepare('DELETE FROM work_item_log WHERE seq = ?').run(rows[0].seq))), '删除日志的一行：被库拒绝');
    check(/只增不改/.test(throws(() => db.exec('DELETE FROM work_item_log'))), '清空日志：被库拒绝');
    const victim = rows.at(-1);
    check(/只增不改/.test(throws(() => db.prepare("INSERT OR REPLACE INTO work_item_log (seq, item_id, fact, fact_source, fact_id, from_state, to_state) VALUES (?, ?, 'verify', 'forged', 'z1', 'progress', 'done')").run(victim.seq, id))), '用已有的 seq 做 INSERT OR REPLACE 改写日志：被库拒绝');
    check(/只增不改/.test(throws(() => db.prepare("INSERT OR REPLACE INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state) VALUES (?, 'verify', ?, ?, 'progress', 'done')").run(id, victim.fact_source, victim.fact_id))), '用已有的（事项、来源、id）做 INSERT OR REPLACE 改写日志：被库拒绝');
    check(/只增不改/.test(throws(() => db.prepare("REPLACE INTO work_item_log (seq, item_id, fact, fact_source, fact_id, from_state, to_state) VALUES (?, ?, 'verify', 'forged', 'z2', 'progress', 'done')").run(victim.seq, id))), '用 REPLACE 改写日志：被库拒绝');
    check(show(items.log(id)) === show(rows), '被拒之后日志原样');
  }

  // ---------- 六、没有「直接设状态」的口子 ----------
  {
    const id = reach('progress');
    check(/只能经事项服务推进/.test(throws(() => db.prepare("UPDATE work_items SET state = 'done' WHERE id = ?").run(id))), '绕过服务直接改 state：被库拒绝');
    check(items.get(id).state === 'progress', '被拒之后状态原样');
    check(throws(() => db.prepare("UPDATE work_items SET title = '改个标题' WHERE id = ?").run(id)) === '', '对照：改别的列不受影响');
    check(/draft/.test(throws(() => db.prepare("INSERT INTO work_items (id, title, created_by, source_kind, state) VALUES ('wi_x', 't', 'user:a', 'agent', 'done')").run())), '直接插一条不是 draft 的事项：被库拒绝');
    check(/不删除/.test(throws(() => db.prepare('DELETE FROM work_items WHERE id = ?').run(id))), '删除事项：被库拒绝');
    check(/不删除/.test(throws(() => db.prepare("INSERT OR REPLACE INTO work_items (id, title, created_by, source_kind) VALUES (?, '重置', 'user:x', 'agent')").run(id))) && items.get(id).state === 'progress', '用已有 id 做 INSERT OR REPLACE 把事项重置成 draft：被库拒绝');
    const other = fresh();
    check(/不删除/.test(throws(() => db.prepare('UPDATE OR REPLACE work_items SET id = ? WHERE id = ?').run(id, other.id))) && items.get(id)?.state === 'progress' && items.get(other.id), '改 id 撞上另一个事项（UPDATE OR REPLACE 会顶掉它）：被库拒绝');
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(items)).filter((m) => /state/i.test(m) && m !== 'constructor');
    check(methods.length === 0, '服务上没有带 state 字样的方法（唯一的改状态入口是 apply）', show(methods));
  }

  // ---------- 六·补、调用方伪造被拒标记（8b 验收提的加固）----------
  {
    const id = reach('accepted');
    const forged = fact('report·progress', { rejected: 'terminal', detail: { rejected: 'terminal' } });
    const r = items.apply(id, forged), last = items.log(id).at(-1);
    check(r.ok && r.state === 'progress' && last.rejected === '' && JSON.parse(last.detail).rejected === undefined, '事实里夹一个 rejected 字段：照常推进，日志的 rejected 列是空的，detail 里也不留这个键', show({ r, last }));
    const again = items.apply(id, { ...forged });
    check(again.ok === true && again.duplicate === true, '再送一次：按成功的重复答，不会被读成「第一次被拒」', show(again));
    const askF = fact('ask', { rejected: 'not_allowed' });
    items.apply(id, askF);
    const ans = items.apply(id, fact('answer·答一条没问过的提问', { ask_id: askF.id }));
    check(ans.ok && ans.recorded && !ans.duplicate, '提问里夹 rejected 字段：仍算问过，答复照常接受', show(ans));
    const real = reach('done'), rf = fact('report·progress');
    items.apply(real, rf);
    const back = items.apply(real, { ...rf, rejected: '' });
    check(back.ok === false && back.reason === 'terminal' && back.duplicate === true, '反过来：真被拒的那条，再送时夹 rejected 为空也改不了第一次的结果', show(back));
  }

  // ---------- 七、事实的形状 ----------
  {
    const id = reach('accepted');
    const before = logCount(id);
    const bad = [
      { kind: 'report', status: 'progress', id: 'x1' },
      { kind: 'report', status: 'progress', source: 'test' },
      { kind: 'report', status: 'progress', source: '', id: 'x2' },
      { kind: 'report', status: 'progress', source: 'test', id: '  ' },
      { kind: 'teleport', source: 'test', id: 'x3' },
      { kind: 'report', status: 'progress', source: 'test', id: 'x4', summary: 'x'.repeat(20000) },
      null,
    ];
    const leaked = bad.filter((f) => { const r = items.apply(id, f); return !(r.ok === false && r.reason === 'bad_fact'); });
    check(leaked.length === 0 && logCount(id) === before && items.get(id).state === 'accepted', `${bad.length} 种形状不对的事实：都被拒，不写日志`, show(leaked));
    check(items.apply('wi_nope', fact('release')).reason === 'unknown_item', '不存在的事项：拒绝');
  }

  // ---------- 八、摘要字段与对象、阶段 ----------
  {
    const id = reach('delivered');
    items.apply(id, fact('eval·stop 带理由'));
    const row = items.get(id);
    check(row.state === 'failed' && row.eval === 'stop' && row.eval_reason === '超出范围', '拒单：记下判断和理由', show(row));
    const id2 = reach('accepted');
    items.apply(id2, fact('ask'));
    items.apply(id2, fact('report·progress'));
    const r2 = items.get(id2);
    check(JSON.parse(r2.open_asks).length === 1 && JSON.parse(r2.open_asks)[0].question === '要哪个店铺？' && r2.progress_summary === '做了一半', '提问进未答列表，进展记最近一条摘要', show(r2));
    const id3 = reach('accepted');
    items.apply(id3, fact('report·dropped 带回执'));
    check(items.get(id3).receipt_outcome === 'dropped', 'dropped 带的回执记下来');
    const last = items.log(id3).at(-1);
    check(JSON.parse(last.detail).receipt?.outcome === 'dropped' && last.fact_source === 'test', '日志的 detail 原样留着事实的其余字段');
    fresh({ object: 'obj-9', phase: 'p1' }); fresh({ object: 'obj-9', phase: 'p2' }); fresh({ object: 'obj-8', phase: 'p1' });
    check(items.list({ object: 'obj-9' }).length === 2 && items.list({ object: 'obj-9', phase: 'p1' }).length === 1 && items.list({ phase: 'p1' }).length === 2, '按对象、阶段筛');
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
