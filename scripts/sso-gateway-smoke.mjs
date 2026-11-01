#!/usr/bin/env node
/** SSO v1 门户免登冒烟（监督席技术审 direct-d2330efc·判据先红后绿）。
 *  设计：/go/:id/ 对 Odoo 类台（type=odoo）——①有 session_id Cookie 透传（白名单单键）②无→302 Odoo 登录+state。
 *  判据：①Odoo 台注册→/go/N/ 携 session_id=xxx→上游收到该 cookie（cap 收）✓
 *        ②无 cookie→302 Location 含 /web/login 且带 state ✓③非 Odoo 台不受影响（护栏）✓
 *        ④透传白名单：携带 session_id+其他 cookie→上游只收 session_id（评审注①）✓
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 9860;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-ssogw-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ssogw-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

// cap：模拟 Odoo 上游——记录收到的 Cookie 头并返回 200
const capHits = [];
const cap = createServer((req, res) => {
  capHits.push({ url: req.url, cookie: req.headers.cookie ?? '' });
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(Buffer.byteLength('<html><body>Odoo mock</body></html>')) });
  res.end('<html><body>Odoo mock</body></html>');
});
const CAP_PORT = await new Promise((r) => cap.listen(0, '127.0.0.1', () => r(cap.address().port)));

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
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ssogw-tok', WM_ODOO_ORIGINS: `http://127.0.0.1:${CAP_PORT}` }, stdio: 'ignore',
});

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // 注册 Odoo 类台
  const reg = await fetch(`${BASE}/api/workbenches`, {
    method: 'POST', headers: ADMIN,
    body: JSON.stringify({ name: 'E2E Odoo SSO 台', url: `http://127.0.0.1:${CAP_PORT}/odoo`, type: 'odoo' }),
  });
  const wb = await reg.json();
  ok('⓪ Odoo 台注册', reg.status === 201, `status=${reg.status}`);
  const wid = wb.id;

  // ① 无 Cookie → 302 Odoo 登录
  capHits.length = 0;
  const r1 = await fetch(`${BASE}/go/${wid}/`, { redirect: 'manual' });
  ok('① 无 sid→302 Odoo 登录', r1.status === 302 && (r1.headers.get('location') ?? '').includes('/web/login'), `status=${r1.status} loc=${r1.headers.get('location')?.slice(0, 60)}`);
  ok('①b 302 带 state（防 open-redirect）', /[?&]state=/.test(r1.headers.get('location') ?? ''), r1.headers.get('location') ?? '');

  // ② 有 session_id → 透传到上游
  capHits.length = 0;
  const r2 = await fetch(`${BASE}/go/${wid}/`, { headers: { Cookie: 'session_id=abc123def456; other_cookie=should_not_pass' } });
  ok('② 有 sid→透传 200', r2.status === 200, `status=${r2.status}`);
  await new Promise((r) => setTimeout(r, 500));
  ok('②b 上游收到 session_id', capHits.length > 0 && capHits[0].cookie.includes('session_id=abc123def456'), `cookie=${capHits[0]?.cookie?.slice(0, 60) ?? '(空)'}`);
  ok('②c 白名单单键（other_cookie 不透传·评审注①）', capHits.length > 0 && !capHits[0].cookie.includes('other_cookie'), `cookie=${capHits[0]?.cookie ?? ''}`);

  // ③ 护栏：非 Odoo 台不受影响（用已有 web 台）
  const r3 = await fetch(`${BASE}/api/workbenches`);
  const all = await r3.json();
  const webWb = (Array.isArray(all) ? all : []).find((w) => w.type === 'web' && w.enabled);
  if (webWb) {
    const r3g = await fetch(`${BASE}/go/${webWb.id}/`, { redirect: 'manual' });
    ok('③ 非 Odoo 台不受影响（不 302 Odoo）', r3g.status !== 302 || !(r3g.headers.get('location') ?? '').includes('/web/login'), `status=${r3g.status}`);
  } else { ok('③ 跳过（无 web 台）', true); }
} finally {
  child.kill(); cap.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== SSO 门户免登冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
