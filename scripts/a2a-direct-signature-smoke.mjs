#!/usr/bin/env node
/**
 * /a2a/direct 入站签名冒烟（WM_A2A_DIRECT_SIG / WM_A2A_DIRECT_SIG_BODY / WM_LOGIN_GATE=enforce）。
 * 对端全是本机回环假节点：本地生成 Ed25519 密钥对，用官方 signCard 签一张假卡片；
 * 路由形式的信封用上游 signOriginClaim（A2A_ORIGIN_SRC 指 dsh-open-a2a-net src/origin-claim.ts）签——就是 DSH 节点实际发的那组头。
 * 隔离 DATA_DIR、替身 GitHub，不碰任何生产主机。
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn as nativeSpawn } from 'node:child_process';
import { spawn } from './owned-script-fixture.mjs';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';

const originSrc = process.env.A2A_ORIGIN_SRC ?? resolve('..', 'dsh-open-a2a-net', 'src', 'origin-claim.ts');
const { signOriginClaim } = await import(pathToFileURL(originSrc).href);

mkdirSync('tmp', { recursive: true });
const out = mkdtempSync(resolve('tmp', 'a2a-direct-sig-'));
const DATA = join(out, 'data');
mkdirSync(DATA);
const TOKEN = 'sig-smoke-admin';
const reserve = netServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r)); const PORT = reserve.address().port; await new Promise((r) => reserve.close(r));
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + extra); } };

// ---------- 假对端：zone=peerz，卡片在 /.well-known/agent-card.json ----------
const keyOf = () => generateKeyPairSync('ed25519').privateKey;
const ZONE = 'peerz';
const peerKey = keyOf();
const otherKey = keyOf();
const cardFor = (team, key) => signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: team + '-node', session: team, team }, key);
const hits = { good: 0, bad: 0, redirect: 0, redirectTarget: 0 };
const peer = createServer((req, res) => {
  const send = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/good/.well-known/agent-card.json') { hits.good++; return send(cardFor(ZONE, peerKey)); }
  if (req.url === '/evil/.well-known/agent-card.json') return send(cardFor('evilz', otherKey));
  if (req.url === '/bad/.well-known/agent-card.json') { hits.bad++; const c = cardFor(ZONE, peerKey); return send({ ...c, signature: c.signature.slice(0, -8) + 'AAAAAAA=' }); }
  if (req.url === '/redir/.well-known/agent-card.json') { hits.redirect++; res.writeHead(302, { location: '/landing/.well-known/agent-card.json' }); return res.end(); }
  if (req.url === '/landing/.well-known/agent-card.json') { hits.redirectTarget++; return send(cardFor(ZONE, peerKey)); }
  send({ error: 'not found' }, 404);
});
await new Promise((r) => peer.listen(0, '127.0.0.1', r));
const PEER = 'http://127.0.0.1:' + peer.address().port;

// ---------- 签名 ----------
const DIRECT = BASE + '/a2a/direct';
const routeHeaders = (o = {}) => signOriginClaim({ url: o.url ?? DIRECT, method: o.method ?? 'POST' }, { caller: o.caller ?? ZONE, callerUrl: PEER + '/good', privateKey: o.key ?? peerKey, unbound: o.unbound ?? false, now: o.ts ?? Date.now() });
const b64u = (buf) => createHash('sha256').update(buf).digest('base64url');
function bodyHeaders(raw, o = {}) {
  const ts = o.ts ?? Date.now();
  const caller = o.caller ?? ZONE, callerUrl = PEER + '/good', aud = new URL(DIRECT).origin;
  const digest = b64u(Buffer.from(o.signedBody ?? raw));
  const text = JSON.stringify(['wm-a2a-direct-body/1', caller, callerUrl, ts, aud, 'POST', '/a2a/direct', digest]);
  return { 'X-A2A-Caller': caller, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud,
    'X-WM-Body-Sha256': o.claimDigest ?? digest, 'X-WM-Body-Sig': edSign(undefined, Buffer.from(text), o.key ?? peerKey).toString('base64') };
}

// ---------- 实例 ----------
const gh = await startFakeGithub();
let child = null, logs = '';
async function boot(extra) {
  logs = '';
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: 'server', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCP_GATEWAY: 'on', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: TOKEN, WM_GITHUB_API: gh.api, MARKET_PUBLIC_URL: BASE, REDIS_URL: '', WM_LOGIN_GATE: '', WM_A2A_DIRECT_SIG: '', WM_A2A_DIRECT_SIG_BODY: '', ...extra },
  });
  child.stdout.on('data', (c) => (logs += c)); child.stderr.on('data', (c) => (logs += c));
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try { if ((await fetch(BASE + '/api/health')).status === 200) return; } catch { /* 未起 */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('instance not ready: ' + logs.slice(-1500));
}
async function halt() { if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; } child = null; }

async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
const admin = { 'X-Admin-Token': TOKEN };
let team = '';
const start = (caller) => JSON.stringify({ team, message: 'sig smoke start', caller_session: caller, task_id: 'sig-' + randomBytes(6).toString('hex') });
// 远程到达的样子（经反代转发），本机命令行豁免不适用
const REMOTE = { 'x-forwarded-for': '192.0.2.10' };
async function direct(raw, headers = {}, path = '/a2a/direct') {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...REMOTE, ...headers }, body: raw });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
const delivered = (r) => r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED';
const refused = (r, reason) => r.status === 401 && (reason === undefined || String(r.body?.error ?? '').includes('(' + reason + ')'));
const show = (r) => JSON.stringify(r).slice(0, 240);

const OK = ZONE + '/aaaa1111';      // run 绑定，登记了好卡片地址
const READ = ZONE + '/bbbb2222';    // read 绑定，同一地址（read 绑定也保留取卡地址）
const NOURL = ZONE + '/cccc3333';   // run 绑定，没登记地址
const BADCARD = ZONE + '/dddd4444'; // 地址上的卡片签名坏了
const REDIR = ZONE + '/eeee5555';   // 地址 302 到别处
const EVIL = 'evilz/ffff6666';      // 地址上的卡 team 是 evilz、钥匙是另一把
const UNBOUND = ZONE + '/99990000'; // 没有任何绑定

try {
  // ===== accept（缺省）=====
  await boot({});
  const yaml = 'title: 签名冒烟 SOP\nsteps:\n  - key: a\n    title: A\n';
  const pub = await ghPublish(BASE, gh, { slug: 'sig-smoke-sop', kind: 'sop', title: '签名冒烟 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: yaml }] });
  assert.equal(pub.status, 201, 'publish ' + pub.status);
  await call('POST', '/api/sops/sig-smoke-sop/publish', {}, admin);
  const bind = (agent_node, mode, notify_url) => call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'sig-smoke-sop', agent_node, direction: 'admits', mode, ...(notify_url ? { notify_url } : {}) }, admin);
  for (const [n, m, u] of [[OK, 'run', PEER + '/good'], [READ, 'read', PEER + '/good'], [NOURL, 'run', ''], [BADCARD, 'run', PEER + '/bad'], [REDIR, 'run', PEER + '/redir'], [EVIL, 'run', PEER + '/evil']]) {
    const r = await bind(n, m, u); assert.equal(r.status, 201, show(r));
  }
  const rows = (await call('GET', '/api/bindings?type=sop&slug=sig-smoke-sop', undefined, admin)).body;
  ok('admits+read 绑定保留 notify_url（入站验签的取卡地址）', rows.find((x) => x.agent_node === READ)?.notify_url === PEER + '/good');
  team = (await call('GET', '/.well-known/agent-card.json')).body.sessionTeams[0].team;

  console.log('— accept（缺省）');
  let raw = start(OK);
  ok('accept：无签名照旧 → 200 DELIVERED', delivered(await direct(raw)));
  raw = start(OK);
  ok('accept：只带 v1 Sig（不绑路由）按无签名照旧', delivered(await direct(raw, routeHeaders({ unbound: true, url: 'not-a-url' }))));
  raw = start(OK);
  const sigOk = routeHeaders();
  let r = await direct(raw, sigOk);
  ok('有效 Sig2（上游 signOriginClaim）→ 进准入、已绑定 200 DELIVERED', delivered(r), show(r));
  r = await direct(raw, sigOk);
  ok('原样重放 → 401 replay', refused(r, 'replay'), show(r));
  raw = start(OK);
  ok('有效 body 签名 → 200 DELIVERED', delivered(await direct(raw, bodyHeaders(raw))));
  r = await direct(start(READ), routeHeaders());
  ok('有效签名、read 绑定 → 走现有准入（200 FAILED：只许 status）', r.status === 200 && r.body?.task_status === 'TASK_STATE_FAILED' && /mode is read/.test(r.body?.error ?? ''), show(r));
  r = await direct(start(UNBOUND), routeHeaders());
  ok('accept：有效签名但无任何绑定 → 照旧 404', r.status === 404, show(r));
  const orig = start(OK);
  const tampered = orig.replace('sig smoke start', 'sig smoke TAMPERED');
  r = await direct(tampered, bodyHeaders(orig, { signedBody: orig, claimDigest: b64u(Buffer.from(orig)) }));
  ok('篡改 body（摘要头没改）→ 401 bad-body-digest', refused(r, 'bad-body-digest'), show(r));
  r = await direct(tampered, bodyHeaders(orig, { signedBody: orig, claimDigest: b64u(Buffer.from(tampered)) }));
  ok('篡改 body 且改了摘要头 → 401 bad-sig', refused(r, 'bad-sig'), show(r));
  r = await direct(start(OK), routeHeaders({ method: 'PUT' }));
  ok('签 PUT 发 POST → 401 bad-sig', refused(r, 'bad-sig'), show(r));
  r = await direct(start(OK), routeHeaders({ url: BASE + '/a2a/log' }));
  ok('签 /a2a/log 发 /a2a/direct → 401 bad-sig', refused(r, 'bad-sig'), show(r));
  r = await direct(start(OK), routeHeaders({ url: 'http://10.9.9.9:13080/a2a/direct' }));
  ok('签给别的主机 → 401 wrong-audience', refused(r, 'wrong-audience'), show(r));
  r = await direct(start(OK), routeHeaders({ ts: Date.now() - 6 * 60_000 }));
  ok('时间戳过期（-6 分钟）→ 401 bad-ts', refused(r, 'bad-ts'), show(r));
  r = await direct(start(OK), routeHeaders({ ts: Date.now() + 6 * 60_000 }));
  ok('时间戳超前（+6 分钟）→ 401 bad-ts', refused(r, 'bad-ts'), show(r));
  r = await direct(start('otherz/aaaa1111'), routeHeaders());
  ok('签名身份 peerz ≠ caller_session 的 zone → 401 identity-mismatch', refused(r, 'identity-mismatch'), show(r));
  r = await direct(start(OK), routeHeaders({ key: otherKey }));
  ok('别的钥匙签 → 401 bad-sig', refused(r, 'bad-sig'), show(r));
  r = await direct(start(EVIL), routeHeaders({ caller: 'evilz' }));
  ok('签名身份对、登记地址上的卡也是它，但钥匙对不上 → 401 bad-sig', refused(r, 'bad-sig'), show(r));
  r = await direct(start(BADCARD), routeHeaders());
  ok('登记地址上的卡片签名无效 → 401 no-card', refused(r, 'no-card'), show(r));
  ok('坏卡确实取过一次', hits.bad >= 1);
  const before = hits.redirectTarget;
  r = await direct(start(REDIR), routeHeaders());
  ok('登记地址 302 → 不跟随 → 401 no-card', refused(r, 'no-card'), show(r));
  ok('取卡不跟随重定向（落地地址零访问）', hits.redirect >= 1 && hits.redirectTarget === before);
  r = await direct(start(OK), { ...routeHeaders(), 'X-A2A-Caller-Url': PEER + '/evil' });
  ok('改 X-A2A-Caller-Url 指向别的卡 → 401 bad-sig（只取登记地址，且 url 在签名里）', refused(r, 'bad-sig'), show(r));
  const replayLater = { raw: start(OK) }; replayLater.h = routeHeaders();
  ok('重启前用掉一个签名', delivered(await direct(replayLater.raw, replayLater.h)));
  await halt();

  // ===== require =====
  console.log('— require');
  await boot({ WM_A2A_DIRECT_SIG: 'require' });
  r = await direct(replayLater.raw, replayLater.h);
  ok('重启后重放 → 仍 401 replay（防重放落库）', refused(r, 'replay'), show(r));
  r = await direct(start(OK));
  ok('require：无签名 → 401 absent', refused(r, 'absent'), show(r));
  r = await direct(start(OK), routeHeaders({ unbound: true, url: 'not-a-url' }));
  ok('require：只带 v1 Sig → 401 unbound-only', refused(r, 'unbound-only'), show(r));
  r = await direct(start(OK), routeHeaders());
  ok('require：有效签名 → 200 DELIVERED', delivered(r), show(r));
  r = await direct(start(NOURL), routeHeaders());
  ok('require：卡片地址未登记 → 401（对外同 no-card，不泄露绑定）', refused(r, 'no-card'), show(r));
  r = await direct(start(UNBOUND), routeHeaders());
  ok('require：无绑定 → 401', refused(r, 'no-card'), show(r));
  await halt();

  // ===== body require =====
  console.log('— WM_A2A_DIRECT_SIG_BODY=require');
  await boot({ WM_A2A_DIRECT_SIG: 'require', WM_A2A_DIRECT_SIG_BODY: 'require' });
  r = await direct(start(OK), routeHeaders());
  ok('只带 Sig2（不签 body）→ 401 body-sig-required', refused(r, 'body-sig-required'), show(r));
  raw = start(OK);
  ok('body 签名 → 200 DELIVERED', delivered(await direct(raw, bodyHeaders(raw))));
  await halt();

  // ===== enforce：强制 require，登录门放行到路由 =====
  console.log('— WM_LOGIN_GATE=enforce');
  await boot({ WM_LOGIN_GATE: 'enforce', WM_A2A_DIRECT_SIG: 'accept' });
  ok('enforce 下 accept 被改成 require 并告警', /WM_A2A_DIRECT_SIG=accept 被忽略/.test(logs));
  const health = (await call('GET', '/api/health')).body;
  ok('启动自检含 enforce 无签名 direct 行且通过', health?.self_probe?.rows?.some((x) => x.id === 'market.a2a-direct.unsigned' && x.verdict === 'pass'), JSON.stringify(health?.self_probe?.failed));
  r = await direct(start(OK));
  ok('enforce：无签名 → 401（路由按签名拒，不是登录门）', refused(r, 'absent'), show(r));
  r = await direct(start(OK), routeHeaders());
  ok('enforce：有效签名 → 过登录门 200 DELIVERED', delivered(r), show(r));
  r = await fetch(BASE + '/api/apps', { headers: REMOTE });
  ok('enforce：别的接口照旧要登录 401', r.status === 401);
  await halt();

  // ===== 坏值拒启 =====
  for (const [k, v] of [['WM_A2A_DIRECT_SIG', 'maybe'], ['WM_A2A_DIRECT_SIG_BODY', 'off']]) {
    const c = nativeSpawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: TOKEN, MCP_GATEWAY: 'on', REDIS_URL: '', [k]: v } });
    let err = ''; c.stderr.on('data', (b) => (err += b));
    const [code] = await once(c, 'exit');
    ok(`${k}=${v} → 拒绝启动`, code === 1 && /a2a-direct-sig\] 拒绝启动/.test(err), 'exit=' + code);
  }

  // ===== 进程内：卡片缓存过期与密钥轮换（注入时钟，不等真实时间） =====
  console.log('— 卡片缓存与密钥轮换');
  const unitData = join(out, 'unit'); mkdirSync(unitData);
  process.env.DATA_DIR = unitData;
  const { db } = await import(pathToFileURL(resolve('server/src/db.ts')).href);
  const { createDirectSigVerifier } = await import(pathToFileURL(resolve('server/src/a2a-direct-sig.ts')).href);
  db.prepare("INSERT INTO bindings (target_type,target_slug,agent_node,direction,mode,notify_url) VALUES ('sop','u','peerz/12345678','admits','run','http://peer.invalid')").run();
  let clock = Date.now(), current = peerKey, fetches = 0;
  const v = createDirectSigVerifier({ audiences: () => ['http://market.invalid'], now: () => clock, fetchText: async () => { fetches++; return JSON.stringify(cardFor(ZONE, current)); } });
  const fakeReq = (key) => ({ method: 'POST', url: '/a2a/direct', socket: {}, headers: Object.fromEntries(Object.entries(signOriginClaim({ url: 'http://market.invalid/a2a/direct', method: 'POST' }, { caller: ZONE, callerUrl: 'http://peer.invalid', privateKey: key, unbound: false, now: clock })).map(([k, x]) => [k.toLowerCase(), x])) });
  ok('首次：取卡并通过', (await v.verify(fakeReq(peerKey), Buffer.alloc(0), 'peerz/12345678')).ok === true && fetches === 1);
  clock += 1000;
  ok('缓存内：不再取卡', (await v.verify(fakeReq(peerKey), Buffer.alloc(0), 'peerz/12345678')).ok === true && fetches === 1);
  const rotated = keyOf(); current = rotated; clock += 1000;
  let u = await v.verify(fakeReq(rotated), Buffer.alloc(0), 'peerz/12345678');
  ok('刚轮换（30 秒内）不重取 → bad-sig，防放大', u.ok === false && u.reason === 'bad-sig' && fetches === 1, JSON.stringify(u));
  clock += 31_000;
  u = await v.verify(fakeReq(rotated), Buffer.alloc(0), 'peerz/12345678');
  ok('30 秒后签名对不上旧卡 → 重取一次新卡并通过（轮换）', u.ok === true && fetches === 2, JSON.stringify(u) + ' fetches=' + fetches);
  clock += 11 * 60_000;
  ok('缓存过期（10 分钟）→ 重新取卡', (await v.verify(fakeReq(rotated), Buffer.alloc(0), 'peerz/12345678')).ok === true && fetches === 3);
  u = await v.verify(fakeReq(peerKey), Buffer.alloc(0), 'peerz/12345678');
  ok('轮换后旧钥匙签的 → bad-sig', u.ok === false && u.reason === 'bad-sig', JSON.stringify(u));
  db.close();
} catch (e) {
  fail++;
  console.log('  ✗ 异常 ' + (e?.stack ?? e) + '\n' + logs.slice(-1500));
} finally {
  await halt();
  peer.closeAllConnections(); await new Promise((r) => peer.close(r));
  await gh.close?.();
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
