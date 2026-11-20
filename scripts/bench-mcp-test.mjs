#!/usr/bin/env node
/**
 * 数据视图的 MCP 工具（docs/data-views.md 第十节 3b）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   一、没有授予：目录里没有这些工具，调用和「没有这个工具」一个样；台存不存在看不出来
 *   二、申请：必须写成 工具@bench:台（读也一样）；不和别的工具混；一次一个台；重复的认得；台没登记也照收（不泄露）
 *   三、系统管理员那条路给不了：会话的 grants 里写不进这些工具；管理口令看不了、批不了台上的申请；
 *       就算库里的 grants 被直接改了也不生效
 *   四、台的管理层批：普通员工批不了；批准之后生效；批过的不能再批；别的台的申请批不到
 *   五、只在批了的那个台、批了的那几个工具上生效：别的台、别的工具、别的会话都不行
 *   六、写：建数据集、写行（幂等键）、存视图；留痕里是 mcp:<会话名>；出错只有代号、说明、细目
 *   七、收回：立即失效；会话吊销之后它的申请批不了
 *   七之二、「等你拍板」里的待批清单：只有有拍板权限的人看得到、答得了；答法和直接调路由是同一处判断
 *   七之二b、写成卡片号、卡片还没开台库的申请：看得到、批得成（批准时顺带开台库）；不能登记台的角色批不了；
 *           驳回、会话吊销不开台库；改绑、删卡片时这种申请一起驳回
 *   八、入口关着：工具不在目录里、调不了、申请不了。网关关着：别的工具放开了，这些照样调不了
 *
 *   node scripts/bench-mcp-test.mjs              测本仓库
 *   node scripts/bench-mcp-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `bench-mcp-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-bench-mcp-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.61' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const running = [];
const openDbs = [];
const openDb = (p) => { const d = new DatabaseSync(p, { timeout: 5000 }); openDbs.push(d); return d; };
async function boot(name, extraEnv = {}, { expectFail = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'admin', WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      return { status: res.status, text, json };
    } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null }; }
  };
  const srv = { name, base, host: new URL(base).host, data, stop, call, log: () => log, db: () => openDb(join(data, 'workbench-market.db')) };
  running.push(srv);
  return srv;
}


/** 经 /mcp 调一个工具。返回 { rpcError, isError, json, text } */
async function tool(srv, token, name, args) {
  const r = await srv.call('POST', '/mcp', { headers: token ? { authorization: `Bearer ${token}` } : {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const res = r.json?.result, text = res?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 出错时是一句话 */ }
  return { status: r.status, rpcError: r.json?.error?.code ?? null, isError: res?.isError === true, json, text };
}
const listed = async (srv, token) => ((await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json?.result?.tools ?? []).map((t) => t.name);
const BENCH_TOOLS = ['dataset_list', 'dataset_query', 'dataset_snapshots', 'view_get', 'view_versions', 'view_diff', 'dataset_define', 'dataset_replace', 'dataset_upsert', 'dataset_append', 'dataset_delete_rows', 'dataset_snapshot', 'dataset_restore', 'view_put', 'view_rollback'];

try {
  const srv = await boot('on', { WM_BENCH_VIEWS: 'on' });
  const db = srv.db();
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: { ...REMOTE, ...same }, session });
  const admin = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
  const activate = async (body) => { const d = await srv.call('POST', '/api/grants', { body: { scope: '*', reason: '合成：数据视图的 MCP 工具', ...body } }); const id = d.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); return (await srv.call('POST', `/api/grants/${id}/approve`)).status; };
  await activate({ principal: 'user:alpha', role: 'management' });
  await activate({ principal: 'user:beta', role: 'member' });
  const mgr = who(SESSIONS.alpha), member = who(SESSIONS.beta);
  const mk = async (name) => { const r = await srv.call('POST', '/api/mcp/sessions', { ...admin, body: { name } }); return { id: r.json?.id, token: r.json?.token, name }; };
  const A = await mk('sess-a'), B = await mk('sess-b');
  for (const slug of ['demo', 'other']) await srv.call('POST', '/api/bench-views', { ...mgr, body: { slug, title: slug } });
  await srv.call('PUT', '/api/bench-views/demo/datasets/seed', { ...mgr, body: { key: ['id'], columns: [{ name: 'id', type: 'integer' }, { name: 'secret', type: 'text' }] } });
  await srv.call('POST', '/api/bench-views/demo/datasets/seed/rows?op=replace', { ...mgr, raw: JSON.stringify([{ id: 1, secret: 'bench-only-marker' }]) });
  check(typeof A.token === 'string' && typeof B.token === 'string', '（准备）两个会话、两个台、demo 里一个数据集');

  console.log('一、没有授予');
  let names = await listed(srv, A.token);
  check(names.length > 0 && !names.some((n) => BENCH_TOOLS.includes(n)), '工具目录（tools/list）里没有数据视图的工具', names.filter((n) => BENCH_TOOLS.includes(n)));
  let r = await tool(srv, A.token, 'dataset_list', { bench: 'demo' });
  const unknown = await tool(srv, A.token, 'no_such_tool', {});
  const ghost = await tool(srv, A.token, 'dataset_list', { bench: 'ghost' });
  check(r.rpcError === -32601 && unknown.rpcError === -32601 && ghost.rpcError === -32601, '调用：和没有这个工具一个样；台登记过没有也看不出来', { demo: r.rpcError, unknown: unknown.rpcError, ghost: ghost.rpcError });
  r = await tool(srv, A.token, 'dataset_query', { bench: 'demo', query: { dataset: 'seed' } });
  check(r.rpcError === -32601 && !r.text.includes('bench-only-marker'), '读也一样：没有授予读不到一行');
  r = await tool(srv, A.token, 'access_info', {});
  const cat = r.json?.catalog?.find((t) => t.name === 'dataset_list');
  check(cat?.bench_scoped === true && cat?.scope === '必须限定到台' && cat?.granted === false && Array.isArray(cat?.granted_benches) && cat.granted_benches.length === 0 && /bench:/.test(r.json?.how_to_request_bench ?? ''), 'access_info：标着「必须限定到台」，还没有授予，写明怎么申请', cat);

  console.log('二、申请');
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list'], reason: 'x' });
  check(r.isError && /必须限定到台/.test(r.text) && /dataset_list@bench:/.test(r.text), '不带台：拒，提示写成 工具@bench:台', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@7'], reason: 'x' });
  check(r.isError && /必须限定到台/.test(r.text), '写成 工具@数字（工作台的写法）：拒', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@bench:demo', 'workbench_list'], reason: 'x' });
  check(r.isError && /单独申请/.test(r.text), '和别的工具混在一条里：拒', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@bench:demo', 'dataset_list@bench:other'], reason: 'x' });
  check(r.isError && /一个台/.test(r.text), '一条里两个台：拒', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@bench:demo'], reason: '' });
  check(r.isError && /reason/.test(r.text), '不写用途：拒', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@bench:demo', 'dataset_query@bench:demo'], reason: '读订单做日报' });
  const reqId = r.json?.request?.id;
  check(r.json?.ok === true && r.json.duplicate === false && r.json.request.bench === 'demo' && r.json.request.status === 'pending' && r.json.request.decided_by === undefined, '写对了：收下，等台的管理层批（应答里没有审批人）', r.text.slice(0, 200));
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_query@bench:demo', 'dataset_list@bench:demo'], reason: '读订单做日报' });
  check(r.json?.duplicate === true && r.json.request.id === reqId, '同样的再申请一次：认得是同一条');
  const g = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@bench:ghost'], reason: '探一下' });
  check(g.json?.ok === true && g.json.request.status === 'pending', '台没登记：照收，应答和登记过的一个样（看不出台存不存在）', g.text.slice(0, 160));
  r = await tool(srv, A.token, 'access_info', {});
  check(r.json?.bench_requests?.some((x) => x.id === reqId && x.status === 'pending') && !r.json?.requests?.some((x) => JSON.stringify(x).includes('bench:')), 'access_info：自己的申请看得到，和工作台那类申请分开列');

  console.log('三、系统管理员那条路给不了');
  r = await srv.call('PUT', `/api/mcp/sessions/${A.id}/grants`, { ...admin, body: { grants: ['dataset_list'] } });
  const r2 = await srv.call('PUT', `/api/mcp/sessions/${A.id}/grants`, { ...admin, body: { grants: ['dataset_list@bench:demo'] } });
  check(r.status === 400 && r2.status === 400 && /台的管理层/.test(r.text) && db.prepare('SELECT grants FROM mcp_sessions WHERE id = ?').get(A.id).grants === '[]', '管理口令改会话的 grants：这些工具写不进去（带不带台都是 400）', { bare: r.status, scoped: r2.status });
  r = await srv.call('GET', '/api/mcp/access-requests', admin);
  check(r.status === 200 && !r.text.includes('dataset_list') && !r.text.includes('读订单做日报'), '管理口令看 MCP 网关页的申请清单：里面没有台的申请');
  r = await srv.call('GET', '/api/bench-views/demo/mcp-grants', admin);
  const dec = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${reqId}`, { ...admin, body: { approve: true } });
  const put = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...admin, body: { session: 'sess-a', tools: ['dataset_list'] } });
  check(r.status === 403 && dec.status === 403 && put.status === 403 && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants').get().n === 0, '管理口令到台上看、批、直接给：都是 403，没有产生授予', { list: r.status, decide: dec.status, put: put.status });
  db.prepare('UPDATE mcp_sessions SET grants = ? WHERE id = ?').run(JSON.stringify(['dataset_list', 'dataset_list@bench:demo', 'dataset_query']), B.id);
  r = await tool(srv, B.token, 'dataset_list', { bench: 'demo' });
  names = await listed(srv, B.token);
  check(r.rpcError === -32601 && !names.includes('dataset_list'), '就算库里会话的 grants 被直接改成带这些工具：不生效');
  db.prepare("UPDATE mcp_sessions SET grants = '[]' WHERE id = ?").run(B.id);

  console.log('四、台的管理层批');
  r = await srv.call('GET', '/api/bench-views/demo/mcp-grants', { headers: REMOTE });
  check(r.status === 401, '没登录看台上的授予：401', r.status);
  r = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${reqId}`, { ...member, body: { approve: true } });
  const mList = await srv.call('GET', '/api/bench-views/demo/mcp-grants', member);
  check(r.status === 403 && mList.status === 403, '普通员工（范围「全部」）看台上的授予、批申请：都是 403', { decide: r.status, list: mList.status });
  // 能改台里的数据、但没有「拍板」的角色（部门成员，范围「全部」）：数据改得了，替会话开权限不行
  await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.strasse });
  const gStaff = await activate({ principal: 'user:strasse', role: 'dept-member' });
  const staff = who(SESSIONS.strasse);
  const sw = await srv.call('PUT', '/api/bench-views/other/datasets/t', { ...staff, body: { columns: [{ name: 'a', type: 'text' }] } });
  const sd = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${reqId}`, { ...staff, body: { approve: true } });
  const sg = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...staff, body: { session: 'sess-a', tools: ['dataset_list'] } });
  check(sw.status === 200 && sd.status === 403 && sg.status === 403 && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants').get().n === 0, '有「做」没有「拍板」的角色：改得了数据，批不了申请、也给不了授予', { grant: gStaff, write: sw.status, decide: sd.status, put: sg.status });
  r = await srv.call('GET', '/api/bench-views/demo/mcp-grants', mgr);
  check(r.status === 200 && r.json?.requests?.some((x) => x.id === reqId && x.session === 'sess-a' && x.reason === '读订单做日报') && r.json.grants.length === 0, '管理层看得到这条申请：哪个会话、要什么、为什么', r.text.slice(0, 200));
  r = await srv.call('GET', '/api/bench-views/other/mcp-grants', mgr);
  check(r.status === 200 && r.json?.requests?.length === 0, '别的台上看不到这条申请');
  r = await srv.call('POST', `/api/bench-views/other/mcp-requests/${reqId}`, { ...mgr, body: { approve: true } });
  check(r.status === 404, '到别的台上批这条申请：404', r.status);
  r = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${reqId}`, { ...mgr, body: { approve: 'yes' } });
  check(r.status === 400, 'approve 不是布尔：拒', r.status);
  r = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${reqId}`, { ...mgr, body: { approve: true, note: '可以' } });
  check(r.status === 200 && r.json?.status === 'approved' && r.json.granted.join() === 'dataset_list,dataset_query', '管理层批准', r.text.slice(0, 160));
  r = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${reqId}`, { ...mgr, body: { approve: false } });
  check(r.status === 409, '批过的再定一次：冲突', r.status);
  const au = db.prepare("SELECT bench, actor, action, tools, request_id FROM bench_mcp_audit WHERE action = 'approve'").get();
  check(au?.bench === 'demo' && au.actor === 'user:alpha' && au.request_id === reqId && au.tools === '["dataset_list","dataset_query"]', '留痕：谁批的、哪个台、哪几个工具', au);

  console.log('五、只在批了的台和工具上生效');
  r = await tool(srv, A.token, 'dataset_list', { bench: 'demo' });
  check(!r.isError && r.json?.datasets?.[0]?.name === 'seed', '批了的会话在批了的台上：读得到', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'dataset_query', { bench: 'demo', query: { dataset: 'seed' } });
  check(r.json?.rows?.[0]?.secret === 'bench-only-marker', '查询也行');
  r = await tool(srv, A.token, 'dataset_list', { bench: 'other' });
  check(r.rpcError === -32601, '同一个会话到别的台：不行', r.rpcError);
  r = await tool(srv, A.token, 'dataset_define', { bench: 'demo', definition: { name: 'x', columns: [{ name: 'a', type: 'text' }] } });
  const r3 = await tool(srv, A.token, 'view_get', { bench: 'demo' });
  check(r.rpcError === -32601 && r3.rpcError === -32601, '没批的工具（写的、别的读的）：不行', { define: r.rpcError, view_get: r3.rpcError });
  r = await tool(srv, B.token, 'dataset_list', { bench: 'demo' });
  check(r.rpcError === -32601, '别的会话：不行', r.rpcError);
  r = await tool(srv, A.token, 'dataset_list', { bench: ['demo'] });
  const r4 = await tool(srv, A.token, 'dataset_list', {});
  check(r.rpcError === -32601 && r4.rpcError === -32601, 'bench 不是字符串、没写 bench：不行', { array: r.rpcError, none: r4.rpcError });
  // 授予还在、台却没登记（登记被撤了，或者库里留着旧的授予）：不行，也不会建出库文件
  db.prepare('INSERT INTO bench_mcp_grants (session_id, bench, tool, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run(A.id, 'never-registered', 'dataset_list', 'user:alpha', 1);
  r = await tool(srv, A.token, 'dataset_list', { bench: 'never-registered' });
  check(r.rpcError === -32601 && !existsSync(join(srv.data, 'bench-stores', 'never-registered.sqlite')), '有授予但台没登记：不行，数据目录里没有多出库文件', r.rpcError);
  db.prepare("DELETE FROM bench_mcp_grants WHERE bench = 'never-registered'").run();
  names = await listed(srv, A.token);
  check(BENCH_TOOLS.filter((n) => names.includes(n)).join() === 'dataset_list,dataset_query', '目录里现在只多了批了的那两个', names.filter((n) => BENCH_TOOLS.includes(n)));
  r = await tool(srv, A.token, 'access_info', {});
  check(r.json?.catalog?.find((t) => t.name === 'dataset_list')?.granted_benches?.join() === 'demo' && r.json.catalog.find((t) => t.name === 'view_put')?.granted === false, 'access_info：写着在哪个台上有');
  r = await srv.call('POST', '/api/mcp-rest/tools/dataset_list', { headers: { authorization: `Bearer ${A.token}` }, body: { bench: 'demo' } });
  const rb = await srv.call('POST', '/api/mcp-rest/tools/dataset_list', { headers: { authorization: `Bearer ${B.token}` }, body: { bench: 'demo' } });
  check(r.status === 200 && rb.status === 403 && !rb.text.includes('seed'), 'REST 渠道同一个口径：批了的 200，没批的 403', { a: r.status, b: rb.status });

  console.log('六、写');
  r = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...member, body: { session: 'sess-a', tools: ['dataset_list'] } });
  check(r.status === 403, '普通员工直接给授予：403', r.status);
  r = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgr, body: { session: 'sess-a', tools: ['workbench_list'] } });
  const r5 = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgr, body: { session: 'no-such-seat', tools: ['dataset_list'] } });
  check(r.status === 400 && r5.status === 404, '给的不是数据视图的工具：拒；会话不存在：404', { tool: r.status, session: r5.status });
  r = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgr, body: { session: 'sess-a', tools: ['dataset_list', 'dataset_query', 'dataset_define', 'dataset_replace', 'view_put', 'view_get'], note: '让它维护日报' } });
  check(r.status === 200 && r.json?.added?.join() === 'dataset_define,dataset_replace,view_get,view_put' && r.json.removed.length === 0, '管理层直接改这个会话在台上的工具', r.text.slice(0, 200));
  r = await tool(srv, A.token, 'dataset_define', { bench: 'demo', definition: { name: 'daily', key: ['day'], columns: [{ name: 'day', type: 'date', label: '日期' }, { name: 'n', type: 'integer', label: '件数' }] } });
  check(!r.isError && r.json?.created === true, '会话建数据集', r.text.slice(0, 120));
  const rows = [{ day: '2026-01-01', n: 3 }, { day: '2026-01-02', n: 5 }];
  r = await tool(srv, A.token, 'dataset_replace', { bench: 'demo', dataset: 'daily', rows, idempotency_key: 'mcp-replace-0001', note: '日报' });
  const again = await tool(srv, A.token, 'dataset_replace', { bench: 'demo', dataset: 'daily', rows, idempotency_key: 'mcp-replace-0001', note: '日报' });
  check(r.json?.row_count === 2 && again.json?.duplicate === true, '会话整份替换；带同一个幂等键再发认得是同一次', { first: r.text.slice(0, 80), again: again.text.slice(0, 80) });
  r = await tool(srv, A.token, 'view_put', { bench: 'demo', doc: { title: '日报', views: [{ key: 'main', title: '总览', blocks: [{ type: 'table', query: { dataset: 'daily', sort: [{ col: 'day' }] } }] }] }, base: 0, note: '首版' });
  const vg = await tool(srv, A.token, 'view_get', { bench: 'demo' });
  check(r.json?.version === 1 && vg.json?.view?.active_version === 1, '会话存视图、读回来');
  // 表格的列都要有说明名：聚合出来的列没给 label，会话存也拒，点名缺的是哪一列；不产生新版本
  r = await tool(srv, A.token, 'view_put', { bench: 'demo', doc: { title: '日报', views: [{ key: 'main', title: '总览', blocks: [{ type: 'table', query: { dataset: 'daily', group: ['day'], measures: [{ as: 'total', fn: 'sum', col: 'n' }] } }] }] }, base: 1, note: '缺说明名' });
  check(/列 total 没有说明名/.test(r.text) && (await tool(srv, A.token, 'view_get', { bench: 'demo' })).json?.view?.active_version === 1, '会话存视图：表格的列没有说明名就拒，点名是哪一列', r.text.slice(0, 200));
  check(/references\/view-doc-schema\.json/.test(r.text), '被拒时应答里指向技能里的完整契约（view_put 的参数说明里只有大致形状）', r.text.slice(0, 200));
  r = await srv.call('GET', '/api/bench-views/demo/log', mgr);
  check(r.json?.writes?.some((w) => w.actor === 'mcp:sess-a') && r.json.changes.some((c) => c.actor === 'mcp:sess-a'), '台的留痕里记的是 mcp:<会话名>', r.text.slice(0, 160));
  r = await tool(srv, A.token, 'dataset_replace', { bench: 'demo', dataset: 'daily', rows: [{ day: 'not-a-date', n: 'x' }] });
  check(r.isError && /"error":"invalid"/.test(r.text) && /details/.test(r.text) && !/SQLITE|sqlite|INSERT INTO/.test(r.text), '写坏了的行：代号、说明、细目，没有库的报错原文', r.text.slice(0, 200));
  r = await tool(srv, A.token, 'dataset_list', { bench: 'demo', extra: 1 });
  check(r.isError && /不认识这些参数/.test(r.text), '多给了不认识的参数：拒', r.text.slice(0, 100));
  r = await tool(srv, A.token, 'view_put', { bench: 'demo', doc: {}, base: '1', note: 'x' });
  check(r.isError && /base/.test(r.text), '编号写成文字：拒', r.text.slice(0, 100));

  console.log('七、收回');
  r = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgr, body: { session: 'sess-a', tools: [] } });
  const after = await tool(srv, A.token, 'dataset_list', { bench: 'demo' });
  check(r.status === 200 && r.json?.removed?.length === 6 && after.rpcError === -32601, '管理层全收回：下一次调用就不行了', { removed: r.json?.removed?.length, after: after.rpcError });
  check(db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_audit WHERE action = 'revoke' AND actor = 'user:alpha' AND bench = 'demo'").get().n === 1, '收回也留痕');
  r = await tool(srv, B.token, 'access_request', { tools: ['dataset_list@bench:demo'], reason: '吊销之前提的' });
  const bReq = r.json?.request?.id;
  await srv.call('DELETE', `/api/mcp/sessions/${B.id}`, admin);
  r = await srv.call('POST', `/api/bench-views/demo/mcp-requests/${bReq}`, { ...mgr, body: { approve: true } });
  const dead = await tool(srv, B.token, 'dataset_list', { bench: 'demo' });
  check(r.status === 409 && dead.status === 401 && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE session_id = ?').get(B.id).n === 0, '会话吊销之后：它的申请批不了，令牌也进不来', { decide: r.status, call: dead.status });
  r = await srv.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgr, body: { session: 'sess-b', tools: ['dataset_list'] } });
  check(r.status === 409, '给吊销了的会话直接授予：拒', r.status);
  console.log('七之二、「等你拍板」里的待批清单');
  r = await tool(srv, A.token, 'access_request', { tools: ['dataset_list@bench:other', 'dataset_append@bench:other'], reason: '往 other 里追加' });
  const att1 = r.json?.request?.id;
  r = await tool(srv, A.token, 'access_request', { tools: ['view_get@bench:other'], reason: '看页面' });
  const att2 = r.json?.request?.id;
  const attention = async (opts) => (await srv.call('GET', '/api/attention', opts)).json;
  const mine = (v) => (v?.items ?? []).filter((x) => x.source === 'bench-mcp');
  const answer = (opts, source_id, ans, input = {}) => srv.call('POST', '/api/attention/answer', { ...opts, body: { source: 'bench-mcp', source_id, answer: ans, input } });
  let v = await attention(mgr);
  const card = mine(v).find((x) => x.source_id === `other:${att1}`);
  check(mine(v).filter((x) => x.source_id.startsWith('other:')).length === 2 && card?.category === 'grant' && card.kind === 'bench-mcp' && card.mine === true && card.answers.join() === 'approve,reject' && card.waiting_for === 'mcp:sess-a'
    && card.detail?.bench === 'other' && card.detail.session === 'sess-a' && card.detail.reason === '往 other 里追加' && card.detail.tools.map((t) => `${t.tool}:${t.category}`).join() === 'dataset_append:write,dataset_list:read' && /含写/.test(card.title) && card.answer_via?.method === 'POST' && card.answer_via.path === `/api/bench-views/other/mcp-requests/${att1}` && JSON.stringify(card.answer_via.answers) === JSON.stringify({ approve: { body: { approve: true, from_attention: true }, input: { note: { to: 'note', max: 500 } } }, reject: { body: { approve: false, from_attention: true }, input: { note: { to: 'note', required: true, max: 500 } } } }) && Object.keys(card.answer_via.answers).join() === card.answers.join(),
    '管理层的「关注」里有这两条：哪个会话、哪个台、要哪几个工具（读写分开）、为什么', JSON.stringify(mine(v)).slice(0, 300));
  check(!mine(v).some((x) => x.source_id.startsWith('ghost:') || x.source_id.startsWith('cap-')), '台没登记的申请不在清单里（没有人能批它）');
  check(db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_requests WHERE id = ? AND status = 'pending'").get(bReq).n === 1 && !mine(v).some((x) => x.source_id === `demo:${bReq}`) && mine(v).length === 2, '吊销了的会话之前提的申请不在清单里（批不了）；台上的管理页里还看得到', mine(v).map((x) => x.source_id));
  const seen = {};
  for (const [name, opts] of [['管理口令', admin], ['普通员工', member], ['有做没有拍板', staff], ['身份来源说的管理员', who(SESSIONS.admin)], ['本机命令行', {}]]) { const x = await attention(opts); seen[name] = `${mine(x).length}/${x?.sources?.['bench-mcp']?.visible}`; }
  check(Object.values(seen).every((x) => x === '0/false'), '管理口令、普通员工、有做没有拍板的角色、没有授予的管理员、本机命令行：清单里都没有这类条目', seen);
  r = await answer(admin, `other:${att1}`, 'approve');
  const r6 = await answer(member, `other:${att1}`, 'approve');
  const r7 = await answer(staff, `other:${att1}`, 'approve');
  check(r.status === 403 && r.json?.error === 'bench_views_admin_token_denied' && r6.status === 403 && r7.status === 403 && db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = 'other'").get().n === 0, '他们来答：和直接调那条路由一样被拒（管理口令 403、没有拍板 403），没有产生授予', { token: r.text.slice(0, 60), member: r6.status, staff: r7.status });
  // 答复入口 /api/attention/answer 对登录的人放开了（L20）：过不过得了不看是不是管理员，由条目的来源判——这里就是台上那条路由的判断。
  // 所以管理层（不是管理员）经它答和直接调台上的路由（条目的 detail.answer_via 写着）是同一处判断，两条路都通；下面批的那一步就用这个人。
  await activate({ principal: 'user:root-admin', role: 'management' });
  const boss = who(SESSIONS.admin);
  r = await answer(mgr, `other:${att1}`, 'reject', {});
  check(r.status === 400 && r.json?.result?.error === 'reason_required' && db.prepare('SELECT status FROM bench_mcp_requests WHERE id = ?').get(att1).status === 'pending' && db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = 'other'").get().n === 0,
    '管理层（不是管理员）经答复入口答：进得来，由台上那条路由判——不批不写理由照样被拒，申请还在', r.text.slice(0, 120));
  r = await answer(boss, `other:${att2}`, 'reject', {});
  check(r.status === 400 && r.json?.result?.error === 'reason_required' && db.prepare('SELECT status FROM bench_mcp_requests WHERE id = ?').get(att2).status === 'pending', '不批不写理由：拒，申请还在', r.text.slice(0, 120));
  const wrong = [];
  for (const bad of ['other', `other:${att1}:x`, `../other:${att1}`, `OTHER:${att1}`, 'other:0', `demo:${att1}`]) { const x = await answer(mgr, bad, 'approve'); if (x.status < 400) wrong.push(bad); }
  check(wrong.length === 0 && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE request_id IN (?, ?)').get(att1, att2).n === 0, '条目 id 写错、写成别的台：都被拒，没批成', wrong);
  r = await answer(mgr, `other:${att1}`, 'approve', { note: '可以', approve: false, session: 'sess-b' });
  check(r.status === 200 && r.json?.result?.status === 'approved' && r.json.duplicate === false && db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = 'other' AND session_id = ?").get(A.id).n === 2
    && db.prepare("SELECT actor FROM bench_mcp_audit WHERE request_id = ? AND action = 'approve'").get(att1)?.actor === 'user:alpha', '管理层（不是管理员）经答复入口批：生效，留痕记的是这个人；多带的字段不算数', r.text.slice(0, 160));
  r = await answer(mgr, `other:${att1}`, 'approve');
  check(r.status === 200 && r.json?.duplicate === true && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_audit WHERE request_id = ?').get(att1).n === 1, '同一条再答一次：认得是答过的，不再生效', r.text.slice(0, 100));
  // 照条目的 answer_via 拼请求：固定的字段加上填的那一项
  const via = mine(await attention(mgr)).find((x) => x.source_id === `other:${att2}`).answer_via;
  const noReason = await srv.call(via.method, via.path, { ...mgr, body: { ...via.answers.reject.body } });
  r = await srv.call(via.method, via.path, { ...mgr, body: { ...via.answers.reject.body, [via.answers.reject.input.note.to]: '页面由人改' } });
  const info2 = await tool(srv, A.token, 'access_info', {});
  check(noReason.status === 400 && r.status === 200 && r.json?.status === 'rejected' && info2.json?.bench_requests?.find((x) => x.id === att2)?.note === '页面由人改' && !mine(await attention(mgr)).some((x) => x.source_id.startsWith('other:')), '管理层照条目的 answer_via 答：不批不写理由被拒；写了理由生效，申请的会话看得到理由；清单里没有了', r.text.slice(0, 120));
  r = await tool(srv, A.token, 'dataset_list', { bench: 'other' });
  check(!r.isError && Array.isArray(r.json?.datasets), '批了之后会话在那个台上用得了');

  console.log('七之二b、写成卡片号的申请：卡片还没开台库也看得到、批得成（批准时顺带开台库）');
  // 属主 11-18 实际踩到的：会话写的是卡片 id，那张卡片还没开台库。原来「关注」里看不到，照台上的路由批又回 404 bench_not_found
  const mkCard = (name) => Number(db.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run(name, `/apps/${name}/`).lastInsertRowid);
  const WC = mkCard('合成卡片甲'), WD = mkCard('合成卡片乙');
  const H = await mk('sess-h');
  const h1 = await tool(srv, H.token, 'access_request', { tools: [`dataset_list@bench:${WC}`, `dataset_query@bench:${WC}`], reason: '维护卡片甲的数据' });
  const h2 = await tool(srv, H.token, 'access_request', { tools: [`view_get@bench:wb-${WC}`], reason: '看卡片甲的页面' });
  const h3 = await tool(srv, H.token, 'access_request', { tools: [`dataset_list@bench:${WD}`], reason: '卡片乙，要被驳回的' });
  const h4 = await tool(srv, H.token, 'access_request', { tools: ['dataset_list@bench:987654'], reason: '没有这张卡片' });
  // 开台库之前提、开了之后还没定的：申请表里存的是卡片号（开了之后再提的，MCP 那一层先换成台标识再存）
  const h6 = await tool(srv, H.token, 'access_request', { tools: [`dataset_snapshots@bench:${WC}`], reason: '开台库之前提的，留到改绑' });
  check([h1, h2, h3, h4].every((x) => x.json?.ok === true && x.json.request.status === 'pending') && h1.json.request.bench === String(WC) && h4.json.request.bench === '987654',
    '（准备）会话写卡片号申请：照收，应答里的台照会话写的原样（不透露卡片开没开台库）', [h1, h2, h3, h4].map((x) => x.text.slice(0, 80)));
  v = await attention(mgr);
  const hc = mine(v).find((x) => x.source_id === `wb-${WC}:${h1.json.request.id}`);
  check(hc?.detail?.bench === `wb-${WC}` && hc.detail.bench_title === '合成卡片甲' && hc.detail.bench_registered === false && hc.detail.workbench_id === WC && hc.detail.session === 'sess-h'
    && hc.detail.tools.map((t) => t.tool).join() === 'dataset_list,dataset_query' && hc.answer_via?.path === `/api/bench-views/wb-${WC}/mcp-requests/${h1.json.request.id}`
    && mine(v).some((x) => x.source_id === `wb-${WC}:${h2.json.request.id}`) && mine(v).some((x) => x.source_id === `wb-${WD}:${h3.json.request.id}`),
    '管理层的「关注」里看得到：卡片名、哪个会话、要哪些工具，标着「还没开台库」；写卡片 id 和 wb-<卡片 id> 的都在', JSON.stringify(mine(v).filter((x) => x.source_id.startsWith('wb-'))).slice(0, 300));
  check(!mine(v).some((x) => x.source_id.endsWith(`:${h4.json.request.id}`)), '没有这张卡片的申请：照旧不在清单里');
  for (const [name, opts] of [['普通员工', member], ['有做没有拍板', staff], ['管理口令', admin]]) { const x = await attention(opts); seen[name] = mine(x).some((y) => y.source_id.startsWith('wb-')); }
  const nb = await srv.call('POST', `/api/bench-views/wb-${WC}/mcp-requests/${h1.json.request.id}`, { ...member, body: { approve: true } });
  const ns = await srv.call('POST', `/api/bench-views/${WC}/mcp-requests/${h1.json.request.id}`, { ...staff, body: { approve: true } });
  const na = await srv.call('POST', `/api/bench-views/wb-${WC}/mcp-requests/${h1.json.request.id}`, { ...admin, body: { approve: true } });
  check(!seen['普通员工'] && !seen['有做没有拍板'] && !seen['管理口令'] && nb.status === 403 && ns.status === 403 && na.status === 403 && !db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(WC),
    '普通员工、有做没有拍板的角色、管理口令：清单里看不到，批也是 403，没有开出台库', { member: nb.status, staff: ns.status, token: na.status });
  const miss = await srv.call('POST', `/api/bench-views/987654/mcp-requests/${h4.json.request.id}`, { ...mgr, body: { approve: true } });
  const cross = await srv.call('POST', `/api/bench-views/wb-${WD}/mcp-requests/${h1.json.request.id}`, { ...mgr, body: { approve: true } });
  check(miss.status === 404 && cross.status === 404 && !db.prepare('SELECT 1 FROM bench_views WHERE workbench_id IN (?, ?)').get(WC, WD) && !existsSync(join(srv.data, 'bench-stores', `wb-${WD}.sqlite`)),
    '没有这张卡片：404；拿别的卡片的路径批这条申请：404，也不会白开一个台库', { miss: miss.status, cross: cross.status });
  // 照条目的 answer_via 批（属主在界面上点「同意」走的就是这一条）
  // 只有数据视图「拍板」、没有「做」的自定义角色：批得了登记过的台上的申请，批不了要顺带开台库的（开台库和 POST /api/bench-views 带 workbench_id 同一道门）
  await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.claimsAdmin });
  const rc = await srv.call('POST', '/api/roles/guest/copy', { body: { id: 'bench-decider', name: '台上拍板' } });
  const ru = await srv.call('PUT', '/api/roles/bench-decider', { body: { permissions: [{ kinds: ['read', 'decide'], domains: ['bench-store'] }] } });
  // 本机命令行就是属主：改动当场生效，没有待放行的提议时放行回 409，两种都算
  const ra = await srv.call('POST', '/api/roles/bench-decider/approve');
  const gDec = await activate({ principal: 'user:claims-admin', role: 'bench-decider' });
  const decider = who(SESSIONS.claimsAdmin);
  const h5 = await tool(srv, H.token, 'access_request', { tools: ['dataset_snapshots@bench:other'], reason: '登记过的台' });
  const dOpen = await srv.call('POST', `/api/bench-views/wb-${WC}/mcp-requests/${h1.json.request.id}`, { ...decider, body: { approve: true } });
  const dReg = await srv.call('POST', `/api/bench-views/other/mcp-requests/${h5.json?.request?.id}`, { ...decider, body: { approve: true } });
  check(rc.status === 201 && ru.status === 200 && [200, 409].includes(ra.status) && gDec === 200 && dOpen.status === 403 && !db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(WC)
    && db.prepare('SELECT status FROM bench_mcp_requests WHERE id = ?').get(h1.json.request.id)?.status === 'pending' && dReg.status === 200 && dReg.json?.status === 'approved',
    '只有「拍板」、不能登记台的角色：要顺带开台库的申请批不了（403，申请还在、没开台库）；登记过的台上的照常批得了', { role: [rc.status, ru.status, ra.status, gDec], open: dOpen.status, registered: dReg.status });
  // 条目缺了（改之前就是这样）也照同一个地址批一次，好看出批准这一步本身通不通
  const hvia = hc?.answer_via ?? { method: 'POST', path: `/api/bench-views/wb-${WC}/mcp-requests/${h1.json.request.id}`, answers: { approve: { body: { approve: true, from_attention: true } } } };
  r = await srv.call(hvia.method, hvia.path, { ...mgr, body: { ...hvia.answers.approve.body, note: '同意' } });
  const opened = db.prepare('SELECT slug, title, workbench_id, created_by FROM bench_views WHERE workbench_id = ?').get(WC);
  check(r.status === 200 && r.json?.status === 'approved' && r.json.granted.join() === 'dataset_list,dataset_query' && r.json.opened_bench?.slug === `wb-${WC}` && r.json.opened_bench.title === '合成卡片甲'
    && opened?.slug === `wb-${WC}` && opened.created_by === 'user:alpha' && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = ? AND session_id = ?').get(`wb-${WC}`, H.id).n === 2,
    '管理层批准：一步办成——给卡片开台库（wb-<卡片 id>，名字用卡片的，记是谁开的），授予写上', r.text.slice(0, 200));
  r = await tool(srv, H.token, 'dataset_list', { bench: String(WC) });
  const viaSlug = await tool(srv, H.token, 'dataset_list', { bench: `wb-${WC}` });
  const notGranted = await tool(srv, H.token, 'view_get', { bench: String(WC) });
  check(!r.isError && Array.isArray(r.json?.datasets) && !viaSlug.isError && notGranted.rpcError === -32601, '授予生效：会话写卡片 id、写台标识都调得了；没批的工具照旧不行', { card: r.text.slice(0, 60), slug: viaSlug.text.slice(0, 60), view_get: notGranted.rpcError });
  v = await attention(mgr);
  const h2c = mine(v).find((x) => x.source_id === `wb-${WC}:${h2.json.request.id}`);
  const listedH = await srv.call('GET', `/api/bench-views/${WC}/mcp-grants`, mgr);
  check(!mine(v).some((x) => x.source_id === `wb-${WC}:${h1.json.request.id}`) && h2c?.detail?.bench_registered === true
    && listedH.status === 200 && listedH.json?.requests?.some((x) => x.id === h1.json.request.id && x.status === 'approved') && listedH.json.requests.some((x) => x.id === h2.json.request.id && x.status === 'pending'),
    '批过的从清单里消失；同一张卡片的另一条（写的 wb-<卡片 id>）还在，现在标着台已登记；台上的管理页里两条都看得到', { h2: h2c?.detail, listed: listedH.json?.requests?.map((x) => `${x.id}:${x.status}`) });
  r = await answer(mgr, `wb-${WC}:${h2.json.request.id}`, 'approve', { note: '可以' });
  check(r.status === 200 && r.json?.result?.status === 'approved' && r.json.result.opened_bench === undefined && (await tool(srv, H.token, 'view_get', { bench: `wb-${WC}` })).rpcError === null, '台开了以后，同一张卡片的下一条照常批（不再开台库）', r.text.slice(0, 160));
  // 驳回：不开台库
  r = await srv.call('POST', `/api/bench-views/wb-${WD}/mcp-requests/${h3.json.request.id}`, { ...mgr, body: { approve: false } });
  const r8 = await srv.call('POST', `/api/bench-views/wb-${WD}/mcp-requests/${h3.json.request.id}`, { ...mgr, body: { approve: false, note: '卡片乙不开放给会话' } });
  const infoH = await tool(srv, H.token, 'access_info', {});
  check(r.status === 400 && r8.status === 200 && r8.json?.status === 'rejected' && !db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(WD) && !existsSync(join(srv.data, 'bench-stores', `wb-${WD}.sqlite`))
    && infoH.json?.bench_requests?.find((x) => x.id === h3.json.request.id)?.note === '卡片乙不开放给会话',
    '驳回没开台库的卡片上的申请：要写理由；驳回了也不开台库；会话看得到理由', { noNote: r.status, reject: r8.status });
  // 会话已吊销：批不了，也不白开台库
  const J = await mk('sess-j');
  const WE = mkCard('合成卡片丙');
  const j1 = await tool(srv, J.token, 'access_request', { tools: [`dataset_list@bench:${WE}`], reason: '吊销前提的' });
  await srv.call('DELETE', `/api/mcp/sessions/${J.id}`, admin);
  r = await srv.call('POST', `/api/bench-views/${WE}/mcp-requests/${j1.json?.request?.id}`, { ...mgr, body: { approve: true } });
  check(r.status === 409 && !db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(WE), '提申请的会话已吊销：409，没有为这张卡片开台库', r.status);
  // 开台库之前写成卡片号、开了之后还没定的申请也算这个台的：台改绑部门、卡片删掉时和写台标识的一起驳回
  const h6pending = db.prepare('SELECT bench, status FROM bench_mcp_requests WHERE id = ?').get(h6.json?.request?.id);
  await srv.call('PUT', '/api/departments/dv-sales', { ...admin, body: { name: 'dv-sales' } });
  const rebind = await srv.call('PUT', `/api/bench-views/wb-${WC}/binding`, { ...mgr, body: { department: 'dv-sales' } });
  const h6row = db.prepare('SELECT status, note FROM bench_mcp_requests WHERE id = ?').get(h6.json?.request?.id);
  check(h6pending?.bench === String(WC) && h6pending.status === 'pending' && rebind.status === 200 && rebind.json?.rejected_mcp_requests === 1 && h6row?.status === 'rejected' && /改绑/.test(h6row.note ?? ''),
    '台改绑部门：开台库之前写卡片号、还没定的申请一起驳回', { h6pending, rebind: rebind.json, h6row });
  // 卡片已经对应了一个别的名字的台，会话却写成 wb-<卡片 id>：不算「没开台库的卡片」（开不出第二个台库），不进清单、批是 404
  const WG = mkCard('合成卡片戊');
  const linkG = await srv.call('POST', '/api/bench-views', { ...mgr, body: { slug: 'linked-g', title: '已对应的台', workbench_id: WG } });
  const hg = await tool(srv, H.token, 'access_request', { tools: [`dataset_list@bench:wb-${WG}`], reason: '写成了 wb-<卡片 id>' });
  const gListed = mine(await attention(mgr)).some((x) => x.source_id.endsWith(`:${hg.json?.request?.id}`));
  const gApprove = await srv.call('POST', `/api/bench-views/wb-${WG}/mcp-requests/${hg.json?.request?.id}`, { ...mgr, body: { approve: true } });
  const gViaLinked = await srv.call('POST', `/api/bench-views/linked-g/mcp-requests/${hg.json?.request?.id}`, { ...mgr, body: { approve: true } });
  // 认法三处一致：清单、台上的管理页、批。管理页上显示待批、却从这个台批不了，只能等它到期——不该出现
  const gPage = await srv.call('GET', '/api/bench-views/linked-g/mcp-grants', mgr);
  check(linkG.status === 201 && hg.json?.ok === true && !gListed && gApprove.status === 404 && gViaLinked.status === 404 && db.prepare('SELECT COUNT(*) AS n FROM bench_views WHERE workbench_id = ?').get(WG).n === 1,
    '卡片已对应了别的台、申请写成 wb-<卡片 id>：不进清单，批是 404（两个路径都是），不会再开一个台库', { link: linkG.status, listed: gListed, approve: gApprove.status, viaLinked: gViaLinked.status });
  check(gPage.status === 200 && !gPage.json?.requests?.some((x) => x.id === hg.json?.request?.id), '这种申请也不出现在那个台的管理页上（显示了也批不了）', gPage.json?.requests?.map((x) => `${x.id}:${x.status}`));
  const WF = mkCard('合成卡片丁');
  const h7 = await tool(srv, H.token, 'access_request', { tools: [`dataset_list@bench:${WF}`], reason: '开库那一条' });
  const h8 = await tool(srv, H.token, 'access_request', { tools: [`dataset_snapshots@bench:${WF}`], reason: '开台库之前提的，留到删卡片' });
  const openF = await srv.call('POST', `/api/bench-views/${WF}/mcp-requests/${h7.json?.request?.id}`, { ...mgr, body: { approve: true } });
  const del = await srv.call('DELETE', `/api/workbenches/${WF}`, { ...admin, body: { confirm_bench_data: true } });
  const h8row = db.prepare('SELECT bench, status, note FROM bench_mcp_requests WHERE id = ?').get(h8.json?.request?.id);
  check(openF.status === 200 && openF.json?.opened_bench?.slug === `wb-${WF}` && del.status === 200 && h8row?.bench === String(WF) && h8row.status === 'rejected' && h8row.note === '卡片已删',
    '删卡片：开台库之前写卡片号、还没定的申请一起驳回', { open: openF.status, del: del.status, h8row });

  console.log('七之三、没人处理的申请到期失效');
  const E = await mk('sess-e');
  const e1 = await tool(srv, E.token, 'access_request', { tools: ['dataset_list@bench:other'], reason: '到期前没人批' });
  const e2 = await tool(srv, E.token, 'access_request', { tools: ['dataset_list@bench:ghost-two'], reason: '标识写错了' });
  const e3 = await tool(srv, E.token, 'access_request', { tools: ['view_get@bench:other'], reason: '刚提的' });
  check(e1.json?.ok && e2.json?.ok && e3.json?.ok && /72 小时内没人处理/.test(e1.json?.note ?? '') && e1.json.note.includes(e1.json.request.ref) && e1.json.note.includes('「other」')
    && e1.json.note.replace(e1.json.request.ref, '#').replace('「other」', '「@」') === e2.json?.note?.replace(e2.json.request.ref, '#').replace('「ghost-two」', '「@」'),
    '提申请时说清期限：72 小时内没人处理就失效，并给出申请编号和标识供核对；除了这两处，写错标识的应答和写对的一样', [e1.json?.note, e2.json?.note]);
  check(mine(await attention(mgr)).some((x) => x.source_id === `other:${e1.json.request.id}`), '（对照）到期之前，「关注」里有这一条');
  // 把前两条的提出时间往前拨 73 小时（第三条不动）
  for (const id of [e1.json.request.id, e2.json.request.id]) db.prepare('UPDATE bench_mcp_requests SET created_at = created_at - ? WHERE id = ?').run(73 * 3_600_000, id);
  const infoEE = await tool(srv, E.token, 'access_info', {});
  const stE = Object.fromEntries((infoEE.json?.bench_requests ?? []).map((x) => [x.id, `${x.status}|${x.note}`]));
  check(stE[e1.json.request.id] === 'expired|失效：没有人处理' && stE[e2.json.request.id] === 'expired|失效：没有人处理' && stE[e3.json.request.id]?.startsWith('pending'),
    '到期的两条：申请的会话查到「失效：没有人处理」——写错标识的和有台没人管的结局一样；没到期的照旧待批', stE);
  check(!mine(await attention(mgr)).some((x) => x.source_id === `other:${e1.json.request.id}`) && mine(await attention(mgr)).some((x) => x.source_id === `other:${e3.json.request.id}`), '「关注」里到期的那条一起消失，没到期的还在');
  const lateE = await srv.call('POST', `/api/bench-views/other/mcp-requests/${e1.json.request.id}`, { ...mgr, body: { approve: true } });
  check(lateE.status === 409 && /失效/.test(lateE.json?.message ?? '') && !db.prepare("SELECT 1 FROM bench_mcp_grants g JOIN mcp_sessions s ON s.id = g.session_id WHERE s.name = 'sess-e'").get(), '到期之后再批：409，说已经失效；没有授予', lateE.text.slice(0, 160));
  const listedE = await srv.call('GET', '/api/bench-views/other/mcp-grants', mgr);
  const trailE = db.prepare("SELECT actor, note FROM bench_mcp_audit WHERE action = 'expire' AND request_id = ?").get(e1.json.request.id);
  check(listedE.json?.requests?.find((x) => x.id === e1.json.request.id)?.status === 'expired' && trailE?.actor === 'system' && trailE?.note === '失效：没有人处理', '台的管理层那边也看到「失效」；留痕记一行，做的人是 system', { listedE: listedE.json?.requests?.find((x) => x.id === e1.json.request.id)?.status, trail: trailE });

  // 单查一条（access_info 带 ref）：先清到期，和清单一样说「失效」。把 e3 拨到过期后直接单查，中间不经过清单
  db.prepare('UPDATE bench_mcp_requests SET created_at = created_at - ? WHERE id = ?').run(73 * 3_600_000, e3.json.request.id);
  const oneE = await tool(srv, E.token, 'access_info', { ref: `bench-${e3.json.request.id}` });
  check(oneE.json?.request?.status === 'expired' && oneE.json?.request?.note === '失效：没有人处理', '单查一条到期没清的申请：同样说「失效：没有人处理」，不说待批', oneE.text?.slice(0, 160) ?? oneE.json);

  // 管理层驳回时备注正好写成「失效：没有人处理」：仍是人驳回，不当成过期
  const F = await mk('sess-f');
  const f1 = await tool(srv, F.token, 'access_request', { tools: ['dataset_list@bench:other'], reason: '要被人驳回的' });
  const fid = f1.json?.request?.id;
  const fr = await answer(mgr, `other:${fid}`, 'reject', { note: '失效：没有人处理' });
  const fInfo = await tool(srv, F.token, 'access_info', {});
  const fOne = await tool(srv, F.token, 'access_info', { ref: `bench-${fid}` });
  const fListed = await srv.call('GET', '/api/bench-views/other/mcp-grants', mgr);
  const fAgain = await answer(mgr, `other:${fid}`, 'reject', { note: '失效：没有人处理' });
  const fLate = await srv.call('POST', `/api/bench-views/other/mcp-requests/${fid}`, { ...mgr, body: { approve: true } });
  const fTrail = db.prepare('SELECT action, actor FROM bench_mcp_audit WHERE request_id = ? ORDER BY id').all(fid);
  check(fr.status === 200 && fInfo.json?.bench_requests?.find((x) => x.id === fid)?.status === 'rejected' && fOne.json?.request?.status === 'rejected'
    && fListed.json?.requests?.find((x) => x.id === fid)?.status === 'rejected'
    && fAgain.status === 200 && fAgain.json?.duplicate === true && !mine(await attention(mgr)).some((x) => x.source_id === `other:${fid}`)
    && fLate.status === 409 && /驳回/.test(fLate.json?.message ?? '') && !/失效/.test(fLate.json?.message ?? '')
    && JSON.stringify(fTrail) === JSON.stringify([{ action: 'reject', actor: 'user:alpha' }]),
    '管理层驳回时理由正好写「失效：没有人处理」：申请人（清单和单查）、台的管理层看到的都是 rejected；「关注」按人驳回处理（再答认得是答过的，再批说已驳回）；留痕是这个人驳回',
    { fr: fr.status, info: fInfo.json?.bench_requests?.find((x) => x.id === fid)?.status, one: fOne.json?.request?.status, listed: fListed.json?.requests?.find((x) => x.id === fid)?.status, again: fAgain.json, late: fLate.json?.message, fTrail });

  let n = 0; for (let i = 0; i < 12; i++) { const x = await tool(srv, A.token, 'access_request', { tools: [`dataset_list@bench:cap-${i}`], reason: '刷' }); if (x.json?.ok) n++; }
  check(n < 12 && n >= 4, '申请有每小时的上限', n);
  await srv.stop();

  console.log('八、入口关着、网关关着');
  const off = await boot('entry-off', { WM_BENCH_VIEWS: 'off' }); // 入口缺省开，关要显式 off
  const C = await (async () => { const x = await off.call('POST', '/api/mcp/sessions', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN }, body: { name: 'sess-c' } }); return { id: x.json?.id, token: x.json?.token }; })();
  // 入口以前开过：台登记着、授予也在。关了之后照样不行
  off.db().prepare('INSERT INTO bench_views (slug, title, created_by, created_at) VALUES (?, ?, ?, ?)').run('demo', 'demo', 'user:alpha', 1);
  off.db().prepare('INSERT INTO bench_mcp_grants (session_id, bench, tool, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run(C.id, 'demo', 'dataset_list', 'user:alpha', 1);
  names = await listed(off, C.token);
  r = await tool(off, C.token, 'dataset_list', { bench: 'demo' });
  const info = await tool(off, C.token, 'access_info', {});
  const ask = await tool(off, C.token, 'access_request', { tools: ['dataset_list@bench:demo'], reason: 'x' });
  check(!names.some((x) => BENCH_TOOLS.includes(x)) && r.rpcError === -32601 && !info.json?.catalog?.some((t) => BENCH_TOOLS.includes(t.name)) && info.json?.bench_requests === undefined && ask.isError && !existsSync(join(off.data, 'bench-stores')),
    '入口关着：目录里没有、调不了（台登记着、库里有授予也不行）、申请不了、不建台库', { call: r.rpcError, ask: ask.text.slice(0, 80) });
  await off.stop();
  const gw = await boot('gateway-off', { WM_BENCH_VIEWS: 'on', MCP_GATEWAY: 'off' });
  gw.db().prepare('INSERT INTO bench_views (slug, title, created_by, created_at) VALUES (?, ?, ?, ?)').run('demo', 'demo', 'user:alpha', 1);
  const open = await tool(gw, null, 'workbench_list', {});
  r = await tool(gw, null, 'dataset_list', { bench: 'demo' });
  const rest = await gw.call('POST', '/api/mcp-rest/tools/dataset_list', { body: { bench: 'demo' } });
  check(!open.isError && open.rpcError === null && r.rpcError === -32601 && rest.status !== 200 && !existsSync(join(gw.data, 'bench-stores', 'demo.sqlite')),
    '网关关着：别的工具不用令牌就能调，数据视图的工具照样调不了（两个渠道都是），也不建台库', { other: open.rpcError, bench: r.rpcError, rest: rest.status });

  console.log('九、大结果给引用：数据视图的工具按台的授予再判');
  {
    const rr = await boot('result-ref', { WM_BENCH_VIEWS: 'on', WM_MCP_RESULT_LIMITS: 'inline=2000,ttl=600000' });
    for (const s of [SESSIONS.admin, SESSIONS.alpha]) await rr.call('GET', '/api/auth/viewer', { session: s });
    const sameR = { origin: `http://${rr.host}`, 'sec-fetch-site': 'same-origin' };
    const mgrR = { headers: { ...REMOTE, ...sameR }, session: SESSIONS.alpha };
    const g = await rr.call('POST', '/api/grants', { body: { scope: '*', reason: '合成：大结果的引用', principal: 'user:alpha', role: 'management' } });
    await rr.call('POST', `/api/grants/${g.json?.grant?.id}/submit`); await rr.call('POST', `/api/grants/${g.json?.grant?.id}/approve`);
    await rr.call('POST', '/api/bench-views', { ...mgrR, body: { slug: 'demo', title: 'demo' } });
    await rr.call('PUT', '/api/bench-views/demo/datasets/seed', { ...mgrR, body: { key: ['id'], columns: [{ name: 'id', type: 'integer' }, { name: 'note', type: 'text' }] } });
    await rr.call('POST', '/api/bench-views/demo/datasets/seed/rows?op=replace', { ...mgrR, raw: JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i + 1, note: 'n'.repeat(100) }))) });
    const made = await rr.call('POST', '/api/mcp/sessions', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN }, body: { name: 'sess-ref' } });
    const R = { id: made.json?.id, token: made.json?.token };
    const grant = await rr.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgrR, body: { session: 'sess-ref', tools: ['dataset_query'] } });
    const q = await tool(rr, R.token, 'dataset_query', { bench: 'demo', query: { dataset: 'seed' } });
    const ref = q.json?.result_ref;
    check(grant.status === 200 && !!ref?.id, '（准备）台上授予了 dataset_query，查出来的结果超过阈值：给引用', { grant: grant.status, text: q.text.slice(0, 160) });
    const ok1 = await rr.call('GET', `/api/mcp-rest/results/${ref?.id}`, { headers: { authorization: `Bearer ${R.token}` } });
    check(ok1.status === 200 && ok1.text.includes('nnnn'), '授予还在：取得到', ok1.status);
    await rr.call('PUT', '/api/bench-views/demo/mcp-grants', { ...mgrR, body: { session: 'sess-ref', tools: [] } });
    const gone = await rr.call('GET', `/api/mcp-rest/results/${ref?.id}`, { headers: { authorization: `Bearer ${R.token}` } });
    const goneRead = await tool(rr, R.token, 'result_read', { id: ref?.id });
    check(gone.status === 403 && goneRead.isError, '收回这个台上的授予：REST 和 result_read 都取不到', { rest: gone.status, read: goneRead.text.slice(0, 80) });
    await rr.stop();
  }
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  for (const d of openDbs) d.close();
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`bench-mcp-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
