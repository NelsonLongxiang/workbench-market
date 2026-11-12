#!/usr/bin/env node
/**
 * 身份来源慢或不通时的对抗组。真实的 server/src/index.ts，身份来源是假提供方（identity-fake-provider.mjs，自报期限 250 毫秒），
 * 只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、来源不回包：带 cookie 的读、写在上限时间内得到确定的应答（认不出，失败关闭），不放行、不当成匿名放到匿名能读的面之外
 *   二、同一个 cookie 短时间里反复认不出：只问来源一次（同时来的合并，刚认不出的留几秒）
 *   三、来源恢复：不用重启，过了留存时间就认得出
 *   四、health 里看得出：问了几次、到点没回答几次、最近一次耗时
 *
 *   node scripts/identity-source-timeout-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS, DEADLINE_MS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `identity-timeout-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-timeout-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.91' };
/** 一次请求的上限：来源的期限加上余量。改动之前，一个请求里几处认人各等一遍 */
const BOUND_MS = DEADLINE_MS + 1500;

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
const data = join(OUT, 'data');
const DOWN = join(data, 'fake-identity-down');
async function boot() {
  const port = await freePort();
  const home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext });
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
  const host = new URL(base).host;
  const call = async (method, path, { session, body, headers = {} } = {}) => {
    const h = { ...REMOTE, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const t0 = Date.now();
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, ms: Date.now() - t0, text, json };
  };
  return { call };
}

try {
  const srv = await boot();
  const stats = async () => (await srv.call('GET', '/api/health')).json?.identity_source ?? null;
  // 先让 alpha 进主体表（来源正常时）
  await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.alpha });

  // ---------- 一、来源不回包：确定的应答，失败关闭 ----------
  {
    const anon = await srv.call('GET', '/api/work-items');
    const s0 = await stats();
    const read = await srv.call('GET', '/api/work-items', { session: SESSIONS.hangs });
    const write = await srv.call('POST', '/api/work-items', { session: SESSIONS.hangs, body: { title: '合成：来源不回包时建事项' } });
    const viewer = await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.hangs });
    const s1 = await stats();
    const closed = (r) => r.status >= 400 && r.status !== 404 && !(r.json?.items?.length > 0);
    check(read.ms < BOUND_MS && write.ms < BOUND_MS && viewer.ms < BOUND_MS && closed(read) && closed(write) && closed(viewer)
      && anon.status >= 400 && read.status >= 400 && s1.timeouts >= s0.timeouts + 1 && typeof s1.last_ms === 'number',
      `来源不回包：带 cookie 的读、写、「你是谁」都在 ${BOUND_MS} 毫秒内有确定的应答，失败关闭（不是 2xx，不当成匿名放行）；health 记下到点没回答`,
      show({ anon: anon.status, read: [read.status, read.ms], write: [write.status, write.ms], viewer: [viewer.status, viewer.ms, viewer.json?.error], s0, s1 }));
  }

  // ---------- 二、同一个 cookie 反复认不出：只问一次 ----------
  {
    writeFileSync(DOWN, 'down');
    const s0 = await stats();
    const burst = await Promise.all(Array.from({ length: 6 }, () => srv.call('GET', '/api/work-items', { session: SESSIONS.flaky })));
    const again = await srv.call('GET', '/api/work-items', { session: SESSIONS.flaky });
    const s1 = await stats();
    check(burst.every((r) => r.status >= 400 && r.ms < BOUND_MS) && again.status >= 400 && again.ms < DEADLINE_MS && s1.asked - s0.asked === 1
      && s1.shared + s1.negative_hits > s0.shared + s0.negative_hits,
      '同一个 cookie 同时来 6 次、紧接着再来 1 次：只问来源一次（同时来的合并，刚认不出的留着），后来那次不再等',
      show({ asked: s1.asked - s0.asked, shared: s1.shared - s0.shared, negative: s1.negative_hits - s0.negative_hits, again: again.ms, burst: burst.map((r) => [r.status, r.ms]) }));
  }

  // ---------- 三、来源恢复：不用重启 ----------
  {
    rmSync(DOWN, { force: true });
    await sleep(3200); // 认不出的回答留 3 秒
    const back = await srv.call('GET', '/api/work-items', { session: SESSIONS.flaky });
    const viewer = await srv.call('GET', '/api/auth/viewer', { session: SESSIONS.flaky });
    check(back.status === 200 && viewer.status === 200 && viewer.json?.viewer?.login === 'alpha',
      '来源恢复之后，过了留存时间就认得出（不用重启）', show({ back: back.status, viewer: [viewer.status, viewer.json?.viewer?.login] }));
  }

  // ---------- 四、health 只给计数和耗时 ----------
  {
    const s = await stats();
    const keys = Object.keys(s ?? {}).sort();
    check(show(keys) === show(['asked', 'failed', 'last_failed_at', 'last_ms', 'negative_hits', 'shared', 'timeouts']) && !show(s).includes('fake-') && !show(s).includes('alpha'),
      'health 里的身份来源：只有计数、最近一次耗时和最近一次失败的时刻，不带凭据和人', show(s));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`identity-source-timeout-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
