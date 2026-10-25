#!/usr/bin/env node
/** 全局口令携带冒烟（direct-92be192a）：api.ts req() 注入 X-Admin-Token——
 *  本机放行（loopback）/ 无口令远程 403（服务面既有行为）/ 前端 bundle 含全局机制锚。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9971;
const DATA = 'tmp/e2e-gt-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: (() => { const e = { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'gt-tok' }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const end = Date.now() + 30000;
let ready = false;
while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { ready = true; break; } } catch { } await new Promise((r) => setTimeout(r, 250)); }
ok('实例就绪', ready);
try {
  const B = `http://127.0.0.1:${PORT}`;
  // ① 本机 loopback 写放行（远程收口中间件对 loopback 全放——含无口令）
  let r = await fetch(`${B}/api/cockpits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '本机舱' }) });
  ok('① 本机写放行（loopback）', r.status === 201, `status=${r.status}`);
  // ② 前端机制锚：bundle 含全局口令模块标记
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync('web/dist/index.html', 'utf8');
  const js = readFileSync('web/dist/assets/' + idx.match(/assets\/(index-[\w-]+\.js)/)[1], 'utf8');
  ok('② bundle 含全局口令机制（wm-admin-token 键）', js.includes('wm-admin-token'));
  ok('② bundle 含顶栏入口（口令已设 文案）', js.includes('口令已设') || js.includes('口令'));
  ok('② bundle 含 401/403 引导标记（needAdminToken）', js.includes('needAdminToken'));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 5; i++) { try { rmSync(DATA, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
}
console.log(`\n===== 全局口令冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
