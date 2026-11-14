#!/usr/bin/env node
/** 全站登录门冒烟（WM_LOGIN_GATE=enforce|off）。隔离 DATA_DIR、随机端口、本机 GitHub 替身与 Odoo 替身，合成口令与中性 slug；不碰生产。
 *  远程匿名用 X-Forwarded-For 模拟（同机反代转进来的不算本机命令行）。判据：
 *   G1 enforce 匿名：/、/apps、/sop、/go 页面 302 /login?next=…；/api/apps、文件接口 401 JSON；大小写/绝对形式不绕过；健康检查与自检三行
 *   G2 口令登录：cookie HttpOnly、SameSite=Lax、12 小时、http 不带 Secure（https 带）、不含口令；登录后全部可访问；登出后同一 cookie 被拦
 *   G3 错误口令 401 且与「未设置口令」同答；连续失败退避 429；每分钟 10 次 429；审计行不含口令
 *   G4 next 只收同站相对路径（//、外站、反斜杠、/api、/login 一律回 /）
 *   G5 沙箱页：带本台 X-App-Token 的 data/files 放行，异台令牌被拦；查看凭证只对本台、篡改即拦、不能当顶层页面打开；预检放行
 *   G6 /mcp：匿名 401（MCP_GATEWAY=off 也被强制开），有效会话 200
 *   G7 本机命令行放行；浏览器标记的本机请求不算命令行；X-Admin-Token 头放行
 *   G8 Odoo：内部员工会话放行，门户账号被拦；登录中继只放登录用的那一个入口；WS 升级匿名断开
 *   G9 A2A：签名卡片放行；/a2a/direct 放行到路由、无签名 → 401
 *   G13 来源 IP：同机反代（对端回环）时按 X-Real-IP / X-Forwarded-For 最右一项分桶限频、审计记真实 IP；对端不是本机时转发头一律不信
 *   G12 按 run 凭据：读凭证只放行该 run 的读与附件下载，上传令牌只放行该 run（执行中）的附件上传；换 run、伪造、吊销、结束都拦
 *   G11 首次 enforce 轮换按台令牌密钥：开门前的旧令牌 401、新令牌放行、记号与密钥 600、日志无密钥、第二次启动不再轮换
 *   G10 off：匿名照旧可读、不跳登录、health 报 off；口令轮换后旧 cookie 失效；非法开关值拒绝启动 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
const readdirSafe = (d) => { try { return readdirSync(d); } catch { return []; } };
import { resolve } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'gate-smoke-synthetic-admin';
mkdirSync('tmp', { recursive: true });

// Odoo 替身：session_id 前缀决定身份；其余路径 404（WS 升级判据看有没有字节回来）
const odoo = createServer((req, res) => {
  const sid = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
  if (req.url === '/web/session/get_session_info') {
    const admin = sid.startsWith('adminsession'), internal = admin || sid.startsWith('internalsession'), portal = sid.startsWith('portalsession');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(internal || portal ? { result: { uid: 7, username: admin ? 'gate.admin' : internal ? 'gate.internal' : 'gate.portal', name: 'Synthetic', is_internal_user: internal, is_admin: admin } } : { result: { uid: false } }));
  }
  res.statusCode = 404; res.end('odoo-fixture-404');
});
odoo.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); });
await new Promise((r) => odoo.listen(0, '127.0.0.1', r));
const ODOO = `http://127.0.0.1:${odoo.address().port}`;
const gh = await startFakeGithub();

function start(extra, tag, dataDir) {
  const PORT = 21000 + Math.floor(Math.random() * 11000);
  const DATA = dataDir ?? mkdtempSync(resolve('tmp', `login-gate-${tag}-`));
  const env = { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '', WM_GITHUB_API: gh.api, ...extra };
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete env[k];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
const PAGE = { ...REMOTE, accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const req = (B, method, path, headers = REMOTE, body) => fetch(B + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
const cookieOf = (r) => (r.headers.get('set-cookie') ?? '');
const loginCookie = (r) => /wm_login=([^;]+)/.exec(cookieOf(r))?.[1] ?? '';
const rawWs = (port, path, cookie) => new Promise((resolveWs) => {
  const s = connect(port, '127.0.0.1'); let bytes = 0;
  const t = setTimeout(() => { s.destroy(); resolveWs(bytes); }, 1500);
  s.once('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 198.51.100.7\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
  s.on('data', (b) => { bytes += b.length; }); s.on('error', () => {});
  s.once('close', () => { clearTimeout(t); resolveWs(bytes); });
});

// ================= enforce =================
console.log('== enforce（MCP_GATEWAY=off 一并设上，验证被强制开）==');
const E = start({ WM_LOGIN_GATE: 'enforce', MCP_GATEWAY: 'off', ADMIN_TOKEN: ADMIN, WM_ODOO_URL: ODOO, WM_ODOO_ORIGINS: ODOO }, 'enforce');
try {
  ok('enforce 实例就绪', await ready(E), E.out().slice(-400));
  const B = E.B;
  const h = await (await fetch(B + '/api/health', { headers: REMOTE })).json();
  ok('G1 /api/health 匿名可读并报 login_gate=enforce', h.login_gate === 'enforce' && h.self_probe?.passed === true);
  ok('G1 自检含三条登录门探测且全过', ['page', 'app', 'api'].every((k) => h.self_probe.rows.some((x) => x.id === `market.login-gate.${k}` && x.verdict === 'pass')));

  // 本机命令行布置（G7 也顺带证明命令行放行）：两个自产台、一个 SOP 台、一个 Odoo 外部台、一个上传文件
  const pa = await ghPublish(B, gh, { slug: 'gate-app', title: 'Gate App', files: [
    { path: 'index.html', content: '<html><head><link rel="stylesheet" href="/apps/gate-app/style.css"></head><body><script src="app.js"></script><img src="/api/apps/gate-app/files/1"></body></html>' },
    { path: 'app.js', content: 'window.GATE_APP=1;' }, { path: 'style.css', content: 'body{}' }] }, { 'x-admin-token': ADMIN });
  const pb = await ghPublish(B, gh, { slug: 'gate-other', title: 'Gate Other', files: [{ path: 'index.html', content: '<html><head></head><body>other</body></html>' }, { path: 'app.js', content: '1' }] }, { 'x-admin-token': ADMIN });
  const ps = await ghPublish(B, gh, { slug: 'gate-sop', kind: 'sop', title: 'Gate SOP', changelog: 'synthetic', files: [{ path: 'sop.yaml', content: JSON.stringify({ title: 'Gate SOP', steps: [{ key: 'one', title: 'One', body: '<p>x</p>' }] }) }] }, { 'x-admin-token': ADMIN });
  const pp = await req(B, 'POST', '/api/sops/gate-sop/publish', {}, { changelog: 'synthetic' });
  ok('G7 本机命令行布置：同步两个自产台、一个 SOP 台并上架', [pa, pb, ps].every((r) => r.status === 201) && pp.status === 200, [pa, pb, ps, pp].map((r) => r.status).join(','));
  const fd = new FormData(); fd.append('file', new Blob(['synthetic file body'], { type: 'text/plain' }), 'note.txt');
  const up = await fetch(B + '/api/apps/gate-app/files', { method: 'POST', body: fd });
  const upj = await up.json().catch(() => ({}));
  const fileId = upj.id ?? upj.file?.id;
  ok('G7 本机命令行上传文件', up.status < 300 && Number.isInteger(fileId), `${up.status} ${JSON.stringify(upj).slice(0, 120)}`);
  const ow = await req(B, 'POST', '/api/workbenches', {}, { name: 'Odoo Fixture', url: ODOO + '/', type: 'odoo' });
  const owj = await ow.json();
  const wbs = await (await req(B, 'GET', '/api/workbenches', {})).json();
  const appWb = wbs.find((w) => w.url === '/apps/gate-app/');
  ok('G7 本机命令行登记 Odoo 台并找到自产台的 /go 入口', ow.status === 201 && !!appWb, `${ow.status}`);
  const appGo = `/go/${appWb?.id}/`, odooGo = `/go/${owj.id}/`;

  // G1 匿名
  for (const p of ['/', '/apps/gate-app/', '/apps/x/', '/sop/gate-sop/', '/sop/x/', appGo, '/go/1/', '/use/1']) {
    const r = await req(B, 'GET', p, PAGE);
    const loc = r.headers.get('location') ?? '';
    ok(`G1 匿名页面 ${p} → 302 /login${p === '/' ? '' : '?next=…'}`, r.status === 302 && (p === '/' ? loc === '/login' : loc === `/login?next=${encodeURIComponent(p)}`), `${r.status} ${loc}`);
  }
  for (const p of ['/api/apps', `/api/apps/gate-app/files/${fileId}`, '/api/apps/x/files/1', '/api/workbenches', '/api/apps/gate-app/data', '/API/apps', '/api/health/../apps', `/apps/gate-app/app.js`]) {
    const r = await req(B, 'GET', p);
    const j = await r.json().catch(() => ({}));
    ok(`G1 匿名接口 ${p} → 401 JSON`, r.status === 401 && j.error === 'login_required' && r.headers.get('x-wm-login-required') === '1', `${r.status}`);
  }
  {
    const r = await req(B, 'GET', '/api/apps', PAGE); // API 不因 Accept: text/html 变成跳转
    ok('G1 /api 带 text/html 也回 401 不跳转', r.status === 401);
    const w = await req(B, 'POST', '/api/workbenches', { ...REMOTE, origin: 'http://198.51.100.7' }, { name: 'x', url: 'http://127.0.0.1:9/' });
    ok('G1 匿名写 → 401（登录门先于管理写门）', w.status === 401);
  }

  // G3 错误口令、同答、限频（先于成功登录：成功会清零连败计数）
  const bad1 = await req(B, 'POST', '/api/auth/login', REMOTE, { token: 'wrong-synthetic' });
  const bad1j = await bad1.json();
  ok('G3 错误口令 → 401 口令无效，不发 cookie', bad1.status === 401 && bad1j.error === '口令无效' && !loginCookie(bad1));
  await req(B, 'POST', '/api/auth/login', REMOTE, { token: 'wrong-synthetic-2' });
  await req(B, 'POST', '/api/auth/login', REMOTE, { token: 'wrong-synthetic-3' });
  const bo = await req(B, 'POST', '/api/auth/login', REMOTE, { token: ADMIN });
  ok('G3 连续失败 3 次后退避：连正确口令也先 429 带 Retry-After', bo.status === 429 && Number(bo.headers.get('retry-after')) >= 1, `${bo.status}`);
  await sleep(1300);
  const xs = await req(B, 'POST', '/api/auth/login', { ...REMOTE, origin: 'http://evil.example' }, { token: ADMIN });
  ok('G3 跨源登录 → 403', xs.status === 403);

  // G2 口令登录
  const li = await req(B, 'POST', '/api/auth/login', REMOTE, { token: ADMIN });
  const sc = cookieOf(li), ck = loginCookie(li);
  ok('G2 退避过后正确口令 → 200 并发 cookie', li.status === 200 && !!ck, `${li.status}`);
  ok('G2 cookie HttpOnly、SameSite=Lax、Max-Age 12 小时、http 下无 Secure', /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Max-Age=43200/.test(sc) && !/Secure/i.test(sc), sc);
  ok('G2 cookie 里不含口令', !decodeURIComponent(ck).includes(ADMIN) && !Buffer.from(ck.split('.')[0], 'base64url').toString().includes(ADMIN));
  ok('G3 审计行只记结果/来源/时间，不含口令', /"source":"login-gate","event":"login","ok":false,"ip":"[^"]+","at":"[^"]+"}/.test(E.out()) && /"ok":true/.test(E.out()) && !E.out().includes(ADMIN) && !E.out().includes('wrong-synthetic'));
  const C = { ...REMOTE, cookie: `wm_login=${ck}` }, CP = { ...PAGE, cookie: `wm_login=${ck}` };
  {
    const https = await req(B, 'POST', '/api/auth/login', { ...REMOTE, 'x-forwarded-proto': 'https' }, { token: ADMIN });
    ok('G2 https（X-Forwarded-Proto）时 cookie 带 Secure', https.status === 200 && /;\s*Secure/i.test(cookieOf(https)));
  }
  for (const p of ['/api/apps', '/api/workbenches', '/sop/gate-sop/']) {
    const r = await req(B, 'GET', p, C);
    ok(`G2 登录后 ${p} → 200`, r.status === 200, `${r.status}`);
  }
  {
    // 台的附件：过了登录门还要台令牌或管理员——登录 cookie 本身不算管理员，带上口令头才行
    const bare = await req(B, 'GET', `/api/apps/gate-app/files/${fileId}`, C);
    const admin = await req(B, 'GET', `/api/apps/gate-app/files/${fileId}`, { ...C, 'x-admin-token': ADMIN });
    ok('G2 登录后读台的附件：只有登录 cookie 403，带口令头 200', bare.status === 403 && admin.status === 200, `${bare.status}/${admin.status}`);
  }
  {
    const r = await req(B, 'GET', '/', CP);
    ok('G2 登录后 / 不再跳登录', r.status !== 302 && r.status !== 401, `${r.status}`);
    const me = await (await req(B, 'GET', '/api/auth/me', C)).json();
    ok('G2 /api/auth/me 报 cookie 身份', me.authenticated === true && me.via === 'cookie' && me.gate === 'enforce');
  }

  // G5 自产台：已登录打开 → 302 到带查看凭证的地址
  let cap = '';
  for (const base of ['/apps/gate-app', appGo.slice(0, -1)]) {
    const r = await req(B, 'GET', base + '/?version=1', CP);
    const loc = r.headers.get('location') ?? '';
    const m = new RegExp(`^${base.replace(/\//g, '\\/')}\\/~wm\\/([0-9a-z]+\\.[0-9a-f]{32})\\/\\?version=1$`).exec(loc);
    ok(`G5 登录后打开 ${base}/ → 302 带查看凭证（保留查询串）`, r.status === 302 && !!m, `${r.status} ${loc}`);
    if (m && !cap) cap = m[1];
  }
  const capBase = `/apps/gate-app/~wm/${cap}`;
  {
    const r = await req(B, 'GET', capBase + '/', CP);
    const html = await r.text();
    const tok = /<meta name="wm-app-token" content="([0-9a-f]{64})">/.exec(html)?.[1] ?? '';
    ok('G5 凭证地址出页面：注入台令牌', r.status === 200 && !!tok);
    ok('G5 页面里指向本台的绝对地址已补凭证（静态属性）', html.includes(`href="${capBase}/style.css"`) && html.includes(`src="/api/apps/gate-app/files/1?wm_av=${cap}"`));
    // 沙箱子资源：不带 cookie
    const SUB = { ...REMOTE, 'sec-fetch-dest': 'script', 'sec-fetch-site': 'cross-site' };
    const js = await req(B, 'GET', capBase + '/app.js', SUB);
    ok('G5 沙箱子资源凭查看凭证（无 cookie）→ 200', js.status === 200 && (await js.text()).includes('GATE_APP'));
    const go = await req(B, 'GET', `${appGo}~wm/${cap}/app.js`, SUB);
    ok('G5 /go/<自产台> 下同一凭证同样可用', go.status === 200, `${go.status}`);
    const other = await req(B, 'GET', `/apps/gate-other/~wm/${cap}/app.js`, SUB);
    ok('G5 凭证换到别的台 → 拦', other.status === 401, `${other.status}`);
    const forged = cap.slice(0, -1) + (cap.endsWith('0') ? '1' : '0');
    ok('G5 篡改凭证 → 拦', (await req(B, 'GET', `/apps/gate-app/~wm/${forged}/app.js`, SUB)).status === 401);
    const expired = (Math.floor(Date.now() / 1000) - 10).toString(36) + '.' + cap.split('.')[1];
    ok('G5 过期凭证（签名不符）→ 拦', (await req(B, 'GET', `/apps/gate-app/~wm/${expired}/app.js`, SUB)).status === 401);
    const top = await req(B, 'GET', capBase + '/', PAGE);
    ok('G5 凭证地址不能当顶层页面匿名打开 → 302 登录（next 去掉凭证）', top.status === 302 && top.headers.get('location') === `/login?next=${encodeURIComponent('/apps/gate-app/')}`, `${top.status} ${top.headers.get('location')}`);
    const frame = await req(B, 'GET', capBase + '/', { ...REMOTE, accept: 'text/html', 'sec-fetch-dest': 'iframe' });
    ok('G5 沙箱 iframe 内导航（无 cookie）凭凭证 → 200', frame.status === 200);
    const img = await req(B, 'GET', `/api/apps/gate-app/files/${fileId}?wm_av=${cap}`, { ...REMOTE, 'sec-fetch-dest': 'image' });
    ok('G5 <img src> 文件凭 wm_av → 200', img.status === 200);
    const imgOther = await req(B, 'GET', `/api/apps/gate-other/files/${fileId}?wm_av=${cap}`, REMOTE);
    ok('G5 wm_av 换到别的台的文件接口 → 401', imgOther.status === 401);
    const listAv = await req(B, 'GET', `/api/apps/gate-app/files?wm_av=${cap}`, REMOTE);
    ok('G5 wm_av 不放行文件列表（只放单个文件）', listAv.status === 401);
    // X-App-Token
    const T = (t) => ({ ...REMOTE, origin: 'null', 'x-app-token': t });
    const f1 = await req(B, 'GET', `/api/apps/gate-app/files/${fileId}`, T(tok));
    ok('G5 带本台 X-App-Token 读文件（无 cookie）→ 200', f1.status === 200);
    const d1 = await req(B, 'POST', '/api/apps/gate-app/data', T(tok), { synthetic: 1 });
    ok('G5 带本台 X-App-Token 写数据 → 放行（非 401）', d1.status !== 401 && d1.status < 500, `${d1.status}`);
    const f2 = await req(B, 'GET', `/api/apps/gate-other/files/${fileId}`, T(tok));
    ok('G5 令牌不属于该台 → 401', f2.status === 401);
    const f3 = await req(B, 'GET', '/api/apps', T(tok));
    ok('G5 台令牌不放行台数据面以外的接口', f3.status === 401);
    const pre = await req(B, 'OPTIONS', '/api/apps/gate-app/data', { ...REMOTE, origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-app-token' });
    ok('G5 沙箱预检 → 204 带允许头', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'null');
    const tokens = await req(B, 'GET', '/design/tokens@1.css', REMOTE);
    ok('G5 设计 token 样式表（公开设计变量）匿名可取', tokens.status !== 401 && tokens.status !== 302, `${tokens.status}`);
    const dl = await req(B, 'GET', `/api/skills/dl/${'0'.repeat(64)}`, REMOTE);
    ok('G5 技能包下载票据路径放行到路由（假票 404，不是 401）', dl.status === 404, `${dl.status}`);
    const dl2 = await req(B, 'GET', '/api/skills/dl/not-a-ticket', REMOTE);
    const sk = await req(B, 'GET', '/api/skills', REMOTE);
    ok('G5 票号格式不对、技能列表仍要登录', dl2.status === 401 && sk.status === 401, `${dl2.status} ${sk.status}`);
  }

  // G6 MCP
  {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
    const a = await req(B, 'POST', '/mcp', REMOTE, init);
    ok('G6 /mcp 匿名 → 401 Bearer（MCP_GATEWAY=off 被强制开）', a.status === 401 && /Bearer/.test(a.headers.get('www-authenticate') ?? ''));
    const ac = await req(B, 'POST', '/mcp', C, init);
    ok('G6 /mcp 只带登录 cookie 仍 401（只认网关会话）', ac.status === 401);
    const s = await (await req(B, 'POST', '/api/mcp/sessions', { 'x-admin-token': ADMIN }, { name: 'gate-smoke' })).json();
    const v = await req(B, 'POST', '/mcp', { ...REMOTE, authorization: `Bearer ${s.token}` }, init);
    ok('G6 /mcp 有效会话 → 200', v.status === 200 && (await v.json()).result?.serverInfo?.name === 'workbench-market');
    for (const [m, pth] of [['GET', '/openapi.json'], ['GET', '/api/mcp-rest/openapi.json'], ['POST', '/api/mcp-rest/tools/x']]) {
      const r = await req(B, m, pth, REMOTE, m === 'POST' ? {} : undefined);
      ok(`G6 ${m} ${pth} 交给网关认证（不回登录门 401）`, r.headers.get('x-wm-login-required') !== '1' && r.status !== 302, `${r.status}`);
    }
    ok('G6 启动日志写明 MCP_GATEWAY=off 被忽略', E.out().includes('MCP_GATEWAY=off 被忽略'));
  }

  // G7 本机命令行 / 浏览器标记 / 口令头
  ok('G7 本机命令行（回环、无浏览器标记）→ 200', (await req(B, 'GET', '/api/apps', {})).status === 200);
  ok('G7 本机命令行带 Accept: text/html 也不跳转', (await req(B, 'GET', '/apps/gate-app/', { accept: 'text/html' })).status === 200);
  ok('G7 本机但带浏览器标记（Sec-Fetch-Site）不算命令行 → 401', (await req(B, 'GET', '/api/apps', { 'sec-fetch-site': 'same-origin' })).status === 401);
  ok('G7 远程带有效 X-Admin-Token → 200', (await req(B, 'GET', '/api/apps', { ...REMOTE, 'x-admin-token': ADMIN })).status === 200);
  ok('G7 远程带错误 X-Admin-Token → 401', (await req(B, 'GET', '/api/apps', { ...REMOTE, 'x-admin-token': 'nope' })).status === 401);

  // G8 Odoo
  {
    const internal = { ...REMOTE, cookie: 'session_id=internalsession0000000001' };
    ok('G8 Odoo 内部员工会话 → 200', (await req(B, 'GET', '/api/apps', internal)).status === 200);
    const me = await (await req(B, 'GET', '/api/auth/me', internal)).json();
    ok('G8 /api/auth/me 报 Odoo 身份与登录名', me.via === 'odoo' && me.login === 'gate.internal');
    {
      // #389：统一待办读面认 Odoo 管理员；登录门下远程只带 Odoo 会话（不带口令）也要与口令管理员同为全量
      await req(B, 'POST', '/api/sop/runs', {}, { slug: 'gate-sop', started_by: 'gate-smoke' }); // 本机命令行播一条待办
      const viaToken = await req(B, 'GET', '/api/tasks', { ...REMOTE, 'x-admin-token': ADMIN });
      const viaOdoo = await req(B, 'GET', '/api/tasks', { ...REMOTE, cookie: 'session_id=adminsession0000000001' });
      const tj = await viaToken.json(), oj = await viaOdoo.json();
      const titles = (j) => JSON.stringify((j.tasks ?? []).map((t) => t.title).sort());
      const notAuthorized = (j) => Object.entries(j.sources ?? {}).some(([, v]) => v?.error === 'source_not_authorized');
      ok('G8 Odoo 管理员（只带会话）/api/tasks → 200，与口令管理员同为全量', viaToken.status === 200 && viaOdoo.status === 200 && titles(oj) === titles(tj) && (tj.tasks ?? []).length > 0 && !notAuthorized(oj), `${viaToken.status}/${viaOdoo.status} ${titles(oj).slice(0, 80)} vs ${titles(tj).slice(0, 80)}`);
      const viaInternal = await req(B, 'GET', '/api/tasks', internal);
      const ij = await viaInternal.json().catch(() => ({}));
      ok('G8 对照：Odoo 普通内部员工过了登录门，但 /api/tasks 不是全量', ij.error !== 'login_required' && !(viaInternal.status === 200 && titles(ij) === titles(tj) && !notAuthorized(ij)), `${viaInternal.status} ${JSON.stringify(ij).slice(0, 120)}`);
    }
    ok('G8 Odoo 门户账号 → 401', (await req(B, 'GET', '/api/apps', { ...REMOTE, cookie: 'session_id=portalsession00000000001' })).status === 401);
    ok('G8 无效 Odoo 会话 → 401', (await req(B, 'GET', '/api/apps', { ...REMOTE, cookie: 'session_id=unknownsession0000000001' })).status === 401);
    const page = await (await req(B, 'GET', '/login', PAGE)).text();
    const relay = `${odooGo}?return=%2Flogin`;
    ok('G8 登录页给出「用 Odoo 登录」与口令两种方式', page.includes('用 Odoo 登录') && page.includes('输入管理员口令登录') && page.includes(JSON.stringify(relay)));
    const rl = await req(B, 'GET', relay, PAGE);
    const rlt = await rl.text();
    ok('G8 登录中继匿名可开（只出跳转页）', rl.status === 200 && rlt.includes(`${ODOO}/web/login`) && !rlt.includes('odoo-fixture-404'));
    ok('G8 同一 Odoo 台去掉 return → 拦', (await req(B, 'GET', odooGo, PAGE)).status === 302);
    ok('G8 同一 Odoo 台的子路径 → 拦', (await req(B, 'GET', `${odooGo}web/login?return=%2Flogin`, PAGE)).status === 302);
    ok('G8 return 换成别的页 → 拦', (await req(B, 'GET', `${odooGo}?return=%2Ftasks`, PAGE)).status === 302);
    ok('G8 别的台挂 return → 拦', (await req(B, 'GET', `${appGo}?return=%2Flogin`, PAGE)).status === 302);
    ok('G8 WS 升级匿名 → 直接断开（0 字节）', (await rawWs(E.PORT, odooGo + 'ws')) === 0);
    ok('G8 WS 升级带登录 cookie → 交给门户（有响应字节）', (await rawWs(E.PORT, odooGo + 'ws', `wm_login=${ck}`)) > 0);
  }

  // G12 按 run 凭据（/a2a/direct 建单发给派单方的 read_capability / upload_token）
  {
    const mk = async () => (await req(B, 'POST', '/api/sop/runs', {}, { slug: 'gate-sop', started_by: 'gate-dispatcher' })).json();
    const r1 = await mk(), r2 = await mk();
    const RC = (cap) => ({ ...REMOTE, 'x-run-read-capability': cap });
    const UT = (t) => ({ ...REMOTE, 'x-run-upload-token': t });
    ok('G12 远程凭本 run 读凭证 GET /api/sop/runs/<id> → 200', (await req(B, 'GET', `/api/sop/runs/${r1.id}`, RC(r1.read_capability))).status === 200);
    ok('G12 远程凭读凭证列附件 → 200', (await req(B, 'GET', `/api/sop/runs/${r1.id}/files`, RC(r1.read_capability))).status === 200);
    const upf = () => { const f = new FormData(); f.append('file', new Blob(['dispatcher file'], { type: 'text/plain' }), 'd.txt'); return f; };
    const up = await fetch(B + `/api/sop/runs/${r1.id}/files`, { method: 'POST', headers: UT(r1.upload_token), body: upf() });
    const upj = await up.json().catch(() => ({}));
    ok('G12 远程凭本 run 上传令牌传附件 → 2xx', up.status < 300, `${up.status}`);
    ok('G12 远程凭读凭证下载该附件 → 200', (await req(B, 'GET', `/api/sop/runs/${r1.id}/files/${upj.id ?? upj.file?.id}`, RC(r1.read_capability))).status === 200);
    ok('G12 读凭证换到别的 run → 401', (await req(B, 'GET', `/api/sop/runs/${r2.id}`, RC(r1.read_capability))).status === 401);
    ok('G12 伪造读凭证 → 401', (await req(B, 'GET', `/api/sop/runs/${r1.id}`, RC('x'.repeat(64)))).status === 401);
    ok('G12 读凭证不放行 run 列表与写', (await req(B, 'GET', '/api/sop/runs', RC(r1.read_capability))).status === 401 && (await req(B, 'PUT', `/api/sop/runs/${r1.id}`, RC(r1.read_capability), { stepKey: 'one', value: {} })).status === 401);
    const up2 = await fetch(B + `/api/sop/runs/${r2.id}/files`, { method: 'POST', headers: UT(r1.upload_token), body: upf() });
    ok('G12 上传令牌换到别的 run → 401', up2.status === 401);
    ok('G12 上传令牌不放行读', (await req(B, 'GET', `/api/sop/runs/${r1.id}`, UT(r1.upload_token))).status === 401);
    await req(B, 'POST', `/api/sop/runs/${r1.id}/read-caps/revoke`, { 'x-admin-token': ADMIN }, {});
    ok('G12 读凭证吊销后 → 401', (await req(B, 'GET', `/api/sop/runs/${r1.id}`, RC(r1.read_capability))).status === 401);
    await req(B, 'POST', `/api/sop/runs/${r2.id}/finish`, {}, {});
    const up3 = await fetch(B + `/api/sop/runs/${r2.id}/files`, { method: 'POST', headers: UT(r2.upload_token), body: upf() });
    ok('G12 run 已结束后上传令牌 → 401', up3.status === 401, `${up3.status}`);
  }

  // G9 A2A
  ok('G9 签名卡片匿名可读', (await req(B, 'GET', '/.well-known/agent-card.json')).status === 200);
  ok('G9 /a2a/direct 无签名 → 路由按签名拒 401', (await req(B, 'POST', '/a2a/direct', REMOTE, { team: 'market/00000000', message: 'x', caller_session: 'x' })).status === 401);
  ok('G9 工作台事件回执（reply token 认证）不被登录门拦', (await req(B, 'POST', '/api/workbench-events/wbe-0000000000000000/decision', REMOTE, { token: 'x', decision: 'ask', reason: 'r' })).status === 404);

  // G4 next
  for (const [raw, want] of [['//evil.example/x', '/'], ['https://evil.example/', '/'], ['/\\evil.example', '/'], ['/%2F%2Fevil.example', '/%2F%2Fevil.example'], ['/api/apps', '/'], ['/login?next=/x', '/'], ['javascript:alert(1)', '/'], ['/work-items?x=1#h', '/work-items?x=1#h']]) {
    const t = await (await req(B, 'GET', `/login?next=${encodeURIComponent(raw)}`, PAGE)).text();
    ok(`G4 next=${raw} → ${want}`, t.includes(`var next=${JSON.stringify(want)}`));
  }
  {
    const r = await req(B, 'GET', '//evil.example/', PAGE);
    const loc = r.headers.get('location') ?? '';
    ok('G4 协议相对路径的匿名页面跳转不带外站 next', r.status === 302 && loc === '/login', `${r.status} ${loc}`);
  }

  // G2 登出
  {
    const lo = await req(B, 'POST', '/api/auth/logout', C);
    ok('G2 登出 → 200 并清 cookie', lo.status === 200 && /wm_login=;/.test(cookieOf(lo)));
    ok('G2 登出后同一 cookie 再访问 → 401', (await req(B, 'GET', '/api/apps', C)).status === 401);
    ok('G2 登出后页面 → 302 登录', (await req(B, 'GET', '/sop/gate-sop/', CP)).status === 302);
    const forged = ck.split('.')[0] + '.' + '0'.repeat(64);
    ok('G2 伪造签名的 cookie → 401', (await req(B, 'GET', '/api/apps', { ...REMOTE, cookie: `wm_login=${forged}` })).status === 401);
  }
} finally { await stop(E); }

// ================= off（行为不变）+ 口令未设置 + 每分钟限频 + 口令轮换 =================
console.log('== off（缺省）==');
const O = start({ WM_LOGIN_GATE: undefined, ADMIN_TOKEN: undefined, MCP_GATEWAY: 'off' }, 'off');
try {
  ok('off 实例就绪', await ready(O), O.out().slice(-400));
  const B = O.B;
  const h = await (await fetch(B + '/api/health')).json();
  ok('G10 health 报 login_gate=off，自检无登录门行', h.login_gate === 'off' && !h.self_probe.rows.some((x) => x.id.startsWith('market.login-gate.')));
  ok('G10 off：远程匿名读 /api/apps → 200', (await req(B, 'GET', '/api/apps')).status === 200);
  ok('G10 off：远程匿名打开不存在的台 → 404（不跳登录）', (await req(B, 'GET', '/apps/x/', PAGE)).status === 404);
  ok('G10 off：远程匿名 /mcp（网关显式关）→ 200', (await req(B, 'POST', '/mcp', REMOTE, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 200);
  const nt = await req(B, 'POST', '/api/auth/login', REMOTE, { token: 'anything' });
  ok('G3 未设置口令时登录 → 401 口令无效（与口令错同答）', nt.status === 401 && (await nt.json()).error === '口令无效');
  const set = await req(B, 'PUT', '/api/admin-token', {}, { token: 'gate-smoke-db-token-1' });
  ok('本机首次设置库存口令', set.status === 200);
  let last = null, first = '';
  for (let i = 0; i < 9; i++) { last = await req(B, 'POST', '/api/auth/login', REMOTE, { token: 'gate-smoke-db-token-1' }); if (i === 0) first = loginCookie(last); }
  ok('G3 一分钟内第 10 次（含此前失败的 1 次）仍放行', last.status === 200, `${last.status}`);
  const over = await req(B, 'POST', '/api/auth/login', REMOTE, { token: 'gate-smoke-db-token-1' });
  ok('G3 一分钟内第 11 次 → 429', over.status === 429 && Number(over.headers.get('retry-after')) > 0, `${over.status}`);
  const me1 = await (await req(B, 'GET', '/api/auth/me', { ...REMOTE, cookie: `wm_login=${first}` })).json();
  ok('G10 off 下 cookie 照样可验（/api/auth/me）', me1.via === 'cookie' && me1.gate === 'off');
  const rot = await req(B, 'PUT', '/api/admin-token', { 'x-admin-token': 'gate-smoke-db-token-1' }, { token: 'gate-smoke-db-token-2' });
  const me2 = await (await req(B, 'GET', '/api/auth/me', { ...REMOTE, cookie: `wm_login=${first}` })).json();
  ok('G10 口令轮换后旧 cookie 失效', rot.status === 200 && me2.authenticated === false);
} finally { await stop(O); }

// ================= 来源 IP（反代后的真实客户端） =================
console.log('== 来源 IP（同机反代）==');
{
  const R = start({ WM_LOGIN_GATE: 'enforce', ADMIN_TOKEN: ADMIN }, 'realip');
  try {
    ok('G13 实例就绪', await ready(R), R.out().slice(-300));
    const B = R.B;
    const viaProxy = (ip, extra = {}) => ({ 'x-real-ip': ip, 'x-forwarded-for': ip, ...extra });
    const attempt = (h) => req(B, 'POST', '/api/auth/login', h, { token: ADMIN });
    for (let i = 0; i < 10; i++) await attempt(viaProxy('203.0.113.10'));
    ok('G13 同一真实客户端一分钟第 11 次 → 429', (await attempt(viaProxy('203.0.113.10'))).status === 429);
    ok('G13 经同一反代的另一个客户端不受牵连 → 200', (await attempt(viaProxy('203.0.113.11'))).status === 200);
    ok('G13 只有 X-Forwarded-For 时取最右一项（左边客户端自报的不算）', (await attempt({ 'x-forwarded-for': '203.0.113.10, 203.0.113.12' })).status === 200 && (await attempt({ 'x-forwarded-for': '203.0.113.12, 203.0.113.10' })).status === 429);
    ok('G13 X-Real-IP 不是合法 IP 时回落到 X-Forwarded-For', (await attempt({ 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '203.0.113.10' })).status === 429);
    ok('G13 审计记真实客户端 IP，不记反代地址', /"event":"login","ok":true,"ip":"203\.0\.113\.11"/.test(R.out()) && !/"event":"login","ok":true,"ip":"127\.0\.0\.1"/.test(R.out()));
    const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
    if (lan) {
      const lanAttempt = (h) => fetch(`http://${lan}:${R.PORT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ token: ADMIN }) });
      for (let i = 0; i < 10; i++) await lanAttempt(viaProxy(`198.18.0.${i + 1}`));
      const r11 = await lanAttempt(viaProxy('198.18.0.99'));
      ok('G13 对端不是本机时，换转发头也绕不过限频（按 TCP 对端计）', r11.status === 429, `${r11.status}`);
    } else ok('G13 对端非本机的伪造对照（本机无非回环地址，跳过）', true);
  } finally { await stop(R); }
}

// ================= 首次 enforce 轮换按台令牌密钥 =================
console.log('== 首次 enforce 轮换按台令牌 ==');
{
  const DATA = mkdtempSync(resolve('tmp', 'login-gate-rotate-'));
  const tokOf = async (B) => /<meta name="wm-app-token" content="([0-9a-f]{64})">/.exec(await (await req(B, 'GET', '/apps/rot-app/', {})).text())?.[1] ?? '';
  const keyFile = join(DATA, '.wm-app-token.key'), mark = join(DATA, '.wm-app-token.gate');
  const A = start({ WM_LOGIN_GATE: 'off', ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'off' }, 'rotate', DATA);
  let oldTok = '', fileId = 0;
  try {
    ok('G11 off 实例就绪', await ready(A), A.out().slice(-300));
    const pr = await ghPublish(A.B, gh, { slug: 'rot-app', title: 'Rot App', files: [{ path: 'index.html', content: '<html><head></head><body>r</body></html>' }] }, { 'x-admin-token': ADMIN });
    const fd = new FormData(); fd.append('file', new Blob(['rotate body'], { type: 'text/plain' }), 'r.txt');
    const up = await (await fetch(A.B + '/api/apps/rot-app/files', { method: 'POST', body: fd })).json();
    fileId = up.id ?? up.file?.id;
    oldTok = await tokOf(A.B);
    ok('G11 开门前拿到旧台令牌（off 下匿名可读页面）', pr.status === 201 && !!oldTok && Number.isInteger(fileId));
    ok('G11 off 不写轮换记号', !existsSync(mark));
  } finally { await stop(A, true); }
  const keyBefore = readFileSync(keyFile, 'utf8');
  const E1 = start({ WM_LOGIN_GATE: 'enforce', ADMIN_TOKEN: ADMIN }, 'rotate', DATA);
  let newTok = '';
  try {
    ok('G11 首次 enforce 实例就绪', await ready(E1), E1.out().slice(-300));
    const T = (t) => ({ ...REMOTE, origin: 'null', 'x-app-token': t });
    ok('G11 旧令牌读文件 → 401', (await req(E1.B, 'GET', `/api/apps/rot-app/files/${fileId}`, T(oldTok))).status === 401);
    ok('G11 旧令牌写数据 → 401', (await req(E1.B, 'POST', '/api/apps/rot-app/data', T(oldTok), { x: 1 })).status === 401);
    newTok = await tokOf(E1.B);
    ok('G11 新令牌与旧令牌不同', !!newTok && newTok !== oldTok);
    ok('G11 新令牌读文件 → 200', (await req(E1.B, 'GET', `/api/apps/rot-app/files/${fileId}`, T(newTok))).status === 200);
    const keyAfter = readFileSync(keyFile, 'utf8');
    ok('G11 密钥文件已换、权限 600', keyAfter !== keyBefore && /^[0-9a-f]{64}$/.test(keyAfter.trim()) && (statSync(keyFile).mode & 0o777) === 0o600);
    ok('G11 写了轮换记号（权限 600）', existsSync(mark) && (statSync(mark).mode & 0o777) === 0o600 && JSON.parse(readFileSync(mark, 'utf8')).reason === 'login-gate-enforce');
    ok('G11 日志写明轮换但不含新旧密钥', E1.out().includes('已轮换按台令牌密钥') && !E1.out().includes(keyAfter.trim()) && !E1.out().includes(keyBefore.trim()));
    ok('G11 没留下临时文件', !readdirSafe(DATA).some((n) => n.endsWith('.tmp')));
  } finally { await stop(E1, true); }
  const E2 = start({ WM_LOGIN_GATE: 'enforce', ADMIN_TOKEN: ADMIN }, 'rotate', DATA);
  try {
    ok('G11 第二次 enforce 实例就绪', await ready(E2), E2.out().slice(-300));
    ok('G11 第二次启动不再轮换：令牌不变、无轮换日志', (await tokOf(E2.B)) === newTok && !E2.out().includes('已轮换按台令牌密钥'));
  } finally { await stop(E2); }
}

// ================= 非法开关值 =================
console.log('== 非法开关值 ==');
for (const v of ['on', 'Enforce', 'enforce ', '1']) {
  const X = start({ WM_LOGIN_GATE: v, ADMIN_TOKEN: ADMIN }, 'bad');
  const code = await Promise.race([X.exited, sleep(15000).then(() => 'timeout')]);
  ok(`G10 WM_LOGIN_GATE=${JSON.stringify(v)} 拒绝启动`, code !== 'timeout' && code !== 0 && X.out().includes('WM_LOGIN_GATE'), String(code));
  await stop(X);
}

await gh.close(); odoo.close();
console.log(`\nlogin-gate-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
