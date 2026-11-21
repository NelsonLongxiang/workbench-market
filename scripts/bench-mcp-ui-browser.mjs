#!/usr/bin/env node
/**
 * #904 台上的 MCP 申请：真实后端 → 浏览器 → 会话的闭环（起隔离实例，MCP 网关开着，业务面不 page.route）。
 *   准备：管理层 alpha、只有「取数、读视图」自定义角色的 beta；登记一个台、绑卡片、存视图；建一个 MCP 会话，经 MCP 的 access_request 提三条申请。
 *   浏览器（scripts/bench-mcp-ui-browser.py）：beta 看不到入口、直接打开说不能管；alpha 从 MCP 网关页「台上的申请」找到、从台页面进管理页，
 *   批准一条（留一句）、驳回一条（必须写理由）、一条在对话框开着时被别处先批了（409 照服务端说）。
 *   回到这里：由原申请会话验证工具——批了的调得了，驳回的照旧不行；申请状态和留痕照页面上办的记着。
 * 身份用合成的（identity-fake-provider）。隔离目录 tmp/bench-mcp-ui-*，跑完清掉。需先 pnpm --filter web build。
 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/bench-mcp-ui-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = 21000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-bench-mcp-ui-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0',
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
const tool = async (token, name, args) => {
  const r = await call('POST', '/mcp', { headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const res = r.json?.result, text = res?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 出错时是一句话 */ }
  return { rpcError: r.json?.error?.code ?? null, isError: res?.isError === true, json, text };
};
let ok = 0, fail = 0;
const check = (c, n, x = '') => { if (c) { ok++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, typeof x === 'string' ? x : JSON.stringify(x)); } };

let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const same = { origin: base, 'sec-fetch-site': 'same-origin' };
  const mgr = { headers: same, session: SESSIONS.alpha };
  const admin = { headers: { 'x-admin-token': ADMIN_TOKEN } };
  for (const s of [SESSIONS.alpha, SESSIONS.beta]) await call('GET', '/api/auth/viewer', { session: s });
  const seed = legacySeed(join(TMP, 'data', 'workbench-market.db'));
  seed.department('sales', 'sales'); // 部门已停写：台要绑一个停写前就有的部门，直接写库造
  const d = await call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'management', scope: '*', reason: '合成：#904' } });
  await call('POST', `/api/grants/${d.json?.grant?.id}/submit`); await call('POST', `/api/grants/${d.json?.grant?.id}/approve`);
  // beta：只点名「取数、读视图」的自定义角色——打得开台页面、管不了台上的 MCP（对照「看不到入口」要在打得开的页面上看）
  await call('POST', '/api/roles/guest/copy', { body: { id: 'ui-viewer', name: '合成·只看视图' } });
  await call('PUT', '/api/roles/ui-viewer', { body: { permissions: [{ actions: ['bench-store.render', 'bench-store.view-get'] }] } });
  await call('POST', '/api/roles/ui-viewer/approve');
  const gb = await call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'ui-viewer', scope: '*', reason: '合成：#904' } });
  await call('POST', `/api/grants/${gb.json?.grant?.id}/submit`); await call('POST', `/api/grants/${gb.json?.grant?.id}/approve`);
  const reg = await call('POST', '/api/bench-views', { ...mgr, body: { slug: 'field', title: '合成·现场台', department: 'sales' } });
  const wb = await call('POST', '/api/workbenches', { body: { name: '合成·现场台卡片', url: 'http://127.0.0.1:9/', type: 'web' } });
  const bind = await call('PUT', '/api/bench-views/field/workbench', { ...mgr, body: { workbench_id: wb.json?.id, note: '合成绑定' } });
  await call('PUT', '/api/bench-views/field/datasets/visits', { ...mgr, body: { title: '巡检记录', key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'region', type: 'text', label: '区域' }] } });
  await call('POST', '/api/bench-views/field/datasets/visits/rows?op=replace', { ...mgr, raw: JSON.stringify([{ id: 1, region: '东区' }]) });
  const view = await call('PUT', '/api/bench-views/field/view', { ...mgr, body: { base: 0, note: '合成：首版', doc: { title: '合成·现场', views: [{ key: 'main', title: '总览', blocks: [{ type: 'table', title: '巡检', query: { dataset: 'visits' } }] }] } } });
  const S = await call('POST', '/api/mcp/sessions', { ...admin, body: { name: 'sess-ui' } });
  const token = S.json?.token;
  const before = await tool(token, 'dataset_list', { bench: 'field' });
  const r1 = await tool(token, 'access_request', { tools: ['dataset_list@bench:field', 'dataset_append@bench:field'], reason: '合成：维护巡检记录' });
  const r2 = await tool(token, 'access_request', { tools: ['view_get@bench:field'], reason: '合成：要被驳回的' });
  const r3 = await tool(token, 'access_request', { tools: ['dataset_query@bench:field'], reason: '合成：别处先批了的' });
  const ids = [r1, r2, r3].map((r) => r.json?.request?.id);
  const betaEntry = await call('GET', `/api/bench-views/${wb.json?.id}/entry`, { headers: same, session: SESSIONS.beta });
  check(betaEntry.status === 200 && betaEntry.json?.can?.mcp === false && reg.status === 201 && wb.status === 201 && bind.status === 200 && view.status === 200 && typeof token === 'string' && before.rpcError === -32601 && ids.every((x) => Number.isInteger(x)),
    '（准备）台、卡片、视图、会话；只看视图的 beta 打得开台、管不了 MCP；会话没授予时调不到台上的工具；经 MCP 提了三条申请', { beta: [betaEntry.status, betaEntry.json?.can], reg: reg.status, wb: wb.status, bind: bind.status, view: [view.status, view.text.slice(0, 200)], before: before.rpcError, ids });
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, card: wb.json?.id, bench: 'field', ids, session_alpha: SESSIONS.alpha, session_beta: SESSIONS.beta }));
  const py = spawn(pythonBin(), ['scripts/bench-mcp-ui-browser.py', cfg], { stdio: 'inherit' });
  const pyCode = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });

  console.log('六、回到会话：页面上办的，会话这边照样生效');
  const after = { list: await tool(token, 'dataset_list', { bench: 'field' }), append: await tool(token, 'dataset_append', { bench: 'field', dataset: 'visits', rows: [{ id: 2, region: '西区' }], idempotency_key: 'ui-904-append-1' }), view: await tool(token, 'view_get', { bench: 'field' }), query: await tool(token, 'dataset_query', { bench: 'field', query: { dataset: 'visits' } }) };
  const info = await tool(token, 'access_info', {});
  const mine = (id) => info.json?.bench_requests?.find((x) => x.id === id);
  check(!after.list.isError && after.list.rpcError === null && Array.isArray(after.list.json?.datasets) && !after.append.isError && after.append.rpcError === null,
    '批准了的两个工具（一读一写）：原申请会话随即调得了', { list: after.list.text.slice(0, 80), append: after.append.text.slice(0, 80) });
  check(after.view.rpcError === -32601 && mine(ids[1])?.status === 'rejected' && mine(ids[1])?.note === '合成：这个会话不看页面',
    '驳回的那个：会话照旧调不到；会话看得到状态和页面上写的驳回理由', { view: after.view.rpcError, req: mine(ids[1]) });
  check(mine(ids[0])?.status === 'approved' && mine(ids[0])?.note === '合成：同意' && mine(ids[2])?.status === 'approved' && !after.query.isError,
    '批准的：会话看得到状态和留的那句；别处先批了的那条也是批准（页面那次 409 没有改动它）', { r1: mine(ids[0]), r3: mine(ids[2]) });
  const page = await call('GET', '/api/bench-views/field/mcp-grants', mgr);
  const acts = (page.json?.log ?? []).filter((x) => x.actor === 'user:alpha').map((x) => `${x.action}:${x.request_id}`).sort();
  check(JSON.stringify(acts) === JSON.stringify([`approve:${ids[0]}`, `approve:${ids[2]}`, `reject:${ids[1]}`].sort()), '留痕：两次批准、一次驳回，都记在 alpha 名下、带申请编号', acts);
  code = pyCode || fail ? 1 : 0;
  console.log(`\nbench-mcp-ui（会话这边）: ${ok} 过 / ${fail} 败`);
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
