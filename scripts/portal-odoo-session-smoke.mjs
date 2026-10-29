#!/usr/bin/env node
/** S4 门户 Odoo 会话转发组（security-adversarial-smoke 调用；也可单跑）：
 *  Odoo 的 session_id 同主机名下会被浏览器带进 /go/<id>/ 的每个请求；它既是用户的 Odoo 会话，也是生命周期审批的身份凭据，
 *  门户只许把它转给可信 Odoo 源（WM_ODOO_ORIGINS / LC_ODOO_URL）——台的类型与端口可由 agent 经 MCP 随意登记，不作数。
 *  隔离实例（WM_ODOO_ORIGINS=可信上游）+ 两个记录型上游（可信 Odoo / 攻击者），各记下收到的 Cookie 头（HTTP 与 WS 升级）。
 *  正例拒：普通台 GET/POST/只有会话/多个同名/WS；攻击者源登记成 type=odoo、或地址路径/查询里带 :8069——走完 SSO state 回跳
 *  （门户给的话）再加同源脚本可伪造的 wm_sso_ok cookie，仍收不到 session_id。
 *  对照：其它 cookie 原样转发；可信 Odoo 源走真实 state 回跳后只收到 session_id（SSO v1 白名单单键）；未过 state 仍剥（P10b）。
 *  另起一个两项都不设的实例（fail closed）：type=odoo 或地址带 :8069 的台不给 SSO 跳转，HTTP 与 WS 都收不到 session_id。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOdooSessionTarget, trustedOdooOrigins } from '../server/src/odoo-session.ts';

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
  // 判定谓词：只认可信源（不起服务）
  {
    const saved = { W: process.env.WM_ODOO_ORIGINS, L: process.env.LC_ODOO_URL };
    const withTrust = (w, l, fn) => { process.env.WM_ODOO_ORIGINS = w; process.env.LC_ODOO_URL = l; try { return fn(); } finally { for (const [k, v] of [['WM_ODOO_ORIGINS', saved.W], ['LC_ODOO_URL', saved.L]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
    const T = (url) => withTrust('http://odoo.corp:8069, https://erp.corp', '', () => isOdooSessionTarget(url));
    const cases = [
      ['可信源本身（含路径）', T('http://odoo.corp:8069/web'), true],
      ['可信源大小写与路径不同仍算同源', T('HTTP://ODOO.CORP:8069/x/y?z=1'), true],
      ['https 可信源缺省端口等价', T('https://erp.corp:443/'), true],
      ['端口 8069 的非可信源', T('http://attacker.example:8069/'), false],
      ['路径里带 :8069', T('http://attacker.example/x/:8069'), false],
      ['userinfo 伪装 http://odoo.corp:8069@attacker.example/', T('http://odoo.corp:8069@attacker.example/'), false],
      ['后缀相似主机 odoo.corp.attacker.example', T('http://odoo.corp.attacker.example:8069/'), false],
      ['同主机换协议 https://odoo.corp:8069', T('https://odoo.corp:8069/'), false],
      ['同主机换端口 odoo.corp:8070', T('http://odoo.corp:8070/'), false],
      ['非法地址', T('not a url'), false],
    ];
    const bad = cases.filter(([, got, want]) => got !== want).map(([n, got]) => `${n}=${got}`);
    ok(`S4p 判定谓词只认可信源（${cases.length} 例：端口/userinfo/相似主机/换协议/换端口都不算；台类型不参与判定）`, bad.length === 0, bad.join(','));
    const t = withTrust('http://ok.corp, ftp://x.corp, :::', 'http://lc-odoo.corp:8069/odoo', trustedOdooOrigins);
    ok('S4q 可信源 = LC_ODOO_URL 的源 ∪ WM_ODOO_ORIGINS，非法项列出不采信', [...t.origins].sort().join(',') === 'http://lc-odoo.corp:8069,http://ok.corp' && t.invalid.length === 2, JSON.stringify({ o: [...t.origins], i: t.invalid }));
    ok('S4r 一个可信源都没配：谁都不转（fail closed）', withTrust('', '', () => !isOdooSessionTarget('http://x/') && !isOdooSessionTarget('http://x:8069/') && !isOdooSessionTarget('http://127.0.0.1:8069/odoo')));
  }
  const cap = await startCaptureUpstream(); // 攻击者源（以及普通台）
  const real = await startCaptureUpstream(); // 可信 Odoo 源
  const DATA = resolve('tmp/sec-portal-sid-' + Date.now().toString(36));
  mkdirSync(DATA, { recursive: true });
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sec-portal', WM_ODOO_ORIGINS: `http://127.0.0.1:${real.port}`, LC_ODOO_URL: '' },
  });
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
    /** 走一遍 SSO v1：无会话进门户 → 若 302 带 state 则回跳消费 → 带会话 + wm_sso_ok（真拿到的，或同源脚本 document.cookie 伪造的）再进 */
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

    ran = await ssoFlow(odoo, 'web');
    got = real.last('/odoo/web');
    ok('S4f 对照：可信 Odoo 源走真实 state 回跳后只收到 session_id（SSO v1 白名单单键）', ran && got && got.cookie === `session_id=${SID}`, `ran=${ran} ${JSON.stringify(got)}`);
    await http(PORT, 'GET', `/go/${odoo}/web2`, { headers: { cookie: `session_id=${SID}; keep=1` } });
    got = real.last('/odoo/web2');
    ok('S4g 对照：可信 Odoo 源未过 state 仍剥 session_id（P10b）', got && !has(got.cookie), JSON.stringify(got));
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
  const PORT2 = 20000 + Math.floor(Math.random() * 20000);
  const env2 = { ...process.env, MCP_GATEWAY: '', PORT: String(PORT2), DATA_DIR: DATA2, ADMIN_TOKEN: 'sec-portal2' };
  delete env2.WM_ODOO_ORIGINS; delete env2.LC_ODOO_URL;
  const child2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), stdio: 'ignore', env: env2 });
  try {
    if (!(await waitReady(PORT2))) throw new Error('S4 未配可信源实例未就绪');
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
    ok('S4s 未配可信源：type=odoo 台不给 SSO 跳转，HTTP 与 WS 都收不到 session_id（含伪造 wm_sso_ok）', a.ok, a.got);
    const b = await probe(await reg('S4-none-port', `http://127.0.0.1:${cap2.port}/np:8069`), '/np:8069');
    ok('S4t 未配可信源：地址带 :8069 的台同样不给跳转、收不到 session_id', b.ok, b.got);
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
  console.log(`S4 portal odoo session: ${r.pass} passed / ${r.fail} failed`);
  process.exitCode = r.fail ? 1 : 0;
}
