#!/usr/bin/env node
/**
 * 「关注」卡片经 answer_via 直接调来源路由时也记进「关注」的答复账、也接受 remember（对抗组）。
 * 隔离实例：假的登录提供方、假的 ygl-trees 命令行（scripts/fixtures/ygl-library-fake.mjs）；名册、部门、团队、事项、对端、台和申请都是合成的；
 * 只在 127.0.0.1 上，不碰任何外部系统。三类 answer_via 都走一遍：事项放行、台的 MCP 授予申请、对端公钥确认。
 *
 *   一、管理层照卡片放行（带 from_attention）、顺带记成经验：放行生效；答复账里有这一条（谁、答法）；经验写成，范围是部门（不是全公司）
 *   二、照卡片放行、不记：账照记；之后经补记接口记成经验能记上
 *   三、别处直接调放行（不带 from_attention）、请求体里塞了 remember：照旧放行，不记账，remember 不看（不写 ygl-trees）；之后补记 404
 *   四、卡片带的 remember 写得不对：400 remember_invalid，事项没放行
 *   五、别人的条目：另一个管理层补记别人答的那一条 404（和不存在逐字一样），「我处理过的」里也没有
 *   六、范围不超过答复人的权限：部门负责人照卡片放行、要求记成「全公司」：放行生效，记成经验被拒，什么都没写
 *   七、对端公钥确认、停用：卡片带来的记账、能记成经验（明确选的全公司照写）；直接调的不记账
 *   八、台的 MCP 授予申请：卡片批的记账、记成经验缺省「只给管理层」（推不出部门不落到全公司）；直接驳回的不记账
 *   九、记账失败（合成的库触发器拒这一行）：批准照样生效、应答照常，只留一条告警，不回滚
 *   十、「关注」列表里三类条目的 answer_via 请求体都带 from_attention
 *   十三、标记只认严格的 true："true"、1 不算卡片发起
 *   十四、原动作失败（非 2xx）：不记账、不记成经验
 *   十二、部门映射指着已删除的部门：缺省范围应答、不传 visibility 的写入都落「只给管理层」
 *   十一、伪造标记：带了 from_attention、但这一条不在这个人的「关注」里：动作照旧，不记账，记成经验 404
 *
 *   node scripts/attention-via-ledger-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `attention-via-ledger-${process.pid}-${Date.now().toString(36)}`);
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
    WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', WM_YGL_CLI: FAKE_CLI, YGL_HOME: ygl, WM_KNOWLEDGE_SYNC_MINUTES: '0', WM_KNOWLEDGE_WRITE_RETRY_SECONDS: '1', WM_BENCH_VIEWS: 'on' };
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
  const release = (h, id, extra = {}) => call('POST', `/api/work-items/${id}/release`, h, extra);
  const later = (h, body) => call('POST', '/api/knowledge/remember', h, { source: 'work-items', ...body });
  const released = (id) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true, timeout: BUSY_MS }); try { return Number(d.prepare("SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ? AND fact = 'release'").get(id).n); } finally { d.close(); } };
  const ledger = (source, like) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true, timeout: BUSY_MS }); try { return d.prepare("SELECT source_id, answer, state, status, answered_by FROM attention_answers WHERE source = ? AND (source_id = ? OR source_id LIKE ? || ':%')").all(source, like, like); } finally { d.close(); } };
  const benchReq = (id) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true, timeout: BUSY_MS }); try { return d.prepare('SELECT status FROM bench_mcp_requests WHERE id = ?').get(id)?.status; } finally { d.close(); } };
  const lastNote = () => { const f = JSON.parse(readFileSync(FX, 'utf8')); const n = f.items.note.at(-1); return n ? { ...n, body: f.bodies[`note:${n.id}`]?.body } : null; };
  const recent = async (h) => ((await call('GET', '/api/knowledge/remember/recent', h)).body?.items ?? []);
  const attention = async (h) => ((await call('GET', '/api/attention', h)).body?.items ?? []);

  // ---------- 十（先看列表：答之前条目都还在） ----------
  {
    const items = await attention(WHO.管理层);
    const via = (src) => items.find((x) => x.source === src && x.answer_via)?.answer_via;
    const bodies = [via('work-items')?.answers?.release?.body, via('bench-mcp')?.answers?.approve?.body, via('bench-mcp')?.answers?.reject?.body, via('a2a-peers')?.answers?.['confirm-key']?.body, via('a2a-peers')?.answers?.disable?.body];
    check(bodies.every((b) => b?.from_attention === true),
      '十、「关注」列表里事项放行、台的申请（批、驳）、对端公钥（确认、停用）的 answer_via 请求体都带 from_attention: true', show(bodies));
  }

  // ---------- 一 ----------
  const c1 = kbCalls();
  const a1 = await release(WHO.管理层, I.v1, { ...VIA, remember: { lesson: '样品批次号和检验单对上了再放' } });
  await sleep(300);
  const n1 = lastNote(), l1 = ledger('work-items', I.v1);
  check(a1.status === 200 && released(I.v1) === 1 && a1.body?.remember?.status === 'written' && a1.body.remember.scope_label === '部门' && n1?.scope === 'dept:ops' && kbCalls() === c1 + 1
      && l1.length === 1 && l1[0].state === 'done' && l1[0].answer === 'release' && l1[0].status === 200 && l1[0].answered_by === 'user:root-admin' && l1[0].source_id.startsWith(`${I.v1}:`),
    '一、管理层照卡片放行、顺带记成经验：放行生效；答复账里有这一条（答法 release、谁答的、哪一轮）；经验写成，缺省范围是部门（dept:ops），不是全公司', show({ a1: [a1.status, a1.body], n1: n1?.scope, l1 }));

  // ---------- 二 ----------
  const a2 = await release(WHO.管理层, I.v2, { ...VIA, by: 'user:alpha' }); // 请求体里伪造的 by 不认：答的人取请求本身
  const l2 = ledger('work-items', I.v2);
  const r2 = await later(WHO.管理层, { source_id: I.v2, lesson: '报价单先看底价' });
  const rec2 = (await recent(WHO.管理层)).find((x) => x.source_id === I.v2);
  check(a2.status === 200 && released(I.v2) === 1 && a2.body?.remember === undefined && l2.length === 1 && l2[0].answered_by === 'user:root-admin' && r2.status === 201 && r2.body?.status === 'written' && rec2?.answer === 'release',
    '二、照卡片放行、不记（请求体里塞了伪造的 by）：答复账照记，答的人是请求本身认出来的；「我处理过的」里有它，之后补记能记上', show({ a2: [a2.status, a2.body], l2, r2: [r2.status, r2.body], rec2 }));

  // ---------- 三 ----------
  const c3 = kbCalls();
  const a3 = await release(WHO.管理层, I.v3, { remember: { lesson: '不该被看' } });
  const r3 = await later(WHO.管理层, { source_id: I.v3, lesson: '补记直接调的' });
  const ghost = await later(WHO.管理层, { source_id: 'wi_doesnotexist', lesson: '不存在' });
  check(a3.status === 200 && released(I.v3) === 1 && a3.body?.remember === undefined && ledger('work-items', I.v3).length === 0 && kbCalls() === c3
      && r3.status === 404 && r3.text === ghost.text && !(await recent(WHO.管理层)).some((x) => x.source_id === I.v3),
    '三、别处直接调放行（不带 from_attention）：照旧放行，不记账；请求体里的 remember 不看，不写 ygl-trees；之后补记 404（和不存在一样）', show({ a3: [a3.status, a3.body], r3: [r3.status, r3.text], c: [c3, kbCalls()] }));

  // ---------- 四 ----------
  const a4 = await release(WHO.管理层, I.v4, { ...VIA, remember: { lesson: '   ' } });
  check(a4.status === 400 && a4.body?.error === 'remember_invalid' && released(I.v4) === 0 && ledger('work-items', I.v4).length === 0,
    '四、卡片带的 remember 写得不对：400 remember_invalid，事项没放行、没记账', show({ a4: [a4.status, a4.body], released: released(I.v4) }));

  // ---------- 五 ----------
  {
    const r5 = await later(WHO.乙, { source_id: I.v1, lesson: '冒用别人的答复' });
    const g5 = await later(WHO.乙, { source_id: 'wi_doesnotexist', lesson: '不存在' });
    const mine5 = (await recent(WHO.乙)).map((x) => x.source_id);
    check(r5.status === 404 && r5.text === g5.text && !mine5.includes(I.v1) && !mine5.includes(I.v2),
      '五、别人的条目：另一个管理层补记管理层照卡片答的那一条，404（和不存在逐字一样）；他的「我处理过的」里没有', show({ r5: [r5.status, r5.text], g5: g5.text, mine5 }));
  }

  // ---------- 六 ----------
  const c6 = kbCalls();
  const a6 = await release(WHO.负责人, I.lead, { ...VIA, remember: { lesson: '负责人想记给全公司', visibility: 'company' } });
  check(a6.status === 200 && released(I.lead) === 1 && a6.body?.remember?.status === 'refused' && a6.body.remember.error === 'remember_not_allowed' && kbCalls() === c6,
    '六、部门负责人照卡片放行、要求记成「全公司」：放行生效，记成经验被拒（拍板授予只在部门范围，记不了），什么都没写', show({ a6: [a6.status, a6.body], c: [c6, kbCalls()] }));

  // ---------- 七 ----------
  {
    const c7 = kbCalls();
    const k = await call('POST', '/api/a2a/peers/peer_00000000000a/confirm-key', WHO.管理层, { ...VIA, fingerprint: KC(2), remember: { lesson: '换钥先电话核对指纹', visibility: 'company' } });
    await sleep(300);
    const n7 = lastNote();
    const d = await call('POST', '/api/a2a/peers/peer_00000000000b/disable', WHO.管理层, { reason: '合成：直接停用' });
    const lk = ledger('a2a-peers', 'peer_00000000000a'), ld = ledger('a2a-peers', 'peer_00000000000b');
    check(k.status === 200 && k.body?.peer?.status === 'active' && k.body?.remember?.status === 'written' && n7?.scope === '*' && kbCalls() === c7 + 1
        && lk.length === 1 && lk[0].answer === 'confirm-key' && d.status === 200 && d.body?.peer?.status === 'disabled' && d.body?.remember === undefined && ld.length === 0,
      '七、对端公钥：照卡片确认的记进答复账、能记成经验（明确选了全公司就写 *）；直接调停用的照旧生效、不记账', show({ k: [k.status, k.body?.remember], n7: n7?.scope, lk, d: d.status, ld }));
  }

  // ---------- 八 ----------
  {
    const c8 = kbCalls();
    const ap = await call('POST', '/api/bench-views/demo/mcp-requests/1', WHO.管理层, { approve: true, ...VIA, remember: { lesson: '只读工具可以先给' } });
    await sleep(300);
    const n8 = lastNote();
    const rj = await call('POST', '/api/bench-views/demo/mcp-requests/2', WHO.管理层, { approve: false, note: '合成：直接驳回' });
    const l8a = ledger('bench-mcp', 'demo:1'), l8b = ledger('bench-mcp', 'demo:2');
    check(ap.status === 200 && benchReq(1) === 'approved' && ap.body?.remember?.status === 'written' && ap.body.remember.scope_label === '只给管理层' && n8?.scope === 'restricted' && kbCalls() === c8 + 1
        && l8a.length === 1 && l8a[0].answer === 'approve' && rj.status === 200 && benchReq(2) === 'rejected' && rj.body?.remember === undefined && l8b.length === 0,
      '八、台的 MCP 申请：照卡片批的记账、记成经验缺省「只给管理层」（推不出部门，不落到全公司）；直接驳回的照旧生效、不记账', show({ ap: [ap.status, ap.body?.remember], n8: n8?.scope, l8a, rj: rj.status, l8b }));
  }

  // ---------- 九 ----------
  {
    const ap = await call('POST', '/api/bench-views/demo/mcp-requests/3', WHO.管理层, { approve: true, ...VIA });
    await sleep(100);
    check(ap.status === 200 && benchReq(3) === 'approved' && ledger('bench-mcp', 'demo:3').length === 0 && /"event":"attention-via-record-failed"/.test(log),
      '九、记账写不进去：批准照样生效、应答照常（不回滚），只留一条告警（attention-via-record-failed）', show({ ap: [ap.status, ap.body], st: benchReq(3), warned: /attention-via-record-failed/.test(log) }));
  }
  // ---------- 十一 ----------
  {
    // 伪造标记：对一个不在「关注」里的对端（没有待确认的新公钥）带 from_attention 和 remember 直接停用——照旧停用，不记账，记成经验回 404 的说法
    const c11 = kbCalls();
    const d = await call('POST', '/api/a2a/peers/peer_00000000000c/disable', WHO.管理层, { ...VIA, reason: '合成：不在关注里', remember: { lesson: '伪造的卡片' } });
    check(d.status === 200 && d.body?.peer?.status === 'disabled' && ledger('a2a-peers', 'peer_00000000000c').length === 0 && d.body?.remember?.status === 'refused' && d.body.remember.error === 'remember_answer_not_found' && kbCalls() === c11,
      '十一、带了 from_attention、但这一条不在这个人的「关注」里：动作照旧生效，不记账，记成经验回「没答过」（不靠标记就能往账里写）', show({ d: [d.status, d.body?.remember], c: [c11, kbCalls()] }));
  }
  // ---------- 十二 ----------
  {
    // 映射指着一个已经删掉的部门：团队 B 认领到运营部，运营部的记录没了（团队那边还记着部门号）。合成：直接删库里那一行
    const defaults = async () => (await call('GET', `/api/knowledge/remember/defaults?source=work-items&source_id=${encodeURIComponent(I.v4)}`, WHO.管理层)).body;
    const before = await defaults();
    { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS }); try { d.exec('PRAGMA foreign_keys = OFF'); d.prepare("DELETE FROM departments WHERE id = 'ops'").run(); } finally { d.close(); } }
    const after = await defaults();
    const c12 = kbCalls();
    const a12 = await release(WHO.管理层, I.v4, { ...VIA, remember: { lesson: '部门删了以后记的' } });
    await sleep(300);
    const n12 = lastNote();
    check(show(before) === show({ default_visibility: 'department', department_name: '合成运营部' }) && show(after) === show({ default_visibility: 'restricted', department_name: null })
        && a12.status === 200 && released(I.v4) === 1 && a12.body?.remember?.status === 'written' && a12.body.remember.scope_label === '只给管理层' && n12?.scope === 'restricted' && kbCalls() === c12 + 1,
      '十二、部门映射指着已删除的部门：缺省范围的应答从「部门」变成「只给管理层」（不给部门名）；不传 visibility 记成经验，写进去的是 restricted，不按不存在的部门写、不落全公司',
      show({ before, after, a12: [a12.status, a12.body?.remember], n12: n12?.scope }));
  }
  // ---------- 十三 ----------
  {
    // 标记只认严格的 true：写成字符串 "true"、数字 1 的不算卡片发起
    const c13 = kbCalls();
    const s6 = await release(WHO.管理层, I.v6, { from_attention: 'true', remember: { lesson: '字符串标记' } });
    const s7 = await release(WHO.管理层, I.v7, { from_attention: 1, remember: { lesson: '数字标记' } });
    check(s6.status === 200 && released(I.v6) === 1 && s7.status === 200 && released(I.v7) === 1 && ledger('work-items', I.v6).length === 0 && ledger('work-items', I.v7).length === 0
        && s6.body?.remember === undefined && s7.body?.remember === undefined && kbCalls() === c13,
      '十三、from_attention 写成 "true" 或 1：不算卡片发起，放行照常，不记账，remember 不看', show({ s6: [s6.status, s6.body], s7: [s7.status, s7.body], c: [c13, kbCalls()] }));
  }
  // ---------- 十四 ----------
  {
    // 原动作失败（这一轮 held 的投递已经没有了，releaseCore 回 409）：照卡片放行也不记账、不记成经验
    { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS }); try { d.prepare("UPDATE workbench_event_deliveries SET status = 'pending' WHERE status = 'held' AND event_id = (SELECT source_ref FROM work_items WHERE id = ?)").run(I.v8); } finally { d.close(); } }
    const c14 = kbCalls();
    const f = await release(WHO.管理层, I.v8, { ...VIA, remember: { lesson: '失败了也想记' } });
    check(f.status === 409 && ledger('work-items', I.v8).length === 0 && f.body?.remember === undefined && kbCalls() === c14 && !(await recent(WHO.管理层)).some((x) => x.source_id === I.v8),
      '十四、照卡片放行、原动作回非 2xx（409）：答复账里没有这一行，也不记成经验，「我处理过的」里没有', show({ f: [f.status, f.body], l: ledger('work-items', I.v8), c: [c14, kbCalls()] }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`attention-via-ledger-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
