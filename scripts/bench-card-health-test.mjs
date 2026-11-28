#!/usr/bin/env node
/** #1086 同源卡片不判离线：
 *   一、纯函数 ownUseRef：相对 /use/…、已知来源同源的 /use/… 认作市场自己的台页面；别的来源、别的路径不认。
 *   二、起隔离实例（NODE_ENV=test、合成身份）：地址是本站 /use/<台> 的卡片巡检后记「待对应」、不判离线；对应到台以后在线；去掉对应又回「待对应」；
 *       （相对地址 /use/… 登记时就被准入拒了——内部路径只收 /apps/、/sop/——所以实例里只造本站的绝对地址，相对地址只在纯函数里核）
 *       地址是别处的卡片照常探测（连不上就离线），没有被一并跳过；对应以后 /use/<卡片 id> 的入口就是这个台。
 *  隔离目录 tmp/bench-card-health-*，跑完清掉。数据都是合成的。 */
import { freePort } from './lib/free-port.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownUseRef, pendingLinkError, PENDING_LINK_PREFIX } from '../server/src/services/bench-card-health.ts';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

let ok = 0, fail = 0;
const check = (c, n, x = '') => { if (c) { ok++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, typeof x === 'string' ? x : JSON.stringify(x)); } };

console.log('一、认不认得市场自己的台页面');
const O = ['https://market.example.test', 'http://127.0.0.1:9800', null];
check(ownUseRef('/use/demo', O) === 'demo' && ownUseRef('/use/demo/reports', O) === 'demo' && ownUseRef(' /use/%E5%8F%B0?v=a#b ', O) === '台', '相对地址 /use/<台>（带子路径、查询、编码的都认，取台的引用）');
check(ownUseRef('https://market.example.test/use/demo', O) === 'demo' && ownUseRef('http://127.0.0.1:9800/use/demo', O) === 'demo', '和市场已知来源同源的 /use/<台>');
check(ownUseRef('https://other.example.test/use/demo', O) === null && ownUseRef('http://127.0.0.1:9801/use/demo', O) === null && ownUseRef('//market.example.test/use/demo', O) === null, '别的来源（含端口不同、协议相对地址）不认，照常探测');
check(ownUseRef('/apps/demo/', O) === null && ownUseRef('/use/', O) === null && ownUseRef('/usex/demo', O) === null && ownUseRef('', O) === null && ownUseRef(5, O) === null && ownUseRef('/use/%E0%A4%A', O) === null, '别的路径、空、坏编码不认');
check(pendingLinkError('demo').startsWith(PENDING_LINK_PREFIX) && pendingLinkError('demo').includes('「demo」') && pendingLinkError('demo').includes('对应到这张卡片'), '「待对应」的原因写明是哪个台、下一步做什么');

console.log('二、隔离实例');
const ROOT = resolve('.');
const TMP = resolve('tmp/bench-card-health-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), HOME: join(TMP, 'home'), ADMIN_TOKEN: 'synthetic-bench-card-health', REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(TMP, 'ext'), WM_BENCH_VIEWS: 'on' };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS', 'MARKET_PUBLIC_URL']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const call = async (method, path, { headers = {}, body, session } = {}) => {
  const h = { ...headers }; if (session) h.cookie = `session_id=${session}`; if (body !== undefined) h['content-type'] = 'application/json';
  try { const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ } return { status: r.status, text, json }; }
  catch (e) { return { status: 0, text: String(e?.name ?? e), json: null }; }
};
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const mgr = { headers: { origin: base, 'sec-fetch-site': 'same-origin' }, session: SESSIONS.alpha };
  await call('GET', '/api/auth/viewer', { session: SESSIONS.alpha });
  const seed = legacySeed(join(TMP, 'data', 'workbench-market.db')); seed.department('sales', 'sales');
  const g = await call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'management', scope: '*', reason: '合成：#1086' } });
  await call('POST', `/api/grants/${g.json?.grant?.id}/submit`); await call('POST', `/api/grants/${g.json?.grant?.id}/approve`);
  const reg = await call('POST', '/api/bench-views', { ...mgr, body: { slug: 'demo', title: '合成·演示台', department: 'sales' } });
  // 入口要有视图描述才开得出台（没有视图的台入口照样 404），照 bench-mcp-ui-browser 造一份最小的
  await call('PUT', '/api/bench-views/demo/datasets/visits', { ...mgr, body: { title: '巡检记录', key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'region', type: 'text', label: '区域' }] } });
  const view = await call('PUT', '/api/bench-views/demo/view', { ...mgr, body: { base: 0, note: '合成：首版', doc: { title: '合成·现场', views: [{ key: 'main', title: '总览', blocks: [{ type: 'table', title: '巡检', query: { dataset: 'visits' } }] }] } } });
  const card = async (name, url) => (await call('POST', '/api/workbenches', { body: { name, url, type: 'web' } }));
  const rel = await card('合成·相对地址卡', '/use/demo');
  check(rel.status === 400, '相对地址 /use/… 登记时被准入拒（所以实例里只看本站绝对地址）', [rel.status, rel.text.slice(0, 120)]);
  const abs = await card('合成·本站地址卡', `${base}/use/demo`), abs2 = await card('合成·本站地址卡二', `${base}/use/demo/reports`), far = await card('合成·别处的卡', 'http://127.0.0.1:9/');
  check(reg.status === 201 && view.status === 200 && abs.status === 201 && abs2.status === 201 && far.status === 201, '（准备）登记台 demo（带一份视图）、三张卡片（本站 /use/demo、本站 /use/demo/reports、别处）', { reg: reg.status, view: [view.status, view.text.slice(0, 160)], abs: abs.status, abs2: abs2.status, far: far.status });
  const probe = async (c) => (await call('POST', `/api/workbenches/${c.json?.id}/check`)).json ?? {};
  let a = await probe(abs2), b = await probe(abs), f = await probe(far);
  check(a.last_status === 'unknown' && String(a.last_error).startsWith(PENDING_LINK_PREFIX) && b.last_status === 'unknown' && String(b.last_error).startsWith(PENDING_LINK_PREFIX), '没对应的本站 /use/<台> 卡片：巡检记「待对应」（unknown），不判离线', { a: [a.last_status, a.last_error], b: [b.last_status, b.last_error] });
  check(f.last_status === 'down', '别处的卡片照常探测（连不上就离线），没被一并跳过', [f.last_status, f.last_error]);
  const link = await call('PUT', '/api/bench-views/demo/workbench', { ...mgr, body: { workbench_id: abs.json?.id } });
  b = await probe(abs); a = await probe(abs2);
  check(link.status === 200 && b.last_status === 'up' && b.last_error === '', '对应到台以后：这张卡片巡检是在线（按台的状态，不探测）', { link: link.status, b: [b.last_status, b.last_error] });
  check(a.last_status === 'unknown' && String(a.last_error).startsWith(PENDING_LINK_PREFIX), '台只对应一张卡片：另一张仍是「待对应」', [a.last_status]);
  const entry = await call('GET', `/api/bench-views/${abs.json?.id}/entry`, mgr);
  check(entry.status === 200 && entry.json?.bench?.slug === 'demo', '对应以后，/use/<卡片 id> 的入口就是这个台（从主页点卡片直接进数据视图页）', [entry.status, entry.json?.bench?.slug]);
  const unlink = await call('PUT', '/api/bench-views/demo/workbench', { ...mgr, body: { workbench_id: null } });
  b = await probe(abs);
  const entry2 = await call('GET', `/api/bench-views/${abs.json?.id}/entry`, mgr);
  check(unlink.status === 200 && b.last_status === 'unknown' && String(b.last_error).startsWith(PENDING_LINK_PREFIX) && entry2.status === 404, '去掉对应后恢复原样：又是「待对应」，卡片 id 的入口回 404', { unlink: unlink.status, b: b.last_status, entry: entry2.status });
  const noGrant = await call('PUT', '/api/bench-views/demo/workbench', { headers: { origin: base, 'sec-fetch-site': 'same-origin' }, session: SESSIONS.beta, body: { workbench_id: abs.json?.id } });
  check(noGrant.status === 403, '没有管理层授予的人：对应接口照旧拒绝', noGrant.status);
} catch (e) {
  fail++; console.error(String(e?.stack ?? e));
} finally {
  server.kill(); await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nbench-card-health-test: ${ok} 过 / ${fail} 败`); process.exit(fail ? 1 : 0);
