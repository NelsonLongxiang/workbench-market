#!/usr/bin/env node
/** #94 v3 S0 收尾批七件冒烟（监督席 direct-67b3d67f·K1-K9 复核红在案·判据先红后绿）。
 *  ①K1 摘要单一字节序（发布 digest == 导入器字节序——大小写分歧路径钉）
 *  ②K4 首版不要求 reviewed_by
 *  ③K6 同名重复路径拒收
 *  ④K7 跨技能撤销 → 404
 *  ⑤K8 钉装响应/版本列表不暴露绝对路径
 *  ⑥K9 不同技能同内容各自可发布
 *  ⑦导入器脚本目录锚定（静态断言）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9870;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-s0b-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 's0b-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
// 字节序摘要期望（与导入器同构：默认 sort+正斜杠归一）
const byteDigest = (files) => {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of sorted) { h.update(f.path.split('\\').join('/')); h.update('\0'); h.update(createHash('sha256').update(f.content, 'utf8').digest('hex')); h.update('\0'); }
  return h.digest('hex');
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
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's0b-tok' }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  const pubSkill = (slug, files, extra = {}) => fetch(`${BASE}/api/skills/${slug}/versions`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ files, changelog: 's0b', ...extra }) });

  // ① K1 字节序同构（Zebra/apple 大小写分歧）
  const FILES = [{ path: 'Zebra.txt', content: 'Z' }, { path: 'apple.txt', content: 'a' }, { path: 'docs/Nested.md', content: '# n' }];
  const r1 = await pubSkill('s0b:k1', FILES, { reviewed_by: 'x' });
  const j1 = await r1.json().catch(() => ({}));
  ok('① 发布 digest == 导入器字节序', j1.tree_digest === byteDigest(FILES), `${(j1.tree_digest ?? '').slice(0, 10)} vs ${byteDigest(FILES).slice(0, 10)}`);

  // ② K4 首版无 reviewed_by
  const r2 = await pubSkill('s0b:k4', [{ path: 'a.md', content: 'first' }]);
  ok('② 首版无 reviewed_by → 201', r2.status === 201, `status=${r2.status}`);

  // ③ K6 重复路径拒收
  const r3 = await pubSkill('s0b:k6', [{ path: 'a.md', content: 'x' }, { path: 'a.md', content: 'y' }], { reviewed_by: 'x' });
  ok('③ 同名重复路径 → 400', r3.status === 400, `status=${r3.status}`);

  // ⑥ K9 不同技能同内容（s0b:k9 与 s0b:k4 同内容）
  const r6 = await pubSkill('s0b:k9', [{ path: 'a.md', content: 'first' }], { reviewed_by: 'x' });
  ok('⑥ 不同技能同内容 → 201（digest 按 skill 域唯一）', r6.status === 201, `status=${r6.status}`);

  // 钉装 s0b:k1 为 ④⑤ 备
  const t1dir = mkdtempSync(join(tmpdir(), 's0b-inst-'));
  for (const f of FILES) { const abs = join(t1dir, f.path); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, f.content); }
  const inst = await (await fetch(`${BASE}/api/skills/s0b:k1/install`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ installed_path: t1dir }) })).json().catch(() => ({}));
  // ⑤ K8 钉装响应+版本列表不暴露绝对路径
  ok('⑤a 钉装响应无绝对路径', !/[A-Za-z]:[\\/]|\/tmp\/|\/home\//.test(String(inst.installed_path ?? '')), String(inst.installed_path ?? '').slice(0, 60));
  const vers = await (await fetch(`${BASE}/api/skills/s0b:k1/versions`)).json().catch(() => ({}));
  const sps = JSON.stringify(vers.versions ?? []);
  ok('⑤b 版本列表无绝对路径', !/[A-Za-z]:[\\/]|\/tmp\//.test(sps), sps.slice(0, 100));
  // MCP 面
  const mcp = async (id, name, args) => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    const raw = await res.text();
    const line = (raw.split('\n').find((l) => l.startsWith('data:')) ?? raw).replace(/^data:\s*/, '');
    try { return JSON.parse(line); } catch { return { raw: line.slice(0, 200) }; }
  };
  const mv = await mcp(1, 'skill_versions', { slug: 's0b:k1' });
  ok('⑤c MCP skill_versions 无绝对路径', !/[A-Za-z]:[\\/]|\/tmp\//.test(JSON.stringify(mv)), JSON.stringify(mv).slice(0, 120));

  // ④ K7 跨技能撤销 → 404（用 s0b:k4 的 slug 撤 k1 的 ledger）
  if (inst.ledger_id) {
    const r4 = await fetch(`${BASE}/api/skills/s0b:k4/install/${inst.ledger_id}/revoke`, { method: 'POST', headers: ADMIN });
    ok('④ 跨技能撤销 → 404', r4.status === 404, `status=${r4.status}`);
  } else { ok('④ 跨技能撤销 → 404', false, '无 ledger'); }

  // ⑦ 导入器脚本目录锚定（静态）
  const imp = readFileSync('scripts/skill-import.mjs', 'utf8');
  ok('⑦ 导入器 import.meta 锚定', /import\.meta\.url|fileURLToPath/.test(imp), '未见锚定');
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== S0 收尾批冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
