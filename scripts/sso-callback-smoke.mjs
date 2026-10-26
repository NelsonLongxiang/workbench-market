#!/usr/bin/env node
/** SSO 回调路由冒烟（A+B·判据先红后绿）。
 *  A: market /sso/callback?redirect=/go/N/&state=xxx——Odoo 登录完统一入口
 *  B: dsh-odoo-sso /odoo/sso/handshake|redirect|logout 三路由
 *  判据（A）：①/sso/callback 无参→400 ②带 redirect+state→302 到目标台 ③非法 redirect（外域）→400（open-redirect 护栏）
 *  判据（B）：④/odoo/sso/handshake 在 contract 路由面声明（routes[] 含三路径）
 */
const { execSync } = await import('node:child_process');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

// A 面（对隔离实例测——红版无路由=404）
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
const PORT = 9863;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-ssocb-data';
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
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
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // ① 无参→400
  const r1 = await fetch(`${BASE}/sso/callback`, { redirect: 'manual' });
  ok('① /sso/callback 无参→400', r1.status === 400, `status=${r1.status}`);
  // ② 带 redirect+state→302 到目标台
  const r2 = await fetch(`${BASE}/sso/callback?redirect=/go/807/&state=abc`, { redirect: 'manual' });
  ok('② 带 redirect+state→302 目标台', r2.status === 302 && r2.headers.get('location') === '/go/807/', `status=${r2.status} loc=${r2.headers.get('location')}`);
  // ③ 外域 redirect→400
  const r3 = await fetch(`${BASE}/sso/callback?redirect=http://evil.example/x&state=abc`, { redirect: 'manual' });
  ok('③ 外域 redirect→400（open-redirect 护栏）', r3.status === 400, `status=${r3.status}`);
} finally { child.kill(); await new Promise((r) => setTimeout(r, 500)); }

// B 面（静态断言——contract routes 面含三路径）
const contract = (await import('node:fs')).readFileSync('../dsh-odoo-sso/src/contract.ts', 'utf8');
ok('④ contract 含 handshake/redirect/logout 三路径', contract.includes('handshake') && contract.includes('redirect') && contract.includes('logout'), '缺路径');
ok('⑤ 路径前缀 /piweb_sso/（活体对齐）', contract.includes('/piweb_sso/handshake'), '前缀未对齐');

console.log(`\n===== SSO 回调+插件路由冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
