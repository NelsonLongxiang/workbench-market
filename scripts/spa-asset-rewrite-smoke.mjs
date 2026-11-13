#!/usr/bin/env node
/** 驾驶舱白屏修冒烟（SPA 绝对路径资产改写·判据先红后绿·监督席 direct-9cd36827）。
 *  ①替身 SPA 台（HTML 引用 /assets/index-abc.js·资产路径真实存在）
 *  ②经 /go/<id>/ 取 HTML——资产引用带 /go/<id>/ 前缀（红版原样 /assets/）
 *  ③真取该资产 → 200 且 JS 内容一致（红版 404 JSON）
 *  ④外链/协议相对/data: 不误改（护栏）
 *  隔离：空的 DATA_DIR（tmp/ 下现建、跑完删），不读任何真实数据，直接 `node scripts/spa-asset-rewrite-smoke.mjs` 就能跑，接在 CI 里。
 */
import { spawn } from './owned-script-fixture.mjs';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const PORT = 9970;
mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'e2e-white-'));
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ws-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
// 替身 SPA 台
const SPA_HTML = '<!doctype html><html><head><script type="module" src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/style-def.css"><link href="//cdn.example.com/x.css" rel="stylesheet"><img src="data:image/png;base64,AAA"></head><body><div id="app"></div></body></html>';
const spa = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(SPA_HTML); }
  if (req.url === '/assets/index-abc.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('import("/assets/LoginView-chunk.js"); const u="/assets/vendor-x.css"; console.log("spa-loaded");\n//# sourceMappingURL=/assets/index-abc.js.map'); }
  if (req.url === '/assets/LoginView-chunk.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('export const login=true;'); }
  if (req.url === '/assets/vendor-x.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('.v{background:url(/assets/font-x.woff2)}'); }
  if (req.url === '/assets/style-def.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('body{}'); }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}');
});
const SP = await new Promise((r) => spa.listen(0, '127.0.0.1', () => r(spa.address().port)));
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ws-tok' }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`http://127.0.0.1:${PORT}/api/health`))) throw new Error('市场实例没起来');
  const reg = await fetch(`http://127.0.0.1:${PORT}/api/workbenches`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'SPA 台', url: `http://127.0.0.1:${SP}/`, type: 'web' }) });
  const wb = await reg.json();
  const id = wb.id;
  const html = await (await fetch(`http://127.0.0.1:${PORT}/go/${id}/`)).text();
  ok('② 资产引用带 /go/<id>/ 前缀', html.includes(`/go/${id}/assets/index-abc.js`) && html.includes(`/go/${id}/assets/style-def.css`), html.slice(0, 160));
  const js = await fetch(`http://127.0.0.1:${PORT}/go/${id}/assets/index-abc.js`);
  const jsText = await js.text();
  ok('③ 真取资产 200 且内容一致（非 404/非 fallback）', js.status === 200 && jsText.includes('spa-loaded'), `status=${js.status} body=${jsText.slice(0, 40)}`);
  const css = await fetch(`http://127.0.0.1:${PORT}/go/${id}/assets/style-def.css`);
  ok('③b CSS 同', css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'), `status=${css.status}`);
  ok('④ 外链/协议相对/data: 不误改', html.includes('href="//cdn.example.com/x.css"') && html.includes('src="data:image/png'), html.slice(0, 400));
  // 第二层（direct-aa94cbd4）：JS bundle 内 /assets/ 改写+chunk 真取 200
  const js2 = await (await fetch(`http://127.0.0.1:${PORT}/go/${id}/assets/index-abc.js`)).text();
  ok('⑤ JS 内 /assets/ 带 /go/ 前缀（动态 chunk）', js2.includes(`/go/${id}/assets/LoginView-chunk.js`) && !/import\("\/assets\//.test(js2), js2.slice(0, 120));
  ok('⑤b JS 内不在引号里的 /assets/ 也带前缀（sourceMappingURL）', js2.includes(`sourceMappingURL=/go/${id}/assets/index-abc.js.map`), js2.slice(-80));
  const chunk = await fetch(`http://127.0.0.1:${PORT}/go/${id}/assets/LoginView-chunk.js`);
  ok('⑥ 真取 LoginView chunk 200（非 404）', chunk.status === 200 && (await chunk.text()).includes('login'), `status=${chunk.status}`);
  const css2 = await (await fetch(`http://127.0.0.1:${PORT}/go/${id}/assets/vendor-x.css`)).text();
  ok('⑦ CSS 内 /assets/ 同带 /go/ 前缀', css2.includes(`url(/go/${id}/assets/font-x.woff2)`), css2.slice(0, 80));
} finally { child.kill(); await new Promise((r) => spa.close(r)); await new Promise((r) => setTimeout(r, 400)); rmSync(DATA, { recursive: true, force: true }); }
console.log(`\n===== 白屏修冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
