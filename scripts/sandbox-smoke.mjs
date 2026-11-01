#!/usr/bin/env node
/** SandboxService+sop_run_sandbox 判据冒烟（先红）——第十域/MCP 工具/layerfs:// URI 分流。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9991;
const DATA = 'tmp/e2e-sbx-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  PASS ' + n + ' ' + x); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: '../' + DATA, ADMIN_TOKEN: 'sbx-tok', SANDBOX_BRIDGE_URL: process.env.SANDBOX_BRIDGE_URL || 'http://127.0.0.1:9' }; delete e.REDIS_URL; return e; })(), // 隐私门红线：bridge 内网地址只经 env（unset 用不可达占位→三态错误面仍验）
  stdio: ['ignore', 'pipe', 'pipe'],
});
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health'); if (r.ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
ok('实例就绪', ready);
try {
  const B = 'http://127.0.0.1:' + PORT;
  const call = async (m, p, body, h = {}) => {
    const r = await fetch(B + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: body }) });
    return r.json();
  };
  // ① MCP 工具在场
  const tl = await call('tools/list', {});
  const names = (tl.result?.tools ?? []).map(t => t.name);
  ok('① sop_run_sandbox 工具在场', names.includes('sop_run_sandbox'), names.filter(n => n.includes('sandbox')).join(','));

  // ② 服务面符号（第十域）
  const { readFileSync } = await import('node:fs');
  let svcSrc = '';
  try { svcSrc = readFileSync('server/src/services/sandbox.ts', 'utf8'); } catch {}
  ok('② SandboxService 在场（services/sandbox.ts）', svcSrc.includes('dispatch'), svcSrc.length + 'B');
  const ctxSrc = readFileSync('server/src/context.ts', 'utf8');
  ok('② 容器注册 SandboxService', ctxSrc.includes('SandboxService'));

  // ③ layerfs:// URI 分流（上传一个 layerfs 引用→下载端分流）
  const pub = await fetch(B + '/api/skills/sbx%3Aprobe/versions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'sbx-tok' }, body: JSON.stringify({ files: [{ path: 'SKILL.md', content: 'x' }], changelog: 'v1', reviewed_by: 'dev' }) });
  ok('③ 种子技能 v1', pub.status === 201);
  // ③ run 建行：建真 SOP 再开 run
  // ③ run 建行：建真 SOP 再开 run
  const sopYaml = ['title: SBX','code: SBX','steps:','  - key: s1','    title: a','    body: "<p>x</p>"',''].join(String.fromCharCode(10));
  await fetch(B + '/api/apps', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'sbx-tok' }, body: JSON.stringify({ slug: 'sbx-sop', kind: 'sop', title: 'SBX', files: [{ path: 'sop.yaml', content: sopYaml }], changelog: 'v1' }) });
  await fetch(B + '/api/sops/sbx-sop/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'sbx-tok' }, body: '{}' });
  const run = await (await fetch(B + '/api/sop/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'sbx-sop', started_by: 'sbx' }) })).json();
  ok('③ run 建行', !!run.id, JSON.stringify(run).slice(0, 80));
  if (run.id) {
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(DATA + '/workbench-market.db');
    sdb.prepare("INSERT INTO sop_run_files (run_id, original_name, mime, size, storage_path, created_by) VALUES (?, 'sandbox-commit', 'application/x-layerfs-commit', 0, 'layerfs://abc123def456', 'sbx')").run(run.id);
    sdb.close();
    const fl = await (await fetch(B + '/api/sop/runs/' + run.id + '/files', { headers: { 'X-Run-Read-Capability': String(run.read_capability ?? '') } })).json();
    ok('③ layerfs URI 并存', (fl.items ?? []).some((f) => f.original_name === 'sandbox-commit'), JSON.stringify(fl).slice(0, 100));
  } else ok('③ layerfs URI 并存', false, 'run 未建');


} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
}
console.log('\n===== Sandbox 判据 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
