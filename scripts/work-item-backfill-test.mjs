#!/usr/bin/env node
/**
 * 事项回填不挡启动（阶段八上线预演）。回填在后台分批跑，每一片让出事件循环；这个版本全量跑完过时，启动只从上次的事件日志水位往后增量核。
 *
 *   一、回填不挡启动：10000 个事件时首个应答里的回填状态还没到 done（应答先于回填跑完）；1000 个和 10000 个事件各起一次，
 *       首个应答的耗时之比不超过 3 倍；回填还在跑的时候健康检查多次应答。不掐绝对时间（CI 机器快慢不一），
 *       只留很宽的兜底（单次健康检查 15 秒）防真卡死
 *   二、回填中途进程被杀：重启接着跑（从记下的游标），终态和一次跑完的逐行相同
 *   三、重跑逐行相同；再启动只从上次的水位往后增量核（没有新事实时核 0 个）
 *   三之二、回滚到没有事项服务的版本期间写进来的事件和事实：再启动时增量补回来（验收方复现的场景）
 *   四、回填期间新进来的事实（游标已过的事件、还没核到的事件、新事件）不丢、不重复
 *   五、回填跑的期间监听器漏过事实：这一轮记成 stale，下次启动从头全量核、补回来
 *   匿名的健康检查只给回填的 state，细节（批数、游标、事件数）只给带管理口令的请求
 *
 *   node scripts/work-item-backfill-test.mjs              测本仓库
 *   node scripts/work-item-backfill-test.mjs --root DIR   测另一棵目录树（拿旧代码跑，看它红）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-backfill-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const ENV = (dataDir) => ({ PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir, NODE_ENV: 'test', ADMIN_TOKEN: 'backfill-synthetic', REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0', WM_EXTENSIONS_DIR: join(dataDir, 'ext') });

/** 在一个数据目录里造 n 个事件：每个事件一条投递，日志是 recorded、queued、sent、decision:accept（事项会追到「已接手」） */
function seed(dataDir, n, from = 0) {
  mkdirSync(join(dataDir, 'ext'), { recursive: true });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
    const ev = await import(${JSON.stringify(at('server/src/workbench-events.ts'))});
    ev.initWorkbenchEvents();
    db.exec('BEGIN');
    const e = db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', ?, ?, 'human', 'human:synthetic', 1, ?, 1, 'target')");
    const d = db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, 'team-a', 'http://peer.synthetic.invalid', 'market/test', 'sent')");
    const l = db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')");
    for (let i = ${from}; i < ${from + n}; i++) {
      const id = 'wbe-' + i.toString(16).padStart(16, '0');
      e.run(id, 'task:' + i, 'wb:task-center:' + i, 'x'.repeat(64));
      const del = Number(d.run(id).lastInsertRowid);
      for (const [dd, a] of [[null, 'recorded'], [del, 'queued'], [del, 'sent'], [del, 'decision:accept']]) l.run(id, dd, a);
    }
    db.exec('COMMIT');
    console.log('SEEDED');`], { env: ENV(dataDir), encoding: 'utf8', timeout: 300000 });
  if (!r.stdout.includes('SEEDED')) throw new Error(`造数据失败：${r.stderr.slice(-600)}`);
}

/** 起服务：返回首个 HTTP 应答的耗时（任何状态码都算能应答） */
async function start(dataDir) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...ENV(dataDir), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  // firstMs：首个应答（启动门没开时是 503，也算应答）；firstState：第一个带回填状态的应答里的状态
  let firstMs = null, firstState = null;
  for (let i = 0; Date.now() - t0 < 90000; i++) { // 旧代码同步回填时，一万个事件要十几秒才应答；给足时间，让它在断言上红而不是在这里
    if (child.exitCode !== null) throw new Error(`服务退出了：${log.slice(-600)}`);
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) }); const j = await r.json().catch(() => ({})); firstMs ??= Date.now() - t0; if (j.work_items_backfill?.state) { firstState = j.work_items_backfill.state; break; } } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (firstState === null) throw new Error(`服务没应答：${log.slice(-600)}`);
  const health = async (anonymous = false) => { const t = Date.now(); const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000), headers: anonymous ? {} : { 'x-admin-token': 'backfill-synthetic' } }); const j = await r.json().catch(() => ({})); return { ms: Date.now() - t, backfill: j.work_items_backfill }; };
  const stop = async (signal = 'SIGTERM') => { if (child.exitCode === null) { child.kill(signal); await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); } };
  return { firstMs, firstState, health, stop, log: () => log };
}

async function waitDone(s, budgetMs = 120000) {
  const t0 = Date.now(), lat = [], seen = new Set();
  let runningPolls = 0;
  for (;;) {
    const h = await s.health(); lat.push(h.ms); if (h.backfill?.state) seen.add(h.backfill.state);
    if (h.backfill?.state === 'running') runningPolls++;
    if (h.backfill?.state === 'done') return { h, maxMs: Math.max(...lat), polls: lat.length, runningPolls, seen: [...seen] };
    if (h.backfill?.state === 'failed') throw new Error('回填停在 failed：' + show(h.backfill));
    if (Date.now() - t0 > budgetMs) throw new Error('回填没在期限内跑完：' + show(h.backfill));
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 事项和事项日志的快照（时间列去掉） */
function snapshot(dataDir) {
  const c = new DatabaseSync(join(dataDir, 'workbench-market.db'), { readOnly: true });
  try {
    const items = c.prepare('SELECT id, title, created_by, creator_principal, source_kind, source_ref, context, event_id, target_team, seat, eval, state, open_asks, receipt_outcome FROM work_items ORDER BY id').all();
    const log = c.prepare('SELECT item_id, fact, fact_source, fact_id, from_state, to_state, actor, detail, rejected FROM work_item_log ORDER BY item_id, fact_source, fact_id').all();
    return { items: items.length, log: log.length, digest: show([items, log]) };
  } finally { c.close(); }
}
const mark = (dataDir) => { const c = new DatabaseSync(join(dataDir, 'workbench-market.db'), { readOnly: true }); try { return c.prepare('SELECT version, status, phase, cursor, batches, events, log_mark, dirty FROM work_item_backfill WHERE id = 1').get(); } catch { return null; } finally { c.close(); } };

/** 参照：同一份数据，进程内一次同步跑完（手动入口 backfill()） */
function reference(dataDir) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
    const { WorkItemService } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
    await root.plugin(WorkItemService);
    const r1 = root.get('workItems').backfill();
    console.log('REF ' + JSON.stringify(r1));
    process.exit(0);`], { env: ENV(dataDir), encoding: 'utf8', timeout: 300000 });
  if (!r.stdout.includes('REF')) throw new Error(`参照跑不完：${r.stderr.slice(-600)}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  // ---------- 一、启动到能应答，不随事件数增长 ----------
  const small = join(OUT, 'small'), big = join(OUT, 'big');
  seed(small, 1000); seed(big, 10000);
  const bigCopy = join(OUT, 'big-copy'); cpSync(big, bigCopy, { recursive: true }); // 给第二节用
  const refDir = join(OUT, 'ref'); cpSync(big, refDir, { recursive: true }); reference(refDir);
  const refSnap = snapshot(refDir);
  check(refSnap.items === 10000, '参照：一次同步跑完，10000 个事件建出 10000 件事项', show(refSnap.items));
  const s1 = await start(small); await s1.stop('SIGKILL');
  const s2 = await start(big);
  console.log(`  · 首个应答：1000 个事件 ${s1.firstMs} ms，10000 个事件 ${s2.firstMs} ms（回填状态 ${s2.firstState}）`);
  check(s2.firstState !== null && s2.firstState !== 'done', '回填不挡启动：10000 个事件时，首个应答里回填还没跑完（应答先于回填）', show({ firstState: s2.firstState }));
  check(s2.firstMs <= 3 * s1.firstMs, '启动到能应答的时间不随事件数增长（10000 个事件的首个应答耗时不超过 1000 个的 3 倍）', show({ small: s1.firstMs, big: s2.firstMs }));
  const d2 = await waitDone(s2, 60000);
  const anon = await s2.health(true);
  await s2.stop();
  check(show(Object.keys(anon.backfill ?? {})) === show(['state']) && anon.backfill.state === 'done', '匿名的健康检查只给回填的 state（不透露批数、游标、事件数）', show(anon.backfill));
  console.log(`  · 回填期间健康检查最慢 ${d2.maxMs} ms（${d2.polls} 次，其中回填在跑时 ${d2.runningPolls} 次）`);
  check(d2.seen.includes('running') && d2.h.backfill.state === 'done' && d2.h.backfill.events === 10000 && d2.h.backfill.batches > 1, '就绪检查里报回填状态：先在跑（第几批）、跑完是 done（核了 10000 个事件）', show({ seen: d2.seen, done: d2.h.backfill }));
  check(d2.runningPolls >= 3 && d2.maxMs < 15000, '回填期间健康检查照常应答（回填在跑时应答了至少 3 次；单次兜底 15 秒防卡死）', show({ runningPolls: d2.runningPolls, maxMs: d2.maxMs }));
  check(snapshot(big).digest === refSnap.digest, '后台分批跑完：事项和事项日志与一次同步跑完的逐行相同');

  // ---------- 二、中途被杀，重启接着跑 ----------
  {
    const s = await start(bigCopy);
    let killedAt = null;
    for (let i = 0; i < 2000; i++) { const h = await s.health(); if (h.backfill?.state === 'running' && h.backfill.batches >= 3) { killedAt = h.backfill; break; } if (h.backfill?.state === 'done') break; await new Promise((r) => setTimeout(r, 5)); }
    await s.stop('SIGKILL');
    const m = mark(bigCopy);
    check(killedAt !== null && m?.status === 'running' && m.cursor > 0, '回填跑到一半时把进程杀掉：库里记着跑到哪了（status=running、游标大于 0）', show({ killedAt, m }));
    const again = await start(bigCopy);
    const first = await again.health();
    const done = await waitDone(again);
    await again.stop();
    check(done.h.backfill.from === m.cursor && m.cursor > 0 && done.h.backfill.cursor === refSnapCursor() && done.h.backfill.phase === 'full', '重启之后从被杀时记下的游标接着跑（不是从头），跑完', show({ killedMark: m, first: first.backfill, done: done.h.backfill }));
    check(snapshot(bigCopy).digest === refSnap.digest, '中途被杀再接着跑：终态与一次跑完的逐行相同');
  }
  function refSnapCursor() { return mark(refDir)?.cursor; }

  // ---------- 三、重跑逐行相同；再启动只做增量 ----------
  {
    reference(refDir);
    check(snapshot(refDir).digest === refSnap.digest, '手动入口 backfill() 再跑一遍：逐行相同');
    const before = mark(big);
    const s = await start(big);
    const d = await waitDone(s);
    await s.stop();
    check(d.h.backfill.phase === 'incremental' && d.h.backfill.from === before.log_mark && before.log_mark > 0 && d.h.backfill.events === 0 && snapshot(big).digest === refSnap.digest,
      '这个版本全量跑完过：再启动只从上次的水位往后增量核，没有新事实时核 0 个，表一行不变', show({ before, done: d.h.backfill }));
  }

  // ---------- 三之二、没有事项服务的进程写进来的（回滚期间）：再启动增量补回来 ----------
  {
    // 不装事项服务、直接写事件和事件日志：新事件 5 个，外加一个老事件上新来的一条事实（提问）
    seed(big, 5, 10000);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      const id = 'wbe-' + (7).toString(16).padStart(16, '0');
      const d = db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ?').get(id).id;
      db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:team-a', 'decision:ask', '{\\"reason\\":\\"回滚期间问的\\"}')").run(id, d);
      console.log('WROTE');`], { env: ENV(big), encoding: 'utf8' });
    if (!r.stdout.includes('WROTE')) throw new Error('写老事件的新事实失败：' + r.stderr.slice(-400));
    const s = await start(big);
    const d = await waitDone(s);
    await s.stop();
    const c = new DatabaseSync(join(big, 'workbench-market.db'), { readOnly: true });
    const counts = { events: c.prepare('SELECT COUNT(*) AS n FROM workbench_events').get().n, items: c.prepare('SELECT COUNT(*) AS n FROM work_items').get().n, asks: JSON.parse(c.prepare("SELECT open_asks FROM work_items WHERE id = 'wi_wbe-0000000000000007'").get().open_asks).length };
    c.close();
    const copy = join(OUT, 'rollback-ref'); cpSync(big, copy, { recursive: true }); reference(copy);
    check(d.h.backfill.phase === 'incremental' && counts.events === 10005 && counts.items === 10005 && counts.asks === 1, '回滚期间（没有事项服务）写进来的 5 个新事件和老事件上的一条新提问：再启动增量补回来（事件 10005、事项 10005）', show({ counts, done: d.h.backfill }));
    check(d.h.backfill.events === 6, '增量只核有新日志行的事件（6 个），不是全量', show(d.h.backfill));
    check(snapshot(big).digest === snapshot(copy).digest, '增量补完的结果，和事后同步全量重跑一遍的逐行相同');
  }

  // ---------- 四、回填期间新进来的事实不丢、不重复 ----------
  {
    const dir = join(OUT, 'live'); seed(dir, 3000);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
      const { WorkItemService } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
      await root.plugin(WorkItemService);
      const items = root.get('workItems');
      const tick = () => new Promise((r) => setImmediate(r));
      const addLog = (eventId, action) => { const d = db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ?').get(eventId)?.id ?? null; db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:team-a', ?, '{\\"reason\\":\\"再问一句\\"}')").run(eventId, d, action); items.onLogged({ event_id: eventId, action }); };
      // 等回填真的在跑、游标过了前面一段
      for (let i = 0; i < 5000 && !(items.backfillStatus().state === 'running' && items.backfillStatus().cursor > 200); i++) await tick();
      const s0 = items.backfillStatus();
      const passed = 'wbe-' + (10).toString(16).padStart(16, '0'), ahead = 'wbe-' + (2900).toString(16).padStart(16, '0');
      addLog(passed, 'decision:ask'); addLog(ahead, 'decision:ask');
      // 一个新事件，回填还没开始核它
      const ev = await import(${JSON.stringify(at('server/src/workbench-events.ts'))});
      const nid = 'wbe-ffffffffffff0001';
      db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', 'task:new', 'wb:task-center:new', 'human', 'human:synthetic', 1, ?, 1, 'target')").run(nid, 'x'.repeat(64));
      const nd = Number(db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, 'team-a', 'http://peer.synthetic.invalid', 'market/test', 'sent')").run(nid).lastInsertRowid);
      for (const [dd, a] of [[null, 'recorded'], [nd, 'queued']]) { db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(nid, dd, a); items.onLogged({ event_id: nid, action: a }); }
      for (let i = 0; i < 20000 && items.backfillStatus().state !== 'done'; i++) await tick();
      const count = (id, fact) => db.prepare("SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ? AND fact = ?").get('wi_' + id, fact).n;
      const asks = (id) => JSON.parse(items.get('wi_' + id)?.open_asks || '[]').length;
      console.log('LIVE ' + JSON.stringify({ s0, done: items.backfillStatus(), passed: [count(passed, 'ask'), asks(passed)], ahead: [count(ahead, 'ask'), asks(ahead)], fresh: [count(nid, 'submit'), items.get('wi_' + nid)?.state] }));
      process.exit(0);`], { env: ENV(dir), encoding: 'utf8', timeout: 300000 });
    const m = /LIVE (.*)/.exec(r.stdout);
    if (!m) throw new Error('第四节跑不完：' + r.stderr.slice(-800));
    const L = JSON.parse(m[1]);
    check(L.s0.state === 'running' && L.done.state === 'done', '事实是在回填跑的期间进来的', show({ s0: L.s0, done: L.done }));
    check(show(L.passed) === show([1, 1]), '游标已经过了的事件：新来的提问记了一次，挂着等答复', show(L.passed));
    check(show(L.ahead) === show([1, 1]), '回填还没核到的事件：监听器先应用，回填再核到时不重复', show(L.ahead));
    check(L.fresh[0] === 1 && L.fresh[1] === 'delivered', '回填期间新建的事件：事项建出来、提交只记一次', show(L.fresh));
    const live = snapshot(dir);
    const copy = join(OUT, 'live-ref'); cpSync(dir, copy, { recursive: true });
    reference(copy);
    check(snapshot(copy).digest === live.digest, '回填期间进来的事实，和事后同步重跑一遍的结果逐行相同（没丢、没重复）');
  }

  // ---------- 五、回填跑的期间监听器漏过事实：记成 stale，下次启动从头全量核 ----------
  {
    const dir = join(OUT, 'dirty'); seed(dir, 2000);
    const run = (code) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
      const { WorkItemService } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
      await root.plugin(WorkItemService);
      const items = root.get('workItems');
      const tick = () => new Promise((r) => setImmediate(r));
      ${code}
      process.exit(0);`], { env: ENV(dir), encoding: 'utf8', timeout: 300000 });
    const r1 = run(`
      for (let i = 0; i < 5000 && !(items.backfillStatus().state === 'running' && items.backfillStatus().cursor > 300); i++) await tick();
      const id = 'wbe-' + (5).toString(16).padStart(16, '0');
      const d = db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ?').get(id).id;
      db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:team-a', 'decision:ask', '{\\"reason\\":\\"监听器漏掉的\\"}')").run(id, d);
      const real = items.syncEvent.bind(items);
      items.syncEvent = () => { throw new Error('合成：监听器这一次出错'); };
      items.onLogged({ event_id: id, action: 'decision:ask' });
      items.syncEvent = real;
      for (let i = 0; i < 20000 && items.backfillStatus().state !== 'done'; i++) await tick();
      const m = db.prepare('SELECT status, dirty FROM work_item_backfill WHERE id = 1').get();
      console.log('R1 ' + JSON.stringify({ m, asks: JSON.parse(items.get('wi_' + id)?.open_asks || '[]').length }));`);
    const m1 = /R1 (.*)/.exec(r1.stdout);
    if (!m1) throw new Error('第五节第一次跑不完：' + r1.stderr.slice(-600));
    const R1 = JSON.parse(m1[1]);
    check(R1.m.status === 'stale' && R1.m.dirty === 1 && R1.asks === 0, '回填跑的期间监听器在游标已越过的事件上漏了一条事实：这一轮跑完记成 stale（不是 done）', show(R1));
    const r2 = run(`
      for (let i = 0; i < 20000 && items.backfillStatus().state !== 'done'; i++) await tick();
      const m = db.prepare('SELECT status, dirty FROM work_item_backfill WHERE id = 1').get();
      console.log('R2 ' + JSON.stringify({ m, phase: items.backfillStatus().phase, asks: JSON.parse(items.get('wi_wbe-0000000000000005')?.open_asks || '[]').length }));`);
    const R2 = JSON.parse(/R2 (.*)/.exec(r2.stdout)?.[1] ?? '{}');
    check(R2.phase === 'full' && R2.m?.status === 'done' && R2.m?.dirty === 0 && R2.asks === 1, '下次启动从头全量核，把漏掉的那条事实补回来，记回 done', show(R2));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
