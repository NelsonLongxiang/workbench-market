#!/usr/bin/env node
/**
 * 事项接上事实的单测（阶段八 8b）：workbench-events 的事件日志 → 事项。
 * 进程内，开一个临时数据目录里的库；不起服务，不访问任何外部系统。
 * 投递、决定端点走真实链路的那一段在 workbench-events-smoke.mjs 的 W14（起隔离实例 + 假对端）。
 *
 *   一、对照规格附录 8b 的映射：每种日志动作对到哪条事实
 *   二、一组录下来的场景：正放、打乱、重复各喂一遍，终态和事项日志相同；监听器漏一次，回填补上；只跑回填，结果和实时相同
 *   三、未验证来源的对抗例：不推进状态，只记「收到但未采信」
 *   四、回填跑两遍，两张表逐行相同
 *   五、真实的来源函数：同一个事务里建事项（来源回滚，事项也没有）；监听器出错不影响来源、计数、回填补上；撤回
 *
 *   node scripts/work-item-facts-test.mjs              测本仓库
 *   node scripts/work-item-facts-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-facts-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

/** 固定种子的洗牌：每次跑结果一样，出了问题能复现 */
function shuffled(list, seed) {
  const a = [...list];
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
process.env.MARKET_PUBLIC_URL ??= 'http://market.synthetic.invalid';
try {
  const { db } = await import(at('server/src/db.ts'));
  const { root } = await import(at('server/src/root-context.ts'));
  const events = await import(at('server/src/workbench-events.ts'));
  const { WorkItemService, factFromEventLog, itemIdForEvent } = await import(at('server/src/services/work-item.ts'));
  events.initWorkbenchEvents();
  // 存量：服务装上之前就有的事件（上线前的老数据）。装上时应当回填出事项
  const legacy = 'wbe-legacy0000000001';
  db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', 'task:0', 'wb:task-center:0', 'human', 'human:legacy', 1, ?, 1, 'default')").run(legacy, 'z'.repeat(64));
  const legacyDelivery = Number(db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, 'team-a', 'http://peer.synthetic.invalid', 'market/test', 'sent')").run(legacy).lastInsertRowid);
  for (const [d, action] of [[null, 'recorded'], [legacyDelivery, 'queued'], [legacyDelivery, 'sent'], [legacyDelivery, 'decision:accept']])
    db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(legacy, d, action);
  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); realError(...a); };
  const realLog = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[work-items]')) logged.push(a.join(' ')); realLog(...a); };
  await root.plugin(WorkItemService);
  const items = root.get('workItems');
  check(items.get('wi_' + legacy)?.state === 'accepted', '先有存量事件、再装服务：装上时回填出事项，追到「已接手」', show(items.get('wi_' + legacy)?.state));
  check(logged.some((l) => l.includes('[work-items] 回填') && l.includes('补建 1 个事项')), '装上时的回填在日志里留一行（补建了几个）', show(logged));
  const realOnLogged = items.onLogged.bind(items);
  const listen = (on) => { items.onLogged = on ? realOnLogged : () => {}; };

  // ---------- 来源表的写法（照 workbench-events.ts 的列）----------
  let n = 0;
  const newEventId = () => `wbe-${(++n).toString(16).padStart(16, '0')}`;
  function writeEvent({ eventId, kind = 'human', routed = 'default', source = 'task-center', teams = ['team-a', 'team-b'] }) {
    db.prepare('INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(eventId, source, 'task-center', `task:${n}`, `wb:task-center:${n}`, kind, kind === 'human' ? 'human:alice' : 'someone typed this', 1, 'x'.repeat(64), source === 'task-center' ? 1 : 0, routed);
    const ids = {};
    for (const t of routed === 'unrouted' ? [] : teams) {
      const info = db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, ?, 'http://peer.synthetic.invalid', 'market/test', 'held')").run(eventId, t);
      ids[t] = Number(info.lastInsertRowid);
    }
    return ids;
  }
  const writeLog = (eventId, deliveryId, actor, action, detail = {}) =>
    Number(db.prepare('INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)').run(eventId, deliveryId, actor, action, JSON.stringify(detail)).lastInsertRowid);
  const sourceRows = (eventId) => db.prepare('SELECT id, event_id, delivery_id, action FROM workbench_event_log WHERE event_id = ? ORDER BY id').all(eventId);
  const eventRow = (eventId) => db.prepare('SELECT * FROM workbench_events WHERE event_id = ?').get(eventId);

  // ---------- 一、映射 ----------
  {
    const ev = { event_id: 'wbe-map', submitter_kind: 'human' };
    const rows = [
      { id: 1, delivery_id: null, actor: 'market', action: 'recorded', detail: '{}' },
      { id: 2, delivery_id: 10, actor: 'market', action: 'queued', detail: '{}' },
      { id: 3, delivery_id: 11, actor: 'market', action: 'queued', detail: '{}' },
      { id: 4, delivery_id: 10, actor: 'market', action: 'retry', detail: '{}' },
      { id: 5, delivery_id: 10, actor: 'market', action: 'dead', detail: '{}' },
      { id: 6, delivery_id: 11, actor: 'market', action: 'sent', detail: '{}' },
      { id: 7, delivery_id: 11, actor: 'receiver', action: 'decision:decline', detail: '{"reason":"  "}' },
    ];
    const f = (i, e = ev, r = rows) => factFromEventLog(e, r, i);
    check(f(0) === null && f(3) === null && f(5) === null, 'recorded、retry、sent 不是事实（recorded 用来建事项）');
    check(f(1)?.kind === 'submit' && f(1).dispatch_open === true && f(1).id === '2' && f(1).source === 'workbench-events', 'queued → submit（开关全开），事实 id 是来源日志的 id', show(f(1)));
    check(f(4)?.kind === 'delivery' && f(4).outcome === 'dead' && f(4).others_alive === true, '一个投递 dead、另一个还在排队：others_alive', show(f(4)));
    check(f(6)?.kind === 'eval' && f(6).verdict === 'stop' && f(6).reason === '未写理由' && f(6).others_alive === false, '另一个已 dead、这个拒接：others_alive=false，理由是空白记「未写理由」', show(f(6)));
    const held = [{ id: 1, delivery_id: 10, actor: 'market', action: 'held', detail: '{}' }, { id: 2, delivery_id: 10, actor: 'human:admin', action: 'released', detail: '{}' }, { id: 3, delivery_id: 10, actor: 'human:x', action: 'cancelled', detail: '{}' }];
    check(f(0, ev, held)?.dispatch_open === false && f(1, ev, held)?.kind === 'release' && f(2, ev, held)?.kind === 'withdraw' && f(2, ev, held).none_sent === true, 'held → submit（开关没全开）；released → release；cancelled → withdraw（一次都没发出去）');
    const sentThenCancel = [{ id: 1, delivery_id: 10, actor: 'market', action: 'sent', detail: '{}' }, { id: 2, delivery_id: 11, actor: 'human:x', action: 'cancelled', detail: '{}' }];
    check(f(1, ev, sentThenCancel).none_sent === false, '有投递发出去过：撤回的 none_sent=false');
    const ask = [{ id: 1, delivery_id: 10, actor: 'receiver:bob', action: 'decision:ask', detail: '{"reason":"哪个店？"}' }];
    check(f(0, ev, ask)?.kind === 'ask' && f(0, ev, ask).question === '哪个店？' && f(0, ev, ask).actor === 'receiver:bob', 'decision:ask → ask，问题取理由，对方自报的名字只记在 actor');
    const un = { event_id: 'wbe-un', submitter_kind: 'unverified' };
    check(f(1, un)?.kind === 'note' && f(1, un).note === 'untrusted' && f(3, un) === null, '提交方未验证：本来是事实的只记「收到但未采信」，不是事实的照旧不记', show(f(1, un)));
  }

  // ---------- 二、录下来的场景 ----------
  /** 场景：每步 [动作, 团队, detail]。expect 是规格下的终态。 */
  const SCENARIOS = {
    '一个拒接一个接单 → 已接手': { steps: [['queued', 'team-a'], ['queued', 'team-b'], ['sent', 'team-a'], ['sent', 'team-b'], ['decision:decline', 'team-b'], ['decision:accept', 'team-a'], ['decision:decline', 'team-a']], expect: 'accepted' },
    '一个 dead 一个拒接 → 没办成': { steps: [['queued', 'team-a'], ['queued', 'team-b'], ['retry', 'team-a'], ['dead', 'team-a'], ['sent', 'team-b'], ['decision:decline', 'team-b', { reason: '不在范围' }]], expect: 'failed' },
    '搁置、放行、先问后接 → 已接手': { steps: [['held', 'team-a'], ['held', 'team-b'], ['released', 'team-a'], ['released', 'team-b'], ['sent', 'team-a'], ['sent', 'team-b'], ['decision:ask', 'team-a', { reason: '哪个店？' }], ['decision:accept', 'team-b']], expect: 'accepted' },
    '搁置后撤回 → 撤回': { steps: [['held', 'team-a'], ['held', 'team-b'], ['cancelled', 'team-a'], ['cancelled', 'team-b']], expect: 'cancelled' },
    '排队中没发出就撤回 → 撤回': { steps: [['queued', 'team-a'], ['queued', 'team-b'], ['cancelled', 'team-a'], ['cancelled', 'team-b']], expect: 'cancelled' },
    '接单后另一个 dead → 已接手': { steps: [['queued', 'team-a'], ['queued', 'team-b'], ['sent', 'team-a'], ['decision:accept', 'team-a'], ['dead', 'team-b']], expect: 'accepted' },
    '一个团队先提问再拒接 → 没办成': { steps: [['queued', 'team-a'], ['sent', 'team-a'], ['decision:ask', 'team-a', { reason: '哪个店？' }], ['decision:decline', 'team-a']], teams: ['team-a'], expect: 'failed' },
    '两个团队：一个提问、另一个拒接、提问的也拒接 → 没办成': { steps: [['queued', 'team-a'], ['queued', 'team-b'], ['sent', 'team-a'], ['sent', 'team-b'], ['decision:ask', 'team-a'], ['decision:decline', 'team-b'], ['decision:decline', 'team-a', { reason: '做不了' }]], expect: 'failed' },
    '只有提问 → 在问你': { steps: [['queued', 'team-a'], ['sent', 'team-a'], ['decision:ask', 'team-a']], teams: ['team-a'], expect: 'blocked' },
    '全部 dead → 没办成': { steps: [['queued', 'team-a'], ['queued', 'team-b'], ['dead', 'team-a'], ['dead', 'team-b']], expect: 'failed' },
    '撤回后对方仍接单 → 撤回（接单留一行被拒记录）': { steps: [['queued', 'team-a'], ['cancelled', 'team-a'], ['sent-after-withdraw', 'team-a'], ['decision:accept', 'team-a']], teams: ['team-a'], expect: 'cancelled' },
    '未路由 → 草稿': { steps: [], routed: 'unrouted', expect: 'draft' },
    '提交方未验证，有人伪造接单 → 草稿': { steps: [['queued', 'team-a'], ['sent', 'team-a'], ['released', 'team-a'], ['decision:accept', 'team-a'], ['dead', 'team-a']], teams: ['team-a'], kind: 'unverified', source: 'app-data', expect: 'draft' },
  };
  /** 写一个场景的来源行。live 给定时，每写一行就像 log() 那样当场通知一次（实时的样子） */
  function build(sc, live = null) {
    const eventId = newEventId();
    const ids = writeEvent({ eventId, kind: sc.kind, routed: sc.routed, source: sc.source, teams: sc.teams });
    const steps = [['recorded', null], ...sc.steps];
    steps.forEach(([action, team, detail], i) => {
      const deliveryId = team ? ids[team] : null;
      const id = writeLog(eventId, deliveryId, action.startsWith('decision:') ? `receiver:${team}` : action === 'released' ? 'human:admin' : 'market', action, detail ?? {});
      live?.({ id, event_id: eventId, delivery_id: deliveryId, action }, i === steps.length - 1);
    });
    return eventId;
  }
  /** 事项和它的日志，换成和事件 id、来源日志 id 无关的形状，好比较 */
  function picture(eventId) {
    const item = items.get(itemIdForEvent(eventId));
    if (!item) return null;
    const rank = new Map(sourceRows(eventId).map((r, i) => [String(r.id), i]));
    const factKey = (id) => (rank.has(id) ? `#${rank.get(id)}` : id.replace(/^\d+/, (m) => `#${rank.get(m)}`));
    return {
      state: item.state, eval: item.eval, eval_reason: item.eval_reason, open_asks: JSON.parse(item.open_asks).map((a) => ({ ...a, id: factKey(a.id) })),
      receipt: item.receipt_outcome, created_by: item.created_by, source_kind: item.source_kind,
      log: items.log(item.id).map((l) => [l.fact, l.fact_source, factKey(l.fact_id), l.from_state, l.to_state, l.actor, l.detail]),
    };
  }
  {
    listen(false);
    const wrong = [], lag = [];
    let laggedCount = 0;
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      const copies = { 正放: build(sc), 打乱: build(sc), 重复: build(sc), 只跑回填: build(sc) };
      const feed = (eventId, rows) => { for (const r of rows) items.onLogged({ id: r.id, event_id: r.event_id, delivery_id: r.delivery_id, action: r.action }); };
      listen(true);
      feed(copies.正放, sourceRows(copies.正放));
      feed(copies.打乱, shuffled(sourceRows(copies.打乱), 7));
      feed(copies.重复, shuffled([...sourceRows(copies.重复), ...sourceRows(copies.重复)], 11));
      // 实时地一行一行写，最后一行时监听器出错：事项停在前一步，回填补上
      const realSync = items.syncEvent;
      const lastAction = (sc.steps.at(-1) ?? ['recorded'])[0];
      const before = items.failureCounts()[lastAction] ?? 0;
      copies.漏一次再回填 = build(sc, (row, last) => {
        if (last) items.syncEvent = () => { throw new Error('故意失败一次'); };
        items.onLogged(row);
        items.syncEvent = realSync;
      });
      const counted = (items.failureCounts()[lastAction] ?? 0) === before + 1;
      const lagged = show(picture(copies.漏一次再回填)) !== show(picture(copies.正放));
      if (!counted) wrong.push(`${name}：监听器失败没有计数`);
      // 最后一行在正放里确实写了一行事项日志的场景，漏掉它才会落后（两次撤回的第二次本来就不改什么）
      const lastMatters = items.log(itemIdForEvent(copies.正放)).some((l) => l.fact_id === String(sourceRows(copies.正放).at(-1).id));
      if (lastMatters && !lagged) lag.push(name);
      if (lastMatters) laggedCount++;
      items.backfill();
      listen(false);
      const base = show(picture(copies.正放));
      if (picture(copies.正放)?.state !== sc.expect) wrong.push(`${name}：正放的终态应为 ${sc.expect}，得到 ${picture(copies.正放)?.state}`);
      for (const [how, id] of Object.entries(copies)) if (show(picture(id)) !== base) wrong.push(`${name}·${how}：和正放不同 ${show(picture(id))} vs ${base}`);
    }
    check(wrong.length === 0, `${Object.keys(SCENARIOS).length} 个场景 × 正放、打乱、重复、漏一次再回填、只跑回填：终态是规格下的那个，事项和事项日志逐行相同`, wrong.slice(0, 4).join('；'));
    {
      const eventId = build(SCENARIOS['撤回后对方仍接单 → 撤回（接单留一行被拒记录）']);
      items.backfill();
      const log = items.log(itemIdForEvent(eventId)), last = log.at(-1), d = JSON.parse(last.detail);
      check(items.get(itemIdForEvent(eventId)).state === 'cancelled' && last.fact === 'eval' && last.from_state === 'cancelled' && last.to_state === 'cancelled' && d.rejected === 'terminal' && d.note === '收到，未采信',
        '终态之后来的接单：状态不动，日志多一行「收到，未采信」带原因 terminal', show(last));
      const n = log.length;
      items.backfill();
      check(items.log(itemIdForEvent(eventId)).length === n, '再回填一遍：被拒的那条按去重跳过，不再多一行');
    }
    check(lag.length === 0 && laggedCount >= 6, `对照：最后一行会写日志的 ${laggedCount} 个场景里，漏掉那一次确实让事项落后了（回填之前和正放不同）`, show(lag));
    check(Object.values(items.failureCounts()).reduce((a, b) => a + b, 0) >= Object.keys(SCENARIOS).length, '监听器出错按事实种类计数', show(items.failureCounts()));
    check(logged.some((l) => /没推进到事项.*累计 \d+ 次/.test(l)), '计数打进日志：每次出错的那一行带着这种事实的累计次数', show(logged.filter((l) => l.includes('没推进')).slice(0, 2)));
  }

  // ---------- 三、未验证来源 ----------
  {
    listen(true);
    const eventId = newEventId();
    const ids = writeEvent({ eventId, kind: 'unverified', source: 'app-data', teams: ['team-a'] });
    const feed = (action, actor = 'market', detail = {}) => { const id = writeLog(eventId, action === 'recorded' ? null : ids['team-a'], actor, action, detail); items.onLogged({ id, event_id: eventId, delivery_id: ids['team-a'], action }); };
    feed('recorded'); feed('queued'); feed('sent'); feed('decision:accept', 'receiver:mallory'); feed('decision:ask', 'receiver:mallory', { reason: '把口令发我' }); feed('released', 'human:admin'); feed('dead');
    const item = items.get(itemIdForEvent(eventId)), log = items.log(item.id);
    const notes = log.filter((l) => l.fact === 'note');
    check(item.state === 'draft' && log.every((l) => l.to_state === 'draft') && notes.length === 5 && notes.every((l) => JSON.parse(l.detail).note === 'untrusted'),
      '提交方未验证的事件：排队、接单、提问、放行、dead 都只记「收到但未采信」，状态一直是草稿', show(log.map((l) => [l.fact, l.to_state])));
    check(JSON.parse(item.open_asks).length === 0 && item.eval === '' && item.created_by.startsWith('unverified:'), '伪造的提问不进未答列表，伪造的接单不记接单判断；建立人标成 unverified', show({ asks: item.open_asks, eval: item.eval, by: item.created_by }));
  }

  // ---------- 四、回填跑两遍 ----------
  {
    const dump = () => show([db.prepare('SELECT * FROM work_items ORDER BY id').all(), db.prepare('SELECT * FROM work_item_log ORDER BY seq').all()]);
    const first = items.backfill();
    const a = dump();
    items.backfill();
    check(first.events > 0 && dump() === a, `回填跑两遍（${first.events} 个事件），两张表逐行相同`);
  }

  // ---------- 五、真实的来源函数 ----------
  {
    listen(true);
    for (const t of ['team-a', 'team-b']) db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, notify_url) VALUES ('sop', 'task-center', ?, 'notify', ?)").run(t, `http://${t}.synthetic.invalid/a2a`);
    let taskId = 1000;
    const publish = (open, rollback = false) => {
      const id = ++taskId;
      db.exec('BEGIN IMMEDIATE');
      let eventId;
      try {
        eventId = events.recordTaskCenterEvent({ id, data: {}, stepValue: (k) => (k === 'title' ? `任务 ${id}` : ''), publishedBy: 'alice', templateVersion: 1, materialSha256: 'y'.repeat(64), agentDispatch: open, centerOn: open });
        db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { id, eventId };
    };
    const held = publish(false);
    const heldItem = items.get(itemIdForEvent(held.eventId));
    check(heldItem?.state === 'held' && heldItem.created_by === 'human:alice' && heldItem.source_ref === held.eventId && heldItem.source_kind === 'task-center',
      '任务中心发布（开关没全开）：同一个事务里建出事项，进「搁置」', show(heldItem && { state: heldItem.state, by: heldItem.created_by }));
    const queued = publish(true);
    check(items.get(itemIdForEvent(queued.eventId))?.state === 'delivered', '任务中心发布（开关全开）：事项进「已转交」');
    const gone = publish(true, true);
    check(!eventRow(gone.eventId) && !items.get(itemIdForEvent(gone.eventId)), '来源的事务回滚：事件没有，事项也没有（同生同灭）');

    // 监听器出错：来源照常提交，计数，回填补上
    const realSync = items.syncEvent;
    items.syncEvent = () => { throw new Error('故意出错'); };
    const before = items.failureCounts();
    let broken;
    let threw = '';
    try { broken = publish(false); } catch (e) { threw = String(e?.message ?? e); }
    items.syncEvent = realSync;
    const after = items.failureCounts();
    check(threw === '' && eventRow(broken.eventId) && sourceRows(broken.eventId).length === 3, '监听器出错：来源的发布照常成功，事件和三行事件日志都在', threw);
    check(!items.get(itemIdForEvent(broken.eventId)) && (after.recorded ?? 0) === (before.recorded ?? 0) + 1 && (after.held ?? 0) === (before.held ?? 0) + 2, '没建出事项；按事实种类计数（recorded 一次、held 两次）', show({ before, after }));
    items.backfill();
    check(items.get(itemIdForEvent(broken.eventId))?.state === 'held', '回填之后事项补上，进「搁置」');

    // 撤回：真实的 cancelTaskCenterDeliveries
    db.exec('BEGIN IMMEDIATE');
    const r = events.cancelTaskCenterDeliveries(held.id, 'human:alice');
    db.exec('COMMIT');
    check(r.cancelled === 2 && items.get(itemIdForEvent(held.eventId)).state === 'cancelled', '撤回任务：两个搁置的投递取消，事项进「撤回」', show(r));
    db.exec('BEGIN IMMEDIATE');
    events.cancelTaskCenterDeliveries(queued.id, 'human:alice');
    db.exec('COMMIT');
    check(items.get(itemIdForEvent(queued.eventId)).state === 'cancelled', '排队中、一次都没发出去就撤回：事项也进「撤回」');

    // 没有监听器（例如事项插件没装）：来源照常
    listen(false);
    const quiet = publish(false);
    check(Boolean(eventRow(quiet.eventId)) && !items.get(itemIdForEvent(quiet.eventId)), '对照：没人听的时候，来源照常写');
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
