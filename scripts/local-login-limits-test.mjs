#!/usr/bin/env node
/**
 * 账号密码登录的限额（对抗组，docs/local-accounts.md 第 8 节）：算哈希之前先占名额、表单 state 一次性、来源识别不认直连的转发头。
 *
 *   甲、进程内（账号服务直接打并发，看「同时在算」的峰值）：
 *     1 同一来源并发 60 个错密码：绝大多数 throttled，同时在算的不超过上限；1b 同一来源换着用户名：同时只核一个
 *     2 换着来源（伪造来源的样子）、同一用户名并发 60 个：同一用户名同时只核一个，绝大多数 throttled
 *     3 换着来源、换着用户名并发 60 个：全进程同时在算的不超过上限
 *     4 claim 返回 false（state 用过了）：不进哈希、回 stale，先记的尝试退回
 *     4b 先记后算：占上名额、还没算哈希时，这一次已经算进来源的尝试数
 *     5 对了的那一次不占来源的尝试数
 *   乙、来源识别：
 *     6 不在可信反代里的对端直连，带来的 X-Real-IP / X-Forwarded-For 不认；在列表里的才认
 *     7 启动自检：可信反代写成网段给 warn，单个地址 pass
 *   丙、起隔离实例走真实路径（本机当可信反代，X-Real-IP 当来源）：
 *     8 同一来源、同一 state 并发 60 个错密码：只有一个进了哈希（401），别的都在哈希之前被拒（state 已换掉 400，或名额占不上 429）
 *     9 同一来源、不同 state 并发 15 个：按来源的一分钟限额在算哈希之前就生效，进哈希的不超过 10 个
 *    10 state 一次性：提交过的那个 state 再交（重放）400，不进哈希；登录成功之后再交旧的也 400
 *    11 换着伪造来源、同一用户名并发 40 个：大部分 429（同一用户名同时只核一个）
 *    12 账号被锁住时日志记一行 locked，带来源
 *    13 名额占不上（429）的那一次不核销 state，之后照样能交
 *
 *   node scripts/local-login-limits-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `local-login-limits-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-local-login-limits-admin';
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = (xs) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

let child = null, log = '';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'unit'), { recursive: true });
try {
  // ---------------- 甲、进程内 ----------------
  console.log('甲、进程内');
  {
    process.env.DATA_DIR = join(OUT, 'unit');
    const { root } = await import(at('server/src/root-context.ts'));
    const mod = await import(at('server/src/services/local-account.ts'));
    await root.plugin(mod.LocalAccountService);
    const acc = root.get('localAccounts');
    for (const u of ['amy', 'bob']) { const r = await acc.create({ username: u }, 'cli'); if (!r.ok) throw new Error(`建不了 ${u}`); }
    // 峰值：每一轮之前重新数（hashLoad().peak 是进程里的最大值，这里看这一轮里自己采到的）
    const burst = async (fn) => {
      let peak = 0, running = true;
      // 没有 hashLoad（改之前的服务）：峰值记成无穷大，这一项红，不让整本崩掉
      const load = () => (typeof acc.hashLoad === 'function' ? acc.hashLoad().inflight : Infinity);
      const sampler = (async () => { while (running) { peak = Math.max(peak, load()); await new Promise((r) => setImmediate(r)); } })();
      const out = await Promise.all(Array.from({ length: 60 }, (_, i) => fn(i)));
      running = false; await sampler;
      return { reasons: tally(out.map((r) => (r.ok ? 'ok' : r.reason))), peak };
    };
    const one = await burst(() => acc.verify('amy', 'wrong-pass-000', '198.51.100.1'));
    check((one.reasons.throttled ?? 0) >= 55 && one.peak <= mod.SOURCE_INFLIGHT_MAX && one.peak <= mod.HASH_INFLIGHT_MAX,
      `1 同一来源并发 60 个：throttled ${one.reasons.throttled ?? 0} 个，同时在算的峰值 ${one.peak}（按来源上限 ${mod.SOURCE_INFLIGHT_MAX}）`, one);
    acc.unlock('amy');
    const src = await burst((i) => acc.verify(`nobody-s${i}`, 'wrong-pass-000', '198.51.100.2'));
    check((src.reasons.throttled ?? 0) >= 55 && src.peak <= 1,
      `1b 同一来源、换着用户名并发 60 个：同时在算的峰值 ${src.peak}（同一来源同时只核一个），throttled ${src.reasons.throttled ?? 0} 个`, src);
    const name = await burst((i) => acc.verify('bob', 'wrong-pass-000', `198.51.100.${10 + i}`));
    check((name.reasons.throttled ?? 0) >= 55 && name.peak <= 1,
      `2 换着来源、同一用户名并发 60 个：throttled ${name.reasons.throttled ?? 0} 个，同时在算的峰值 ${name.peak}（同一用户名同时只核一个）`, name);
    acc.unlock('bob');
    const all = await burst((i) => acc.verify(`nobody-${i}`, 'wrong-pass-000', `203.0.113.${i + 1}`));
    check((all.reasons.throttled ?? 0) >= 50 && all.peak <= mod.HASH_INFLIGHT_MAX,
      `3 换着来源、换着用户名并发 60 个：同时在算的峰值 ${all.peak}（全进程上限 ${mod.HASH_INFLIGHT_MAX}），throttled ${all.reasons.throttled ?? 0} 个`, all);
    const t0 = Date.now();
    const stale = await acc.verify('amy', 'wrong-pass-000', '198.51.100.200', Date.now(), { claim: () => false });
    const took = Date.now() - t0;
    let after = 0;
    for (let i = 0; i < 10; i++) if ((await acc.verify('nobody-x', 'wrong', '198.51.100.200')).reason !== 'throttled') after++;
    check(stale.ok === false && stale.reason === 'stale' && took < 50 && after === 10,
      '4 claim 返回 false：不进哈希（立即返回）、回 stale；先记的那次退回（这个来源之后还有满额 10 次）', { stale, took, after });
    acc.unlock('amy');
    // 这一次在算哈希之前就已经算进来源的尝试数：先错 9 次，第 10 次占上名额、还没算哈希时，这个来源已经满额
    for (let i = 0; i < 9; i++) await acc.verify(`nobody-p${i}`, 'wrong', '198.51.100.202');
    let fullInside = null;
    await acc.verify('nobody-p9', 'wrong', '198.51.100.202', Date.now(), { claim: () => { fullInside = acc.throttled('198.51.100.202'); return true; } });
    check(fullInside === true, '4b 先记后算：第 10 次占上名额、还没算哈希时，这个来源已经记满（并发进来的不会都看到「还没满」）', fullInside);
    await acc.setPassword('amy', 'Amy-pass-00001');
    let okCount = 0;
    for (let i = 0; i < 12; i++) if ((await acc.verify('amy', 'Amy-pass-00001', '198.51.100.201')).ok) okCount++;
    check(okCount === 12, '5 对了的那一次不占来源的尝试数：同一来源连着登对 12 次都行', okCount);
  }

  // ---------------- 乙、来源识别 ----------------
  console.log('乙、来源识别');
  {
    const { clientIp, trustedProxyCheck } = await import(at('server/src/login-gate.ts'));
    const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
    const forged = { 'x-real-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.98, 192.0.2.97' };
    const saved = process.env.WM_TRUSTED_PROXIES;
    delete process.env.WM_TRUSTED_PROXIES;
    const direct = clientIp(req('203.0.113.7', forged));
    process.env.WM_TRUSTED_PROXIES = '172.17.0.1';
    const notListed = clientIp(req('203.0.113.7', forged));
    const listed = clientIp(req('172.17.0.1', forged));
    const xffOnly = clientIp(req('172.17.0.1', { 'x-forwarded-for': '192.0.2.98, 192.0.2.97' }));
    if (saved === undefined) delete process.env.WM_TRUSTED_PROXIES; else process.env.WM_TRUSTED_PROXIES = saved;
    check(direct === '203.0.113.7' && notListed === '203.0.113.7' && listed === '192.0.2.99' && xffOnly === '192.0.2.97',
      '6 不在可信反代里的对端直连：转发头一律不认，来源就是 TCP 对端；在列表里的才认 X-Real-IP（没有就取 XFF 最右项）', { direct, notListed, listed, xffOnly });
    const a = trustedProxyCheck(['172.17.0.1']), b = trustedProxyCheck(['172.17.0.0/16', '10.0.0.1/32', '::1']);
    check(a.verdict === 'pass' && b.verdict === 'warn' && JSON.stringify(b.ranges) === JSON.stringify(['172.17.0.0/16']),
      '7 启动自检：可信反代写成网段 warn（列出网段），单个地址（含 /32）pass', { a, b });
  }

  // ---------------- 丙、隔离实例 ----------------
  console.log('丙、隔离实例');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base,
    // 本机当作反代：X-Real-IP 当来源（每个场景用自己的来源，按来源的限额各算各的）
    WM_TRUSTED_PROXIES: '127.0.0.1' });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
  const adminCall = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  for (const u of ['carol', 'dave']) if ((await adminCall('POST', '/api/local-accounts', { username: u })).status !== 201) throw new Error(`建不了 ${u}`);
  const carolTemp = (await adminCall('POST', '/api/local-accounts/carol/reset-password')).json?.temp_password;

  /** 发起一次登录：拿表单地址（带 state）和这个浏览器的 state cookie */
  const begin = async (ip) => {
    const r = await fetch(`${base}/login/local?next=/`, { headers: { 'sec-fetch-site': 'same-origin', 'x-real-ip': ip }, redirect: 'manual' });
    const loc = new URL(r.headers.get('location') ?? '', base);
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { form: loc.pathname + loc.search, cookie, status: r.status };
  };
  const post = async (form, ip, fields, cookie = '') => {
    const r = await fetch(new URL(form, base), { method: 'POST', redirect: 'manual',
      headers: { 'sec-fetch-site': 'same-origin', origin: base, 'x-real-ip': ip, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields).toString() });
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location') ?? '', action: /<form method="post" action="([^"]+)"/.exec(text)?.[1] ?? '', text };
  };

  {
    const ip = '192.0.2.51';
    const { form } = await begin(ip);
    const rs = await Promise.all(Array.from({ length: 60 }, () => post(form, ip, { username: 'dave', password: 'wrong-pass-000' })));
    const t = tally(rs.map((r) => r.status));
    check((t[401] ?? 0) === 1 && (t[429] ?? 0) + (t[400] ?? 0) === 59,
      `8 同一来源、同一 state 并发 60 个错密码：只有一个进了哈希（401）；别的都在哈希之前被拒——state 已经换掉的 400 ${t[400] ?? 0} 个、名额占不上的 429 ${t[429] ?? 0} 个`, t);
    await adminCall('POST', '/api/local-accounts/dave/unlock');
  }
  {
    const ip = '192.0.2.52';
    const forms = [];
    for (let i = 0; i < 15; i++) forms.push((await begin(ip)).form);
    const rs = await Promise.all(forms.map((f, i) => post(f, ip, { username: `nobody-${i}`, password: 'wrong-pass-000' })));
    const t = tally(rs.map((r) => r.status));
    check((t[401] ?? 0) <= 10 && (t[429] ?? 0) >= 5 && (t[429] ?? 0) + (t[401] ?? 0) === 15,
      `9 同一来源、不同 state 并发 15 个：进哈希的（401）${t[401] ?? 0} 个（一分钟不超过 10 个，算哈希之前就数），429 ${t[429] ?? 0} 个`, t);
  }
  {
    const ip = '192.0.2.53';
    const { form, cookie } = await begin(ip);
    const first = await post(form, ip, { username: 'dave', password: 'wrong-pass-000' }, cookie);
    const t0 = Date.now();
    const replay = await post(form, ip, { username: 'dave', password: 'wrong-pass-000' }, cookie);
    const took = Date.now() - t0;
    const okLogin = await post(first.action, ip, { username: 'carol', password: carolTemp }, cookie);
    const replayAfter = await post(first.action, ip, { username: 'carol', password: carolTemp }, cookie);
    const forged = await post('/login/local/form?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ip, { username: 'dave', password: 'x' });
    check(first.status === 401 && first.action && first.action !== form && replay.status === 400 && took < 80
        && okLogin.status === 200 && /name="ticket"/.test(okLogin.text) && replayAfter.status === 400 && forged.status === 400,
      '10 state 一次性：提交一次就换新的；旧的再交（重放）400、不进哈希；登录对了之后再交旧的也 400；伪造的 400',
      { first: [first.status, !!first.action], replay: [replay.status, took], okLogin: okLogin.status, replayAfter: replayAfter.status, forged: forged.status });
    await adminCall('POST', '/api/local-accounts/dave/unlock');
  }
  {
    // 换着伪造来源（每个请求自报一个 X-Real-IP，各自拿各自的 state）、都猜 dave
    const forms = [];
    for (let i = 0; i < 40; i++) forms.push({ ip: `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}`, form: (await begin(`198.18.${Math.floor(i / 200)}.${(i % 200) + 1}`)).form });
    const rs = await Promise.all(forms.map(({ ip, form }) => post(form, ip, { username: 'dave', password: 'wrong-pass-000' })));
    const t = tally(rs.map((r) => r.status));
    check((t[429] ?? 0) >= 30 && (t[429] ?? 0) + (t[401] ?? 0) === 40,
      `11 换着伪造来源、同一用户名并发 40 个：429 ${t[429] ?? 0} 个（同一用户名同时只核一个，换头绕不过），进哈希的 ${t[401] ?? 0} 个`, t);
  }
  {
    // 名额占不上（429）的那一次不动 state：两个来源各拿一个 state、同时猜 dave，一个进哈希、一个 429；429 的那个 state 之后照样能交
    await adminCall('POST', '/api/local-accounts/dave/unlock');
    const [a, b] = [await begin('192.0.2.61'), await begin('192.0.2.62')];
    const [ra, rb] = await Promise.all([post(a.form, '192.0.2.61', { username: 'dave', password: 'wrong-pass-000' }), post(b.form, '192.0.2.62', { username: 'dave', password: 'wrong-pass-000' })]);
    const busy = ra.status === 429 ? { r: ra, f: a.form, ip: '192.0.2.61' } : rb.status === 429 ? { r: rb, f: b.form, ip: '192.0.2.62' } : null;
    const again = busy ? await post(busy.f, busy.ip, { username: 'dave', password: 'wrong-pass-000' }) : null;
    check(!!busy && [ra.status, rb.status].sort().join() === '401,429' && again?.status === 401,
      '13 名额占不上（429）的那一次不核销 state：之后拿同一个表单再交，照常核对（401，不是 400）', { ra: ra.status, rb: rb.status, again: again?.status });
  }
  {
    await adminCall('POST', '/api/local-accounts/dave/unlock');
    const ip = '192.0.2.54';
    let { form } = await begin(ip);
    for (let i = 0; i < 5; i++) { const r = await post(form, ip, { username: 'dave', password: `wrong-pass-${i}00` }); form = r.action || form; }
    await sleep(200);
    const line = log.split('\n').find((l) => l.includes('"event":"locked"') && l.includes('"username":"dave"') && l.includes(`"from":"${ip}"`));
    check(!!line && !/wrong-pass/.test(log), '12 连续输错 5 次锁住时日志记一行 locked（用户名、来源），不带密码', line ?? '');
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`local-login-limits-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
