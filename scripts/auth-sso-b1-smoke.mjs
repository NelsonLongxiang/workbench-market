#!/usr/bin/env node
/** #221 SSO v2 B1 判据 harness（先红）：A1 登录/A3 登出/A6 me/B1 未登 /go/ 302 /login /B3 登录页在产。
 *  红态=端点缺失（404/无 302）。落件后转绿。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-sso-b1-' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'b1' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
try {
  await waitReady(B + '/api/health');
  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  // A1 登录（自建账号·先注册后登录）
  const r0 = await post('/api/auth/register', { username: 'u1', password: 'pw-strong-1' });
  const r1 = await post('/api/auth/login', { username: 'u1', password: 'pw-strong-1' });
  const setc = r1.headers.get('set-cookie') ?? '';
  ok('A1 login → 200 + wm_session cookie', r1.status === 200 && /wm_session=/.test(setc), r1.status + '/' + setc.slice(0, 30));
  // A6 me
  const me = await fetch(B + '/api/auth/me', { headers: { Cookie: (setc.match(/wm_session=[^;]+/) ?? [''])[0] } });
  ok('A6 me → 200 {user}', me.status === 200, String(me.status));
  // B3 登录页
  const lp = await fetch(B + '/login');
  ok('B3 /login 页在产', lp.status === 200 && /text\/html/.test(lp.headers.get('content-type') ?? ''), String(lp.status));
  // B1 未登 /go/ → 302 /login（无 cookie）
  const g = await fetch(B + '/go/1/', { redirect: 'manual' });
  ok('B1 未登 /go/ → 302 → /login', g.status === 302 && String(g.headers.get('location') ?? '').includes('/login'), g.status + '→' + String(g.headers.get('location')).slice(0, 40));
  // A3 logout
  const lo = await post('/api/auth/logout', {});
  ok('A3 logout → 200', lo.status === 200, String(lo.status));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #221 B1 判据 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
