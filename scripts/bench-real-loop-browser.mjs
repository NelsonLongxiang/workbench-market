#!/usr/bin/env node
/**
 * #762 真实后端→浏览器闭环（起隔离实例，浏览器一路用真接口，业务面不 page.route）：
 *   建数据集 → 写合成行 → 存视图 → 浏览器打开 → 筛选 → 表单提交 → 查询确认落库 → 幂等重放 → 旧版本表单拒 →
 *   回退重读 → 解绑（撤权） → 跨台隔离。
 * 身份用合成的（identity-fake-provider，标注：合成身份，不冒充生产身份）。隔离目录 tmp/bench-real-loop-*，跑完清掉。
 * 需先 pnpm --filter web build。种子与核对全走正式 REST 入口（与 MCP 工具同一处理器；MCP 授予面另有 bench-mcp-test 覆盖）。
 */
import { freePort } from './lib/free-port.mjs';
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/bench-real-loop-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-bench-loop-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
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

let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const same = { origin: base, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: same, session });
  const admin = { headers: { 'x-admin-token': ADMIN_TOKEN } };
  for (const s of [SESSIONS.alpha, SESSIONS.beta]) await call('GET', '/api/auth/viewer', { session: s });
  // 部门已停写：两个部门和 beta 的 dept:sales 授予是停写前就有的，直接写库造（scripts/lib/legacy-dept-seed.mjs）
  const seed = legacySeed(join(TMP, 'data', 'workbench-market.db'));
  for (const id of ['sales', 'ops']) seed.department(id, id);
  const grantsGot = [];
  const activate = async (principal, role, scope) => { const d = await call('POST', '/api/grants', { body: { principal, role, scope, reason: '合成：真实闭环' } }); const id = d.json?.grant?.id; const s2 = await call('POST', `/api/grants/${id}/submit`); const a = await call('POST', `/api/grants/${id}/approve`); grantsGot.push(`${principal}:draft=${d.status},submit=${s2.status},approve=${a.status}`); };
  await activate('user:alpha', 'management', '*');
  seed.grant('user:beta', 'dept-member', 'dept:sales', { reason: '合成：真实闭环' });
  const mgr = who(SESSIONS.alpha);
  // 两个台：sales 的主台 + ops 的他台（跨台隔离用）；各绑一张卡片
  const binds = [];
  const mkBench = async (slug, title, department) => {
    const reg = await call('POST', '/api/bench-views', { ...mgr, body: { slug, title, department } });
    const wb = await call('POST', '/api/workbenches', { body: { name: `合成·${title}`, url: 'http://127.0.0.1:9/', type: 'web' } });
    const bind = await call('PUT', `/api/bench-views/${slug}/workbench`, { ...mgr, body: { workbench_id: wb.json?.id, note: '合成绑定' } });
    binds.push(`${slug}:reg=${reg.status},wb=${wb.status},bind=${bind.status}`);
    return wb.json?.id;
  };
  const card = await mkBench('field', '现场登记台', 'sales');
  const otherCard = await mkBench('other', '他部门台', 'ops');
  const B = '/api/bench-views/field';
  await call('PUT', `${B}/datasets/visits`, { ...mgr, body: { title: '巡检记录', key: ['id'], columns: [
    { name: 'id', type: 'integer', label: '编号' }, { name: 'day', type: 'text', label: '月份' }, { name: 'region', type: 'text', label: '区域' }, { name: 'amount', type: 'decimal', label: '金额' } ] } });
  const rows = [
    { id: 1, day: '2026-01-05', region: '东区', amount: 1200.5 },
    { id: 2, day: '2026-01-20', region: '南区', amount: 860 },
    { id: 3, day: '2026-02-02', region: '东区', amount: 15 },
    { id: 4, day: '2026-02-13', region: '西区', amount: 300 },
  ];
  await call('POST', `${B}/datasets/visits/rows?op=replace`, { ...mgr, raw: JSON.stringify(rows) });
  const doc = { title: '现场登记台', views: [
    { key: 'overview', title: '总览', blocks: [
      { type: 'filter-bar', fields: [{ name: 'month', kind: 'search', label: '月份' }, { name: 'region', kind: 'search', label: '区域' }] },
      { type: 'stat', title: '合计金额', query: { dataset: 'visits', filter: [{ col: 'day', op: 'prefix', value: '$month' }, { col: 'region', op: '=', value: '$region' }], measures: [{ fn: 'sum', col: 'amount', as: 'v', label: '金额' }] }, value: 'v', unit: '元' },
      { type: 'table', title: '记录', query: { dataset: 'visits', filter: [{ col: 'day', op: 'prefix', value: '$month' }, { col: 'region', op: '=', value: '$region' }], sort: [{ col: 'id' }] }, span: 12 },
    ] },
    { key: 'entry', title: '补录', blocks: [{ type: 'form', dataset: 'visits', fields: ['id', 'day', 'region', 'amount'], submit_label: '登记' }] },
  ] };
  const saved = await call('PUT', `${B}/view`, { ...mgr, body: { doc, base: 0, note: '首版' } });
  const be = await call('GET', `/api/bench-views/${card}/entry`, { session: SESSIONS.beta });
  const br = await call('GET', '/api/bench-views/field/render?view=overview', { session: SESSIONS.beta });
  if (saved.status !== 200 || saved.json?.version !== 1 || !Number.isInteger(card) || !Number.isInteger(otherCard) || be.status !== 200 || br.status !== 200)
    throw new Error(`种子没就位：view=${saved.status} card=${card} other=${otherCard} betaEntry=${be.status}/${be.text.slice(0, 120)} betaRender=${br.status}/${br.text.slice(0, 80)} grants=[${grantsGot.join('; ')}] binds=[${binds.join('; ')}]`);
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, card, other_card: otherCard, session_beta: SESSIONS.beta, session_alpha: SESSIONS.alpha }));
  const py = spawn(pythonBin(), ['scripts/bench-real-loop-browser.py', cfg], { stdio: 'inherit' });
  code = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
