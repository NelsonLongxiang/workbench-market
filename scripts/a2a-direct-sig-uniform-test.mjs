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
let child = null;
let out = '';
function boot(extra) {
  out = '';
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: 'server',
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'uni-admin', MARKET_PUBLIC_URL: BASE, WM_GITHUB_API: gh.api, WM_A2A_CARD_COOLDOWN_S: '2', WM_LOGIN_GATE: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
}
async function stop() { if (!child || child.exitCode !== null) return; const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; }
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }
async function call(method, path, body, headers = {}) { const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, text: await r.text() }; }
function signedBy(key, callerUrl = PEER, zone = 'dsh') {
  const ts = Date.now();
  return { 'X-A2A-Caller': zone, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': BASE, 'X-A2A-Caller-Sig2': edSign(undefined, Buffer.from(JSON.stringify(['a2a-origin-claim/2', zone, callerUrl, ts, BASE, 'POST', '/a2a/direct'])), key).toString('base64') };
}
const refused = async () => (await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts ?? {};
const diff = (a, b) => { const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d) o[k] = d; } return o; };
/** 应答里随请求变的字段（task_id）换成占位再比 */
const norm = (text) => text.replace(/"task_id":"[^"]*"/g, '"task_id":"<id>"');
// 四种调用方：A 绑定 + 登记取卡地址（名片是它）；B 绑定、没登记地址；C 没绑定；D 绑定 + 登记地址，但那里的名片不是它
const A = 'dsh/aaaa1111', B = 'dsh/bbbb2222', C = 'dsh/cccc3333', D = 'dsh/dddd4444';
const anyKey = generateKeyPairSync('ed25519').privateKey;
let team = '';
let seq = 0;
const status = (caller) => ({ team, message: JSON.stringify({ sop: { action: 'status' } }), caller_session: caller, task_id: `u-${++seq}`, context_id: 'ctx-none' });
async function setup() {
  const p = await ghPublish(BASE, gh, { slug: 'uni-sop', kind: 'sop', title: 'uni', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: uni\nsteps:\n  - key: a\n    title: A\n' }] });
  if (p.status !== 201) throw new Error('发布失败');
  await call('POST', '/api/sops/uni-sop/publish', {}, ADMIN);
  await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'uni-sop', agent_node: A, mode: 'run', direction: 'admits', notify_url: PEER }, ADMIN);
  await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'uni-sop', agent_node: B, mode: 'run', direction: 'admits' }, ADMIN);
  await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'uni-sop', agent_node: D, mode: 'run', direction: 'admits', notify_url: OTHER }, ADMIN);
}

try {
  console.log('一（accept，缺省）：取卡或验签失败一律按未签名走——不更宽、也不更严');
  boot({ WM_A2A_DIRECT_SIG: '' });
  if (!(await ready())) throw new Error('实例未就绪：' + out.slice(-600));
  await setup();
  team = (await (await fetch(BASE + '/.well-known/agent-card.json')).json()).sessionTeams?.[0]?.team;
  const bad = {}, plain = {}, deltas = {};
  for (const [name, caller] of [['A', A], ['B', B], ['C', C], ['D', D]]) {
    const before = await refused();
    bad[name] = await call('POST', '/a2a/direct', status(caller), signedBy(anyKey));
    deltas[name] = diff(before, await refused());
    plain[name] = await call('POST', '/a2a/direct', status(caller));
  }
  for (const n of ['A', 'B', 'C', 'D']) ok(`${n}：坏签名的应答与不带签名的逐字节相同（task_id 换占位）`, bad[n].status === plain[n].status && norm(bad[n].text) === norm(plain[n].text), `${bad[n].status} ${bad[n].text} | ${plain[n].status} ${plain[n].text}`);
  ok('有绑定（A 登记了地址、D 登记的地址上名片不对）与有绑定（B 没登记）：坏签名的应答逐字节相同', norm(bad.A.text) === norm(bad.B.text) && norm(bad.D.text) === norm(bad.B.text) && bad.A.status === bad.B.status, `${bad.A.text} | ${bad.B.text}`);
  ok('……公开计数的增量也相同（取卡这一步不计拒收）', JSON.stringify(deltas.A) === JSON.stringify(deltas.B) && JSON.stringify(deltas.D) === JSON.stringify(deltas.B), JSON.stringify(deltas));
  ok('没绑定（C）坏签名 → 与不带签名同为准入的 404', bad.C.status === 404 && bad.C.text === plain.C.text);
  await sleep(200);
  ok('内部日志记下了回退和原因（bad-sig、unregistered、not-derivable）', /"unverified":"bad-sig","fallback":"unsigned"/.test(out) && /"unverified":"unregistered"/.test(out) && /"unverified":"not-derivable"/.test(out), out.split('\n').filter((l) => l.includes('a2a-direct-sig')).join(' | ').slice(0, 400));
  await stop();

  console.log('一（require）：对外应答与公开计数统一');
  boot({ WM_A2A_DIRECT_SIG: 'require' });
  if (!(await ready())) throw new Error('require 实例未就绪：' + out.slice(-600));
  const rq = {}, rd = {};
  for (const [name, caller] of [['A', A], ['B', B], ['C', C], ['D', D]]) {
    const before = await refused();
    rq[name] = await call('POST', '/a2a/direct', status(caller), signedBy(anyKey));
    rd[name] = diff(before, await refused());
  }
  ok('A / B / C / D 的应答逐字节相同（401 no-card）', ['A', 'B', 'D'].every((n) => rq[n].status === rq.C.status && rq[n].text === rq.C.text) && rq.C.status === 401 && /\(no-card\)/.test(rq.C.text), JSON.stringify(rq));
  ok('应答里不出现 bad-sig / not-derivable / unregistered', !/bad-sig|not-derivable|unregistered/.test(Object.values(rq).map((r) => r.text).join('')));
  ok('公开计数的增量都只是 sig:no-card 一格', ['A', 'B', 'C', 'D'].every((n) => JSON.stringify(rd[n]) === JSON.stringify({ 'sig:no-card': 1 })), JSON.stringify(rd));
  await sleep(200);
  ok('内部日志照旧分开记（bad-sig、unregistered、not-derivable 各有）', /"refused":"bad-sig"/.test(out) && /"refused":"unregistered"/.test(out) && /"refused":"not-derivable"/.test(out));

  console.log('二、取卡冷却');
  await sleep(2200); // 让前面那次取卡过冷却
  const before = peer.gets;
  for (let i = 0; i < 10; i++) await call('POST', '/a2a/direct', status(A), signedBy(anyKey));
  ok(`冷却期内连续 10 次签名失败，只取 ${peer.gets - before} 次卡（≤ 1）`, peer.gets - before <= 1, `gets=${peer.gets - before}`);
  let r = await call('POST', '/a2a/direct', status(A), signedBy(peer.key));
  ok('正确的钥匙签 → 过签名、进准入', r.status === 200 && JSON.parse(r.text).code === -32000 && /no run bound/.test(r.text), r.text.slice(0, 160));
  const newKey = generateKeyPairSync('ed25519').privateKey;
  peer.key = newKey;
  r = await call('POST', '/a2a/direct', status(A), signedBy(newKey));
  ok('刚换钥匙、还在冷却期 → 用缓存的旧名片，新钥匙签的过不了', r.status === 401, r.text.slice(0, 120));
  await sleep(2200);
  r = await call('POST', '/a2a/direct', status(A), signedBy(newKey));
  ok('冷却过后 → 重取名片，新钥匙签的能过', r.status === 200 && /no run bound/.test(r.text), r.text.slice(0, 160));
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  await stop();
  peerServer.close();
  otherServer.close();
  await gh.close();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
