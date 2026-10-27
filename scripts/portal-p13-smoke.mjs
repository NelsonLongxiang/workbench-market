#!/usr/bin/env node
/** #170 P1②③ 冒烟：①非 HTTPS Secure 剥离 ②__Host- 保留 Path=/+Secure ③泛化根路径（"/static/x"→/go/<id>/static/x）④外部 URL/已带前缀不误改。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const TP = PORT + 1;
const DATA = 'tmp/e2e-p13-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'p13' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const target = createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(302, {
      'Set-Cookie': ['sid=abc; Path=/; Secure; HttpOnly', '__Host-sid=h1; Path=/; Secure', '__Secure-k=v2; Path=/; Secure'],
      Location: '/',
    });
    return res.end();
  }
  if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('fetch("/static/x.json"); const u="/img/a.png"; const e="https://cdn.x.com/img/a.png"; const g="/go/1/already";'); }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>ok</h1>');
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
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p13' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  await waitReady(`${B}/api/health`);
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'p13', url: `http://127.0.0.1:${TP}/`, type: 'web' }) })).json();
  const lg = await fetch(`${B}/go/${wb.id}/login`, { redirect: 'manual' });
  const sc = lg.headers.getSetCookie ? lg.headers.getSetCookie() : [String(lg.headers.get('set-cookie') ?? '')];
  const sid = sc.find((c) => c.startsWith('sid=') && !c.startsWith('__'));
  const host = sc.find((c) => c.startsWith('__Host-'));
  ok('① 普通 cookie 非 HTTPS 剥 Secure', !!sid && !/;\s*secure/i.test(sid), sid);
  ok('①b 普通 cookie Path 改 /go/<id>/', !!sid && sid.includes(`Path=/go/${wb.id}/`), sid);
  ok('② __Host- 保留 Path=/+Secure', !!host && /path=\//i.test(host) && /;\s*secure/i.test(host), host);
  const js = await (await fetch(`${B}/go/${wb.id}/app.js`)).text();
  ok('③ 泛化根路径 /static → 前缀', js.includes(`/go/${wb.id}/static/x.json`), js.slice(0, 80));
  ok('③b /img 前缀', js.includes(`/go/${wb.id}/img/a.png`), '');
  ok('④ 外链不误改', js.includes('https://cdn.x.com/img/a.png'), '');
  ok('④b 已带前缀不二次改', js.includes('/go/1/already') && !js.includes(`/go/${wb.id}/go/1`), '');
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log(`\n===== P1②③ 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
