#!/usr/bin/env node
/**
 * A2A 错误码表与 /api/health 的 a2a 块（阶段七第 5 步）。
 *
 * 一、错误码表：每个原因都有错误码 / HTTP 状态 / 公开桶 / 中文原因 / 中文处理办法；签名拒收的每一种（a2a-direct-sig.ts 的 SigRefusal）都在表里；
 *    a2a.ts 里记的每个键都在表里。出站积压聚合（services/a2a-stats.ts）用假数据核对计数、最老待发、回执时长中位数。
 * 二、HTTP：/api/health 带 a2a 块（开关生效值、名片有效期、幂等窗口、出站积压、拒收计数），每种入站拒收打一次、计数各涨一格；
 *    /api/health/ready 不带；入站签名 require 时无签名请求记进 sig:absent。
 * 三、对抗组：/api/health 是公开端点——
 *    · 查无 SOP 与没有绑定对外同答 404，健康块里也只能涨同一格（否则发一条请求比计数就能分出 SOP 是否存在）；
 *    · 健康块里不出团队名、调用方、task_id、消息内容。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:net';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const CJK = /[一-鿿]/;

const UNIT_DATA = resolve('tmp/a2a-health-unit');
const HTTP_DATA = 'tmp/a2a-health-http';
for (const d of [UNIT_DATA, HTTP_DATA]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }

console.log('一、错误码表与出站聚合');
process.env.DATA_DIR = UNIT_DATA;
let errors = null;
try { errors = await import('../server/src/a2a/errors.ts'); } catch (e) { ok('a2a/errors.ts 可加载', false, String(e?.message ?? e).slice(0, 160)); }
if (errors) {
  const { A2A_ERRORS } = errors;
  const entries = Object.entries(A2A_ERRORS);
  const bad = entries.filter(([, v]) => !(CJK.test(v.reason) && CJK.test(v.fix) && Number.isInteger(v.http) && (v.code === null || Number.isInteger(v.code)) && typeof v.public === 'string' && v.public !== ''));
  ok(`每个原因都有中文原因和处理办法、错误码、HTTP 状态、公开桶（${entries.length} 个）`, entries.length > 0 && bad.length === 0, bad.map(([k]) => k).join(','));
  const sigSrc = readFileSync('server/src/a2a-direct-sig.ts', 'utf8');
  const sigType = /export type SigRefusal =([^;]+);/.exec(sigSrc)?.[1] ?? '';
  const sigReasons = [...sigType.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const missingSig = sigReasons.filter((r) => !(`sig:${r}` in A2A_ERRORS));
  ok(`签名拒收的 ${sigReasons.length} 种原因都在表里`, sigReasons.length >= 10 && missingSig.length === 0, missingSig.join(','));
  const used = [...readFileSync('server/src/a2a.ts', 'utf8').matchAll(/noteA2aError\('([^']+)'\)/g)].map((m) => m[1]);
  const usedVerdict = /noteA2aError\(verdict\)/.test(readFileSync('server/src/a2a.ts', 'utf8'));
  const missingUsed = used.filter((k) => !(k in A2A_ERRORS));
  ok(`a2a.ts 记的 ${used.length} 个键都在表里（另有幂等判定 replay / conflict）`, used.length >= 9 && missingUsed.length === 0 && usedVerdict && 'replay' in A2A_ERRORS && 'conflict' in A2A_ERRORS, missingUsed.join(','));
  ok('对外同答 404 的两种原因共用一个公开桶', A2A_ERRORS['unknown-team'].public === A2A_ERRORS['not-admitted'].public);
  ok('对外同答 no-card 的两种原因共用一个公开桶', A2A_ERRORS['sig:unregistered'].public === A2A_ERRORS['sig:no-card'].public);
  const pubs = new Map();
  for (const [k, v] of entries) { if (!pubs.has(v.public)) pubs.set(v.public, []); pubs.get(v.public).push(k); }
  const merged = [...pubs.entries()].filter(([, ks]) => ks.length > 1).map(([p, ks]) => `${p}=${ks.join('+')}`).sort();
  ok('只有这两处并桶，其余一个原因一个桶', JSON.stringify(merged) === JSON.stringify(['not-found=unknown-team+not-admitted', 'sig:no-card=sig:unregistered+sig:no-card']), JSON.stringify(merged));
}
{
  let stats = null;
  try { stats = await import('../server/src/services/a2a-stats.ts'); } catch (e) { ok('services/a2a-stats.ts 可加载', false, String(e?.message ?? e).slice(0, 160)); }
  if (stats) {
    const { db } = await import('../server/src/db.ts');
    const empty = stats.receiptOutboxStats();
    ok('空表：计数为空、没有待发、没有时长样本', JSON.stringify(empty) === JSON.stringify({ counts: {}, oldest_pending_s: null, recent_delay_s: { samples: 0, median: null, max: null } }), JSON.stringify(empty));
    ok('事件投递表没建时不抛错', stats.eventDeliveryStats().counts === null);
    const now = Date.parse('2026-11-11T12:00:00Z');
    const ins = db.prepare('INSERT INTO a2a_outbox (run_id, target_url, payload, status, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(1, 'http://t.invalid/', '{}', 'pending', '2026-11-11 11:50:00', '');
    ins.run(2, 'http://t.invalid/', '{}', 'pending', '2026-11-11 11:59:00', '');
    ins.run(3, 'http://t.invalid/', '{}', 'dead', '2026-11-11 10:00:00', '');
    ins.run(4, 'http://t.invalid/', '{}', 'sent', '2026-11-11 10:00:00', '2026-11-11 10:00:02');
    ins.run(5, 'http://t.invalid/', '{}', 'sent', '2026-11-11 10:00:00', '2026-11-11 10:00:10');
    ins.run(6, 'http://t.invalid/', '{}', 'sent', '2026-11-11 10:00:00', '2026-11-11 10:01:00');
    const s = stats.receiptOutboxStats(now);
    ok('按状态计数', JSON.stringify(s.counts) === JSON.stringify({ dead: 1, pending: 2, sent: 3 }), JSON.stringify(s.counts));
    ok('最老一条待发 600 秒', s.oldest_pending_s === 600, String(s.oldest_pending_s));
    ok('回执时长：3 个样本、中位数 10 秒、最大 60 秒', s.recent_delay_s.samples === 3 && s.recent_delay_s.median === 10 && s.recent_delay_s.max === 60, JSON.stringify(s.recent_delay_s));
    const health = await import('../server/src/a2a/health.ts');
    const h = health.a2aHealth({ directSig: 'accept', directSigBody: 'accept' }, now);
    const text = JSON.stringify(h);
    ok('健康块不出出站目标地址', !text.includes('t.invalid'), text.slice(0, 200));
    ok('健康块形状：叶子只许数字、null、固定枚举、ISO 时间', shapeProblems(h).length === 0, shapeProblems(h).join('; '));
    // H15：dead 行即使带 sent_at 也不进时长样本；H13：偶数个样本取中间两个的平均
    ins.run(7, 'http://t.invalid/', '{}', 'dead', '2026-11-11 10:00:00', '2026-11-11 10:30:00');
    ok('dead 行带 sent_at 不进时长样本', stats.receiptOutboxStats(now).recent_delay_s.samples === 3);
    ins.run(8, 'http://t.invalid/', '{}', 'sent', '2026-11-11 10:00:00', '2026-11-11 10:01:40');
    const even = stats.receiptOutboxStats(now).recent_delay_s;
    ok('偶数个样本（2/10/60/100 秒）→ 中位数 35 秒', even.samples === 4 && even.median === 35 && even.max === 100, JSON.stringify(even));
    // H20：读数缓存 5 秒（a2aHealth 收 now）
    health.resetA2aHealthCache();
    const t0 = now + 3_600_000;
    const first = health.a2aHealth({ directSig: 'accept', directSigBody: 'accept' }, t0).outbox.receipts.counts;
    ins.run(9, 'http://t.invalid/', '{}', 'pending', '2026-11-11 12:00:00', '');
    const cached = health.a2aHealth({ directSig: 'accept', directSigBody: 'accept' }, t0 + 4_999).outbox.receipts.counts;
    const fresh = health.a2aHealth({ directSig: 'accept', directSigBody: 'accept' }, t0 + 5_000).outbox.receipts.counts;
    ok('5 秒内读缓存（新行不出现），满 5 秒重读', cached.pending === first.pending && fresh.pending === first.pending + 1, JSON.stringify({ first, cached, fresh }));
    // H16：读数出错不抛（表没了）
    db.exec('DROP TABLE a2a_outbox');
    health.resetA2aHealthCache();
    let threw = '';
    let broken = null;
    try { broken = health.a2aHealth({ directSig: 'accept', directSigBody: 'accept' }, t0 + 20_000); } catch (e) { threw = String(e?.message ?? e); }
    ok('出站表读不了 → 不抛错，计数为 null', threw === '' && broken?.outbox?.receipts?.counts === null, threw || JSON.stringify(broken));
  }
}

/** H9：a2a 块的叶子只许数字、null、固定枚举、ISO 时间；多出一个地址字段就会被抓到 */
function shapeProblems(block, path = 'a2a', out = []) {
  const ENUMS = new Set(['accept', 'require', 'off', 'on', 'sqlite']);
  if (block === null || typeof block === 'number') return out;
  if (typeof block === 'string') {
    if (!(ENUMS.has(block) || (path.endsWith('.since') && !Number.isNaN(Date.parse(block)) && /^\d{4}-\d{2}-\d{2}T/.test(block)))) out.push(`${path}=${JSON.stringify(block)}`);
    return out;
  }
  if (typeof block === 'object' && !Array.isArray(block)) { for (const [k, v] of Object.entries(block)) shapeProblems(v, `${path}.${k}`, out); return out; }
  out.push(`${path} 类型 ${Array.isArray(block) ? 'array' : typeof block}`);
  return out;
}

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status === 200) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const reserve = createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r)); const PORT = reserve.address().port; await new Promise((r) => reserve.close(r));
const BASE = `http://127.0.0.1:${PORT}`;
const gh = await startFakeGithub();
function boot(extra = {}) {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: 'server',
    env: { ...process.env, DATA_DIR: `../${HTTP_DATA}`, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', ADMIN_TOKEN: 'health-admin-tok', WM_GITHUB_API: gh.api, WM_A2A_DIRECT_SIG: '', WM_A2A_DIRECT_SIG_BODY: '', A2A_ORIGIN_CLAIM_UNBOUND: '', WM_LOGIN_GATE: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
}
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
const a2aBlock = async () => (await call('GET', '/api/health')).body?.a2a;
const refused = async () => (await a2aBlock())?.refused?.counts ?? {};
function diff(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) { const d = (after[k] ?? 0) - (before[k] ?? 0); if (d) out[k] = d; }
  return out;
}
async function bumps(name, req, expect) {
  const before = await refused();
  const r = await req();
  const d = diff(before, await refused());
  ok(`${name} → 计数 ${JSON.stringify(expect)}`, JSON.stringify(d) === JSON.stringify(expect), `status=${r.status} diff=${JSON.stringify(d)} body=${JSON.stringify(r.body).slice(0, 120)}`);
  return r;
}
const ADMIN = { 'X-Admin-Token': 'health-admin-tok' };
const CALLER = 'dsh/1a2b3c4d';
const RO_CALLER = 'dsh/5e6f7a8b';

let child = boot();
try {
  console.log('二、/api/health 的 a2a 块');
  if (!(await waitReady(BASE + '/api/health'))) throw new Error('实例未就绪（20s 超时）');
  const h0 = (await call('GET', '/api/health')).body;
  const a = h0?.a2a ?? {};
  ok('a2a 块在场', typeof h0?.a2a === 'object', JSON.stringify(h0).slice(0, 200));
  ok('开关生效值：入站签名 accept、body 签名 accept、v1 旧签名 on', a.inbound?.signature === 'accept' && a.inbound?.body_signature === 'accept' && a.outbound?.origin_claim_v1 === 'on', JSON.stringify(a));
  ok('名片有效期 45 小时', a.card?.ttl_s === 45 * 3600);
  ok('幂等：sqlite、窗口 1800 秒', a.idempotency?.store === 'sqlite' && a.idempotency?.window_s === 1800);
  ok('出站积压：回执与事件两张表', a.outbox?.receipts?.counts && typeof a.outbox.receipts.counts === 'object' && a.outbox?.events && 'counts' in a.outbox.events, JSON.stringify(a.outbox));
  ok('拒收计数从零开始，带起点时刻', a.refused && Object.keys(a.refused.counts).length === 0 && !Number.isNaN(Date.parse(a.refused.since)), JSON.stringify(a.refused));
  ok('原有字段不变', h0.ok === true && h0.service === 'workbench-market-server' && 'self_probe' in h0 && 'login_gate' in h0);
  const ready = (await call('GET', '/api/health/ready')).body;
  ok('/api/health/ready 不带 a2a 块', ready && !('a2a' in ready), JSON.stringify(ready).slice(0, 160));

  const pub = await ghPublish(BASE, gh, { slug: 'health-sop', kind: 'sop', title: '健康 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: 健康 SOP\nsteps:\n  - key: a\n    title: A\n' }] });
  ok('SOP 发布', pub.status === 201, `status=${pub.status}`);
  await call('POST', '/api/sops/health-sop/publish', {}, ADMIN);
  let r = await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'health-sop', agent_node: CALLER, mode: 'run', direction: 'admits' }, ADMIN);
  ok('绑定 run 模式', r.status === 201, JSON.stringify(r.body));
  r = await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'health-sop', agent_node: RO_CALLER, mode: 'read', direction: 'admits' }, ADMIN);
  ok('绑定 read 模式', r.status === 201, JSON.stringify(r.body));
  const card = (await call('GET', '/.well-known/agent-card.json')).body;
  const team = `market/${card.sessionTeams?.[0]?.team?.split('/')[1] ?? ''}`;
  const START = JSON.stringify({ sop: { action: 'start' } });
  const direct = (b) => () => call('POST', '/a2a/direct', b);

  await bumps('缺 team', direct({ message: 'x', caller_session: CALLER }), { 'missing-fields': 1 });
  await bumps('匿名', direct({ team, message: 'x' }), { anonymous: 1 });
  await bumps('team 格式不对', direct({ team: 'nope', message: 'x', caller_session: CALLER }), { 'not-found': 1 });
  await bumps('read 绑定发 start', direct({ team, message: START, caller_session: RO_CALLER, task_id: 'h-ro' }), { 'read-only-binding': 1 });
  await bumps('没有 run 的 context 发 note', direct({ team, message: JSON.stringify({ sop: { action: 'note', text: 'x' } }), caller_session: CALLER, task_id: 'h-note', context_id: 'ctx-none' }), { 'no-run-for-context': 1 });
  await bumps('正常 start 不计', direct({ team, message: START, caller_session: CALLER, task_id: 'h-1', context_id: 'ctx-h' }), {});
  await bumps('重放', direct({ team, message: START, caller_session: CALLER, task_id: 'h-1', context_id: 'ctx-h' }), { replay: 1 });
  await bumps('冲突', direct({ team, message: START + ' ', caller_session: CALLER, task_id: 'h-1', context_id: 'ctx-h' }), { conflict: 1 });
  await bumps('自带回执地址与绑定不符（照常开 run）', direct({ team, message: START, caller_session: CALLER, task_id: 'h-cb', context_id: 'ctx-cb', callback: 'http://elsewhere.invalid/cb' }), { 'callback-mismatch': 1 });
  const big = JSON.stringify({ team, message: 'x'.repeat(520 * 1024), caller_session: CALLER });
  await bumps('超过 512 KiB', () => call('POST', '/a2a/direct', big), { 'payload-too-large': 1 });

  console.log('三、对抗组：公开计数不泄露');
  const unknown = await bumps('查无 SOP（合法格式、不存在的节点号）', direct({ team: 'market/deadbeef', message: START, caller_session: CALLER, task_id: 'h-x1' }), { 'not-found': 1 });
  const unbound = await bumps('SOP 存在但调用方没绑定', direct({ team, message: START, caller_session: 'dsh/ffffffff', task_id: 'h-x2' }), { 'not-found': 1 });
  ok('两者对外应答一致', unknown.status === 404 && unbound.status === 404 && JSON.stringify(unknown.body) === JSON.stringify(unbound.body));
  ok('HTTP 上的健康块形状同样只有数字、null、固定枚举、ISO 时间', shapeProblems(await a2aBlock()).length === 0, shapeProblems(await a2aBlock()).join('; '));
  const text = JSON.stringify(await a2aBlock());
  const leaks = [team, CALLER, RO_CALLER, 'dsh/ffffffff', 'h-1', 'ctx-h', 'health-sop', 'elsewhere.invalid'].filter((s) => text.includes(s));
  ok('健康块里没有团队名、调用方、task_id、context、SOP 名、地址', leaks.length === 0, leaks.join(','));

  console.log('二（续）、入站签名 require');
  await stop(child);
  child = boot({ WM_A2A_DIRECT_SIG: 'require', A2A_ORIGIN_CLAIM_UNBOUND: 'off' });
  if (!(await waitReady(BASE + '/api/health'))) throw new Error('require 模式实例未就绪');
  const b = await a2aBlock();
  ok('开关生效值随配置：require、v1 off', b?.inbound?.signature === 'require' && b?.outbound?.origin_claim_v1 === 'off', JSON.stringify(b));
  ok('重启后拒收计数清零', Object.keys(b?.refused?.counts ?? { x: 1 }).length === 0);
  const r401 = await bumps('无签名 → 401', direct({ team, message: START, caller_session: CALLER, task_id: 'h-s1' }), { 'sig:absent': 1 });
  ok('应答仍是 401', r401.status === 401);
  // H7：带签名、但调用方的绑定上没登记取卡地址（unregistered）→ 对外与「取不到卡」同答，公开计数落进 sig:no-card
  {
    const key = generateKeyPairSync('ed25519').privateKey;
    const ts = Date.now();
    const zone = CALLER.split('/')[0];
    const callerUrl = 'http://127.0.0.1:9/';
    const sig2 = edSign(undefined, Buffer.from(JSON.stringify(['a2a-origin-claim/2', zone, callerUrl, ts, BASE, 'POST', '/a2a/direct'])), key).toString('base64');
    const headers = { 'X-A2A-Caller': zone, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': BASE, 'X-A2A-Caller-Sig2': sig2 };
    const rs = await bumps('签名请求、绑定上没登记取卡地址 → 计进 sig:no-card（与取不到卡并桶）', () => call('POST', '/a2a/direct', { team, message: START, caller_session: CALLER, task_id: 'h-s2' }, headers), { 'sig:no-card': 1 });
    ok('……对外应答写 no-card，不写 unregistered', rs.status === 401 && /\(no-card\)/.test(rs.body?.error ?? '') && !/unregistered/.test(JSON.stringify(rs.body)), JSON.stringify(rs.body));
  }
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  await stop(child);
  await gh.close();
}

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
