#!/usr/bin/env node
/** 白屏三层+外链护栏冒烟（PR#128-#130 面·丢失补回后回归）。
 *  ①HTML 资产前缀 ②JS 内 /assets/ 前缀 ③Vite helper 改写 ④外链 airwallex 原样+内链仍改
 *  ⑤CSS 里的 /api/ 加前缀、跨源外链不动 ⑥HTML 里已是 /go/N/ 形的不再加前缀
 *  隔离：空的 DATA_DIR（tmp/ 下现建、跑完删），不读任何真实数据，直接 node 就能跑，接在 CI 里。
 */
import { spawn } from './owned-script-fixture.mjs';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const PORT = 10010;
mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'e2e-ws-'));
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ws-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const spa = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script src="/assets/e.js"></script><link rel="stylesheet" href="/assets/s.css"><a href="/go/987654/keep">k</a>'); }
  if (req.url === '/assets/s.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('.a{background:url(/api/v1/i.png)}.b{background:url(https://cdn.y.com/api/z.png)}'); }
  if (req.url === '/assets/e.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('const Qa=function(e){return"/"+e}; import(Qa("assets/x.js")); import("/assets/lit.js"); const pay="https://checkout.airwallex.com/assets/pay.js"; const inner="/assets/y.js";'); }
  res.writeHead(404); res.end('{}');
});
const SP = await new Promise((r) => spa.listen(0, '127.0.0.1', () => r(spa.address().port)));
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ws-tok' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  if (!(await waitReady(`${B}/api/health`))) throw new Error('市场实例没起来');
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ws', url: `http://127.0.0.1:${SP}/`, type: 'web' }) })).json();
  const id = wb.id;
  const html = await (await fetch(`${B}/go/${id}/`)).text();
  ok('① HTML 资产前缀', html.includes(`/go/${id}/assets/e.js`), html.slice(0, 80));
  const js = await (await fetch(`${B}/go/${id}/assets/e.js`)).text();
  ok('② JS 内字面 /assets/ 前缀（import("/assets/lit.js")→/go/<id>/）', js.includes(`/go/${id}/assets/lit.js`) && !/import\("\/assets\//.test(js), js.slice(0, 140));
  ok('③ Vite helper 改写', js.includes(`return "/go/${id}/"+`), js.slice(0, 100));
  ok('④ 外链原样（airwallex 无 /go/ 注入）', js.includes('https://checkout.airwallex.com/assets/pay.js') && !js.includes('airwallex.com/go/'), js.slice(0, 160));
  ok('④b 内链仍改（/assets/y.js 带 /go/）', js.includes(`/go/${id}/assets/y.js`), '');
  const css = await (await fetch(`${B}/go/${id}/assets/s.css`)).text();
  ok('⑤ CSS 内 /api/ 前缀', css.includes(`url(/go/${id}/api/v1/i.png)`), css);
  ok('⑤b CSS 内跨源外链不动', css.includes('url(https://cdn.y.com/api/z.png)'), css);
  ok('⑥ HTML 里已是 /go/N/ 形的不再加前缀', html.includes('href="/go/987654/keep"'), html.slice(0, 200));
} finally { child.kill(); await new Promise((r) => spa.close(r)); await new Promise((r) => setTimeout(r, 400)); rmSync(DATA, { recursive: true, force: true }); }
console.log(`\n===== 白屏三层+护栏冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
