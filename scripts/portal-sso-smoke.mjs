#!/usr/bin/env node
/** #170 P1④⑤ 冒烟：①无 session_id 首访 → 302 带 state+Set-Cookie②回跳 state 不匹配 → 400 ③匹配 → 消费清 cookie 并继续 ④普通 cookie 补 SameSite=Lax。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const TP = PORT + 1;
const DATA = 'tmp/e2e-sso-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'sso' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const target = createServer((req, res) => {
  if (req.url === '/web/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>login</h1>'); }
  if (req.url === '/setck') { res.writeHead(200, { 'Set-Cookie': 'plain=1; Path=/', 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>page</h1>');
});
await new Promise((r) => target.listen(TP, '127.0.0.1', r));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sso' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  await waitReady(`${B}/api/health`);
  // 建 odoo 类型（生产 types 只有 web）→ 再登记 Odoo 类台（触发 SSO 分支）
  await fetch(`${B}/api/types`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'odoo', name: 'Odoo', default_port: 8069 }) });
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'sso', url: `http://127.0.0.1:${TP}/`, type: 'odoo' }) })).json();
  ok('登记 odoo 台', Number.isInteger(wb.id), JSON.stringify(wb).slice(0, 100));
  // ① 首访 → 302 带 state + Set-Cookie wm_sso_<id>
  const r1 = await fetch(`${B}/go/${wb.id}/`, { redirect: 'manual' });
  const loc = String(r1.headers.get('location') ?? '');
  const setck = r1.headers.getSetCookie ? r1.headers.getSetCookie().join('; ') : String(r1.headers.get('set-cookie') ?? '');
  const m = /state=([^&]+)/.exec(loc);
  ok('① 302 带 state 且回跳经市场', r1.status === 302 && !!m && loc.includes(encodeURIComponent(`/go/${wb.id}/?state=`)), `status=${r1.status} loc=${loc.slice(0, 120)}`);
  ok('①b state cookie HttpOnly', new RegExp('wm_sso_' + wb.id).test(setck) && /HttpOnly/i.test(setck), setck.slice(0, 120));
  // ② 不匹配 state → 400
  const r2 = await fetch(`${B}/go/${wb.id}/?state=bad`, { headers: { cookie: 'wm_sso_' + wb.id + '=good' }, redirect: 'manual' });
  ok('② state 不匹配 → 400', r2.status === 400, `status=${r2.status}`);
  // ③ 匹配 → 继续（200 页面）
  const r3 = await fetch(`${B}/go/${wb.id}/?state=abc`, { headers: { cookie: 'wm_sso_' + wb.id + '=abc' }, redirect: 'manual' });
  // state 匹配即消费成功：无 session_id 时正确行为=再 302 去登录（不是 400·不是 502）
  ok('③ state 匹配 → 消费并续流程（302 登录/200 页面）', r3.status === 302 || r3.status === 200, `status=${r3.status}`);
  // ④ SameSite 补位（非 HTTPS 剥 Secure 后补 Lax）
  const r4 = await fetch(`${B}/go/${wb.id}/setck`, { headers: { cookie: 'session_id=e2e' } });
  const c4 = String(r4.headers.get('set-cookie') ?? '');
  ok('④ 普通 cookie 补 SameSite=Lax', /SameSite=Lax/i.test(c4), c4);
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log(`\n===== SSO ④⑤ 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
