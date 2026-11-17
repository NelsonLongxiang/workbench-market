#!/usr/bin/env node
/**
 * 事项回填和启动自检的时序（上线前的阻塞：慢环境里自检第一行 market.mcp.initialize 超时，进程按设计拒绝启动）。
 *
 *   一、回填很慢也不挡自检：每处理一个事件人为慢 200 毫秒（预加载注入，模拟带全量跟踪的慢环境），一批 50 个事件就超过自检超时。
 *       自检照样通过、服务起来；回填在自检通过之后开始，并且照样跑完、事项都建出来
 *       （以前回填在端口一开就同步跑一整批，第一条自检请求等它跑完才有应答，超时、拒绝启动）
 *   二、每片最多超出时间表一个事件的工夫：回填期间健康检查的应答等不了一整批（50 个事件）那么久
 *   三、自检没过，回填不开始：预加载让自检请求拿到不对的应答，进程拒绝启动；库里没有回填的记账、没有建出事项
 *   回填结果和改之前逐行相同，由 work-item-backfill-test 守。
 *
 *   node scripts/work-item-backfill-startup-test.mjs              测本仓库
 *   node scripts/work-item-backfill-startup-test.mjs --root DIR   测另一棵目录树（拿旧代码跑，看它红）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-backfill-startup-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;
const N = 60, SLOW_MS = 200;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const ENV = (dataDir) => ({ PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir, NODE_ENV: 'test', ADMIN_TOKEN: 'backfill-startup-synthetic', REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', WM_EXTENSIONS_DIR: join(dataDir, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' });

/** 造 n 个事件（只有事件、投递、日志，没有事项：事项由回填建） */
function seed(dataDir) {
  mkdirSync(join(dataDir, 'ext'), { recursive: true });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
    const ev = await import(${JSON.stringify(at('server/src/workbench-events.ts'))});
    ev.initWorkbenchEvents();
    db.exec('BEGIN');
    const e = db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', ?, ?, 'human', 'human:seed', NULL, ?, 1, 'target')");
    const d = db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, 'team-a', 'http://peer.synthetic.invalid', 'market/test', 'sent')");
    const l = db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')");
    for (let i = 0; i < ${N}; i++) {
      const id = 'wbe-' + i.toString(16).padStart(16, '0');
      e.run(id, 'task:' + i, 'wb:task-center:' + i, 'x'.repeat(64));
      const del = Number(d.run(id).lastInsertRowid);
      for (const [dd, a] of [[null, 'recorded'], [del, 'queued'], [del, 'sent'], [del, 'decision:accept']]) l.run(id, dd, a);
    }
    db.exec('COMMIT');
    console.log('SEEDED');`], { env: ENV(dataDir), encoding: 'utf8', timeout: 120000 });
  if (!r.stdout.includes('SEEDED')) throw new Error(`造数据失败：${r.stderr.slice(-600)}`);
}

/** 预加载：每处理一个事件人为慢 SLOW_MS 毫秒（忙等，占住事件循环，和慢环境里的同步工作一样） */
function slowPreload(dir) {
  const f = join(dir, 'slow-sync.mjs');
  writeFileSync(f, `
    const { WorkItemService } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
    const orig = WorkItemService.prototype.syncEvent;
    WorkItemService.prototype.syncEvent = function (id) { const t = Date.now(); while (Date.now() - t < ${SLOW_MS}) { /* 忙等 */ } return orig.call(this, id); };
  `);
  return pathToFileURL(f).href;
}
/** 预加载：自检的 MCP 请求拿到 200（应当是 401），自检判这一行不过 */
function breakProbePreload(dir) {
  const f = join(dir, 'break-probe.mjs');
  writeFileSync(f, `
    import http from 'node:http';
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (event, req, res) {
      if (event === 'request' && req.headers['user-agent'] === 'workbench-market/self-probe' && req.url === '/mcp') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return true;
      }
      return emit.apply(this, arguments);
    };
  `);
  return pathToFileURL(f).href;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const children = [];
try {
  // ---------- 一、二：回填很慢也不挡自检 ----------
  {
    const dir = join(OUT, 'slow');
    seed(dir);
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', slowPreload(dir), 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...ENV(dir), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    const ADMIN = { 'x-admin-token': 'backfill-startup-synthetic' };
    // 每一次健康检查的耗时都记下（从发出到应答或放弃）：连接被拒（端口还没开）很快就回，不算卡；卡住的会一直等到应答
    let h = null, worst = 0;
    for (const t0 = Date.now(); Date.now() - t0 < 60000 && child.exitCode === null;) {
      const s = Date.now();
      try { const r = await fetch(base + '/api/health', { headers: ADMIN, signal: AbortSignal.timeout(15000) }); const j = await r.json(); worst = Math.max(worst, Date.now() - s); if (j.self_probe?.at) { h = j; break; } } catch (e) { if (e?.name === 'TimeoutError') worst = Math.max(worst, Date.now() - s); }
      await new Promise((r) => setTimeout(r, 100));
    }
    const mcp = h?.self_probe?.rows?.find((x) => x.id === 'market.mcp.initialize');
    check(child.exitCode === null && h?.self_probe?.passed === true && mcp?.verdict === 'pass',
      `回填每个事件慢 ${SLOW_MS} 毫秒（一批 50 个就超过自检超时）：自检照样通过，第一行 market.mcp.initialize 过，服务起来`, show({ exit: child.exitCode, passed: h?.self_probe?.passed, mcp, failed: h?.self_probe?.failed, refused: (/\{"source":"self-probe","event":"startup-refused"[^\n]*/.exec(log) ?? [''])[0] }));
    // 回填期间健康检查：每次应答都等不了一整批（50 个事件 × 200 毫秒 = 10 秒），最慢也只是一个事件的工夫加一点
    let done = null;
    for (const t0 = Date.now(); child.exitCode === null && Date.now() - t0 < 120000;) {
      const s = Date.now();
      try { const r = await fetch(base + '/api/health', { headers: ADMIN, signal: AbortSignal.timeout(15000) }); const j = await r.json(); worst = Math.max(worst, Date.now() - s); if (j.work_items_backfill?.state === 'done') { done = j.work_items_backfill; break; } } catch { worst = Math.max(worst, Date.now() - s); }
      await new Promise((r) => setTimeout(r, 50));
    }
    check(done && done.events === N && worst < 3000, `回填照样跑完（${N} 个事件）；期间健康检查最慢一次 < 3 秒（每片最多超出一个事件的工夫，不再是一整批）`, show({ done, worst }));
    const n = (() => { const d = new DatabaseSync(join(dir, 'workbench-market.db'), { readOnly: true }); try { return d.prepare('SELECT COUNT(*) AS n FROM work_items').get().n; } finally { d.close(); } })();
    check(n === N, `事项都建出来了（${N} 件）`, show(n));
    const iProbe = log.indexOf('"id":"market.mcp.initialize"'), iBack = log.indexOf('[work-items] 后台回填完成');
    check(iProbe >= 0 && iBack > iProbe, '日志顺序：自检那一行在前，回填完成在后', show({ iProbe, iBack }));
    child.kill('SIGTERM');
  }
  // ---------- 三、自检没过，回填不开始 ----------
  {
    const dir = join(OUT, 'refused');
    seed(dir);
    const port = await freePort();
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', breakProbePreload(dir), 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...ENV(dir), PORT: String(port) }, encoding: 'utf8', timeout: 90000 });
    const q = (sql) => { const d = new DatabaseSync(join(dir, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
    const mark = q("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'work_item_backfill'")[0].n ? q('SELECT status FROM work_item_backfill') : [];
    const items = q('SELECT COUNT(*) AS n FROM work_items')[0].n;
    check(r.status === 1 && r.stderr.includes('startup-refused') && mark.length === 0 && items === 0 && !r.stdout.includes('后台回填'),
      '自检没过（MCP 那一行应答不对）：拒绝启动；回填没有开始——库里没有回填的记账、没有建出事项、日志里没有回填', show({ status: r.status, mark, items, refused: r.stderr.includes('startup-refused') }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) { c.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
