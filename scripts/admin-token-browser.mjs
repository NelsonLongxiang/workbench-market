#!/usr/bin/env node
/** #292 M1（+M4 残余）浏览器反例（Python Playwright/Chromium，CI browser-security job）。
 *  M1 起：业务面无口令入口、控制面不跑不可信内容、两面互读不到；以下为 M4 时期的原始说明，登录弹窗部分仍适用：
 *  口令在本标签页时
 *  ① 使用页 /use/<id> 与驾驶舱都不出现 /go/ iframe，合成上游页读不到口令；
 *  ② 点「清除口令并内嵌」后 iframe 出现、存储为空；
 *  ③ 同一标签页跳到 /go/<id>/、/sop/<slug>/ 后，新文档的 sessionStorage 里没有口令；
 *  ④ 对照：没设口令时使用页照常内嵌；
 *  ⑤ 顶栏 ViewerChip 的 Odoo 登录弹窗（whoami 用 page.route 打桩成 401 + 同源 /go/ 探针页）：有口令时不发起、只给「清除口令并登录」；
 *     弹窗里 sessionStorage 没有口令、window.opener 为 null；登录成功（含弹窗先被关掉、之后 whoami 才变 200）照常收尾；
 *  ⑥ bfcache：后退若未命中往返缓存（persisted=false）记 SKIP，不当通过。
 *  需先 pnpm --filter web build（服务端托管 web/dist）。合成上游 + 全新 DATA_DIR + 随机回环端口；不碰真实口令。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const TMP = resolve('tmp/admin-token-browser-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
// 合成上游：页面把能读到的口令写进 window.__probe（同源 iframe 时可读 parent 与 sessionStorage）
const probe = '<!doctype html><title>token probe</title><script>window.__probe={own:sessionStorage.getItem("wm-admin-token")};try{window.__probe.parent=parent.sessionStorage.getItem("wm-admin-token")}catch(e){window.__probe.parent="blocked"}try{window.__probe.opener=window.opener?window.opener.sessionStorage.getItem("wm-admin-token"):"no-opener"}catch(e){window.__probe.opener="blocked"}</script>';
const upstream = createServer((rq, rs) => { rq.resume(); rs.writeHead(200, { 'content-type': 'text/html' }); rs.end(probe); });
await new Promise((x) => upstream.listen(0, '127.0.0.1', x));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN: 'synthetic-browser-admin' };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT']) delete env[k]; // 控制面用缺省 PORT+1
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': env.ADMIN_TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const wb = await api('POST', '/api/workbenches', { name: 'token-probe', url: `http://127.0.0.1:${upstream.address().port}/`, type: 'web' });
  const ck = await api('POST', '/api/cockpits', { name: 'probe-cockpit', panels: [{ i: 'p1', workbenchId: wb.id, x: 0, y: 0, w: 6, h: 6 }] });
  await api('POST', '/api/apps', { slug: 'token-sop', title: 'Token SOP', kind: 'sop', changelog: 'synthetic', files: [{ path: 'sop.yaml', content: JSON.stringify({ title: 'Token SOP', steps: [{ key: 'one', title: 'One', body: '<p>probe</p>' }] }) }] });
  await api('POST', '/api/sops/token-sop/publish', { changelog: 'synthetic' });
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, control: `http://127.0.0.1:${PORT + 1}`, wid: wb.id, cockpit: ck.id, sop: 'token-sop', token: env.ADMIN_TOKEN }));
  const py = spawn(process.env.PYTHON || 'python3', ['scripts/admin-token-browser.py', cfg], { stdio: 'inherit' });
  code = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill(); upstream.close();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
