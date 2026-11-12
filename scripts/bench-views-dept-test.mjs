#!/usr/bin/env node
/**
 * 数据视图：台绑部门之后谁进得来（docs/data-views.md 第三节）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   一、绑定：登记时绑、部门要在部门表里；没绑的台只有管理层
 *   二、本部门有已放行授予的人：自己部门的台读写都行，清单里只有自己进得去的；别的部门的台、没绑的台、没登记的台都是 403
 *   三、拍板：有这个部门拍板授予的人批得了 MCP 授予、能把新台登记到自己部门；部门成员不行；改绑只有管理层
 *   四、关系不带来权限：系统管理员把人加进部门成员表、设成部门负责人、设成团队负责人，这个人仍然 403
 *   五、授予要放行：系统管理员起草的部门范围授予停在待放行时 403，属主放行后才通
 *   六、改绑：原部门的人立即进不来，新部门的人进得来；解绑之后只有管理层；留痕
 *   七、细到团队的台：同部门别的人写不了；团队负责人（有授予的）、有部门拍板授予的人写得了
 *   七之二、席位不按部门认：团队认领到部门之后，这个团队的席位仍调不了这个部门的台，要按台批
 *   八、「等你拍板」：只看得到自己有拍板授予的部门的台上的申请
 *   九、主体停用：进不来
 *
 *   node scripts/bench-views-dept-test.mjs              测本仓库
 *   node scripts/bench-views-dept-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `bench-views-dept-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-bench-dept-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.61' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const running = [];
async function boot(name, extraEnv = {}, { expectFail = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
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
  const srv = { name, base, host: new URL(base).host, data, stop, call, log: () => log, db: () => new DatabaseSync(join(data, 'workbench-market.db')) };
  running.push(srv);
  return srv;
}


try {
  const srv = await boot('on', { WM_BENCH_VIEWS: 'on' });
  const db = srv.db();
  const P = { boss: SESSIONS.alpha, member: SESSIONS.beta, lead: SESSIONS.strasse, other: SESSIONS.noAdminFlag, sys: SESSIONS.admin };
  for (const s of Object.values(P)) await srv.call('GET', '/api/auth/viewer', { session: s });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: { ...REMOTE, ...same }, session });
  const token = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
  const boss = who(P.boss), member = who(P.member), lead = who(P.lead), other = who(P.other), sys = who(P.sys);
  // 授予：本机命令行（属主）起草、提交、放行
  const activate = async (body) => { const d = await srv.call('POST', '/api/grants', { body: { reason: '合成：台绑部门', ...body } }); const id = d.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); const a = await srv.call('POST', `/api/grants/${id}/approve`); return a.status < 300; };
  const otherId = db.prepare("SELECT id FROM principals WHERE id = 'user:no-flag'").get()?.id;
  for (const id of ['sales', 'ops']) await srv.call('PUT', `/api/departments/${id}`, { ...token, body: { name: id } });
  const prep = [
    await activate({ principal: 'user:alpha', role: 'management', scope: '*' }),
    await activate({ principal: 'user:beta', role: 'dept-member', scope: 'dept:sales' }),
    await activate({ principal: 'user:strasse', role: 'dept-lead', scope: 'dept:sales' }),
    await activate({ principal: 'user:no-flag', role: 'dept-member', scope: 'dept:ops' }),
  ];
  check(prep.every(Boolean) && otherId === 'user:no-flag', '（准备）两个部门；管理层一人；sales 的部门成员、部门负责人各一人；ops 的部门成员一人（授予都由属主放行）', { prep, otherId });
  const st = async (opts, method, path, body) => (await srv.call(method, `/api/bench-views${path}`, { ...opts, ...(body === undefined ? {} : { body }) })).status;
  const COLS = { columns: [{ name: 'a', type: 'text' }] };

  console.log('一、绑定');
  let r = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'x', title: 'x', department: 'nope' } });
  check(r.status === 404 && db.prepare("SELECT COUNT(*) AS n FROM bench_views").get().n === 0, '绑到不存在的部门：拒，没有登记出台', r.text.slice(0, 100));
  r = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'x', title: 'x', department: 'Sales' } });
  const r1 = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'x', title: 'x', team_host: 'aaaaaaaa', team: 'z/canvas/t' } });
  check(r.status === 400 && r1.status === 400, '部门标识写法不对、只写团队不写部门：拒', { dept: r.status, team: r1.status });
  r = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'sales-b', title: '销售台', department: 'sales' } });
  const r2 = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'ops-b', title: '运营台', department: 'ops' } });
  const r3 = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'free', title: '没绑的台' } });
  check(r.status === 201 && r.json?.bench?.department_id === 'sales' && r2.status === 201 && r3.status === 201 && r3.json?.bench?.department_id === '', '管理层登记三个台：两个各绑一个部门，一个不绑', r.text.slice(0, 160));
  for (const b of ['sales-b', 'ops-b', 'free']) await srv.call('PUT', `/api/bench-views/${b}/datasets/d`, { ...boss, body: COLS });

  console.log('二、本部门有已放行授予的人');
  r = await srv.call('GET', '/api/bench-views', member);
  check(r.status === 200 && r.json?.benches?.map((b) => b.slug).join() === 'sales-b', '部门成员的清单里只有自己部门的台', r.text.slice(0, 160));
  const read = await st(member, 'GET', '/sales-b/datasets'), write = await st(member, 'PUT', '/sales-b/datasets/mine', COLS);
  const rows = await srv.call('POST', '/api/bench-views/sales-b/datasets/mine/rows?op=replace', { ...member, raw: JSON.stringify([{ a: 'x' }]) });
  check(read === 200 && write === 200 && rows.status === 200, '自己部门的台：读、建数据集、写行都行', { read, write, rows: rows.status });
  // 幂等键按写的人隔开：同一个部门里另一个人用同一个键，拿不到前一个人的结果，也不报「键已用在另一份内容上」
  const keyed = (opts, k) => ({ ...opts, headers: { ...opts.headers, 'idempotency-key': k } });
  const put = (opts, rowsJson) => srv.call('POST', '/api/bench-views/sales-b/datasets/mine/rows?op=replace', { ...keyed(opts, 'shared-key-0001'), raw: rowsJson });
  const k1 = await put(member, JSON.stringify([{ a: 'member-wrote-this' }]));
  const k2 = await put(lead, JSON.stringify([{ a: 'lead-wrote-this' }]));
  const k3 = await put(lead, JSON.stringify([{ a: 'lead-wrote-this' }])), k4 = await put(member, JSON.stringify([{ a: 'member-wrote-this' }]));
  const k5 = await put(lead, JSON.stringify([{ a: 'member-wrote-this' }]));
  check(k1.status === 200 && k1.json?.duplicate === undefined && k2.status === 200 && k2.json?.duplicate === undefined && k3.json?.duplicate === true && k4.json?.duplicate === true && k5.status === 409,
    '同部门另一个人用同一个幂等键：照常写入（不是 409、不算重复）；各人重试各自认得；自己的键换内容才是冲突', { k1: k1.status, k2: `${k2.status}/${k2.json?.duplicate}`, k3: k3.json?.duplicate, k4: k4.json?.duplicate, k5: k5.status });
  r = await srv.call('GET', '/api/bench-views/sales-b/log', member);
  check(r.status === 200 && r.json?.writes?.some((w) => w.actor === 'user:beta') && r.json.writes.some((w) => w.actor === 'user:strasse'), '留痕记的是各自写的人');
  const denied = {};
  for (const [name, path] of [['别的部门的台', '/ops-b/datasets'], ['没绑的台', '/free/datasets'], ['没登记的台', '/ghost/datasets']]) denied[name] = `${await st(member, 'GET', path)}/${await st(member, 'PUT', `${path}/x`, COLS)}`;
  check(Object.values(denied).every((x) => x === '403/403'), '别的部门的台、没绑的台、没登记的台：读写都是 403（看不出台存不存在）', denied);
  r = await srv.call('GET', '/api/bench-views', other);
  const o1 = await st(other, 'GET', '/sales-b/datasets'), o2 = await st(other, 'GET', '/ops-b/datasets');
  check(r.json?.benches?.map((b) => b.slug).join() === 'ops-b' && o1 === 403 && o2 === 200, '别的部门的人：进不了这个部门的台，进得了自己的', { list: r.text.slice(0, 80), sales: o1, ops: o2 });

  console.log('三、拍板');
  const seat = (await srv.call('POST', '/api/mcp/sessions', { ...token, body: { name: 'seat-d' } })).json;
  const grantBody = { session: 'seat-d', tools: ['dataset_list'] };
  const m1 = await st(member, 'PUT', '/sales-b/mcp-grants', grantBody), m2 = await st(member, 'GET', '/sales-b/mcp-grants');
  check(m1 === 403 && m2 === 200, '部门成员：看得到台上的授予，给不了', { put: m1, get: m2 });
  const l1 = await st(lead, 'PUT', '/sales-b/mcp-grants', grantBody), l2 = await st(lead, 'PUT', '/ops-b/mcp-grants', grantBody);
  check(l1 === 200 && l2 === 403 && db.prepare("SELECT granted_by FROM bench_mcp_grants WHERE bench = 'sales-b'").get()?.granted_by === 'user:strasse', '有这个部门拍板授予的人：给得了自己部门的台，给不了别的部门的', { sales: l1, ops: l2 });
  const c1 = await st(lead, 'POST', '', { slug: 'sales-2', title: '销售二台', department: 'sales' });
  const c2 = await st(lead, 'POST', '', { slug: 'lead-ops', title: 'x', department: 'ops' }), c3 = await st(lead, 'POST', '', { slug: 'lead-free', title: 'x' });
  const c4 = await st(member, 'POST', '', { slug: 'member-b', title: 'x', department: 'sales' });
  check(c1 === 201 && c2 === 403 && c3 === 403 && c4 === 403 && db.prepare("SELECT COUNT(*) AS n FROM bench_views WHERE slug IN ('lead-ops', 'lead-free', 'member-b')").get().n === 0,
    '登记新台：有拍板授予的人只能登记到自己部门（别的部门、不绑都不行）；部门成员不行', { own: c1, ops: c2, unbound: c3, member: c4 });
  const b1 = await st(lead, 'PUT', '/sales-b/binding', { department: 'ops' }), b2 = await st(member, 'PUT', '/sales-b/binding', { department: '' }), b3 = await st(token, 'PUT', '/sales-b/binding', { department: 'ops' });
  check(b1 === 403 && b2 === 403 && b3 === 403 && db.prepare("SELECT department_id FROM bench_views WHERE slug = 'sales-b'").get().department_id === 'sales', '改绑：部门负责人、部门成员、管理口令都不行', { lead: b1, member: b2, token: b3 });

  console.log('四、关系不带来权限');
  const add = await srv.call('PUT', '/api/departments/sales/members/user:root-admin', token);
  const mkLead = await srv.call('PUT', '/api/departments/sales', { ...token, body: { name: 'sales', lead: 'user:root-admin' } });
  const relNow = () => db.prepare("SELECT (SELECT COUNT(*) FROM department_members WHERE department_id = 'sales' AND principal_id = 'user:root-admin') AS m, (SELECT lead_principal FROM departments WHERE id = 'sales') AS l").get();
  const proposal = db.prepare("SELECT status FROM relation_proposals WHERE kind = 'dept-lead' AND department_id = 'sales' AND principal_id = 'user:root-admin' ORDER BY id DESC").get();
  const NINE = [['GET', ''], ['GET', '/sales-b/datasets'], ['PUT', '/sales-b/datasets/x', COLS], ['GET', '/sales-b/render'], ['GET', '/sales-b/log'], ['GET', '/sales-b/mcp-grants'], ['PUT', '/sales-b/mcp-grants', grantBody], ['POST', '', { slug: 'sys-b', title: 'x', department: 'sales' }], ['PUT', '/sales-b/binding', { department: 'ops' }]];
  const nine = async () => { const got = []; for (const [m, path, body] of NINE) got.push(await st(sys, m, path, body)); return got; };
  let got = await nine();
  const rel = relNow();
  check(add.status < 300 && mkLead.status < 300 && rel.m === 1 && rel.l === '' && proposal?.status === 'pending' && got.every((x) => x === 403),
    '系统管理员把一个人加进部门成员表、又提议设成部门负责人（提议待确认）：这个人对这个部门的台是 403（清单、读、写、拍板、登记、改绑）', { add: add.status, lead: mkLead.status, rel, proposal, got: got.join() });
  // 就算负责人这层关系确认了（这里直接写进部门表，等于确认过的结果），没有授予照样进不来：关系不带来权限
  db.prepare("UPDATE departments SET lead_principal = 'user:root-admin' WHERE id = 'sales'").run();
  got = await nine();
  check(relNow().l === 'user:root-admin' && got.every((x) => x === 403), '负责人这层关系就算确认了，没有已放行的授予照样是 403', { rel: relNow(), got: got.join() });

  console.log('五、授予要放行');
  const d = await srv.call('POST', '/api/grants', { ...token, body: { principal: 'user:root-admin', role: 'dept-member', scope: 'dept:sales', reason: '合成：系统管理员起草' } });
  const gid = d.json?.grant?.id;
  await srv.call('POST', `/api/grants/${gid}/submit`, token);
  const self = await srv.call('POST', `/api/grants/${gid}/approve`, token);
  const pend = await st(sys, 'GET', '/sales-b/datasets');
  check(gid !== undefined && self.status >= 400 && pend === 403, '系统管理员起草的部门范围授予，自己放行不了；停在待放行时仍是 403', { approve: self.status, read: pend });
  const rel2 = await srv.call('POST', `/api/grants/${gid}/approve`);
  const ok1 = await st(sys, 'GET', '/sales-b/datasets'), ok2 = await st(sys, 'GET', '/ops-b/datasets');
  check(rel2.status < 300 && ok1 === 200 && ok2 === 403, '属主放行之后：进得了这个部门的台，别的部门的照样进不了', { approve: rel2.status, sales: ok1, ops: ok2 });

  console.log('六、改绑');
  // 改绑之前：seat-d 在这个台上有部门负责人批的一个工具，另有一条没定的申请
  const askD = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${seat.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'access_request', arguments: { tools: ['dataset_snapshots@bench:sales-b'], reason: '改绑之前提的' } } } });
  const toolD = async () => { const x = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${seat.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dataset_list', arguments: { bench: 'sales-b' } } } }); return x.json?.error?.code ?? 'ok'; };
  const beforeMove = await toolD();
  r = await srv.call('PUT', '/api/bench-views/sales-b/binding', { ...boss, body: { department: 'ops', note: '划给运营' } });
  const a1 = await st(member, 'GET', '/sales-b/datasets'), a2 = await st(other, 'GET', '/sales-b/datasets'), a3 = await st(lead, 'PUT', '/sales-b/mcp-grants', grantBody);
  check(r.status === 200 && r.json?.changed === true && a1 === 403 && a2 === 200 && a3 === 403, '管理层把台改绑到别的部门：原部门的人（含负责人）立即进不来，新部门的人进得来', { put: r.status, old: a1, now: a2, oldLead: a3 });
  // 改绑之后，新部门的人用旧部门的人用过的键、发同样的内容：等于没人用过，拿不到那个人那次写入的结果
  const moved1 = await srv.call('POST', '/api/bench-views/sales-b/datasets/mine/rows?op=replace', { ...other, headers: { ...other.headers, 'idempotency-key': 'shared-key-0001' }, raw: JSON.stringify([{ a: 'member-wrote-this' }]) });
  const moved2 = await srv.call('POST', '/api/bench-views/sales-b/datasets/mine/rows?op=replace', { ...other, headers: { ...other.headers, 'idempotency-key': 'shared-key-0001' }, raw: JSON.stringify([{ a: 'something-else' }]) });
  check(moved1.status === 200 && moved1.json?.duplicate === undefined && moved2.status === 409, '改绑之后新部门的人用旧部门的人用过的幂等键：同样的内容也不算重复（拿不到旧结果）；冲突只和他自己的那次比', { same: `${moved1.status}/${moved1.json?.duplicate}`, own: moved2.status });
  const afterMove = await toolD();
  const moved = { grants: db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = 'sales-b'").get().n, pending: db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_requests WHERE bench = 'sales-b' AND status = 'pending'").get().n,
    note: db.prepare("SELECT note, decided_by FROM bench_mcp_requests WHERE bench = 'sales-b' AND status = 'rejected' ORDER BY id DESC").get(), audit: db.prepare("SELECT actor, tools, note FROM bench_mcp_audit WHERE bench = 'sales-b' AND action = 'revoke' ORDER BY id DESC").get() };
  check(askD.status === 200 && beforeMove === 'ok' && afterMove === -32601 && r.json?.revoked_mcp_grants === 1 && r.json?.rejected_mcp_requests === 1 && moved.grants === 0 && moved.pending === 0
    && moved.note?.decided_by === 'user:alpha' && /改绑/.test(moved.note?.note ?? '') && moved.audit?.actor === 'user:alpha' && moved.audit.tools === '["dataset_list"]' && /改绑/.test(moved.audit.note),
    '改绑时：原部门批给 MCP 会话的授予全部收回（会话立即调不了）、没定的申请驳回并写明原因，应答里有数，留痕记是谁', { beforeMove, afterMove, resp: r.text.slice(0, 200), moved });
  // 解绑、从没绑到绑上，同样是台换了主人：各自也要收回授予、驳回申请
  const askSeat = (tools) => srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${seat.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'access_request', arguments: { tools, reason: '改绑之前提的' } } } });
  const mcpState = () => ({ grants: db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = 'sales-b'").get().n, pending: db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_requests WHERE bench = 'sales-b' AND status = 'pending'").get().n });
  const rejectLog = () => db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_audit WHERE bench = 'sales-b' AND action = 'reject' AND actor = 'user:alpha' AND request_id IS NOT NULL").get().n;
  const p1 = await st(boss, 'PUT', '/sales-b/mcp-grants', grantBody); await askSeat(['view_get@bench:sales-b']);
  const beforeUnbind = { ...mcpState(), tool: await toolD() };
  r = await srv.call('PUT', '/api/bench-views/sales-b/binding', { ...boss, body: { department: '' } });
  const u1 = await st(other, 'GET', '/sales-b/datasets'), u2 = await st(boss, 'GET', '/sales-b/datasets');
  check(r.status === 200 && u1 === 403 && u2 === 200, '解绑之后：只有管理层进得来', { other: u1, boss: u2 });
  const afterUnbind = { ...mcpState(), tool: await toolD() };
  check(p1 === 200 && beforeUnbind.grants === 1 && beforeUnbind.pending === 1 && beforeUnbind.tool === 'ok' && r.json?.revoked_mcp_grants === 1 && r.json?.rejected_mcp_requests === 1 && afterUnbind.grants === 0 && afterUnbind.pending === 0 && afterUnbind.tool === -32601 && rejectLog() === 2,
    '绑着的台解绑：原来的 MCP 授予没了、没定的申请被驳回（驳回也各留一行痕）', { beforeUnbind, afterUnbind, resp: r.text.slice(0, 160), rejectLog: rejectLog() });
  const p2 = await st(boss, 'PUT', '/sales-b/mcp-grants', grantBody); await askSeat(['view_versions@bench:sales-b']);
  const beforeBind = { ...mcpState(), tool: await toolD() };
  r = await srv.call('PUT', '/api/bench-views/sales-b/binding', { ...boss, body: { department: 'sales' } });
  const afterBind = { ...mcpState(), tool: await toolD() };
  check(p2 === 200 && beforeBind.grants === 1 && beforeBind.pending === 1 && beforeBind.tool === 'ok' && r.json?.revoked_mcp_grants === 1 && r.json?.rejected_mcp_requests === 1 && afterBind.grants === 0 && afterBind.pending === 0 && afterBind.tool === -32601 && rejectLog() === 3,
    '没绑的台（管理层批过授予）绑到部门：同样收回、驳回', { beforeBind, afterBind, resp: r.text.slice(0, 160) });
  const again = await srv.call('PUT', '/api/bench-views/sales-b/binding', { ...boss, body: { department: 'sales' } });
  const bad = await st(boss, 'PUT', '/sales-b/binding', {}), bad2 = await st(boss, 'PUT', '/ghost/binding', { department: 'sales' }), bad3 = await st(boss, 'PUT', '/sales-b/binding', { department: 'nope' });
  const audit = db.prepare("SELECT action, before, after, actor FROM bench_bind_audit WHERE slug = 'sales-b' ORDER BY id").all();
  check(again.json?.changed === false && again.json?.revoked_mcp_grants === 0 && bad === 400 && bad2 === 404 && bad3 === 404 && audit.map((x) => `${x.action}:${x.before}>${x.after}`).join() === 'bind:>sales,bind:sales>ops,unbind:ops>,bind:>sales' && audit.every((x) => x.actor === 'user:alpha'),
    '改绑留痕：谁、从哪到哪；和现在一样的不记；没写 department、台没登记、部门不存在都拒', { audit, bad, bad2, bad3 });

  console.log('七、细到团队的台');
  db.prepare('INSERT INTO teams (host, team, department_id, claimed, claimed_by, claimed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').run('abcdef01', 'z/canvas/tigers', 'sales', 'admin-token', 1, 1);
  r = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'team-b', title: '团队台', department: 'ops', team_host: 'abcdef01', team: 'z/canvas/tigers' } });
  check(r.status === 400, '团队没有认领到这个部门：绑不上', r.text.slice(0, 100));
  r = await srv.call('POST', '/api/bench-views', { ...boss, body: { slug: 'team-b', title: '团队台', department: 'sales', team_host: 'abcdef01', team: 'z/canvas/tigers' } });
  const t1 = await st(member, 'GET', '/team-b/datasets'), t2 = await st(member, 'PUT', '/team-b/datasets/x', COLS), t3 = await st(lead, 'PUT', '/team-b/datasets/x', COLS);
  check(r.status === 201 && t1 === 403 && t2 === 403 && t3 === 200, '同部门、不在这个团队里的部门成员：进不来；有部门拍板授予的人进得来', { create: r.status, read: t1, write: t2, lead: t3 });
  db.prepare('INSERT INTO team_leads (host, team, principal_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run('abcdef01', 'z/canvas/tigers', 'user:beta', 'admin-token', 1);
  db.prepare('INSERT INTO team_leads (host, team, principal_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run('abcdef01', 'z/canvas/tigers', 'user:no-flag', 'admin-token', 1);
  const t4 = await st(member, 'PUT', '/team-b/datasets/y', COLS), t5 = await st(other, 'PUT', '/team-b/datasets/z', COLS), t6 = await st(other, 'GET', '/team-b/datasets');
  check(t4 === 200 && t5 === 403 && t6 === 403, '设成团队负责人之后：有这个部门授予的人进得来；没有这个部门授予的人（别的部门的）当了团队负责人也进不来', { withGrant: t4, noGrantWrite: t5, noGrantRead: t6 });
  r = await srv.call('GET', '/api/bench-views', member);
  check(r.json?.benches?.map((b) => b.slug).sort().join() === 'sales-2,sales-b,team-b', '清单跟着变：现在进得去的三个', r.text.slice(0, 200));

  console.log('七之二、席位不按部门认');
  // 团队已经认领到 sales（上面那一行）。名册里放一个这个团队的席位，再给它一个同名的 MCP 会话：
  // 团队挂在部门下不等于席位能碰这个部门的台——席位没有授予这一层，在「认领要业务侧放行」做完之前只认按台批的授予（3b）
  db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)').run('abcdef01', 'https://node.synthetic.invalid', 'z', Date.now(), Date.now());
  db.prepare('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)').run('abcdef01', 'z/canvas/tigers', 'seat-t', 'sid-seat-t', 'seat-t', 'member', Date.now(), Date.now());
  const seatT = (await srv.call('POST', '/api/mcp/sessions', { ...token, body: { name: 'seat-t' } })).json;
  const call = async (tk, name, args) => { const x = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${tk}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }); return x.json?.error?.code ?? (x.json?.result?.isError ? 'isError' : 'ok'); };
  const s1 = await call(seatT.token, 'dataset_list', { bench: 'team-b' }), s2 = await call(seatT.token, 'dataset_list', { bench: 'sales-b' }), s3 = await call(seatT.token, 'dataset_query', { bench: 'team-b', query: { dataset: 'x' } });
  const listed = ((await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${seatT.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json?.result?.tools ?? []).map((t) => t.name);
  check(typeof seatT?.token === 'string' && s1 === -32601 && s2 === -32601 && s3 === -32601 && !listed.includes('dataset_list') && db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE session_id = ?').get(seatT.id).n === 0,
    '团队认领到部门之后，这个团队的席位仍调不了这个部门的台（细到这个团队的台也不行）：没有按台批的授予就和没有这个工具一样', { team: s1, dept: s2, query: s3 });
  const g1 = await st(lead, 'PUT', '/team-b/mcp-grants', { session: 'seat-t', tools: ['dataset_list'] });
  const s4 = await call(seatT.token, 'dataset_list', { bench: 'team-b' }), s5 = await call(seatT.token, 'dataset_list', { bench: 'sales-b' });
  check(g1 === 200 && s4 === 'ok' && s5 === -32601, '有部门拍板授予的人按台批给它之后：批了的那个台调得了，同部门别的台照样不行', { grant: g1, granted: s4, other: s5 });

  r = await srv.call('PUT', '/api/bench-views/team-b/binding', { ...boss, body: { department: 'sales' } });
  const kept = await call(seatT.token, 'dataset_list', { bench: 'team-b' });
  check(r.status === 200 && r.json?.changed === true && r.json.revoked_mcp_grants === 0 && kept === 'ok', '同一个部门里从细到团队放开：部门没变，已有的 MCP 授予不动', { resp: r.text.slice(0, 160), kept });
  await srv.call('PUT', '/api/bench-views/team-b/binding', { ...boss, body: { department: 'sales', team_host: 'abcdef01', team: 'z/canvas/tigers' } });

  console.log('八、「等你拍板」');
  const ask = async (tools) => (await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${seat.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'access_request', arguments: { tools, reason: '合成' } } } })).status;
  await ask(['dataset_query@bench:sales-b']); await ask(['dataset_query@bench:ops-b']);
  const mine = async (opts) => { const v = (await srv.call('GET', '/api/attention', opts)).json; return { ids: (v?.items ?? []).filter((x) => x.source === 'bench-mcp').map((x) => x.source_id.split(':')[0]).sort().join(), visible: v?.sources?.['bench-mcp']?.visible }; };
  const vLead = await mine(lead), vMember = await mine(member), vBoss = await mine(boss), vSys = await mine(sys);
  check(vLead.ids === 'sales-b' && vLead.visible === true && vBoss.ids === 'ops-b,sales-b' && vMember.ids === '' && vMember.visible === false && vSys.ids === '' && vSys.visible === false,
    '部门负责人只看到自己部门的台上的申请；管理层看到全部；部门成员（没有拍板）看不到这一类', { lead: vLead, member: vMember, boss: vBoss, sys: vSys });
  const reqOps = db.prepare("SELECT id FROM bench_mcp_requests WHERE bench = 'ops-b' AND status = 'pending'").get().id, reqSales = db.prepare("SELECT id FROM bench_mcp_requests WHERE bench = 'sales-b' AND status = 'pending'").get().id;
  const dOps = await st(lead, 'POST', `/ops-b/mcp-requests/${reqOps}`, { approve: true }), dSales = await st(lead, 'POST', `/sales-b/mcp-requests/${reqSales}`, { approve: true });
  check(dOps === 403 && dSales === 200, '部门负责人批：自己部门的台上的批得了，别的部门的批不了', { ops: dOps, sales: dSales });

  console.log('九、主体停用');
  await srv.call('POST', '/api/principals/disable', { body: { id: 'user:beta', reason: '合成' } });
  const off1 = await st(member, 'GET', '/sales-b/datasets');
  check(off1 === 401 || off1 === 403, '主体停用之后：进不来', off1);
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`bench-views-dept-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
