#!/usr/bin/env node
/**
 * 报告第 1 步 PR B（docs/report-step1.md 第二节第 2 小节、第三节、第四节）：台对维度的绑定、按绑定生成并冻结报告、论断、读报告。
 * 起隔离实例（假的登录提供方，NODE_ENV=test），起法照 scripts/bench-card-test.mjs。合成数据：一个台、一份订单数据集、一份带「月份」筛选的视图，
 * 一个跨领域维度（本机命令行建、发模板，另一个属主复核后生效），一个属于 zeta 领域的维度（这个台没绑领域，用不了）。
 *
 *   G1 绑定：管理层绑成；普通员工（没有台上的授予）403；绑的槽缺、多、列对不上、参数引用模板没有的输入、块是表单或不存在：400；base 对不上 409；
 *      维度不存在 404、属于别的领域 409、没有生效模板 409
 *   G2 （#6）生成请求里带来源（视图版本、哈希、行数）、producer_kind 等：400 不认识的键，不被采纳；来源由服务端填（视图版本、sha256、行数对得上）
 *   G3 （#7）数据槽取到的行比 max_rows 多（截断）：拒，不出半份报告；列类型和模板不合（绑到别的类型的列上）：生成时拒
 *   G4 （#8）论断：条数不在模板范围内、类别不认识、正文空、依据指报告里没有的行：400；合格的冻结下来，claim_key 是「类别-序号」
 *   G5 （#9）生成之后台里数据变了、视图改了版：已冻结的报告逐字不变；再生成一份，来源的视图版本、哈希、行数都不同
 *   G6 更正：supersedes 接链头成；接已经被更正过的 409；接别的事物 409；清单里标被谁更正了
 *   G7 模板换了版本（判据类、复核后生效）：旧绑定生成 409，要重新绑
 *   G8 读：管理层读得到清单和单份；普通员工 403；没登录 401；不存在的 404
 *   G9 （#17）删卡片：台库里只有报告也算有数据，409 的规模里有报告份数，不带正文
 *   R1 回应：理由必填、立场照模板、回应者／类别／位置由服务端填；R2 未处理的反驳（人的链头、改主意接链头、不分叉）；
 *   R3 MCP 生成、回应记 AI，AI 的反驳不算；R4 被更正之后旧报告上的不算；R5 回应、报告、论断不能改不能删
 *   R6（#932 独立验收）能回应读不了的 404 和不存在一样；MCP 回应要有 report_get 授予；一个人一条链；接别人链头 409；对整份报告的反驳算
 *   R7（PR D）入口的 can.reports、can.respond 和接口同一套判法；读报告带回模板的立场和论断类别名、回应标出 mine
 *   G10 产出方由服务端填：登录的那个人，记 human（数据视图的台只认人，本机命令行、管理口令进不来是既有规矩）
 *
 *   node scripts/bench-report-test.mjs
 */
import { createServer } from 'node:net';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `bench-report-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-bench-report-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.62' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const running = [];
async function boot(name, extraEnv = {}, { expectFail = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'admin', WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (expectFail ? 20000 : 40000);
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => { if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); } if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); } };
  if (!ready) {
    const selfExit = child.exitCode, listening = await fetch(`${base}/api/health`).then(() => true, () => false);
    await stop();
    if (expectFail) return { failed: true, refused: selfExit !== null && selfExit !== 0 && !listening, log };
    throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  }
  if (expectFail) { await stop(); return { failed: false, log }; }
  /** raw：请求体是原始字节（行的写入）；否则按 JSON 发 */
  const call = async (method, path, { headers = {}, body, raw, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (raw !== undefined) h['content-type'] = 'application/json';
    else if (body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, text, json };
    } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null }; }
  };
  const srv = { name, base, host: new URL(base).host, data, stop, call, log: () => log, db: () => new DatabaseSync(join(data, 'workbench-market.db')) };
  running.push(srv);
  return srv;
}



/** 一份合格的模板（维度的第二版模板）：月份参数、一句摘要、订单明细一个槽（按编号作行键）、封面、表格、合计统计；论断要 1～2 条结论、0～3 条风险 */
const tpl = (over = {}) => ({
  schema_version: 2, title: '合成·月度经营',
  parameters: { period: { type: 'month', required: true } }, fields: { summary: { required: true, max_length: 500 } },
  slots: {
    orders: { columns: [{ name: 'id', type: 'integer', label: '单号' }, { name: 'amount', type: 'decimal', label: '金额' }], key: ['id'], max_rows: 3, completeness: 'all' },
  },
  body: [
    { id: 'cover', type: 'cover', title: ['合成经营 ', { ref: { scope: 'parameter', name: 'period' } }], content: [{ ref: { scope: 'field', name: 'summary' } }] },
    { id: 'detail', type: 'section', title: ['明细'], children: [{ id: 'tbl', type: 'data-view', component: 'table', data: 'orders', props: { columns: ['id', 'amount'] } }] },
  ],
  claims: [{ kind: 'conclusion', label: '结论', min: 1, max: 2 }, { kind: 'risk', label: '风险', min: 0, max: 3 }],
  responses: { stances: ['agree', 'dispute', 'supplement'], reason_required: true },
  gate: { open_dispute_blocks_acceptance: false },
  ...over,
});
const VIEW = { title: '合成订单台', views: [{ key: 'board', title: '看板', blocks: [
  { type: 'filter-bar', fields: [{ name: 'month', kind: 'month' }] },
  { type: 'table', title: '订单', query: { dataset: 'orders', filter: [{ col: 'day', op: 'prefix', value: '$month' }], sort: [{ col: 'id' }] } },
  { type: 'form', dataset: 'orders', fields: ['id', 'day', 'amount'] },
] }] };
const BINDING = { orders: { view: 'board', block: 1, params: { month: { ref: { scope: 'parameter', name: 'period' } } }, columns: { id: 'id', amount: 'amount' } } };
const INPUTS = { parameters: { period: '2026-11' }, fields: { summary: '本月合成摘要' } };
const CLAIMS = [{ kind: 'conclusion', text: '本月合成结论', basis: [{ slot: 'orders', key: [1] }] }];

try {
  const srv = await boot('on', { WM_BENCH_VIEWS: 'on' });
  const db = srv.db();
  const P = { boss: SESSIONS.alpha, member: SESSIONS.beta, sys: SESSIONS.admin };
  for (const s of Object.values(P)) await srv.call('GET', '/api/auth/viewer', { session: s });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: { ...REMOTE, ...same }, session });
  const boss = who(P.boss), member = who(P.member), sys = who(P.sys);
  const activate = async (body) => { const d = await srv.call('POST', '/api/grants', { body: { reason: '合成：报告', ...body } }); const id = d.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); const a = await srv.call('POST', `/api/grants/${id}/approve`); return a.status === 200; };
  const sysId = db.prepare("SELECT id FROM principals WHERE id LIKE '%root-admin%'").get()?.id;
  const g1 = await activate({ principal: 'user:alpha', role: 'management', scope: '*' });
  const g2 = await activate({ principal: sysId, role: 'owner', scope: '*' });
  // 判据类模板版本要作者以外、认得出的人复核（#926 验收）：本机命令行不能发判据类版本，所以由 alpha（另授属主）在浏览器里发、sys 复核
  const g3 = await activate({ principal: 'user:alpha', role: 'owner', scope: '*' });
  const pub = (id, body) => srv.call('POST', `/api/report-dimensions/${id}/templates`, { ...boss, body });
  const bv = (opts, method, path, body) => srv.call(method, `/api/bench-views${path}`, { ...opts, ...(body === undefined ? {} : { body }) });
  const cli = (method, path, body) => srv.call(method, path, body === undefined ? {} : { body });
  // 台、数据集、视图
  const mk = await bv(boss, 'POST', '', { slug: 'synth-orders', title: '合成订单台' });
  await bv(boss, 'PUT', '/synth-orders/datasets/orders', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '单号' }, { name: 'day', type: 'date', label: '日期' }, { name: 'amount', type: 'decimal', label: '金额' }] });
  const rows = (data, op = 'replace') => srv.call('POST', `/api/bench-views/synth-orders/datasets/orders/rows?op=${op}`, { ...boss, raw: JSON.stringify(data) });
  await rows([{ id: 1, day: '2026-11-03', amount: 100.5 }, { id: 2, day: '2026-11-09', amount: 20 }, { id: 3, day: '2026-10-30', amount: 7 }]);
  const vput = await bv(boss, 'PUT', '/synth-orders/view', { doc: VIEW, base: 0, note: '合成' });
  // 维度：跨领域的 monthly（本机命令行建，alpha 发模板，属主 sys 复核后生效）；属于 zeta 领域的 zdim
  await cli('POST', '/api/report-dimensions', { id: 'monthly', title: '合成月度经营' });
  const t1 = await pub('monthly', { body: tpl() });
  const rv = await srv.call('POST', '/api/report-dimensions/monthly/templates/1/review', { ...sys, body: {} });
  const ac = await cli('POST', '/api/report-dimensions/monthly/activate', { version: 1 });
  await cli('POST', '/api/report-dimensions', { id: 'pending', title: '合成还没生效' });
  await cli('POST', '/api/areas', { id: 'zeta', name: '合成己领域' });
  await cli('POST', '/api/report-dimensions', { id: 'zdim', title: '合成 zeta 的维度', area: 'zeta' });
  // zdim 也给一版生效的模板：G1 里它被拒，只能是因为「属于别的领域」，不是因为没有生效模板（变异 b7 存活后补）
  await pub('zdim', { body: tpl() });
  const zrv = await srv.call('POST', '/api/report-dimensions/zdim/templates/1/review', { ...sys, body: {} });
  const zac = await cli('POST', '/api/report-dimensions/zdim/activate', { version: 1 });
  check(g1 && g2 && g3 && mk.status === 201 && vput.status === 200 && t1.status === 201 && rv.status === 200 && ac.status === 200 && zrv.status === 200 && zac.status === 200,
    '（准备）管理层、属主；台、数据集（11 月两行、10 月一行）、视图；跨领域维度 monthly 第 1 版复核后生效', { g1, g2, mk: mk.status, vput: vput.status, t1: t1.status, rv: rv.text?.slice(0, 160), ac: ac.status });

  console.log('G1 绑定');
  const bind = (opts, slots, base = 0, dim = 'monthly') => bv(opts, 'PUT', `/synth-orders/reports/${dim}/binding`, { base, slots });
  {
    const byMember = await bind(member, BINDING);
    const bad = {
      missing: (await bind(boss, {})).status,
      extra: (await bind(boss, { ...BINDING, other: BINDING.orders })).status,
      colMissing: (await bind(boss, { orders: { ...BINDING.orders, columns: { id: 'id' } } })).status,
      paramUnknown: (await bind(boss, { orders: { ...BINDING.orders, params: { month: { ref: { scope: 'parameter', name: 'nope' } } } } })).status,
      formBlock: (await bind(boss, { orders: { ...BINDING.orders, block: 2 } })).status,
      noBlock: (await bind(boss, { orders: { ...BINDING.orders, block: 9 } })).status,
      noView: (await bind(boss, { orders: { ...BINDING.orders, view: 'ghost' } })).status,
      unknownKey: (await bv(boss, 'PUT', '/synth-orders/reports/monthly/binding', { base: 0, slots: BINDING, kind: 'x' })).status,
    };
    const zr = await bind(boss, BINDING, 0, 'zdim');
    const dims = { ghost: (await bind(boss, BINDING, 0, 'ghost')).status, zeta: zr.status, zetaWhy: /属于别的领域/.test(zr.text), pending: (await bind(boss, BINDING, 0, 'pending')).status };
    const ok1 = await bind(boss, BINDING);
    const stale = await bind(boss, BINDING, 0);
    const got = await bv(boss, 'GET', '/synth-orders/reports/monthly/binding');
    check(byMember.status === 403 && Object.values(bad).every((s) => s === 400) && dims.ghost === 404 && dims.zeta === 409 && dims.zetaWhy && dims.pending === 409
        && ok1.status === 200 && ok1.json?.binding?.version === 1 && ok1.json?.binding?.template_version === 1 && stale.status === 409 && got.json?.binding?.version === 1,
      'G1 普通员工绑 403；槽缺、多、列对不上、参数引用模板没有的输入、块是表单、块不存在、视图不存在、不认识的键 400；维度不存在 404、属于别的领域（有生效模板，拒的原因就是领域）409、没有生效模板 409；管理层绑成第 1 版；base 对不上 409；读回第 1 版',
      { byMember: byMember.status, bad, dims, ok1: ok1.text?.slice(0, 200), stale: stale.status });
  }

  console.log('G2 来源由服务端填');
  const gen = (opts, body) => bv(opts, 'POST', '/synth-orders/reports', body);
  const G = (over = {}) => ({ dimension: 'monthly', subject: 'card:synth-orders@2026-11', inputs: INPUTS, claims: CLAIMS, ...over });
  let first;
  {
    const smuggled = {
      sources: (await gen(boss, { ...G(), sources: [{ slot: 'orders', rows: 999 }] })).status,
      producerKind: (await gen(boss, { ...G(), producer_kind: 'human' })).status,
      viewSha: (await gen(boss, { ...G(), view_sha256: 'f'.repeat(64) })).status,
      expected: (await gen(boss, { ...G(), expected_rows: 2 })).status,
    };
    first = await gen(boss, G());
    const src = first.json?.report?.sources?.[0];
    check(Object.values(smuggled).every((s) => s === 400) && first.status === 201 && src?.rows === 2 && src?.view_version === 1 && /^[0-9a-f]{64}$/.test(src?.view_sha256 ?? '') && src?.view === 'board' && src?.block === 1,
      'G2 请求里带来源、producer_kind、视图哈希、预期行数：400 不认识的键；合格的生成 201，来源由服务端填（视图第 1 版、哈希、11 月 2 行）', { smuggled, first: first.text?.slice(0, 300) });
  }

  console.log('G3 不出半份报告');
  {
    await rows([{ id: 4, day: '2026-11-20', amount: 1 }, { id: 5, day: '2026-11-21', amount: 2 }], 'append');
    const tooMany = await gen(boss, G({ subject: 'card:synth-orders@2026-11b' }));
    await rows([{ id: 1, day: '2026-11-03', amount: 100.5 }, { id: 2, day: '2026-11-09', amount: 20 }, { id: 3, day: '2026-10-30', amount: 7 }]);
    check(tooMany.status === 400 && /incomplete_data/.test(tooMany.text), 'G3a 11 月有 4 行、槽最多 3 行：取不完就拒（report_incomplete_data），不出半份报告', tooMany.text?.slice(0, 200));
    // 金额那一列绑到日期列上：绑的时候不知道类型（只核写法），生成时按取回的列类型拒
    const rb = await bind(boss, { orders: { ...BINDING.orders, columns: { id: 'id', amount: 'day' } } }, 1);
    const wrongType = await gen(boss, G({ subject: 'card:synth-orders@2026-11t' }));
    const back = await bind(boss, BINDING, 2);
    check(rb.status === 200 && wrongType.status === 400 && /incompatible_column/.test(wrongType.text) && back.status === 200,
      'G3b 槽的「金额」（decimal）绑到日期列：生成时拒（report_incompatible_column）；改回来', { rb: rb.status, wrongType: wrongType.text?.slice(0, 160), back: back.status });
  }

  console.log('G4 论断');
  {
    const bad = {
      none: (await gen(boss, G({ claims: [] }))).text,
      tooMany: (await gen(boss, G({ claims: [CLAIMS[0], CLAIMS[0], CLAIMS[0]] }))).text,
      unknownKind: (await gen(boss, G({ claims: [...CLAIMS, { kind: 'praise', text: '合成' }] }))).text,
      empty: (await gen(boss, G({ claims: [{ kind: 'conclusion', text: '  ' }] }))).text,
      basisMissing: (await gen(boss, G({ claims: [{ kind: 'conclusion', text: '合成', basis: [{ slot: 'orders', key: [3] }] }] }))).text,
      basisSlot: (await gen(boss, G({ claims: [{ kind: 'conclusion', text: '合成', basis: [{ slot: 'ghost', key: [1] }] }] }))).text,
    };
    const codes = Object.fromEntries(Object.entries(bad).map(([k, t]) => [k, (/report_[a-z_]+/.exec(t) ?? [''])[0]]));
    const want = { none: 'report_claim_count', tooMany: 'report_claim_count', unknownKind: 'report_unknown_claim_kind', empty: 'report_invalid_claim_text', basisMissing: 'report_basis_not_in_report', basisSlot: 'report_basis_not_in_report' };
    const keys = (first.json?.claims ?? []).map((c) => c.claim_key);
    check(JSON.stringify(codes) === JSON.stringify(want) && JSON.stringify(keys) === '["conclusion-1"]',
      'G4 论断条数不够、太多、类别不认识、正文空、依据指 10 月那一行（不在这份报告里）、指不存在的槽：各自拦在预期的那一道；合格的冻结成 conclusion-1', { codes, keys });
  }

  console.log('G5 冻结');
  {
    const id = first.json?.report?.id;
    const before = await bv(boss, 'GET', `/synth-orders/reports/${id}`);
    await rows([{ id: 6, day: '2026-11-25', amount: 999 }], 'append');
    const VIEW2 = { ...VIEW, title: '合成订单台·二' };
    const v2 = await bv(boss, 'PUT', '/synth-orders/view', { doc: VIEW2, base: 1, note: '合成二版' });
    const after = await bv(boss, 'GET', `/synth-orders/reports/${id}`);
    const again = await gen(boss, G({ subject: 'card:synth-orders@2026-11c' }));
    const s1 = before.json?.report?.sources?.[0], s2 = again.json?.report?.sources?.[0];
    check(before.status === 200 && after.text === before.text && v2.status === 200 && again.status === 201 && s2?.rows === 3 && s2?.view_version === 2 && s2?.view_sha256 !== s1?.view_sha256
        && JSON.stringify(after.json?.report?.body).includes('100.5') && !JSON.stringify(after.json?.report?.body).includes('999'),
      'G5 台里加了一行、视图改到第 2 版：已冻结的报告逐字不变；再生成一份，来源是视图第 2 版、哈希不同、3 行', { v2: v2.status, s1, s2 });
  }

  console.log('G6 更正');
  {
    const id = first.json?.report?.id;
    const fix = await gen(boss, G({ supersedes: id }));
    const forked = await gen(boss, G({ supersedes: id }));
    const otherSubject = await gen(boss, G({ subject: 'card:other', supersedes: fix.json?.report?.id }));
    const ghost = await gen(boss, G({ supersedes: 99999 }));
    const list = await bv(boss, 'GET', '/synth-orders/reports?subject=card:synth-orders@2026-11');
    const old = (list.json?.reports ?? []).find((r) => r.id === id);
    check(fix.status === 201 && forked.status === 409 && otherSubject.status === 409 && ghost.status === 404 && old?.superseded_by === fix.json?.report?.id && list.json?.reports?.length === 2,
      'G6 更正链头成；再更正同一份（分叉）409；更正别的事物的 409；不存在的 404；清单里旧那份标着被谁更正了', { fix: fix.status, forked: forked.status, otherSubject: otherSubject.status, ghost: ghost.status, old });
  }

  console.log('G7 模板换版');
  {
    const t2 = await pub('monthly', { body: tpl({ claims: [{ kind: 'conclusion', label: '结论', min: 1, max: 1 }] }) });
    await srv.call('POST', '/api/report-dimensions/monthly/templates/2/review', { ...sys, body: {} });
    const ac2 = await cli('POST', '/api/report-dimensions/monthly/activate', { version: 2 });
    const stale = await gen(boss, G({ subject: 'card:synth-orders@2026-11d' }));
    const rebind = await bind(boss, BINDING, 3);
    const ok = await gen(boss, G({ subject: 'card:synth-orders@2026-11d' }));
    check(t2.status === 201 && ac2.status === 200 && stale.status === 409 && rebind.status === 200 && rebind.json?.binding?.template_version === 2 && ok.status === 201 && ok.json?.report?.template_version === 2,
      'G7 模板换到第 2 版后，照第 1 版绑的生成 409；重新绑（第 2 版绑定）之后生成成，报告记模板第 2 版', { t2: t2.status, ac2: ac2.status, stale: stale.text?.slice(0, 160), rebind: rebind.status, ok: ok.status });
  }

  console.log('G8 读');
  {
    const id = first.json?.report?.id;
    const r = {
      boss: (await bv(boss, 'GET', `/synth-orders/reports/${id}`)).status, member: (await bv(member, 'GET', `/synth-orders/reports/${id}`)).status,
      memberList: (await bv(member, 'GET', '/synth-orders/reports')).status, memberGen: (await gen(member, G({ subject: 'card:x' }))).status,
      anon: (await srv.call('GET', `/api/bench-views/synth-orders/reports/${id}`, { headers: REMOTE })).status,
      token: (await srv.call('GET', `/api/bench-views/synth-orders/reports/${id}`, { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } })).status,
      missing: (await bv(boss, 'GET', '/synth-orders/reports/99999')).status, badId: (await bv(boss, 'GET', '/synth-orders/reports/abc')).status,
      badSubject: (await bv(boss, 'GET', '/synth-orders/reports?subject=no%20colon')).status,
    };
    check(r.boss === 200 && r.member === 403 && r.memberList === 403 && r.memberGen === 403 && r.anon === 401 && r.token === 403 && r.missing === 404 && r.badId === 400 && r.badSubject === 400,
      'G8 管理层读得到；普通员工读、列、生成都 403；没登录 401；管理口令 403；不存在 404；编号、事物写法不对 400', r);
  }

  console.log('G9 删卡片的门');
  {
    // 卡片 + 只有报告的台库：先建卡片、开台库，绑、生成一份，然后把数据集和视图以外的都看作数据——这里直接用规模核
    const card = (await srv.call('POST', '/api/workbenches', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN }, body: { name: '合成·报告卡', url: 'http://127.0.0.1:9/rep', type: 'web' } })).json?.id;
    const link = await bv(boss, 'PUT', '/synth-orders/workbench', { workbench_id: card });
    const del = await srv.call('DELETE', `/api/workbenches/${card}`, { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN }, body: { confirm_bench_data: true } });
    const sc = del.json?.bench_data;
    check(link.status === 200 && del.status === 409 && sc?.reports >= 4 && sc?.report_bytes > 0 && !/合成经营|本月合成|100\.5/.test(del.text),
      'G9 删挂着报告的卡片：409 的规模里有报告份数和大小，不带正文', { link: link.status, del: del.status, sc });
  }

  console.log('G10 产出方');
  {
    // 数据视图的台只认人（本机命令行、管理口令都进不来，既有规矩）：产出方就是登录的那个人，由服务端填，记 human
    const r = first.json?.report;
    const stored = (await bv(boss, 'GET', `/synth-orders/reports/${r?.id}`)).json?.report;
    check(r?.producer === 'user:alpha' && r?.producer_kind === 'human' && stored?.producer === 'user:alpha' && stored?.producer_kind === 'human',
      'G10 产出方由服务端填：登录的管理层 user:alpha，记 human（存下来的也一样）', { producer: r?.producer, kind: r?.producer_kind, stored: stored?.producer });
  }

  // ================= R：回应、未处理的反驳、MCP（报告第 1 步 PR C） =================
  console.log('R1 回应');
  // 现在 monthly 生效的是第 2 版（结论 1 条），台已重新绑。先出一份新报告做回应
  const rep = await gen(boss, G({ subject: 'card:synth-orders@resp' }));
  const rid = rep.json?.report?.id;
  const respond = (opts, body, id = rid) => bv(opts, 'POST', `/synth-orders/reports/${id}/responses`, body);
  const read = async (id = rid) => (await bv(boss, 'GET', `/synth-orders/reports/${id}`)).json;
  {
    const bad = {
      noReason: (await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '  ' })).status,
      longReason: (await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '理'.repeat(4001) })).status,
      badStance: (await respond(boss, { claim_key: 'conclusion-1', stance: 'like', reason: '合成' })).status,
      smuggledKind: (await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成', responder_kind: 'human' })).status,
      smuggledPos: (await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成', position: 'owner@*' })).status,
      badKey: (await respond(boss, { claim_key: 'Conclusion', stance: 'agree', reason: '合成' })).status,
    };
    const nf = {
      claim: (await respond(boss, { claim_key: 'risk-9', stance: 'agree', reason: '合成' })).status,
      report: (await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成' }, 99999)).status,
    };
    const deny = {
      member: (await respond(member, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成' })).status,
      anon: (await srv.call('POST', `/api/bench-views/synth-orders/reports/${rid}/responses`, { headers: REMOTE, body: { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成' } })).status,
    };
    const okR = await respond(boss, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：口径不对' });
    const resp = okR.json?.response;
    check(Object.values(bad).every((x) => x === 400) && nf.claim === 404 && nf.report === 404 && deny.member === 403 && deny.anon === 401
        && okR.status === 201 && resp?.responder === 'user:alpha' && resp?.responder_kind === 'human' && /management@\*/.test(resp?.position ?? ''),
      'R1 理由空、太长、立场不在模板里、请求里写回应者类别或位置、论断编号写法不对：400；没有这条论断、没有这份报告：404；普通员工 403、没登录 401；管理层反驳成：回应者、记人、位置（授予）由服务端填',
      { bad, nf, deny, resp });
  }

  console.log('R2 未处理的反驳');
  let firstResp;
  {
    const r1 = await read();
    firstResp = r1?.claims?.[0]?.responses?.[0]?.id;
    const c1 = r1?.claims?.[0];
    // 改主意：接自己的链头改成认可；再接同一条（分叉）409；接别人的、对不同论断的 409
    const change = await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成：看错了', supersedes: firstResp });
    const fork = await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成', supersedes: firstResp });
    const otherClaim = await respond(boss, { stance: 'agree', reason: '合成：对整份', supersedes: change.json?.response?.id });
    const r2 = await read();
    check(c1?.open_dispute === true && r1?.open_disputes === 1 && change.status === 201 && fork.status === 409 && otherClaim.status === 409
        && r2?.claims?.[0]?.open_dispute === false && r2?.open_disputes === 0 && r2?.gate?.open_dispute_blocks_acceptance === false,
      'R2 人的反驳是链头：这条论断有未处理的反驳（1 处）；本人改成认可（接链头）后没有了；同一条再接（分叉）、接到对整份报告上：409；读的时候带着模板的验收声明', { c1: c1?.open_dispute, n1: r1?.open_disputes, change: change.status, fork: fork.status, otherClaim: otherClaim.status, r2: r2?.claims?.[0]?.open_dispute });
  }

  console.log('R3 MCP：经会话生成、回应记 AI；AI 的反驳不算未处理');
  {
    const admin = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
    const sess = (await srv.call('POST', '/api/mcp/sessions', { ...admin, body: { name: 'synth-report-seat' } })).json;
    const tools = ['report_list', 'report_get', 'report_generate', 'report_respond'];
    const grant = await bv(boss, 'PUT', '/synth-orders/mcp-grants', { session: 'synth-report-seat', tools });
    const call = async (name, args) => {
      const r = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${sess?.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
      const res = r.json?.result, text = res?.content?.[0]?.text ?? '';
      let json = null; try { json = JSON.parse(text); } catch { /* 出错时是一句话 */ }
      return { isError: res?.isError === true, rpcError: r.json?.error?.code ?? null, json, text };
    };
    const made = await call('report_generate', { bench: 'synth-orders', ...G({ subject: 'card:synth-orders@mcp' }) });
    const mid = made.json?.report?.id;
    const aiDispute = await call('report_respond', { bench: 'synth-orders', id: mid, claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：AI 觉得不对' });
    const got = await call('report_get', { bench: 'synth-orders', id: mid });
    const listed = await call('report_list', { bench: 'synth-orders', subject: 'card:synth-orders@mcp' });
    const smuggle = await call('report_generate', { bench: 'synth-orders', ...G({ subject: 'card:synth-orders@mcp2' }), sources: [] });
    const other = await call('report_get', { bench: 'synth-orders-other', id: mid });
    check(!!sess?.token && grant.status === 200 && !made.isError && made.json?.report?.producer === 'mcp:synth-report-seat' && made.json?.report?.producer_kind === 'ai'
        && !aiDispute.isError && aiDispute.json?.response?.responder_kind === 'ai' && aiDispute.json?.response?.position === 'mcp'
        && got.json?.claims?.[0]?.open_dispute === false && got.json?.open_disputes === 0 && listed.json?.reports?.length === 1
        && smuggle.isError && (other.isError || other.rpcError !== null),
      'R3 MCP 会话生成：producer 是 mcp:会话名、记 AI；AI 反驳记 AI、位置 mcp，不算未处理的反驳；带来源的拒；没授予的台调不到',
      { made: made.text?.slice(0, 200), ai: aiDispute.json?.response, got: got.json?.claims?.[0]?.open_dispute, listed: listed.json?.reports?.length, smuggle: smuggle.isError, other: other.text?.slice(0, 80) });
    // 人在 AI 那份上反驳：算；报告被更正之后旧报告上的不算
    const human = await respond(boss, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：人也觉得不对' }, mid);
    const before = await read(mid);
    const fix = await gen(boss, G({ subject: 'card:synth-orders@mcp', supersedes: mid }));
    const after = await read(mid);
    check(human.status === 201 && before?.claims?.[0]?.open_dispute === true && fix.status === 201 && after?.report?.superseded_by === fix.json?.report?.id && after?.claims?.[0]?.open_dispute === false && after?.open_disputes === 0,
      'R4 人的反驳算未处理；这份报告被更正之后，旧报告上的反驳不再算（看新报告）', { human: human.status, before: before?.claims?.[0]?.open_dispute, after: after?.claims?.[0]?.open_dispute, sb: after?.report?.superseded_by });
  }

  console.log('R6 回应要读得了（第 14 条）；一个人一条链（第 15 条）；接别人的链头、对整份报告的反驳（#932 独立验收）');
  {
    // 只能回应、读不了报告的人（自定义角色只列 report-respond，范围 *）：和报告不存在一样 404，应答一字不差，库里没多一行
    await cli('POST', '/api/roles/guest/copy', { id: 'respond-only', name: '合成只能回应' });
    await cli('PUT', '/api/roles/respond-only', { permissions: [{ actions: ['bench-store.report-respond'] }] });
    await cli('POST', '/api/roles/respond-only/approve');
    const gR = await activate({ principal: 'user:beta', role: 'respond-only', scope: '*' });
    const beforeN = (await read())?.claims?.[0]?.responses?.length;
    const onReal = await respond(member, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：读不了也想反驳' });
    const onGhost = await respond(member, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：读不了也想反驳' }, 99999);
    const readDenied = await bv(member, 'GET', `/synth-orders/reports/${rid}`);
    const afterR = await read();
    check(gR && readDenied.status === 403 && onReal.status === 404 && onReal.status === onGhost.status && onReal.text === onGhost.text
        && afterR?.claims?.[0]?.responses?.length === beforeN && afterR?.open_disputes === 0,
      'R6a 能回应、读不了报告的人：回应存在的报告和不存在的报告一样 404、应答一字不差（探不出报告在不在）；没写进去，不算未处理的反驳',
      { gR, readDenied: readDenied.status, onReal: `${onReal.status} ${onReal.text?.slice(0, 80)}`, onGhost: `${onGhost.status} ${onGhost.text?.slice(0, 80)}`, n: [beforeN, afterR?.claims?.[0]?.responses?.length] });
    // MCP：只授了 report_respond、没授 report_get 的会话回应不了；两个都授了才行
    const admin = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
    const sess = (await srv.call('POST', '/api/mcp/sessions', { ...admin, body: { name: 'synth-respond-only' } })).json;
    const call = async (name, args) => {
      const r = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${sess?.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
      const res = r.json?.result;
      return { isError: res?.isError === true, rpcError: r.json?.error?.code ?? null, text: res?.content?.[0]?.text ?? JSON.stringify(r.json?.error ?? '') };
    };
    const g1 = await bv(boss, 'PUT', '/synth-orders/mcp-grants', { session: 'synth-respond-only', tools: ['report_respond'] });
    const only = await call('report_respond', { bench: 'synth-orders', id: rid, claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：没授读' });
    const g2 = await bv(boss, 'PUT', '/synth-orders/mcp-grants', { session: 'synth-respond-only', tools: ['report_respond', 'report_get'] });
    const both = await call('report_respond', { bench: 'synth-orders', id: rid, stance: 'supplement', reason: '合成：授了读，对整份补充' });
    check(g1.status === 200 && (only.isError || only.rpcError !== null) && g2.status === 200 && !both.isError && both.rpcError === null,
      'R6b MCP：只授了 report_respond 的会话回应不了（要能读）；report_get 也授了才回应得了', { g1: g1.status, only: only.text.slice(0, 100), g2: g2.status, both: both.text.slice(0, 100) });
    // 一个人一条链：已经回应过的，不带 supersedes 再发 409（不然先反驳、后另起一条认可，反驳还算着）
    const mineHead = (r) => { const m = (r?.claims?.[0]?.responses ?? []).filter((x) => x.responder === 'user:alpha'); const rep = new Set(m.map((x) => x.supersedes)); return m.find((x) => !rep.has(x.id)); };
    const head = mineHead(await read());
    const fresh = await respond(boss, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：另起一条' });
    // 接别人的链头：409
    const othersHead = await respond(sys, { claim_key: 'conclusion-1', stance: 'dispute', reason: '合成：接别人的', supersedes: head?.id });
    // 对整份报告的反驳算进未处理的反驳；本人改成认可后不算
    const whole = await respond(boss, { stance: 'dispute', reason: '合成：整份口径不对' });
    const w1 = await read();
    const wholeBack = await respond(boss, { stance: 'agree', reason: '合成：整份没问题', supersedes: whole.json?.response?.id });
    const w2 = await read();
    check(!!head && fresh.status === 409 && othersHead.status === 409 && whole.status === 201 && w1?.open_disputes === 1 && w1?.claims?.every((c) => c.open_dispute === false)
        && w1?.responses?.some((x) => x.stance === 'dispute') && wholeBack.status === 201 && w2?.open_disputes === 0,
      'R6c 已经回应过的不带 supersedes 再发 409；接别人的链头 409；对整份报告的反驳算一处未处理的反驳（论断上都没有），本人改成认可后为 0',
      { head: head?.id, fresh: fresh.status, othersHead: othersHead.status, whole: whole.status, w1: w1?.open_disputes, wholeBack: wholeBack.status, w2: w2?.open_disputes });
    // 收回 beta 的「只能回应」，下面入口 can 的对照从干净的 beta 开始
    const gid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'respond-only' AND status = 'active'").get()?.id;
    const rv = await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：R6 用完收回' });
    check(rv.status === 200, '（收尾）收回 beta 的只能回应', rv.status);
  }

  console.log('R7 报告页要的：入口的 can、读报告带回的模板信息和 mine（报告第 1 步 PR D）');
  {
    // 入口：能读报告、能回应的人 can.reports / can.respond 为 true。
    // 对照要进得了入口：普通员工先授一个只点名「取数、读视图」的自定义角色（入口 200，两项都 false），再加一个只点名「读报告」的（reports true、respond 还是 false）
    const role = async (id, actions) => {
      const c = await cli('POST', '/api/roles/guest/copy', { id, name: `合成·${id}` });
      const n = await cli('PUT', `/api/roles/${id}`, { permissions: [{ actions }] });
      await cli('POST', `/api/roles/${id}/approve`);
      return c.status === 201 && n.status === 200;
    };
    const prep = await role('rp-viewer', ['bench-store.render', 'bench-store.view-get']) && await activate({ principal: 'user:beta', role: 'rp-viewer', scope: '*' });
    const eBoss = await bv(boss, 'GET', '/synth-orders/entry'), eMember = await bv(member, 'GET', '/synth-orders/entry');
    const prep2 = await role('rp-reader', ['bench-store.report-read']) && await activate({ principal: 'user:beta', role: 'rp-reader', scope: '*' });
    const eReader = await bv(member, 'GET', '/synth-orders/entry');
    const canM = eMember.json?.can, canR = eReader.json?.can;
    check(prep && prep2 && eMember.status === 200 && canM?.reports === false && canM?.respond === false && eReader.status === 200 && canR?.reports === true && canR?.respond === false,
      'R7 入口的 can 对照：只能取数、读视图的人 reports、respond 都是 false；再授读报告：reports true、respond 仍是 false（和接口的判法一致）', { prep, prep2, member: [eMember.status, canM], reader: [eReader.status, canR] });
    // 读：带回这一版模板可选的立场、论断各类的名字；自己的回应 mine 为 true，MCP 会话的为 false
    const list = (await bv(boss, 'GET', '/synth-orders/reports?subject=card:synth-orders@mcp')).json?.reports ?? [];
    const old = list.find((x) => x.superseded_by !== null);
    const r = old ? (await bv(boss, 'GET', `/synth-orders/reports/${old.id}`)).json : null;
    const rs = r?.claims?.[0]?.responses ?? [];
    const mineOk = rs.length >= 2 && rs.every((x) => x.mine === (x.responder === 'user:alpha')) && rs.some((x) => x.mine) && rs.some((x) => !x.mine && x.responder_kind === 'ai');
    check(eBoss.status === 200 && eBoss.json?.can?.reports === true && eBoss.json?.can?.respond === true
        && JSON.stringify(r?.template) === JSON.stringify({ stances: ['agree', 'dispute', 'supplement'], claims: [{ kind: 'conclusion', label: '结论' }] }) && mineOk,
      'R7 入口的 can.reports、can.respond：管理层 true；读报告带回这份报告那一版模板（第 2 版只有「结论」一类）可选的立场和论断类别名；回应标出是不是读的人自己的（AI 会话的不是）',
      { boss: eBoss.json?.can, template: r?.template, mine: rs.map((x) => [x.responder, x.mine]) });
  }

  console.log('R5 回应不能改不能删');
  {
    // 台库是单独的文件，经主库查不到：直接开台库
    const { DatabaseSync } = await import('node:sqlite');
    const store = new DatabaseSync(join(srv.data, 'bench-stores', 'synth-orders.sqlite'));
    const tr = (sql) => { try { store.prepare(sql).run(); return false; } catch { return true; } };
    // 先确认表在、有行：不然改删报「没有这张表」也算拒，测不出触发器
    let rows = -1; try { rows = Number(store.prepare('SELECT COUNT(*) AS n FROM bs_report_responses').get().n); } catch { rows = -1; }
    const r = { upd: tr("UPDATE bs_report_responses SET stance = 'agree'"), del: tr('DELETE FROM bs_report_responses'), updReport: tr("UPDATE bs_reports SET subject = 'x'"), delClaim: tr('DELETE FROM bs_report_claims') };
    let after = -1; try { after = Number(store.prepare('SELECT COUNT(*) AS n FROM bs_report_responses').get().n); } catch { after = -1; }
    store.close();
    check(rows > 0 && after === rows && Object.values(r).every(Boolean), 'R5 台库里直接改、删回应、报告、论断：触发器都拒，回应一行没少', { rows, after, r });
  }
  db.close();
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`bench-report-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
