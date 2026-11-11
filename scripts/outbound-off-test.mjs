#!/usr/bin/env node
/**
 * 对外断开（WM_OUTBOUND=off）的对抗组：一个记账的假网络，证明打开开关的进程真的一个都没往外发。
 *
 * 假网络在本测试进程里（被测的是子进程，闸管不到这里）：一个 TCP 监听、一个 UDP 监听、一个 Unix 域套接字，只记账。
 *
 *   第一组（进程层）：子进程只装闸，然后用每一种办法往假网络发——fetch、http.request、https.request、net.connect、
 *     tls.connect、http2.connect、Unix 域套接字、带域名的 fetch（要做 DNS）、dns.lookup、dns.resolve4、Resolver、
 *     UDP send、spawn、execFileSync、new Worker。每一种都必须报 EOUTBOUNDOFF，假网络收到 0 个；连自己听的端口照常通。
 *   第二组（实例层）：起一个打开开关的市场实例。库里所有对外地址都指向假网络——台地址（/go/、探活）、通知绑定、
 *     投递目标、回执 outbox、准入绑定（验签取卡）、库里的巡检间隔、MCP 上游、沙箱桥，再造一个过时的豁免面快照逼出启动通知；
 *     环境变量里 Odoo、Redis、LayerFS、A2A 状态源、GitHub、评估网关也都指向它。然后把触发点逐个走一遍：
 *     等两轮 worker、提交台数据（新事件 + 立即试投）、check-all、/go/ 反代、管理员 A2A 发送、入站 /a2a/direct 带签名头（取卡）、
 *     带 Odoo 会话 cookie 认人、app_sync 拉 GitHub。断言：假网络收到 0 个连接；投递和回执 outbox 仍是 pending、attempts 不变；
 *     健康检查和就绪检查都报 outbound；自检里有「对外已断开」那一行。
 *   对照组（先红后绿）：同样两组不开开关重跑，假网络必须收到连接——证明本测试看得见出站。
 *   非法值（WM_OUTBOUND=disabled）拒绝启动。
 *
 *   node scripts/outbound-off-test.mjs              测本仓库
 *   node scripts/outbound-off-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer as tcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `outbound-off-${process.pid}-${Date.now().toString(36)}`);
const ADMIN = 'outbound-synthetic-admin';
const GATE = pathToFileURL(join(ROOT, 'server', 'src', 'outbound-gate.ts')).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = tcpServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** 假网络：TCP、UDP、Unix 域套接字各一个，只记账 */
async function fakeNet(dir) {
  mkdirSync(dir, { recursive: true });
  const seen = { tcp: 0, udp: 0, unix: 0 };
  const socks = new Set();
  const answer = (sock) => { socks.add(sock); sock.on('close', () => socks.delete(sock)); sock.on('error', () => {}); sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); };
  const tcp = tcpServer((s) => { seen.tcp++; answer(s); });
  const tcpPort = await new Promise((ok) => tcp.listen(0, '127.0.0.1', () => ok(tcp.address().port)));
  const udp = createSocket('udp4'); udp.on('message', () => { seen.udp++; });
  const udpPort = await new Promise((ok) => udp.bind(0, '127.0.0.1', () => ok(udp.address().port)));
  // Unix 域套接字的路径有长度上限（macOS 104 字节），放在系统临时目录的短路径下
  const sockDir = mkdtempSync(join(tmpdir(), 'wmo-'));
  const unixPath = join(sockDir, 's');
  const unix = tcpServer((s) => { seen.unix++; answer(s); });
  await new Promise((ok) => unix.listen(unixPath, ok));
  return { seen, tcpPort, udpPort, unixPath, url: `http://127.0.0.1:${tcpPort}`, close: () => { for (const x of socks) x.destroy(); return Promise.all([new Promise((r) => tcp.close(r)), new Promise((r) => unix.close(r)), new Promise((r) => udp.close(r))]).then(() => rmSync(sockDir, { recursive: true, force: true })); }};
}

// ---------- 第一组：进程层 ----------
const PROBE = (net) => `
await import(${JSON.stringify(GATE)});
const results = {};
const code = (e) => e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code ?? String(e?.message ?? e).slice(0, 80);
// 每一种最多等 2 秒：不开开关的对照里，DNS 之类真的会去问网络，可能很久才回
const tryIt = async (name, fn) => { let t; try { await Promise.race([Promise.resolve().then(fn), new Promise((_, no) => { t = setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 2000); })]); results[name] = 'sent'; } catch (e) { results[name] = code(e); } finally { clearTimeout(t); } };
const ev = (emitter) => new Promise((ok, no) => { emitter.once('error', no); emitter.once('connect', () => { emitter.destroy?.(); ok(); }); });
const http = await import('node:http'), https = await import('node:https'), netm = await import('node:net'), tls = await import('node:tls'), http2 = await import('node:http2');
const dns = await import('node:dns'), dgram = await import('node:dgram'), cp = await import('node:child_process'), wt = await import('node:worker_threads');
const U = ${JSON.stringify(net.url)}, P = ${net.tcpPort};
await tryIt('fetch', () => fetch(U + '/x', { signal: AbortSignal.timeout(3000) }));
await tryIt('fetch-hostname', () => fetch('http://peer.synthetic.invalid:' + P + '/x', { signal: AbortSignal.timeout(3000) }));
await tryIt('http.request', () => new Promise((ok, no) => { const r = http.request(U + '/x', (res) => { res.resume(); ok(); }); r.on('error', no); r.end(); }));
await tryIt('https.request', () => new Promise((ok, no) => { const r = https.request('https://127.0.0.1:' + P + '/x', { rejectUnauthorized: false }, (res) => { res.resume(); ok(); }); r.on('error', no); r.end(); }));
await tryIt('net.connect', () => ev(netm.connect(P, '127.0.0.1')));
await tryIt('net.connect-options', () => ev(netm.createConnection({ host: '127.0.0.1', port: P })));
await tryIt('tls.connect', () => new Promise((ok, no) => { const s = tls.connect({ host: '127.0.0.1', port: P, rejectUnauthorized: false }); s.once('error', no); s.once('secureConnect', ok); }));
// http2 拿到套接字就会先报 connect（哪怕套接字随即被拦），所以要真发一个请求、收到应答才算发出去了
await tryIt('http2.request', () => new Promise((ok, no) => { const s = http2.connect(U); s.once('error', no); const q = s.request({ ':path': '/x' }); q.once('error', no); q.once('response', () => { s.close(); ok(); }); q.end(); }));
await tryIt('unix-socket', () => ev(netm.connect(${JSON.stringify(net.unixPath)})));
await tryIt('dns.lookup', () => new Promise((ok, no) => dns.lookup('peer.synthetic.invalid', (e) => (e ? no(e) : ok()))));
await tryIt('dns.promises.lookup', () => dns.promises.lookup('peer.synthetic.invalid'));
await tryIt('dns.resolve4', () => new Promise((ok, no) => dns.resolve4('peer.synthetic.invalid', (e) => (e ? no(e) : ok()))));
await tryIt('dns.Resolver', () => new dns.promises.Resolver().resolve4('peer.synthetic.invalid'));
await tryIt('udp.send', () => new Promise((ok, no) => { const s = dgram.createSocket('udp4'); try { s.send('x', ${net.udpPort}, '127.0.0.1', (e) => { s.close(); e ? no(e) : ok(); }); } catch (e) { s.close(); no(e); } }));
await tryIt('spawn', () => { cp.spawn(process.execPath, ['-e', '0']); });
await tryIt('execFileSync', () => { cp.execFileSync(process.execPath, ['-e', '0']); });
await tryIt('worker', () => { new wt.Worker('process.exit(0)', { eval: true }).terminate(); });
// 自己听的端口照常通
const own = http.createServer((q, s) => s.end('own'));
await new Promise((ok) => own.listen(0, '127.0.0.1', ok));
await tryIt('own-port', async () => { const r = await fetch('http://127.0.0.1:' + own.address().port + '/'); if ((await r.text()) !== 'own') throw new Error('bad'); });
own.close();
console.log('RESULTS ' + JSON.stringify(results));
process.exit(0);
`;
async function processLayer(dir, off) {
  const net = await fakeNet(dir);
  const file = join(dir, `probe-${off ? 'off' : 'on'}.mjs`);
  writeFileSync(file, PROBE(net));
  const r = await new Promise((ok) => {
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, HOME: dir, ...(off ? { WM_OUTBOUND: 'off' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', () => ok(out));
  });
  await sleep(300);
  const seen = { ...net.seen };
  await net.close();
  const m = /RESULTS (.*)/.exec(r);
  return { results: m ? JSON.parse(m[1]) : null, seen, raw: r.slice(-600) };
}

// ---------- 第二组：实例层 ----------
function seed(dataDir, url) {
  const code = `
const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
const cols = (t) => new Set(db.prepare('PRAGMA table_info("' + t + '")').all().map((c) => c.name));
const ins = (t, row) => { const c = cols(t); const ks = Object.keys(row).filter((k) => c.has(k)); return Number(db.prepare('INSERT INTO "' + t + '" (' + ks.join(',') + ') VALUES (' + ks.map(() => '?').join(',') + ')').run(...ks.map((k) => row[k])).lastInsertRowid); };
const U = ${JSON.stringify(url)};
const wid = ins('workbenches', { name: '外部台', url: U + '/', type: 'web', enabled: 1, health_path: '/' });
const app = ins('apps', { slug: 'syn-form', title: '合成表单', description: 'x', created_by: 'mcp:synthetic', active_version: 1, status: 'published', kind: 'app', source_repo: 'example/synthetic', source_path: 'syn-form', a2a_node8: '0a1b2c3d' });
ins('app_versions', { app_id: app, version: 1, file_count: 1, total_bytes: 1, created_by: 'mcp:synthetic', changelog: 'x', source_commit: '0'.repeat(40) });
ins('bindings', { target_type: 'app', target_slug: 'syn-form', agent_node: 'syn/1a2b3c4d', direction: 'notify', mode: 'read', notify_url: U + '/a2a', created_by: 'mcp:synthetic' });
ins('bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'syn/1a2b3c4d', direction: 'admits', mode: 'write', notify_url: U, created_by: 'mcp:synthetic' });
ins('workbench_events', { event_id: 'wbe-0000000000000001', source: 'app-data', workbench: 'syn-form', item: 'item:1', context_id: 'ctx-1', submitter_kind: 'human', submitter: 'h', data_sha256: '0'.repeat(64), dispatch: 1, routed: 'target' });
ins('workbench_event_deliveries', { event_id: 'wbe-0000000000000001', target_team: 'syn/1a2b3c4d', target_url: U, caller_session: 'market/synthetic', status: 'pending', message: '{}', attempts: 0, next_at: '2000-01-01 00:00:00' });
ins('a2a_outbox', { run_id: 1, task_id: 't', context_id: 'c', target_url: U, payload: '{}', status: 'pending', attempts: 0, next_at: '2000-01-01 00:00:00' });
// 人的答复发回席位（阶段七 R2）：一条到期的答复，目标是假网络
ins('workbench_event_replies', { kind: 'answer', event_id: 'wbe-0000000000000001', delivery_id: 1, ref: 1, qid: 'q1', team: 'syn/1a2b3c4d', caller_session: 'market/synthetic', context_id: 'ctx-1', target_url: U, message: JSON.stringify({ text: '合成答复', by: 'user:alpha' }), status: 'pending', attempts: 0, next_at: '2000-01-01 00:00:00', created_at: '2000-01-01 00:00:00' });
for (const [k, v] of [['health_interval_seconds', '10'], ['mcp_upstreams', JSON.stringify([{ prefix: 'syn', url: U + '/mcp', enabled: true }])], ['sandbox_bridge_url', U]]) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
db.prepare('INSERT INTO remote_allow_state (snapshot) VALUES (?)').run('[]');
console.log('SEEDED ' + wid);`;
  const f = join(dataDir, '..', 'seed.mjs'); writeFileSync(f, code);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', f], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir }, encoding: 'utf8' });
  const m = /SEEDED (\d+)/.exec(r.stdout || '');
  if (!m) throw new Error('灌数据失败：' + (r.stderr || '').slice(-800));
  return Number(m[1]);
}
async function boot(dataDir, env) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir, ADMIN_TOKEN: ADMIN, PORT: String(port), MARKET_PUBLIC_URL: base, A2A_OUTBOX_BACKOFF_SCALE: '0.001', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) return { ok: false, log };
    try { if ((await fetch(base + '/api/health')).status === 200) break; } catch { /* 还没起来 */ }
    if (i > 300) { child.kill('SIGKILL'); return { ok: false, log }; }
    await sleep(100);
  }
  const call = async (method, path, body, headers = {}) => {
    try {
      const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
      let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
      return { status: r.status, body: j };
    } catch (e) { return { status: 0, body: String(e) }; }
  };
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 8000); child.once('exit', () => { clearTimeout(t); r(); }); }); } };
  return { ok: true, base, call, stop, log: () => log };
}
async function instanceLayer(dir, off) {
  const net = await fakeNet(dir);
  const data = join(dir, 'data'); mkdirSync(data, { recursive: true });
  const env = {
    WM_ODOO_URL: net.url, REDIS_URL: `redis://127.0.0.1:${net.tcpPort}`, LAYERFS_SERVICE_URL: net.url, A2A_STATE_URL: net.url, A2A_API_KEY: 'x',
    WM_GITHUB_API: net.url, EVAL_GATEWAY_URL: net.url, AI_GATEWAY_API_KEY: 'x', ...(off ? { WM_OUTBOUND: 'off' } : {}),
  };
  // 先起一次建表（事件表随任务中心初始化才建），再灌数据
  let I = await boot(data, { ...env, REDIS_URL: '' });
  if (!I.ok) throw new Error('建表那次没起来：' + I.log.slice(-600));
  await I.stop();
  const wid = seed(data, net.url);
  const before = { ...net.seen };
  I = await boot(data, env);
  if (!I.ok) { await net.close(); return { boot: false, log: I.log.slice(-800) }; }
  const A = { 'x-admin-token': ADMIN };
  const hits = {};
  await sleep(4000); // 豁免面变更通知在启动 3 秒后
  hits.appData = (await I.call('POST', '/api/apps/syn-form/data', { data: { a: 1 } })).status;
  hits.checkAll = (await I.call('POST', '/api/check-all', undefined, A)).status;
  hits.go = (await I.call('GET', `/go/${wid}/`, undefined, A)).status;
  hits.a2aSend = (await I.call('POST', '/api/a2a/send', { target_url: net.url, team: 'syn/1a2b3c4d', message: 'x' }, A)).status;
  hits.direct = (await I.call('POST', '/a2a/direct', { team: 'market/00000000', message: 'x', caller_session: 'syn/1a2b3c4d' },
    { 'x-a2a-caller': 'syn', 'x-a2a-caller-url': net.url, 'x-a2a-caller-ts': String(Date.now()), 'x-a2a-caller-aud': I.base, 'x-a2a-caller-sig2': 'AAAA' })).status;
  hits.odooViewer = (await I.call('GET', '/api/auth/viewer', undefined, { cookie: 'session_id=0123456789abcdef0123456789abcdef' })).status;
  hits.appSync = (await I.call('POST', '/api/apps/syn-form/sync', {}, A)).status;
  await sleep(11000); // 两轮 worker（5 秒一轮）+ 巡检间隔 10 秒
  const anon = (await I.call('GET', '/api/health')).body;
  const ready = (await I.call('GET', '/api/health/ready')).body;
  const adm = (await I.call('GET', '/api/health', undefined, A)).body;
  await I.stop();
  await sleep(300);
  const seen = { tcp: net.seen.tcp - before.tcp, udp: net.seen.udp - before.udp, unix: net.seen.unix - before.unix };
  await net.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const deliveries = db.prepare('SELECT status, attempts FROM workbench_event_deliveries ORDER BY id').all();
  const outbox = db.prepare('SELECT status, attempts FROM a2a_outbox ORDER BY id').all();
  const replies = db.prepare('SELECT status, attempts FROM workbench_event_replies ORDER BY id').all();
  db.close();
  return { boot: true, seen, hits, anon, ready, adm, deliveries, outbox, replies };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  console.log('== 第一组：进程层（闸本身）');
  const pOff = await processLayer(join(OUT, 'p-off'), true).catch((e) => ({ results: null, raw: String(e) }));
  const pOn = await processLayer(join(OUT, 'p-on'), false).catch((e) => ({ results: null, raw: String(e) }));
  if (!pOff.results) check(false, '进程层（开关打开）跑完', pOff.raw);
  else {
    const blockedKinds = Object.keys(pOff.results).filter((k) => k !== 'own-port');
    const leaks = blockedKinds.filter((k) => pOff.results[k] !== 'EOUTBOUNDOFF');
    check(leaks.length === 0, `打开开关：${blockedKinds.length} 种出站办法一律在发出前被拦（EOUTBOUNDOFF）`, show(Object.fromEntries(leaks.map((k) => [k, pOff.results[k]]))));
    check(pOff.seen.tcp === 0 && pOff.seen.udp === 0 && pOff.seen.unix === 0, '打开开关：假网络收到 0 个 TCP 连接、0 个 UDP 包、0 个 Unix 连接', show(pOff.seen));
    check(pOff.results['own-port'] === 'sent', '打开开关：连自己听的端口照常通');
  }
  if (!pOn.results) check(false, '进程层（对照）跑完', pOn.raw);
  else check(pOn.seen.tcp > 0 && pOn.seen.udp > 0 && pOn.seen.unix > 0 && pOn.results.spawn === 'sent', '对照（不开开关）：假网络收到 TCP、UDP、Unix 连接，子进程起得来——本测试看得见出站', show(pOn.seen));

  console.log('== 第二组：实例层（真实入口、库里和环境里所有对外地址都指向假网络）');
  const off = await instanceLayer(join(OUT, 'i-off'), true);
  if (!off.boot) check(false, '打开开关的实例起来了', off.log);
  else {
    check(off.seen.tcp === 0 && off.seen.udp === 0 && off.seen.unix === 0, '打开开关：整个过程假网络收到 0 个连接', show({ seen: off.seen, hits: off.hits }));
    check(off.hits.appData === 201, `台数据照常能提交（新事件建了，投递挂着）`, show(off.hits.appData));
    check(off.hits.checkAll === 503, 'check-all 拒绝探活（503），不把副本里的台都记成离线', show(off.hits.checkAll));
    check(off.deliveries.length >= 2 && off.deliveries.every((d) => d.status === 'pending' && d.attempts === 0), `投递全部仍是 pending、attempts 都是 0（${off.deliveries.length} 条，含刚提交的）`, show(off.deliveries));
    check(off.outbox.every((o) => o.status === 'pending' && o.attempts === 0), '回执 outbox 仍是 pending、attempts 0', show(off.outbox));
    check(off.replies.length === 1 && off.replies.every((o) => o.status === 'pending' && o.attempts === 0), '人的答复发回席位（阶段七 R2）仍是 pending、attempts 0', show(off.replies));
    check(show(off.anon?.outbound) === '{"mode":"off"}' && show(off.ready?.outbound) === '{"mode":"off"}', '健康检查、就绪检查匿名都能看到 outbound: off（不给计数）', show([off.anon?.outbound, off.ready?.outbound]));
    const row = off.anon?.self_probe?.rows?.find((r) => r.id === 'market.outbound.disconnected');
    check(row?.verdict === 'pass' && off.anon?.self_probe?.passed === true, '启动自检里有「对外已断开」这一行，并且通过', show(row));
    const b = off.adm?.outbound?.blocked ?? {};
    const need = ['event-delivery', 'receipt-outbox', 'allow-notify', 'health-patrol', 'health-check', 'tcp'];
    check(need.every((k) => (b[k] ?? 0) > 0), `管理员能看到各类被拦的计数（${need.join('、')} 都 > 0）`, show(b));
  }
  const on = await instanceLayer(join(OUT, 'i-on'), false);
  if (!on.boot) check(false, '对照实例起来了', on.log);
  else check(on.seen.tcp > 0 && (on.deliveries.some((d) => d.attempts > 0 || d.status !== 'pending') || on.outbox.some((o) => o.attempts > 0)) && on.replies.some((o) => o.attempts > 0 || o.status !== 'pending') && on.anon?.outbound === undefined,
    '对照（不开开关）：假网络收到连接、投递或回执被试过、健康检查里没有 outbound——本测试看得见实例的出站', show({ seen: on.seen, d: on.deliveries, o: on.outbox }));

  console.log('== 非法值');
  const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `await import(${JSON.stringify(GATE)})`, '--input-type=module'], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, WM_OUTBOUND: 'disabled' }, encoding: 'utf8' });
  check(bad.status !== 0 && /WM_OUTBOUND 只能是 on 或 off/.test(bad.stderr), 'WM_OUTBOUND=disabled：拒绝启动', bad.stderr.slice(-200));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
