#!/usr/bin/env node
/** 登录门上线演练（WM_LOGIN_GATE=enforce）：在隔离实例上按调用方逐类发真实请求，列出期望值、实际值、是否通过。
 *  本机随机端口、合成 DATA_DIR、本机替身（GitHub、Odoo、外部台、A2A 对端），合成口令与中性 slug；不碰生产库与生产网络。
 *  远程调用方用 X-Forwarded-For 模拟（同机反代转进来的不算本机命令行）。
 *  用法：node scripts/login-gate-rollout-check.mjs [--json <输出文件>]。退出码：有「必须通过」的行没过 → 1。
 *  每行的 need：must = 上线前必须成立；gap = 已知缺口（记录现状，不影响退出码）；info = 行为变化，供上线方案参考。 */
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, createServer as netServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : '';
const rows = [];
const row = (cat, what, expect, actual, pass, need = 'must', note = '') => { rows.push({ cat, what, expect, actual: String(actual), pass: !!pass, need, note }); console.log(`  ${pass ? '✓' : need === 'must' ? '✗' : '·'} [${cat}] ${what} — 期望 ${expect}，实际 ${actual}${note ? `（${note}）` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'rollout-check-synthetic-admin';
const REMOTE = { 'x-forwarded-for': '198.51.100.20' };
const PAGE = { ...REMOTE, accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
mkdirSync('tmp', { recursive: true });
const OUT = mkdtempSync(resolve('tmp', 'login-gate-rollout-'));
const DATA = join(OUT, 'data');
const freePort = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const PORT = await freePort();
const B = `http://127.0.0.1:${PORT}`;

// ---------- 替身 ----------
const odoo = createServer((req, res) => {
  const sid = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
  if (req.url === '/web/session/get_session_info') {
    const admin = sid.startsWith('adminsession'), internal = admin || sid.startsWith('internalsession'), portal = sid.startsWith('portalsession');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(internal || portal ? { result: { uid: 9, username: admin ? 'rc.admin' : internal ? 'rc.internal' : 'rc.portal', name: 'Synthetic', is_internal_user: internal, is_admin: admin } } : { result: { uid: false } }));
  }
  res.statusCode = 404; res.end('odoo-fixture');
});
const upstream = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>upstream</title><p>synthetic external workbench</p>'); });
upstream.on('upgrade', (_q, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'));
const ZONE = 'rcpeer';
const peerKey = generateKeyPairSync('ed25519').privateKey;
const peer = createServer((req, res) => {
  if (req.url === '/node/.well-known/agent-card.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: ZONE + '-node', session: ZONE, team: ZONE }, peerKey))); }
  res.statusCode = 404; res.end('{}');
});
for (const s of [odoo, upstream, peer]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
const ODOO = `http://127.0.0.1:${odoo.address().port}`, UP = `http://127.0.0.1:${upstream.address().port}`, PEER = `http://127.0.0.1:${peer.address().port}`;
const gh = await startFakeGithub();

// ---------- 实例 ----------
function boot(extra) {
  const env = { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '', WM_GITHUB_API: gh.api, ADMIN_TOKEN: ADMIN, MARKET_PUBLIC_URL: B, WM_ODOO_URL: ODOO, WM_ODOO_ORIGINS: ODOO, MCP_GATEWAY: 'on', WM_A2A_DIRECT_SIG: '', WM_A2A_DIRECT_SIG_BODY: '', ...extra };
  for (const k of ['WM_EXTENSIONS_DIR', 'YGL_HOME']) delete env[k];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((r) => child.once('exit', r));
  return { child, exited, out: () => out };
}
async function ready(inst) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) { if (inst.child.exitCode !== null) return -1; try { if ((await fetch(B + '/api/health')).status === 200) return Date.now() - t0; } catch { /* 未起 */ } await sleep(100); }
  return -1;
}
async function halt(inst) { if (inst.child.exitCode === null && inst.child.signalCode === null) { inst.child.kill(); await inst.exited; } }
const req = async (method, path, headers = REMOTE, body) => {
  const isBuf = Buffer.isBuffer(body) || body instanceof FormData;
  const r = await fetch(B + path, { method, redirect: 'manual', headers: body === undefined || isBuf ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, h: r.headers, text, j };
};
const gate401 = (r) => r.status === 401 && r.j?.error === 'login_required';
const st = (r) => `${r.status}${gate401(r) ? ' login_required' : ''}${r.status === 302 ? ' → ' + (r.h.get('location') ?? '').slice(0, 60) : ''}`;
const ws = (path, extra = '') => new Promise((done) => {
  const s = connect(PORT, '127.0.0.1'); let n = 0; const t = setTimeout(() => { s.destroy(); done(n); }, 1500);
  s.once('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 198.51.100.20\r\n${extra}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
  s.on('data', (b) => { n += b.length; }); s.on('error', () => {}); s.once('close', () => { clearTimeout(t); done(n); });
});
// /a2a/direct 的 body 绑定签名（a2a-direct-sig.ts 的 market 形式）
function signedDirect(raw, caller) {
  const ts = Date.now(), callerUrl = PEER + '/node', aud = new URL(B).origin;
  const digest = createHash('sha256').update(raw).digest('base64url');
  const text = JSON.stringify(['wm-a2a-direct-body/1', caller, callerUrl, ts, aud, 'POST', '/a2a/direct', digest]);
  return { 'X-A2A-Caller': caller, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud, 'X-WM-Body-Sha256': digest, 'X-WM-Body-Sig': edSign(undefined, Buffer.from(text), peerKey).toString('base64') };
}
const tokOf = async (slug, headers = {}) => /<meta name="wm-app-token" content="([0-9a-f]{64})">/.exec((await req('GET', `/apps/${slug}/`, headers)).text)?.[1] ?? '';

let code = 0;
try {
  // ===== 开门前（off）：布置，并拿一枚开门前的台令牌 =====
  let E = boot({ WM_LOGIN_GATE: 'off' });
  if ((await ready(E)) < 0) throw new Error('off 实例未就绪：' + E.out().slice(-600));
  const pub = await ghPublish(B, gh, { slug: 'rc-app', title: 'RC App', files: [{ path: 'index.html', content: '<html><head></head><body><script src="app.js"></script></body></html>' }, { path: 'app.js', content: '1' }] }, { 'x-admin-token': ADMIN });
  const sop = await ghPublish(B, gh, { slug: 'rc-sop', kind: 'sop', title: 'RC SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: RC SOP\nsteps:\n  - key: a\n    title: A\n' }] }, { 'x-admin-token': ADMIN });
  await req('POST', '/api/sops/rc-sop/publish', {}, { changelog: 'x' });
  const ext = (await req('POST', '/api/workbenches', {}, { name: 'RC External', url: UP + '/', type: 'web' })).j;
  const odooWb = (await req('POST', '/api/workbenches', {}, { name: 'RC Odoo', url: ODOO + '/', type: 'odoo' })).j;
  const appWb = (await req('GET', '/api/workbenches', {})).j.find((w) => w.url === '/apps/rc-app/');
  for (const [node, url] of [[`${ZONE}/a1b2c3d4`, PEER + '/node'], [`${ZONE}/0f0f0f0f`, '']]) await req('POST', '/api/bindings', { 'x-admin-token': ADMIN }, { target_type: 'sop', target_slug: 'rc-sop', agent_node: node, direction: 'admits', mode: 'run', ...(url ? { notify_url: url } : {}) });
  const preTok = await tokOf('rc-app');
  if (pub.status !== 201 || sop.status !== 201 || !ext?.id || !odooWb?.id || !appWb || !preTok) throw new Error('布置失败');
  await halt(E);

  // ===== 首次 enforce =====
  E = boot({ WM_LOGIN_GATE: 'enforce' });
  const bootMs = await ready(E);
  if (bootMs < 0) throw new Error('enforce 实例未就绪：' + E.out().slice(-600));
  const health = await req('GET', '/api/health');
  const login = await req('POST', '/api/auth/login', REMOTE, { token: ADMIN });
  const ck = /wm_login=([^;]+)/.exec(login.h.get('set-cookie') ?? '')?.[1] ?? '';
  const C = { ...REMOTE, cookie: `wm_login=${ck}` }, CP = { ...PAGE, cookie: `wm_login=${ck}` };
  const ODOO_IN = { ...REMOTE, cookie: 'session_id=internalsession00000000001' }, ODOO_ADM = { ...REMOTE, cookie: 'session_id=adminsession000000000001' };
  const T = (t) => ({ ...REMOTE, origin: 'null', 'x-app-token': t });

  console.log('\n— 健康检查与启动自检');
  const sp = health.j?.self_probe;
  row('健康', '远程 GET /api/health', '200，login_gate=enforce', `${health.status} ${health.j?.login_gate}`, health.status === 200 && health.j?.login_gate === 'enforce');
  row('健康', '远程 HEAD /api/health', '200', (await fetch(B + '/api/health', { method: 'HEAD', headers: REMOTE })).status, true);
  row('健康', '启动自检全过（含登录门三行、未签名 direct 行）', 'passed，无 fail', `${sp?.passed} fail=${(sp?.failed ?? []).join(',') || '无'} 行=${(sp?.rows ?? []).length}`, sp?.passed === true && ['market.login-gate.page', 'market.login-gate.app', 'market.login-gate.api'].every((id) => sp.rows.some((x) => x.id === id && x.verdict === 'pass')));
  row('健康', '首次 enforce 启动到健康', '< 30s', `${bootMs}ms`, bootMs < 30_000, 'info');
  row('健康', '首次 enforce 轮换台令牌（日志一行，无密钥）', '有轮换日志', E.out().includes('已轮换按台令牌密钥') ? '有' : '无', E.out().includes('已轮换按台令牌密钥'));

  console.log('\n— agent 经 MCP 令牌');
  const sess = (await req('POST', '/api/mcp/sessions', { 'x-admin-token': ADMIN }, { name: 'rc-agent' })).j;
  await req('PUT', `/api/mcp/sessions/${sess.id}/grants`, { 'x-admin-token': ADMIN }, { grants: ['workbench_summary', 'app_files_upload'] });
  const BR = { ...REMOTE, authorization: `Bearer ${sess.token}` };
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  let r = await req('POST', '/mcp', REMOTE, init);
  row('MCP', '远程匿名 POST /mcp', '401 + Bearer 质询（网关，不是登录门）', `${st(r)} ${r.h.get('www-authenticate') ? 'Bearer' : ''}`, r.status === 401 && !gate401(r) && /Bearer/.test(r.h.get('www-authenticate') ?? ''));
  r = await req('POST', '/mcp', BR, init);
  row('MCP', '远程带会话 POST /mcp initialize', '200', st(r), r.status === 200);
  r = await req('GET', '/openapi.json', REMOTE);
  row('MCP', '远程匿名 GET /openapi.json', '401（网关）', st(r), r.status === 401 && !gate401(r));
  r = await req('GET', '/openapi.json', BR);
  row('MCP', '远程带会话 GET /openapi.json', '200', st(r), r.status === 200);
  r = await req('POST', '/api/mcp-rest/tools/workbench_summary', BR, {});
  row('MCP', '远程带会话 POST /api/mcp-rest/tools/workbench_summary', '200', st(r), r.status === 200);
  r = await req('PUT', '/api/mcp-rest/apps/rc-app/files/rc.txt', { ...BR, 'content-type': 'text/plain' }, Buffer.from('rollout synthetic bytes'));
  row('MCP', '远程带会话 PUT 原始字节上传', '201', st(r), r.status === 201);
  r = await req('POST', '/mcp', { ...REMOTE, cookie: `wm_login=${ck}` }, init);
  row('MCP', '只带登录 cookie 调 /mcp', '401（MCP 不认浏览器登录）', st(r), r.status === 401);

  console.log('\n— A2A 入站与回执');
  r = await req('GET', '/.well-known/agent-card.json');
  const team = r.j?.sessionTeams?.[0]?.team ?? '';
  row('A2A', '远程 GET 签名卡片', '200，含 sessionTeams', `${r.status} teams=${r.j?.sessionTeams?.length ?? 0}`, r.status === 200 && !!team);
  const startMsg = (caller) => JSON.stringify({ team, message: 'rollout start', caller_session: caller, task_id: 'rc-' + randomBytes(5).toString('hex') });
  let raw = startMsg(`${ZONE}/a1b2c3d4`);
  r = await req('POST', '/a2a/direct', { ...REMOTE, 'content-type': 'application/json' }, Buffer.from(raw));
  row('A2A', '远程未签名 POST /a2a/direct', '401（enforce 强制 require）', `${r.status} ${String(r.j?.error ?? '').slice(0, 40)}`, r.status === 401 && !gate401(r));
  raw = startMsg(`${ZONE}/a1b2c3d4`);
  r = await req('POST', '/a2a/direct', { ...REMOTE, 'content-type': 'application/json', ...signedDirect(raw, ZONE) }, Buffer.from(raw));
  const dsop = r.j?.sop ?? r.j?.result?.sop ?? JSON.parse(JSON.stringify(r.j ?? {}).match(/"sop":(\{[^}]*\})/)?.[1] ?? '{}');
  row('A2A', '远程签名 direct（绑定登记了取卡地址）', '200 DELIVERED，回 upload_token 与 read_capability', `${r.status} ${r.j?.task_status ?? ''} run=${dsop.run_id ?? '?'}`, r.status === 200 && r.j?.task_status === 'TASK_STATE_DELIVERED' && !!dsop.read_capability);
  raw = startMsg(`${ZONE}/0f0f0f0f`);
  r = await req('POST', '/a2a/direct', { ...REMOTE, 'content-type': 'application/json', ...signedDirect(raw, ZONE) }, Buffer.from(raw));
  row('A2A', '远程签名 direct（绑定没登记 notify_url）', '401 no-card（需补 notify_url）', `${r.status} ${String(r.j?.error ?? '').match(/\(([a-z-]+)\)/)?.[1] ?? ''}`, r.status === 401, 'info', '上线前给每条 admits 绑定补 notify_url');
  r = await req('POST', '/api/workbench-events/wbe-0000000000000000/decision', REMOTE, { token: 'x', decision: 'ask', reason: 'r' });
  row('A2A', '远程 POST 事件回执 decision', '到路由（未知事件 404），不被登录门拦', st(r), r.status === 404);
  const runId = Number(dsop.run_id);
  r = await req('GET', `/api/sop/runs/${runId}`, { ...REMOTE, 'x-run-read-capability': dsop.read_capability ?? '' });
  row('A2A', '派单方凭 read_capability 远程读 run（REST）', '200', st(r), r.status === 200);
  const fd = new FormData(); fd.append('file', new Blob(['rollout run file'], { type: 'text/plain' }), 'run.txt');
  r = await req('POST', `/api/sop/runs/${runId}/files`, { ...REMOTE, 'x-run-upload-token': dsop.upload_token ?? '' }, fd);
  row('A2A', '派单方凭 upload_token 远程传 run 附件（REST）', '2xx', st(r), r.status < 300);

  console.log('\n— SOP Runner 与附件');
  r = await req('GET', '/sop/rc-sop/', PAGE);
  row('SOP', '远程匿名打开 /sop/<slug>/', '302 /login?next=…', st(r), r.status === 302 && (r.h.get('location') ?? '').startsWith('/login?next='));
  r = await req('GET', '/sop/rc-sop/', CP);
  row('SOP', '登录后打开 /sop/<slug>/', '200', st(r), r.status === 200);
  const BRW = { ...C, 'sec-fetch-site': 'same-origin', origin: B };
  r = await req('POST', '/api/sop/runs', BRW, { slug: 'rc-sop', started_by: 'rc-field' });
  const run2 = r.j ?? {};
  row('SOP', '登录后页面建 run（同源浏览器）', '2xx，回 upload_token 与 read_capability', `${st(r)}`, r.status < 300 && !!run2.read_capability);
  const fd2 = new FormData(); fd2.append('file', new Blob(['runner attachment'], { type: 'text/plain' }), 'a.txt');
  r = await req('POST', `/api/sop/runs/${run2.id}/files`, { ...BRW, 'x-run-upload-token': run2.upload_token ?? '' }, fd2);
  const fileId = r.j?.id ?? r.j?.file?.id;
  row('SOP', '登录后页面传 run 附件', '2xx', st(r), r.status < 300);
  r = await req('GET', `/api/sop/runs/${run2.id}/files/${fileId}`, { ...C, 'x-run-read-capability': run2.read_capability });
  row('SOP', '登录后凭读凭证下载附件', '200', st(r), r.status === 200);
  r = await req('GET', `/api/sop/runs/${run2.id}/files/${fileId}`, { ...REMOTE, 'x-run-read-capability': run2.read_capability });
  row('SOP', '未登录只凭读凭证下载附件（凭证被转发出去）', '200（读凭证本身就是按 run 的不记名凭据，30 天有效、可吊销）', st(r), r.status === 200, 'info', '与派单方直连同一条规则');

  console.log('\n— 自产台、SOP 台内嵌与 /go/ 门户');
  r = await req('GET', '/apps/rc-app/', PAGE);
  row('台', '远程匿名打开自产台', '302 /login', st(r), r.status === 302 && (r.h.get('location') ?? '').startsWith('/login'));
  r = await req('GET', '/apps/rc-app/', CP);
  const capLoc = r.h.get('location') ?? '';
  row('台', '登录后打开自产台', '302 到 /apps/<slug>/~wm/<凭证>/', st(r), r.status === 302 && /\/~wm\//.test(capLoc));
  r = await req('GET', capLoc.replace(/\/$/, '/app.js'), { ...REMOTE, 'sec-fetch-dest': 'script' });
  row('台', '沙箱子资源凭查看凭证（无 cookie）', '200', st(r), r.status === 200);
  r = await req('GET', `/go/${appWb.id}/`, CP);
  row('台', '登录后经 /go/<自产台>/ 打开', '302 到 /go/<id>/~wm/…', st(r), r.status === 302 && /\/go\/\d+\/~wm\//.test(r.h.get('location') ?? ''));
  r = await req('GET', `/go/${ext.id}/`, CP);
  row('台', '登录后经 /go/<外部台>/ 打开', '200（代理上游）', st(r), r.status === 200 && r.text.includes('synthetic external workbench'));
  r = await req('GET', `/go/${ext.id}/`, PAGE);
  row('台', '远程匿名经 /go/<外部台>/', '302 /login', st(r), r.status === 302);
  row('台', '远程匿名 /go/ WebSocket 升级', '断开（0 字节）', `${await ws(`/go/${ext.id}/ws`)} 字节`, (await ws(`/go/${ext.id}/ws`)) === 0);
  const wsIn = await ws(`/go/${ext.id}/ws`, `Cookie: wm_login=${ck}\r\n`);
  row('台', '登录后 /go/ WebSocket 升级', '交给门户（有响应字节）', `${wsIn} 字节`, wsIn > 0);
  const newTok = await tokOf('rc-app', {});
  r = await req('POST', '/api/apps/rc-app/data', T(preTok), { x: 1 });
  row('台', '开门前的旧台令牌写数据', '401（首次 enforce 已轮换）', st(r), r.status === 401);
  r = await req('POST', '/api/apps/rc-app/data', T(newTok), { x: 1 });
  row('台', '新台令牌写数据（沙箱页）', '放行（非 401）', st(r), r.status !== 401 && r.status < 500);

  console.log('\n— 事项页、Odoo 身份、任务中心、Odoo 登录回跳');
  r = await req('GET', '/work-items', PAGE);
  row('事项页', '远程匿名打开 /work-items', '302 /login?next=%2Fwork-items', st(r), r.status === 302 && r.h.get('location') === '/login?next=%2Fwork-items');
  r = await req('GET', '/api/auth/viewer', ODOO_IN);
  row('Odoo 身份', 'Odoo 内部员工 /api/auth/viewer', '过登录门', st(r), !gate401(r));
  r = await req('GET', '/api/auth/viewer', { ...REMOTE, cookie: 'session_id=portalsession00000000001' });
  row('Odoo 身份', 'Odoo 门户账号', '401（登录门只认内部员工）', st(r), gate401(r));
  r = await req('GET', '/api/tasks', ODOO_ADM);
  row('统一待办', 'Odoo 管理员只带会话读 /api/tasks', '200', st(r), r.status === 200);
  r = await req('POST', '/api/task-center/tasks/999999/publish', BRW, {});
  row('任务中心', '只有登录 cookie（非管理员）发布任务', '403（管理写仍要口令或 Odoo 管理员）', st(r), r.status === 403);
  r = await req('POST', '/api/task-center/tasks/999999/publish', { ...REMOTE, 'x-admin-token': ADMIN }, {});
  row('任务中心', '远程带口令发布任务', '过两道门（不存在的任务 404）', st(r), r.status === 404);
  r = await req('GET', `/go/${odooWb.id}/?return=%2Flogin`, PAGE);
  row('Odoo', '登录中继 /go/<Odoo 台>/?return=/login（匿名）', '200 跳转页', st(r), r.status === 200 && r.text.includes(`${ODOO}/web/login`));
  r = await req('GET', `/go/${odooWb.id}/?return=%2Ftasks`, PAGE);
  row('Odoo', '旧入口 ?return=/tasks（匿名）', '302 /login（只能从登录页走）', st(r), r.status === 302, 'info', '匿名用户先到登录页；已登录用户在 /tasks 照旧可用');
  r = await req('GET', `/go/${odooWb.id}/?return=%2Ftasks`, { ...PAGE, cookie: `wm_login=${ck}` });
  row('Odoo', '已登录用户走 ?return=/tasks', '200 跳转页', st(r), r.status === 200);
  r = await req('GET', `/sso/callback?redirect=/go/${odooWb.id}/&state=x`, { ...PAGE, cookie: 'session_id=internalsession00000000001' });
  row('Odoo', 'Odoo 登录回跳 /sso/callback（带内部员工会话）', '过登录门（state 不符由路由 400）', st(r), !gate401(r) && r.status !== 302);
  r = await req('GET', '/login', PAGE);
  row('Odoo', '登录页给出「用 Odoo 登录」', '有', r.text.includes('用 Odoo 登录') ? '有' : '无', r.text.includes('用 Odoo 登录'));

  console.log('\n— 运维脚本与回调');
  r = await req('GET', '/api/apps', {});
  row('运维', '本机命令行 GET /api/apps', '200', st(r), r.status === 200);
  r = await ghPublish(B, gh, { slug: 'rc-app', title: 'RC App', files: [{ path: 'index.html', content: '<html><head></head><body>v2</body></html>' }], force: true }, {});
  row('运维', '本机命令行 POST /api/apps/<slug>/sync', '2xx（或发布锁 409）', r.status, r.status < 300 || r.status === 409);
  r = await req('POST', '/api/apps/rc-sop/sync', REMOTE, {});
  row('运维', '远程（局域网）不带口令 sync', '401（以前是 403）', st(r), gate401(r), 'info');
  r = await req('POST', '/api/apps/rc-app/sync', { ...REMOTE, 'x-admin-token': ADMIN }, { force: true });
  row('运维', '远程带口令 sync', '过登录门（2xx 或发布锁 409）', st(r), !gate401(r) && (r.status < 300 || r.status === 409));
  for (const [what, path] of [['GET /api/workbenches', '/api/workbenches'], ['GET /api/summary', '/api/summary'], ['GET /api/stats', '/api/stats'], ['GET /api/skills', '/api/skills']]) {
    r = await req('GET', path, REMOTE);
    row('运维', `远程不带口令 ${what}（以前开放读）`, '401', st(r), gate401(r), 'info', '只读脚本、看板需改带口令或走 MCP');
  }
  r = await req('GET', '/api/workbenches', { ...REMOTE, 'x-admin-token': ADMIN });
  row('运维', '远程带口令 GET /api/workbenches', '200', st(r), r.status === 200);
  await halt(E);

  console.log('\n— 回滚与再开');
  E = boot({ WM_LOGIN_GATE: 'off' });
  const backMs = await ready(E);
  r = await req('GET', '/api/apps', REMOTE);
  row('回滚', '改回 off 重启后远程匿名读', '200', `${st(r)}（重启 ${backMs}ms 后）`, r.status === 200);
  const offTok = await tokOf('rc-app', {});
  row('回滚', 'off 下台令牌不回退（仍是 enforce 时的新令牌）', '新令牌', offTok === newTok ? '新令牌' : offTok === preTok ? '旧令牌' : '其它', offTok === newTok);
  r = await req('POST', '/api/apps/rc-app/data', T(preTok), { x: 1 });
  row('回滚', 'off 下旧令牌写数据（远程写面本就免令牌）', '放行', st(r), r.status < 300, 'info', '旧令牌失效只影响沙箱页的跨源读（拿不到 ACAO），刷新即好');
  await halt(E);
  E = boot({ WM_LOGIN_GATE: 'enforce' });
  await ready(E);
  row('回滚', '再次 enforce 不重复轮换', '令牌不变', (await tokOf('rc-app', {})) === newTok ? '不变' : '变了', (await tokOf('rc-app', {})) === newTok && !E.out().includes('已轮换按台令牌密钥'));
  await halt(E);
} catch (e) {
  console.error('演练中断：', e?.stack ?? e); code = 2;
} finally {
  await gh.close(); for (const s of [odoo, upstream, peer]) s.close();
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  rmSync(OUT, { recursive: true, force: true });
}
const mustFail = rows.filter((x) => x.need === 'must' && !x.pass);
const gaps = rows.filter((x) => x.need === 'gap');
console.log(`\n登录门上线演练：${rows.length} 行；必须项 ${rows.filter((x) => x.need === 'must').length} 行，未过 ${mustFail.length}；缺口 ${gaps.length} 行（通过 ${gaps.filter((x) => x.pass).length}）`);
process.exit(code || (mustFail.length ? 1 : 0));
