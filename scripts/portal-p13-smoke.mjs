#!/usr/bin/env node
/** #170 P1②③ 冒烟：①非 HTTPS Secure 剥离 ②__Host- 保留 Path=/+Secure ③泛化根路径（"/static/x"→/go/<id>/static/x）④外部 URL/已带前缀不误改。
 *  隔离：空的 DATA_DIR（tmp/ 下现建、跑完删），不读任何真实数据，直接 node 就能跑，接在 CI 里。 */
import { spawn } from './owned-script-fixture.mjs';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 12000);
const TP = PORT + 1;
mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'e2e-p13-'));
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
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p13' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  if (!(await waitReady(`${B}/api/health`))) throw new Error('市场实例没起来');
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'p13', url: `http://127.0.0.1:${TP}/`, type: 'web' }) })).json();
  const lg = await fetch(`${B}/go/${wb.id}/login`, { redirect: 'manual' });
  const sc = lg.headers.getSetCookie ? lg.headers.getSetCookie() : [String(lg.headers.get('set-cookie') ?? '')];
  const sid = sc.find((c) => c.startsWith('sid=') && !c.startsWith('__'));
  const host = sc.find((c) => c.startsWith('__Host-'));
  ok('① 普通 cookie 非 HTTPS 剥 Secure', !!sid && !/;\s*secure/i.test(sid), sid);
  ok('①b 普通 cookie Path 改 /go/<id>/', !!sid && sid.includes(`Path=/go/${wb.id}/`), sid);
  ok('② __Host- 保留 Path=/+Secure', !!host && /;\s*path=\/(;|$)/i.test(host) && /;\s*secure/i.test(host), host);
  const js = await (await fetch(`${B}/go/${wb.id}/app.js`)).text();
  ok('③ 泛化根路径 /static → 前缀', js.includes(`/go/${wb.id}/static/x.json`), js.slice(0, 80));
  ok('③b /img 前缀', js.includes(`/go/${wb.id}/img/a.png`), '');
  ok('④ 外链不误改', js.includes('https://cdn.x.com/img/a.png'), '');
  ok('④b 已带前缀不二次改', js.includes('/go/1/already') && !js.includes(`/go/${wb.id}/go/1`), '');
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((x) => setTimeout(x, 400)); rmSync(DATA, { recursive: true, force: true }); }
console.log(`\n===== P1②③ 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
