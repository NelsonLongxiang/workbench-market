#!/usr/bin/env node
/**
 * 「关注」的读（阶段八 8c）。规格见产品化文档 02 附录 8c。
 *
 *   一、注册可撤销：提供方随插件卸载撤销，它的条目不再出现（进程内）
 *   二、起一个隔离实例（假的登录提供方，NODE_ENV=test），七个来源各造待决：
 *       · 每个来源都出现在管理员的「关注」里
 *       · 对每个看的人（管理员、两个内部员工、远程匿名），每个有旧接口的来源：旧接口看得见（200），
 *         「关注」里这个来源可见、条数等于旧接口的条数；旧接口看不见（401 / 403），「关注」里不可见、0 条
 *       · 事项：造 N 条 ready，建立人和管理员各看到自己该看到的 N 条，别人 0 条；搁置的事项 = 工作台事件列表里搁置的事件
 *       · 事件层未答的提问数 = 事项上 open_asks 的总数
 *       · 跨站、别的站的页面来的请求被拒
 *
 *   node scripts/attention-test.mjs              测本仓库
 *   node scripts/attention-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `attention-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'attention-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** 造数据的脚本：在实例起来之前，用同一个数据目录写好七个来源的待决 */
const SEED = `
const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
const { db } = await import(at('server/src/db.ts'));
const { root } = await import(at('server/src/root-context.ts'));
const events = await import(at('server/src/workbench-events.ts'));
const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
events.initWorkbenchEvents();
await root.plugin(WorkItemService);
const items = root.get('workItems');
// 变更申请：两条待审，一条已批（对照）
for (const [slug, status] of [['app-one', 'pending'], ['app-two', 'pending'], ['app-done', 'approved']])
  db.prepare("INSERT INTO change_requests (kind, slug, op, target_version, reason, requested_by, status) VALUES ('app', ?, 'rollback', 1, '合成', 'mcp:synthetic', ?)").run(slug, status);
// MCP 权限申请：一条待批，一条已拒（对照）
const s = db.prepare("INSERT INTO mcp_sessions (name, token_sha256) VALUES ('synthetic-session', ?)").run('a'.repeat(64)).lastInsertRowid;
for (const status of ['pending', 'rejected']) db.prepare("INSERT INTO mcp_access_requests (session_id, tools, reason, status) VALUES (?, '[\\"app_sync\\"]', '合成', ?)").run(s, status);
// 待对接清单
db.prepare("INSERT INTO principal_pending (provider, external_id, display_name) VALUES ('synthetic', 'someone', 'Someone')").run();
// 统一待办：一个进行中的 SOP run
db.prepare("INSERT INTO sop_runs (sop_slug, sop_version, status, started_by) VALUES ('synthetic-sop', 1, 'running', 'user:alpha')").run();
// 待属主看板：一张外部台卡片，属主常量、两条事项（一条已由属主答复）
const wb = db.prepare("INSERT INTO workbenches (name, url, type) VALUES ('看板', '/owner-pending', 'web')").run().lastInsertRowid;
const putVar = (key, value, owner) => db.prepare("INSERT INTO workbench_vars (workbench_id, key, kind, value, owner, updated_by) VALUES (?, ?, 'const', ?, ?, ?)").run(wb, key, JSON.stringify(value), owner, owner);
putVar('config.owner', { owner_login: 'boss', writers: ['mcp:writer'] }, 'odoo:boss');
putVar('item.1', { question: '待答的问题', source: '登记方' }, 'mcp:writer');
putVar('item.2', { question: '已答的问题', source: '登记方' }, 'mcp:writer');
putVar('answer.2', { summary: '答了' }, 'odoo:boss');
// 工作台事件：两个团队；一个事件开关全开、被一个团队提问；一个事件搁置（过目）
for (const t of ['team-a', 'team-b']) db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, notify_url) VALUES ('sop', 'task-center', ?, 'notify', ?)").run(t, 'http://' + t + '.synthetic.invalid/a2a');
const publish = (id, open) => { db.exec('BEGIN IMMEDIATE'); const e = events.recordTaskCenterEvent({ id, data: {}, stepValue: () => '', publishedBy: 'alpha', templateVersion: 1, materialSha256: 'b'.repeat(64), agentDispatch: open, centerOn: open }); db.exec('COMMIT'); return e; };
const asked = publish(901, true);
const d = db.prepare("SELECT id FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id LIMIT 1").get(asked).id;
db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', decision = 'ask', decision_reason = '哪个店？', decided_by = 'bob', decided_at = datetime('now') WHERE id = ?").run(d);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(asked, d);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(asked, d, JSON.stringify({ reason: '哪个店？' }));
items.syncEvent(asked);
publish(902, false);
// 先问后接：同一个投递先提问、后接单（v1 允许）——事件层不再算这条提问，事项上也不该再挂着
const askThenAccept = publish(903, true);
const d2 = db.prepare("SELECT id FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id LIMIT 1").get(askThenAccept).id;
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(askThenAccept, d2);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:carol', 'decision:ask', ?)").run(askThenAccept, d2, JSON.stringify({ reason: '截止哪天？' }));
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:carol', 'decision:accept', '{}')").run(askThenAccept, d2);
db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', decision = 'accept', decided_by = 'carol', decided_at = datetime('now') WHERE id = ?").run(d2);
items.syncEvent(askThenAccept);
// 事项：ready 的，alpha 建两条、beta 建一条
const toReady = (by, n) => { const it = items.create({ title: '待验收 ' + n, created_by: by, creator_principal: by, source_kind: 'agent' }); for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? ''), ...x }); };
toReady('user:alpha', 1); toReady('user:alpha', 2); toReady('user:beta', 3);
console.log('SEEDED');
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  // ---------- 一、注册可撤销 ----------
  {
    const req = createRequire(join(ROOT, 'server', 'package.json'));
    const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href);
    const { AttentionService } = await import(at('server/src/services/attention.ts'));
    const ctx = new Context();
    await ctx.plugin(AttentionService);
    const attention = ctx.get('attention');
    const fiber = ctx.plugin({ inject: ['attention'], apply(c) { c.attention.provide({ source: 'demo', label: '演示', list: () => [{ source: 'demo', source_id: '1', category: 'ask', title: 'x', waiting_for: 'y', since: '2026-01-01', answers: [], object: '', phase: '', link: '' }] }); } });
    await fiber;
    const before = await attention.collect({ headers: {} });
    await fiber.dispose();
    const after = await attention.collect({ headers: {} });
    check(before.counts.total === 1 && attention.sources().length === 0 && after.counts.total === 0 && !('demo' in after.sources), '提供方随插件卸载撤销：卸掉之后它的条目不再出现', show({ before: before.counts, after: after.counts }));
    const revoke = attention.provide({ source: 'demo2', label: '演示', list: () => { throw new Error('坏了'); } });
    attention.provide({ source: 'demo3', label: '演示', list: () => [] });
    const broken = await attention.collect({ headers: {} });
    revoke();
    check(broken.sources.demo2?.error === 'demo2_source_unavailable' && broken.sources.demo3?.visible === true && !attention.sources().includes('demo2'), '一个提供方出错只影响它自己；返回的撤销函数也能撤', show(broken.sources));
    let dup = '';
    try { attention.provide({ source: 'demo3', label: '重名', list: () => [] }); } catch (e) { dup = String(e.message); }
    check(/已经有提供方/.test(dup), '同一个来源只能有一个提供方', dup);
  }

  // ---------- 二、隔离实例 ----------
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(join(OUT, 'ext'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', SEED], { env, encoding: 'utf8' });
  if (!seeded.stdout.includes('SEEDED')) throw new Error(`造数据失败：${seeded.stderr.slice(-800)}`);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const VIEWERS = {
    管理员: { ...SAME, 'x-admin-token': ADMIN_TOKEN },
    '管理员（会话登录）': { ...SAME, cookie: `session_id=${SESSIONS.admin}` },
    'alpha（内部员工）': { ...SAME, cookie: `session_id=${SESSIONS.alpha}` },
    'beta（内部员工）': { ...SAME, cookie: `session_id=${SESSIONS.beta}` },
    远程匿名: { ...SAME, 'x-forwarded-for': '198.51.100.7' },
  };
  const get = async (path, headers) => { const r = await fetch(base + path, { headers }); let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ } return { status: r.status, body }; };
  const { buildBoard, parseConfig } = await import(at('web/src/owner-pending.ts'));

  /** 每个有旧接口的来源：旧接口的条数（看不见回 null） */
  const OLD = {
    'change-requests': async (h) => { const r = await get('/api/change-requests?status=pending', h); return r.status === 200 ? r.body.length : null; },
    'mcp-access': async (h) => { const r = await get('/api/mcp/access-requests?status=pending', h); return r.status === 200 ? r.body.length : null; },
    'seat-asks': async (h) => { const r = await get('/api/workbench-events?limit=200', h); return r.status === 200 ? r.body.flatMap((e) => e.deliveries).filter((d) => d.decision === 'ask').length : null; },
    // 统一待办：没做完的；别的提供方已经单独列出的变更申请剔掉（change-request:<id>）
    tasks: async (h) => { const r = await get('/api/tasks', h); return r.status === 200 ? r.body.tasks.filter((t) => t.status !== 'done' && !t.id.startsWith('change-request:')).length : null; },
    'owner-pending': async (h) => {
      const list = await get('/api/workbenches', { ...h });
      const board = (Array.isArray(list.body) ? list.body : []).find((w) => w.url === '/owner-pending');
      if (!board) return null;
      const r = await get(`/api/workbenches/${board.id}/vars`, h);
      if (r.status !== 200) return null;
      const cfg = parseConfig(r.body.items.find((v) => v.key === 'config.owner'));
      return buildBoard(r.body.items, cfg).rows.filter((x) => x.status === 'open').length;
    },
    'principal-pending': async (h) => { const r = await get('/api/principals/pending', h); return r.status === 200 ? r.body.pending.length : null; },
  };

  const views = {};
  for (const [who, h] of Object.entries(VIEWERS)) {
    const r = await get('/api/attention', h);
    views[who] = r.body;
    if (r.status !== 200) { check(false, `${who}：GET /api/attention 应答 200`, `${r.status} ${show(r.body)}`); continue; }
    const wrong = [];
    for (const [src, old] of Object.entries(OLD)) {
      const n = await old(h), meta = r.body.sources[src];
      // 例外（阶段七 #567）：席位的提问，旧接口只给管理员；「关注」里登录的人也可见，只列他看得到的事项上的提问（itemDecisionVerdict 判答法，遗留差异 L21）。
      // 这里造的提问挂在没有建立人主体的事项上，所以登录的员工可见、0 条；远程匿名照旧不可见
      if (src === 'seat-asks' && n === null) {
        const expectVisible = who !== '远程匿名';
        if (meta.visible !== expectVisible || meta.count !== 0) wrong.push(`seat-asks：应当${expectVisible ? '可见、0 条' : '不可见'}，「关注」${meta.visible ? '可见' : '不可见'} ${meta.count} 条`);
        continue;
      }
      if (n === null ? (meta.visible || meta.count !== 0) : (!meta.visible || meta.count !== n)) wrong.push(`${src}：旧接口 ${n === null ? '看不见' : n + ' 条'}，「关注」${meta.visible ? '可见' : '不可见'} ${meta.count} 条`);
    }
    check(wrong.length === 0, `${who}：六个有旧接口的来源，可见性和条数都和旧接口一致（席位的提问按建立人另算，见例外）`, wrong.join('；'));
  }

  const admin = views.管理员;
  const bySource = (v, src, cat) => v.items.filter((x) => x.source === src && (!cat || x.category === cat));
  check(['change-requests', 'mcp-access', 'seat-asks', 'tasks', 'owner-pending', 'principal-pending', 'work-items'].every((s) => admin.counts.by_source[s] >= 1), '七个来源各造的待决都出现在管理员的「关注」里', show(admin.counts.by_source));
  check(bySource(admin, 'change-requests').length === 2 && bySource(admin, 'mcp-access').length === 1, '对照：已批、已拒的不出现', show(admin.counts.by_source));
  check(admin.items.every((x) => ['source', 'source_id', 'category', 'title', 'waiting_for', 'since', 'answers', 'object', 'phase', 'link'].every((k) => k in x)), '每条的形状统一（来源、id、类别、标题、谁在等、从何时等、答法、对象、阶段、链接）');
  // 显示名在汇总那一层统一补：每条都有 waiting_for_name（看不到的、不是人的为 null），从来不是内部键本身
  check(Object.values(views).every((v) => (v.items ?? []).every((x) => 'waiting_for_name' in x && (x.waiting_for_name === null || (typeof x.waiting_for_name === 'string' && x.waiting_for_name !== x.waiting_for))))
    && bySource(admin, 'principal-pending').every((x) => x.waiting_for_name === null),
    '每条都带 waiting_for_name（汇总那一层补的）；不是人的键（待对接的外部身份）为 null，名字从来不是内部键本身', show(admin.items.map((x) => [x.source, x.waiting_for, x.waiting_for_name])));
  check(bySource(admin, 'seat-asks')[0]?.link.startsWith('/work-items/wi_wbe-'), '席位的提问带着对应事项的链接', show(bySource(admin, 'seat-asks')));
  // 链接只放站内页面路径：要么 null（没有对应页面，在卡片上当场办），要么是 / 开头、不是 /api/ 的路径
  const badLinks = Object.entries(views).flatMap(([who, v]) => (v.items ?? []).filter((x) => !(x.link === null || (typeof x.link === 'string' && x.link.startsWith('/') && !x.link.startsWith('/api/')))).map((x) => [who, x.source, x.link]));
  check(badLinks.length === 0 && bySource(admin, 'principal-pending').every((x) => x.link === null),
    '各来源给的链接要么是 null，要么是站内页面路径（不以 /api/ 开头）；待对接的主体没有对应页面，给 null', show(badLinks));

  // 事项：验收 = ready（建立人 + 管理员），过目 = held（管理员）
  const accept = (who) => bySource(views[who], 'work-items', 'accept').length;
  check(accept('管理员') === 3 && accept('alpha（内部员工）') === 2 && accept('beta（内部员工）') === 1 && accept('远程匿名') === 0, '验收：ready 的事项，建立人看到自己的（alpha 2、beta 1），管理员看到全部 3 条，别人 0 条', show({ 管理员: accept('管理员'), alpha: accept('alpha（内部员工）'), beta: accept('beta（内部员工）'), 匿名: accept('远程匿名') }));
  check(views['alpha（内部员工）'].sources['work-items'].visible && !views.远程匿名.sources['work-items'].visible, '没登录的看不见事项这个来源；登录的看得见（只有自己的）');
  const eventsList = await get('/api/workbench-events?limit=200', VIEWERS.管理员);
  const heldEvents = eventsList.body.filter((e) => e.deliveries.some((d) => d.status === 'held')).length;
  check(bySource(admin, 'work-items', 'glance').length === heldEvents && heldEvents === 1, `过目：搁置的事项条数 = 工作台事件列表里搁置的事件数（${heldEvents}）`, show(bySource(admin, 'work-items', 'glance')));
  check(bySource(views['alpha（内部员工）'], 'work-items', 'glance').length === 0, '过目只给管理员：内部员工看不到搁置的事项');

  // 事件层未答的提问 = 事项上 open_asks 的总数
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const openAsks = ro.prepare('SELECT open_asks FROM work_items').all().reduce((n, r) => n + JSON.parse(r.open_asks).length, 0);
  ro.close();
  check(openAsks === bySource(admin, 'seat-asks').length && openAsks === 1, `事件层未答的提问数（${bySource(admin, 'seat-asks').length}）= 事项上 open_asks 的总数（${openAsks}）`);

  // 对抗：口令不对、跨站、别的站
  const forged = await get('/api/attention', { ...SAME, cookie: `session_id=${SESSIONS.alpha}`, 'x-admin-token': 'not-the-token' });
  check(forged.status === 200 && !forged.body.sources['change-requests'].visible && forged.body.counts.by_category.glance === 0, '内部员工带一个错的口令：仍然不是管理员，管理员才看得见的来源都不可见', show(forged.body?.sources?.['change-requests']));
  const forgedCreator = await get('/api/attention', { ...SAME, cookie: `session_id=${SESSIONS.forged}` });
  check(forgedCreator.status === 200 && forgedCreator.body.counts.total === 0, '提供方不认的会话：什么都看不到', show(forgedCreator.body?.counts));
  for (const [what, h] of [['跨站请求', { 'sec-fetch-site': 'cross-site', 'x-admin-token': ADMIN_TOKEN }], ['别的站的页面', { origin: 'https://elsewhere.example', 'x-admin-token': ADMIN_TOKEN }]]) {
    const r = await get('/api/attention', h);
    check(r.status === 403 && r.body?.error === 'attention_cross_origin_denied', `${what}：拒绝`, show(r));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.slice(-1500));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
