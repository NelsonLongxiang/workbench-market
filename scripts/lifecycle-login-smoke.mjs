#!/usr/bin/env node
/** #275 生命周期面登录入口冒烟（替身引擎 + 替身 Odoo）：
 *  401 带 login_url（只挑可信 Odoo 台、LC_ODOO_URL 对应的优先、没登记给 null）· /go/<id>/?return= 经 Odoo 登录（已登录也经过，幂等直通）·
 *  state 回跳后 302 落回市场原页面并清掉回跳 cookie · return 只收本站 path（//、绝对 URL、/go/ 都不收）· 统一待办生命周期源带 login_url。 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/lc-login-smoke-' + Date.now().toString(36));
const ENG = join(TMP, 'engine'), HOME = join(TMP, 'home'), DATA = join(TMP, 'data');
for (const d of [ENG, HOME, DATA]) mkdirSync(d, { recursive: true });
copyFileSync('scripts/fixtures/fake-lc-engine.cjs', join(ENG, 'bin.cjs'));
copyFileSync('scripts/fixtures/lc-board-sample.json', join(ENG, 'lc-board-sample.json'));
writeFileSync(join(ENG, 'mode'), 'ok');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const SID = 'sidL' + '0'.repeat(28);
const odoo = createServer((rq, rs) => {
  rq.resume(); rq.on('end', () => {
    const got = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(rq.headers.cookie ?? ''))?.[1] ?? '';
    rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(got === SID ? { jsonrpc: '2.0', id: null, result: { uid: 7, username: 'pm-a', name: '测试 PM-A', is_internal_user: true } } : { jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } }));
  });
});
await new Promise((x) => odoo.listen(0, '127.0.0.1', x));
const OP = odoo.address().port;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'lc-login-smoke',
  LC_YGL_BIN: join(ENG, 'bin.cjs'), LC_YGL_HOME: HOME, LC_ODOO_URL: `http://127.0.0.1:${OP}`, LC_WORKBENCH_KEY_FILE: join(TMP, 'no-such.key'), WM_ODOO_ORIGINS: `http://localhost:${OP}` };
for (const k of ['LC_LEDGER', 'LC_ANCHOR_DIR', 'LC_TEST']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));

const http = (method, path, { headers = {}, body } = {}) => new Promise((done) => {
  const rq = request({ host: '127.0.0.1', port: PORT, method, path, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) } }));
  if (body !== undefined) rq.write(body);
  rq.end();
});
const cookiesOf = (r) => (r.headers['set-cookie'] ?? []).map(String);
const cookieVal = (r, name) => cookiesOf(r).map((c) => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find((v) => v !== undefined);
const reg = async (name, url) => (await http('POST', '/api/workbenches', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url, type: 'odoo' }) })).body?.id;

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end && (await http('GET', '/api/health')).status !== 200) await new Promise((x) => setTimeout(x, 250));

  console.log('login_url 选台');
  let r = await http('GET', '/api/lifecycle/board');
  ok('没登记 Odoo 台：401 且 login_url 为 null', r.status === 401 && r.body?.login_url === null, JSON.stringify(r.body));
  const rogue = await reg('rogue-odoo', 'http://127.0.0.1:1/');
  const wid = await reg('odoo', `http://127.0.0.1:${OP}/`);
  const wloc = await reg('odoo-localhost', `http://localhost:${OP}/`);
  ok('登记三个台', [rogue, wid, wloc].every((x) => Number.isInteger(x)), JSON.stringify([rogue, wid, wloc]));
  r = await http('GET', '/api/lifecycle/board');
  ok('401 带 login_url，只挑可信 Odoo 源、同主机名（127.0.0.1）', r.status === 401 && r.body?.login_url === `/go/${wid}/?return=%2Flifecycle`, JSON.stringify(r.body?.login_url));
  ok('401 仍 no-store', /no-store/.test(String(r.headers['cache-control'])));
  r = await http('GET', '/api/lifecycle/board', { headers: { host: `localhost:${PORT}` } });
  ok('LC_ODOO_URL 对应的台优先（Host 为 localhost 也不换台：生命周期只认这个 Odoo 的会话）', r.body?.login_url === `/go/${wid}/?return=%2Flifecycle`, JSON.stringify(r.body?.login_url));
  r = await http('GET', '/api/tasks');
  const life = r.body?.sources?.lifecycle;
  ok('统一待办：生命周期源 auth_required + login_url 回 /tasks', life?.ok === false && life.auth_required === true && life.login_url === `/go/${wid}/?return=%2Ftasks`, JSON.stringify(life));

  console.log('SSO v1 舞步带 return（Odoo 19 修复：市场中继页 + whoami 轮询）');
  const back = '/lifecycle?as_of=2026-12-18T18:00:00+08:00';
  r = await http('GET', `/go/${wid}/?return=${encodeURIComponent(back)}`);
  ok('未登录 return 流：200 中继页（不再让 Odoo 绝对回跳——真实 Odoo 19 会把绝对回跳本地化成 /zh_CN/<path> 404）', r.status === 200 && String(r.headers['content-type'] ?? '').includes('text/html') && !r.headers.location, `${r.status} ${r.headers.location ?? ''} ${r.headers['content-type']}`);
  ok('中继页 Cache-Control: no-store', /no-store/.test(String(r.headers['cache-control'])), String(r.headers['cache-control']));
  ok('return 流不写回跳/state cookie（回程改由 whoami 轮询）', !cookieVal(r, `wm_sso_ret_${wid}`) && !cookieVal(r, `wm_sso_${wid}`), JSON.stringify(cookiesOf(r)));
  r = await http('GET', `/go/${wid}/?return=${encodeURIComponent(back)}`, { headers: { cookie: `session_id=${SID}` } });
  ok('已有 Odoo 会话的 return 流同样是中继页（弹窗内完成，幂等不循环）', r.status === 200 && !r.headers.location, `${r.status} ${r.headers.location ?? ''}`);
  r = await http('GET', '/api/lifecycle/whoami');
  ok('whoami：匿名 401 带 auth_required 与登录入口（#279 顶栏 chip）', r.status === 401 && r.body?.auth_required === true && r.body.login_url === `/go/${wid}/?return=%2Flifecycle`, JSON.stringify(r.body));
  r = await http('GET', '/api/lifecycle/whoami', { headers: { cookie: `session_id=${SID}` } });
  ok('whoami：有效会话 200 回 viewer', r.status === 200 && r.body?.ok === true && r.body?.viewer?.sub === 'user:pm-a', JSON.stringify(r.body));
  ok('whoami：带显示名、类别「人」、roles 为 null（#279 过渡）', r.body?.viewer?.name === '测试 PM-A' && r.body.viewer.login === 'pm-a' && r.body.viewer.kind === '人' && r.body.roles === null, JSON.stringify(r.body));
  ok('whoami 200 也是 no-store', /no-store/.test(String(r.headers['cache-control'])));
  const state2 = 'st2-roundtrip';
  const ret2 = encodeURIComponent(back);
  r = await http('GET', `/go/${wid}/?state=${state2}`, { headers: { cookie: `session_id=${SID}; wm_sso_${wid}=${state2}; wm_sso_ret_${wid}=${ret2}` } });
  ok('#276 残留的回跳 cookie 不再生效：state 通过也不跳（进 Odoo 台代理）', !r.headers.location, `${r.status} ${r.headers.location}`);
  ok('残留回跳 cookie 顺手清掉', cookiesOf(r).some((c) => c.startsWith(`wm_sso_ret_${wid}=;`)), JSON.stringify(cookiesOf(r)));
  r = await http('GET', `/go/${wid}/?state=forged`, { headers: { cookie: `session_id=${SID}; wm_sso_${wid}=${state2}; wm_sso_ret_${wid}=${ret2}` } });
  ok('state 不符：400，不跳', r.status === 400 && !r.headers.location, `${r.status}`);
  r = await http('GET', `/go/${wid}/?state=${state2}`, { headers: { cookie: `session_id=${SID}; wm_sso_${wid}=${state2}; wm_sso_ret_${wid}=${encodeURIComponent('//evil.example/x')}` } });
  ok('回跳 cookie 被换成 //evil：不跳外站（进 Odoo 台代理）', !String(r.headers.location ?? '').includes('evil'), `${r.status} ${r.headers.location}`);
  for (const planted of ['/.//evil.example/x', '/%2e//evil.example/x', '/a/..//evil.example/x', '/apps/x/']) {
    r = await http('GET', `/go/${wid}/?state=${state2}`, { headers: { cookie: `session_id=${SID}; wm_sso_${wid}=${state2}; wm_sso_ret_${wid}=${encodeURIComponent(planted)}` } });
    ok(`被写入的回跳 cookie ${planted}：state 通过也不跳`, !r.headers.location, `${r.status} ${r.headers.location}`);
  }

  console.log('return 只收本站 path');
  for (const bad of ['//evil.example/x', 'https://evil.example/', '/go/3/', '/\\evil.example', 'lifecycle', '/.//evil.example', '/%2e//evil.example', '/apps/demo/', '/settings']) {
    r = await http('GET', `/go/${wid}/?return=${encodeURIComponent(bad)}`);
    const v = cookieVal(r, `wm_sso_ret_${wid}`);
    ok(`return=${bad} 不收（退回普通 302 入口、不写回跳 cookie）`, r.status === 302 && !v, `${r.status} ${v}`);
  }
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  server.kill(); odoo.close();
  await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`lifecycle-login-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
