#!/usr/bin/env node
/** #198 裁 A 冒烟：①页面注入 wm-app-token ②Origin:null+令牌 → ACAO null 且 data 200 ③无/错令牌不发 ACAO ④异台令牌不通过。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-198-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'k198' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
const B = 'http://127.0.0.1:' + PORT;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync('server/data/' + d, DATA + '/' + d, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'k198' }, stdio: 'ignore' });
try {
  await waitReady(B + '/api/health');
  for (const slug of ['a198', 'b198']) {
    await fetch(B + '/api/apps', { method: 'POST', headers: H, body: JSON.stringify({ slug, title: 't', files: [{ path: 'index.html', content: '<html><head><title>x</title></head><body>ok</body></html>' }] }) });
  }
  // ① 注入
  const html = await (await fetch(B + '/apps/a198/')).text();
  const m = /name="wm-app-token" content="([0-9a-f]{64})"/.exec(html);
  ok('① 页面注入 wm-app-token（64 hex）', !!m, html.slice(0, 80));
  const tokA = m?.[1] ?? '';
  // ② Origin null + 正确令牌 → ACAO null + data 200
  const r2 = await fetch(B + '/api/apps/a198/data', { headers: { Origin: 'null', 'X-App-Token': tokA } });
  ok('② Origin:null+令牌 → ACAO null', r2.headers.get('access-control-allow-origin') === 'null', String(r2.headers.get('access-control-allow-origin')));
  ok('②b data 读 200', r2.status === 200, String(r2.status));
  // ③ 无令牌 → 无 ACAO；错令牌 → 无 ACAO
  const r3 = await fetch(B + '/api/apps/a198/data', { headers: { Origin: 'null' } });
  const r3b = await fetch(B + '/api/apps/a198/data', { headers: { Origin: 'null', 'X-App-Token': 'f'.repeat(64) } });
  ok('③ 无/错令牌不发 ACAO', [r3, r3b].every((r) => r.headers.get('access-control-allow-origin') !== 'null'), [r3.headers.get('access-control-allow-origin'), r3b.headers.get('access-control-allow-origin')].join(','));
  // ④ 异台令牌（a 的令牌打 b）
  const r4 = await fetch(B + '/api/apps/b198/data', { headers: { Origin: 'null', 'X-App-Token': tokA } });
  ok('④ 异台令牌不通过（不可跨台复用）', r4.headers.get('access-control-allow-origin') !== 'null', String(r4.headers.get('access-control-allow-origin')));
  // ⑤ 预检 OPTIONS
  const r5 = await fetch(B + '/api/apps/a198/data', { method: 'OPTIONS', headers: { Origin: 'null', 'X-App-Token': tokA, 'Access-Control-Request-Method': 'POST' } });
  ok('⑤ 预检 OPTIONS 204 + ACAO null', r5.status === 204 && r5.headers.get('access-control-allow-origin') === 'null', r5.status + '|' + r5.headers.get('access-control-allow-origin'));
  // ⑥ 预检免令牌（规范形态：不带 X-App-Token 值）
  const r6 = await fetch(B + '/api/apps/a198/data', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-app-token' } });
  ok('⑥ 预检免令牌（不带 X-App-Token 也 204+ACAO）', r6.status === 204 && r6.headers.get('access-control-allow-origin') === 'null', r6.status + '|' + r6.headers.get('access-control-allow-origin'));
  // ⑦ 查询串形态（GET …/data?limit=1 带回 ACAO）
  const r7 = await fetch(B + '/api/apps/a198/data?limit=1', { headers: { Origin: 'null', 'X-App-Token': tokA } });
  ok('⑦ 查询串形态 GET 带 ACAO', r7.headers.get('access-control-allow-origin') === 'null', String(r7.headers.get('access-control-allow-origin')));
  // ⑧ 负对照：查询串 + 无令牌 → 无 ACAO
  const r8 = await fetch(B + '/api/apps/a198/data?limit=1', { headers: { Origin: 'null' } });
  ok('⑧ 查询串+无令牌 → 无 ACAO（负对照）', r8.headers.get('access-control-allow-origin') !== 'null', String(r8.headers.get('access-control-allow-origin')));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #198 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
