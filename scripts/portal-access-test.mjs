#!/usr/bin/env node
/** 门户按台访问范围（portal-access.ts）。隔离 DATA_DIR、随机端口、本机上游替身、假身份来源（identity-fake-preload），合成口令与凭据；不碰生产。
 *  远程身份用 X-Forwarded-For 模拟（不带转发头的本机请求算本机命令行 = 管理员）。判据：
 *   A1 默认值：带凭据（URL token / bearer）的外部台新建后 access=admin；不带凭据 = all；显式 listed 生效
 *   A2 校验：非法 access 400 且不落库；listed 空名单 400；自产台/SOP 台设非 all 400
 *   A3 判定（enforce）：内部员工打不开 admin 台（403 JSON + X-WM-Access-Denied，上游零命中）；能开 all 台；
 *      名单里的人（user:<主体>）能开 listed 台且上游收到注入的凭据；有管理员授予的人、口令头、口令登录 cookie 能开 admin 台；门户账号先被登录门 401
 *   A4 页面导航被拒 → 403 HTML；WS 升级与 HTTP 同判（被拒断开、放行有字节）
 *   A5 改写：给 all 台加凭据自动收紧为 admin；显式 access=all 保留；改成自产台地址时回到 all
 *   A6 MCP：access / access_logins / cookie_set_id / auth 一律 400；带凭据的台改地址 403 且地址不变；改名照常
 *   A7 审计：拒绝与放行各有 source=portal-access 行，日志不含凭据明文
 *   A8 登录门 off：匿名（浏览器标记）打不开 admin 台、能开 all 台
 *   A9 迁移：旧库（无 access 列）启动后，带凭据的外部台回填 admin，其余 all，启动日志点名
 *   A10 导入：备份里没有 access 的带凭据行导入后为 admin，带了合法 access 的沿用
 *   A12 名单只收 user:（Odoo 已下线）：新建、改台加新的 odoo: 一律 400 且不落库；改台保留原有的 odoo: 项照常；
 *       备份恢复进来的旧 odoo: 项按查看人主体名下保留的历史 Odoo 绑定对上，没绑的人对不上 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SESSIONS } from './identity-fake-provider.mjs';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'portal-access-synthetic-admin';
const BEARER = 'portal-access-synthetic-bearer';
const URLTOKEN = 'portal-access-synthetic-urltoken';
mkdirSync('tmp', { recursive: true });

// Exercise the actual decider and transaction method without importing the application database.
const {createPortalAccess,decide,loginsOf,newOdooEntries,normalizeLogin}=await import('../server/src/portal-access.ts');
const {stripTypeScriptTypes}=await import('node:module'),{readFileSync}=await import('node:fs');
const serviceText=readFileSync('server/src/services/workbench.ts','utf8');
const methods=[...serviceText.matchAll(/^  accessTransaction<T>[(]operation: [(][)] => T[)]: T [{][\s\S]*?^  [}]/gm)];
if(methods.length!==1)throw Error('actual accessTransaction method not uniquely found');
const method=methods[0][0];
const memory=new DatabaseSync(':memory:');memory.exec('CREATE TABLE probe(id INTEGER)');
const transaction=new Function('db',stripTypeScriptTypes('const holder={'+method+'};holder;', {mode:'strip'})+';return holder.accessTransaction;')(memory);
let rolled=false;try{transaction(()=>{memory.exec('INSERT INTO probe VALUES(1)');throw Error('owned-failure')})}catch(error){rolled=error.message==='owned-failure'}
ok('A11 transaction error rolls back preceding writes',rolled&&memory.prepare('SELECT COUNT(*) n FROM probe').get().n===0);
transaction(()=>memory.exec('INSERT INTO probe VALUES(2)'));
ok('A11 transaction success commits',memory.prepare('SELECT COUNT(*) n FROM probe').get().n===1);memory.close();
const listed={id:7,url:'http://synthetic.invalid/',access:'listed',access_logins:['odoo:alice']};
ok('A11 equal login text without bound Odoo identity is not listed',!decide(listed,{via:'session',login:'alice',principal:'user:alice',admin:false,odooLogins:[]}).allow);
ok('A11 bound historical Odoo identity matches a legacy odoo: entry',decide(listed,{via:'session',login:'unrelated-session-name',principal:'user:someone',admin:false,odooLogins:['Alice']}).allow);
const listedUser={...listed,access_logins:['user:alice']};
ok('A12 user: entry matches the viewer principal',decide(listedUser,{via:'session',login:'x',principal:'user:alice',admin:false,odooLogins:[]}).allow);
ok('A12 user: entry does not match by login text alone (no principal)',!decide(listedUser,{via:'source',login:'alice',principal:null,admin:false,odooLogins:[]}).allow);
ok('A12 user: entry is not matched by a bound Odoo login of the same name',!decide(listedUser,{via:'session',login:'x',principal:'user:bob',admin:false,odooLogins:['alice']}).allow);
ok('A12 bare names normalize to user:, odoo: kept as written',normalizeLogin(' Alice ')==='user:alice'&&normalizeLogin('odoo:Alice')==='odoo:alice'&&normalizeLogin('USER:Alice')==='user:alice');
ok('A12 newOdooEntries flags only odoo: entries not already present',JSON.stringify(newOdooEntries(['odoo:a','odoo:b','user:c'],['odoo:A']))==='["odoo:b"]'&&newOdooEntries(['user:c']).length===0);
ok('A11 stored non-string ACL entries are ignored',loginsOf({...listed,access_logins:[123,{},null]}).length===0);
for(const channel of ['http','ws']){
  let row={...listed,access:'listed'},release,entered;
  const reached=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const guard=createPortalAccess({byId:()=>row,viewer:async()=>{entered();await wait;return{via:'source',login:'alice',principal:'user:alice',admin:false,odooLogins:['alice']}},log:()=>{}});
  const pending=guard({url:'/go/007/private',headers:{},socket:{remoteAddress:'192.0.2.5'}},channel);
  await reached;row={...row,access:'admin'};release();
  ok('A11 '+channel+' policy tightening while identity awaits is observed',!(await pending).allow);
}

// 上游替身：记录每次命中带来的凭据
const hits = [];
const up = createServer((req, res) => {
  hits.push({ url: req.url, auth: req.headers.authorization ?? '' });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ upstream: true }));
});
up.on('upgrade', (req, socket) => { hits.push({ url: req.url, auth: req.headers.authorization ?? '', ws: true }); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nupstream-ws'); });
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${up.address().port}`;

const PRELOAD = pathToFileURL(resolve('scripts/identity-fake-preload.mjs')).href;
function start(extra, tag, dataDir) {
  const PORT = 21000 + Math.floor(Math.random() * 11000);
  const DATA = dataDir ?? mkdtempSync(resolve('tmp', `portal-access-${tag}-`));
  const env = { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '', IDENTITY_SEAM_ROOT: resolve('.'), ...extra };
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete env[k];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { B: `http://127.0.0.1:${PORT}`, PORT, child, exited, out: () => out, DATA };
}
async function ready(inst) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (inst.child.exitCode !== null) return false;
    try { if ((await fetch(inst.B + '/api/health')).status === 200) return true; } catch { /* 未起 */ }
    await sleep(200);
  }
  return false;
}
async function stop(inst, keep = false) {
  if (inst.child.exitCode === null && inst.child.signalCode === null) { inst.child.kill(); await inst.exited; }
  if (!keep) rmSync(inst.DATA, { recursive: true, force: true });
}

const REMOTE = { 'x-forwarded-for': '198.51.100.7' };
const PAGE = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const ADM = { 'x-admin-token': ADMIN };
const sess = (s) => ({ ...REMOTE, cookie: `session_id=${s}` });
const req = async (B, method, path, headers = REMOTE, body) => {
  const r = await fetch(B + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
};
const rawWs = (port, path, headers) => new Promise((resolveWs) => {
  const s = connect(port, '127.0.0.1'); let bytes = '';
  const t = setTimeout(() => { s.destroy(); resolveWs(bytes); }, 1500);
  s.on('data', (d) => { bytes += d.toString(); });
  s.on('close', () => { clearTimeout(t); resolveWs(bytes); });
  s.on('error', () => { clearTimeout(t); resolveWs(bytes); });
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
});
const hitCount = () => hits.length;
const create = (B, body) => req(B, 'POST', '/api/workbenches', ADM, body);

// ---------- E：登录门 enforce ----------
console.log('E · WM_LOGIN_GATE=enforce');
const E = start({ WM_LOGIN_GATE: 'enforce', ADMIN_TOKEN: ADMIN }, 'enforce');
try {
  ok('E 启动', await ready(E), E.out().slice(-600));
  const B = E.B;
  // A1 默认值
  const wTok = await create(B, { name: 'tok', url: `${UP}/?token=${URLTOKEN}` });
  const wBear = await create(B, { name: 'bear', url: `${UP}/b/`, auth: { type: 'bearer', value: BEARER } });
  const wPlain = await create(B, { name: 'plain', url: `${UP}/p/` });
  const wList = await create(B, { name: 'listed', url: `${UP}/l/`, auth: { type: 'bearer', value: BEARER }, access: 'listed', access_logins: ['Beta'] });
  ok('A1 URL 带 token 的台默认 admin', wTok.status === 201 && wTok.body.access === 'admin', JSON.stringify(wTok.body));
  ok('A1 bearer 台默认 admin', wBear.status === 201 && wBear.body.access === 'admin');
  ok('A1 无凭据台 = all', wPlain.status === 201 && wPlain.body.access === 'all');
  ok('A1 显式 listed 生效、登录名规范化', wList.status === 201 && wList.body.access === 'listed' && JSON.stringify(wList.body.access_logins) === '["user:beta"]', JSON.stringify(wList.body));
  const pool=await req(B,'POST','/api/cookies',ADM,{label:'synthetic pool',cookies:[{name:'synthetic_cookie',value:'synthetic-value'}]});
  const pooled=await create(B,{name:'pooled',url:UP+'/pooled/',cookie_set_id:pool.body.id});
  ok('A1 valid cookie-pool attachment is stored and defaults to admin',pooled.status===201&&pooled.body.cookie_set_id===pool.body.id&&pooled.body.access==='admin');
  const invalidPool=await create(B,{name:'invalid-pool',url:UP+'/invalid-pool/',cookie_set_id:-1});
  ok('A2 nonpositive cookie-pool ID keeps the existing detach contract without raising privileges',invalidPool.status===201&&invalidPool.body.cookie_set_id===-1&&invalidPool.body.access==='all');
  // A2 校验
  const before = (await req(B, 'GET', '/api/workbenches', ADM)).body.length;
  ok('A2 非法 access 400', (await create(B, { name: 'bad', url: `${UP}/x/`, access: 'everyone' })).status === 400);
  ok('A2 listed 空名单 400', (await create(B, { name: 'bad2', url: `${UP}/y/`, access: 'listed', access_logins: [] })).status === 400);
  ok('A2 自产台设 admin 400', (await create(B, { name: 'bad3', url: '/apps/some-app/', access: 'admin' })).status === 400);
  ok('A2 被拒的写入都没落库', (await req(B, 'GET', '/api/workbenches', ADM)).body.length === before);

  // A3 判定
  const internal = sess(SESSIONS.alpha);
  let n0 = hitCount();
  let r = await req(B, 'GET', `/go/${wTok.body.id}/`, internal);
  ok('A3 内部员工打不开 admin 台：403 + 原因头', r.status === 403 && r.headers.get('x-wm-access-denied') === 'not-admin' && r.body?.error === 'workbench_access_denied', `${r.status} ${JSON.stringify(r.body)}`);
  ok('A3 被拒请求上游零命中', hitCount() === n0);
  r = await req(B, 'GET', `/go/${wPlain.body.id}/`, internal);
  ok('A3 内部员工能开 all 台', r.status === 200 && r.body?.upstream === true, `${r.status}`);
  n0 = hitCount();
  r = await req(B, 'GET', `/go/${wList.body.id}/`, sess(SESSIONS.beta));
  ok('A3 名单里的人能开 listed 台且上游收到凭据', r.status === 200 && hits.slice(n0).some((h) => h.auth === `Bearer ${BEARER}`), `${r.status}`);
  ok('A3 名单外的人打不开 listed 台', (await req(B, 'GET', `/go/${wList.body.id}/`, internal)).headers.get('x-wm-access-denied') === 'not-listed');
  n0 = hitCount();
  r = await req(B, 'GET', `/go/${wTok.body.id}/`, sess(SESSIONS.admin));
  ok('A3 有管理员授予的人能开 admin 台且 URL token 照常带上', r.status === 200 && hits.slice(n0).some((h) => String(h.url).includes(URLTOKEN)), `${r.status}`);
  ok('A3 口令头（远程）能开 admin 台', (await req(B, 'GET', `/go/${wBear.body.id}/`, { ...REMOTE, ...ADM })).status === 200);
  const login = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...REMOTE }, body: JSON.stringify({ token: ADMIN }) });
  const wl = /wm_login=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  ok('A3 口令登录 cookie 能开 admin 台', wl !== '' && (await req(B, 'GET', `/go/${wBear.body.id}/`, { ...REMOTE, cookie: `wm_login=${wl}` })).status === 200);
  ok('A3 门户账号先被登录门拦（401）', (await req(B, 'GET', `/go/${wPlain.body.id}/`, sess(SESSIONS.portal))).status === 401);
  // A4 页面与 WS
  r = await req(B, 'GET', `/go/${wBear.body.id}/`, { ...internal, ...PAGE });
  ok('A4 页面导航被拒 → 403 HTML', r.status === 403 && typeof r.body === 'string' && r.body.includes('只给管理员'), `${r.status}`);
  n0 = hitCount();
  const wsDenied = await rawWs(E.PORT, `/go/${wTok.body.id}/ws`, { 'x-forwarded-for': '198.51.100.7', cookie: `session_id=${SESSIONS.alpha}` });
  ok('A4 WS：内部员工连 admin 台被断开、上游零命中', !wsDenied.includes('101') && hitCount() === n0, JSON.stringify(wsDenied.slice(0, 40)));
  const wsOk = await rawWs(E.PORT, `/go/${wTok.body.id}/ws`, { 'x-forwarded-for': '198.51.100.7', cookie: `session_id=${SESSIONS.admin}` });
  ok('A4 WS：有管理员授予的人连 admin 台能握手', wsOk.includes('101'), JSON.stringify(wsOk.slice(0, 40)));

  for(const path of [`/go/${wTok.body.id}suffix`, `/go/00${wTok.body.id}/private`, `/go/${wTok.body.id}/private?x=1`]){
    const before=hitCount(), denied=await req(B,'GET',path,internal);
    ok('A4 alternate accepted portal path stays restricted '+path,denied.status===403&&hitCount()===before);
    const deniedWs=await rawWs(E.PORT,path,{...internal});
    ok('A4 alternate WS path denied before upstream '+path,!deniedWs.includes('101')&&hitCount()===before);
  }
  // A5 改写
  r = await req(B, 'PUT', `/api/workbenches/${wPlain.body.id}`, ADM, { auth: { type: 'basic', value: 'u:p' } });
  ok('A5 给 all 台加凭据自动收紧为 admin', r.status === 200 && r.body.access === 'admin', JSON.stringify(r.body));
  r = await req(B, 'PUT', `/api/workbenches/${wPlain.body.id}`, ADM, { access: 'all' });
  ok('A5 显式 access=all 保留（管理员明确选择）', r.status === 200 && r.body.access === 'all');
  r = await req(B, 'PUT', `/api/workbenches/${wPlain.body.id}`, ADM, { name: 'plain-renamed' });
  ok('A5 只改名不动范围', r.status === 200 && r.body.access === 'all');
  r = await req(B, 'PUT', `/api/workbenches/${wTok.body.id}`, ADM, { access: 'listed', access_logins: ['alpha'] });
  ok('A5 改成 listed 后名单里的人能开', r.status === 200 && (await req(B, 'GET', `/go/${wTok.body.id}/`, internal)).status === 200);

  // A12 名单只收 user:
  const nBefore = (await req(B, 'GET', '/api/workbenches', ADM)).body.length;
  r = await create(B, { name: 'odoo-new', url: `${UP}/o/`, access: 'listed', access_logins: ['odoo:somebody'] });
  ok('A12 新建台名单带 odoo: → 400 且不落库', r.status === 400 && String(r.body?.error ?? '').includes('odoo:') && (await req(B, 'GET', '/api/workbenches', ADM)).body.length === nBefore, `${r.status} ${JSON.stringify(r.body)}`);
  const listBefore = JSON.stringify((await req(B, 'GET', `/api/workbenches/${wList.body.id}`, ADM)).body);
  r = await req(B, 'PUT', `/api/workbenches/${wList.body.id}`, ADM, { access: 'listed', access_logins: ['beta', 'odoo:somebody'] });
  ok('A12 改台加新的 odoo: → 400 且台不变', r.status === 400 && JSON.stringify((await req(B, 'GET', `/api/workbenches/${wList.body.id}`, ADM)).body) === listBefore, `${r.status}`);
  // 备份恢复进来的旧项（合并导入照收历史数据）
  const imp = await req(B, 'POST', '/api/import', ADM, { mode: 'merge', workbenches: [{ name: 'legacy-listed', url: `${UP}/legacy/`, auth: { type: 'bearer', value: BEARER }, access: 'listed', access_logins: ['odoo:Legacy.Beta'] }] });
  const legacy = (await req(B, 'GET', '/api/workbenches', ADM)).body.find((w) => w.name === 'legacy-listed');
  ok('A12 备份恢复的旧 odoo: 项照收', imp.status === 200 && JSON.stringify(legacy?.access_logins) === '["odoo:legacy.beta"]', `${imp.status} ${JSON.stringify(legacy)}`);
  ok('A12 主体名下没有历史绑定：旧 odoo: 项对不上', (await req(B, 'GET', `/go/${legacy.id}/`, sess(SESSIONS.beta))).headers.get('x-wm-access-denied') === 'not-listed');
  { const d = new DatabaseSync(join(E.DATA, 'workbench-market.db'), { timeout: 10_000 }); d.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('odoo', 'Legacy.Beta', 'legacy.beta', 'user:beta')").run(); d.close(); }
  n0 = hitCount();
  r = await req(B, 'GET', `/go/${legacy.id}/`, sess(SESSIONS.beta));
  ok('A12 主体名下保留的历史 Odoo 绑定对上旧 odoo: 项', r.status === 200 && hits.slice(n0).some((h) => h.auth === `Bearer ${BEARER}`), `${r.status} ${r.headers.get('x-wm-access-denied')}`);
  ok('A12 别人（没有那条绑定）仍对不上', (await req(B, 'GET', `/go/${legacy.id}/`, internal)).headers.get('x-wm-access-denied') === 'not-listed');
  r = await req(B, 'PUT', `/api/workbenches/${legacy.id}`, ADM, { access: 'listed', access_logins: ['odoo:legacy.beta', 'alpha'] });
  ok('A12 改台保留原有的 odoo: 项、加 user: 项照常', r.status === 200 && JSON.stringify(r.body.access_logins) === '["odoo:legacy.beta","user:alpha"]' && (await req(B, 'GET', `/go/${legacy.id}/`, internal)).status === 200, `${r.status} ${JSON.stringify(r.body)}`);

  // A6 MCP
  const s = await req(B, 'POST', '/api/mcp/sessions', ADM, { name: 'portal-access-agent' });
  const tok = s.body?.token;
  await req(B, 'PUT', `/api/mcp/sessions/${s.body?.id}/grants`, ADM, { grants: ['workbench_register', 'workbench_update'] });
  const call = async (name, args) => {
    const x = await req(B, 'POST', '/mcp', { authorization: `Bearer ${tok}` }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const bad = !!x.body?.error || !!x.body?.result?.isError;
    return { bad, text: JSON.stringify(x.body) };
  };
  ok('A6 MCP 会话就绪', typeof tok === 'string' && tok.length > 0, JSON.stringify(s.body));
  for (const [k, v] of [['access', 'all'], ['access_logins', ['x']], ['cookie_set_id', 1], ['auth', { type: 'bearer', value: 'x' }]]) {
    const before=JSON.stringify((await req(B,'GET',`/api/workbenches/${wBear.body.id}`,ADM)).body);
    const x = await call('workbench_update', { id: wBear.body.id, [k]: v });
    ok(`A6 MCP 写 ${k} 被拒`, x.bad && x.text.includes(k), x.text.slice(0, 200));
    ok(`A6 MCP rejected ${k} leaves existing row exactly unchanged`,JSON.stringify((await req(B,'GET',`/api/workbenches/${wBear.body.id}`,ADM)).body)===before);
  }
  ok('A6 MCP 新建带 access 被拒', (await call('workbench_register', { name: 'm', url: `${UP}/m/`, access: 'all' })).bad);
  const moved = await call('workbench_update', { id: wBear.body.id, url: `${UP}/elsewhere/` });
  const after = (await req(B, 'GET', `/api/workbenches/${wBear.body.id}`, ADM)).body;
  ok('A6 MCP 改带凭据台的地址被拒且地址不变', moved.bad && moved.text.includes('改地址') && after.url === `${UP}/b/`, moved.text.slice(0, 200));
  ok('A6 MCP 只改名照常', !(await call('workbench_update', { id: wBear.body.id, name: 'bear-renamed' })).bad);

  // A7 审计
  const logs = E.out().split('\n').filter((l) => l.includes('"source":"portal-access"'));
  ok('A7 有拒绝与放行审计行', logs.some((l) => l.includes('"verdict":"deny"')) && logs.some((l) => l.includes('"verdict":"allow"')), String(logs.length));
  ok('A7 日志不含凭据明文', !E.out().includes(BEARER) && !E.out().includes(URLTOKEN));
} finally { await stop(E); }

// ---------- O：登录门 off ----------
console.log('O · WM_LOGIN_GATE=off');
const O = start({ WM_LOGIN_GATE: undefined, ADMIN_TOKEN: ADMIN }, 'off');
try {
  ok('O 启动', await ready(O), O.out().slice(-600));
  const B = O.B;
  const wBear = await create(B, { name: 'bear', url: `${UP}/b/`, auth: { type: 'bearer', value: BEARER } });
  const wPlain = await create(B, { name: 'plain', url: `${UP}/p/` });
  const anon = { ...REMOTE, ...PAGE };
  ok('A8 匿名打不开 admin 台（anonymous）', (await req(B, 'GET', `/go/${wBear.body.id}/`, { ...REMOTE })).headers.get('x-wm-access-denied') === 'anonymous');
  ok('A8 匿名能开 all 台（旧行为）', (await req(B, 'GET', `/go/${wPlain.body.id}/`, anon)).status === 200);
} finally { await stop(O); }

// ---------- M：旧库迁移 ----------
console.log('M · 旧库（无 access 列）迁移');
{
  const DATA = mkdtempSync(resolve('tmp', 'portal-access-migrate-'));
  const M1 = start({ WM_LOGIN_GATE: undefined, ADMIN_TOKEN: ADMIN }, 'migrate', DATA);
  ok('M1 首次启动', await ready(M1), M1.out().slice(-400));
  await stop(M1, true);
  const db = new DatabaseSync(join(DATA, 'workbench-market.db'));
  db.exec('ALTER TABLE workbenches DROP COLUMN access'); db.exec('ALTER TABLE workbenches DROP COLUMN access_logins');
  const ins = db.prepare("INSERT INTO workbenches (name, url, type, auth_config) VALUES (?, ?, 'web', ?)");
  const a = Number(ins.run('legacy-token', `${UP}/?token=${URLTOKEN}`, '').lastInsertRowid);
  const b = Number(ins.run('legacy-bearer', `${UP}/b/`, JSON.stringify({ type: 'bearer', value: BEARER })).lastInsertRowid);
  const c = Number(ins.run('legacy-plain', `${UP}/p/`, '').lastInsertRowid);
  const d = Number(ins.run('legacy-app', '/apps/legacy/', '').lastInsertRowid);
  db.close();
  const M2 = start({ WM_LOGIN_GATE: undefined, ADMIN_TOKEN: ADMIN }, 'migrate', DATA);
  try {
    ok('M2 再次启动', await ready(M2), M2.out().slice(-400));
    const list = (await req(M2.B, 'GET', '/api/workbenches', ADM)).body;
    const acc = (id) => list.find((w) => w.id === id)?.access;
    ok('A9 URL token 行回填 admin', acc(a) === 'admin');
    ok('A9 bearer 行回填 admin', acc(b) === 'admin');
    ok('A9 无凭据行保持 all', acc(c) === 'all' && acc(d) === 'all');
    ok('A9 启动日志点名回填的台', M2.out().includes('[portal-access]') && M2.out().includes(String(a)) && M2.out().includes(String(b)));
    // A10 导入
    const imp = await req(M2.B, 'POST', '/api/import', ADM, { mode: 'replace', types: [], workbenches: [
      { name: 'imp-bearer', url: `${UP}/ib/`, auth: { type: 'bearer', value: BEARER } },
      { name: 'imp-listed', url: `${UP}/il/`, auth: { type: 'bearer', value: BEARER }, access: 'listed', access_logins: ['someone'] },
      { name: 'imp-plain', url: `${UP}/ip/` },
    ] });
    const l2 = (await req(M2.B, 'GET', '/api/workbenches', ADM)).body;
    const by = (n) => l2.find((w) => w.name === n);
    ok('A10 导入：没带 access 的带凭据行为 admin', imp.status === 200 && by('imp-bearer')?.access === 'admin', `${imp.status} ${JSON.stringify(imp.body).slice(0, 200)}`);
    ok('A10 导入：带了合法 access 的沿用', by('imp-listed')?.access === 'listed' && JSON.stringify(by('imp-listed')?.access_logins) === '["user:someone"]');
    ok('A10 导入：无凭据行 all', by('imp-plain')?.access === 'all');
    const snapshot=JSON.stringify(l2);
    const invalid=await req(M2.B,'POST','/api/import',ADM,{mode:'replace',workbenches:[{name:'would-replace',url:`${UP}/valid/`},{name:'invalid-access',url:`${UP}/invalid/`,access:'listed',access_logins:[]}]});
    ok('A10 invalid ACL rejects whole replace import before any writes',invalid.status===400&&JSON.stringify((await req(M2.B,'GET','/api/workbenches',ADM)).body)===snapshot);
    const invalidType=await req(M2.B,'PUT',`/api/workbenches/${by('imp-listed').id}`,ADM,{access:'listed',access_logins:[{toString:'someone'}]});
    ok('A10 non-string ACL member rejects without row mutation',invalidType.status===400&&JSON.stringify((await req(M2.B,'GET','/api/workbenches',ADM)).body)===snapshot);
  } finally { await stop(M2); }
}

up.close();
console.log(`\n门户按台访问范围：${pass} 过 / ${fail} 不过`);
process.exit(fail ? 1 : 0);
