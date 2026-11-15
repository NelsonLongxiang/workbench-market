#!/usr/bin/env node
/**
 * 经验库没接入 ygl-trees 时，「记成经验」当场拒（对抗组）。隔离实例：本机找不到 ygl-trees 命令行（WM_YGL_CLI 指向一个不存在的文件），
 * 同步关着（WM_KNOWLEDGE_SYNC_MINUTES=0）；登录、名册、部门、事项都是合成的，只在 127.0.0.1 上。
 * 接上了的情形（行为不变）在 knowledge-remember-test、attention-via-ledger-test 里，那两本用的是假的命令行。
 *
 *   一、/api/auth/me 的 can.remember_knowledge：持管理层授予的人也是 false（没接入）
 *   二、「关注」答复带 remember：答复照常成功（放行了），remember 当场拒（knowledge_not_connected），不生成待写、不进重试
 *   三、卡片经 answer_via 放行带 remember：同样放行成功、经验被拒；答复账照记（之后接上了还能补记）
 *   四、补记接口：503 knowledge_not_connected，什么都不写
 *   五、同步状态里没有待写、没有放弃的；过一个重试周期也没有
 *
 *   node scripts/knowledge-remember-offline-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `knowledge-remember-offline-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const FAKE_CLI = join(HERE, 'fixtures', 'ygl-library-fake.mjs');
const ADMIN_TOKEN = 'knowledge-remember-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid';
const TEAM = 'zone1/canvas/Team A', VACANT = 'zone1/canvas/Team B';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 测试自己开的库连接都带忙等：服务端同时在写，不等就会偶发 database is locked
const BUSY_MS = 10_000;
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ygl = join(OUT, 'ygl');
  for (const d of [data, home, ygl, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const FX = join(ygl, 'library-fixture.json');
  writeFileSync(FX, JSON.stringify({ items: { claim: [], note: [], skill: [], check: [] }, bodies: {} }));
  const fixture = (patch) => { const f = JSON.parse(readFileSync(FX, 'utf8')); writeFileSync(FX, JSON.stringify({ ...f, ...patch })); };
  const kbCalls = () => { try { return readFileSync(join(ygl, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('kb add')).length; } catch { return 0; } };
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT,
    WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', WM_YGL_CLI: join(OUT, 'no-such-ygl-cli.cjs'), YGL_HOME: ygl, WM_KNOWLEDGE_SYNC_MINUTES: '0', WM_KNOWLEDGE_WRITE_RETRY_SECONDS: '1', WM_BENCH_VIEWS: 'on' };
  // 事项：都由 alpha 建、都先过目（held）。团队 B 的四件给管理层代办放行，团队 A 的一件给部门负责人放
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    const ev = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/workbench-events.ts')).href)});
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService, itemIdForEvent } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    ev.initWorkbenchEvents();
    await root.plugin(WorkItemService);
    const items = root.get('workItems');
    const b = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', ?, 'notify', 'read', ?, 'seed')");
    b.run(${JSON.stringify(TEAM)}, ${JSON.stringify(PEER)}); b.run(${JSON.stringify(VACANT)}, ${JSON.stringify(PEER)});
    const mk = (title, team) => {
      const id = Number(db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'published')").run(title).lastInsertRowid);
      const f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
      db.exec('BEGIN IMMEDIATE');
      const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: 'user:alpha', publisherPrincipal: 'user:alpha', templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: 'user:alpha' } });
      db.exec('COMMIT');
      items.syncEvent(e);
      return itemIdForEvent(e);
    };
    const out = { v1: mk('合成：样品批次待放行', ${JSON.stringify(VACANT)}), v2: mk('合成：报价单待放行', ${JSON.stringify(VACANT)}), v3: mk('合成：发货单待放行', ${JSON.stringify(VACANT)}),
      v4: mk('合成：合同待放行', ${JSON.stringify(VACANT)}), lead: mk('合成：交给有负责人的团队', ${JSON.stringify(TEAM)}),
      v6: mk('合成：标记写成字符串', ${JSON.stringify(VACANT)}), v7: mk('合成：标记写成 1', ${JSON.stringify(VACANT)}), v8: mk('合成：放行失败', ${JSON.stringify(VACANT)}) };
    console.log('SEEDED ' + JSON.stringify(out));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);

  const FP = 'sha256:' + (HOST + '0'.repeat(64)).slice(0, 64);
  const KC = (n) => 'sha256:' + String(n).repeat(64);
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS });
    const now = Date.now();
    db.prepare('INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(HOST, PEER, FP, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
    db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('peer-rem', ?, 'zone1', '', 'active', ?, 'seed', '0', '0')").run(PEER, FP);
    const seatIns = db.prepare('INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?7, ?8, ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?9, ?10)');
    seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', PEER, FP, now, now);
    seatIns.run(HOST, VACANT, 'zone1/0000000d', 'seat-0000000d', '合成别队', 'router', PEER, FP, now, now);
    // 两个名片公钥变了的对端（合成的）：一个照卡片确认、一个直接停用
    const kc = db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, public_key, key_fingerprint, pending_public_key, pending_fingerprint, registered_by, registered_at, updated_at) VALUES (?, ?, 'zone9', '', 'key_changed', 'old', ?, 'new', ?, 'seed', '0', '0')");
    kc.run('peer_00000000000a', 'http://kc-a.synthetic.invalid', KC(1), KC(2));
    kc.run('peer_00000000000b', 'http://kc-b.synthetic.invalid', KC(3), KC(4));
    // 十一：一个启用着的对端（不在「关注」里）
    db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('peer_00000000000c', 'http://kc-c.synthetic.invalid', 'zone9', '', 'active', ?, 'seed', '0', '0')").run(KC(5));
    // 一个没绑部门的台、一个会话、三条待批的申请
    db.prepare("INSERT INTO bench_views (slug, title, created_by, created_at) VALUES ('demo', '合成台', 'seed', ?)").run(now);
    const sid = Number(db.prepare("INSERT INTO mcp_sessions (name, token_sha256) VALUES ('seat-x', 'h')").run().lastInsertRowid);
    const rq = db.prepare("INSERT INTO bench_mcp_requests (session_id, bench, tools, reason, created_at) VALUES (?, 'demo', '[\"dataset_list\"]', ?, ?)");
    for (const why of ['合成：要看数据一', '合成：要看数据二', '合成：要看数据三']) rq.run(sid, why, now);
    // 九：答复账里 demo:3 这一行写不进去（合成的触发器），看原动作是不是照样生效
    db.exec("CREATE TRIGGER synthetic_ledger_fail BEFORE INSERT ON attention_answers WHEN NEW.source = 'bench-mcp' AND NEW.source_id = 'demo:3' BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END");
    const person = db.prepare("INSERT INTO principals (id, id_key, kind, display_name) VALUES (?, ?, 'person', ?)");
    const ident = db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', ?, ?, ?)");
    person.run('user:bob-synth', 'user:bob-synth', '合成乙'); ident.run('no-flag', 'no-flag', 'user:bob-synth');
    db.close();
  }
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await sleep(200);
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: r.status, body, text };
  };
  const SAME = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '192.0.2.81' };
  const WHO = { 管理层: { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, 负责人: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 普通员工: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, 乙: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  const cli = (method, path, body) => call(method, path, {}, body);
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成：卡片记账' }); await cli('POST', `/api/grants/${d.body?.grant?.id}/submit`, {}); return (await cli('POST', `/api/grants/${d.body?.grant?.id}/approve`, {})).status; };
  const setup = [
    (await cli('PUT', '/api/departments/sales', { name: '合成销售部', lead: 'user:beta' })).status,
    (await cli('PUT', '/api/departments/ops', { name: '合成运营部' })).status,
    (await cli('POST', '/api/teams/claim', { host: HOST, team: TEAM, department: 'sales' })).status,
    (await cli('POST', '/api/teams/claim', { host: HOST, team: VACANT, department: 'ops' })).status,
    await grant('user:root-admin', 'management'), await grant('user:alpha', 'member'), await grant('user:bob-synth', 'management'),
  ];
  if (!setup.every((s) => s >= 200 && s < 300)) throw new Error(`现场搭不起来：${show(setup)}`);

  const VIA = { from_attention: true };
  const released = (id) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true, timeout: BUSY_MS }); try { return Number(d.prepare("SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ? AND fact = 'release'").get(id).n); } finally { d.close(); } };
  const ledger = (source, like) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true, timeout: BUSY_MS }); try { return d.prepare("SELECT source_id, answer, state, status, answered_by FROM attention_answers WHERE source = ? AND (source_id = ? OR source_id LIKE ? || ':%')").all(source, like, like); } finally { d.close(); } };
  const answer = (h, id, remember) => call('POST', '/api/attention/answer', h, { source: 'work-items', source_id: id, answer: 'release', ...(remember !== undefined ? { remember } : {}) });
  const writes = () => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true, timeout: BUSY_MS }); try { return Number(d.prepare('SELECT COUNT(*) AS n FROM knowledge_writes').get().n); } finally { d.close(); } };
  const status = async () => (await call('GET', '/api/knowledge/status', { 'x-admin-token': ADMIN_TOKEN })).body?.writes;

  // ---------- 一 ----------
  const me = async (h) => (await call('GET', '/api/auth/me', h)).body?.can?.remember_knowledge;
  const can = { 管理层: await me(WHO.管理层), 普通员工: await me(WHO.普通员工) };
  check(can.管理层 === false && can.普通员工 === false, '一、没接入：持管理层授予的人 can.remember_knowledge 也是 false（前端据此不给勾选、不给补记）', show(can));

  // ---------- 二 ----------
  const a2 = await answer(WHO.管理层, I.v1, { lesson: '没接入时想记' });
  check(a2.status === 200 && released(I.v1) === 1 && a2.body?.remember?.status === 'refused' && a2.body.remember.error === 'knowledge_not_connected' && typeof a2.body.remember.message === 'string' && writes() === 0,
    '二、「关注」答复带 remember：答复照常（放行了），经验当场拒（knowledge_not_connected，带说法），没有待写这一行', show({ a2: [a2.status, a2.body?.remember], writes: writes() }));

  // ---------- 三 ----------
  const a3 = await call('POST', `/api/work-items/${I.v2}/release`, WHO.管理层, { ...VIA, remember: { lesson: '卡片上想记' } });
  check(a3.status === 200 && released(I.v2) === 1 && a3.body?.remember?.status === 'refused' && a3.body.remember.error === 'knowledge_not_connected' && writes() === 0 && ledger('work-items', I.v2).length === 1,
    '三、卡片经 answer_via 放行带 remember：放行成功、经验当场拒，没有待写；答复账照记', show({ a3: [a3.status, a3.body?.remember], writes: writes() }));

  // ---------- 四 ----------
  const r4 = await call('POST', '/api/knowledge/remember', WHO.管理层, { source: 'work-items', source_id: I.v2, lesson: '补记' });
  check(r4.status === 503 && r4.body?.error === 'knowledge_not_connected' && writes() === 0,
    '四、补记接口：503 knowledge_not_connected，什么都不写', show({ r4: [r4.status, r4.body], writes: writes() }));

  // ---------- 五 ----------
  await sleep(2500); // 重试周期是 1 秒：真有待写的话这时已经试过了
  const s5 = await status();
  check(s5?.pending === 0 && s5?.failed === 0 && writes() === 0 && !/knowledge\.write|kb add/.test(log),
    '五、同步状态里没有待写、没有放弃的；过了重试周期也没有重试（日志里没有写入的尝试）', show({ s5, writes: writes() }));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`knowledge-remember-offline-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
