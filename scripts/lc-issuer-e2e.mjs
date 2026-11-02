#!/usr/bin/env node
/** 生命周期签发入口端到端（真 ygl-trees 0.116.1 + lifecycle-os 插件，测试模式全新工作区）：
 *  在 $LC_OS_DIR/work/wb-issuer-e2e/<ts>/ 建工作区（不碰运行工作区 ~/.ygl-trees-lc、不改 lifecycle-os 已跟踪文件）→
 *  生成测试签发私钥（目录外、600）并把 identity.yaml 副本里 workbench 公钥换成它（LC_TEST=1 + LC_IDENTITY_FILE）→
 *  tools/sync-principals.cjs 写主体镜像 → 测试模式自报身份搭授权与提议 → 起隔离工作台 + 替身 Odoo，经 HTTP 走统一待办与批准。
 *  另用 server/src/lifecycle.ts 的签发与调用函数直接对插件核验：断言不能复用、为请求 A 签的用于 B 被拒、inbox 断言不能拿来批。
 *  缺引擎或 lifecycle-os → NEEDS-MATERIAL（exit 2），不计 PASS。
 *  环境：LC_OS_DIR（缺省 ~/workspace/lifecycle-os）、YGL_BIN（缺省依次找 lifecycle-os node_modules、~/workspace/ygl-trees 的 0.116.1 构建）。 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PIN = '0.116.1';
const LC_OS = resolve(process.env.LC_OS_DIR || join(homedir(), 'workspace/lifecycle-os'));
const BIN = [process.env.YGL_BIN, join(LC_OS, 'node_modules/.bin/ygl-trees'), join(homedir(), 'workspace/ygl-trees/tmp/wt-0.116.1/dist/bundle/bin.cjs'), join(homedir(), 'workspace/ygl-trees/dist/bundle/bin.cjs')].filter(Boolean).find((p) => existsSync(p));
const needs = (why) => { console.log(`NEEDS-MATERIAL: ${why}`); process.exit(2); };
if (!existsSync(join(LC_OS, 'plugins/ygl-lc/index.js')) || !existsSync(join(LC_OS, 'tools/sync-principals.cjs'))) needs(`lifecycle-os 不在 ${LC_OS}（设 LC_OS_DIR）`);
if (!BIN) needs('找不到 ygl-trees 引擎（设 YGL_BIN）');
const ver = (execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', env: { ...process.env, YGL_NO_UPDATE_CHECK: '1' } }).trim().split('\n')[0].match(/\d+\.\d+\.\d+/) ?? ['?'])[0];
if (ver !== PIN) needs(`引擎 ${ver} ≠ 钉版 ${PIN}（${BIN}）`);

const dir = join(LC_OS, 'work/wb-issuer-e2e', Date.now().toString(36));
const home = join(dir, 'home');
if (resolve(home).startsWith(join(homedir(), '.ygl-trees-lc'))) needs('拒绝在运行工作区下建测试工作区');
mkdirSync(join(dir, 'keys'), { recursive: true, mode: 0o700 });
const base = { ...process.env, YGL_HOME: home, YGL_SESSION: 'lc-proto', YGL_NO_UPDATE_CHECK: '1' };
for (const k of ['LC_ACTOR', 'LC_ACTOR_KIND', 'LC_ASSERTION', 'LC_CLOCK', 'LC_TEST', 'LC_IDENTITY_FILE']) delete base[k];
const y = (args) => execFileSync(process.execPath, [BIN, ...args], { env: base, encoding: 'utf8', cwd: dir });

let pass = 0, fail = 0;
const checks = [];
const ok = (n, c, x = '') => { checks.push({ name: n, ok: !!c, got: c ? undefined : x }); if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

// ---------- 全新工作区（同 lifecycle-os tests/engine.cjs setupHome 的步骤，模型生成到本目录） ----------
mkdirSync(home, { recursive: true });
execFileSync(process.execPath, [join(LC_OS, 'tools/build-model.cjs'), join(LC_OS, 'decl'), join(dir, 'lc-model.json')], { encoding: 'utf8', cwd: LC_OS });
y(['db', 'init']); y(['tree', 'new', 'lc-model']);
y(['node', 'import', '--file', join(dir, 'lc-model.json'), '--tree', 'lc-model', '--merge']); y(['node', 'index', '--tree', 'lc-model']);
y(['plugin', 'install', join(LC_OS, 'plugins/ygl-lc')]);

// 测试签发密钥：私钥 600 放在 work/ 下（workbench-market 仓库外）；identity.yaml 副本只换 workbench 公钥
const { privateKey } = generateKeyPairSync('ed25519');
const keyFile = join(dir, 'keys/workbench.key');
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const rogue = generateKeyPairSync('ed25519').privateKey;
const { signLcAssertion, runLc, loadIssuerKey } = await import('../server/src/lifecycle.ts');
const pubkey = loadIssuerKey(keyFile).pubkey;
const idText = readFileSync(join(LC_OS, 'decl/identity.yaml'), 'utf8');
if (!idText.includes('"__P:ISSUER-KEY-WORKBENCH__"')) needs('decl/identity.yaml 里找不到 workbench 公钥占位');
const idFile = join(dir, 'identity.yaml');
writeFileSync(idFile, idText.replace('"__P:ISSUER-KEY-WORKBENCH__"', `"${pubkey}"`));
const TEST = { LC_TEST: '1', LC_IDENTITY_FILE: idFile };
const lc = (args, extra = {}) => { try { return JSON.parse(execFileSync(process.execPath, [BIN, 'lc', ...args], { env: { ...base, ...TEST, ...extra }, encoding: 'utf8' }).trim().split('\n').pop()); } catch (e) { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } };
const as = (actor, kind, args) => lc(args, { LC_ACTOR: actor, LC_ACTOR_KIND: kind }); // 测试模式自报，只用于搭场景

const users = join(dir, 'users.json');
writeFileSync(users, JSON.stringify([{ login: 'pm-a', account_type: '人' }, { login: 'pm-b', account_type: '人' }, { login: 'owner', account_type: '人' },
  { login: 'ex', account_type: '人', active: false }, { login: 'mapper', account_type: 'agent' }]));
const sync = JSON.parse(execFileSync(process.execPath, [join(LC_OS, 'tools/sync-principals.cjs'), '--users', users],
  { env: { ...base, ...TEST, YGL_BIN: BIN, LC_ACTOR: 'system:odoo-sync', LC_ACTOR_KIND: '系统' }, encoding: 'utf8' }).trim());
ok('主体镜像：sync-principals 写入 5 个主体', sync.synced === 5, JSON.stringify(sync.users));
as('user:owner', '人', ['grant', '--id', 'g-pm', '--grantee', 'user:pm-a', '--grantee-kind', '人', '--domain', '产品', '--from', '2026-01-01T00:00:00+08:00']);
const P = [1, 2, 3, 4].map((n) => {
  as('agent:mapper', 'agent', ['link', '--id', `l-${n}`, '--type', 'sku_of_pd', '--from', `sku-${n}`, '--to', 'pd-1', '--method', '规格推导', '--confidence', '中', '--evidence', `obs-${n}`, '--idempotency-key', `k-link-${n}`]);
  return as('agent:mapper', 'agent', ['propose', '--object', `l-${n}`, '--machine', 'identity_link', '--to', '已确认', '--evidence', `obs-${n}`, '--idempotency-key', `k-confirm-${n}`]).data?.proposal_id;
});
ok('场景：四条待人工确认的提议', P.every((p) => /^p-[0-9a-f]{12}$/.test(String(p))), JSON.stringify(P));

// ---------- 替身 Odoo + 隔离工作台 ----------
const SIDS = { sidA: 'pm-a', sidB: 'pm-b', sidX: 'ex', sidG: 'ghost' };
const sid = (k) => `${k}${'0'.repeat(28)}`;
const odoo = createServer((rq, rs) => {
  let s = ''; rq.on('data', (c) => (s += c)); rq.on('end', () => {
    const got = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(rq.headers.cookie ?? ''))?.[1] ?? '';
    const login = Object.entries(SIDS).find(([k]) => sid(k) === got)?.[1];
    const body = login && rq.url === '/web/session/get_session_info' ? { jsonrpc: '2.0', id: null, result: { uid: 100 + login.length, username: login, is_internal_user: true } } : { jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } };
    rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
});
await new Promise((x) => odoo.listen(0, '127.0.0.1', x));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = resolve('tmp/lc-e2e-' + Date.now().toString(36));
mkdirSync(DATA, { recursive: true });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'lc-e2e',
    LC_YGL_BIN: BIN, LC_YGL_HOME: home, LC_WORKBENCH_KEY_FILE: keyFile, LC_ODOO_URL: `http://127.0.0.1:${odoo.address().port}`, ...TEST },
});
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const http = (method, path, { headers = {}, body } = {}) => new Promise((done) => {
  const rq = request({ host: '127.0.0.1', port: PORT, method, path, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, body: j }); });
  });
  rq.on('error', (e) => done({ status: 0, body: { error: String(e) } }));
  if (body !== undefined) rq.write(body);
  rq.end();
});
const tasksAs = (k) => http('GET', '/api/tasks', { headers: { cookie: `session_id=${sid(k)}` } });
const approveAs = (k, proposal_id, grant = 'g-pm') => http('POST', '/api/lifecycle/approve', { headers: { 'content-type': 'application/json', 'x-wm-lifecycle': '1', cookie: `session_id=${sid(k)}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ proposal_id, grant }) });
const lcItems = (r) => (r.body?.tasks ?? []).filter((t) => t.source === 'lifecycle');
const nonces = () => { const d = new DatabaseSync(join(home, 'ygl-trees.db'), { readOnly: true }); try { return d.prepare('SELECT nonce FROM lc_nonce').all().map((r) => r.nonce); } finally { d.close(); } };
const blobSha = (f) => { const b = readFileSync(f); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
const rejected = (r, re) => r?.status === 'denied' && r.error?.code === 'IDENTITY_REJECTED' && re.test(r.error.message);

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end && (await http('GET', '/api/health')).status !== 200) await new Promise((x) => setTimeout(x, 250));

  console.log('统一待办（HTTP，经工作台现签 inbox 断言）');
  let r = await tasksAs('sidA');
  ok('pm-a 看到四条生命周期待办，授权均为 g-pm', r.body?.sources?.lifecycle?.ok === true && r.body.sources.lifecycle.viewer === 'user:pm-a' && lcItems(r).length === 4 && lcItems(r).every((t) => t.lc?.grant === 'g-pm' && P.includes(t.lc?.proposal_id)), JSON.stringify(r.body?.sources?.lifecycle));
  r = await tasksAs('sidB');
  ok('没有授权的 pm-b 生命周期待办为空（源 ok）', r.body?.sources?.lifecycle?.ok === true && lcItems(r).length === 0, JSON.stringify(r.body?.sources?.lifecycle));
  r = await tasksAs('sidX');
  ok('停用账号 ex：lc 拒，脱敏错误码且源不出条目', r.body?.sources?.lifecycle?.ok === false && r.body.sources.lifecycle.error === 'lifecycle_source_unavailable' && lcItems(r).length === 0, JSON.stringify(r.body?.sources?.lifecycle));
  r = await tasksAs('sidG');
  ok('Odoo 有、主体镜像没有的 ghost：lc 拒，错误脱敏', r.body?.sources?.lifecycle?.ok === false && r.body.sources.lifecycle.error === 'lifecycle_source_unavailable', JSON.stringify(r.body?.sources?.lifecycle));

  console.log('HTTP审批只读遏制（不出示断言、不写审批账本）');
  const n0 = nonces().length;
  for (const [who, proposal] of [['sidA', P[0]], ['sidB', P[1]], ['sidG', P[1]], ['sidA', 'p-000000000000']]) {
    r = await approveAs(who, proposal);
    ok(who + ' HTTP批准被硬拒', r.status === 503 && r.body?.error?.code === 'LC_APPROVAL_READ_ONLY');
  }
  ok('HTTP拒绝不新增nonce', nonces().length === n0);
  ok('HTTP拒绝不写审批账本', !lc(['ledger']).data.ledger.some(x => x.kind === 'approve'));
  r = await tasksAs('sidA');
  ok('只读待办仍四条', lcItems(r).length === 4);

  console.log('断言一次性与请求绑定（直接对插件出示 lifecycle.ts 签的断言）');
  process.env.LC_TEST = '1'; process.env.LC_IDENTITY_FILE = idFile; // runLc 只在本进程 LC_TEST=1 时透传测试模式
  const cfg = { bin: BIN, home };
  const key = loadIssuerKey(keyFile).key;
  const sign = (sub, action, flags, o = {}) => signLcAssertion(o.key ?? key, { sub, action, flags, ...o });
  const ap = (p) => ({ proposal: p, grant: 'g-pm' });
  const forP3 = sign('user:pm-a', 'approve', ap(P[2]));
  let x = await runLc(cfg, 'approve', ap(P[3]), forP3);
  ok('为 P3（请求 A）签的断言拿去批 P4（请求 B）→ 拒「不是这个请求」', rejected(x.envelope, /不是这个请求/), JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'approve', ap(P[2]), forP3);
  ok('被拒过一次的断言作废：回到 P3 也拒「已经用过」', rejected(x.envelope, /已经用过/), JSON.stringify(x.envelope?.error));
  const tIn = sign('user:pm-a', 'inbox', {});
  x = await runLc(cfg, 'inbox', {}, tIn);
  ok('inbox 断言首次出示：applied', x.envelope?.status === 'applied' && Array.isArray(x.envelope.data?.items), JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'inbox', {}, tIn);
  ok('同一张 inbox 断言第二次出示 → 拒「已经用过」', rejected(x.envelope, /已经用过/), JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'approve', ap(P[2]), sign('user:pm-a', 'inbox', {}));
  ok('inbox 断言拿去批 P3 → 拒「不是这个请求」', rejected(x.envelope, /不是这个请求/), JSON.stringify(x.envelope?.error));
  const tOk = sign('user:pm-a', 'approve', ap(P[2]));
  x = await runLc(cfg, 'approve', ap(P[2]), tOk);
  ok('为 P3 新签一张就能批', x.envelope?.status === 'applied', JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'approve', ap(P[2]), tOk);
  ok('批成功的断言也只能用一次（重放 → 已经用过）', rejected(x.envelope, /已经用过/), JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'inbox', {}, sign('user:pm-a', 'inbox', {}, { key: rogue }));
  ok('别的私钥签的断言 → 拒「签名不对」', rejected(x.envelope, /签名不对/), JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'inbox', {}, sign('user:pm-a', 'inbox', {}, { now: Math.floor(Date.now() / 1000) - 1000 }));
  ok('过期断言 → 拒', rejected(x.envelope, /过期/), JSON.stringify(x.envelope?.error));
  x = await runLc(cfg, 'approve', ap(P[3]), sign('user:pm-b', 'approve', ap(P[3])));
  ok('给 pm-b 签的真断言：身份是 pm-b，没授权批不了（GATE_DENIED）', x.envelope?.status === 'denied' && x.envelope.error?.code === 'GATE_DENIED', JSON.stringify(x.envelope?.error));

  console.log('收尾');
  r = await approveAs('sidA', P[3]);
  ok('HTTP批P4仍只读拒绝', r.status === 503 && r.body?.error?.code === 'LC_APPROVAL_READ_ONLY');
  r = await tasksAs('sidA');
  ok('HTTP只读拒绝不使收件箱缓存失效（直接插件写入另算）', r.body?.sources?.lifecycle?.ok === true && lcItems(r).some(t => t.lc?.proposal_id === P[0]) && lcItems(r).some(t => t.lc?.proposal_id === P[3]));
  const all = nonces();
  ok('lc_nonce 无重复（每张断言 nonce 独一）', new Set(all).size === all.length && all.length > 0, `${all.length}`);
} catch (e) {
  ok('端到端运行', false, String(e?.stack ?? e));
} finally {
  server.kill(); odoo.close();
  await new Promise((x) => setTimeout(x, 400));
  rmSync(DATA, { recursive: true, force: true });
}
const summary = { engine: { bin: BIN, version: ver }, lifecycle_os: LC_OS, dir, pass, fail, checks };
mkdirSync('tmp', { recursive: true });
writeFileSync('tmp/lc-issuer-e2e-summary.json', JSON.stringify(summary, null, 2));
if (fail && serverErr) console.log(serverErr.slice(-2000));
console.log(`lc-issuer-e2e: ${pass} passed / ${fail} failed（工作区 ${dir}，摘要 tmp/lc-issuer-e2e-summary.json）`);
process.exitCode = fail ? 1 : 0;
