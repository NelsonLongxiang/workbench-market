#!/usr/bin/env node
/**
 * 判定并行比对的对抗组（阶段六 6c）。真实的 server/src/index.ts，身份来源是假提供方（identity-fake-provider.mjs），
 * 只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、开关：缺省关（报告是空的、不记任何东西）；值不合法拒绝启动（进程自己以非 0 退出）
 *   二、各类结果落对地方：内置身份按清单一致、细分的动作、被完整性门拦下、状态码不代表授权、不确定、404 不判、没报动作不比
 *   三、迁移：第一次见到的人给 member，身份来源说是管理员的给 admin，来源记 migration；重复见不重复迁
 *   四、故意撤一条授予：比对里出现对应的不一致；迁移不会把它补回来
 *   五、迁移出来的授予：一条命令列出、一条命令整批撤销（只有属主能）
 *   六、记录里没有查询串、路径里的 id、口令和 cookie
 *   六之二、请求本身改了口令：身份按请求进来时认
 *   七、判定出错只计数：挂一个抛错的监听器，应答和比对关着时逐字节相同
 *
 *   node scripts/judgment-compare-smoke.mjs              测本仓库
 *   node scripts/judgment-compare-smoke.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `judgment-compare-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const FAULT = pathToFileURL(join(HERE, 'judgment-fault-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-judgment-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.61' };
const token = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };

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

const running = [];
async function boot(name, extraEnv = {}, { expectFail = false, fault = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const args = ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, ...(fault ? ['--import', FAULT] : []), 'src/index.ts'];
  const child = spawn(process.execPath, args, { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (expectFail ? 20000 : 40000);
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => {
    if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); }
    if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); }
  };
  if (!ready) {
    const code = child.exitCode;
    await stop();
    if (expectFail) return { failed: true, code, log };
    throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  }
  if (expectFail) { await stop(); return { failed: false, log }; }
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  // 比对在应答结束之后算：取报告之前稍等，让前面的请求都记完
  const report = async () => { await sleep(300); return (await call('GET', '/api/judgment/compare')).json; };
  const srv = { name, base, host: new URL(base).host, stop, call, report, log: () => log };
  running.push(srv);
  return srv;
}

const tallyOf = (rep, route, outcome) => (rep?.tally ?? []).find((t) => t.route === route && t.outcome === outcome)?.count ?? 0;
const mismatch = (rep, route, rule) => (rep?.mismatches ?? []).find((m) => m.route === route && (!rule || m.rule === rule));

try {
  // ---------- 一、开关 ----------
  {
    const off = await boot('off');
    await off.call('GET', '/api/types', { headers: REMOTE });
    await off.call('GET', '/api/grants', { headers: token });
    const rep = await off.report();
    const bad = await boot('bad-switch', { WM_JUDGMENT_COMPARE: 'yes' }, { expectFail: true });
    const relOut = await boot('bad-out', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: 'out.jsonl' }, { expectFail: true });
    check(rep?.on === false && rep.tally.length === 0 && rep.mismatches.length === 0
      && bad.failed && bad.code !== null && bad.code !== 0 && bad.log.includes('[judgment] 拒绝启动') && relOut.failed && relOut.code !== 0,
      '开关：缺省关，报告是空的；WM_JUDGMENT_COMPARE 不是 on/off、输出路径不是绝对的，进程自己以非 0 退出', show({ on: rep?.on, tally: rep?.tally?.length, bad: bad.code, relOut: relOut.code }));
    await off.stop();
  }

  const outFile = join(OUT, 'compare.jsonl');
  mkdirSync(OUT, { recursive: true });
  const srv = await boot('on', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: outFile });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const asRoot = { headers: { ...REMOTE, ...same }, session: SESSIONS.admin };
  const asAlpha = { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha };

  // ---------- 二、各类结果 ----------
  {
    const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };
    await srv.call('GET', '/api/grants'); // 本机命令行读授予：L19 起登录的人按对象裁剪，路由声明了状态码不代表授权
    await srv.call('GET', '/api/principals', { headers: token }); // 管理口令读管理面：一致
    await srv.call('GET', '/api/types?secret=synthetic-query-secret', { headers: REMOTE }); // 匿名读开放面：清单里列了，一致
    await srv.call('GET', '/api/export', { headers: REMOTE }); // 匿名拿掩码导出：一致
    await srv.call('GET', '/api/export?reveal=1', { headers: REMOTE }); // 匿名取真值：细分成 market.export-reveal，两边都拒
    await srv.call('GET', '/api/principals', { headers: { ...token, ...cross } }); // 带有效口令的跨站：被完整性门拦下
    await srv.call('GET', '/api/auth/viewer', { headers: REMOTE }); // 声明了状态码不代表授权
    await srv.call('POST', '/api/grants', { body: { role: 'member', scope: '*' } }); // 400：不确定
    await srv.call('GET', '/api/grants/987654', { headers: token }); // 授予单条：同样声明了状态码不代表授权
    await srv.call('GET', '/api/departments/no-such-dept-987654', { headers: token }); // 404：不判
    await srv.call('GET', '/api/workbenches/1/vars', { headers: token }); // 工作台变量的存量路由：没报动作（新库自带任务中心这个台，id 1）
    const rep = await srv.report();
    check(rep.on === true && rep.mismatches.length === 0
      && tallyOf(rep, 'GET /api/grants', 'not-verdict') === 1 && tallyOf(rep, 'GET /api/grants/:id', 'not-verdict') === 1 && tallyOf(rep, 'GET /api/principals', 'agree') >= 1
      && tallyOf(rep, 'GET /api/types', 'agree') === 1 && tallyOf(rep, 'GET /api/export', 'agree') === 2
      && tallyOf(rep, 'GET /api/principals', 'integrity-blocked') === 1 && tallyOf(rep, 'GET /api/auth/viewer', 'not-verdict') === 1
      && tallyOf(rep, 'POST /api/grants', 'uncertain') === 1 && tallyOf(rep, 'GET /api/departments/:id', 'skip-404') === 1
      && tallyOf(rep, 'GET /api/workbenches/:id/vars', 'unregistered') === 1,
      '各类结果：管理口令、匿名按登记的清单一致；授予的读（按对象裁剪）记「状态码不代表授权」；导出按 reveal 细分后两种都一致；带口令的跨站记「被完整性门拦下」；声明的路由记「状态码不代表授权」；400 不确定；404 不判；没报动作的不比',
      show(rep.tally));
  }

  // ---------- 三、迁移 ----------
  {
    const a1 = await srv.call('GET', '/api/principals', asRoot);
    await srv.call('GET', '/api/types', asAlpha);
    await srv.call('GET', '/api/principals', asAlpha); // 非管理员读管理面：旧的拒、新的也拒（member 没有管理类）
    await srv.call('GET', '/api/principals', asRoot); // 再见一次：不重复迁
    const rep = await srv.report();
    const migrated = (await srv.call('GET', '/api/grants?source=migration')).json?.grants ?? [];
    const pairs = migrated.map((g) => `${g.principal_id}:${g.role}:${g.status}`).sort();
    check(a1.status === 200 && show(pairs) === show(['user:alpha:member:active', 'user:root-admin:admin:active', 'user:root-admin:management:active', 'user:root-admin:member:active'])
      && migrated.every((g) => g.source === 'migration' && g.approved_by === 'system:migration')
      && !mismatch(rep, 'GET /api/principals') && tallyOf(rep, 'GET /api/types', 'agree') >= 1,
      '迁移：第一次见到的人给 member、身份来源说是管理员的给 admin 和 management 两条（等于今天的原样，能分别撤；不经三档放行，L6），来源 migration、放行人 system:migration；再见不重复迁；迁完之后管理员读管理面、成员读开放面、成员读管理面（两边都拒）都一致', show({ pairs, tally: rep.tally.filter((t) => t.route === 'GET /api/principals') }));
  }

  // ---------- 四、故意撤一条授予 ----------
  {
    const admins = ((await srv.call('GET', '/api/grants?source=migration&principal=user:root-admin')).json?.grants ?? []).filter((g) => g.role === 'admin');
    const rv = await srv.call('POST', `/api/grants/${admins[0]?.id}/revoke`, { body: { reason: '合成：故意撤，看比对' } });
    const after = await srv.call('GET', '/api/principals', asRoot);
    await srv.call('GET', '/api/principals', asRoot);
    const rep = await srv.report();
    const m = mismatch(rep, 'GET /api/principals', 'no-grant');
    const again = ((await srv.call('GET', '/api/grants?principal=user:root-admin&source=migration')).json?.grants ?? []).filter((g) => g.role === 'admin');
    check(rv.status === 200 && after.status === 200 && m?.old === 'allow' && m.new === 'deny' && m.actor_kind === 'person' && m.count === 2
      && again.length === 1 && again[0].status === 'revoked',
      '故意撤掉迁移给的 admin：旧守卫照样放行（应答不变），比对里出现「旧允许、新拒绝、没有授予」，同一种合并计数；迁移不会把它补回来', show({ rv: rv.status, after: after.status, m, again: again.map((g) => g.status) }));
  }

  // ---------- 五、迁移的整批撤销 ----------
  {
    const byToken = await srv.call('POST', '/api/grants/revoke-migration', { headers: token, body: { reason: '合成' } });
    const noReason = await srv.call('POST', '/api/grants/revoke-migration', { body: {} });
    const byCli = await srv.call('POST', '/api/grants/revoke-migration', { body: { reason: '合成：整批撤销' } });
    const left = ((await srv.call('GET', '/api/grants?source=migration&status=active')).json?.grants ?? []).length;
    const manual = (await srv.call('GET', '/api/grants?source=manual')).json?.grants ?? [];
    check(byToken.status === 403 && noReason.status === 400 && byCli.status === 200 && byCli.json?.revoked === 3 && left === 0 && manual.length === 0,
      '迁移出来的授予整批撤销：口令管理员 403（只有属主能）、不写理由 400；本机命令行撤了剩下的 3 条，之后一条生效的都没有', show({ byToken: byToken.status, noReason: noReason.status, byCli: byCli.json, left }));
  }

  // ---------- 六、记录里没有不该有的 ----------
  {
    const rep = JSON.stringify(await srv.report());
    const lines = readFileSync(outFile, 'utf8');
    const leaks = ['synthetic-query-secret', ADMIN_TOKEN, SESSIONS.admin, SESSIONS.alpha, '987654', '192.0.2.61'].filter((x) => rep.includes(x) || lines.includes(x));
    const routesOk = lines.trim().split('\n').every((l) => { const o = JSON.parse(l); return !String(o.route ?? '').includes('?') && !Object.keys(o).some((k) => ['body', 'query', 'headers', 'cookie', 'principal'].includes(k)); });
    check(leaks.length === 0 && routesOk && rep.includes('GET /api/grants/:id'),
      '比对记录（库里的报告、输出文件）没有查询串、路径里的 id、口令、cookie 和来源地址；路由记模式；输出文件不记主体', show({ leaks }));
  }
  await srv.stop();

  // ---------- 六之二、请求本身改了口令：身份按请求进来时认 ----------
  {
    // 口令放在库里（不设环境变量，才能经接口改）：先本机命令行设一个，再远程带着它改成新的
    const tk = await boot('token-change', { WM_JUDGMENT_COMPARE: 'on', ADMIN_TOKEN: '' });
    const first = await tk.call('PUT', '/api/admin-token', { body: { token: 'synthetic-judgment-first-0001' } });
    const changed = await tk.call('PUT', '/api/admin-token', { headers: { ...REMOTE, 'x-admin-token': 'synthetic-judgment-first-0001' }, body: { token: 'synthetic-judgment-second-0002' } });
    await sleep(300);
    const rep2 = (await tk.call('GET', '/api/judgment/compare')).json;
    check(first.status === 200 && changed.status === 200 && tallyOf(rep2, 'PUT /api/admin-token', 'agree') === 2 && !mismatch(rep2, 'PUT /api/admin-token'),
      '请求本身改了口令：按请求进来时的身份（应急管理员）判，一致；不会事后拿新口令去认、认成匿名', show({ first: first.status, changed: changed.status, tally: rep2?.tally?.filter((t) => t.route === 'PUT /api/admin-token'), m: rep2?.mismatches }));
    await tk.stop();
  }

  // ---------- 七、判定出错只计数，应答逐字节不变 ----------
  {
    const plain = await boot('plain');
    const faulty = await boot('faulty', { WM_JUDGMENT_COMPARE: 'on' }, { fault: true });
    const probes = [
      ['GET', '/api/types', { headers: REMOTE }],
      ['GET', '/api/roles', { headers: token }],
      ['POST', '/api/grants', { headers: token, body: { role: 'member' } }],
      ['GET', '/api/grants/42', { headers: token }],
      ['GET', '/api/principals', { headers: REMOTE }],
    ];
    const diffs = [];
    for (const [m, p, o] of probes) {
      const a = await plain.call(m, p, o), b = await faulty.call(m, p, o);
      // 两个实例前后脚起，建表时写下的时间可能差一秒：只把时间换成占位，别的逐字节比
      const steady = (t) => t.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<时间>');
      if (a.status !== b.status || steady(a.text) !== steady(b.text)) diffs.push([m, p, a.status, b.status, a.text.slice(0, 300), b.text.slice(0, 300)]);
    }
    const rep = await faulty.report();
    const errors = (rep?.tally ?? []).filter((t) => t.outcome === 'error').reduce((n, t) => n + t.count, 0);
    check(diffs.length === 0 && errors >= 3 && (rep?.mismatches ?? []).length === 0,
      '判定监听器抛错：应答和比对关着的实例逐字节相同（5 种请求；两个实例建表的时间换成占位），出错只计数', show({ diffs, errors }));
    await plain.stop(); await faulty.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`judgment-compare-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
