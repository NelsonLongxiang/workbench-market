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
 *   R6e（#932 统筹）报告清单不越界：别的台的清单、按事物筛都 403、没有条数；MCP 只能列有授予的台
 *   R6d（属主 2026-11-21：收窄）回应记的位置只含管得到这个台的授予：别的领域的不记，台绑到那个领域以后才记
 *   R7（PR D）入口的 can.reports、can.respond 和接口同一套判法；读报告带回模板的立场和论断类别名、回应标出 mine；
 *   R7b（#937 统筹）读、清单带给人看的名字（维度、人、位置、来源视图），页面据此不露内部标识；
 *   N1（#965 y3）名字取不到给 null，不退回内部串
 *   G12（#930 统筹验收）产出方只有 person 记 human；带报告动作的自定义角色两人放行：提议没放行、授予没放行都不生效
 *   G11（#930 独立验收）只能看台的人读报告、生成、绑定 403；冻结后补论断、论断挂到不存在的报告都拒；三张冻结的表在库里 UPDATE、DELETE、INSERT OR REPLACE 都拒
 *   F（A～D 验收建议的补测）F1 预设 member 读不了报告；F2 领域授予读得了、回应得了；F2b 只有 read 档的领域授予读不了；F3 老部门的授予记进位置；F4 旧报告带它那一版模板
 *   S （报告第 1 步 F，用例 16）跨台的同一事物 GET /api/report-subjects/:subject：按读者能读的台裁剪；读不到的台上的报告、台名、份数都不出现；没开过台库的台不建库
 *   S4 （#996 验收探针）只有 render、只有 respond 的授予：单台清单 403，跨台清单也读不了（钉住判法是 report-read）
 *   S5 （#996 验收建议①～④）合计是份数不是台数；?limit=1 每台只回 1 份；names 只带本台报告的维度和产出方；没有这件事物报告的台不列
 *   G10 产出方由服务端填：登录的那个人，记 human（数据视图的台只认人，本机命令行、管理口令进不来是既有规矩）
 *
 *   node scripts/bench-report-test.mjs
 */
import { createServer } from 'node:net';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

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
    // 给人看的名字（#937 统筹：页面不露内部标识）：读、清单都带 names，和库里的名字一致；取不到的是 null（页面写「未命名」）
    const dimTitle = (id) => db.prepare('SELECT title FROM report_dimensions WHERE id = ?').get(id)?.title ?? null;
    const pName = (id) => (db.prepare('SELECT display_name FROM principals WHERE id = ?').get(id)?.display_name || '').trim() || null;
    const nm = r?.names, ls = await bv(boss, 'GET', '/synth-orders/reports?subject=card:synth-orders@mcp');
    const actorsOk = nm && Object.keys(nm.actors).length >= 2 && Object.entries(nm.actors).every(([a, n]) => n === pName(a)) && nm.actors['user:alpha'] && !String(nm.actors['user:alpha']).includes(':');
    const posAlpha = rs.find((x) => x.responder === 'user:alpha')?.position, posAi = rs.find((x) => x.responder_kind === 'ai')?.position;
    const pa = nm?.positions?.[posAlpha];
    // 角色名照角色表（/api/roles）的 name，不是角色标识
    const roleNames = new Map(((await cli('GET', '/api/roles')).json?.roles ?? []).map((x) => [x.id, x.name]));
    const roleIds = String(posAlpha ?? '').split(',').map((g) => g.slice(0, g.lastIndexOf('@')));
    const posOk = posAlpha?.includes('@*') && Array.isArray(pa) && pa.length === roleIds.length && pa.every((g, i) => g.role === roleNames.get(roleIds[i]) && g.role !== roleIds[i] && g.scope === '全公司') && nm?.positions?.[posAi] === 'mcp';
    const srcOk = Array.isArray(nm?.sources) && nm.sources.length === r.report.sources.length && nm.sources.length >= 1
      && nm.sources.every((x, i) => x.slot === r.report.sources[i].slot && x.view === '看板' && (x.block === null || typeof x.block === 'string'));
    const ln = ls.json?.names;
    const listOk = ls.status === 200 && ln && Object.entries(ln.dimensions).every(([d, t]) => t === dimTitle(d)) && Object.values(ln.dimensions).some((t) => t)
      && Object.entries(ln.actors).every(([a, n]) => n === pName(a)) && Object.keys(ln.actors).length >= 1;
    check(nm?.dimension === dimTitle(r?.report?.dimension_id) && nm?.dimension && actorsOk && posOk && srcOk && listOk,
      'R7b 给人看的名字：读报告带维度标题、产出方和回应者的显示名、位置写成「角色名 + 范围名」（* 是全公司、MCP 会话是 mcp）、来源的视图标题；清单带维度标题、产出方显示名；和库里一致，取不到是 null',
      { names: nm, list: ln, posAlpha, posAi });
    // 收回 beta 的 rp-viewer、rp-reader：后面 G11「只能看台、不能读报告」从干净的 beta 开始
    const rvs = [];
    for (const role of ['rp-viewer', 'rp-reader']) {
      const gid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = ? AND status = 'active'").get(role)?.id;
      rvs.push((await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：R7 用完收回' })).status);
    }
    check(rvs.every((x) => x === 200), '（收尾）收回 beta 的 rp-viewer、rp-reader', rvs);
  }

  console.log('R6d 回应记的位置只含管得到这个台的授予（属主 2026-11-21：收窄）');
  {
    // alpha 另有一条只管 zeta 领域的授予：和这个台无关，不进位置；全公司（*）的照记
    const gZ = await activate({ principal: 'user:alpha', role: 'area-lead', scope: 'area:zeta' });
    const posRep = await gen(boss, G({ subject: 'card:synth-orders@pos' }));
    const pr = await respond(boss, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成：看位置' }, posRep.json?.report?.id);
    const pos = pr.json?.response?.position ?? '';
    check(gZ && pr.status === 201 && pos === 'management@*,owner@*' && !pos.includes('zeta'),
      'R6d 回应记的位置只含管得到这个台的授予：全公司的 management、owner 记上，只管 zeta 领域的 area-lead 不记', { gZ, status: pr.status, pos });
    // 台绑到 zeta 以后，zeta 的授予就管得到这个台了：记上。用完解绑，后面照旧
    const bind = await bv(boss, 'PUT', '/synth-orders/binding', { department: 'zeta' });
    const pw = await respond(boss, { stance: 'supplement', reason: '合成：绑了 zeta 再看位置' }, posRep.json?.report?.id);
    const unbind = await bv(boss, 'PUT', '/synth-orders/binding', { department: '' });
    const posZ = pw.json?.response?.position ?? '';
    check(bind.status === 200 && pw.status === 201 && posZ === 'area-lead@area:zeta,management@*,owner@*' && unbind.status === 200,
      'R6d 台绑到 zeta 以后，zeta 的 area-lead 管得到这个台，记进位置', { bind: [bind.status, bind.text?.slice(0, 120)], pw: pw.status, posZ, unbind: unbind.status });
  }

  console.log('R6e 报告清单不越界：只列这一个台里的、读者能读的台（#932 统筹：用例 16 挪到后续 PR 的前提）');
  {
    // 持 zeta 领域成员授予的人：台绑到 zeta 时读得了这个台的清单；另一个没绑 zeta 的台（有报告）读不了清单、按事物筛也读不了，数目也看不到
    const other = await bv(boss, 'POST', '', { slug: 'synth-other', title: '合成别的台' });
    await cli('POST', '/api/areas', { id: 'eta', name: '合成庚领域' });
    const be = await bv(boss, 'PUT', '/synth-other/binding', { department: 'eta' }); // 别的台绑在别的领域：按台判时这一道要拦住 zeta 的人
    const ga = await activate({ principal: 'user:beta', role: 'area-member', scope: 'area:zeta' });
    const bz = await bv(boss, 'PUT', '/synth-orders/binding', { department: 'zeta' });
    const mine = await bv(member, 'GET', '/synth-orders/reports');
    const otherList = await bv(member, 'GET', '/synth-other/reports');
    const otherSubject = await bv(member, 'GET', '/synth-other/reports?subject=card:synth-orders@resp');
    const ub = await bv(boss, 'PUT', '/synth-orders/binding', { department: '' });
    const gid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'area-member' AND status = 'active'").get()?.id;
    const rv = await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：R6e 用完收回' });
    // 清单里每一条都是这个台自己的报告（台库是一台一个，清单只读这一个台库）
    const ids = (mine.json?.reports ?? []).map((r) => r.id);
    check(other.status === 201 && be.status === 200 && ga && bz.status === 200 && mine.status === 200 && ids.length > 0
        && otherList.status === 403 && !('reports' in (otherList.json ?? {})) && otherSubject.status === 403 && ub.status === 200 && rv.status === 200,
      'R6e 持 zeta 领域授予的人：绑到 zeta 的台清单 200；没绑 zeta 的别的台清单、按事物筛都 403，应答里没有报告也没有条数（用完解绑、收回）',
      { other: other.status, be: [be.status, be.text?.slice(0, 80)], ga, bz: bz.status, mine: [mine.status, ids.length], otherList: `${otherList.status} ${otherList.text?.slice(0, 80)}`, otherSubject: otherSubject.status, ub: ub.status, rv: rv.status });
    // MCP：会话只在 synth-orders 上有 report_list，到别的台列清单调不到
    const admin = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
    const sess = (await srv.call('POST', '/api/mcp/sessions', { ...admin, body: { name: 'synth-list-scope' } })).json;
    const g = await bv(boss, 'PUT', '/synth-orders/mcp-grants', { session: 'synth-list-scope', tools: ['report_list'] });
    const call = async (args) => { const r = await srv.call('POST', '/mcp', { headers: { authorization: `Bearer ${sess?.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_list', arguments: args } } }); const res = r.json?.result; return { isError: res?.isError === true, rpcError: r.json?.error?.code ?? null, text: res?.content?.[0]?.text ?? '' }; };
    const own = await call({ bench: 'synth-orders' });
    const cross = await call({ bench: 'synth-other' });
    check(g.status === 200 && !own.isError && own.rpcError === null && (cross.isError || cross.rpcError !== null) && !/"reports"/.test(cross.text),
      'R6e MCP：会话只在本台有 report_list，列本台成、列别的台调不到（不回清单）', { g: g.status, own: own.text.slice(0, 60), cross: cross.text.slice(0, 80) });
  }

  console.log('R5 回应不能改不能删');
  {
    // 台库是单独的文件，经主库查不到：直接开台库
    const { DatabaseSync } = await import('node:sqlite');
    const store = new DatabaseSync(join(srv.data, 'bench-stores', 'synth-orders.sqlite'));
    const tr = (sql) => { try { store.prepare(sql).run(); return false; } catch { return true; } };
    // 先确认表在、有行：不然改删报「没有这张表」也算拒，测不出触发器
    let rows = -1; try { rows = Number(store.prepare('SELECT COUNT(*) AS n FROM bs_report_responses').get().n); } catch { rows = -1; }
    const r = { upd: tr("UPDATE bs_report_responses SET stance = 'agree'"), del: tr('DELETE FROM bs_report_responses'), updReport: tr("UPDATE bs_reports SET subject = 'x'"), delClaim: tr('DELETE FROM bs_report_claims'),
      // 同键覆盖（INSERT OR REPLACE 删旧行不触发 DELETE 触发器）：回应也拒（#930 独立验收）
      repResp: tr("INSERT OR REPLACE INTO bs_report_responses (id, report_id, claim_key, stance, reason, responder, responder_kind, position, supersedes, created_at) SELECT id, report_id, claim_key, 'agree', '偷换', responder, responder_kind, position, supersedes, created_at FROM bs_report_responses ORDER BY id LIMIT 1") };
    let after = -1; try { after = Number(store.prepare('SELECT COUNT(*) AS n FROM bs_report_responses').get().n); } catch { after = -1; }
    store.close();
    check(rows > 0 && after === rows && Object.values(r).every(Boolean), 'R5 台库里直接改、删、同键覆盖回应，改报告、删论断：触发器都拒，回应一行没少', { rows, after, r });
  }

  console.log('G11 只能看台、不能读报告的人；冻结的三张表在库里不能改、删、覆盖（#930 独立验收）');
  {
    // 只授了「取数、读视图」的人（进得了台，没有读报告）：读报告 403（m11）
    await cli('POST', '/api/roles/guest/copy', { id: 'g-viewer', name: '合成·只看台' });
    await cli('PUT', '/api/roles/g-viewer', { permissions: [{ actions: ['bench-store.render', 'bench-store.view-get'] }] });
    await cli('POST', '/api/roles/g-viewer/approve');
    const gv = await activate({ principal: 'user:beta', role: 'g-viewer', scope: '*' });
    const rid0 = first.json?.report?.id;
    const view = await bv(member, 'GET', '/synth-orders/view');
    const one = await bv(member, 'GET', `/synth-orders/reports/${rid0}`);
    const list = await bv(member, 'GET', '/synth-orders/reports');
    // 只能看台的人也不能生成、不能绑（#930 统筹验收 A3：生成借用 render 的动作时没有用例守）
    const vGen = await gen(member, G({ subject: 'card:synth-orders@viewer' }));
    const vBind = await bv(member, 'PUT', '/synth-orders/reports/monthly/binding', { base: 0, slots: BINDING });
    const gid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'g-viewer' AND status = 'active'").get()?.id;
    const rv = await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：G11 用完收回' });
    check(gv && view.status === 200 && one.status === 403 && list.status === 403 && vGen.status === 403 && vBind.status === 403 && rv.status === 200,
      'G11 只授了取数、读视图的人：读视图 200，读一份报告、读清单、生成、绑定都 403（用完收回）', { gv, view: view.status, one: one.status, list: list.status, gen: vGen.status, bind: vBind.status, rv: rv.status });
    // 绑定的筛选参数不在视图的筛选栏里（#930 验收 m16）：绑得上，生成时 400，不出报告；再绑回好的
    const cur = (await bv(boss, 'GET', '/synth-orders/reports/monthly/binding')).json?.binding;
    const curSlots = cur?.slots;
    const badBind = await bv(boss, 'PUT', '/synth-orders/reports/monthly/binding', { base: cur?.version, slots: { orders: { ...curSlots?.orders, params: { region: { ref: { scope: 'parameter', name: 'period' } } } } } });
    const nBefore = (await bv(boss, 'GET', '/synth-orders/reports')).json?.reports?.length;
    const badGen = await gen(boss, G({ subject: 'card:synth-orders@badparam' }));
    const nAfter = (await bv(boss, 'GET', '/synth-orders/reports')).json?.reports?.length;
    const goodBind = await bv(boss, 'PUT', '/synth-orders/reports/monthly/binding', { base: badBind.json?.binding?.version, slots: curSlots });
    check(!!curSlots && badBind.status === 200 && badGen.status === 400 && /筛选项/.test(badGen.text ?? '') && nAfter === nBefore && goodBind.status === 200,
      'G11 绑定的筛选参数不在视图筛选栏里：生成 400（说清是哪个参数），不出报告；再绑回好的', { badBind: badBind.status, badGen: `${badGen.status} ${badGen.text?.slice(0, 100)}`, n: [nBefore, nAfter], goodBind: goodBind.status });
    // 冻结：台库里直接 UPDATE、DELETE、INSERT OR REPLACE（同键覆盖）三张表都拒，行原样
    const store = new DatabaseSync(join(srv.data, 'bench-stores', 'synth-orders.sqlite'));
    const tr = (sql, ...a) => { try { store.prepare(sql).run(...a); return false; } catch { return true; } };
    const snap = () => JSON.stringify(['bs_report_bindings', 'bs_reports', 'bs_report_claims'].map((t) => store.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
    const before = snap();
    const rows0 = { b: store.prepare('SELECT COUNT(*) AS n FROM bs_report_bindings').get().n, r: store.prepare('SELECT COUNT(*) AS n FROM bs_reports').get().n, c: store.prepare('SELECT COUNT(*) AS n FROM bs_report_claims').get().n };
    const r = {
      updB: tr("UPDATE bs_report_bindings SET slots = '{}'"), delB: tr('DELETE FROM bs_report_bindings'),
      repB: tr("INSERT OR REPLACE INTO bs_report_bindings (dimension_id, version, template_version, slots, created_by, created_at) VALUES ('monthly', 1, 1, '{}', 'x', 1)"),
      updR: tr("UPDATE bs_reports SET body = '[]'"), delR: tr('DELETE FROM bs_reports'),
      repR: tr("INSERT OR REPLACE INTO bs_reports (id, dimension_id, template_version, template_sha256, binding_version, subject, inputs, body, sources, content_sha256, producer, producer_kind, supersedes, created_at, claim_count) VALUES (?, 'monthly', 1, 'x', 1, 'card:x', '{}', '[]', '[]', 'x', 'x', 'human', NULL, 1, 1)", rid0),
      updC: tr("UPDATE bs_report_claims SET text = 'x'"), delC: tr('DELETE FROM bs_report_claims'),
      repC: tr("INSERT OR REPLACE INTO bs_report_claims (report_id, claim_key, kind, text, basis) VALUES (?, 'conclusion-1', 'conclusion', '偷换的结论', '[]')", rid0),
      // 冻结以后补一条新论断、把论断挂到不存在的报告上（#930 统筹验收：论断要随报告一起冻结）
      addClaim: tr("INSERT INTO bs_report_claims (report_id, claim_key, kind, text, basis) VALUES (?, 'risk-1', 'risk', '事后补的风险', '[]')", rid0),
      orphanClaim: tr("INSERT INTO bs_report_claims (report_id, claim_key, kind, text, basis) VALUES (99999, 'conclusion-1', 'conclusion', '没有报告的论断', '[]')"),
    };
    const same = snap() === before;
    store.close();
    check(rows0.b > 0 && rows0.r > 0 && rows0.c > 0 && Object.values(r).every(Boolean) && same,
      'G11 台库里直接 UPDATE、DELETE、INSERT OR REPLACE（同键覆盖）报告绑定、报告、论断，冻结后补论断、论断挂到不存在的报告：触发器都拒，三张表一行没变', { rows0, r, same });
  }

  console.log('G12 产出方算人还是 AI；带报告动作的自定义角色要两人放行（#930 统筹验收）');
  {
    // 只有主体表里登记为人的记 human，席位、应用、节点、系统、内置身份、MCP 会话、认不出的都记 ai
    const { actorKindOf } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'services', 'report-compile.ts')).href);
    const kinds = { person: actorKindOf('person'), seat: actorKindOf('seat'), app: actorKindOf('app'), node: actorKindOf('node'), system: actorKindOf('system'), service: actorKindOf('service'), none: actorKindOf(null), undef: actorKindOf(undefined), empty: actorKindOf('') };
    check(kinds.person === 'human' && Object.entries(kinds).filter(([k]) => k !== 'person').every(([, v]) => v === 'ai'),
      'G12 产出方算人还是 AI：只有主体 kind 为 person 的记 human；席位、应用、节点、系统、服务、查不到的都记 ai', kinds);
    // 非人走不到生成：本机命令行（回环、不带浏览器标记）、本机页面（回环、同源浏览器）都是内置身份，生成 403——
    // 今天只有人的会话能走到产出方那一步；哪天内置身份被放进来，这里先红（#930 统筹增量验收）
    const before = (await bv(boss, 'GET', '/synth-orders/reports')).json?.reports?.length;
    const byCli = await srv.call('POST', '/api/bench-views/synth-orders/reports', { body: G({ subject: 'card:synth-orders@cli' }) });
    const byPage = await srv.call('POST', '/api/bench-views/synth-orders/reports', { headers: same, body: G({ subject: 'card:synth-orders@page' }) });
    const after = (await bv(boss, 'GET', '/synth-orders/reports')).json?.reports?.length;
    check(byCli.status === 403 && byPage.status === 403 && before === after,
      'G12 本机命令行、本机页面（内置身份，非人）生成报告：403，没出报告——走得到产出方的只有人的会话', { cli: `${byCli.status} ${byCli.text?.slice(0, 80)}`, page: `${byPage.status} ${byPage.text?.slice(0, 80)}`, n: [before, after] });
    // 两人制：管理口令改自定义角色只记成提议，属主放行前不生效；授予只起草、提交、没放行，也不生效
    const adminTok = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
    await cli('POST', '/api/roles/guest/copy', { id: 'rep-two', name: '合成·两人制' });
    await cli('PUT', '/api/roles/rep-two', { permissions: [{ actions: ['bench-store.render', 'bench-store.view-get'] }] });
    await cli('POST', '/api/roles/rep-two/approve');
    const proposed = await srv.call('PUT', '/api/roles/rep-two', { ...adminTok, body: { permissions: [{ actions: ['bench-store.render', 'bench-store.view-get', 'bench-store.report-generate', 'bench-store.report-read'] }] } });
    const gr = await activate({ principal: 'user:beta', role: 'rep-two', scope: '*' });
    const beforeApprove = await gen(member, G({ subject: 'card:synth-orders@two-1' }));
    const approved = await cli('POST', '/api/roles/rep-two/approve');
    const afterApprove = await gen(member, G({ subject: 'card:synth-orders@two-2' }));
    const gid2 = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'rep-two' AND status = 'active'").get()?.id;
    const rv2 = await cli('POST', `/api/grants/${gid2}/revoke`, { reason: '合成：G12 收回' });
    // 授予只起草、提交，没有放行
    const d = await srv.call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'rep-two', scope: '*', reason: '合成：只提交' } });
    const sub = await srv.call('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const pending = await gen(member, G({ subject: 'card:synth-orders@two-3' }));
    const pendingList = await bv(member, 'GET', '/synth-orders/reports');
    check([200, 202].includes(proposed.status) && gr && beforeApprove.status === 403 && approved.status === 200 && afterApprove.status === 201 && rv2.status === 200
        && sub.status === 200 && pending.status === 403 && pendingList.status === 403,
      'G12 管理口令把自定义角色改成带报告动作，只是提议：属主放行前授给人，生成 403；放行后 201；授予只起草、提交没放行：生成、读清单 403',
      { proposed: [proposed.status, proposed.text?.slice(0, 120)], gr, beforeApprove: beforeApprove.status, approved: approved.status, afterApprove: [afterApprove.status, afterApprove.text?.slice(0, 100)], rv2: rv2.status, sub: sub.status, pending: pending.status, pendingList: pendingList.status });
  }
  console.log('F 验收建议的补测（报告第 1 步 A～D 合并后的跟进）');
  {
    const revoke = async (principal, role) => {
      const gid = db.prepare("SELECT id FROM grants WHERE principal_id = ? AND role = ? AND status = 'active'").get(principal, role)?.id;
      return (await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：F 用完收回' })).status;
    };
    const rid0 = first.json?.report?.id;
    // F1（#930 验收 m11）按档授予的预设：普通员工（member，范围 *）读不了报告和清单
    const gm = await activate({ principal: 'user:beta', role: 'member', scope: '*' });
    const f1 = { view: (await bv(member, 'GET', '/synth-orders/view')).status, one: (await bv(member, 'GET', `/synth-orders/reports/${rid0}`)).status, list: (await bv(member, 'GET', '/synth-orders/reports')).status };
    const rv1 = await revoke('user:beta', 'member');
    // 台的动作全局都按 write 档判（judgment-builtins.ts），member 只有 read 档加点名的几个写动作，所以连视图也读不了：这里只守「读不了报告、清单」
    check(gm && f1.one === 403 && f1.list === 403 && rv1 === 200, 'F1 预设 member（范围 *）：读报告、读清单 403（视图也是 403：台的动作按 write 档判）', { gm, f1, rv1 });
    // F2（#932 验收 q3）领域授予：台绑到 zeta，持 area-member@area:zeta 的人读得了报告、清单，回应得了
    const ga = await activate({ principal: 'user:beta', role: 'area-member', scope: 'area:zeta' });
    const bz = await bv(boss, 'PUT', '/synth-orders/binding', { department: 'zeta' });
    const f2 = { one: (await bv(member, 'GET', `/synth-orders/reports/${rid0}`)).status, list: (await bv(member, 'GET', '/synth-orders/reports')).status,
      respond: (await bv(member, 'POST', `/synth-orders/reports/${rid0}/responses`, { stance: 'supplement', reason: '合成：领域成员补充' })).status };
    const ub = await bv(boss, 'PUT', '/synth-orders/binding', { department: '' });
    const f2off = (await bv(member, 'GET', `/synth-orders/reports/${rid0}`)).status;
    const rv2 = await revoke('user:beta', 'area-member');
    check(ga && bz.status === 200 && f2.one === 200 && f2.list === 200 && f2.respond === 201 && ub.status === 200 && f2off === 403 && rv2 === 200,
      'F2 台绑到 zeta：持 zeta 领域成员授予的人读报告、读清单 200，回应 201；解绑以后读 403', { ga, bz: bz.status, f2, ub: ub.status, f2off, rv2 });
    // F2b（#944 验收：读报告的范围档改成 read 的变异）按档给的、限定到领域的授予：自定义角色只有 read 档、范围 area:zeta，台绑到 zeta——
    // 读报告在范围档要 write，所以 403；范围档被放宽成 read 时就会 200
    await cli('POST', '/api/roles/guest/copy', { id: 'k-reader', name: '合成·只读档' });
    const kput = await cli('PUT', '/api/roles/k-reader', { permissions: [{ kinds: ['read'] }] });
    await cli('POST', '/api/roles/k-reader/approve');
    const gk = await activate({ principal: 'user:beta', role: 'k-reader', scope: 'area:zeta' });
    const bk = await bv(boss, 'PUT', '/synth-orders/binding', { department: 'zeta' });
    const f2b = { one: (await bv(member, 'GET', `/synth-orders/reports/${rid0}`)).status, list: (await bv(member, 'GET', '/synth-orders/reports')).status };
    const ubk = await bv(boss, 'PUT', '/synth-orders/binding', { department: '' });
    const rvk = await revoke('user:beta', 'k-reader');
    check(kput.status === 200 && gk && bk.status === 200 && f2b.one === 403 && f2b.list === 403 && ubk.status === 200 && rvk === 200,
      'F2b 只有 read 档、范围 area:zeta 的自定义角色，台绑到 zeta：读报告、读清单 403（读报告在范围档也按 write 判）', { kput: kput.status, gk, bk: bk.status, f2b, ubk: ubk.status, rvk });
    // F3（#932 验收 s1）老部门：台绑到部门 dv-old，dept:dv-old 的授予记进回应的位置，dept:dv-else 的不记
    const seed = legacySeed(join(srv.data, 'workbench-market.db'));
    seed.department('dv-old', '合成老部门'); seed.department('dv-else', '合成别的老部门');
    seed.grant('user:alpha', 'dept-member', 'dept:dv-old'); seed.grant('user:alpha', 'dept-member', 'dept:dv-else');
    const bd = await bv(boss, 'PUT', '/synth-orders/binding', { department: 'dv-old' });
    const rep3 = await gen(boss, G({ subject: 'card:synth-orders@dept' }));
    const r3 = await bv(boss, 'POST', `/synth-orders/reports/${rep3.json?.report?.id}/responses`, { claim_key: 'conclusion-1', stance: 'agree', reason: '合成：看部门位置' });
    const pos3 = r3.json?.response?.position ?? '';
    const ub3 = await bv(boss, 'PUT', '/synth-orders/binding', { department: '' });
    check(bd.status === 200 && r3.status === 201 && pos3.includes('dept-member@dept:dv-old') && !pos3.includes('dv-else') && ub3.status === 200,
      'F3 台绑到老部门 dv-old：dept:dv-old 的授予记进位置，dept:dv-else 的不记', { bd: [bd.status, bd.text?.slice(0, 100)], r3: r3.status, pos3, ub3: ub3.status });
    // F4（#937 验收 s5）读旧报告带的是它生成时那一版模板（第 1 版有结论、风险两类），不是现在生效的第 2 版
    const old = (await bv(boss, 'GET', `/synth-orders/reports/${rid0}`)).json;
    const kinds = (old?.template?.claims ?? []).map((c) => c.kind);
    check(old?.report?.template_version === 1 && JSON.stringify(kinds) === JSON.stringify(['conclusion', 'risk']),
      'F4 读第 1 版模板生成的旧报告：带回的模板是第 1 版的（结论、风险两类），不是现在生效的第 2 版', { tv: old?.report?.template_version, kinds });
  }

  console.log('S 跨台的同一事物（报告第 1 步 F，用例 16）：GET /api/report-subjects/:subject 按读者能读的台裁剪');
  {
    const SUBJ = 'card:synth-shared@2026-11';
    const subj = (opts, s = encodeURIComponent(SUBJ), q = '') => srv.call('GET', `/api/report-subjects/${s}${q}`, opts);
    const storeFile = (slug) => join(srv.data, 'bench-stores', `${slug}.sqlite`);
    // synth-other（R6e 建的，绑在 eta 领域）补数据集、视图、绑定，好在两个台上都生成同一件事物的报告
    await bv(boss, 'PUT', '/synth-other/datasets/orders', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '单号' }, { name: 'day', type: 'date', label: '日期' }, { name: 'amount', type: 'decimal', label: '金额' }] });
    await srv.call('POST', '/api/bench-views/synth-other/datasets/orders/rows?op=replace', { ...boss, raw: JSON.stringify([{ id: 7, day: '2026-11-05', amount: 70 }]) });
    const ov = await bv(boss, 'PUT', '/synth-other/view', { doc: VIEW, base: 0, note: '合成' });
    const ob = await bv(boss, 'PUT', '/synth-other/reports/monthly/binding', { base: 0, slots: BINDING });
    const rA = await gen(boss, G({ subject: SUBJ }));
    const rB = await bv(boss, 'POST', '/synth-other/reports', G({ subject: SUBJ, claims: [{ kind: 'conclusion', text: '别的台的结论', basis: [{ slot: 'orders', key: [7] }] }] }));
    // 第三个台登记了、从没开过台库：跨台读不能为了它顺手建库
    const mkE = await bv(boss, 'POST', '', { slug: 'synth-empty', title: '合成空台' });
    const emptyBefore = existsSync(storeFile('synth-empty'));
    const all = await subj(boss);
    const emptyAfter = existsSync(storeFile('synth-empty'));
    const slugs = (r) => (r.json?.benches ?? []).map((x) => x.bench?.slug).sort();
    check(ov.status === 200 && ob.status === 200 && rA.status === 201 && rB.status === 201 && mkE.status === 201
        && all.status === 200 && JSON.stringify(slugs(all)) === JSON.stringify(['synth-orders', 'synth-other']) && all.json?.total === 2
        && (all.json?.benches ?? []).every((x) => x.reports.length === 1 && x.reports[0].subject === SUBJ)
        && emptyBefore === false && emptyAfter === false,
      'S1 管理层：两个台上同一件事物的报告都列出（各一份，合计 2），带台名；登记了但没开过台库的台不列、也不被顺手建库',
      { ov: ov.status, ob: [ob.status, ob.text?.slice(0, 120)], rA: rA.status, rB: [rB.status, rB.text?.slice(0, 120)], mkE: mkE.status, all: [all.status, slugs(all), all.json?.total], emptyBefore, emptyAfter });

    // 反例（用例 16）：持 zeta 领域授予的人，只读得了绑到 zeta 的 synth-orders；synth-other（绑在 eta）上的报告不出现，份数也不出现
    const ga = await activate({ principal: 'user:beta', role: 'area-member', scope: 'area:zeta' });
    const bz = await bv(boss, 'PUT', '/synth-orders/binding', { department: 'zeta' });
    const part = await subj(member);
    const otherOnly = await subj(member, encodeURIComponent(SUBJ), '?limit=50');
    const ub = await bv(boss, 'PUT', '/synth-orders/binding', { department: '' });
    // 台解绑以后，这个人一个台都读不了：200、空清单、合计 0（不回 403，不暗示别处有）
    const none = await subj(member);
    const gid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'area-member' AND status = 'active'").get()?.id;
    const rv = await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：S 用完收回' });
    const leak = (r) => /synth-other|合成别的台|别的台的结论/.test(r.text ?? '');
    check(ga && bz.status === 200 && part.status === 200 && JSON.stringify(slugs(part)) === JSON.stringify(['synth-orders']) && part.json?.total === 1
        && !leak(part) && otherOnly.status === 200 && otherOnly.json?.total === 1 && !leak(otherOnly)
        && ub.status === 200 && none.status === 200 && (none.json?.benches ?? []).length === 0 && none.json?.total === 0 && !leak(none) && rv.status === 200,
      'S2 反例（用例 16）：持 zeta 领域授予的人只看到绑在 zeta 的台上那一份，合计 1；绑在别的领域的台上的报告、台名、份数都不出现。台解绑后一个台都读不了：200、空清单、合计 0',
      { ga, bz: bz.status, part: [part.status, slugs(part), part.json?.total, leak(part)], otherOnly: [otherOnly.status, otherOnly.json?.total], ub: ub.status, none: [none.status, none.text?.slice(0, 120)], rv: rv.status });

    // 预设 member（全公司范围，有取数、没有读报告）：也一个台都读不了
    const gm = await activate({ principal: 'user:beta', role: 'member', scope: '*' });
    const asMember = await subj(member);
    const gmid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'member' AND status = 'active'").get()?.id;
    const rvm = await cli('POST', `/api/grants/${gmid}/revoke`, { reason: '合成：S 用完收回' });
    // 认人：没登录 401、管理口令 403（台里是业务数据，管理口令看不了）、跨站 403；写错的事物 400；没有报告的事物 200 空
    const anon = await srv.call('GET', `/api/report-subjects/${encodeURIComponent(SUBJ)}`, { headers: REMOTE });
    const tok = await srv.call('GET', `/api/report-subjects/${encodeURIComponent(SUBJ)}`, { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    const cross = await srv.call('GET', `/api/report-subjects/${encodeURIComponent(SUBJ)}`, { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: P.boss });
    const bad = await subj(boss, 'nope');
    const badLimit = await subj(boss, encodeURIComponent(SUBJ), '?limit=x');
    const miss = await subj(boss, encodeURIComponent('card:synth-nothing'));
    check(gm && asMember.status === 200 && asMember.json?.total === 0 && !leak(asMember) && rvm.status === 200
        && anon.status === 401 && !('benches' in (anon.json ?? {})) && tok.status === 403 && !('benches' in (tok.json ?? {})) && cross.status === 403
        && bad.status === 400 && badLimit.status === 400 && miss.status === 200 && miss.json?.total === 0,
      'S3 预设 member 读不了报告：空清单；没登录 401、管理口令 403、跨站 403，都不带清单；事物写错、limit 写错 400；没有报告的事物 200、合计 0',
      { asMember: [asMember.status, asMember.json?.total], rvm: rvm.status, anon: anon.status, tok: tok.status, cross: cross.status, bad: bad.status, badLimit: badLimit.status, miss: [miss.status, miss.json?.total] });
  }

  console.log('S4 （#996 验收探针）判法和单台清单一致：只有 render、只有 respond 的授予，单台清单 403，跨台清单也读不了');
  {
    const SUBJ4 = 'card:synth-orders@2026-11';
    const bossAll = await srv.call('GET', `/api/report-subjects/${encodeURIComponent(SUBJ4)}`, boss);
    for (const role of ['probe-render-only', 'respond-only']) {
      if (role === 'probe-render-only') {
        await cli('POST', '/api/roles/guest/copy', { id: role, name: '探针只看台' });
        await cli('PUT', `/api/roles/${role}`, { permissions: [{ actions: ['bench-store.render', 'bench-store.view-get'] }] });
        await cli('POST', `/api/roles/${role}/approve`);
      }
      const ga = await activate({ principal: 'user:beta', role, scope: '*' });
      const single = await bv(member, 'GET', '/synth-orders/reports');
      const cross = await srv.call('GET', `/api/report-subjects/${encodeURIComponent(SUBJ4)}`, member);
      const gid = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = ? AND status = 'active'").get(role)?.id;
      const rv = await cli('POST', `/api/grants/${gid}/revoke`, { reason: '合成：S4 用完收回' });
      check(ga && single.status === 403 && cross.status === 200 && cross.json?.total === 0 && (cross.json?.benches ?? []).length === 0 && rv.status === 200 && (bossAll.json?.total ?? 0) > 0,
        `S4 ${role}：单台清单 403，跨台清单空（管理层同一事物有报告，所以不是没数据）`, { ga, single: single.status, cross: [cross.status, cross.json?.total], boss: [bossAll.status, bossAll.json?.total], rv: rv.status });
    }
  }

  console.log('S5 （#996 验收建议①～④）合计是份数、limit 按台、names 不带出别台、没有这件事物报告的台不列');
  {
    const SUBJ5 = 'card:synth-s5@2026-11';
    const subj5 = (opts, s = encodeURIComponent(SUBJ5), q = '') => srv.call('GET', `/api/report-subjects/${s}${q}`, opts);
    // 第二个维度（跨领域，alpha 发模板、sys 复核后生效），绑到 synth-other；synth-other 上的报告由 sys 生成：维度和产出方都和 synth-orders 不同
    const d2 = await cli('POST', '/api/report-dimensions', { id: 'mdim2', title: '合成第二维度S5' });
    const t2 = await pub('mdim2', { body: tpl() });
    const r2 = await srv.call('POST', '/api/report-dimensions/mdim2/templates/1/review', { ...sys, body: {} });
    const a2 = await cli('POST', '/api/report-dimensions/mdim2/activate', { version: 1 });
    const b2 = await bv(boss, 'PUT', '/synth-other/reports/mdim2/binding', { base: 0, slots: BINDING });
    // synth-orders 上同一件事物两份（boss 生成），synth-other 上一份（sys 生成）：台数 2、份数 3，分得开
    const o1 = await gen(boss, G({ subject: SUBJ5 }));
    const o2 = await gen(boss, G({ subject: SUBJ5 }));
    const x1 = await bv(sys, 'POST', '/synth-other/reports', { dimension: 'mdim2', subject: SUBJ5, inputs: INPUTS, claims: [{ kind: 'conclusion', text: 'S5 第二维度的结论', basis: [{ slot: 'orders', key: [7] }] }] });
    const by = (r) => Object.fromEntries((r.json?.benches ?? []).map((x) => [x.bench?.slug, x]));
    const all = await subj5(boss);
    const one = await subj5(boss, encodeURIComponent(SUBJ5), '?limit=1');
    const A = by(all), L = by(one);
    check(d2.status === 201 && t2.status === 201 && r2.status === 200 && a2.status === 200 && b2.status === 200 && o1.status === 201 && o2.status === 201 && x1.status === 201
        && all.status === 200 && A['synth-orders']?.reports.length === 2 && A['synth-other']?.reports.length === 1 && (all.json?.benches ?? []).length === 2 && all.json?.total === 3,
      'S5① 一个台上同一件事物两份、另一个台一份：合计 3（份数），不是 2（台数）',
      { d2: d2.status, t2: t2.status, r2: r2.text?.slice(0, 120), a2: a2.status, b2: [b2.status, b2.text?.slice(0, 120)], o: [o1.status, o2.status], x1: [x1.status, x1.text?.slice(0, 160)], all: [all.status, all.json?.total, Object.keys(A)] });
    check(one.status === 200 && L['synth-orders']?.reports.length === 1 && L['synth-other']?.reports.length === 1 && one.json?.total === 2,
      'S5② ?limit=1：每个台只回 1 份，合计 2', { one: [one.status, one.json?.total, Object.entries(L).map(([k, v]) => [k, v.reports.length])] });
    const keysOf = (o) => Object.keys(o ?? {}).sort().join(',');
    const own = (x) => x && keysOf(x.names?.dimensions) === [...new Set(x.reports.map((r) => r.dimension_id))].sort().join(',')
      && keysOf(x.names?.actors) === [...new Set(x.reports.map((r) => r.producer))].sort().join(',');
    const ord = A['synth-orders'], oth = A['synth-other'];
    check(own(ord) && own(oth) && keysOf(ord?.names?.dimensions) === 'monthly' && keysOf(oth?.names?.dimensions) === 'mdim2'
        && keysOf(ord?.names?.actors) !== keysOf(oth?.names?.actors) && !JSON.stringify(ord ?? {}).includes('合成第二维度S5'),
      'S5③ 两个台维度、产出方都不同：每个台的 names 只有它自己报告里的维度和产出方，不带出别台的', { ord: ord?.names, oth: oth?.names });
    // ④ 口径（#996 验收建议④，按现行为定）：读得了、台库也在，但没有这件事物报告的台不列出；没有任何报告的事物回 200、空清单
    const none = await subj5(boss, encodeURIComponent('card:synth-s5-none'));
    check(none.status === 200 && none.json?.total === 0 && (none.json?.benches ?? []).length === 0,
      'S5④ 两个台都读得了、台库都在，但都没有这件事物的报告：benches 为空，不列「reports: []」的台', { none: [none.status, none.text?.slice(0, 160)] });
  }

  console.log('N 名字取不到时给 null，不退回内部串（#965 y3）');
  {
    // 位置里的范围指向已经不在的领域、回应者在主体表里查不到：正常流程造不出来（台只能绑在存在的领域上），直接往台库写一条回应。
    // 放在最后，免得这条回应影响前面各节的计数
    const rid0 = first.json?.report?.id;
    const store = new DatabaseSync(join(srv.data, 'bench-stores', 'synth-orders.sqlite'));
    const maxId = Number(store.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM bs_report_responses').get().n);
    let wrote = false;
    try {
      store.prepare("INSERT INTO bs_report_responses (id, report_id, claim_key, stance, reason, responder, responder_kind, position, supersedes, created_at) VALUES (?, ?, '', 'supplement', '合成：范围名取不到', 'user:ghost-n1', 'human', 'area-member@area:ghost-n1,management@*', NULL, ?)").run(maxId + 1, rid0, Date.now());
      wrote = true;
    } catch (e) { wrote = String(e?.message ?? e); }
    store.close();
    const rd = await bv(boss, 'GET', `/synth-orders/reports/${rid0}`);
    const pos = rd.json?.names?.positions?.['area-member@area:ghost-n1,management@*'];
    const roleNames = new Map(((await cli('GET', '/api/roles')).json?.roles ?? []).map((x) => [x.id, x.name]));
    check(wrote === true && rd.status === 200 && Array.isArray(pos) && pos.length === 2
        && pos[0].role === roleNames.get('area-member') && pos[0].scope === null
        && pos[1].role === roleNames.get('management') && pos[1].scope === '全公司'
        && rd.json?.names?.actors?.['user:ghost-n1'] === null && !JSON.stringify(rd.json?.names ?? {}).includes('"area:ghost-n1"'),
      'N1 范围指向不在的领域：names.positions 里这一项的 scope 是 null（不退回 area:…），角色名照给；回应者查不到：actors 里是 null（页面都写「未命名」）',
      { wrote, status: rd.status, pos, actor: rd.json?.names?.actors?.['user:ghost-n1'] });
  }
  console.log('治理试点：精确作用域、MCP 和 REST、站内确认');
  {
    const area = 'zeta', bench = 'synth-orders', dimension = 'zdim';
    const benchPath = '/synth-orders';
    const bound = await bv(boss, 'PUT', benchPath + '/binding', { department: area });
    const proposerRole = await activate({ principal: 'user:beta', role: 'management', scope: '*' });
    const activeArea = db.prepare('SELECT status FROM areas WHERE id = ?').get(area)?.status;
    const lead = activeArea === 'active' || await activate({ principal: 'user:alpha', role: 'area-lead', scope: 'area:' + area });
    const created = await srv.call('POST', '/api/mcp/sessions', { ...member, body: { name: 'governance-synthetic-session', responsible_principal: 'user:beta' } });
    // 命名会话需站内管理员本人创建。这组以合成主库路径模拟已确认存量会话，仍用真实令牌过网关。
    const token = created.json?.token ?? 'b'.repeat(64);
    if (!created.json?.token) {
      db.prepare("INSERT INTO mcp_sessions (name, token_sha256, responsible_principal) VALUES ('governance-bound-fixture', ?, 'user:beta')").run(createHash('sha256').update(token).digest('hex'));
    }
    const bearer = { ...REMOTE, Authorization: 'Bearer ' + token };
    const access = await srv.call('POST', '/api/mcp-rest/tools/access_request', { headers: bearer, body: {
      area, actions: ['report.governance-bench-bind'], reason: '合成绑定', report_scope: { bench, dimension },
    } });
    const ref = access.json?.request?.ref;
    const okGrant = ref ? await srv.call('POST', '/api/areas/zeta/access-requests/' + ref.slice(5) + '/approve', { ...boss, body: {} }) : null;
    const dim = await srv.call('GET', '/api/report-dimensions/zdim/templates/1', boss);
    const view = await bv(boss, 'GET', benchPath + '/view');
    const current = await bv(boss, 'GET', benchPath + '/reports/zdim/binding');
    const viewSha = view.json?.sha256 ?? view.json?.view?.sha256;
    const templateSha = dim.json?.template?.sha256 ?? dim.json?.sha256;
    if (!viewSha || !templateSha) throw Error('合成模板或视图未取得摘要：' + JSON.stringify({ bound: bound.status, lead, proposerRole, access: access.status, view: Object.keys(view.json ?? {}), dim: Object.keys(dim.json ?? {}) }));
    const input = { op: 'bench-bind', idempotency_key: 'bind-fixture-1', args: {
      bench, dimension, template_version: 1, template_sha256: templateSha, base: current.json?.binding?.version ?? 0,
      view_version: view.json?.version ?? view.json?.view?.version, view_sha256: viewSha, slots: BINDING,
    } };
    const rest = body => srv.call('POST', '/api/report-governance/proposals', { headers: bearer, body });
    const ask = await rest(input);
    const wrongDimension = await rest({ ...input, args: { ...input.args, dimension: 'monthly' } });
    const missingDimension = await rest({ ...input, args: { ...input.args, dimension: 'missing-dimension' } });
    check(bound.status === 200 && lead && proposerRole && okGrant?.status === 200 && ask.status === 202 && ask.json?.status === 'pending' &&
      wrongDimension.status === 403 && wrongDimension.text === missingDimension.text,
      'RG1 授予精确到台和维度，未授权与未登记目标同拒', { bound: bound.status, lead, proposerRole, grant: okGrant?.status, access: access.text, ask: ask.text, wrong: wrongDimension.text });
    if (!ask.json?.id) throw Error('治理夹具未提案：' + ask.text);
    const catalog = await srv.call('POST', '/api/mcp-rest/tools/access_info', { headers: bearer, body: {} });
    const governance = catalog.json?.capabilities?.filter(row => row.name.startsWith('report.governance-')) ?? [];
    const fields = 'area,description,granted,kind,name';
    check(catalog.status === 200 && governance.map(row => row.name).sort().join(',') === 'report.governance-propose,report.governance-result' &&
      governance.every(row => Object.keys(row).sort().join(',') === fields && row.granted === true),
      'RG6 默认 access_info 只列两条治理简行，不展开参数', { status: catalog.status, governance });
    const id = ask.json.id;
    const invoked = await srv.call('POST', '/mcp', { headers: bearer, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'invoke', arguments: { target: 'report.governance-propose', args: input },
    } } });
    const rpc = JSON.parse(invoked.json?.result?.content?.[0]?.text ?? '{}');
    const before = await bv(boss, 'GET', benchPath + '/reports/zdim/binding');
    const inbox = await srv.call('GET', '/api/report-governance/inbox', boss);
    const frozen = inbox.json?.proposals?.find(row => row.id === id);
    const path = '/api/report-governance/inbox/' + id + '/confirm';
    const confirmation = { snapshot_sha256: frozen?.snapshot_sha256 };
    const cliDenied = await srv.call('POST', path, { body: confirmation });
    const noBrowserEvidence = await srv.call('POST', path, { session: P.boss, body: confirmation });
    const agentDenied = await srv.call('POST', path, { headers: bearer, body: confirmation });
    const crossDenied = await srv.call('POST', path, { ...boss, headers: { ...boss.headers, origin: 'https://other.example.test', 'sec-fetch-site': 'cross-site' }, body: confirmation });
    const confirmed = await srv.call('POST', path, { ...boss, body: confirmation });
    const after = await bv(boss, 'GET', benchPath + '/reports/zdim/binding');
    const result = await srv.call('GET', '/api/report-governance/proposals/' + id, { headers: bearer });
    check(rpc.id === id && before.json?.binding?.version === current.json?.binding?.version && frozen && cliDenied.status === 401 &&
      agentDenied.status === 403 && noBrowserEvidence.status === 403 && crossDenied.status === 403 && confirmed.json?.status === 'confirmed' &&
      after.json?.binding?.version === input.args.base + 1 && result.json?.result?.version === input.args.base + 1 && !result.json?.frozen,
      'RG2 MCP 与 REST 幂等同一提案，只有有权同源自然人确认才写绑定', { rpc, frozen: !!frozen, cliDenied, agentDenied, noBrowserEvidence, crossDenied, confirmed, result });
    const replayConfirm = await srv.call('POST', path, { ...boss, body: confirmation });
    const duplicate = await rest({ ...input, args: { ...input.args, base: input.args.base + 1 } });
    const proposal2 = await rest({ ...input, idempotency_key: 'bind-fixture-2', args: { ...input.args, base: input.args.base + 1 } });
    const inbox2 = await srv.call('GET', '/api/report-governance/inbox', boss);
    const second = inbox2.json?.proposals?.find(row => row.id === proposal2.json?.id);
    if (!second) throw Error('第二条提案未冻结：' + proposal2.text);
    await rows([{ id: 100, day: '2026-11-18', amount: 1 }], 'append');
    const stale = await srv.call('POST', '/api/report-governance/inbox/' + second.id + '/confirm', { ...boss, body: { snapshot_sha256: second.snapshot_sha256 } });
    const unchanged = await bv(boss, 'GET', benchPath + '/reports/zdim/binding');
    check(replayConfirm.json?.result?.version === input.args.base + 1 && duplicate.status === 409 && stale.json?.status === 'conflict' &&
      unchanged.json?.binding?.version === input.args.base + 1, 'RG3 同号重试只回原版本，异参数冲突，来源修订漂移不写绑定', { replayConfirm, duplicate, stale, unchanged });
    // 模拟台库已提交但主库回执暂不可写。只能用持久绑定回执对账，不能再追加一版。
    const proposal3 = await rest({ ...input, idempotency_key: 'bind-fixture-3', args: { ...input.args, base: input.args.base + 1 } });
    const inbox3 = await srv.call('GET', '/api/report-governance/inbox', boss);
    const third = inbox3.json?.proposals?.find(row => row.id === proposal3.json?.id);
    if (!third) throw Error('第三条提案未冻结：' + proposal3.text);
    const path3 = '/api/report-governance/inbox/' + third.id + '/confirm';
    const confirm3 = { ...boss, body: { snapshot_sha256: third.snapshot_sha256 } };
    db.exec("CREATE TRIGGER fixture_settlement_failure BEFORE UPDATE ON report_governance_proposals WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, 'fixture: lost settlement'); END");
    let firstConfirm;
    try { firstConfirm = await srv.call('POST', path3, confirm3); }
    finally { db.exec('DROP TRIGGER fixture_settlement_failure'); }
    const unsettled = db.prepare('SELECT status FROM report_governance_proposals WHERE id = ?').get(Number(third.id.slice(2)))?.status;
    const committed = await bv(boss, 'GET', benchPath + '/reports/zdim/binding');
    const recovered = await srv.call('POST', path3, confirm3);
    const settled = await bv(boss, 'GET', benchPath + '/reports/zdim/binding');
    check(firstConfirm.status >= 400 && unsettled === 'confirming' && committed.json?.binding?.version === input.args.base + 2 &&
      recovered.json?.status === 'confirmed' && recovered.json?.result?.version === input.args.base + 2 &&
      settled.json?.binding?.version === committed.json?.binding?.version,
      'RG5 台库提交后主库回执失败，重试查持久回执收敛且不重写绑定', { firstConfirm, unsettled, committed, recovered, settled });
    const proposalCount = () => db.prepare('SELECT COUNT(*) AS n FROM report_governance_proposals').get().n;
    const approval = db.prepare('SELECT * FROM area_access_requests WHERE id = ?');
    const approvalId = Number(ref.slice(5));
    const approvedBefore = approval.get(approvalId);
    const grantId = db.prepare("SELECT id FROM grants WHERE principal_id = 'user:beta' AND role = 'management' AND scope = '*' AND status = 'active'").get()?.id;
    const currentInput = { ...input, args: { ...input.args, base: settled.json?.binding?.version } };
    const allowed = await rest({ ...currentInput, idempotency_key: 'bind-fixture-grant-active' });
    const revokeManagement = await cli('POST', '/api/grants/' + grantId + '/revoke', { reason: '合成：验证报告治理当前授予撤销' });
    const countBefore = proposalCount();
    const denied = await rest({ ...currentInput, idempotency_key: 'bind-fixture-grant-revoked' });
    const countAfter = proposalCount();
    const approvedAfter = approval.get(approvalId);
    check(allowed.status === 202 && revokeManagement.status === 200 && approvedBefore?.status === 'approved' &&
      JSON.stringify(approvedBefore) === JSON.stringify(approvedAfter) && denied.status === 403 && denied.text === wrongDimension.text &&
      countAfter === countBefore, 'RG7 台和维度批准保留，责任人当前账户失权同拒且无新增提案',
      { allowed: allowed.status, revoked: revokeManagement.status, approval: approvedAfter?.status, denied: denied.status, counts: [countBefore, countAfter] });
    // 恢复账户授予，让后续改绑回转测试只受台范围的约束。
    if (!await activate({ principal: 'user:beta', role: 'management', scope: '*' })) throw Error('未恢复合成报告治理授予');
    const moved = await bv(boss, 'PUT', benchPath + '/binding', { department: '' });
    const movedBack = await bv(boss, 'PUT', benchPath + '/binding', { department: area });
    const lost = await srv.call('GET', '/api/report-governance/proposals/' + id, { headers: bearer });
    check(moved.status === 200 && movedBack.status === 200 && lost.status === 403, 'RG4 台范围改绑再回转不会恢复旧会话批准', { moved: moved.status, movedBack: movedBack.status, lost });
  }
  console.log('V3 平铺报告正文');
  {
    const name = 'report-v3';
    const conv = (content) => tpl({ schema_version: 3, body: {
      root: 'main', elements: {
        main: { type: 'document', props: {}, children: ['summary', 'numbers'] },
        summary: { type: 'section', props: { title: '合成报告' }, children: ['count'] },
        count: { type: 'text', props: { content } },
        numbers: { type: 'text', props: { content: { $join: { ref: { scope: 'slot', name: 'orders', column: 'id' } }, separator: ' / ' } } },
      },
    } });
    const count = { $count: { ref: { scope: 'slot', name: 'orders' } } };
    const valid = conv({ $concat: ['订单 ', count, ' 条，率 ',
      { $format: 'percent', locale: 'en-US', value: { $math: 'divide', a: count, b: 4 } },
      '，日期 ', { $format: 'date', locale: 'en-US', value: '2026-11-02T00:01:00Z' },
      '，摘要 ', { ref: { scope: 'field', name: 'summary' } },
    ] });
    const cycle = structuredClone(valid);
    cycle.body.elements.summary.children.push('main');
    const stray = structuredClone(valid);
    stray.body.elements.stray = { type: 'text', props: { content: '孤立' } };
    const event = structuredClone(valid);
    event.body.elements.count.on = { press: 'write' };
    await cli('POST', '/api/report-dimensions', { id: name, title: '合成平铺报告' });
    const rejected = [];
    for (const item of [cycle, stray, event, conv({ $state: '/inputs/fields/summary' }), conv({ $count: [], $concat: [] })]) {
      rejected.push((await pub(name, { body: item })).status);
    }
    check(rejected.every((status) => status === 400), 'V3a 发布拒循环、孤立元素、事件和非白名单或混写指令', rejected);
    const oldVersion = await pub(name, { body: tpl() });
    const review = await srv.call('POST', '/api/report-dimensions/' + name + '/templates/1/review', { ...sys, body: {} });
    const nextVersion = await pub(name, { body: valid });
    const act = await cli('POST', '/api/report-dimensions/' + name + '/activate', { version: 2 });
    check(oldVersion.status === 201 && review.status === 200 && nextVersion.status === 201 && nextVersion.json?.template?.kind === 'layout' && act.status === 200,
      'V3b 判据相同的 v3 只换版式，继承 v2 的复核', { old: oldVersion.status, review: review.status, next: nextVersion.json, active: act.status });
    await rows([{ id: 1, day: '2026-11-03', amount: 1 }, { id: 2, day: '2026-11-09', amount: 2 }]);
    const bound = await bind(boss, BINDING, 0, name);
    const request = G({ dimension: name, subject: 'card:v3-freeze', inputs: { ...INPUTS, fields: { summary: '{"$math":"add","a":5,"b":9}' } } });
    const filled = await gen(boss, request);
    const frozen = filled.json?.report?.body;
    const nextRows = await rows([{ id: 1, day: '2026-11-03', amount: 10 }]);
    const loaded = await bv(boss, 'GET', '/synth-orders/reports/' + filled.json?.report?.id);
    check(bound.status === 200 && filled.status === 201 && nextRows.status === 200 && loaded.status === 200 && frozen?.schema_version === 2 &&
      frozen.body?.[0]?.children?.[0]?.content === '订单 2 条，率 50%，日期 11/02/2026，摘要 {"$math":"add","a":5,"b":9}' &&
      frozen.body?.[1]?.content === '1 / 2' && JSON.stringify(loaded.json?.report?.body) === JSON.stringify(frozen),
      'V3c 服务端冻结五种指令，数据字段只作文字、改行后冻结正文保持', { bound: bound.status, filled: filled.status, nextRows: nextRows.status, frozen });
    const arithmetic = await pub(name, { body: conv({ $math: 'divide', a: 1, b: 0 }) });
    const a3 = await cli('POST', '/api/report-dimensions/' + name + '/activate', { version: 3 });
    const b3 = await bind(boss, BINDING, 1, name);
    const noReport = await gen(boss, request);
    check(arithmetic.status === 201 && a3.status === 200 && b3.status === 200 && noReport.status === 400 && noReport.text.includes('invalid_expression_number'),
      'V3d 运行期非有限算术报400，不冻结半份报告', { published: arithmetic.status, activate: a3.status, binding: b3.status, generate: noReport.text });
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
