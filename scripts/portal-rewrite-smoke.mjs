#!/usr/bin/env node
/** 白屏三层+外链护栏冒烟（PR#128-#130 面·丢失补回后回归）。
 *  ①HTML 资产前缀 ②JS 内 /assets/ 前缀 ③Vite helper 改写 ④外链 airwallex 原样+内链仍改
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 10010;
const DATA = 'tmp/e2e-ws-' + Date.now().toString(36);
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ws-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const spa = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script src="/assets/e.js"></script>'); }
  if (req.url === '/assets/e.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('const Qa=function(e){return"/"+e}; import(Qa("assets/x.js")); import("/assets/lit.js"); const pay="https://checkout.airwallex.com/assets/pay.js"; const inner="/assets/y.js";'); }
  res.writeHead(404); res.end('{}');
});
const SP = await new Promise((r) => spa.listen(0, '127.0.0.1', () => r(spa.address().port)));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ws-tok' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  await waitReady(`${B}/api/health`);
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'ws', url: `http://127.0.0.1:${SP}/`, type: 'web' }) })).json();
  const id = wb.id;
  const html = await (await fetch(`${B}/go/${id}/`)).text();
  ok('① HTML 资产前缀', html.includes(`/go/${id}/assets/e.js`), html.slice(0, 80));
  const js = await (await fetch(`${B}/go/${id}/assets/e.js`)).text();
  ok('② JS 内字面 /assets/ 前缀（import("/assets/lit.js")→/go/<id>/）', js.includes(`/go/${id}/assets/lit.js`) && !/import\("\/assets\//.test(js), js.slice(0, 140));
  ok('③ Vite helper 改写', js.includes(`return "/go/${id}/"+`), js.slice(0, 100));
  ok('④ 外链原样（airwallex 无 /go/ 注入）', js.includes('https://checkout.airwallex.com/assets/pay.js') && !js.includes('airwallex.com/go/'), js.slice(0, 160));
  ok('④b 内链仍改（/assets/y.js 带 /go/）', js.includes(`/go/${id}/assets/y.js`), '');
} finally { child.kill(); await new Promise((r) => spa.close(r)); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== 白屏三层+护栏冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
