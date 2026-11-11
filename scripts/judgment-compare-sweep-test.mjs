#!/usr/bin/env node
/**
 * 判定并行比对的零不一致门槛，第二种覆盖（阶段六 6c，接进 CI）：每种身份把动作快照里的每条 GET 都打一遍，写面挑代表，新旧结论不一致必须为 0。
 * 录制回放只覆盖录过的请求：内置身份的清单少列一项，回放没录到那一条就抓不到。这里按身份 × 路由铺满，补上这个缺口。
 *
 * 六种身份：匿名（经反代的远程）、本机页面（回环直连的同源浏览器）、本机命令行、员工（身份来源的非管理员）、身份来源管理员、管理口令。
 * 只在本机起隔离实例，身份来源是合成的，不访问任何外部系统。
 *
 *   node scripts/judgment-compare-sweep-test.mjs              测本仓库
 *   node scripts/judgment-compare-sweep-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `judgment-sweep-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-judgment-sweep-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.71' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

let child = null;
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

let ok = false;
try {
  const port = await freePort();
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '',
    IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: join(OUT, 'compare.jsonl'),
  });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);

  const call = async (method, path, headers = {}, body) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      await res.arrayBuffer();
      return res.status;
    } catch { return 0; }
  };

  const IDS = {
    匿名: REMOTE,
    本机页面: { origin: base, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'user-agent': 'Mozilla/5.0 (judgment sweep)' },
    本机命令行: {},
    员工: { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` },
    身份来源管理员: { ...REMOTE, cookie: `session_id=${SESSIONS.admin}` },
    管理口令: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN },
  };

  // 种一个台、一个自产台、一个 run，让带 id 的路由走到处理函数里
  await call('POST', '/api/workbenches', {}, { name: 'sweep-wb', url: 'http://127.0.0.1:9/x', type: 'web' });
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare("INSERT INTO apps (slug, title) VALUES ('sweep-app', 'sweep-app')").run(); } finally { db.close(); }
  }
  const concrete = (p) => {
    if (p.startsWith('/^')) return p.includes('sop') ? '/sop/sweep-sop/' : p.includes('design') ? '/design/tokens@1.css' : p.includes('apps') ? '/apps/sweep-app/' : '/some/page';
    return p.replace(/:id\(\\d\+\)/g, '1').replace(':fileId', '1').replace(':eventId', 'wbe-0000000000000001').replace(':ticket', '0'.repeat(64))
      .replace(':key', 'sweepkey').replace(':slug', 'sweep-app').replace(':flow', 'nosuch').replace(':name', 'sweep').replace(':id', '1');
  };
  const snap = JSON.parse(readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8'));
  const gets = [...new Set(snap.apps.flat().map((l) => /^(GET|ALL) (\S+)\s+->\s+\S/.exec(l)?.[2]).filter(Boolean))];
  let n = 0;
  for (const path of gets) for (const h of Object.values(IDS)) { await call('GET', concrete(path), h); n++; }
  // 写面挑代表：走写请求总门的普通写、口令、匿名提交面（台数据、run 的开建）、主体与授予的管理面
  const writes = [
    ['POST', '/api/types', { name: 'sweep-type', label: 'sweep' }],
    ['POST', '/api/cockpits', { name: 'sweep-cockpit' }],
    ['PUT', '/api/settings', { check_interval: 300 }],
    ['POST', '/api/cookies', { label: 'sweep', cookies: [] }],
    ['POST', '/api/apps/sweep-app/data', { data: { a: 1 } }],
    ['POST', '/api/sop/runs', { slug: 'no-such-sop' }],
    ['POST', '/api/grants', { role: 'member', scope: '*' }],
    ['POST', '/api/grants/revoke-migration', { reason: 'sweep' }],
    ['POST', '/api/principals/disable', { id: 'user:nobody', reason: 'sweep' }],
  ];
  for (const [method, path, body] of writes) for (const h of Object.values(IDS)) { await call(method, path, h, body); n++; }

  await sleep(1500); // 比对在应答之后攒批写
  const rep = await (await fetch(`${base}/api/judgment/compare`, { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } })).json();
  const sum = (o) => (rep?.tally ?? []).filter((t) => t.outcome === o).reduce((a, t) => a + t.count, 0);
  const compared = (rep?.tally ?? []).reduce((a, t) => a + t.count, 0);
  const mismatches = rep?.mismatches ?? [];
  for (const m of mismatches) console.log(`  ✗ 不一致：${m.route}｜${m.actor_kind}｜${m.action}｜旧${m.old}·新${m.new}｜${m.rule}（${m.count} 次）`);
  ok = rep?.on === true && compared > 0 && sum('mismatch') === 0 && sum('error') === 0;
  console.log(`  ${ok ? '✓' : '✗'} 六种身份 × ${gets.length} 条 GET + ${writes.length} 个写：请求 ${n} 次，比对 ${compared} 次，不一致 ${sum('mismatch')}，判定出错 ${sum('error')}`);
} catch (e) {
  console.log(`  ✗ 没跑成：${e?.message ?? e}`);
} finally {
  await stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`judgment-compare-sweep-test: ${ok ? '1 passed / 0 failed' : '0 passed / 1 failed'}`);
process.exit(ok ? 0 : 1);
