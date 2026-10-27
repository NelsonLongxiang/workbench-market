#!/usr/bin/env node
/** #94 S3 导出包与 agent 端校验冒烟（K14+K15·判据先红后绿）。
 *  ①导出面：GET /api/skills/:slug/export?version=N → 200·ustar 魔数·文件数符
 *  ②安装计划：MCP skill_install_plan 带 export_url+expected_digest
 *  ③上报面：POST report-digest 摘要同→match:true 记档；异→drift:true 记档（K14 漂移）
 *  ④未知版本 404
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9925;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-s3-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 's3-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const mcp = async (id, name, args) => {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await res.text();
  const line = (raw.split('\n').find((l) => l.startsWith('data:')) ?? raw).replace(/^data:\s*/, '');
  try { return JSON.parse(line); } catch { return { raw: line.slice(0, 200) }; }
};

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`);
  db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's3-tok' }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // 取真技能（快照带入）
  const skills = await (await fetch(`${BASE}/api/skills`)).json();
  const sk = (Array.isArray(skills) ? skills : []).find((s) => s.versions >= 1);
  const slug = sk?.slug ?? 'jf:taste';
  // ① 导出面
  const ex = await fetch(`${BASE}/api/skills/${encodeURIComponent(slug)}/export`);
  const buf = Buffer.from(await ex.arrayBuffer());
  ok('①a export 200', ex.status === 200, `status=${ex.status}`);
  ok('①b ustar 魔数（257 偏移）', buf.length > 262 && buf.slice(257, 262).toString() === 'ustar', buf.length > 262 ? buf.slice(257, 262).toString() : 'short');
  ok('①c 包非空（≥2 块）', buf.length >= 1024, `bytes=${buf.length}`);
  // ② 安装计划
  const plan = await mcp(1, 'skill_install_plan', { slug });
  const pt = String(plan?.result?.content?.[0]?.text ?? JSON.stringify(plan));
  ok('②a plan 带 export_url', /export_url/.test(pt), pt.slice(0, 80));
  ok('②b plan 带 expected digest', /expected_sha256|expected_digest/.test(pt));
  // ③ 上报面
  const vs = await (await fetch(`${BASE}/api/skills/${encodeURIComponent(slug)}/versions`)).json();
  const v1 = (vs.versions ?? [])[0];
  const repOk = await fetch(`${BASE}/api/skills/${encodeURIComponent(slug)}/report-digest`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ version: v1.version, digest: v1.tree_digest, reported_by: 's3-agent' }) });
  const repOkJ = await repOk.json().catch(() => ({}));
  ok('③a 摘要同→match:true 记档', repOk.status === 200 && repOkJ.match === true, JSON.stringify(repOkJ).slice(0, 80));
  const repBad = await fetch(`${BASE}/api/skills/${encodeURIComponent(slug)}/report-digest`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ version: v1.version, digest: 'deadbeef'.repeat(8), reported_by: 's3-agent' }) });
  const repBadJ = await repBad.json().catch(() => ({}));
  ok('③b 摘要异→drift:true 记档（K14 漂移）', repBad.status === 200 && repBadJ.match === false && repBadJ.drift === true, JSON.stringify(repBadJ).slice(0, 80));
  // ④ 未知版本
  const ex404 = await fetch(`${BASE}/api/skills/${encodeURIComponent(slug)}/export?version=99999`);
  ok('④ 未知版本 404', ex404.status === 404, `status=${ex404.status}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== S3 导出+校验冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
