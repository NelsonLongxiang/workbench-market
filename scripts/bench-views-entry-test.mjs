#!/usr/bin/env node
/**
 * 数据视图的入口（/api/bench-views，docs/data-views.md 第三步的前一半）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   一、开关：缺省开（不设就开，没登录的请求由认人那一层回 401）；显式 off 时这组路由每条都回 404（不认人、不建库）；值不合法拒绝启动
 *   二、谁进不了：没登录 401；管理口令 403（读和写都是，带着管理层的登录一起来也是）；没有授予的人 403；
 *       系统管理员角色的授予 403；授予的范围不是「全部」的 403；主体停用 403；本机命令行 403；带跨站标记 403
 *   三、谁进得了：只有管理层（范围「全部」）的人，读写都行。普通员工（范围「全部」）读写都是 403；
 *       带业务写的授予系统管理员一个人给不出去：停在待放行时被授的人全 403，属主放行后才通；
 *       写行的请求体最后才收：没登录、没权限、台没登记、op 不对的，请求体没发完就回了
 *   四、台要先登记：没登记的标识 404，而且数据目录里不会多出库文件；没权限的人看不出台存不存在（都是 403）
 *   五、整条流程：登记台、建数据集、四种写入（请求体原样递给工作线程，5 MB 也收）、查询、快照与退回、
 *       视图保存与版本与回退、取数、表单、留痕；幂等键走请求头
 *   六、出错的样子：只有代号、说明、细目，不带库的报错原文
 *
 *   node scripts/bench-views-entry-test.mjs              测本仓库
 *   node scripts/bench-views-entry-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `bench-views-entry-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-bench-views-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.61' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const running = [];
const openDbs = [];
const openDb = (path) => { const d = new DatabaseSync(path, { timeout: 5000 }); openDbs.push(d); return d; };
async function boot(name, extraEnv = {}, { expectFail = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'admin', WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const driftImport = name === 'publication-race' ? ['--import', pathToFileURL(join(HERE, 'fixtures/bench-render-drift-preload.mjs')).href] : [];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, ...driftImport, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (expectFail ? 20000 : 40000);
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => { if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); } if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); } };
  if (!ready) {
    const selfExit = child.exitCode, listening = await fetch(`${base}/api/health`).then(() => true, () => false);
    await stop();
    if (expectFail) return { failed: true, refused: selfExit !== null && selfExit !== 0 && !listening, log };
    throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  }
  if (expectFail) { await stop(); return { failed: false, log }; }
  /** raw：请求体是原始字节（行的写入）；否则按 JSON 发 */
  const call = async (method, path, { headers = {}, body, raw, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (raw !== undefined) h['content-type'] = 'application/json';
    else if (body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
    } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null }; }
  };
  const srv = { name, base, host: new URL(base).host, data, stop, call, log: () => log, db: () => openDb(join(data, 'workbench-market.db')) };
  running.push(srv);
  return srv;
}

try {
  console.log('一、开关');
  const off = await boot('off', { WM_BENCH_VIEWS: 'off' });
  for (const s of [SESSIONS.admin, SESSIONS.alpha]) await off.call('GET', '/api/auth/viewer', { session: s });
  let r = await off.call('GET', '/api/bench-views', { headers: REMOTE, session: SESSIONS.admin });
  check(r.status === 404 && r.json?.error === 'bench_views_off', '显式 off：/api/bench-views 回 404', r.text.slice(0, 80));
  r = await off.call('GET', '/api/bench-views', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
  check(r.status === 404, '显式 off：带管理口令也是 404（在认人之前就回了）', r.status);
  r = await off.call('POST', '/api/bench-views/x/datasets/a/rows?op=replace', { headers: REMOTE, raw: '[]' });
  check(r.status === 404, '显式 off：行的写入也是 404', r.status);
  check(!existsSync(join(off.data, 'bench-stores')), '显式 off：数据目录里没有台库的目录');
  await off.stop();
  // 不设开关＝开着：路由在，没登录的请求不再是「入口关着」的 404，而是认人那一层的 401
  const dflt = await boot('default');
  r = await dflt.call('GET', '/api/bench-views', { headers: REMOTE });
  check(r.status === 401 && r.json?.error !== 'bench_views_off', '不设开关：缺省开着，没登录回 401（不是入口关着的 404）', r.text.slice(0, 80));
  await dflt.stop();
  const bad = await boot('bad', { WM_BENCH_VIEWS: 'yes' }, { expectFail: true });
  check(bad.failed && bad.refused && /WM_BENCH_VIEWS/.test(bad.log), '开关的值不合法：拒绝启动，说清是哪个变量', bad.log.slice(-200));
  const badTtl = await boot('bad-ttl', { WM_BENCH_VIEWS: 'on', WM_BENCH_REQUEST_TTL_HOURS: '0' }, { expectFail: true });
  check(badTtl.failed && badTtl.refused && /WM_BENCH_REQUEST_TTL_HOURS/.test(badTtl.log), '台的申请期限不合法（0 小时）：拒绝启动，说清是哪个变量', badTtl.log.slice(-200));

  const srv = await boot('on', { WM_BENCH_VIEWS: 'on' });
  const db = srv.db();
  // 让假提供方认出的人进主体表
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: { ...REMOTE, ...same }, session });
  const token = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
  // 授予：本机命令行（属主）起草、提交、放行
  const activate = async (body) => { const d = await srv.call('POST', '/api/grants', { body: { scope: '*', reason: '合成：数据视图入口', ...body } }); const id = d.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); const a = await srv.call('POST', `/api/grants/${id}/approve`); return { id, ok: a.status >= 200 && a.status < 300, d, a }; };
  const g1 = await activate({ principal: 'user:alpha', role: 'management' });
  check(g1.ok, '（准备）alpha 拿到管理层、范围「全部」的授予', { d: g1.d.status, a: g1.a.status, t: g1.a.text.slice(0, 120) });
  const mgr = who(SESSIONS.alpha), nobody = who(SESSIONS.beta), root = who(SESSIONS.admin);

  console.log('二、谁进不了');
  r = await srv.call('GET', '/api/bench-views', { headers: REMOTE });
  check(r.status === 401, '没登录：401', r.status);
  r = await srv.call('GET', '/api/bench-views', token);
  check(r.status === 403 && r.json?.error === 'bench_views_admin_token_denied', '管理口令读：403，说明台里的数据管理口令看不了', r.text.slice(0, 120));
  r = await srv.call('POST', '/api/bench-views', { ...token, body: { slug: 'by-token', title: 'x' } });
  check(r.status === 403 && db.prepare("SELECT COUNT(*) AS n FROM bench_views WHERE slug = 'by-token'").get().n === 0, '管理口令写：403，没有登记出台', r.status);
  r = await srv.call('GET', '/api/bench-views', { headers: { ...REMOTE, ...same, 'x-admin-token': ADMIN_TOKEN }, session: SESSIONS.alpha });
  check(r.status === 403 && r.json?.error === 'bench_views_admin_token_denied', '管理口令带着管理层的登录一起来：照样 403（先认口令）', r.status);
  r = await srv.call('GET', '/api/bench-views', nobody);
  check(r.status === 403 && r.json?.error === 'bench_views_forbidden', '登录了但没有授予：403', r.text.slice(0, 100));
  r = await srv.call('GET', '/api/bench-views', root);
  check(r.status === 403, '身份来源说是管理员、但没有管理层授予的登录：403', r.status);
  // 系统管理员这个角色（范围「全部」）：管得了系统那几块，台里的业务数据看不了、也改不了
  const gSys = await activate({ principal: 'user:root-admin', role: 'admin' });
  r = await srv.call('GET', '/api/bench-views', root);
  const sysWrite = await srv.call('POST', '/api/bench-views', { ...root, body: { slug: 'by-sysadmin', title: 'x' } });
  check(gSys.ok && r.status === 403 && sysWrite.status === 403 && db.prepare("SELECT COUNT(*) AS n FROM bench_views WHERE slug = 'by-sysadmin'").get().n === 0,
    '有系统管理员授予（范围「全部」，已放行）的登录：读写都是 403', { grant: gSys.a.status, read: r.status, write: sysWrite.status });
  r = await srv.call('GET', '/api/bench-views');
  check(r.status === 403, '本机命令行（回环直连、没有登录）：403', r.status);
  r = await srv.call('GET', '/api/bench-views', { headers: { ...REMOTE, origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }, session: SESSIONS.alpha });
  check(r.status === 403 && r.json?.error === 'bench_views_cross_origin_denied', '带跨站标记：403，哪怕是管理层的登录', r.text.slice(0, 100));
  // dept: 范围的管理层授予：部门已停写，新起草 422，经接口造不出来（原来也没建部门 sales，起草同样被拒，这一条一直是空的）。
  // 改成直接写库造停写前就有的那种（scripts/lib/legacy-dept-seed.mjs），并先核它确实在、是 active，免得前置失败时下面的 403 白白成立
  const legacy = legacySeed(join(srv.data, 'workbench-market.db'));
  legacy.department('sales', '合成销售部');
  const g2 = legacy.grant('user:beta', 'management', 'dept:sales', { reason: '合成：数据视图入口' });
  const g2Row = db.prepare('SELECT principal_id, role, scope, status FROM grants WHERE id = ?').get(g2);
  check(g2Row?.principal_id === 'user:beta' && g2Row.role === 'management' && g2Row.scope === 'dept:sales' && g2Row.status === 'active',
    '（前置）beta 持一条生效的 dept:sales 管理层授予（停写前就有的，直接写库造）', g2Row);
  r = await srv.call('GET', '/api/bench-views', nobody);
  check(r.status === 403, '授予的范围不是「全部」（dept:…）：这一步还不认，403', { grant: g2Row?.status, got: r.status });

  console.log('三、谁进得了');
  r = await srv.call('GET', '/api/bench-views', mgr);
  check(r.status === 200 && Array.isArray(r.json?.benches) && r.json.benches.length === 0, '管理层（范围「全部」）：读得到，现在一个台都没有', r.text.slice(0, 120));
  r = await srv.call('POST', '/api/bench-views', { ...mgr, body: { slug: 'demo', title: '示例台' } });
  check(r.status === 201 && r.json?.bench?.created_by === 'user:alpha', '管理层登记一个台：记下是谁建的', r.text.slice(0, 160));
  r = await srv.call('POST', '/api/bench-views', { ...mgr, body: { slug: 'demo', title: '再来一个' } });
  check(r.status === 409 && r.json?.error === 'conflict', '同一个标识再登记：冲突', r.text.slice(0, 120));
  r = await srv.call('POST', '/api/bench-views', { ...mgr, body: { slug: '../x', title: 't' } });
  check(r.status === 400, '标识写法不对：拒', r.status);
  // 普通员工、范围「全部」：每个登录过的员工迁移之后都有这样一条。读写都进不来——不然入口一开全公司都读得到所有台
  const g3 = await activate({ principal: 'user:beta', role: 'member' });
  const ALL_ROUTES = [['GET', ''], ['POST', ''], ['GET', '/demo/datasets'], ['PUT', '/demo/datasets/x'], ['POST', '/demo/datasets/x/rows?op=append'], ['POST', '/demo/query'],
    ['GET', '/demo/datasets/x/snapshots'], ['POST', '/demo/datasets/x/snapshots'], ['POST', '/demo/restore'], ['GET', '/demo/view'], ['PUT', '/demo/view'], ['GET', '/demo/view/versions'],
    ['GET', '/demo/view/diff?a=1&b=2'], ['GET', '/demo/changes'], ['POST', '/demo/view/rollback'], ['GET', '/demo/render'], ['POST', '/demo/form'], ['GET', '/demo/log']];
  const memberGot = [];
  for (const [m, path] of ALL_ROUTES) memberGot.push((await srv.call(m, `/api/bench-views${path}`, { ...nobody, ...(m === 'GET' ? {} : path.includes('/rows') ? { raw: '[]' } : { body: {} }) })).status);
  check(g3.ok && ALL_ROUTES.length === 18 && memberGot.every((x) => x === 403), '只有普通员工授予（范围「全部」）的人：18 条路由读写全是 403', memberGot.join());

  console.log('三之一、带业务写的授予：系统管理员一个人给不出去');
  // 管理口令（只有系统管理员身份）起草一条「部门成员、范围全部」给 strasse 并提交，自己放行不了；停在待放行时 strasse 哪条路由都进不来
  await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.strasse });
  const pendingOne = who(SESSIONS.strasse);
  const draft = await srv.call('POST', '/api/grants', { ...token, body: { principal: 'user:strasse', role: 'dept-member', scope: '*', reason: '合成：系统管理员起草' } });
  const gid = draft.json?.grant?.id;
  const submitted = await srv.call('POST', `/api/grants/${gid}/submit`, token);
  const selfApprove = await srv.call('POST', `/api/grants/${gid}/approve`, token);
  const stateOf = () => db.prepare('SELECT status FROM grants WHERE id = ?').get(gid)?.status;
  const tryAll = async () => { const got = []; for (const [m, path] of ALL_ROUTES) got.push((await srv.call(m, `/api/bench-views${path}`, { ...pendingOne, ...(m === 'GET' ? {} : path.includes('/rows') ? { raw: '[]' } : { body: {} }) })).status); return got; };
  const before = await tryAll();
  check(gid !== undefined && submitted.status < 300 && selfApprove.status >= 400 && stateOf() !== 'active' && before.every((x) => x === 403),
    '管理口令起草、提交了，自己放行不了；停在待放行时被授的人 18 条路由全是 403', { draft: draft.status, submit: submitted.status, approve: selfApprove.status, state: stateOf(), got: before.join() });
  const released = await srv.call('POST', `/api/grants/${gid}/approve`);
  const after = await tryAll();
  check(released.status < 300 && stateOf() === 'active' && after.every((x) => x !== 403 && x !== 401), '属主（本机命令行）放行之后：这个人进得来了（不再是 403）', { approve: released.status, state: stateOf(), got: after.join() });

  console.log('三之二、写行的请求体：没过门的不读');
  // 只发请求头和 1 MB 的开头，后面的不发、也不结束请求：服务端要是先收请求体再判，就会一直等下去
  const early = (path, headers) => new Promise((done) => {
    const u = new URL(srv.base + path);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(30 * 1024 * 1024), ...headers } });
    const timer = setTimeout(() => { req.destroy(); done({ status: 0, waited: true }); }, 4000);
    req.on('response', (res) => { clearTimeout(timer); res.resume(); req.destroy(); done({ status: res.statusCode, waited: false }); });
    req.on('error', () => {});
    req.write(Buffer.alloc(1024 * 1024, 0x20));
  });
  let e1 = await early('/api/bench-views/demo/datasets/x/rows?op=append', REMOTE);
  check(e1.status === 401 && !e1.waited, '远程匿名发 30 MB 的写入：请求体没发完就回了 401（服务端没去读它）', e1);
  e1 = await early('/api/bench-views/ghost/datasets/x/rows?op=append', { ...mgr.headers, cookie: `session_id=${SESSIONS.alpha}` });
  check(e1.status === 404 && !e1.waited, '有权限但台没登记：请求体没发完就回了 404', e1);
  e1 = await early('/api/bench-views/demo/datasets/x/rows?op=append', { ...nobody.headers, cookie: `session_id=${SESSIONS.beta}` });
  check(e1.status === 403 && !e1.waited, '登录了但没权限：请求体没发完就回了 403', e1);
  e1 = await early('/api/bench-views/demo/datasets/x/rows?op=nope', { ...mgr.headers, cookie: `session_id=${SESSIONS.alpha}` });
  check(e1.status === 400 && !e1.waited, 'op 不认识：请求体没发完就回了 400', e1);

  console.log('四、台要先登记');
  r = await srv.call('GET', '/api/bench-views/ghost/datasets', mgr);
  check(r.status === 404 && r.json?.error === 'bench_not_found', '没登记的标识：404', r.text.slice(0, 100));
  r = await srv.call('PUT', '/api/bench-views/ghost/datasets/a', { ...mgr, body: { columns: [{ name: 'a', type: 'text' }] } });
  check(r.status === 404 && !existsSync(join(srv.data, 'bench-stores', 'ghost.sqlite')), '往没登记的台写：404，数据目录里没有多出库文件', r.status);
  const a = await srv.call('GET', '/api/bench-views/ghost/datasets', who(SESSIONS.admin)), b = await srv.call('GET', '/api/bench-views/demo/datasets', who(SESSIONS.admin));
  check(a.status === 403 && b.status === 403, '没权限的人看不出台存不存在：登记过的、没登记的都是 403', { ghost: a.status, demo: b.status });

  console.log('五、整条流程');
  const B = '/api/bench-views/demo';
  r = await srv.call('PUT', `${B}/datasets/orders`, { ...mgr, body: { title: '订单', key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'day', type: 'date', label: '日期' }, { name: 'region', type: 'text', label: '地区' }, { name: 'amount', type: 'decimal', label: '金额' }] } });
  check(r.status === 200 && r.json?.created === true, '建数据集', r.text.slice(0, 160));
  const rows = [{ id: 1, day: '2026-01-05', region: '东区', amount: 1200.5 }, { id: 2, day: '2026-01-20', region: '南区', amount: 860 }];
  const key = (k) => ({ ...mgr, headers: { ...mgr.headers, 'idempotency-key': k } });
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=replace`, { ...key('entry-replace-0001'), raw: JSON.stringify(rows) });
  check(r.status === 200 && r.json?.row_count === 2 && r.json?.op === 'replace', '整份替换：请求体是行的数组', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=replace`, { ...key('entry-replace-0001'), raw: JSON.stringify(rows) });
  check(r.status === 200 && r.json?.duplicate === true, '带同一个幂等键（请求头）再发：认得是同一次', r.text.slice(0, 120));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=upsert`, { ...mgr, raw: JSON.stringify([{ id: 2, day: '2026-01-20', amount: 900 }, { id: 3, day: '2026-02-02', region: '东区', amount: 15 }]) });
  check(r.status === 200 && r.json?.inserted === 1 && r.json?.updated === 1, '按主键更新', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=append`, { ...mgr, raw: JSON.stringify([{ id: 4, day: '2026-02-03', region: '西区', amount: 5 }]) });
  check(r.status === 200 && r.json?.inserted === 1, '追加', r.text.slice(0, 120));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=delete`, { ...mgr, raw: JSON.stringify([{ id: 4 }]) });
  const snapId = r.json?.snapshot_id;
  check(r.status === 200 && r.json?.deleted === 1 && Number.isInteger(snapId), '按主键删行：删之前留了快照', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/datasets/orders/rows/?op=upsert`, { ...mgr, raw: JSON.stringify([{ id: 3, day: '2026-02-02', region: '东区', amount: 15 }]) });
  check(r.status === 200 && r.json?.updated === 1, '地址带尾斜杠：照常写入（请求体没被全局解析先读掉）', r.text.slice(0, 120));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=nope`, { ...mgr, raw: '[]' });
  check(r.status === 400 && r.json?.error === 'invalid', '不认识的 op：拒', r.text.slice(0, 100));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=append`, { ...mgr, raw: '[{"id": 9, "day": ' });
  check(r.status === 400 && /JSON/.test(r.json?.message ?? ''), '请求体不是合法的 JSON：拒', r.text.slice(0, 120));
  // 5 MB 的请求体：全局的 JSON 解析上限是 4 MB，这条路由不经它
  await srv.call('PUT', `${B}/datasets/bulk`, { ...mgr, body: { key: ['id'], columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }] } });
  const bulk = JSON.stringify(Array.from({ length: 2600 }, (_, i) => ({ id: i, body: 'x'.repeat(1990) })));
  r = await srv.call('POST', `${B}/datasets/bulk/rows?op=replace`, { ...mgr, raw: bulk });
  check(bulk.length > 5_000_000 && r.status === 200 && r.json?.row_count === 2600, '5 MB 的请求体：收得下（原样递给工作线程，不经全局的 JSON 解析）', { bytes: bulk.length, status: r.status, t: r.text.slice(0, 100) });
  r = await srv.call('POST', `${B}/query`, { ...mgr, body: { query: { dataset: 'orders', group: ['region'], measures: [{ as: 'n', fn: 'count' }], sort: [{ col: 'region' }] } } });
  check(r.status === 200 && r.json?.rows?.length === 2, '查询', r.text.slice(0, 160));
  r = await srv.call('GET', `${B}/datasets/orders/snapshots`, mgr);
  check(r.status === 200 && r.json?.snapshots?.some((x) => x.id === snapId), '列出快照', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/restore`, { ...mgr, body: { snapshot_id: snapId, note: '退回删行之前' } });
  check(r.status === 200 && r.json?.row_count === 4, '退回快照：删掉的那一行回来了', r.text.slice(0, 160));
  const doc = { title: '订单台', views: [
    { key: 'overview', title: '总览', blocks: [
      { type: 'filter-bar', fields: [{ name: 'month', kind: 'month' }] },
      { type: 'stat', title: '金额', query: { dataset: 'orders', filter: [{ col: 'day', op: 'prefix', value: '$month' }], measures: [{ as: 'v', fn: 'sum', col: 'amount' }] }, value: 'v' },
      { type: 'table', query: { dataset: 'orders', sort: [{ col: 'id' }] } } ] },
    { key: 'entry', title: '补录', blocks: [{ type: 'form', dataset: 'orders', fields: ['id', 'day', 'region', 'amount'] }] } ] };
  r = await srv.call('PUT', `${B}/view`, { ...mgr, body: { doc, base: 0, note: '首版' } });
  check(r.status === 200 && r.json?.version === 1, '保存视图描述', r.text.slice(0, 160));
  r = await srv.call('PUT', `${B}/view`, { ...mgr, body: { doc: { ...doc, title: '订单台二版' }, base: 0, note: '基于旧版' } });
  check(r.status === 409 && r.json?.error === 'conflict', '基于旧版保存：冲突，不覆盖', r.text.slice(0, 120));
  r = await srv.call('PUT', `${B}/view`, { ...mgr, body: { doc: { ...doc, title: '订单台二版' }, base: 1, note: '改标题' } });
  check(r.status === 200 && r.json?.version === 2, '基于当前版保存：新版本', r.text.slice(0, 120));
  r = await srv.call('GET', `${B}/view/versions`, mgr);
  check(r.status === 200 && r.json?.versions?.length === 2 && r.json.versions[0].author === 'user:alpha', '版本清单：记着是谁改的', r.text.slice(0, 200));
  r = await srv.call('GET', `${B}/view/diff?a=1&b=2`, mgr);
  check(r.status === 200 && r.json?.diff?.some((d) => d.path === '/title'), '两版的差异', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/view/rollback`, { ...mgr, body: { to: 1, base: 2, note: '回到首版' } });
  check(r.status === 200 && r.json?.active_version === 1, '回退：首版重新生效', r.text.slice(0, 120));
  r = await srv.call('GET', `${B}/render?view=overview&p.month=2026-01&p.nope=x`, mgr);
  check(r.status === 200 && r.json?.blocks?.[1]?.data?.rows?.[0]?.v === 2100.5 && Object.keys(r.json.params).join() === 'month', '取数：筛选栏的值经查询串给，没声明的不认', r.text.slice(0, 200));
  r = await srv.call('POST', `${B}/form`, { ...key('entry-form-000001'), body: { view: 'entry', block: 0, version: 1, values: { id: 50, day: '2026-03-01', region: '北区', amount: 7 } } });
  check(r.status === 200 && r.json?.op === 'form' && r.json?.inserted === 1, '表单提交', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/form`, { ...mgr, body: { view: 'entry', block: 0, version: 2, values: { id: 51, day: '2026-03-01' } } });
  check(r.status === 409, '表单：页面拿的不是现在生效的那一版，拒', r.status);
  r = await srv.call('GET', `${B}/log`, mgr);
  check(r.status === 200 && r.json?.writes?.[0]?.actor === 'user:alpha' && r.json?.changes?.length > 0 && !JSON.stringify(r.json).includes('北区'), '留痕：谁、做了什么；只有摘要，没有内容', r.text.slice(0, 200));
  r = await srv.call('GET', '/api/bench-views', mgr);
  check(r.status === 200 && r.json?.benches?.map((x) => x.slug).join() === 'demo' && readdirSync(join(srv.data, 'bench-stores')).filter((f) => f.endsWith('.sqlite')).join() === 'demo.sqlite', '台的清单里只有登记过的那一个；数据目录里也只有它的库', readdirSync(join(srv.data, 'bench-stores')));

  console.log('五之一、变更游标（docs/task-graph-step1.md 第五节之六）');
  {
    const cur = async (who = mgr) => srv.call('GET', `${B}/changes`, who);
    let c = await cur();
    const c0 = c.json?.cursor;
    check(c.status === 200 && typeof c0 === 'string' && c0.length >= 16 && Object.keys(c.json).join() === 'cursor' && /private, no-store/.test(c.headers?.['cache-control'] ?? ''), '有权：回一个游标，只有游标、不缓存', { s: c.status, t: c.text.slice(0, 120) });
    r = await srv.call('GET', `${B}/render?view=overview`, mgr);
    check(r.status === 200 && r.json?.cursor === c0, '取数回应带同一个游标', { render: r.json?.cursor, changes: c0 });
    c = await cur();
    check(c.json?.cursor === c0, '没有改动：游标不变');
    r = await srv.call('POST', `${B}/datasets/orders/rows?op=upsert`, { ...mgr, raw: JSON.stringify([{ id: 3, day: '2026-02-02', region: '东区', amount: 16 }]) });
    c = await cur();
    const c1 = c.json?.cursor;
    check(r.status === 200 && r.json?.row_count === 5 && c1 !== c0, '同一视图版本、行数不变的 upsert：游标变（普通行写入推进 bs_writes）', { upsert: r.text.slice(0, 80), c0, c1 });
    r = await srv.call('POST', `${B}/datasets/orders/snapshots`, { ...mgr, body: { note: '游标测试' } });
    const sid = r.json?.snapshot_id ?? r.json?.id;
    c = await cur(); const c2 = c.json?.cursor;
    r = await srv.call('POST', `${B}/restore`, { ...mgr, body: { snapshot_id: sid, note: '游标测试' } });
    c = await cur();
    check(r.status === 200 && c.json?.cursor !== c2, '退回快照：游标变', { restore: r.text.slice(0, 80) });
    const c3 = c.json?.cursor;
    const v = await srv.call('GET', `${B}/view`, mgr);
    r = await srv.call('PUT', `${B}/view`, { ...mgr, body: { doc: { ...doc, title: '订单台三版' }, base: v.json.view.active_version, note: '游标测试' } });
    c = await cur();
    check(r.status === 200 && c.json?.cursor !== c3, '保存视图（启用版本变）：游标变', r.text.slice(0, 80));
    c = await srv.call('GET', `${B}/changes?view=overview`, mgr);
    check(c.status === 400, '不收查询参数', c.status);
    c = await cur(nobody);
    check(c.status === 403 && !c.text.includes('cursor'), '台上没有授予：403，不给游标', c.status);
    c = await srv.call('GET', `${B}/changes`, { headers: REMOTE });
    check(c.status === 401, '没登录：401', c.status);
    c = await srv.call('GET', '/api/bench-views/ghost/changes', mgr);
    check(c.status === 404, '台没登记：判过权才 404', c.status);
    c = await srv.call('GET', '/api/bench-views/ghost/changes', nobody);
    check(c.status === 403, '没权限的人问不存在的台：403，不露台在不在', c.status);
  }

  console.log('六、出错的样子');
  r = await srv.call('POST', `${B}/query`, { ...mgr, body: { query: { dataset: 'orders', filter: [{ col: 'id', op: 'constructor', value: 1 }] } } });
  check(r.status === 400 && Object.keys(r.json ?? {}).every((k) => ['error', 'message', 'details'].includes(k)) && !/SQLITE|ds_orders|c_id/.test(r.text), '写法不对：只有代号、说明、细目，不带库的报错原文', r.text.slice(0, 160));
  r = await srv.call('POST', `${B}/datasets/orders/rows?op=append`, { ...mgr, raw: JSON.stringify([{ id: 1, day: '2026-01-05' }]) });
  check(r.status === 409, '主键撞了：冲突', r.text.slice(0, 120));
  r = await srv.call('GET', `${B}/datasets/nope/snapshots`, mgr);
  check(r.status === 404 && r.json?.error === 'not_found', '没有这个数据集：404', r.text.slice(0, 100));

  console.log('六之一、本台常量变量的视图绑定');
  const card = await srv.call('POST', '/api/workbenches', { body: { name: '合成变量台', url: 'http://127.0.0.1:9/', type: 'web' } });
  const wid = card.json?.id;
  check(card.status === 201 && Number.isInteger(wid), '绑定准备：创建卡片', card.text.slice(0, 100));
  r = await srv.call('PUT', "/api/bench-views/demo/workbench", { ...mgr, body: { workbench_id: wid, note: '合成绑定' } });
  check(r.status === 200, '绑定准备：视图台只关联本卡片', r.text.slice(0, 100));
  const putVar = (key, value, extra = {}) => srv.call('PUT', '/api/workbenches/' + wid + '/vars/' + key, { body: { value, ...extra } });
  await putVar('completed', 37);
  await putVar('target', 100, { kind: 'const' });
  await putVar('secret_unused', 984321);
  await putVar('bad_value', 'not a number');
  const beforeView = await srv.call('GET', B + '/view', mgr);
  const bindDoc = { title: '合成绑定', views: [{ key: 'board', title: '总览', blocks: [
    { type: 'stat', title: '已完成', value: { var: 'completed' } },
    { type: 'progress', value: { var: 'completed' }, total: { var: 'target' } },
    { type: 'stat', title: '缺键', value: { var: 'missing' } },
    { type: 'stat', title: '坏类型', value: { var: 'bad_value' } },
    { type: 'stat', title: '对照', query: { dataset: 'orders', measures: [{ fn: 'count', as: 'n' }] }, value: 'n', tone_rules: [{ col: 'n', op: '<', value: { var: 'target' }, tone: 'warning' }] },
  ] }] };
  r = await srv.call('PUT', B + '/view', { ...mgr, body: { doc: bindDoc, base: beforeView.json.view.active_version, note: '合成引用' } });
  check(r.status === 200, '保存引用视图：无数据集的指标和进度可用', r.text.slice(0, 160));
  r = await srv.call('GET', B + '/render', mgr);
  const bound = r.json?.blocks ?? [];
  check(r.status === 200 && bound[0]?.data?.rows?.[0]?.[bound[0].value] === 37 && bound[1]?.total === 100, '真实 render：指标、进度值与常量目标', r.text.slice(0, 180));
  check(bound[0]?.var_revisions?.completed === 1 && bound[1]?.var_revisions?.target === 1 && !r.text.includes('secret_unused') && !r.text.includes('984321'), '只返回显式选择的数值与 revision，不枚举空间', r.text.slice(0, 160));
  check(bound[2]?.error?.code === 'not_found' && !bound[2]?.data && bound[3]?.error?.code === 'invalid' && !bound[3]?.data && bound[4]?.tone_rules?.[0]?.value === 100, '缺键和坏类型是块错，其他块及阈值正常', r.text.slice(0, 160));
  const beforeVar = (await srv.call('GET', B + '/changes', mgr)).json?.cursor;
  await putVar('completed', 38, { revision: 1 });
  check(typeof beforeVar === 'string' && (await srv.call('GET', B + '/changes', mgr)).json?.cursor === beforeVar, '工作台变量变了：游标不变（第 1 步不随变量自动刷新，写明在设计稿）');
  r = await srv.call('GET', B + '/render', mgr);
  check(r.json?.blocks?.[0]?.data?.rows?.[0]?.[r.json.blocks[0].value] === 38 && r.json.blocks[0].var_revisions.completed === 2, '修改原变量后重新 render 读到新值和 revision');
  r = await srv.call('GET', '/api/workbenches/' + wid + '/vars/completed', mgr);
  check(r.status === 403, '原变量 REST 门不变：只有管理层业务授予仍不能直接读变量', r.status);
  r = await srv.call('GET', B + '/render?var=secret_unused', mgr);
  check(r.status === 200 && r.json?.blocks?.every(b => b.error?.code === 'invalid' && !b.data) && !r.text.includes('984321'), '请求参数不能额外选择变量：明确块错，不输出任何值');
  const activeView = await srv.call('GET', B + '/view', mgr);
  for (const ref of [{ var: 'completed', bench: 999 }, { var: 'completed', path: '/x' }, { var: 'x[0]' }, { var: 'x + y' }]) {
    r = await srv.call('PUT', B + '/view', { ...mgr, body: { doc: { title: '拒绝', views: [{ key: 'v', title: 'v', blocks: [{ type: 'stat', value: ref }] }] }, base: activeView.json.view.active_version, note: '应被拒绝' } });
    check(r.status === 400, '跨台、子路径或表达式引用保存即拒：' + JSON.stringify(ref), r.status);
  }
  r = await srv.call('GET', '/api/bench-views/ghost/render?var=secret_unused', nobody);
  check(r.status === 403, '无权请求先拒绝，不探台或变量', r.status);

  console.log('六之三、任务图 dag（docs/task-graph-step1.md）：保存 → 取数');
  {
    r = await srv.call('PUT', `${B}/datasets/tasks`, { ...mgr, body: { title: '任务', key: ['id'], columns: [{ name: 'id', type: 'text', label: '编号' }, { name: 'name', type: 'text', label: '任务' }, { name: 'deps', type: 'text', label: '前置' }, { name: 'role', type: 'text', label: '角色' }, { name: 'st', type: 'text', label: '状态' }, { name: 'pct', type: 'integer', label: '进度' }] } });
    check(r.status === 200, '任务数据集', r.text.slice(0, 120));
    const tasks = (n) => Array.from({ length: n }, (_, i) => ({ id: 't' + i, name: '任务' + i, deps: i ? 't' + (i - 1) : null, role: i === 0 ? 'start' : i === n - 1 ? 'end' : null, st: i === 0 ? 'done' : 'todo', pct: i === 0 ? 100 : 0 }));
    r = await srv.call('POST', `${B}/datasets/tasks/rows?op=replace`, { ...mgr, raw: JSON.stringify(tasks(3)) });
    check(r.status === 200, '写 3 个任务', r.text.slice(0, 120));
    const cur = await srv.call('GET', B + '/view', mgr);
    const dagBase = { type: 'dag', id_col: 'id', label_col: 'name', deps_col: 'deps', role_col: 'role', status_col: 'st', progress_col: 'pct', detail_cols: ['st', 'pct'] };
    const dagDoc = { title: '任务图', views: [{ key: 'tasks', title: '任务', blocks: [{ ...dagBase, query: { dataset: 'tasks' } }, { ...dagBase, title: '只看待办', query: { dataset: 'tasks', filter: [{ col: 'st', op: 'eq', value: 'todo' }] } }] }] };
    r = await srv.call('PUT', B + '/view', { ...mgr, body: { doc: dagDoc, base: cur.json.view.active_version, note: '任务图' } });
    check(r.status === 200, '保存任务图视图', r.text.slice(0, 160));
    const after = await srv.call('GET', B + '/view', mgr);
    r = await srv.call('PUT', B + '/view', { ...mgr, body: { doc: { ...dagDoc, views: [{ ...dagDoc.views[0], blocks: [{ ...dagBase, query: { dataset: 'tasks', limit: 10 } }] }] }, base: after.json.view.active_version, note: '应被拒绝' } });
    check(r.status === 400 && r.text.includes('limit'), '任务图的查询写 limit：保存即拒', r.text.slice(0, 160));
    r = await srv.call('GET', B + '/render?view=tasks', mgr);
    const [full, part] = r.json?.blocks ?? [];
    check(r.status === 200 && full?.type === 'dag' && full.data?.rows?.length === 3 && full.data.truncated === false && full.graph_meta?.filtered === false && full.data.columns.find((c) => c.name === 'deps')?.label === '前置', '取数：全量块回 3 行、没截断、不算筛选、列带说明名', r.text.slice(0, 200));
    check(part?.graph_meta?.filtered === true && part.data?.rows?.length === 2, '有 filter 的块：标成筛选（部分结果）', part?.graph_meta);
    await srv.call('POST', `${B}/datasets/tasks/rows?op=replace`, { ...mgr, raw: JSON.stringify(tasks(500)) });
    r = await srv.call('GET', B + '/render?view=tasks', mgr);
    check(r.json?.blocks?.[0]?.data?.rows?.length === 500 && r.json.blocks[0].data.truncated === false, '恰好 500 个：全部取回、不算截断', { n: r.json?.blocks?.[0]?.data?.rows?.length, t: r.json?.blocks?.[0]?.data?.truncated });
    await srv.call('POST', `${B}/datasets/tasks/rows?op=replace`, { ...mgr, raw: JSON.stringify(tasks(501)) });
    r = await srv.call('GET', B + '/render?view=tasks', mgr);
    check(r.json?.blocks?.[0]?.data?.rows?.length === 500 && r.json.blocks[0].data.truncated === true, '501 个：只取 500 个、标截断', { n: r.json?.blocks?.[0]?.data?.rows?.length, t: r.json?.blocks?.[0]?.data?.truncated });
    await srv.call('POST', `${B}/datasets/tasks/rows?op=replace`, { ...mgr, raw: JSON.stringify(tasks(502)) });
    r = await srv.call('GET', B + '/render?view=tasks', mgr);
    check(r.json?.blocks?.[0]?.data?.rows?.length === 500 && r.json.blocks[0].data.truncated === true, '502 个：同样只取 500 个、标截断');
  }

  console.log('六之二、最终 HTTP 发布屏障');
  const raceSrv = await boot('publication-race', { WM_BENCH_VIEWS: 'on' });
  await raceSrv.call('GET', '/api/auth/viewer', { session: SESSIONS.alpha });
  const raceWho = { session: SESSIONS.alpha, headers: { ...REMOTE, origin: raceSrv.base, 'sec-fetch-site': 'same-origin' } };
  const grantDraft = await raceSrv.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'management', scope: '*', reason: '合成竞态' } });
  await raceSrv.call('POST', '/api/grants/' + grantDraft.json.grant.id + '/submit');
  await raceSrv.call('POST', '/api/grants/' + grantDraft.json.grant.id + '/approve');
  const raceCard = await raceSrv.call('POST', '/api/workbenches', { body: { name: '合成竞态卡片', url: 'http://127.0.0.1:9/' } });
  await raceSrv.call('POST', '/api/bench-views', { ...raceWho, body: { slug: 'binding-race', title: '合成竞态', workbench_id: raceCard.json.id } });
  await raceSrv.call('PUT', '/api/bench-views/binding-race/datasets/d', { ...raceWho, body: { columns: [{ name: 'n', type: 'integer', label: '数值' }] } });
  await raceSrv.call('POST', '/api/bench-views/binding-race/datasets/d/rows?op=replace', { ...raceWho, raw: JSON.stringify([{ n: 984321 }]) });
  await raceSrv.call('PUT', '/api/bench-views/binding-race/view', { ...raceWho, body: { base: 0, note: '合成竞态', doc: { title: '合成', views: [{ key: 'v', title: 'v', blocks: [{ type: 'stat', query: { dataset: 'd' }, value: 'n' }] }] } } });
  const raced = await raceSrv.call('GET', '/api/bench-views/binding-race/render', raceWho);
  check(raced.status === 403 && !raced.text.includes('984321') && !raced.text.includes('var_revisions'), '真实 HTTP：adapter返回后、路由发布前微任务改绑，整份响应拒绝无数据残留', { status: raced.status, body: raced.text.slice(0, 160) });

  console.log('七、停用');
  await srv.call('POST', '/api/principals/disable', { body: { id: 'user:alpha', reason: '合成' } });
  r = await srv.call('GET', '/api/bench-views', mgr);
  check(r.status === 401 || r.status === 403, '主体停用之后：进不来', r.status);
  r = await srv.call('GET', B + '/changes', mgr);
  check((r.status === 401 || r.status === 403) && !r.text.includes('cursor'), '主体停用之后：变更游标也拿不到', r.status);
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  for (const d of openDbs) d.close();
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`bench-views-entry-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
