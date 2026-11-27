#!/usr/bin/env node
/** #1095 数据集列的显示格式和「只在行详情」（隔离实例、合成身份）：
 *   不合格的定义照中文说法拒收；合格的照存，取数应答里的列带上 format、detail_only；合计、平均、最小、最大沿用原列的格式，计数不沿用；只改格式也是改列，出新版本。
 *  隔离目录 tmp/bench-column-format-*，跑完清掉。数据都是合成的。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

let ok = 0, fail = 0;
const check = (c, n, x = '') => { if (c) { ok++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, typeof x === 'string' ? x : JSON.stringify(x)); } };
const ROOT = resolve('.');
const TMP = resolve('tmp/bench-column-format-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = 21000 + Math.floor(Math.random() * 12000);
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
  const g = await call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'management', scope: '*', reason: '合成：#1095' } });
  await call('POST', `/api/grants/${g.json?.grant?.id}/submit`); await call('POST', `/api/grants/${g.json?.grant?.id}/approve`);
  const reg = await call('POST', '/api/bench-views', { ...mgr, body: { slug: 'fmt', title: '合成·格式台', department: 'sales' } });
  check(reg.status === 201, '（准备）登记台 fmt', reg.status);
  const ID = { name: 'id', type: 'integer', label: '编号', auto: true };
  const define = (cols) => call('PUT', '/api/bench-views/fmt/datasets/sales', { ...mgr, body: { title: '合成销售', key: ['id'], columns: [ID, ...cols] } });
  console.log('一、不合格的定义照中文说法拒收');
  const bad = [
    [[{ name: 'region', type: 'text', format: { decimals: 2 } }], 'format 只用于整数列和小数列'],
    [[{ name: 'amount', type: 'decimal', format: { decimals: 9 } }], 'decimals'],
    [[{ name: 'amount', type: 'decimal', format: { percent: true, unit: '万' } }], '至多写一个'],
    [[{ name: 'amount', type: 'decimal', format: { digits: 2 } }], '不认识的键'],
    [[{ name: 'raw', type: 'text', detail_only: 'yes' }], 'detail_only'],
  ];
  for (const [cols, want] of bad) {
    const r = await define(cols);
    check(r.status === 400 && String(r.json?.message ?? r.json?.error ?? '').includes(want), `拒收并说「${want}」`, [r.status, r.json]);
  }
  console.log('二、合格的定义照存，取数应答里的列带上格式');
  const AMOUNT = { decimals: 2, unit: '万' }, RATE = { percent: true, decimals: 2 };
  const ok1 = await define([{ name: 'region', type: 'text', label: '区域' }, { name: 'amount', type: 'decimal', label: '金额', format: AMOUNT },
    { name: 'rate', type: 'decimal', label: '佣金比例', format: RATE }, { name: 'raw', type: 'text', label: '原始字符串', detail_only: true }]);
  check(ok1.status === 200, '带 format、detail_only 的定义收下', [ok1.status, ok1.json]);
  const rows = await call('POST', '/api/bench-views/fmt/datasets/sales/rows?op=append', { ...mgr, body: [{ region: '东区', amount: 7000, rate: 0.15, raw: '7000.000000001' }, { region: '西区', amount: 164000, rate: 0.2, raw: '164000' }] });
  const view = await call('PUT', '/api/bench-views/fmt/view', { ...mgr, body: { base: 0, note: '合成：#1095', doc: { title: '合成·格式', views: [{ key: 'main', title: '总览', blocks: [
    { type: 'stat', title: '合计金额', value: 'total', query: { dataset: 'sales', measures: [{ fn: 'sum', col: 'amount', as: 'total' }, { fn: 'count', as: 'n' }] } },
    { type: 'table', title: '明细', query: { dataset: 'sales' } }] }] } } });
  check(rows.status === 200 && view.status === 200, '（准备）两行数据、视图', [rows.status, rows.json, view.status, view.json]);
  const rr = await call('GET', '/api/bench-views/fmt/render?view=main', mgr);
  const blocks = rr.json?.blocks ?? [];
  const col = (b, n) => (b?.data?.columns ?? []).find((c) => c.name === n);
  const table = blocks.find((b) => b.type === 'table'), stat = blocks.find((b) => b.type === 'stat');
  const J = JSON.stringify;
  check(rr.status === 200 && (table?.data?.rows ?? []).length === 2 && J(col(table, 'amount')?.format) === J(AMOUNT) && J(col(table, 'rate')?.format) === J(RATE), '表格的列带上 format（金额按万两位、比例按百分比两位）', [rr.status, col(table, 'amount'), col(table, 'rate')]);
  check(col(table, 'raw')?.detail_only === true && col(table, 'amount')?.detail_only === undefined && col(table, 'region')?.format === undefined, 'detail_only 只在那一列；没配的列没有这两个键', [col(table, 'raw'), col(table, 'region')]);
  check(J(col(stat, 'total')?.format) === J(AMOUNT) && col(stat, 'n')?.format === undefined, '合计沿用原列的格式；计数不沿用', [col(stat, 'total'), col(stat, 'n')]);
  console.log('三、只改格式也是改列');
  const ok2 = await define([{ name: 'region', type: 'text', label: '区域' }, { name: 'amount', type: 'decimal', label: '金额', format: { decimals: 1, unit: '万' } },
    { name: 'rate', type: 'decimal', label: '佣金比例', format: RATE }, { name: 'raw', type: 'text', label: '原始字符串', detail_only: true }]);
  const rr2 = await call('GET', '/api/bench-views/fmt/render?view=main', mgr);
  const t2 = (rr2.json?.blocks ?? []).find((b) => b.type === 'table');
  check(ok2.status === 200 && ok2.json?.version > ok1.json?.version && J(col(t2, 'amount')?.format) === J({ decimals: 1, unit: '万' }), '改了金额的小数位：出新版本，取数应答跟着换', [ok1.json?.version, ok2.json?.version, col(t2, 'amount')]);
} catch (e) {
  fail++; console.error(String(e?.stack ?? e));
} finally {
  server.kill(); await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nbench-column-format-test: ${ok} 过 / ${fail} 败`); process.exit(fail ? 1 : 0);
