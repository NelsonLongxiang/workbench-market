#!/usr/bin/env node
/**
 * 判定比对报告的「接口合计」入口（judgment-compare-report.mjs --snapshot / --since）的单测。
 * 生产上不开 WM_JUDGMENT_COMPARE_OUT（每比一次加一行、不轮转），报告改拿 GET /api/judgment/compare 的应答出；
 * 这里核它和逐行输出（--from）出的是同一份数。
 *
 *   一、同一个实例、同一批请求：--from 逐行输出 和 --snapshot 接口应答，出的合计、按域、不一致（原因 × 身份 × 域）逐项相同
 *       （面门拦下的在库里和完整性门记在一起，比之前把逐行输出里的 surface-blocked 并进 integrity-blocked；error 只在库里有，不比）
 *   二、--since：两份应答相减，和逐行输出里两次取数之间的那几行出的数逐项相同
 *   三、拒绝的输入（退出 2，不出半截的报告）：--since 那份更多（库清过或给反了）、比对没打开的应答、不是这个接口的 JSON、
 *       --since 不带 --snapshot、--snapshot 和 --from 一起给
 *   四、--require-zero：接口合计里有不一致就失败（退出 1）
 *   五、切换开关拒掉的（enforced 表）进 enforced-deny；记账写失败不是 0 时报告点出来
 *
 * 真实的 server/src/index.ts，身份来源是假提供方，只在 127.0.0.1 上，不访问任何外部系统。
 *   node scripts/judgment-compare-snapshot-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `judgment-snapshot-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const REPORT = join(HERE, 'judgment-compare-report.mjs');
const ADMIN_TOKEN = 'synthetic-snapshot-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.62' };
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

let child = null;
async function boot(outFile) {
  const port = await freePort();
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  // 「没报动作」的结果用一个扩展直接挂在 ctx.app 上的路由来造（和 judgment-compare-smoke 一样）
  mkdirSync(join(ext, 'legacy-probe'), { recursive: true });
  writeFileSync(join(ext, 'legacy-probe', 'server.mjs'), "export function register(ctx) { ctx.app.get('/legacy-probe/ping', (_req, res) => { res.json({ ok: true }); }); }\n");
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: outFile });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40000;
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json };
  };
  return { base, host: new URL(base).host, call };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** 跑报告脚本，返回退出码和它写的 JSON（没写出来为 null） */
function report(args, name) {
  const out = join(OUT, `${name}.md`);
  const r = spawnSync(process.execPath, [REPORT, ...args, '--out', out], { cwd: ROOT, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(readFileSync(out.replace(/\.md$/, '.json'), 'utf8')); } catch { /* 没写出来 */ }
  let md = ''; try { md = readFileSync(out, 'utf8'); } catch { /* 没写出来 */ }
  return { status: r.status, json, md, stderr: r.stderr };
}
/** 两份报告可比的部分：逐行输出里的 surface-blocked 并进 integrity-blocked（库里就是这么记的）；error 只在库里有，不比 */
function comparable(j) {
  if (!j) return null;
  const fold = (e) => { const o = { ...e }; o['integrity-blocked'] = (o['integrity-blocked'] ?? 0) + (o['surface-blocked'] ?? 0); o.total = (o.total ?? 0) - (o.error ?? 0) - (o.other ?? 0); delete o['surface-blocked']; delete o.error; delete o.other; return o; };
  const byDomain = Object.fromEntries(Object.entries(j.by_domain).map(([d, e]) => [d, fold(e)]).filter(([, e]) => e.total > 0).sort());
  const reasons = j.reasons.map((r) => ({ reason: r.reason, actor: r.actor, count: r.count, domains: r.domains, routes: r.routes })).sort((a, b) => (a.reason + a.actor < b.reason + b.actor ? -1 : 1));
  return sorted({ totals: fold(j.totals), byDomain, reasons, uncertain: j.uncertain, unregistered: j.unregistered });
}
/** 键排好序（两条路攒数的先后不同，对象的键顺序会不一样） */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

try {
  mkdirSync(OUT, { recursive: true });
  const jsonl = join(OUT, 'compare.jsonl');
  const srv = await boot(jsonl);
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const asRoot = { headers: { ...REMOTE, ...same }, session: SESSIONS.admin };
  const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };
  // 取数这一次请求自己的比对在应答之后才记：它不在自己这份里，却在逐行输出里。两边都去掉这条路由再比
  const SELF = 'GET /api/judgment/compare';
  const snapshot = async (name) => {
    await sleep(400);
    const r = await srv.call('GET', '/api/judgment/compare');
    const f = join(OUT, `${name}.json`);
    writeFileSync(f, JSON.stringify({ ...r.json, tally: (r.json?.tally ?? []).filter((t) => t.route !== SELF) }));
    return f;
  };
  const notSelf = (l) => { try { return JSON.parse(l).route !== SELF; } catch { return true; } };

  // 第一批：一致、不确定、404 不判、没报动作、状态码不代表授权、被完整性门拦下，再造一种不一致（撤掉迁移给的 admin）
  await srv.call('GET', '/api/principals', { headers: token });
  await srv.call('GET', '/api/types', { headers: REMOTE });
  await srv.call('GET', '/api/principals', asRoot); // 第一次见到：迁移给 admin
  await srv.call('POST', '/api/grants', { body: { role: 'member', scope: '*' } }); // 400：不确定
  await srv.call('GET', '/api/departments/no-such-dept-1', { headers: token }); // 404：不判
  await srv.call('GET', '/legacy-probe/ping'); // 没报动作
  await srv.call('GET', '/api/grants'); // 声明了状态码不代表授权
  await srv.call('GET', '/api/principals', { headers: { ...REMOTE, ...cross }, session: SESSIONS.admin }); // 跨站被拒
  const admins = ((await srv.call('GET', '/api/grants?source=migration&principal=user:root-admin')).json?.grants ?? []).filter((g) => g.role === 'admin');
  await srv.call('POST', `/api/grants/${admins[0]?.id}/revoke`, { body: { reason: '合成：故意撤，看比对' } });
  await srv.call('GET', '/api/principals', asRoot); // 旧允许、新拒绝
  const snap1 = await snapshot('snap1');
  await sleep(300);
  const cut = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim()).length;
  // 第二批：同一种不一致再来两次，另有几次一致
  await srv.call('GET', '/api/principals', asRoot);
  await srv.call('GET', '/api/principals', asRoot);
  await srv.call('GET', '/api/types', { headers: REMOTE });
  await srv.call('GET', '/api/principals', { headers: token });
  const snap2 = await snapshot('snap2');
  await stop();
  const all = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim());
  const head = join(OUT, 'all.jsonl'), tail = join(OUT, 'tail.jsonl');
  writeFileSync(head, all.filter(notSelf).join('\n') + '\n');
  writeFileSync(tail, all.slice(cut).filter(notSelf).join('\n') + '\n');

  // ---------- 一、--snapshot 和 --from 同一份数 ----------
  {
    const a = report(['--from', head], 'from-all');
    const b = report(['--snapshot', snap2], 'snap-all');
    const ca = comparable(a.json), cb = comparable(b.json);
    check(a.status === 0 && b.status === 0 && !!ca && show(ca) === show(cb) && ca.totals.mismatch === 3 && ca.totals.agree > 0 && ca.totals.uncertain > 0
      && ca.totals['skip-404'] > 0 && ca.totals.unregistered > 0 && ca.totals['not-verdict'] > 0 && ca.totals['integrity-blocked'] > 0,
      '同一批请求：接口合计（--snapshot）和逐行输出（--from）出的合计、按域、不一致（原因 × 身份 × 域 × 路由）逐项相同；七类结果都有',
      show({ a: [a.status, ca?.totals], b: [b.status, cb?.totals], stderr: b.stderr.slice(0, 200) }));
    check(/记账写失败 0 次、队列满丢掉 0 次/.test(b.md) && /接口合计/.test(b.md) && !/记账写失败/.test(a.md),
      '接口合计的报告写明丢数计数（都是 0），不一致的复现指到路由；逐行输出的报告不写这一行', show(b.md.split('\n').slice(0, 6)));
  }

  // ---------- 二、--since：两份相减 ----------
  {
    const a = report(['--from', tail], 'from-tail');
    const b = report(['--snapshot', snap2, '--since', snap1], 'snap-delta');
    const ca = comparable(a.json), cb = comparable(b.json);
    check(a.status === 0 && b.status === 0 && !!ca && show(ca) === show(cb) && ca.totals.mismatch === 2 && /只算和上一份之间新增的/.test(b.md),
      '--since：两份应答之间新增的，和逐行输出里两次取数之间那几行出的数逐项相同（第二批的两次不一致、几次一致）',
      show({ a: ca?.totals, b: cb?.totals }));
  }

  // ---------- 三、拒绝的输入 ----------
  {
    const offFile = join(OUT, 'off.json'); writeFileSync(offFile, JSON.stringify({ on: false, tally: [], mismatches: [], writeFailures: 0, dropped: 0 }));
    const junk = join(OUT, 'junk.json'); writeFileSync(junk, JSON.stringify({ ok: true }));
    const r = {
      reversed: report(['--snapshot', snap1, '--since', snap2], 'rej-reversed'),
      off: report(['--snapshot', offFile], 'rej-off'),
      junk: report(['--snapshot', junk], 'rej-junk'),
      sinceAlone: report(['--since', snap1], 'rej-since'),
      both: report(['--snapshot', snap2, '--from', jsonl], 'rej-both'),
      missing: report(['--snapshot', join(OUT, 'nope.json')], 'rej-missing'),
    };
    const st = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.status, !!v.json]]));
    check(Object.values(r).every((v) => v.status === 2 && v.json === null) && /计数变小/.test(r.reversed.stderr) && /on=false/.test(r.off.stderr),
      '拒绝的输入一律退出 2、不出报告：--since 那份更多（库清过或给反了）、比对没打开、不是这个接口的应答、--since 单给、和 --from 一起给、文件不存在', show(st));
  }

  // ---------- 四、--require-zero ----------
  {
    const z = report(['--snapshot', snap2, '--require-zero'], 'zero');
    check(z.status === 1, '--require-zero：接口合计里有不一致就退出 1', show({ status: z.status }));
  }

  // ---------- 五、切换开关拒掉的（enforced 表）进「按域」的 enforced-deny 列 ----------
  {
    const f = join(OUT, 'enforced.json');
    writeFileSync(f, JSON.stringify({ on: true, tally: [{ route: 'GET /api/types', action: 'types.list', outcome: 'agree', count: 4 }], mismatches: [],
      enforced: [{ route: 'POST /api/grants', action: 'grant.create', actor_kind: 'person', verdict: 'deny', rule: 'no-grant', count: 3 }], writeFailures: 2, dropped: 0 }));
    const r = report(['--snapshot', f], 'enforced');
    check(r.status === 0 && r.json?.totals?.['enforced-deny'] === 3 && r.json?.by_domain?.grant?.['enforced-deny'] === 3 && r.json?.totals?.agree === 4
      && /记账写失败 2 次/.test(r.md) && /不是 0/.test(r.md),
      '接口合计里切换开关拒掉的（enforced 表）记进 enforced-deny，按动作归域；记账写失败不是 0 时报告点出来', show({ status: r.status, totals: r.json?.totals }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  await stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`judgment-compare-snapshot-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
