#!/usr/bin/env node
/**
 * 数据视图的台改按领域判（docs/domains-step1.md 第 1 步 PR3b）。隔离实例（NODE_ENV=test，WM_BENCH_VIEWS=on，假的登录提供方）。
 * 合成的人：alpha 管理层（登记、绑台）；beta 是 sales 的领域成员（area:sales）；strasse 是 sales 的领域负责人；no-flag 只有旧的部门范围授予（dept:ops、dept:legacy）。
 * 领域 sales、ops 是 active；部门 legacy 还没迁成领域。台：b-sales（绑 sales）、b-ops（绑 ops）、b-legacy（绑 legacy）。
 *
 *   E1 （#10 台的一半）持 area:sales 的人：sales 的台读写都行；ops、legacy 的台 403
 *   E2 （#12）只持 dept:ops 的人：领域 ops 在、没撤时，过渡期 dept:ops 等同 area:ops，ops 的台照旧进得去；
 *      但在领域 ops 上读不到（404）、定不了规范（403）——新的 area.* 一律不认 dept:
 *   E3 （统筹 11-20）领域 ops 撤了：dept:ops 的等同不再成立，ops 的台 403
 *   E4 部门 legacy 还没迁成领域：dept:legacy 照旧进得去（和今天一样）
 *   E5 绑台：绑到撤了的领域拒（409）；只有领域、没有同标识部门的也能绑；什么都没有的 404
 *
 *   node scripts/areas-scope-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `areas-scope-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const REMOTE = { 'x-forwarded-for': '192.0.2.71' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

let child = null;
rmSync(OUT, { recursive: true, force: true });
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_BENCH_VIEWS: 'on' });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
  const host = new URL(base).host;
  const call = async (method, path, { session, body } = {}) => {
    const h = session ? { ...REMOTE, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', cookie: `session_id=${session}` } : {};
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json, text };
  };
  const P = { boss: SESSIONS.alpha, beta: SESSIONS.beta, strasse: SESSIONS.strasse, nf: SESSIONS.noAdminFlag };
  for (const s of Object.values(P)) await call('GET', '/api/auth/viewer', { session: s });
  const issue = async (principal, role, scope) => {
    const d = await call('POST', '/api/grants', { body: { principal, role, scope, reason: '合成' } });
    const id = d.json?.grant?.id; await call('POST', `/api/grants/${id}/submit`); return (await call('POST', `/api/grants/${id}/approve`)).status;
  };
  // 部门（旧的）三个，领域两个（sales、ops，各放行一位负责人变 active）；legacy 不建领域
  for (const id of ['sales', 'ops', 'legacy']) await call('PUT', `/api/departments/${id}`, { body: { name: `合成${id}` } });
  for (const id of ['sales', 'ops']) await call('POST', '/api/areas', { body: { id, name: `合成${id}` } });
  const prep = [
    await issue('user:alpha', 'management', '*'),
    await issue('user:strasse', 'area-lead', 'area:sales'), await issue('user:strasse', 'area-lead', 'area:ops'),
    await issue('user:beta', 'area-member', 'area:sales'),
    await issue('user:no-flag', 'dept-member', 'dept:ops'), await issue('user:no-flag', 'dept-member', 'dept:legacy'),
  ];
  const benches = [];
  for (const [slug, department] of [['b-sales', 'sales'], ['b-ops', 'ops'], ['b-legacy', 'legacy']]) {
    benches.push((await call('POST', '/api/bench-views', { session: P.boss, body: { slug, title: slug, department } })).status);
    await call('PUT', `/api/bench-views/${slug}/datasets/d`, { session: P.boss, body: { columns: [{ name: 'a', type: 'text' }] } });
  }
  check(prep.every((s) => s === 200) && benches.every((s) => s === 201), '（准备）领域 sales、ops 有负责人；beta 持 area:sales；no-flag 持 dept:ops、dept:legacy；三个台各绑一个标识', { prep, benches });
  const reads = async (session, slug) => (await call('GET', `/api/bench-views/${slug}/datasets`, { session })).status;

  // ---- E1 ----
  {
    const s = {
      read: await reads(P.beta, 'b-sales'), write: (await call('PUT', '/api/bench-views/b-sales/datasets/mine', { session: P.beta, body: { columns: [{ name: 'a', type: 'text' }] } })).status,
      ops: await reads(P.beta, 'b-ops'), legacy: await reads(P.beta, 'b-legacy'),
      list: ((await call('GET', '/api/bench-views', { session: P.beta })).json?.benches ?? []).map((b) => b.slug).join(','),
    };
    check(s.read === 200 && s.write === 200 && s.ops === 403 && s.legacy === 403 && s.list === 'b-sales',
      'E1（#10）持 area:sales 的领域成员：sales 的台读写都行、清单里只有它；ops、legacy 的台 403', s);
  }

  // ---- E2 ----
  {
    const s = {
      ops: await reads(P.nf, 'b-ops'), area: (await call('GET', '/api/areas/ops', { session: P.nf })).status,
      spec: (await call('POST', '/api/areas/ops/specs', { session: P.nf, body: { body: '合成' } })).status, sales: await reads(P.nf, 'b-sales'),
    };
    check(s.ops === 200 && s.area === 404 && s.spec === 403 && s.sales === 403,
      'E2（#12）只持 dept:ops 的人：领域 ops 在时进得去 ops 的台（过渡期等同）；领域 ops 本身读不到（404）、定不了规范（403）；sales 的台 403', s);
  }

  // ---- E3 ----
  {
    const ret = await call('POST', '/api/areas/ops/retire', { body: { reason: '合成' } });
    const s = { retire: ret.status, ops: await reads(P.nf, 'b-ops'), legacy: await reads(P.nf, 'b-legacy') };
    check(s.retire === 200 && s.ops === 403 && s.legacy === 200, 'E3（统筹 11-20）领域 ops 撤了：dept:ops 的等同不成立，ops 的台 403；还没迁的 legacy 不受影响', s);
  }

  // ---- E4 ----
  {
    const s = { read: await reads(P.nf, 'b-legacy'), write: (await call('PUT', '/api/bench-views/b-legacy/datasets/nf', { session: P.nf, body: { columns: [{ name: 'a', type: 'text' }] } })).status };
    check(s.read === 200 && s.write === 200, 'E4 部门 legacy 还没迁成领域：只持 dept:legacy 的人照旧读写得了 legacy 的台（和今天一样）', s);
  }

  // ---- E5 ----
  {
    await call('POST', '/api/areas', { body: { id: 'only-area', name: '合成只有领域' } });
    const s = {
      retired: (await call('POST', '/api/bench-views', { session: P.boss, body: { slug: 'b-r', title: 'r', department: 'ops' } })).status,
      onlyArea: (await call('POST', '/api/bench-views', { session: P.boss, body: { slug: 'b-a', title: 'a', department: 'only-area' } })).status,
      none: (await call('POST', '/api/bench-views', { session: P.boss, body: { slug: 'b-n', title: 'n', department: 'nowhere' } })).status,
      rebind: (await call('PUT', '/api/bench-views/b-sales/binding', { session: P.boss, body: { department: 'ops' } })).status,
    };
    check(s.retired === 409 && s.onlyArea === 201 && s.none === 404 && s.rebind === 409,
      'E5 绑台：绑到撤了的领域拒（409，登记和改绑都是）；只有领域、没有同标识部门的能绑；部门、领域都没有的 404', s);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await sleep(500);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`areas-scope-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
