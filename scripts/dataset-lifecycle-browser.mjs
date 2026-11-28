#!/usr/bin/env node
/**
 * #1015 数据集退役与恢复页：真实后端 → 浏览器闭环（起隔离实例，业务面不 page.route）。
 *   准备：管理层 alpha（范围「全部」）、没有授予的 beta；一个台，两个数据集：old_orders（两行、没被引用）、used_orders（被现行视图引用）。
 *   浏览器（scripts/dataset-lifecycle-browser.py）：beta 打开只看到没权限的说法；alpha 看到两张表，退役 used_orders 被阻断并写清视图和块；
 *   退役 old_orders 要一字不差复述名字和理由；预检后视图被改（修订推进）时确认 409、要重新预检；恢复回到在用清单。
 *   回到这里：经接口核对数据一行不少、两次成功的生命周期动作。
 * 身份用合成的（identity-fake-provider）。隔离目录 tmp/dataset-lifecycle-ui-*，跑完清掉。需先 pnpm --filter web build。
 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/dataset-lifecycle-ui-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
// 端口向系统要空闲的，不随机挑（随机挑会撞上别的实例）
const PORT = await new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), HOME: join(TMP, 'home'), ADMIN_TOKEN: '{{SECRET_xs4rz1kr}}', REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(TMP, 'ext'), WM_BENCH_VIEWS: 'on' };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const call = async (method, path, { headers = {}, body, raw, session } = {}) => {
  const h = { ...headers };
  if (session) h.cookie = `session_id=${session}`;
  if (raw !== undefined || body !== undefined) h['content-type'] = 'application/json';
  try {
    const res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null }; }
};
let ok = 0, fail = 0;
const check = (c, n, x = '') => { if (c) { ok++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, typeof x === 'string' ? x : JSON.stringify(x)); } };

let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  if (server.exitCode !== null) throw new Error('server exited');
  const same = { origin: base, 'sec-fetch-site': 'same-origin' };
  const mgr = { headers: same, session: SESSIONS.alpha };
  for (const s of [SESSIONS.alpha, SESSIONS.beta]) await call('GET', '/api/auth/viewer', { session: s });
  const g = await call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'management', scope: '*', reason: '合成：#1015 页面' } });
  await call('POST', `/api/grants/${g.json?.grant?.id}/submit`); const ga = await call('POST', `/api/grants/${g.json?.grant?.id}/approve`);
  const reg = await call('POST', '/api/bench-views', { ...mgr, body: { slug: 'demo', title: '合成·示例台' } });
  const def = { title: '订单', key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'region', type: 'text', label: '地区' }] };
  const d1 = await call('PUT', '/api/bench-views/demo/datasets/old_orders', { ...mgr, body: { ...def, title: '旧订单' } });
  const d2 = await call('PUT', '/api/bench-views/demo/datasets/used_orders', { ...mgr, body: { ...def, title: '在用订单' } });
  const rows = await call('POST', '/api/bench-views/demo/datasets/old_orders/rows?op=append', { ...mgr, raw: JSON.stringify([{ id: 1, region: '东' }, { id: 2, region: '西' }]) });
  const view = await call('PUT', '/api/bench-views/demo/view', { ...mgr, body: { base: 0, note: '合成：引用 used_orders', doc: { title: '台', views: [{ key: 'v', title: '总览', blocks: [{ type: 'table', query: { dataset: 'used_orders', sort: [{ col: 'id' }] } }] }] } } });
  check(ga.status === 200 && reg.status === 201 && d1.status === 200 && d2.status === 200 && rows.status === 200 && view.status === 200,
    '（准备）alpha 管理层、台、两个数据集、两行数据、视图引用 used_orders', { ga: ga.status, reg: reg.status, d1: d1.status, d2: d2.status, rows: rows.status, view: view.status });
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, bench: 'demo', session_alpha: SESSIONS.alpha, session_beta: SESSIONS.beta, shots: process.env.DATASET_SHOTS ?? '' }));
  const py = spawn(pythonBin(), ['scripts/dataset-lifecycle-browser.py', cfg], { stdio: 'inherit' });
  const pyCode = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });

  console.log('回到接口：页面上办的照样生效');
  const list = await call('GET', '/api/bench-views/demo/datasets', mgr);
  const retired = await call('GET', '/api/bench-views/demo/retired-datasets', mgr);
  const q = await call('POST', '/api/bench-views/demo/query', { ...mgr, body: { query: { dataset: 'old_orders', sort: [{ col: 'id' }] } } });
  check(list.json?.datasets?.some((x) => x.name === 'old_orders') && Array.isArray(retired.json?.datasets) && retired.json.datasets.length === 0,
    'old_orders 经页面退役又恢复：回到在用清单，已退役清单为空', { list: list.text.slice(0, 160), retired: retired.text.slice(0, 160) });
  check(q.status === 200 && q.text.includes('东') && q.text.includes('西'), '恢复后数据一行不少', q.text.slice(0, 200));
  const again = await call('POST', '/api/bench-views/demo/datasets/used_orders/retire/precheck', mgr);
  check(again.json?.blockers?.some((b) => b.kind === 'view') && list.json?.datasets?.some((x) => x.name === 'used_orders'), 'used_orders 被阻断后没有动', again.text.slice(0, 160));
  code = pyCode || fail ? 1 : 0;
  console.log(`\ndataset-lifecycle-ui（接口这边）: ${ok} 过 / ${fail} 败`);
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
