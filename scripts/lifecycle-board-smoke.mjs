#!/usr/bin/env node
/** 生命周期全景 GET /api/lifecycle/board 冒烟（替身引擎 + 替身 Odoo，不需要 lifecycle-os）：
 *  未配置降级 ok:false · 未登录/会话失效 401 · no-store · 只读不给 LC_ASSERTION · 30s 缓存 · 并发合并 ·
 *  pd/as_of 校验 400 · rc 2 / 无信封降级不缓存 · next 提示原样透传 · LC_LEDGER 锚点带 --anchor、缺文件告警 · 审批仍 503。 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/lc-board-smoke-' + Date.now().toString(36));
const ENG = join(TMP, 'engine');
const HOME = join(TMP, 'home');
const ANCHORS = join(TMP, 'anchors');
for (const d of [ENG, HOME, ANCHORS]) mkdirSync(d, { recursive: true });
copyFileSync('scripts/fixtures/fake-lc-engine.cjs', join(ENG, 'bin.cjs'));
copyFileSync('scripts/fixtures/lc-board-sample.json', join(ENG, 'lc-board-sample.json'));
writeFileSync(join(ANCHORS, 'smoke-ledger.jsonl'), '');
const setMode = (m) => writeFileSync(join(ENG, 'mode'), m);
const calls = () => (existsSync(join(ENG, 'calls.jsonl')) ? readFileSync(join(ENG, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
setMode('ok');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const SID = 'sidA' + '0'.repeat(28);
const SID_PORTAL = 'sidP' + '0'.repeat(28), SID_NOFLAG = 'sidN' + '0'.repeat(28);
const odoo = createServer((rq, rs) => {
  let s = ''; rq.on('data', (c) => (s += c)); rq.on('end', () => {
    const got = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(rq.headers.cookie ?? ''))?.[1] ?? '';
    const body = got === SID ? { jsonrpc: '2.0', id: null, result: { uid: 7, username: 'pm-a', is_internal_user: true } }
      : got === SID_PORTAL ? { jsonrpc: '2.0', id: null, result: { uid: 8, username: 'portal-x', is_internal_user: false } }
      : got === SID_NOFLAG ? { jsonrpc: '2.0', id: null, result: { uid: 9, username: 'old-odoo' } }
      : { jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } };
    rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
});
await new Promise((x) => odoo.listen(0, '127.0.0.1', x));

const servers = [];
function boot(extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = join(TMP, `data-${port}`);
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, MCP_GATEWAY: '', PORT: String(port), DATA_DIR: data, ADMIN_TOKEN: 'lc-board-smoke', ...extraEnv };
  for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'LC_LEDGER', 'LC_ANCHOR_DIR', 'LC_TEST']) if (!(k in extraEnv)) delete env[k];
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
  p.err = ''; p.stderr.on('data', (c) => (p.err += c));
  servers.push(p);
  return port;
}
const http = (port, method, path, headers = {}) => new Promise((done) => {
  const rq = request({ host: '127.0.0.1', port, method, path, headers }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) } }));
  rq.end();
});
const up = async (port) => { const end = Date.now() + 40_000; while (Date.now() < end && (await http(port, 'GET', '/api/health')).status !== 200) await new Promise((x) => setTimeout(x, 250)); };
const cookie = { cookie: `session_id=${SID}` };

try {
  const bare = boot({});
  const P = boot({ LC_YGL_BIN: join(ENG, 'bin.cjs'), LC_YGL_HOME: HOME, LC_ODOO_URL: `http://127.0.0.1:${odoo.address().port}`, LC_LEDGER: 'smoke-ledger', LC_ANCHOR_DIR: ANCHORS, LC_WORKBENCH_KEY_FILE: join(TMP, 'never-created.key') }); // 私钥只为让统一待办过配置检查、走到登录门；门户拒绝发生在读私钥之前
  await Promise.all([up(bare), up(P)]);
  const board = (q = '', h = cookie) => http(P, 'GET', `/api/lifecycle/board${q}`, h);

  console.log('未配置 LC_*：降级');
  let r = await http(bare, 'GET', '/api/lifecycle/board', cookie);
  ok('未配置 → 200 ok:false，带原因', r.status === 200 && r.body?.ok === false && /未配置/.test(r.body.error ?? ''), JSON.stringify(r.body));
  ok('未配置也是 no-store', /no-store/.test(String(r.headers['cache-control'])) && /private/.test(String(r.headers['cache-control'])));

  console.log('登录门（resolveOdooViewer）');
  r = await board('', {});
  ok('无 Odoo 会话 → 401', r.status === 401 && r.body?.ok === false, JSON.stringify(r.body));
  ok('401 也是 no-store', /no-store/.test(String(r.headers['cache-control'])));
  r = await board('', { cookie: `session_id=${'sidZ' + '0'.repeat(28)}` });
  ok('会话失效 → 401', r.status === 401, JSON.stringify(r.body));
  for (const [label, sid, why] of [['门户用户（is_internal_user=false）', SID_PORTAL, /门户账号不能访问工作台/], ['字段缺失（fail closed）', SID_NOFLAG, /无法确认是否内部员工/]]) {
    const ck = { cookie: `session_id=${sid}` };
    r = await board('', ck);
    ok(`${label}：board 403，文案说明原因`, r.status === 403 && r.body?.ok === false && why.test(r.body.error ?? ''), JSON.stringify(r.body));
    r = await http(P, 'GET', '/api/lifecycle/whoami', ck);
    ok(`${label}：whoami 403、不回 viewer`, r.status === 403 && !r.body?.viewer && r.body?.auth_required === false, JSON.stringify(r.body));
    r = await http(P, 'GET', '/api/tasks', ck);
    const life = r.body?.sources?.lifecycle;
    ok(`${label}：统一待办生命周期源拒绝（不进 inbox，不当未登录）`, life?.ok === false && !life.auth_required && why.test(life.error ?? ''), JSON.stringify(life));
  }
  ok('登录门挡住时不调引擎', calls().length === 0, JSON.stringify(calls()));

  console.log('只读看板');
  r = await board();
  const c1 = calls();
  ok('已登录 → 200 ok:true，6 个产品、5 条待放行、2 条未确认关系', r.status === 200 && r.body?.ok === true && r.body.data?.products?.length === 6 && r.body.data.pending?.length === 5 && r.body.data.links_unconfirmed?.length === 2, JSON.stringify(r.body).slice(0, 300));
  ok('信封 data 原样透传（summary 不重算）', JSON.stringify(r.body?.data?.summary) === JSON.stringify(JSON.parse(readFileSync('scripts/fixtures/lc-board-sample.json', 'utf8')).data.summary));
  ok('标出查看人、cached:false', r.body?.viewer === 'user:pm-a' && r.body?.cached === false);
  ok('Cache-Control: private, no-store', /private/.test(String(r.headers['cache-control'])) && /no-store/.test(String(r.headers['cache-control'])), String(r.headers['cache-control']));
  ok('调引擎一次：lc board，子进程没有 LC_ASSERTION', c1.length === 1 && c1[0].args[0] === 'lc' && c1[0].args[1] === 'board' && c1[0].assertion === false, JSON.stringify(c1));
  ok('YGL_HOME = LC_YGL_HOME', c1[0]?.home === HOME, c1[0]?.home);
  ok('回带账本名 anchor_ledger（徽标文案用）', r.body?.anchor_ledger === 'smoke-ledger', JSON.stringify(r.body?.anchor_ledger));
  ok('LC_LEDGER → --anchor <LC_ANCHOR_DIR>/<账本名>.jsonl', c1[0]?.args.join(' ').includes(`--anchor ${join(ANCHORS, 'smoke-ledger.jsonl')}`), JSON.stringify(c1[0]?.args));
  r = await board();
  ok('30 秒内再请求：命中缓存不再调引擎', r.body?.ok === true && r.body.cached === true && calls().length === 1, `${calls().length}`);
  r = await board('', { cookie: `session_id=${SID_PORTAL}` });
  ok('缓存已热时门户会话仍 403、不回缓存数据', r.status === 403 && r.body?.cached === undefined && r.body?.data === undefined && calls().length === 1, JSON.stringify(r.body));

  console.log('并发合并');
  setMode('slow');
  const rs = await Promise.all([1, 2, 3, 4].map(() => board('?pd=rmvu6m0e9:pd-A')));
  const pdCalls = calls().filter((c) => c.args.includes('--pd'));
  ok('同时到达的 4 个 ?pd= 请求只调一次引擎', pdCalls.length === 1 && rs.every((x) => x.body?.ok === true && x.body.data?.products?.length === 1), `${pdCalls.length}`);
  ok('--pd 原样传给引擎', pdCalls[0]?.args.join(' ').includes('--pd rmvu6m0e9:pd-A'));
  setMode('ok');

  console.log('参数校验');
  r = await board('?pd=-bogus');
  ok('pd 以 - 开头 → 400', r.status === 400, JSON.stringify(r.body));
  r = await board('?as_of=2026-12-18%2018:00');
  ok('as_of 无时区 → 400', r.status === 400, JSON.stringify(r.body));
  r = await board('?as_of=2026-12-18T18:00:00%2B08:00');
  ok('严格 ISO as_of → --as-of 透传', r.body?.ok === true && calls().at(-1)?.args.join(' ').includes('--as-of 2026-12-18T18:00:00+08:00'), JSON.stringify(calls().at(-1)));

  console.log('降级');
  setMode('rc2');
  const n0 = calls().length;
  r = await board('?pd=rmvu6m0e9:pd-B');
  ok('rc 2 → 200 ok:false 带引擎错误', r.status === 200 && r.body?.ok === false && /USAGE/.test(r.body.error ?? ''), JSON.stringify(r.body));
  await board('?pd=rmvu6m0e9:pd-B');
  ok('失败不缓存：再请求重新调引擎', calls().length === n0 + 2, `${calls().length - n0}`);
  setMode('garbage');
  r = await board('?pd=rmvu6m0e9:pd-C');
  ok('无信封 → 200 ok:false', r.status === 200 && r.body?.ok === false && /无信封/.test(r.body.error ?? ''), JSON.stringify(r.body));
  setMode('nolanes');
  r = await board('?pd=rmvu6m0e9:pd-D');
  ok('泳道未登记：ok:true、products 空、next 提示原样透传', r.body?.ok === true && r.body.data?.products?.length === 0 && r.body.next?.[0] === '树里没有泳道登记 reg-lanes', JSON.stringify(r.body?.next));
  setMode('ok');

  console.log('缓存与并发封顶');
  for (let i = 0; i < 70; i++) await board(`?as_of=2026-12-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}%2B08:00`);
  r = await http(P, 'GET', '/api/lifecycle/status', { 'x-admin-token': 'lc-board-smoke' });
  ok('连续 70 个不同 as_of 后缓存条数 ≤ 64', r.body?.board_cache?.max === 64 && r.body.board_cache.entries <= 64 && r.body.board_cache.entries > 0, JSON.stringify(r.body?.board_cache));
  setMode('slow');
  const n1 = calls().length;
  const burst = await Promise.all(['pd-A', 'pd-B', 'pd-C', 'pd-D'].map((x) => board(`?as_of=2026-12-02T00:00:00%2B08:00&pd=rmvu6m0e9:${x}`)));
  ok('4 个不同 key 同时未命中：只起 2 个子进程，其余回忙', calls().length - n1 === 2 && burst.filter((x) => x.body?.ok === true).length === 2 && burst.filter((x) => x.status === 200 && x.body?.ok === false && x.body.busy === true && /忙/.test(x.body.error ?? '')).length === 2, `${calls().length - n1} ${JSON.stringify(burst.map((x) => x.body?.busy ?? x.body?.ok))}`);
  setMode('ok');

  console.log('锚点缺失');
  rmSync(join(ANCHORS, 'smoke-ledger.jsonl'));
  r = await board('?pd=rmvu6m0e9:pd-E');
  ok('锚点文件不在：不带 --anchor，warnings 点名', r.body?.ok === true && !calls().at(-1)?.args.includes('--anchor') && /锚点文件不存在/.test(String(r.body.warnings?.[0])), JSON.stringify(r.body?.warnings));

  console.log('审批保持停用');
  r = await http(P, 'POST', '/api/lifecycle/approve', { 'content-type': 'application/json', ...cookie });
  ok('POST /api/lifecycle/approve 仍 503 LC_APPROVAL_READ_ONLY', r.status === 503 && r.body?.error?.code === 'LC_APPROVAL_READ_ONLY', JSON.stringify(r.body));
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  for (const s of servers) s.kill();
  odoo.close();
  await new Promise((x) => setTimeout(x, 400));
  if (fail) for (const s of servers) if (s.err) console.log(s.err.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`lifecycle-board-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
