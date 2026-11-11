#!/usr/bin/env node
/**
 * /a2a/direct 入站签名拒收的对外应答统一；取卡加冷却。
 *
 * 一、require 模式下，匿名带任意签名的请求：调用方没有绑定 / 有绑定但签名不对 / 有绑定但登记地址上的名片不是这个身份，
 *    对外应答（状态码与应答体）逐字节相同；服务端日志里内部原因照旧分开。
 * 二、取卡冷却：冷却期内连续签名失败只取一次卡；对方真换了钥匙，冷却过后新钥匙签的请求能过。
 * 三、开关：WM_A2A_CARD_COOLDOWN_S 非法值拒绝启动。
 */
import { spawn } from './owned-script-fixture.mjs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATA = resolve('tmp/a2a-direct-sig-uniform');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

console.log('三、开关');
{
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', env: { ...process.env, DATA_DIR: DATA, PORT: '0', WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', WM_A2A_CARD_COOLDOWN_S: 'soon' }, encoding: 'utf8', timeout: 30000 });
  ok('WM_A2A_CARD_COOLDOWN_S 非法值拒绝启动', r.status !== 0 && /WM_A2A_CARD_COOLDOWN_S/.test(r.stderr + r.stdout), `status=${r.status}`);
}

// 对方节点的名片服务：zone dsh；可以换钥匙、可以改成别的 team；数取卡次数
const peer = { key: generateKeyPairSync('ed25519').privateKey, team: 'dsh', gets: 0 };
const PP = await port();
const PEER = `http://127.0.0.1:${PP}`;
const peerServer = createServer((req, res) => {
  if (req.url === '/.well-known/agent-card.json') {
    peer.gets++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: peer.team, session: peer.team, team: peer.team }, peer.key)));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => peerServer.listen(PP, '127.0.0.1', r));
// 另一个名片服务：team 不是 dsh（not-derivable 用）
const otherKey = generateKeyPairSync('ed25519').privateKey;
const PO = await port();
const OTHER = `http://127.0.0.1:${PO}`;
const otherServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: 'zz', session: 'zz', team: 'zz' }, otherKey))); });
await new Promise((r) => otherServer.listen(PO, '127.0.0.1', r));

const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const gh = await startFakeGithub();
const ADMIN = { 'X-Admin-Token': 'uni-admin' };
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'uni-admin', MARKET_PUBLIC_URL: BASE, WM_GITHUB_API: gh.api, WM_A2A_DIRECT_SIG: 'require', WM_A2A_CARD_COOLDOWN_S: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }
async function call(method, path, body, headers = {}) { const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, text: await r.text() }; }
function signedBy(key, callerUrl = PEER, zone = 'dsh') {
  const ts = Date.now();
  return { 'X-A2A-Caller': zone, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': BASE, 'X-A2A-Caller-Sig2': edSign(undefined, Buffer.from(JSON.stringify(['a2a-origin-claim/2', zone, callerUrl, ts, BASE, 'POST', '/a2a/direct'])), key).toString('base64') };
}

try {
  if (!(await ready())) throw new Error('实例未就绪：' + out.slice(-600));
  const p = await ghPublish(BASE, gh, { slug: 'uni-sop', kind: 'sop', title: 'uni', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: uni\nsteps:\n  - key: a\n    title: A\n' }] });
  if (p.status !== 201) throw new Error('发布失败');
  await call('POST', '/api/sops/uni-sop/publish', {}, ADMIN);
  await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'uni-sop', agent_node: 'dsh/aaaa1111', mode: 'run', direction: 'admits', notify_url: PEER }, ADMIN);
  await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'uni-sop', agent_node: 'dsh/cccc3333', mode: 'run', direction: 'admits', notify_url: OTHER }, ADMIN);
  const card = await (await fetch(BASE + '/.well-known/agent-card.json')).json();
  const team = card.sessionTeams?.[0]?.team;
  const body = (caller, task) => ({ team, message: JSON.stringify({ sop: { action: 'start' } }), caller_session: caller, task_id: task });

  console.log('一、对外应答统一');
  const anyKey = generateKeyPairSync('ed25519').privateKey;
  const bound = await call('POST', '/a2a/direct', body('dsh/aaaa1111', 'u-1'), signedBy(anyKey));
  const unbound = await call('POST', '/a2a/direct', body('dsh/bbbb2222', 'u-2'), signedBy(anyKey));
  const wrongTeam = await call('POST', '/a2a/direct', body('dsh/cccc3333', 'u-3'), signedBy(anyKey));
  ok('有绑定、签名不对 vs 没有绑定：状态码与应答体逐字节相同', bound.status === unbound.status && bound.text === unbound.text, `${bound.status} ${bound.text} | ${unbound.status} ${unbound.text}`);
  ok('有绑定、登记地址上的名片不是这个身份 vs 没有绑定：逐字节相同', wrongTeam.status === unbound.status && wrongTeam.text === unbound.text, `${wrongTeam.text} | ${unbound.text}`);
  ok('应答里不出现 bad-sig / not-derivable / unregistered', !/bad-sig|not-derivable|unregistered/.test(bound.text + unbound.text + wrongTeam.text));
  await sleep(200);
  ok('内部日志照旧分开记（bad-sig、unregistered、not-derivable 各有）', /"refused":"bad-sig"/.test(out) && /"refused":"unregistered"/.test(out) && /"refused":"not-derivable"/.test(out), out.split('\n').filter((l) => l.includes('a2a-direct-sig')).join(' | ').slice(0, 400));

  console.log('二、取卡冷却');
  await sleep(2200); // 让前面那次取卡过冷却
  const before = peer.gets;
  for (let i = 0; i < 10; i++) await call('POST', '/a2a/direct', body('dsh/aaaa1111', `u-n${i}`), signedBy(anyKey));
  ok(`冷却期内连续 10 次签名失败，只取 ${peer.gets - before} 次卡（≤ 1）`, peer.gets - before <= 1, `gets=${peer.gets - before}`);
  let r = await call('POST', '/a2a/direct', body('dsh/aaaa1111', 'u-ok1'), signedBy(peer.key));
  ok('正确的钥匙签 → 过签名、进准入', r.status === 200 && JSON.parse(r.text).task_status === 'TASK_STATE_DELIVERED', r.text.slice(0, 160));
  // 对方真换了钥匙
  const newKey = generateKeyPairSync('ed25519').privateKey;
  peer.key = newKey;
  r = await call('POST', '/a2a/direct', body('dsh/aaaa1111', 'u-rot1'), signedBy(newKey));
  ok('刚换钥匙、还在冷却期 → 用缓存的旧名片，新钥匙签的过不了', r.status === 401, r.text.slice(0, 120));
  await sleep(2200);
  r = await call('POST', '/a2a/direct', body('dsh/aaaa1111', 'u-rot2'), signedBy(newKey));
  ok('冷却过后 → 重取名片，新钥匙签的能过', r.status === 200 && JSON.parse(r.text).task_status === 'TASK_STATE_DELIVERED', r.text.slice(0, 160));
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  child.kill();
  peerServer.close();
  otherServer.close();
  await gh.close();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
