#!/usr/bin/env node
// OriginClaim 绑定形式（v2）冒烟：市场出站信封在「不绑定窗已关」的对端也能过验。
// 裁判是上游 dsh-open-a2a-net 的 verifyOriginClaim（A2A_ORIGIN_SRC 指 src/origin-claim.ts），
// 窗口按关窗后的状态跑（unboundOpen:false）——#64 关窗那天对端就是这么判的。
// 隔离 DATA_DIR、本机回环，不碰任何生产主机。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const originSrc = process.env.A2A_ORIGIN_SRC ?? resolve('..', 'dsh-open-a2a-net', 'src', 'origin-claim.ts');
const { verifyOriginClaim } = await import(pathToFileURL(originSrc).href);

mkdirSync('tmp', { recursive: true });
const data = mkdtempSync(resolve('tmp', 'oc-bound-'));
const port = 21000 + Math.floor(Math.random() * 20000);
const base = 'http://127.0.0.1:' + port;
const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_TOKEN: 'oc-test', MCP_GATEWAY: 'off', REDIS_URL: '', LAYERFS_SERVICE_URL: '', MARKET_PUBLIC_URL: base };
let child, logs = '', pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('PASS ' + name); };

// 对端：记下每次投递的原始请求，用上游裁判按「窗已关」验
const seen = [];
const peer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, socket: req.socket });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: 'peer-1', text: 'ok' }));
  });
});
await new Promise((r) => peer.listen(0, '127.0.0.1', r));
const peerBase = 'http://127.0.0.1:' + peer.address().port;

const judge = (req, audiences = [peerBase]) => verifyOriginClaim(req, {
  cardCache: new Map(),
  fetch: (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, text: () => r.text() })),
  audiences,
  unboundOpen: false,
  onUnbound: () => {},
  now: Date.now(),
});
// 同一组头、换个方法/路径/目标重放（模拟被截获的信封拿去别处用）
const replay = (got, patch) => ({ method: got.method, url: got.url, headers: got.headers, socket: got.socket, ...patch });

async function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => (logs += c)); child.stderr.on('data', (c) => (logs += c));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} if (child.exitCode !== null) break; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('fixture boot failed ' + logs.slice(-800));
}
async function stop() { if (child?.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } }

try {
  await start();
  const sent = await fetch(base + '/api/a2a/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'oc-test' },
    body: JSON.stringify({ target_url: peerBase, team: 'dsh/66abc2cf', message: 'origin-claim probe' }),
  });
  check('出站 200', () => assert.equal(sent.status, 200, logs.slice(-400)));
  check('对端收到 1 次投递', () => assert.equal(seen.length, 1));
  const got = seen[0];
  check('信封带 Aud + Sig2（绑定形式）', () => { assert.equal(got.headers['x-a2a-caller-aud'], peerBase); assert.ok(String(got.headers['x-a2a-caller-sig2'] ?? '').length > 0); });
  check('信封仍带 v1 Sig（未升级对端开窗期回落）', () => assert.ok(String(got.headers['x-a2a-caller-sig'] ?? '').length > 0));

  const v = await judge(got);
  check('上游裁判·窗已关：通过且为绑定形式', () => { assert.equal(v.ok, true, JSON.stringify(v)); assert.equal(v.bound, true); assert.equal(v.caller, 'market'); });

  const otherPath = await judge(replay(got, { url: '/a2a/canvas-op' }));
  check('重放到别的路由 → bad-sig', () => assert.deepEqual(otherPath, { ok: false, reason: 'bad-sig' }));
  const otherMethod = await judge(replay(got, { method: 'PUT' }));
  check('换方法重放 → bad-sig', () => assert.deepEqual(otherMethod, { ok: false, reason: 'bad-sig' }));
  // 本机回环到达时 socket 本端也算受众；换成非回环的受众表来模拟「别的主机」
  const foreign = await judge(replay(got, { socket: {} }), ['http://10.9.9.9:13080']);
  check('别的主机（受众不符）→ wrong-audience', () => assert.deepEqual(foreign, { ok: false, reason: 'wrong-audience' }));

  // 反例（旧实现的形状）：只有 v1 Sig、没有 Sig2——关窗后必拒
  const legacyHeaders = { ...got.headers }; delete legacyHeaders['x-a2a-caller-sig2']; delete legacyHeaders['x-a2a-caller-aud'];
  const legacy = await judge(replay(got, { headers: legacyHeaders }));
  check('反例：仅 v1 信封在关窗后 → unbound-closed', () => assert.deepEqual(legacy, { ok: false, reason: 'unbound-closed' }));

  console.log(`origin-claim-bound-smoke: ${pass} PASS`);
} catch (e) {
  console.error('FAIL', e?.message ?? e);
  console.error(logs.slice(-1200));
  process.exitCode = 1;
} finally {
  await stop();
  peer.close();
}
