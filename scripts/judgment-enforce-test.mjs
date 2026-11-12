#!/usr/bin/env node
/**
 * 判定切换开关（WM_JUDGMENT_ENFORCE，阶段六 6d 第 0 步）的对抗组。真实的 server/src/index.ts，身份来源是假提供方，
 * 只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、拒绝启动：域名写法不对、域没有登记的动作、比对没开
 *   二、缺省空：一个域都不切，拒绝的应答还是旧守卫的写法
 *   三、切了 principal、stats、grant 三个域：
 *       · 新判定放行的照常（匿名读统计；口令、管理员登录、本机命令行列主体）；
 *       · 写：新判定拒绝的在处理之前回 403 judgment_denied（管理员登录、但不是属主，整批撤销迁移授予），记进 judgment_enforced，不算不一致；
 *       · 管理面的读（GET）走读的路：远程匿名、普通员工列主体，新旧都拒，应答是旧守卫的、和不切时逐字一样；
 *       · 没切的域照旧按旧守卫（匿名读 Cookie 池、远程匿名列授予的拒绝写法不变）；
 *       · 反向比对：给员工一条 admin 授予，新判定放行、旧守卫照旧拒，记成不一致（说明旧守卫还不能拿掉）
 *   面门：走错面的才算被挡（比对单列、开关不抢先），没声明、判不了的照常
 *   四、读的路（类别 read）：新判定拒，旧处理函数照跑——旧的也拒就原样回旧应答（逐字一样，404 还是 404）；
 *       旧的要放行就换成拒绝，旧的应答体一个字节都不发（json、流式写、跳转、HEAD 都试）
 *
 *   node scripts/judgment-enforce-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { createRequire } from 'node:module';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `judgment-enforce-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-enforce-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.71' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

const children = [];
async function boot(name, extraEnv, { expectFail = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + (expectFail ? 20000 : 40000); !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (expectFail) {
    for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
    return { refused: !ready && child.exitCode !== null && child.exitCode !== 0, code: child.exitCode, log };
  }
  if (!ready) throw new Error(`实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ')}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  return { base, host: new URL(base).host, call, log: () => log };
}

try {
  // ---------- 一、拒绝启动 ----------
  {
    const cases = {
      badName: await boot('bad-name', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_ENFORCE: 'Stats!' }, { expectFail: true }),
      unknownDomain: await boot('unknown', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_ENFORCE: 'stats,no-such-domain' }, { expectFail: true }),
      compareOff: await boot('compare-off', { WM_JUDGMENT_ENFORCE: 'stats' }, { expectFail: true }),
    };
    const bad = Object.entries(cases).filter(([, r]) => !r.refused || !r.log.includes('拒绝启动')).map(([k, r]) => [k, r.code]);
    check(bad.length === 0 && cases.unknownDomain.log.includes('no-such-domain') && cases.compareOff.log.includes('WM_JUDGMENT_COMPARE=on'),
      '拒绝启动：域名写法不对、域没有登记的动作、比对没开，进程自己以非 0 退出并说清原因', show(bad));
  }

  // ---------- 二、缺省空 ----------
  {
    const srv = await boot('default', { WM_JUDGMENT_COMPARE: 'on' });
    const anon = await srv.call('GET', '/api/principals', { headers: REMOTE });
    check(anon.status === 403 && !anon.text.includes('judgment_denied') && !srv.log().includes('"event":"enforce"'),
      '缺省空：一个域都不切，远程匿名列主体照旧由旧守卫拒（写法不变），没有切换的启动日志', show({ status: anon.status, body: anon.text.slice(0, 120) }));
  }

  // ---------- 三、切了 principal、stats ----------
  {
    const srv = await boot('enforce', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_ENFORCE: 'principal,stats,grant' });
    const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
    for (const s of [SESSIONS.admin, SESSIONS.alpha]) await srv.call('GET', '/api/auth/viewer', { session: s });
    const r = {
      statsAnon: await srv.call('GET', '/api/stats', { headers: REMOTE }),
      listToken: await srv.call('GET', '/api/principals', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } }),
      listOdooAdmin: await srv.call('GET', '/api/principals', { headers: { ...REMOTE, ...same }, session: SESSIONS.admin }),
      listCli: await srv.call('GET', '/api/principals'),
      listAnon: await srv.call('GET', '/api/principals', { headers: REMOTE }),
      listStaff: await srv.call('GET', '/api/principals', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha }),
      cookiesAnon: await srv.call('GET', '/api/cookies', { headers: REMOTE }),
      revokeOdooAdmin: await srv.call('POST', '/api/grants/revoke-migration', { headers: { ...REMOTE, ...same }, session: SESSIONS.admin, body: { reason: '合成：不是属主' } }),
    };
    check(srv.log().includes('"event":"enforce"') && srv.log().includes('"principal"'), '切换的启动日志写明切了哪些域');
    check(r.statsAnon.status === 200 && r.listToken.status === 200 && Array.isArray(r.listToken.json?.principals) && r.listOdooAdmin.status === 200 && r.listCli.status === 200,
      '新判定放行的照常：匿名读统计；口令、管理员登录（迁移出的系统管理员）、本机命令行列主体', show(Object.fromEntries(['statsAnon', 'listToken', 'listOdooAdmin', 'listCli'].map((k) => [k, r[k].status]))));
    check(r.revokeOdooAdmin.status === 403 && r.revokeOdooAdmin.json?.error === 'judgment_denied' && r.revokeOdooAdmin.json?.action === 'grant.revoke-migration',
      '写：新判定拒绝的在处理之前回 403 judgment_denied（管理员登录、但不是属主，整批撤销迁移授予）', show(r.revokeOdooAdmin.json));
    const plain = await boot('plain', { WM_JUDGMENT_COMPARE: 'on' });
    const plainAnon = await plain.call('GET', '/api/principals', { headers: REMOTE });
    check(r.listAnon.status === 403 && r.listAnon.text === plainAnon.text && !r.listAnon.text.includes('judgment_denied')
      && r.listStaff.status === 403 && !r.listStaff.text.includes('judgment_denied') && !r.listStaff.text.includes('user:'),
      '管理面的读走读的路：远程匿名、普通员工列主体，新旧都拒，回的是旧守卫的应答（和不切时逐字一样），没有主体内容', show({ anon: r.listAnon.text.slice(0, 80), staff: r.listStaff.text.slice(0, 80) }));
    check(r.cookiesAnon.status === 200, '没切的域照旧按旧守卫：匿名读 Cookie 池 200', show({ cookies: r.cookiesAnon.status }));

    // 反向比对：给员工 alpha 一条 admin 授予（本机命令行是属主），新判定放行，旧守卫（要管理口令或管理员登录）照旧拒
    const d = await srv.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'admin', scope: '*', reason: '合成：反向比对' } });
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const a = await srv.call('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const staffAgain = await srv.call('GET', '/api/principals', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha });
    await sleep(400);
    const report = await srv.call('GET', '/api/judgment/compare');
    const enforcedRows = report.json?.enforced ?? [];
    const mism = report.json?.mismatches ?? [];
    check(a.json?.grant?.status === 'active' && staffAgain.status === 403 && !staffAgain.text.includes('judgment_denied')
      && mism.some((m) => m.route === 'GET /api/principals' && m.old === 'deny' && m.new === 'allow' && m.actor_kind === 'person'),
      '反向比对：员工有了 admin 授予，新判定放行，旧守卫照旧拒（写法是旧的），记成不一致：旧守卫还不能拿掉', show({ status: staffAgain.status, mism }));
    check(enforcedRows.some((e) => e.route === 'POST /api/grants/revoke-migration' && e.actor_kind === 'person' && e.verdict === 'deny')
      && !enforcedRows.some((e) => e.route === 'GET /api/principals') && !mism.some((m) => m.actor_kind === 'anonymous'),
      '开关真的拒掉的（写）记进 judgment_enforced；读的路上新旧都拒的不记（旧的应答原样回），也不当不一致', show(enforcedRows));
  }
  // ---------- 四、读的路 ----------
  {
    // 拦截函数单独测：一个最小的 Express 应用，每条路由前面都套上「新判定拒」
    const require = createRequire(join(ROOT, 'server', 'package.json'));
    const express = require('express');
    const { denyIfAllowed, surfaceBlocked } = await import(pathToFileURL(join(ROOT, 'server/src/judgment-read-deny.ts')).href);
    // 面门：when 成立才算被挡；没声明、when 抛错都按没走错面（不靠它把请求从比对里摘出去）
    const wrongSurface = { surfaceGate: { why: '只在控制面', when: (q) => q.headers['x-surface'] !== 'control' } };
    const throws = { surfaceGate: { why: '判不了', when: () => { throw new Error('boom'); } } };
    const sb = [surfaceBlocked(wrongSurface, { headers: { 'x-surface': 'market' } }), surfaceBlocked(wrongSurface, { headers: { 'x-surface': 'control' } }), surfaceBlocked(undefined, { headers: {} }), surfaceBlocked({ action: 'x.read' }, { headers: {} }), surfaceBlocked(throws, { headers: {} })];
    check(JSON.stringify(sb) === JSON.stringify([true, false, false, false, false]), '面门：走错面的才算被挡；没声明面门、when 抛错都按没走错面', JSON.stringify(sb));
    const app = express();
    const recorded = [];
    const body = JSON.stringify({ error: 'judgment_denied', action: 'x.read' });
    app.use((req, res, next) => { denyIfAllowed(res, req.path === '/ok401' ? 401 : 403, body, () => recorded.push(req.path)); next(); });
    app.get(['/ok', '/ok401'], (_q, r) => r.set('ETag', 'W/"secret"').json({ secret: 'CANARY-READ-SECRET-1' }));
    app.get('/stream', (_q, r) => { r.status(200); r.setHeader('Content-Type', 'text/plain'); r.write('CANARY-READ-SECRET-2'); r.write('more'); r.end('tail'); });
    app.get('/redirect', (_q, r) => r.redirect('/elsewhere?CANARY-READ-SECRET-3'));
    app.get('/denied', (_q, r) => r.status(403).json({ error: 'old_guard_said_no' }));
    app.get('/hidden', (_q, r) => r.status(404).json({ error: 'not_found' }));
    app.get('/gone', (_q, r) => r.status(410).json({ error: 'gone' }));
    const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, method = 'GET') => { const r = await fetch(base + path, { method, redirect: 'manual' }); return { status: r.status, text: await r.text(), etag: r.headers.get('etag'), location: r.headers.get('location'), len: r.headers.get('content-length') }; };
    const r = { ok: await get('/ok'), ok401: await get('/ok401'), stream: await get('/stream'), redirect: await get('/redirect'), head: await get('/ok', 'HEAD'),
      denied: await get('/denied'), hidden: await get('/hidden'), gone: await get('/gone') };
    await new Promise((ok) => server.close(ok));
    const replaced = ['ok', 'ok401', 'stream', 'redirect'].every((k) => r[k].text === body && !r[k].text.includes('CANARY') && !r[k].etag && !r[k].location && Number(r[k].len) === Buffer.byteLength(body));
    check(replaced && r.ok.status === 403 && r.ok401.status === 401 && r.stream.status === 403 && r.redirect.status === 403 && r.head.status === 403 && r.head.text === '',
      '读的路：旧的要放行（json、流式写、跳转、HEAD）都换成拒绝，旧的应答体、ETag、跳转地址一个都不发；没认出人的 401 照路由声明', show(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.status, v.text.slice(0, 40)]]))));
    check(r.denied.status === 403 && r.denied.text === '{"error":"old_guard_said_no"}' && r.hidden.status === 404 && r.hidden.text === '{"error":"not_found"}' && r.gone.status === 410
      && show(recorded.sort()) === show(['/ok', '/ok', '/ok401', '/redirect', '/stream']),
      '读的路：旧的也拒、404 藏起来的、410 的原样放过（逐字一样）；只有真的换掉的才记账', show({ denied: r.denied.text, hidden: r.hidden.text, recorded }));
    // 接进实例：切了 work-items，远程匿名读事项列表——旧守卫回 401，原样回旧的写法
    const off = await boot('read-off', { WM_JUDGMENT_COMPARE: 'on' });
    const on = await boot('read-on', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_ENFORCE: 'work-items,work-item' });
    const a = await off.call('GET', '/api/work-items', { headers: REMOTE });
    const b = await on.call('GET', '/api/work-items', { headers: REMOTE });
    check(a.status === 401 && b.status === 401 && a.text === b.text && !b.text.includes('judgment_denied'),
      '切了 work-items：远程匿名读事项列表，新判定拒、旧守卫也拒，应答和不切时逐字一样', show({ off: [a.status, a.text], on: [b.status, b.text] }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); }
  await sleep(500);
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`judgment-enforce-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
