#!/usr/bin/env node
/** P3 回执冒烟（network/a2a-receipt E1–E7 的本席自查版 · 独立实例）：
 *  派单 run 完成 → 回执投到绑定的 callback_url；自报 callback 被拒；人开 run 无回执；不可达留 pending；重复完成不重复投递。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { parseReceipt } from '@nelsonlongxiang/dsh-open-a2a-net/receipt';

const PORT = 9841;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-rcpt-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const json = async (url, method = 'GET', body, headers = {}) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
};

// 替身回调服务甲 / 乙
const gotA = [], gotB = [];
const mk = (sink) => createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { sink.push({ path: req.url, body: b }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
const srvA = mk(gotA), srvB = mk(gotB);
let srvC = null;
await new Promise((r) => srvA.listen(9842, '127.0.0.1', r));
await new Promise((r) => srvB.listen(9843, '127.0.0.1', r));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'rcpt-tok', A2A_OUTBOX_BACKOFF_SCALE: '0.001' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
const AT = { 'X-Admin-Token': 'rcpt-tok' };

try {
  // 建 SOP 台并上架
  await json(`${BASE}/api/apps`, 'POST', {
    slug: 'rv-rcpt', kind: 'sop', title: '回执冒烟流程',
    files: [{ path: 'sop.yaml', content: 'title: 回执冒烟流程\ncode: SOP-RCPT\nsteps:\n  - key: s1\n    title: 一步\n    body: "<p>x</p>"\n' }],
    changelog: '冒烟',
  });
  await json(`${BASE}/api/sops/rv-rcpt/publish`, 'POST', {}, AT);
  // 绑定先行（上卡规则：published ∧ ≥1 有效绑定）→ 再取卡片句柄
  let r = await json(`${BASE}/api/bindings`, 'POST', { target_type: 'sop', target_slug: 'rv-rcpt', agent_node: 'dsh/0123rcpt', mode: 'run', direction: 'admits', notify_url: `http://127.0.0.1:9842` }, AT);
  ok('绑定(带 callback_url) 201', r.status === 201, JSON.stringify(r.body));
  r = await json(`${BASE}/api/bindings`, 'POST', { target_type: 'sop', target_slug: 'rv-rcpt', agent_node: 'dsh/0123dead', mode: 'run', direction: 'admits', notify_url: `http://127.0.0.1:9849` }, AT);
  ok('绑定(死端口) 201', r.status === 201);
  const card = await json(`${BASE}/.well-known/agent-card.json`);
  const team = card.body?.sessionTeams?.find((t) => t.name === 'rv-rcpt')?.team;
  ok('SOP 上卡', !!team, JSON.stringify(card.body?.sessionTeams));

  const CAPS = {}; // #309 phase2：run 级读能力（创建响应即得）
  const RC = (id) => ({ 'X-Run-Read-Capability': CAPS[id] || '' });
  const dispatch = async (caller, taskId, ctxId, extra = {}) => json(`${BASE}/a2a/direct`, 'POST', {
    team, caller_session: caller, task_id: taskId, context_id: ctxId,
    message: JSON.stringify({ sop: { slug: 'rv-rcpt', action: 'start' } }), ...extra,
  });

  // E1/E2：派单 → 完成 → 回执到达甲且可被上游 parseReceipt 解析
  let d = await dispatch('dsh/0123rcpt', 'rv-c-1', 'rv-cctx-1');
  const runId = d.body?.sop?.run_id;
  CAPS[runId] = String(d.body?.sop?.read_capability ?? '');
  ok('派单开出 run', Number.isInteger(runId), JSON.stringify(d.body).slice(0, 160));
  await json(`${BASE}/api/sop/runs/${runId}/finish`, 'POST', {});
  await new Promise((r2) => setTimeout(r2, 1500));
  const hit = gotA.filter((x) => x.path === '/a2a/direct');
  ok('E1 回执到达甲一次', hit.length >= 1, `got=${hit.length}`);
  let parsed = null;
  try { parsed = hit.length ? parseReceipt(JSON.parse(hit[hit.length - 1].body).message) : null; } catch { }
  ok('E1 上游 parseReceipt 可解析', parsed?.taskId === 'rv-c-1' && parsed?.envelope?.outcome === 'completed', JSON.stringify(parsed));
  ok('E2 幂等键 run-<id>-finished', parsed?.envelope?.idempotencyKey === `run-${runId}-finished`, String(parsed?.envelope?.idempotencyKey));
  ok('E2 context_id 回流', hit.length > 0 && JSON.parse(hit[hit.length - 1].body).context_id === 'rv-cctx-1');
  r = await json(`${BASE}/api/sop/runs/${runId}`, 'GET', undefined, RC(runId));
  ok('E1 receipt=sent', r.body?.receipt === 'sent', String(r.body?.receipt));

  // E3：重复完成不重复投递
  const before = gotA.length;
  await json(`${BASE}/api/sop/runs/${runId}/finish`, 'POST', {});
  await new Promise((r2) => setTimeout(r2, 1200));
  ok('E3 重复完成不产生第二条回执', gotA.length === before, `${before} → ${gotA.length}`);

  // E4：人自己开的 run 不发回执
  r = await json(`${BASE}/api/sop/runs`, 'POST', { slug: 'rv-rcpt', started_by: 'human' });
  const humanRun = r.body?.id;
  CAPS[humanRun] = String(r.body?.read_capability ?? '');
  const beforeH = gotA.length + gotB.length;
  await json(`${BASE}/api/sop/runs/${humanRun}/finish`, 'POST', {});
  await new Promise((r2) => setTimeout(r2, 1200));
  const detail = await json(`${BASE}/api/sop/runs/${humanRun}`, 'GET', undefined, RC(humanRun));
  ok('E4 人开 run 无回执 + receipt=none', gotA.length + gotB.length === beforeH && detail.body?.receipt === 'none', `receipt=${detail.body?.receipt}`);

  // E5：自报 callback 与绑定不一致 → 不投递 + rejected
  const beforeB = gotB.length;
  d = await dispatch('dsh/0123rcpt', 'rv-c-5', 'rv-cctx-5', { callback: 'http://127.0.0.1:9843' });
  const run5 = d.body?.sop?.run_id;
  CAPS[run5] = String(d.body?.sop?.read_capability ?? '');
  await json(`${BASE}/api/sop/runs/${run5}/finish`, 'POST', {});
  await new Promise((r2) => setTimeout(r2, 1500));
  const d5 = await json(`${BASE}/api/sop/runs/${run5}`, 'GET', undefined, RC(run5));
  ok('E5 乙未收到 + receipt=rejected', gotB.length === beforeB && d5.body?.receipt === 'rejected:callback-mismatch', `receipt=${d5.body?.receipt} gotB=${gotB.length}`);

  // E6：回调不可达 → pending（首投失败即 pending；dead 转移见 E9）
  d = await dispatch('dsh/0123dead', 'rv-c-6', 'rv-cctx-6');
  const run6 = d.body?.sop?.run_id;
  CAPS[run6] = String(d.body?.sop?.read_capability ?? '');
  await json(`${BASE}/api/sop/runs/${run6}/finish`, 'POST', {});
  await new Promise((r2) => setTimeout(r2, 800));
  const d6 = await json(`${BASE}/api/sop/runs/${run6}`, 'GET', undefined, RC(run6));
  ok('E6 不可达回执留 pending', d6.body?.receipt === 'pending', String(d6.body?.receipt));

  // E8：重试到期补投（#50 修复自查）——丙替身前 2 次 503，之后 200
  let hitsC = 0;
  srvC = createServer((req, res) => {
    hitsC++;
    if (hitsC <= 2) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((r2) => srvC.listen(9844, '127.0.0.1', r2));
  r = await json(`${BASE}/api/bindings`, 'POST', { target_type: 'sop', target_slug: 'rv-rcpt', agent_node: 'dsh/0123rc8', mode: 'run', direction: 'admits', notify_url: `http://127.0.0.1:9844` }, AT);
  d = await dispatch('dsh/0123rc8', 'rv-c-8', 'rv-cctx-8');
  const run8 = d.body?.sop?.run_id;
  CAPS[run8] = String(d.body?.sop?.read_capability ?? '');
  await json(`${BASE}/api/sop/runs/${run8}/finish`, 'POST', {});
  await new Promise((r2) => setTimeout(r2, 30_000));
  const d8 = await json(`${BASE}/api/sop/runs/${run8}`, 'GET', undefined, RC(run8));
  ok('E8 重试补投 → sent（≥3 次 POST）', d8.body?.receipt === 'sent' && hitsC >= 3, `receipt=${d8.body?.receipt} hitsC=${hitsC}`);

  // E9：重试耗尽 → dead（scale 0.001 下退避毫秒级，5 次即 dead）
  await new Promise((r2) => setTimeout(r2, 25_000));
  const d9 = await json(`${BASE}/api/sop/runs/${run6}`, 'GET', undefined, RC(run6));
  ok('E9 耗尽转 dead', d9.body?.receipt === 'dead', String(d9.body?.receipt));

  // DB 校验：outbox 行数与幂等唯一
  const db = new DatabaseSync(`${DATA}/workbench-market.db`, { readOnly: true });
  const rows = db.prepare('SELECT run_id, status FROM a2a_outbox').all();
  ok('outbox 每 run 至多一行', new Set(rows.map((x) => x.run_id)).size === rows.length, JSON.stringify(rows));
} finally {
  child.kill(); srvA.close(); srvB.close(); srvC?.close();
  await new Promise((r) => setTimeout(r, 600));
}
console.log(`\n===== P3 回执冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
