#!/usr/bin/env node
/**
 * 市场出站补 body 绑定签名（Sig3，上游 a2a-origin-claim/3）：对端宿主间要求 Sig2 与 Sig3 都带。
 * 裁判是上游新版 verifyOriginClaim（钉在含 Sig3 校验的 a2a-net 提交，env A2A_ORIGIN_V3_SRC）。
 *   · a2aSendOutbound（事件投递、答复、管理员手动发送都走它）发出的请求：带 Sig2 + Sig3，上游判 bodyBound
 *   · marketOriginClaim 带 body：同上
 *   · 回执 outbox（run 完成后的回执，postReceipt）：worker 真投出去的请求带 Sig2 + Sig3 与摘要头，上游判 bodyBound
 *   · 正文被改 → 上游拒（不降级到 Sig2）；不带 body 的请求（取卡等 GET）只带 Sig2，与之前相同
 */
import { spawn } from './owned-script-fixture.mjs';
import { spawn as rawSpawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = process.env.A2A_ORIGIN_V3_SRC ?? resolve('..', 'dsh-open-a2a-net-provenance', 'src', 'origin-claim.ts');
const { verifyOriginClaim } = await import(pathToFileURL(src).href);

const DATA = resolve('tmp/a2a-outbound-sig3');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const market = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', MARKET_PUBLIC_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'],
});
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }

// 对端：用上游新版 verifyOriginClaim 验每个请求（带原始字节）
const RP = await port();
const RECV = `http://127.0.0.1:${RP}`;
const seen = [];
const recv = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    if (req.url === '/.well-known/agent-card.json') { res.writeHead(404); return res.end(); }
    const verdict = await verifyOriginClaim(req, {
      cardCache: new Map(), audiences: [RECV], unboundOpen: false, onUnbound: () => {}, now: Date.now(), rawBody: raw, freshCard: true,
      fetch: (url, init) => fetch(url, init).then((x) => ({ ok: x.ok, status: x.status, text: () => x.text() })),
    });
    seen.push({ url: req.url, headers: req.headers, verdict });
    res.writeHead(200, { 'content-type': 'application/json' });
    let j = {}; try { j = JSON.parse(raw.toString('utf8')); } catch {}
    res.end(JSON.stringify({ routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: j.task_id, context_id: j.context_id }));
  });
});
await new Promise((r) => recv.listen(RP, '127.0.0.1', r));

// 子进程必须异步跑：本进程里的对端要同时应答（同步等会把自己卡死）
const child = (code) => new Promise((resolveP) => {
  const c = rawSpawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: 'server', env: { ...process.env, DATA_DIR: DATA, MARKET_PUBLIC_URL: BASE, NODE_ENV: 'test' } });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  const t = setTimeout(() => c.kill(), 30000);
  c.on('close', () => { clearTimeout(t); resolveP({ stdout, stderr }); });
});

try {
  if (!(await ready())) throw new Error('市场未就绪');
  // 一、a2aSendOutbound
  let r = await child(`const m = await import('./src/a2a.ts'); const out = await m.a2aSendOutbound(m.a2aKeyPath(), { baseUrl: ${JSON.stringify(RECV)}, team: 'lab/canvas/ops' }, 'hello', 'wb:task-center:1', 'market/12345678', { taskId: 'wbe-0000000000000001.d1.a1', async: true }); console.log(JSON.stringify(out));`);
  await sleep(100);
  const d1 = seen.find((s) => s.url === '/a2a/direct');
  ok('a2aSendOutbound：带 Sig2 与 Sig3、正文摘要头', !!d1 && typeof d1.headers['x-a2a-caller-sig2'] === 'string' && typeof d1.headers['x-a2a-caller-sig3'] === 'string' && typeof d1.headers['x-a2a-body-sha256'] === 'string', r.stderr.slice(-300));
  ok('……上游新版 verifyOriginClaim 验过，且判为 body 绑定', d1?.verdict?.ok === true && d1.verdict.bodyBound === true && d1.verdict.caller === 'market', JSON.stringify(d1?.verdict ?? null).slice(0, 200));

  // 二、marketOriginClaim 带 body（回执 outbox 那条路）
  seen.length = 0;
  r = await child(`const m = await import('./src/a2a.ts'); const url = ${JSON.stringify(RECV + '/a2a/direct')}; const body = JSON.stringify({ team: 'lab', message: 'receipt', task_id: 'receipt-1' });
    const h = m.marketOriginClaim(m.a2aKeyPath(), { url, method: 'POST', body });
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body });
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: body.replace('receipt', 'RECEIPT') });
    console.log('ok');`);
  await sleep(100);
  ok('marketOriginClaim 带 body → 上游判 body 绑定', seen[0]?.verdict?.ok === true && seen[0].verdict.bodyBound === true, JSON.stringify(seen[0]?.verdict ?? null).slice(0, 200) + r.stderr.slice(-200));
  ok('正文被改 → 上游拒（不降级到 Sig2）', seen[1]?.verdict?.ok === false, JSON.stringify(seen[1]?.verdict ?? null));

  // 二之二、回执 outbox 那一路（postReceipt）：放一行到期的回执，等 worker 真投出去
  seen.length = 0;
  { const d = new DatabaseSync(resolve(DATA, 'workbench-market.db'), { timeout: 5000 }); d.exec('PRAGMA busy_timeout = 5000');
    d.prepare("INSERT INTO a2a_outbox (run_id, task_id, context_id, target_url, payload, next_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-1 minute'))")
      .run(424242, 'direct-0123456789ab', 'wb:sig3:1', RECV, '[A2A receipt] task direct-0123456789ab\n{"outcome":"completed","idempotencyKey":"direct-0123456789ab","disposition":"result"}');
    d.close(); }
  { const end = Date.now() + 15000; while (Date.now() < end && !seen.some((x) => x.url === '/a2a/direct')) await sleep(200); }
  const rc = seen.find((x) => x.url === '/a2a/direct');
  ok('回执 outbox（postReceipt）：worker 投出的回执带 Sig2、Sig3 与摘要头', !!rc && typeof rc.headers['x-a2a-caller-sig2'] === 'string' && typeof rc.headers['x-a2a-caller-sig3'] === 'string' && typeof rc.headers['x-a2a-body-sha256'] === 'string', JSON.stringify(rc ? Object.keys(rc.headers) : null));
  ok('……上游新版 verifyOriginClaim 验过，且判为 body 绑定', rc?.verdict?.ok === true && rc.verdict.bodyBound === true && rc.verdict.caller === 'market', JSON.stringify(rc?.verdict ?? null).slice(0, 200));

  // 三、不带 body 的请求只带 Sig2（与之前相同）
  r = await child(`const m = await import('./src/a2a.ts'); console.log(JSON.stringify(m.marketOriginClaim(m.a2aKeyPath(), { url: ${JSON.stringify(RECV + '/x')}, method: 'GET' })));`);
  let h3 = {}; try { h3 = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  ok('不带 body → 只有 Sig2，没有 Sig3 与摘要头', typeof h3['X-A2A-Caller-Sig2'] === 'string' && !('X-A2A-Caller-Sig3' in h3) && !('X-A2A-Body-Sha256' in h3), JSON.stringify(Object.keys(h3)));
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  market.kill();
  recv.close();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
