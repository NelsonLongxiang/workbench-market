#!/usr/bin/env node
/** 门户日志不泄露上游会话（运维席 direct-cb457b75 复现的问题，合成实例与替身上游）：
 *  门户 /go/<id>/ 上游下发 Set-Cookie（含 session_id），进程 stdout/stderr 里不出现 cookie 值，只记 cookie 名；查询串也不进日志。
 *  对抗（direct-d9c28a29 / direct-871e4312 / direct-237dbde1）：路径里藏 %3F / %253F 编码的查询串不进日志。
 *  原来的第二部分（Odoo 同域登录中继 /web/login 的嵌入安全头）随中继一起下线（2026-11-17），见 log-secret-relay-headers-smoke 的历史。 */
import { freePort } from './lib/free-port.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = resolve('tmp/log-secret-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });

const PORTAL_SECRET = 'portalSidSECRETvalue000000000000001';
const OTHER_SECRET = 'otherCookieSECRETvalue000000000002';
const QUERY_SECRET = 'querySECRETstate00000000000000004';
const ENC_SECRET = 'encodedSECRETmarker0000000000000005';
const DBL_SECRET = 'doubleSECRETmarker00000000000000006';

const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
globalThis.__MARKET = base;
const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'log-secret-admin', REDIS_URL: '', LAYERFS_SERVICE_URL: '', WM_LOGIN_GATE: 'off' };
for (const k of ['WM_EXTENSIONS_DIR']) delete env[k];

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let logs = ''; server.stdout.on('data', (c) => (logs += c)); server.stderr.on('data', (c) => (logs += c));
/** 等条件成立，带上限（不是固定睡几毫秒）；返回成没成立 */
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(50); return cond(); };
/** 等服务端日志静下来：连续 quiet 毫秒没有新内容（上限 ms）。「秘密不在日志里」要在日志写完之后判，否则负载下会假通过。
 *  到了上限日志还没静下来，返回 false；调用方用 quiet() 把它记成这一步失败，不照常往下判「不在日志里」 */
const settle = async (quietMs = 300, ms = 5000) => { const end = Date.now() + ms; let last = logs.length, t = Date.now(); while (Date.now() < end) { await sleep(50); if (logs.length !== last) { last = logs.length; t = Date.now(); } else if (Date.now() - t >= quietMs) return true; } return false; };
/** 等日志静下来，没静下来就判这一步失败（写明原因）；返回静没静下来，调用方据此跳过「不在日志里」的判断 */
const quiet = async (what) => { const q = await settle(); if (!q) ok(`${what}：服务端日志 5 秒内一直没静下来，不能判「秘密不在日志里」`, false, `日志 ${logs.length} 字`); return q; };

try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready ' + logs.slice(-300)); await sleep(200); }

  // 门户：外部台——上游 Set-Cookie 只该以 cookie 名出现在日志里
  const other = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [`session_id=${PORTAL_SECRET}; Path=/`, `tracker=${OTHER_SECRET}; Path=/`] }); res.end('<p>other upstream</p>'); }); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const reg = await (await fetch(base + '/api/workbenches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'synthetic portal target', url: `http://127.0.0.1:${other.address().port}/`, type: 'web' }) })).json();
  ok('合成外部台已登记', Number.isInteger(reg.id), JSON.stringify(reg));
  const go = await fetch(`${base}/go/${reg.id}/?state=${QUERY_SECRET}`, { redirect: 'manual' });
  await go.text(); await waitFor(() => /\[proxres-entry\][^\n]*sc: /.test(logs), 5000); const q1 = await quiet('门户请求之后');
  ok('门户请求经过代理', go.status === 200, String(go.status));
  ok('proxres-entry 日志只记 cookie 名', /\[proxres-entry\][^\n]*sc: [^\n]*session_id/.test(logs) && /\[proxres-entry\][^\n]*tracker/.test(logs), logs.split('\n').filter((l) => l.includes('proxres-entry')).join(' / ').slice(0, 200));
  ok('上游 session_id 的值不进日志', q1 && !logs.includes(PORTAL_SECRET));
  ok('其它上游 cookie 的值不进日志', q1 && !logs.includes(OTHER_SECRET));
  for (const [label, path] of [['%3F', `/go/${reg.id}/safe%3F${ENC_SECRET}`], ['%253F', `/go/${reg.id}/safe%253F${DBL_SECRET}`]]) {
    const x = await fetch(base + path, { redirect: 'manual' }); await x.text();
  }
  const q2 = await quiet('带编码查询串的请求之后');
  ok('路径里 %3F 编码的查询串不进日志', q2 && !logs.includes(ENC_SECRET), logs.split('\n').filter((l) => l.includes(ENC_SECRET)).join(' / ').replaceAll(ENC_SECRET, '<E>').slice(0, 300));
  ok('路径里 %253F 双重编码的查询串不进日志', q2 && !logs.includes(DBL_SECRET), logs.split('\n').filter((l) => l.includes(DBL_SECRET)).join(' / ').replaceAll(DBL_SECRET, '<D>').slice(0, 300));
  ok('查询串不进日志', q2 && !logs.includes(QUERY_SECRET), logs.split('\n').filter((l) => l.includes(QUERY_SECRET)).join(' / ').replaceAll(QUERY_SECRET, '<Q>').slice(0, 300));
  other.close();

} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  server.kill(); await sleep(300); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nportal-log-secret-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
