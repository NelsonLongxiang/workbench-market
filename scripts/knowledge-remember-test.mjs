#!/usr/bin/env node
/**
 * 经验库第 2 步：拍板时「把这次的取舍记成经验」（对抗组）。隔离实例：假的登录提供方、假的 ygl-trees 命令行（scripts/fixtures/ygl-library-fake.mjs），
 * 名册、部门、团队、事项都是合成的；只在 127.0.0.1 上，不碰任何外部系统。
 *
 *   现场：团队 A 认领到销售部（部门负责人 beta）；团队 B 认领到运营部（运营部没有负责人：团队 B 缺负责人，持有管理层授予的人代办放行）。
 *   一、管理层在「关注」里代办放行团队 B 的事项，顺带记成经验：答复照常生效；写进 ygl-trees（kb add），范围是事项所在团队的部门（dept:ops）；
 *       正文开头是 cue / lesson / evidence 三项 frontmatter（能直接 promote），正文是中性写法（模板里没有「你」），evidence 是不透明引用（不露事项号、主体）；
 *       同步以后经验库里有这一条，带拍板人的名字（decided_by_name），范围说法是部门名；只有普通员工授予的人看不到（部门级要有这个部门的授予）
 *   二、同一次答复再记一次（补记接口）：200、duplicate，不再写
 *   三、remember 写得不对（lesson 空）：答复整个被拒（400），事项没放行
 *   四、ygl-trees 暂时不通（rc 1）：答复照常生效，经验待写；同步状态里待写 1；恢复后后台重试写成
 *   五、参数被 ygl-trees 拒（rc 2）：放弃（failed），不再重试；同步状态里放弃 1
 *   六、谁不能记：部门负责人（拍板授予只在部门范围）答复照常生效、记成经验被拒（refused）；管理口令补记 403；匿名 401；跨站 403
 *   七、没答过、别人答的：补记 404（和不存在一样）
 *   八、明确选「全公司」：写成 *，普通员工也看得到
 *
 *   node scripts/knowledge-remember-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `knowledge-remember-${process.pid}-${Date.now().toString(36)}`);
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
    WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', WM_YGL_CLI: FAKE_CLI, YGL_HOME: ygl, WM_KNOWLEDGE_SYNC_MINUTES: '0', WM_KNOWLEDGE_WRITE_RETRY_SECONDS: '1' };
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
      v4: mk('合成：合同待放行', ${JSON.stringify(VACANT)}), lead: mk('合成：交给有负责人的团队', ${JSON.stringify(TEAM)}) };
    console.log('SEEDED ' + JSON.stringify(out));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    const now = Date.now();
    db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)').run(HOST, PEER, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
    // 团队归属绑节点时要对端登记（启用、带指纹，合成的）；没有这条规则的版本上多一行也不碍事
    db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('peer-rem', ?, 'zone1', '', 'active', 'sha256:' || ?, 'seed', '0', '0')").run(PEER, HOST);
    const seatIns = db.prepare('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)');
    seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', now, now);
    seatIns.run(HOST, VACANT, 'zone1/0000000d', 'seat-0000000d', '合成别队', 'router', now, now);
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
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const WHO = { 管理层: { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, 负责人: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 普通员工: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  const cli = (method, path, body) => call(method, path, {}, body);
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成：记成经验' }); await cli('POST', `/api/grants/${d.body?.grant?.id}/submit`, {}); return (await cli('POST', `/api/grants/${d.body?.grant?.id}/approve`, {})).status; };
  const setup = [
    (await cli('PUT', '/api/departments/sales', { name: '合成销售部', lead: 'user:beta' })).status,
    (await cli('PUT', '/api/departments/ops', { name: '合成运营部' })).status,
    (await cli('POST', '/api/teams/claim', { host: HOST, team: TEAM, department: 'sales' })).status,
    (await cli('POST', '/api/teams/claim', { host: HOST, team: VACANT, department: 'ops' })).status,
    await grant('user:root-admin', 'management'), await grant('user:alpha', 'member'),
  ];
  if (!setup.every((s) => s >= 200 && s < 300)) throw new Error(`现场搭不起来：${show(setup)}`);
  const answer = (h, id, remember) => call('POST', '/api/attention/answer', h, { source: 'work-items', source_id: id, answer: 'release', ...(remember !== undefined ? { remember } : {}) });
  const later = (h, body) => call('POST', '/api/knowledge/remember', h, { source: 'work-items', ...body });
  const kbList = async (h) => ((await call('GET', '/api/knowledge?kind=kb', h)).body?.items ?? []);
  const released = (id) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return Number(d.prepare("SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ? AND fact = 'release'").get(id).n); } finally { d.close(); } };
  const status = async () => (await call('GET', '/api/knowledge/status', { 'x-admin-token': ADMIN_TOKEN })).body?.writes;
  const lastNote = () => { const f = JSON.parse(readFileSync(FX, 'utf8')); const n = f.items.note.at(-1); return n ? { ...n, body: f.bodies[`note:${n.id}`]?.body } : null; };

  // ---------- 一 ----------
  const a1 = await answer(WHO.管理层, I.v1, { lesson: '先核对样品批次号和检验单，再放行' });
  await sleep(300);
  const note1 = lastNote();
  const mgList = await kbList(WHO.管理层), alList = await kbList(WHO.普通员工);
  const got1 = mgList.find((x) => x.title === '合成：样品批次待放行');
  check(a1.status === 200 && a1.body?.remember?.status === 'written' && a1.body.remember.duplicate === false && a1.body.remember.scope_label === '部门' && released(I.v1) === 1,
    '一、管理层代办放行顺带记成经验：答复生效（放行了），经验写成，范围取事项所在团队的部门', show({ a1: [a1.status, a1.body?.remember], released: released(I.v1) }));
  const fm = /^---\ncue: "(.*)"\nlesson: "(.*)"\nevidence: "(market:answer\/[A-Za-z0-9_-]{22})"\n---\n/.exec(note1?.body ?? '');
  check(note1?.scope === 'dept:ops' && fm && fm[1] === '合成：样品批次待放行' && fm[2] === '先核对样品批次号和检验单，再放行' && !note1.body.includes('你')
      && !note1.body.includes(I.v1) && !note1.body.includes('user:') && /^遇到「合成：样品批次待放行」时：/m.test(note1.body),
    '一、写进 ygl-trees 的那一条：范围 dept:ops；正文开头 cue / lesson / evidence 三项（能直接 promote）；正文中性写法、没有「你」；evidence 是不透明引用，不露事项号、主体', show(note1));
  check(got1?.decided_by_name === 'Synthetic root-admin' && got1.scope_label === '合成运营部' && !alList.some((x) => x.title === '合成：样品批次待放行'),
    '一、同步以后经验库里有这一条：带拍板人的名字、范围说法是部门名；只有普通员工授予的人看不到（部门级要这个部门的授予）', show({ got1, alpha: alList.map((x) => x.title) }));

  // ---------- 二 ----------
  const before2 = kbCalls();
  const d2 = await later(WHO.管理层, { source_id: I.v1, lesson: '先核对样品批次号和检验单，再放行' });
  check(d2.status === 200 && d2.body?.duplicate === true && d2.body.status === 'written' && kbCalls() === before2,
    '二、同一次答复再记（补记接口）：200、duplicate，不再写 ygl-trees', show({ d2: [d2.status, d2.body], calls: [before2, kbCalls()] }));

  // ---------- 三 ----------
  const bad = await answer(WHO.管理层, I.v2, { lesson: '   ' });
  check(bad.status === 400 && bad.body?.error === 'remember_invalid' && released(I.v2) === 0,
    '三、remember 写得不对（lesson 空）：答复整个被拒（400），事项没放行', show({ bad: [bad.status, bad.body?.error], released: released(I.v2) }));

  // ---------- 四 ----------
  fixture({ kb_add_fail: 'exit1' });
  const a4 = await answer(WHO.管理层, I.v2, { lesson: '报价超过底价两成要先问销售负责人', visibility: 'restricted' });
  const s4 = await status();
  check(a4.status === 200 && released(I.v2) === 1 && a4.body?.remember?.status === 'pending' && s4?.pending === 1,
    '四、ygl-trees 暂时不通（rc 1）：答复照常生效（放行了），经验待写；同步状态里待写 1', show({ a4: [a4.status, a4.body?.remember], s4 }));
  fixture({ kb_add_fail: undefined });
  let s4b = null;
  for (let i = 0; i < 40; i++) { await sleep(250); s4b = await status(); if (s4b?.pending === 0) break; }
  await sleep(300);
  const got4 = (await kbList(WHO.管理层)).find((x) => x.title === '合成：报价单待放行');
  check(s4b?.pending === 0 && got4?.scope_label === '只给管理层' && got4.decided_by_name === 'Synthetic root-admin' && !(await kbList(WHO.普通员工)).some((x) => x.title === '合成：报价单待放行'),
    '四、恢复以后后台重试写成：待写清零，经验库里有这一条（只给管理层，普通员工看不到）', show({ s4b, got4 }));

  // ---------- 五 ----------
  fixture({ kb_add_fail: 'exit2' });
  const a5 = await answer(WHO.管理层, I.v3, { lesson: '发货前确认收货地址' });
  const c5 = kbCalls();
  fixture({ kb_add_fail: undefined });
  await sleep(2500);
  const s5 = await status();
  check(a5.status === 200 && released(I.v3) === 1 && a5.body?.remember?.status === 'failed' && s5?.failed === 1 && kbCalls() === c5,
    '五、参数被 ygl-trees 拒（rc 2）：答复照常生效，经验放弃（failed），之后不再重试；同步状态里放弃 1', show({ a5: [a5.status, a5.body?.remember], s5, calls: [c5, kbCalls()] }));

  // ---------- 六 ----------
  const a6 = await answer(WHO.负责人, I.lead, { lesson: '负责人自己的取舍' });
  const tok = await later(ADMIN, { source_id: I.v4, lesson: 'x' });
  const anon = await call('POST', '/api/knowledge/remember', { 'x-forwarded-for': '192.0.2.82' }, { source: 'work-items', source_id: I.v4, lesson: 'x' });
  const cross = await call('POST', '/api/knowledge/remember', { ...WHO.管理层, 'sec-fetch-site': 'cross-site' }, { source: 'work-items', source_id: I.v4, lesson: 'x' });
  check(a6.status === 200 && released(I.lead) === 1 && a6.body?.remember?.status === 'refused' && a6.body.remember.error === 'remember_not_allowed'
      && tok.status === 403 && anon.status === 401 && cross.status === 403,
    '六、部门负责人答复照常生效、记成经验被拒（拍板授予只在部门范围）；管理口令补记 403；匿名 401；跨站 403', show({ a6: [a6.status, a6.body?.remember], tok: tok.status, anon: anon.status, cross: cross.status }));

  // ---------- 七 ----------
  const n7a = await later(WHO.管理层, { source_id: I.lead, lesson: '别人答的' });
  const n7b = await later(WHO.管理层, { source_id: 'wi_doesnotexist', lesson: '不存在' });
  check(n7a.status === 404 && n7b.status === 404 && n7a.text === n7b.text,
    '七、补记别人答的、不存在的：一样回 404，应答逐字相同', show({ n7a: [n7a.status, n7a.text], n7b: n7b.status }));

  // ---------- 八 ----------
  const a8 = await answer(WHO.管理层, I.v4);
  const r8 = await later(WHO.管理层, { source_id: I.v4, lesson: '合同金额以盖章版为准', visibility: 'company' });
  await sleep(300);
  const note8 = lastNote();
  const al8 = (await kbList(WHO.普通员工)).find((x) => x.title === '合成：合同待放行');
  check(a8.status === 200 && r8.status === 201 && r8.body?.status === 'written' && r8.body.scope_label === '全公司' && note8?.scope === '*' && al8?.scope_label === '全公司' && al8.decided_by_name === 'Synthetic root-admin',
    '八、答完以后补记、明确选「全公司」：写成 *，普通员工也看得到（带拍板人的名字）；没给 cue 时用事项的标题', show({ a8: a8.status, r8: [r8.status, r8.body], note8: note8?.scope, al8 }));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`knowledge-remember-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
