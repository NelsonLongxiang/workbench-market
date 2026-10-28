#!/usr/bin/env node
/** R1 冒烟：①公网 8.8.8.8 默认拒 ②豁免模式可过+警告日志 ③内网/回环/无点主机放行。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-r1-' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
async function runWith(extraEnv) {
  rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'r1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const B = 'http://127.0.0.1:' + PORT;
  await waitReady(B + '/api/health');
  return { child, B };
}
try {
  let { child, B } = await runWith({});
  const reg = (url) => fetch(B + '/api/workbenches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'R1', url }) });
  const r1 = await reg('http://8.8.8.8:80/');
  ok('① 公网 8.8.8.8 默认拒', r1.status === 400, String(r1.status));
  const r2 = await reg('http://192.168.3.100:8080/');
  ok('② 内网放行', r2.status === 201, String(r2.status));
  const r3 = await reg('http://127.0.0.1:4000/');
  ok('③ 回环放行', r3.status === 201, String(r3.status));
  child.kill(); await new Promise((x) => setTimeout(x, 1800));
  ({ child, B } = await runWith({ ALLOW_PUBLIC_NET: '1' }));
  const r4 = await reg('http://8.8.8.8:80/');
  ok('④ 豁免模式公网可过', r4.status === 201, String(r4.status));
  child.kill(); await new Promise((x) => setTimeout(x, 400));
} finally {}
console.log('\n===== R1 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
