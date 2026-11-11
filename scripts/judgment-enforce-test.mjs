#!/usr/bin/env node
/**
 * 判定切换开关（WM_JUDGMENT_ENFORCE，阶段六 6d 第 0 步）的对抗组。真实的 server/src/index.ts，身份来源是假提供方，
 * 只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、拒绝启动：域名写法不对、域没有登记的动作、比对没开
 *   二、缺省空：一个域都不切，拒绝的应答还是旧守卫的写法
 *   三、切了 principal、stats 两个域：
 *       · 新判定放行的照常（匿名读统计；口令、管理员登录、本机命令行列主体）；
 *       · 新判定拒绝的在处理之前回 403 judgment_denied（远程匿名、普通员工列主体），记进 judgment_enforced，不算不一致；
 *       · 没切的域照旧按旧守卫（匿名读 Cookie 池、远程匿名列授予的拒绝写法不变）；
 *       · 反向比对：给员工一条 admin 授予，新判定放行、旧守卫照旧拒，记成不一致（说明旧守卫还不能拿掉）
 *
 *   node scripts/judgment-enforce-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
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
    const srv = await boot('enforce', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_ENFORCE: 'principal,stats' });
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
      grantsAnon: await srv.call('GET', '/api/grants', { headers: REMOTE }),
    };
    check(srv.log().includes('"event":"enforce"') && srv.log().includes('"principal"'), '切换的启动日志写明切了哪些域');
    check(r.statsAnon.status === 200 && r.listToken.status === 200 && Array.isArray(r.listToken.json?.principals) && r.listOdooAdmin.status === 200 && r.listCli.status === 200,
      '新判定放行的照常：匿名读统计；口令、管理员登录（迁移出的系统管理员）、本机命令行列主体', show(Object.fromEntries(['statsAnon', 'listToken', 'listOdooAdmin', 'listCli'].map((k) => [k, r[k].status]))));
    check(r.listAnon.status === 403 && r.listAnon.json?.error === 'judgment_denied' && r.listAnon.json?.action === 'principal.list'
      && r.listStaff.status === 403 && r.listStaff.json?.error === 'judgment_denied' && !r.listStaff.text.includes('user:'),
      '新判定拒绝的在处理之前回 403 judgment_denied（远程匿名、普通员工列主体），应答里没有主体内容', show({ anon: r.listAnon.json, staff: r.listStaff.json }));
    check(r.cookiesAnon.status === 200 && r.grantsAnon.status === 403 && !r.grantsAnon.text.includes('judgment_denied'),
      '没切的域照旧按旧守卫：匿名读 Cookie 池 200；远程匿名列授予由旧守卫拒，写法不变', show({ cookies: r.cookiesAnon.status, grants: r.grantsAnon.text.slice(0, 120) }));

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
    check(enforcedRows.some((e) => e.route === 'GET /api/principals' && e.actor_kind === 'anonymous' && e.verdict === 'deny')
      && enforcedRows.some((e) => e.route === 'GET /api/principals' && e.actor_kind === 'person' && e.verdict === 'deny')
      && !mism.some((m) => m.actor_kind === 'anonymous'),
      '开关拒掉的记进 judgment_enforced（路由、身份类别、结论、规则），不当不一致', show(enforcedRows));
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
