#!/usr/bin/env node
/** S4 门户会话不外泄组（security-adversarial-smoke 调用；也可单跑）：
 *  Odoo 下线（2026-11-17）起，门户对任何上游都剥掉浏览器带来的 session_id，不再有「只转给可信 Odoo 源」的单点登录。
 *  session_id 同主机名下会被浏览器带进 /go/<id>/ 的每个请求；台的类型与地址可由 agent 经 MCP 随意登记，一律不作数。
 *  隔离实例特意还设着旧的 WM_ODOO_ORIGINS / WM_ODOO_URL（指向一个记录型上游）：它们已下线，启动只告警、不起作用。
 *  两个记录型上游（以前算「可信 Odoo」的 / 攻击者），各记下收到的 Cookie 头（HTTP 与 WS 升级）。
 *  正例拒：普通台 GET/POST/只有会话/多个同名/WS；攻击者源登记成 type=odoo、地址带 :8069；以前算可信 Odoo 源的台，
 *  带上同源脚本可伪造的 wm_sso_ok、或旧的 state 回跳参数，都收不到 session_id；首访也不再 302 去 Odoo 登录。
 *  对照：其它 cookie 原样转发。另起一个旧变量都不设的实例，结论相同。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripSessionIdCookie, verifyPortalSessionStrip } from '../server/src/portal.ts';

function http(port, method, path, { headers = {}, body } = {}) {
  return new Promise((done) => {
    const rq = request({ host: '127.0.0.1', port, method, path, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (rs) => {
      let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, body: j, headers: rs.headers }); });
    });
    rq.on('error', (e) => done({ status: 0, body: { error: String(e) } }));
    if (body !== undefined) rq.write(body);
    rq.end();
  });
}
export function wsUpgrade(port, path, cookie) {
  return new Promise((done) => {
    const rq = request({ host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Cookie: cookie } });
    const end = () => { rq.destroy(); done(); };
    rq.on('upgrade', end); rq.on('response', end); rq.on('error', end); rq.setTimeout(5000, end);
    rq.end();
  });
}
async function waitReady(port, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await http(port, 'GET', '/api/health'); if (r.status && r.status < 500) return true; await new Promise((x) => setTimeout(x, 250)); }
  return false;
}

/** 记录型上游：按路径记下收到的 Cookie 头（HTTP 与 WS 升级） */
export async function startCaptureUpstream() {
  const seen = [];
  const srv = createServer((rq, rs) => { rq.resume(); rq.on('end', () => { seen.push({ kind: 'http', url: rq.url, cookie: rq.headers.cookie }); rs.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); }); });
  srv.on('upgrade', (rq, socket) => { seen.push({ kind: 'ws', url: rq.url, cookie: rq.headers.cookie }); socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  await new Promise((x) => srv.listen(0, '127.0.0.1', x));
  return { port: srv.address().port, seen, last: (url) => [...seen].reverse().find((x) => x.url === url), close: () => srv.close() };
}

export async function runPortalOdooSessionGroup() {
  let pass = 0, fail = 0;
  const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
  // 剥除函数本身（不起服务）：只剥 session_id 这一个名字，别的 cookie 原样、顺序不变
  {
    const strip = (cookie) => { const h = { cookie }; stripSessionIdCookie(h); return h.cookie; };
    const cases = [
      ['只有 session_id：整个 Cookie 头去掉', strip('session_id=s1'), undefined],
      ['夹在中间', strip('a=1; session_id=s1; b=2'), 'a=1; b=2'],
      ['名字两边有空白', strip(' session_id = s1 ;a=1'), 'a=1'],
      ['多个同名', strip('session_id=s1; x=1; session_id=s2'), 'x=1'],
      ['数组形式的 Cookie 头', strip(['a=1', 'session_id=s1']), 'a=1'],
      ['名字相近的不剥', strip('session_idx=1; my_session_id=2'), 'session_idx=1; my_session_id=2'],
    ];
    const bad = cases.filter(([, got, want]) => got !== want).map(([n, got]) => `${n}=${got}`);
    ok(`S4p 剥除函数只剥 session_id（${cases.length} 例）`, bad.length === 0, bad.join(','));
    ok('S4q 启动自检用的同一份检查是绿的', verifyPortalSessionStrip().ok === true);
  }
  const cap = await startCaptureUpstream(); // 攻击者源（以及普通台）
  const real = await startCaptureUpstream(); // 以前算「可信 Odoo」的源（旧变量还指着它）
  const DATA = resolve('tmp/sec-portal-sid-' + Date.now().toString(36));
  mkdirSync(DATA, { recursive: true });
  const PORT = 20000 + Math.floor(Math.random() * 12000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sec-portal', WM_ODOO_ORIGINS: `http://127.0.0.1:${real.port}`, WM_ODOO_URL: `http://127.0.0.1:${real.port}/odoo`, WM_ODOO_LOGIN_PROXY: '1' },
  });
  let log1 = ''; child.stderr.on('data', (d) => (log1 += d));
  try {
    if (!(await waitReady(PORT))) throw new Error('S4 隔离实例未就绪');
    const reg = async (name, url, type) => (await http(PORT, 'POST', '/api/workbenches', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url, ...(type ? { type } : {}) }) })).body?.id;
    const plain = await reg('S4-plain', `http://127.0.0.1:${cap.port}/plain`);
    const odoo = await reg('S4-odoo', `http://127.0.0.1:${real.port}/odoo`, 'odoo');
    const fakeType = await reg('S4-fake-type', `http://127.0.0.1:${cap.port}/ft`, 'odoo');
    const fakePath = await reg('S4-fake-path', `http://127.0.0.1:${cap.port}/fp:8069`);
    const fakeQuery = await reg('S4-fake-query', `http://127.0.0.1:${cap.port}/fq?next=:8069`);
    if (![plain, odoo, fakeType, fakePath, fakeQuery].every(Boolean)) throw new Error(`登记失败 ${[plain, odoo, fakeType, fakePath, fakeQuery]}`);
    const SID = 'S4secretS4secretS4secret';
    const has = (c) => /(?:^|;\s*)session_id=/.test(String(c ?? ''));
    const lastUnder = (u, prefix) => [...u.seen].reverse().find((x) => String(x.url).startsWith(prefix));
    /** 以前的 SSO v1 舞步：无会话进门户 → 若 302 带 state 则回跳消费 → 带会话 + wm_sso_ok（真拿到的，或同源脚本伪造的）再进。现在第一步就不该 302 */
    const ssoFlow = async (id, path) => {
      const r1 = await http(PORT, 'GET', `/go/${id}/`);
      const st = /wm_sso_(\d+)=([^;]+)/.exec(String(r1.headers?.['set-cookie'] ?? ''));
      let ran = false;
      if (r1.status === 302 && st) {
        const r2 = await http(PORT, 'GET', `/go/${id}/?state=${st[2]}`, { headers: { cookie: `wm_sso_${id}=${st[2]}; session_id=${SID}` } });
        ran = /wm_sso_ok_/.test(String(r2.headers?.['set-cookie'] ?? ''));
      }
      await http(PORT, 'GET', `/go/${id}/${path}`, { headers: { cookie: `session_id=${SID}; wm_sso_ok_${id}=1; keep=1` } });
      return ran;
    };

    await http(PORT, 'GET', `/go/${plain}/a`, { headers: { cookie: `session_id=${SID}; keep=1; other=2` } });
    let got = cap.last('/plain/a');
    ok('S4a 非 Odoo 台 GET：收不到 session_id，其它 cookie 原样', got && !has(got.cookie) && got.cookie === 'keep=1; other=2', JSON.stringify(got));
    await http(PORT, 'POST', `/go/${plain}/b`, { headers: { cookie: `keep=1; session_id=${SID}`, 'content-type': 'application/json' }, body: '{"x":1}' });
    got = cap.last('/plain/b');
    ok('S4b 非 Odoo 台 POST：收不到 session_id', got && !has(got.cookie) && got.cookie === 'keep=1', JSON.stringify(got));
    await http(PORT, 'GET', `/go/${plain}/c`, { headers: { cookie: `session_id=${SID}` } });
    got = cap.last('/plain/c');
    ok('S4c 只有 session_id：上游连 Cookie 头都没有', got && got.cookie === undefined, JSON.stringify(got));
    await http(PORT, 'GET', `/go/${plain}/d`, { headers: { cookie: `session_id=${SID}; x=1; session_id=other0other0other0` } });
    got = cap.last('/plain/d');
    ok('S4d 多个同名 session_id：一个都不转', got && !has(got.cookie) && got.cookie === 'x=1', JSON.stringify(got));
    await wsUpgrade(PORT, `/go/${plain}/ws`, `session_id=${SID}; keep=1`);
    got = cap.last('/plain/ws');
    ok('S4e 非 Odoo 台 WS 升级：收不到 session_id', got && got.kind === 'ws' && !has(got.cookie) && got.cookie === 'keep=1', JSON.stringify(got));

    let ran = await ssoFlow(fakeType, 'steal');
    got = lastUnder(cap, '/ft/steal');
    ok(`S4h 攻击者源登记成 type=odoo：SSO 回跳${ran ? '走完' : '不再提供'} + 伪造 wm_sso_ok，仍收不到 session_id`, got && !has(got.cookie), JSON.stringify(got));
    ran = await ssoFlow(fakePath, 'steal');
    got = lastUnder(cap, '/fp:8069/steal');
    ok(`S4i 地址路径带 :8069：SSO 回跳${ran ? '走完' : '不再提供'} + 伪造 wm_sso_ok，仍收不到 session_id`, got && !has(got.cookie), JSON.stringify(got));
    ran = await ssoFlow(fakeQuery, 'steal');
    got = lastUnder(cap, '/fq/steal');
    ok(`S4j 地址查询带 :8069：SSO 回跳${ran ? '走完' : '不再提供'} + 伪造 wm_sso_ok，仍收不到 session_id`, got && !has(got.cookie), JSON.stringify(got));
    await wsUpgrade(PORT, `/go/${fakeType}/ws`, `session_id=${SID}; wm_sso_ok_${fakeType}=1`);
    got = lastUnder(cap, '/ft/ws');
    ok('S4k 攻击者 type=odoo 台的 WS 升级：收不到 session_id', got && got.kind === 'ws' && !has(got.cookie), JSON.stringify(got));

    const first = await http(PORT, 'GET', `/go/${odoo}/`);
    ran = await ssoFlow(odoo, 'web');
    got = real.last('/odoo/web');
    ok('S4f 以前算可信 Odoo 源的台（旧变量还指着它）：首访不再 302 去登录，没有 state 回跳；带伪造的 wm_sso_ok 也收不到 session_id，其它 cookie 照转（市场自己的 wm_ cookie 门户本来就剥）',
      first.status !== 302 && !ran && got && !has(got.cookie) && got.cookie === `keep=1`, `first=${first.status} ran=${ran} ${JSON.stringify(got)}`);
    await http(PORT, 'GET', `/go/${odoo}/web2?state=forged`, { headers: { cookie: `session_id=${SID}; wm_sso_${odoo}=forged; keep=1` } });
    got = real.last('/odoo/web2?state=forged');
    ok('S4g 带旧的 state 回跳参数和 state cookie：照样剥 session_id，原样转发（不再核 state）', got && !has(got.cookie), JSON.stringify(got));
    await wsUpgrade(PORT, `/go/${odoo}/ws`, `session_id=${SID}; wm_sso_ok_${odoo}=1`);
    got = real.last('/odoo/ws');
    ok('S4l 以前算可信 Odoo 源的台的 WS 升级：收不到 session_id', got && got.kind === 'ws' && !has(got.cookie), JSON.stringify(got));
    ok('S4m 旧变量（WM_ODOO_ORIGINS、WM_ODOO_URL、WM_ODOO_LOGIN_PROXY）启动时各打一行「已下线、忽略」，不拒启动',
      ['WM_ODOO_ORIGINS', 'WM_ODOO_URL', 'WM_ODOO_LOGIN_PROXY'].every((n) => log1.includes(`"name":"${n}"`) && log1.includes('已下线')), log1.slice(-400));
  } catch (e) {
    ok('S4 组运行', false, String(e?.message ?? e));
  } finally {
    child.kill(); cap.close(); real.close();
    await new Promise((x) => setTimeout(x, 400));
    rmSync(DATA, { recursive: true, force: true });
  }

  // 两项都不设的实例（fail closed）：登记成 type=odoo、或地址带 :8069 的台，都拿不到会话、也没有 SSO 跳转
  const cap2 = await startCaptureUpstream();
  const DATA2 = resolve('tmp/sec-portal-sid-none-' + Date.now().toString(36));
  mkdirSync(DATA2, { recursive: true });
  // 随机端口偶发撞车（CI 上见过一次未就绪）：换端口最多起三次；失败时带上服务端日志尾，便于定位
  let PORT2 = 0, child2 = null, log2 = '';
  for (let attempt = 1; attempt <= 3 && !child2; attempt++) {
    PORT2 = 20000 + Math.floor(Math.random() * 12000);
    const env2 = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT2), DATA_DIR: DATA2, ADMIN_TOKEN: 'sec-portal2' };
    delete env2.WM_ODOO_ORIGINS; delete env2.WM_ODOO_URL; delete env2.LC_ODOO_URL;
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], env: env2 });
    log2 = ''; c.stderr.on('data', (d) => (log2 += d));
    if (await waitReady(PORT2)) child2 = c;
    else { c.kill(); await new Promise((x) => setTimeout(x, 300)); }
  }
  try {
    if (!child2) throw new Error('S4 未配可信源实例未就绪（三次）：' + log2.slice(-300));
    const SID = 'S4noneS4noneS4noneS4none';
    const reg = async (name, url, type) => (await http(PORT2, 'POST', '/api/workbenches', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url, ...(type ? { type } : {}) }) })).body?.id;
    const probe = async (id, base) => {
      const r1 = await http(PORT2, 'GET', `/go/${id}/`); // 无会话进门户：旧口径会 302 去 Odoo 登录
      await http(PORT2, 'GET', `/go/${id}/steal`, { headers: { cookie: `session_id=${SID}; wm_sso_ok_${id}=1; keep=1` } });
      await wsUpgrade(PORT2, `/go/${id}/ws`, `session_id=${SID}; wm_sso_ok_${id}=1; keep=1`);
      const h = cap2.last(`${base}/steal`), w = cap2.last(`${base}/ws`);
      const leak = (x) => /(?:^|;\s*)session_id=/.test(String(x?.cookie ?? ''));
      return { ok: r1.status !== 302 && !!h && !!w && !leak(h) && !leak(w), got: `首访 ${r1.status} · http=${h?.cookie} · ws=${w?.cookie}` };
    };
    const a = await probe(await reg('S4-none-type', `http://127.0.0.1:${cap2.port}/nt`, 'odoo'), '/nt');
    ok('S4s 旧变量都不设：type=odoo 台不给 SSO 跳转，HTTP 与 WS 都收不到 session_id（含伪造 wm_sso_ok）', a.ok, a.got);
    const b = await probe(await reg('S4-none-port', `http://127.0.0.1:${cap2.port}/np:8069`), '/np:8069');
    ok('S4t 旧变量都不设：地址带 :8069 的台同样不给跳转、收不到 session_id', b.ok, b.got);
  } catch (e) {
    ok('S4 未配可信源组运行', false, String(e?.message ?? e));
  } finally {
    child2.kill(); cap2.close();
    await new Promise((x) => setTimeout(x, 400));
    rmSync(DATA2, { recursive: true, force: true });
  }
  return { pass, fail };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await runPortalOdooSessionGroup();
  console.log(`S4 portal session strip: ${r.pass} passed / ${r.fail} failed`);
  process.exitCode = r.fail ? 1 : 0;
}
