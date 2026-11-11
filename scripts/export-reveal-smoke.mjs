#!/usr/bin/env node
/**
 * 导出真值要求管理员的对抗组（安全面，回补）：GET /api/export?reveal=1。真实的 server/src/index.ts，Odoo 是本机的替身
 * （session_id 前缀决定身份：adminsession 管理员、internalsession 内部员工），只在 127.0.0.1 上，不访问任何外部系统。
 * 台里放合成的密钥，逐条看应答正文里有没有它。
 *
 *   拒绝例（都必须 403 或登录门的 401，正文里没有真值，也不降级成掩码的 200）：
 *     匿名（本机直连、带转发头的远程）；口令不对；口令对但浏览器从别的站点发来；Odoo 管理员但跨站；
 *     登录的非管理员；路径换大小写；只带 Origin 的跨站；登录门开着时的远程匿名、登录的非管理员。
 *   合法对照：口令管理员（本机、远程）、Odoo 管理员同源，能取到真值；不带 reveal 的导出照旧掩码、谁都能取。
 *
 *   node scripts/export-reveal-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ADMIN_TOKEN = 'synthetic-export-reveal-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.41' };
const SECRET_QUERY = 'synthetic-query-secret-7f3a';
const SECRET_BEARER = 'synthetic-bearer-secret-9c1d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const leaks = (text) => text.includes(SECRET_QUERY) || text.includes(SECRET_BEARER);

// Odoo 替身：session_id 前缀决定身份；其余路径 404
const odoo = createServer((req, res) => {
  const sid = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
  if (req.url === '/web/session/get_session_info') {
    const admin = sid.startsWith('adminsession'), internal = admin || sid.startsWith('internalsession');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(internal ? { result: { uid: admin ? 2 : 7, username: admin ? 'reveal.admin' : 'reveal.staff', name: 'Synthetic', is_internal_user: true, is_admin: admin } } : { result: { uid: false } }));
  }
  res.statusCode = 404; res.end('odoo-fixture-404');
});
await new Promise((r) => odoo.listen(0, '127.0.0.1', r));
const ODOO = `http://127.0.0.1:${odoo.address().port}`;
const ADMIN_SID = 'adminsession-synthetic-0001', STAFF_SID = 'internalsession-synthetic-0001';

async function freePort() {
  const probe = createNetServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

mkdirSync(resolve('tmp'), { recursive: true });
const running = [];
async function boot(tag, extra = {}) {
  const port = await freePort();
  const data = mkdtempSync(resolve('tmp', `export-reveal-${tag}-`));
  const env = { ...process.env, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '', MCP_GATEWAY: 'off', ADMIN_TOKEN, WM_ODOO_URL: ODOO, WM_ODOO_ORIGINS: ODOO, ...extra };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < end && child.exitCode === null) {
    try { ready = (await fetch(base + '/api/health')).status === 200; } catch { /* 未起 */ }
    if (!ready) await sleep(200);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => {
    if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); }
    if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); }
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  if (!ready) { await stop(); throw new Error(`实例 ${tag} 没起来：${out.trim().split('\n').slice(-4).join(' | ')}`); }
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: r.status, text, json, cache: r.headers.get('cache-control') ?? '' };
  };
  const srv = { base, host: new URL(base).host, call, stop };
  running.push(srv);
  return srv;
}

async function seed(srv) {
  const r = await srv.call('POST', '/api/workbenches', { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { name: '合成·带密钥', url: `http://127.0.0.1:9/q?token=${SECRET_QUERY}&x=1`, type: 'web', auth: { type: 'bearer', value: SECRET_BEARER } } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`布置现场失败：${r.status} ${r.text.slice(0, 200)}`);
}
const denied = (r, want = 403) => r.status === want && !leaks(r.text) && r.json?.masked === undefined;
const revealed = (r) => r.status === 200 && r.json?.masked === 0 && leaks(r.text) && r.cache.includes('no-store');

try {
  // ---------- 一、登录门关着 ----------
  {
    const open = await boot('open');
    await seed(open);
    const same = { origin: `http://${open.host}`, 'sec-fetch-site': 'same-origin' };
    const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };
    const cases = [
      ['匿名（本机直连）', await open.call('GET', '/api/export?reveal=1')],
      ['匿名（带转发头的远程）', await open.call('GET', '/api/export?reveal=1', { headers: REMOTE })],
      ['口令不对', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': 'nope' } })],
      ['口令对，但浏览器从别的站点发来', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...cross, 'x-admin-token': ADMIN_TOKEN } })],
      ['Odoo 管理员，但浏览器从别的站点发来', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...cross }, session: ADMIN_SID })],
      ['登录的非管理员（同源）', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: STAFF_SID })],
      ['路径换大小写的匿名', await open.call('GET', '/API/Export?reveal=1', { headers: REMOTE })],
      ['只带 Origin 的跨站（没有 Sec-Fetch-Site）、口令对', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, origin: 'https://elsewhere.example', 'x-admin-token': ADMIN_TOKEN } })],
    ];
    const bad = cases.filter(([, r]) => !denied(r)).map(([label, r]) => [label, r.status, leaks(r.text)]);
    check(bad.length === 0, `登录门关着，取真值的拒绝例（${cases.length} 种）：都 403，正文里没有真值，也没降级成掩码的导出`, show(bad));

    const local = await open.call('GET', '/api/export?reveal=1', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const remote = await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    const session = await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: ADMIN_SID });
    check(revealed(local) && revealed(remote) && revealed(session),
      '对照：口令管理员（本机、远程）和 Odoo 管理员（同源）能取到真值，应答不进缓存', show({ local: local.status, remote: remote.status, session: session.status }));

    const masked = await open.call('GET', '/api/export', { headers: REMOTE });
    const other = await open.call('GET', '/api/export?reveal=true', { headers: REMOTE });
    const twice = await open.call('GET', '/api/export?reveal=1&reveal=1', { headers: REMOTE });
    check([masked, other, twice].every((r) => r.status === 200 && r.json?.masked === 1 && !leaks(r.text) && !r.cache.includes('no-store')),
      '不带 reveal、reveal=true、reveal 给了两次：照旧掩码导出（200、masked=1、没有真值），和改之前一样', show({ masked: masked.status, other: other.status, twice: twice.status }));
    await open.stop();
  }

  // ---------- 二、登录门开着 ----------
  {
    const gated = await boot('gated', { WM_LOGIN_GATE: 'enforce' });
    await seed(gated);
    const same = { origin: `http://${gated.host}`, 'sec-fetch-site': 'same-origin' };
    const anon = await gated.call('GET', '/api/export?reveal=1', { headers: REMOTE });
    const member = await gated.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: STAFF_SID });
    const memberMasked = await gated.call('GET', '/api/export', { headers: { ...REMOTE, ...same }, session: STAFF_SID });
    const token = await gated.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    const session = await gated.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: ADMIN_SID });
    check(anon.status === 401 && !leaks(anon.text) && denied(member) && memberMasked.status === 200 && memberMasked.json?.masked === 1 && !leaks(memberMasked.text) && revealed(token) && revealed(session),
      '登录门开着：远程匿名 401；登录的非管理员取真值 403（掩码导出照旧能取）；对照：口令管理员、Odoo 管理员同源能取',
      show({ anon: anon.status, member: member.status, memberMasked: memberMasked.status, token: token.status, session: session.status }));
    await gated.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  odoo.close();
}
console.log(`export-reveal-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
