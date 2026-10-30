#!/usr/bin/env node
/** 生命周期全景端到端（真 ygl-trees 0.116.1 + lifecycle-os lc board，测试模式全新回放工作区）：
 *  lifecycle-os tests/replay-2611.cjs --fresh-home 建场景（$LC_OS_DIR/work/replay/wb-board-e2e-<ts>，不碰运行工作区 ~/.ygl-trees-lc）→
 *  lc anchor --out 出锚点文件（LC_LEDGER/LC_ANCHOR_DIR 指过去）→ 起隔离工作台 + 替身 Odoo →
 *  GET /api/lifecycle/board?as_of=2026-12-18T18:00:00+08:00 核对 6 个产品、5 条卡点、2 条未确认关系、带锚点 tamper_evident:true；
 *  再改坏锚点文件一行，换 as_of 重取，核对锚点对不上（anchor_ok:false；lc 未升级时 tamper_evident:false）。
 *  --serve：核对后不退出，打印端口与替身 Odoo 会话 cookie，供浏览器看页面与截图。
 *  缺引擎或 lifecycle-os → NEEDS-MATERIAL（exit 2），不计 PASS。环境同 lc-issuer-e2e：LC_OS_DIR、YGL_BIN。 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PIN = '0.116.1';
const AS_OF = '2026-12-18T18:00:00+08:00';
const SERVE = process.argv.includes('--serve');
const LC_OS = resolve(process.env.LC_OS_DIR || join(homedir(), 'workspace/lifecycle-os'));
const BIN = [process.env.YGL_BIN, join(homedir(), '.local/share/yuanguang-lifecycle-os/engine', PIN, 'dist/bundle/bin.cjs'), join(LC_OS, 'node_modules/.bin/ygl-trees'), join(homedir(), 'workspace/ygl-trees/tmp/wt-0.116.1/dist/bundle/bin.cjs')].filter(Boolean).find((p) => existsSync(p));
const needs = (why) => { console.log(`NEEDS-MATERIAL: ${why}`); process.exit(2); };
if (!existsSync(join(LC_OS, 'tests/replay-2611.cjs'))) needs(`lifecycle-os 不在 ${LC_OS}（设 LC_OS_DIR）`);
if (!BIN) needs('找不到 ygl-trees 引擎（设 YGL_BIN）');
const ver = (execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', env: { ...process.env, YGL_NO_UPDATE_CHECK: '1' } }).trim().split('\n')[0].match(/\d+\.\d+\.\d+/) ?? ['?'])[0];
if (ver !== PIN) needs(`引擎 ${ver} ≠ 钉版 ${PIN}（${BIN}）`);

const home = join(LC_OS, 'work/replay', `wb-board-e2e-${Date.now().toString(36)}`);
if (resolve(home).startsWith(join(homedir(), '.ygl-trees-lc'))) needs('拒绝在运行工作区下建测试工作区');
const env0 = { ...process.env, YGL_BIN: BIN, YGL_NO_UPDATE_CHECK: '1' };
for (const k of ['LC_ACTOR', 'LC_ACTOR_KIND', 'LC_ASSERTION', 'LC_CLOCK', 'YGL_HOME']) delete env0[k];
const replay = JSON.parse(execFileSync(process.execPath, ['tests/replay-2611.cjs', '--fresh-home', home, '--out', join(home, 'export.sql')], { cwd: LC_OS, env: env0, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').pop());
const tag = replay.tag;
const ANCH = join(home, 'anchors');
mkdirSync(ANCH, { recursive: true });
const anchorFile = join(ANCH, 'e2e.jsonl');
execFileSync(process.execPath, [BIN, 'lc', 'anchor', '--out', anchorFile], { env: { ...env0, YGL_HOME: home, YGL_SESSION: 'lc-proto', LC_TEST: '1' }, encoding: 'utf8' });
const goodAnchor = readFileSync(anchorFile, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
ok('回放场景：链一致、内核看板自检全过', replay.chain_consistent === true && replay.board?.failed?.length === 0, JSON.stringify(replay.board));

const SID = 'sidE2E' + '0'.repeat(26);
const odoo = createServer((rq, rs) => {
  rq.resume(); rq.on('end', () => {
    const got = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(rq.headers.cookie ?? ''))?.[1] ?? '';
    rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(got === SID ? { jsonrpc: '2.0', id: null, result: { uid: 9, username: 'pm-a', is_internal_user: true } } : { jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } }));
  });
});
await new Promise((x) => odoo.listen(0, '127.0.0.1', x));
const PORT = Number(process.env.E2E_PORT) || 20000 + Math.floor(Math.random() * 20000);
const DATA = resolve('tmp/lc-board-e2e-' + Date.now().toString(36));
mkdirSync(DATA, { recursive: true });
const senv = { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'lc-board-e2e', LC_YGL_BIN: BIN, LC_YGL_HOME: home, LC_ODOO_URL: `http://127.0.0.1:${odoo.address().port}`, LC_TEST: '1', LC_LEDGER: 'e2e', LC_ANCHOR_DIR: ANCH };
for (const k of ['LC_WORKBENCH_KEY_FILE', 'LC_IDENTITY_FILE']) delete senv[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env: senv });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const http = (path, headers = {}) => new Promise((done) => {
  const rq = request({ host: '127.0.0.1', port: PORT, path, headers }, (rs) => { let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j }); }); });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) } })); rq.end();
});
const done = () => { server.kill(); odoo.close(); setTimeout(() => rmSync(DATA, { recursive: true, force: true }), 300); };

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end && (await http('/api/health')).status !== 200) await new Promise((x) => setTimeout(x, 250));
  let r = await http(`/api/lifecycle/board?as_of=${encodeURIComponent(AS_OF)}`);
  ok('无 Odoo 会话 → 401', r.status === 401);
  r = await http(`/api/lifecycle/board?as_of=${encodeURIComponent(AS_OF)}`, { cookie: `session_id=${SID}` });
  const d = r.body?.data;
  ok('真引擎 lc board → ok:true，as_of 原样', r.status === 200 && r.body?.ok === true && d?.as_of === AS_OF, JSON.stringify(r.body).slice(0, 400));
  ok('6 个产品', d?.products?.length === 6 && d.summary?.products === 6, `${d?.products?.length}`);
  ok('5 条卡点（人工 2 + 规则 3）', d?.pending?.length === 5 && d.pending.filter((p) => p.release_by === '人工').length === d.summary.pending_human && d.summary.pending_human + d.summary.gate_blocked === 5, JSON.stringify(d?.summary));
  ok('2 条未确认关系', d?.links_unconfirmed?.length === 2 && d.summary.links_unconfirmed === 2);
  ok('产品阶段与回放一致', d?.products?.every((p) => replay.product_stages[p.pd.replace(`${tag}:`, '')] === p.states.product_stage?.state), JSON.stringify(replay.product_stages));
  ok('no-store', /no-store/.test(String(r.headers['cache-control'])));
  const L = d?.ledger;
  ok('带锚点：tamper_evident:true，covered_through 是行号（数字），回带账本名', L?.tamper_evident === true && typeof L.covered_through === 'number' && L.covered_through === L.rows && r.body?.anchor_ledger === 'e2e', JSON.stringify(L));
  r = await http(`/api/lifecycle/board?as_of=${encodeURIComponent(AS_OF)}&pd=${encodeURIComponent(`${tag}:pd-A`)}`, { cookie: `session_id=${SID}` });
  ok('?pd= 只回该产品', r.body?.ok === true && r.body.data?.products?.length === 1 && r.body.data.products[0].pd === `${tag}:pd-A`, JSON.stringify(r.body?.data?.products?.map((p) => p.pd)));
  writeFileSync(anchorFile, goodAnchor.replace(/"row_hash":"([0-9a-f])/, (_, c) => `"row_hash":"${c === '0' ? '1' : '0'}`));
  r = await http(`/api/lifecycle/board?as_of=${encodeURIComponent('2026-12-18T18:00:01+08:00')}`, { cookie: `session_id=${SID}` });
  const T = r.body?.data?.ledger;
  ok('锚点改坏：tamper_evident:false，anchor_ok 为 false 或（lc 未升级）缺省', r.body?.ok === true && T?.tamper_evident === false && (T.anchor_ok === false || T.anchor_ok === undefined), JSON.stringify(T));
  writeFileSync(anchorFile, goodAnchor);
  r = await http('/lifecycle');
  ok('页面路由 /lifecycle 由 SPA 托管', r.status === 200);
} catch (e) {
  ok('端到端运行', false, String(e?.stack ?? e));
}
mkdirSync('tmp', { recursive: true });
writeFileSync('tmp/lifecycle-board-e2e-summary.json', JSON.stringify({ engine: { bin: BIN, version: ver }, home, tag, pass, fail }, null, 2));
if (fail && serverErr) console.log(serverErr.slice(-2000));
console.log(`lifecycle-board-e2e: ${pass} passed / ${fail} failed（工作区 ${home}）`);
if (SERVE && !fail) {
  console.log(`SERVE port=${PORT} cookie=session_id=${SID} as_of=${AS_OF}（Ctrl-C 结束）`);
  process.on('SIGINT', () => { done(); process.exit(0); });
  process.on('SIGTERM', () => { done(); process.exit(0); });
} else { done(); process.exitCode = fail ? 1 : 0; }
