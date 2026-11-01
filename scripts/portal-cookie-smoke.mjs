#!/usr/bin/env node
/** 登录态保持冒烟（属主报障 Sub2API）：Set-Cookie 去 Domain+Path 改 /go/<id>/·cookie 回传透传。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 10036, TP = 10037;
const DATA = 'tmp/e2e-ck-' + Date.now().toString(36);
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ck' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const target = createServer((req, res) => {
  if (req.url === '/login') { res.writeHead(302, { 'Set-Cookie': 'sid=abc123; Domain=127.0.0.1; Path=/; HttpOnly', Location: '/' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('page:' + String(req.headers.cookie ?? ''));
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
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ck' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  await waitReady(`${B}/api/health`);
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ck', url: `http://127.0.0.1:${TP}/`, type: 'web' }) })).json();
  const lg = await fetch(`${B}/go/${wb.id}/login`, { redirect: 'manual' });
  const sc = String(lg.headers.get('set-cookie') ?? '');
  ok('① 去 Domain', !/domain=/i.test(sc), sc);
  ok(`② Path 改 /go/${wb.id}/`, sc.includes(`Path=/go/${wb.id}/`), sc);
  const r1 = await fetch(`${B}/go/${wb.id}/`, { headers: { cookie: 'sid=abc123' } });
  ok('③ 回传透传（登录态保持）', (await r1.text()).includes('sid=abc123'), '');
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== 登录态保持冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
