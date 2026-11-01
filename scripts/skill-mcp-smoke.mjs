#!/usr/bin/env node
/** P1-a MCP 工具面冒烟（判据先红）：skills_list/skill_versions/skill_install_plan 三工具——
 *  未注册时 tools/list 缺名（红）→实现后在场且调用返回种子/版本链/计划。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9951;
const DATA = 'tmp/e2e-p1a-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'p1a-tok' }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { ready = true; break; } } catch { } await new Promise((r) => setTimeout(r, 250)); }
ok('实例就绪', ready);
try {
  const B = `http://127.0.0.1:${PORT}`;
  const rpc = async (method, params) => {
    const r = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return r.json();
  };
  const tl = await rpc('tools/list', {});
  const names = (tl.result?.tools ?? []).map((t) => t.name);
  ok('tools_list 在场', names.includes('skills_list'));
  ok('skill_versions 工具在场', names.includes('skill_versions'));
  ok('skill_install_plan 工具在场', names.includes('skill_install_plan'));

  // 种子一投（用发布面造一条）→ 三工具行为
  const pub = await fetch(`${B}/api/skills/p1a%3Aprobe/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'p1a-tok' }, body: JSON.stringify({ files: [{ path: 'SKILL.md', content: '---\nname: p1a-probe\n---\nbody' }], changelog: 'p1a', reviewed_by: 'dev' }) });
  ok('种子发布（口令门空 token=本机放行）', pub.status === 201, `status=${pub.status}`);
  const sl = await rpc('tools/call', { name: 'skills_list', arguments: { layer: 5 } });
  const slText = sl.result?.content?.[0]?.text ?? '';
  ok('skills_list 返回含种子', slText.includes('p1a:probe'), slText.slice(0, 100));
  const sv = await rpc('tools/call', { name: 'skill_versions', arguments: { slug: 'p1a:probe' } });
  ok('skill_versions 版本链 v1', (sv.result?.content?.[0]?.text ?? '').includes('"version":1') || (sv.result?.content?.[0]?.text ?? '').includes('v1'));
  const ip = await rpc('tools/call', { name: 'skill_install_plan', arguments: { slug: 'p1a:probe' } });
  const ipText = ip.result?.content?.[0]?.text ?? '';
  ok('install_plan 含 expected digest 与命令形态', ipText.includes('sha256') || ipText.includes('digest'), ipText.slice(0, 120));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
}
console.log(`\n===== P1-a MCP 工具面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
