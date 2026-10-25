#!/usr/bin/env node
/** 驾驶舱改名冒烟（direct-3b98f8c2 用户报障件）：后端 PUT name 已在——本件验前端构建产物含改名入口 + API 链端到端。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9931;
const DATA = 'tmp/e2e-rename-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'rn' }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { ready = true; break; } } catch { } await new Promise((r) => setTimeout(r, 250)); }
ok('实例就绪', ready);
try {
  const B = `http://127.0.0.1:${PORT}`;
  const j = async (u, m = 'GET', b, h = {}) => (await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined })).json();
  // API 链（监督席已验后端——本席复核 + 改名后列表刷新语义）
  const c = await j('/api/cockpits', 'POST', { name: '驾驶舱原名' }, { 'X-Admin-Token': 'rn' });
  ok('建舱', !!c.id);
  await j(`/api/cockpits/${c.id}`, 'PUT', { name: '驾驶舱新名' }, { 'X-Admin-Token': 'rn' });
  const list = await j('/api/cockpits');
  ok('PUT name 生效（列表见新名）', list.some((x) => x.id === c.id && x.name === '驾驶舱新名'));
  // 前端构建产物含改名入口
  const { readFileSync } = await import('node:fs');
  const bundle = readFileSync('web/dist/assets/' + readFileSync('web/dist/index.html', 'utf8').match(/assets\/(index-[\w-]+\.js)/)[1], 'utf8');
  ok('bundle 含改名按钮文案', bundle.includes('改名'));
  ok('bundle 含重命名成功反馈', bundle.includes('已重命名'));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
}
console.log(`\n===== 驾驶舱改名冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
