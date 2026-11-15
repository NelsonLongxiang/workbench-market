#!/usr/bin/env node
/**
 * 台库按卡片 id 对全部工作台开放（docs/data-views.md 第十三节第 5 条第 3 步）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   一、卡片 id 认台：只给 workbench_id 就给这张卡片开台库（标识 wb-<id>、名字用卡片的）；路径和 MCP 里写卡片 id 或台标识都认；
 *       已有的台标识是别名；纯数字、留给别的卡片的 wb-<n> 不许登记；没有台的卡片 id 和没登记一样（没权限的人照旧 403）
 *   二、删卡片的把关（台库里有数据时）：只有管理口令的、只有系统管理员身份的 409，提示找管理层；
 *       持管理层授予但没带确认的 409；409 只给规模，不出现数据集名、列名、数值
 *   三、带了确认：删成；备份进 .deleted/，留痕写明谁删的、备份、到期；台的登记、授予、库文件都没了，没定的申请驳回，
 *       驾驶舱里挂这个台的视图面板摘掉；按卡片 id 和台标识都取不到，MCP 调用和没有这个工具一样
 *   四、台库是空的、或者卡片没有台：和原来一样直接删，不要确认、不留备份；本机命令行（属主）带确认删得了有数据的
 *   五、视图台页面的入口 GET /api/bench-views/:bench/entry：写卡片 id 拿到台名、版本、默认视图、各视图的键和标题；
 *       读不到的、不存在的、卡片没有台的、还没有视图描述的，应答逐字一样（404 bench_not_found）；没登录 401
 *   五之二、取数时表单块带 can_submit：管理层 true；只授了「取数、读视图」的自定义角色 false（这时交表单确实 403）；不是表单的块不带
 *   四之二、删台（DELETE /api/apps/:slug）也走同一道门、同一条路：台的卡片的台库有数据时，只有管理口令的 409、什么都没删（台、卡片、台库都在）；
 *       属主不带确认 409、带了确认删成——卡片、台的登记、常量变量、驾驶舱面板一起没了，台库删前备份；台库空的台照旧直接删，卡片的常量变量也一起删（原来留成孤儿）
 *   四之三、main 档（缺省）只删卡片：台的提交记录照旧留在主库（第 6 步的语义变化只在 shadow、bench 档）
 *   七、WM_APP_DATA_STORE=bench：台的提交和附件在卡片的台库里——只删卡片也删它们：只有管理口令的 409（规模里有几条提交、几个附件），
 *       什么都没删；属主带确认删成：台库删前备份，主库里这个台的提交、附件和磁盘上的附件字节一起删了；台本身还在
 *       一个台两张卡片（/apps/ 和 /sop/ 各一张）：删不存数据的那张，提交不动；删存数据的那张、另一张还在，主库那份留着、剩下的卡片读得到；删最后一张才连主库那份一起删
 *       上传时最后一个名额：三笔同时到，只进一笔（查上限 → 插入排在这个台的写入队里），其余 413，磁盘上不留它们的文件
 *   八、删台的门和删卡片之间不隔着远端调用：删远端项目的那几秒里，有人往台里提交（bench 档下这是卡片台库的第一次写入），
 *       台和卡片照样一起删掉，不会出现「台删了、卡片还在」的半截。
 *       远端删失败（502）：卡片已删、台标成「删除中」——提交、上传 409，读按不存在 404，列表里没有它，主库、台库都没有新行；重试删台照常删干净
 *   六、（阶段一复验补的）台库里只有视图描述也算有数据；本机浏览器页面不是属主；同名旧库还在时不许登记；
 *       纯数字标识的旧台：数字写法照旧认到它，同号卡片不许对应别的台（只许对应它自己），启动时报出来
 *
 *   node scripts/bench-card-test.mjs              测本仓库
 *   node scripts/bench-card-test.mjs --root DIR   测另一棵目录树（变异测试用）
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
const OUT = join(HERE, '..', 'tmp', `bench-card-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-bench-card-admin';
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
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
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


async function tool(srv, token, name, args) {
  const r = await srv.call('POST', '/mcp', { headers: token ? { authorization: `Bearer ${token}` } : {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const res = r.json?.result, text = res?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 出错时是一句话 */ }
  return { status: r.status, isError: res?.isError === true, json, text };
}


try {
  const srv = await boot('on', { WM_BENCH_VIEWS: 'on' });
  const db = srv.db();
  const P = { boss: SESSIONS.alpha, member: SESSIONS.beta, sys: SESSIONS.admin };
  for (const s of Object.values(P)) await srv.call('GET', '/api/auth/viewer', { session: s });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const who = (session) => ({ headers: { ...REMOTE, ...same }, session });
  const token = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
  const boss = who(P.boss), member = who(P.member), sys = who(P.sys);
  const activate = async (body) => { const d = await srv.call('POST', '/api/grants', { body: { reason: '合成：卡片台库', ...body } }); const id = d.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); const a = await srv.call('POST', `/api/grants/${id}/approve`); return a.status === 200; };
  const sysId = db.prepare("SELECT id FROM principals WHERE id LIKE '%root-admin%'").get()?.id;
  const prep = await activate({ principal: 'user:alpha', role: 'management', scope: '*' });
  const mkWb = async (name, path) => (await srv.call('POST', '/api/workbenches', { ...token, body: { name, url: `http://127.0.0.1:9/${path}`, type: 'web' } })).json?.id;
  const W1 = await mkWb('合成·设备台', 'w1'), W2 = await mkWb('合成·旧台', 'w2'), W3 = await mkWb('合成·没台', 'w3'), W4 = await mkWb('合成·空台', 'w4'), W5 = await mkWb('合成·属主删', 'w5');
  check(prep && sysId && [W1, W2, W3, W4, W5].every((x) => Number.isInteger(x)), '（准备）管理层一人；五张卡片', { prep, sysId });
  const bv = (opts, method, path, body) => srv.call(method, `/api/bench-views${path}`, { ...opts, ...(body === undefined ? {} : { body }) });
  const rows = (opts, ref, data) => srv.call('POST', `/api/bench-views/${ref}/datasets/secret_ds/rows?op=replace`, { ...opts, raw: JSON.stringify(data) });
  const defineDs = (ref) => bv(boss, 'PUT', `/${ref}/datasets/secret_ds`, { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'hidden_col', type: 'text', label: '备注' }] });

  console.log('一、卡片 id 认台');
  let r = await bv(boss, 'POST', '', { workbench_id: W1 });
  check(r.status === 201 && r.json?.bench?.slug === `wb-${W1}` && r.json.bench.title === '合成·设备台' && r.json.bench.workbench_id === W1, '只给 workbench_id：开出台库，标识 wb-<卡片 id>，名字用卡片的', r.text.slice(0, 200));
  const d1 = await defineDs(W1), w1 = await rows(boss, W1, [{ id: 1, hidden_col: '内部值-甲' }, { id: 2, hidden_col: '内部值-乙' }]);
  const viaSlug = await bv(boss, 'GET', `/wb-${W1}/datasets`);
  check(d1.status === 200 && w1.status === 200 && viaSlug.json?.datasets?.[0]?.row_count === 2, '路径写卡片 id 建数据集、写数据；写台标识读到的是同一个台', { d1: d1.status, w1: w1.status, viaSlug: viaSlug.text.slice(0, 120) });
  const badReg = { digits: (await bv(boss, 'POST', '', { slug: '12345', title: '全数字' })).status, other: (await bv(boss, 'POST', '', { slug: `wb-${W3}`, title: '占别人的' })).status, mismatch: (await bv(boss, 'POST', '', { slug: `wb-${W3}`, title: '对不上', workbench_id: W4 })).status };
  check(Object.values(badReg).every((x) => x === 400) && !db.prepare('SELECT 1 FROM bench_views WHERE slug IN (?, ?)').get('12345', `wb-${W3}`), '纯数字的标识、留给别的卡片的 wb-<n>（不给或给错 workbench_id）都拒：400，没登记出来', badReg);
  r = await bv(boss, 'POST', '', { slug: 'legacy-a', title: '旧台', workbench_id: W2 });
  const alias = await bv(boss, 'GET', `/${W2}/datasets`);
  check(r.status === 201 && alias.status === 200 && Array.isArray(alias.json?.datasets), '已有的台标识是别名：对应上卡片之后，写卡片 id 也认到这个台', { r: r.status, alias: alias.status });
  const noBench = { boss: await bv(boss, 'GET', `/${W3}/datasets`), member: await bv(member, 'GET', `/${W3}/datasets`), memberReal: await bv(member, 'GET', `/${W1}/datasets`) };
  check(noBench.boss.status === 404 && noBench.boss.json?.error === 'bench_not_found' && noBench.member.status === 403 && noBench.memberReal.status === 403 && !existsSync(join(srv.data, 'bench-stores', `${W3}.sqlite`)), '没有台的卡片 id：管理层 404、没权限的人 403（和有台的一样，探不出来）；问一句不会建出库', { boss: noBench.boss.status, member: noBench.member.status, memberReal: noBench.memberReal.status });
  // MCP：申请写卡片 id，记成台标识；调用写卡片 id 或台标识都认
  const mkSess = async (name) => { const x = await srv.call('POST', '/api/mcp/sessions', { ...token, body: { name } }); return { id: x.json?.id, token: x.json?.token }; };
  const C = await mkSess('card-sess-c'), D = await mkSess('card-sess-d');
  const req1 = await tool(srv, C.token, 'access_request', { tools: [`dataset_list@bench:${W1}`], reason: '合成：按卡片 id 申请' });
  const reqRow = db.prepare('SELECT id, bench FROM bench_mcp_requests WHERE session_id = ?').get(C.id);
  const ok1 = await srv.call('POST', `/api/bench-views/${W1}/mcp-requests/${reqRow?.id}`, { ...boss, body: { approve: true } });
  const callId = await tool(srv, C.token, 'dataset_list', { bench: String(W1) }), callSlug = await tool(srv, C.token, 'dataset_list', { bench: `wb-${W1}` });
  check(req1.json?.ok && reqRow?.bench === `wb-${W1}` && ok1.status === 200 && callId.json?.datasets?.length === 1 && callSlug.json?.datasets?.length === 1, 'MCP：申请写卡片 id，记成台标识；批了以后调用写卡片 id 或台标识都认', { req: req1.text.slice(0, 100), bench: reqRow?.bench, ok1: ok1.status, callId: callId.text.slice(0, 80) });
  await tool(srv, D.token, 'access_request', { tools: [`dataset_list@bench:wb-${W1}`], reason: '合成：没人批的' });
  const ck = await srv.call('POST', '/api/cockpits', { ...token, body: { name: '合成驾驶舱', panels: [{ kind: 'bench-view', bench: `wb-${W1}`, view: 'board', tab: 'board' }, { kind: 'bench-view', bench: 'legacy-a', view: 'board', tab: 'board' }] } });

  console.log('五、视图台页面的入口');
  const entry = (opts, ref) => srv.call('GET', `/api/bench-views/${ref}/entry`, opts);
  const noView = await entry(boss, W2);
  const doc = { title: '合成·旧台视图', views: [{ key: 'board', title: '看板', blocks: [{ type: 'table', title: '明细', query: { dataset: 'secret_ds', limit: 10 } }] }, { key: 'detail', title: '明细', blocks: [{ type: 'table', query: { dataset: 'secret_ds', limit: 10 } }, { type: 'form', dataset: 'secret_ds', fields: ['id', 'hidden_col'] }] }] };
  await bv(boss, 'PUT', `/legacy-a/datasets/secret_ds`, { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'hidden_col', type: 'text', label: '备注' }] });
  const put = await bv(boss, 'PUT', `/${W2}/view`, { doc, base: 0, note: '合成：第一版' });
  const got = await entry(boss, W2);
  check(noView.status === 404 && put.status === 200 && got.status === 200 && JSON.stringify(got.json) === JSON.stringify({ bench: { slug: 'legacy-a', title: '旧台', workbench_id: W2 }, version: 1, title: '合成·旧台视图', default_view: 'board', views: [{ key: 'board', title: '看板' }, { key: 'detail', title: '明细' }] }), '写卡片 id：台名、版本、默认视图（第一份）、各视图的键和标题；还没有视图描述时 404', { noView: noView.status, put: put.text.slice(0, 300), got: got.text });
  const alike = [await entry(member, W2), await entry(boss, W3), await entry(boss, 999999), await entry(member, 999999), await entry(boss, 'ghost-bench'), noView];
  check(alike.every((x) => x.status === 404 && x.text === alike[0].text), '读不到的（普通员工）、卡片没有台、卡片不存在、台没登记、还没有视图描述：应答逐字一样', alike.map((x) => [x.status, x.text]));
  const anonE = await srv.call('GET', `/api/bench-views/${W2}/entry`, { headers: REMOTE }), tokE = await entry(token, W2);
  check(anonE.status === 401 && tokE.status === 403, '没登录 401；管理口令 403（台里是业务数据）', { anon: anonE.status, token: tokE.status });

  console.log('五之二、取数时表单块带 can_submit');
  // 自定义角色：只点名「取数、读视图」两个动作（属主复制一个预设、改成只有这两个动作、放行），授给普通员工 beta
  const copied = await srv.call('POST', '/api/roles/guest/copy', { body: { id: 'bv-viewer', name: '合成·只看数据视图' } });
  const narrowed = await srv.call('PUT', '/api/roles/bv-viewer', { body: { permissions: [{ actions: ['bench-store.render', 'bench-store.view-get'] }] } });
  await srv.call('POST', '/api/roles/bv-viewer/approve');
  const viewerOk = await activate({ principal: 'user:beta', role: 'bv-viewer', scope: '*' });
  const rBoss = await srv.call('GET', `/api/bench-views/${W2}/render?view=detail`, boss), rView = await srv.call('GET', `/api/bench-views/${W2}/render?view=detail`, member);
  const formOf = (r) => r.json?.blocks?.find((b) => b.type === 'form'), tableOf = (r) => r.json?.blocks?.find((b) => b.type === 'table');
  const submitDenied = await srv.call('POST', `/api/bench-views/${W2}/form`, { ...member, body: { view: 'detail', block: 1, version: rView.json?.version, values: { id: 9, hidden_col: 'x' } } });
  check(copied.status === 201 && narrowed.status === 200 && viewerOk, '（准备）只点名取数、读视图的自定义角色，授给普通员工', { copied: copied.text.slice(0, 120), narrowed: narrowed.text.slice(0, 120), viewerOk });
  check(rBoss.status === 200 && formOf(rBoss)?.can_submit === true && rView.status === 200 && formOf(rView)?.can_submit === false && submitDenied.status === 403 && !('can_submit' in (tableOf(rBoss) ?? {})),
    '管理层取数：表单块 can_submit 为 true；只能取数的人：false，这时交表单确实 403；表格块不带这个字段', { boss: formOf(rBoss), view: formOf(rView), denied: submitDenied.status, rView: rView.status });

  console.log('二、删卡片的把关（台库里有数据）');
  const tok = await srv.call('DELETE', `/api/workbenches/${W1}`, { ...token, body: { confirm_bench_data: true } });
  const sysDel = await srv.call('DELETE', `/api/workbenches/${W1}`, { ...sys, body: { confirm_bench_data: true } });
  check(tok.status === 409 && tok.json?.code === 'bench_data_needs_management' && /管理层/.test(tok.json?.error ?? ''), '只有管理口令（带了确认也一样）：409，提示找管理层', tok.text.slice(0, 200));
  check(sysDel.status === 409 && sysDel.json?.code === 'bench_data_needs_management', '只有系统管理员身份（没有管理层授予，带了确认也一样）：409', sysDel.text.slice(0, 200));
  const sc = tok.json?.bench_data;
  check(sc?.datasets === 1 && sc.rows === 2 && sc.bytes > 0 && sc.view_versions === 0 && !/secret_ds|hidden_col|内部值/.test(tok.text + sysDel.text), '409 只给规模（1 个数据集、2 行、多大、0 版视图），不出现数据集名、列名、数值', sc);
  const granted = await activate({ principal: sysId, role: 'management', scope: '*' });
  const noConfirm = await srv.call('DELETE', `/api/workbenches/${W1}`, sys);
  check(granted && noConfirm.status === 409 && noConfirm.json?.code === 'bench_data_confirm_required' && db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(W1), '持管理层授予、没带确认：409，卡片和台都还在', noConfirm.text.slice(0, 200));

  console.log('三、带了确认');
  const before = Date.now();
  const del = await srv.call('DELETE', `/api/workbenches/${W1}`, { ...sys, body: { confirm_bench_data: true } });
  const deletedDir = join(srv.data, 'bench-stores', '.deleted');
  const backups = existsSync(deletedDir) ? readdirSync(deletedDir) : [];
  const trail = db.prepare("SELECT actor, note FROM bench_bind_audit WHERE slug = ? AND action = 'delete'").get(`wb-${W1}`);
  check(del.status === 200 && del.json?.bench?.slug === `wb-${W1}` && backups.some((f) => f.startsWith(`wb-${W1}--`)) && Date.parse(del.json.bench.backup_expires_at) - before >= 30 * 86_400_000 - 60_000, '删成；备份进 .deleted/，到期是 30 天后', { del: del.text.slice(0, 200), backups });
  check(trail?.actor === sysId && /\.deleted\/wb-/.test(trail.note) && /到期/.test(trail.note), '留痕写明谁删的、备份是哪个文件、什么时候到期', trail);
  const bk = new DatabaseSync(join(deletedDir, backups.find((f) => f.startsWith(`wb-${W1}--`))), { readOnly: true });
  const bkRows = bk.prepare('SELECT COUNT(*) AS n FROM ds_secret_ds').get()?.n; bk.close();
  check(bkRows === 2, '备份里的数据完整（2 行）', bkRows);
  const gone = {
    card: !db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(W1), reg: !db.prepare('SELECT 1 FROM bench_views WHERE slug = ?').get(`wb-${W1}`),
    grants: db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_grants WHERE bench = ?').get(`wb-${W1}`).n === 0,
    pending: db.prepare("SELECT COUNT(*) AS n FROM bench_mcp_requests WHERE bench = ? AND status = 'pending'").get(`wb-${W1}`).n === 0,
    rejected: db.prepare("SELECT note FROM bench_mcp_requests WHERE bench = ? AND session_id = ?").get(`wb-${W1}`, D.id)?.note === '卡片已删',
    file: !existsSync(join(srv.data, 'bench-stores', `wb-${W1}.sqlite`)),
  };
  check(Object.values(gone).every(Boolean), '卡片、台的登记、授予都没了；没定的申请驳回（卡片已删）；库文件没了', gone);
  const after = { id: await bv(boss, 'GET', `/${W1}/datasets`), slug: await bv(boss, 'GET', `/wb-${W1}/datasets`), mcp: await tool(srv, C.token, 'dataset_list', { bench: `wb-${W1}` }) };
  const panels = JSON.parse(db.prepare('SELECT layout_config FROM cockpits WHERE id = ?').get(ck.json?.id)?.layout_config ?? '[]');
  check(after.id.status === 404 && after.slug.status === 404 && (after.mcp.isError || after.mcp.status !== 200 || !after.mcp.json?.datasets), '按卡片 id、台标识都取不到；MCP 调用和没有这个工具一样', { id: after.id.status, slug: after.slug.status, mcp: after.mcp.text.slice(0, 80) });
  check(ck.status === 201 && panels.length === 1 && panels[0].bench === 'legacy-a', '驾驶舱里挂这个台的视图面板摘掉了，挂别的台的留着', panels);

  console.log('四、空台、没台、属主');
  await bv(boss, 'POST', '', { workbench_id: W4 });
  await bv(boss, 'GET', `/${W4}/datasets`); // 开过库文件、里面是空的
  const emptyDel = await srv.call('DELETE', `/api/workbenches/${W4}`, token);
  const noBenchDel = await srv.call('DELETE', `/api/workbenches/${W3}`, token);
  check(emptyDel.status === 200 && !emptyDel.json?.bench && !db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(W4) && !(readdirSync(deletedDir).some((f) => f.startsWith(`wb-${W4}--`))), '台库是空的：管理口令也删得了，不要确认、不留备份，台一起删', emptyDel.text.slice(0, 160));
  check(noBenchDel.status === 200 && JSON.stringify(noBenchDel.json) === JSON.stringify({ ok: true, deleted: W3 }), '卡片没有台：应答和原来一样', noBenchDel.text);
  await bv(boss, 'POST', '', { workbench_id: W5 });
  await defineDs(W5); await rows(boss, W5, [{ id: 1, hidden_col: 'x' }]);
  const ownerNo = await srv.call('DELETE', `/api/workbenches/${W5}`, {});
  const ownerYes = await srv.call('DELETE', `/api/workbenches/${W5}?confirm_bench_data=true`, {});
  check(ownerNo.status === 409 && ownerNo.json?.code === 'bench_data_confirm_required' && ownerYes.status === 200 && ownerYes.json?.bench?.slug === `wb-${W5}`, '本机命令行（属主）：不带确认 409，查询串带确认删得了', { no: ownerNo.text.slice(0, 120), yes: ownerYes.text.slice(0, 160) });
  console.log('四之二、删台');
  // 合成的台：直接往主库写台和它的卡片（不经发布，没有远端项目）
  const mkApp = (slug) => {
    db.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run(slug, `合成·${slug}`);
    return Number(db.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run(`合成·${slug}`, `/apps/${slug}/`).lastInsertRowid);
  };
  const WA = mkApp('syn-del-a'), WB = mkApp('syn-del-b'), WC = mkApp('syn-del-c');
  for (const w of [WA, WC]) { await bv(boss, 'POST', '', { workbench_id: w }); await defineDs(w); await rows(boss, w, [{ id: 1, hidden_col: '台里的数据' }]); }
  for (const w of [WA, WB]) await srv.call('PUT', `/api/workbenches/${w}/vars/k`, { ...token, body: { value: 1 } });
  const ckA = await srv.call('POST', '/api/cockpits', { ...token, body: { name: '合成·删台驾驶舱', panels: [{ kind: 'bench-view', bench: `wb-${WA}`, view: 'board', tab: 'board' }, { kind: 'bench-view', bench: 'legacy-a', view: 'board', tab: 'board' }] } });
  const appDel = (opts, slug, q = '') => srv.call('DELETE', `/api/apps/${slug}${q}`, { ...opts, body: { reviewed_by: '合成审核人' } });
  const left = (slug, w) => ({ app: !!db.prepare('SELECT 1 FROM apps WHERE slug = ?').get(slug), card: !!db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(w), bench: !!db.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(w), vars: db.prepare('SELECT COUNT(*) AS n FROM workbench_vars WHERE workbench_id = ?').get(w).n });
  const byToken = await appDel(token, 'syn-del-a');
  const afterToken = left('syn-del-a', WA);
  check(byToken.status === 409 && byToken.json?.code === 'bench_data_needs_management' && afterToken.app && afterToken.card && afterToken.bench && afterToken.vars === 1, '删台：卡片的台库有数据，只有管理口令的 409，什么都没删（台、卡片、台库、常量变量都在）', { status: byToken.status, body: byToken.text.slice(0, 160), afterToken });
  const appOwnerNo = await appDel({}, 'syn-del-a');
  const appOwnerYes = await appDel({}, 'syn-del-a', '?confirm_bench_data=true');
  const afterOwner = left('syn-del-a', WA);
  const ckPanels = JSON.parse(db.prepare('SELECT layout_config FROM cockpits WHERE id = ?').get(ckA.json?.id)?.layout_config ?? '[]');
  check(appOwnerNo.status === 409 && appOwnerNo.json?.code === 'bench_data_confirm_required' && appOwnerYes.status === 200 && !afterOwner.app && !afterOwner.card && !afterOwner.bench && afterOwner.vars === 0 && readdirSync(deletedDir).some((f) => f.startsWith(`wb-${WA}--`)) && !existsSync(join(srv.data, 'bench-stores', `wb-${WA}.sqlite`)) && ckPanels.length === 1 && ckPanels[0].bench === 'legacy-a',
    '删台：属主不带确认 409；带了确认删成——台、卡片、台的登记、常量变量、驾驶舱面板一起没了，台库删前留了备份、库文件删了', { no: appOwnerNo.text.slice(0, 120), yes: appOwnerYes.text.slice(0, 120), afterOwner, ckPanels });
  const plainDel = await appDel(token, 'syn-del-b');
  const afterPlain = left('syn-del-b', WB);
  check(plainDel.status === 200 && !afterPlain.app && !afterPlain.card && afterPlain.vars === 0, '删台：卡片没有台库的照旧直接删（管理口令就行），卡片的常量变量也一起删了（原来留成孤儿）', { status: plainDel.status, afterPlain });

  // 经人审批准删台（变更申请）：同一道门——只有管理口令的批准 409、申请仍待定、什么都没删；属主批准并带确认才删成
  const crId = Number(db.prepare("INSERT INTO change_requests (kind, slug, op, reason, requested_by) VALUES ('app', 'syn-del-c', 'delete', '合成的申请理由', 'mcp:synthetic')").run().lastInsertRowid);
  const crToken = await srv.call('POST', `/api/change-requests/${crId}/approve`, { ...token, body: { reviewed_by: '合成审核人' } });
  const afterCr = { ...left('syn-del-c', WC), status: db.prepare('SELECT status FROM change_requests WHERE id = ?').get(crId).status };
  const crOwner = await srv.call('POST', `/api/change-requests/${crId}/approve`, { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { reviewed_by: '合成审核人', confirm_bench_data: true } }); // 本机命令行带口令（批准入口要口令）＝属主
  const afterCrOwner = left('syn-del-c', WC);
  check(crToken.status === 409 && crToken.json?.code === 'bench_data_needs_management' && afterCr.app && afterCr.card && afterCr.bench && afterCr.status === 'pending' && crOwner.status === 200 && !afterCrOwner.app && !afterCrOwner.card && !afterCrOwner.bench,
    '经人审批准删台：只有管理口令的批准 409（申请仍待定，什么都没删）；属主批准并带确认删成', { token: crToken.text.slice(0, 160), afterCr, owner: crOwner.text.slice(0, 160), afterCrOwner });

  console.log('四之三、main 档只删卡片');
  const WM = mkApp('syn-del-m');
  await srv.call('POST', '/api/apps/syn-del-m/data', { body: { data: { n: 1 } } });
  const mDel = await srv.call('DELETE', `/api/workbenches/${WM}`, token);
  check(mDel.status === 200 && db.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-del-m'").get().n === 1, 'main 档只删卡片：台的提交记录照旧留在主库', { status: mDel.status, body: mDel.text.slice(0, 160) });

  console.log('六、阶段一复验补的');
  const W6 = await mkWb('合成·只有视图', 'w6'), W7 = await mkWb('合成·本机页面删', 'w7'), W8 = await mkWb('合成·同号', 'w8');
  // 只有视图描述、没有数据集
  await bv(boss, 'POST', '', { workbench_id: W6 });
  const onlyView = await bv(boss, 'PUT', `/${W6}/view`, { doc: { title: '只有筛选栏', views: [{ key: 'a', title: '甲', blocks: [{ type: 'filter-bar', fields: [{ name: 'm', kind: 'month' }] }] }] }, base: 0, note: '合成' });
  const v6 = await srv.call('DELETE', `/api/workbenches/${W6}`, token);
  check(onlyView.status === 200 && v6.status === 409 && v6.json?.code === 'bench_data_needs_management' && v6.json?.bench_data?.datasets === 0 && v6.json.bench_data.view_versions === 1 && db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(W6), '台库里只有视图描述（没有数据集）也算有数据：管理口令删 409，卡片还在', { onlyView: onlyView.text.slice(0, 120), v6: v6.text.slice(0, 200) });
  // 本机浏览器页面（回环、带浏览器标记、没登录、没口令）不是属主
  await bv(boss, 'POST', '', { workbench_id: W7 });
  await defineDs(W7); await rows(boss, W7, [{ id: 1, hidden_col: 'x' }]);
  const page = await srv.call('DELETE', `/api/workbenches/${W7}`, { headers: { origin: srv.base, 'sec-fetch-site': 'same-origin' }, body: { confirm_bench_data: true } });
  // 本机浏览器页面带着管理口令（过得了写入总门）：按「只有管理口令」算，409，不当属主
  const pageTok = await srv.call('DELETE', `/api/workbenches/${W7}`, { headers: { origin: srv.base, 'sec-fetch-site': 'same-origin', 'x-admin-token': ADMIN_TOKEN }, body: { confirm_bench_data: true } });
  check(page.status !== 200 && pageTok.status === 409 && pageTok.json?.code === 'bench_data_needs_management' && db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(W7) && existsSync(join(srv.data, 'bench-stores', `wb-${W7}.sqlite`)),
    '本机浏览器页面不是属主：没口令的过不了写入总门；带管理口令、带确认的按管理口令算，409；卡片和库都在', { page: page.status, pageTok: pageTok.text.slice(0, 200) });
  // 同名旧库还在（删台时文件没删掉）：不许用这个标识重新登记
  await bv(boss, 'POST', '', { slug: 'reuse-a', title: '旧台' });
  await bv(boss, 'PUT', '/reuse-a/datasets/secret_ds', { key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'hidden_col', type: 'text', label: '备注' }] });
  await rows(boss, 'reuse-a', [{ id: 1, hidden_col: '旧数据' }]);
  db.prepare("DELETE FROM bench_views WHERE slug = 'reuse-a'").run(); // 模拟：登记删了、库文件没删掉
  const again = await bv(boss, 'POST', '', { slug: 'reuse-a', title: '新台' });
  check(again.status === 409 && !db.prepare("SELECT 1 FROM bench_views WHERE slug = 'reuse-a'").get(), '同名旧库还在：用这个标识重新登记 409，没登记出来（不接手旧数据）', again.text.slice(0, 200));
  // 纯数字标识的旧台（以前许登记）：写数字照旧认到它；同号卡片不许对应别的台
  db.prepare('INSERT INTO bench_views (slug, title, created_by, created_at) VALUES (?, ?, ?, ?)').run(String(W8), '纯数字旧台', 'synthetic', Date.now());
  const legacyRead = await bv(boss, 'GET', `/${W8}/datasets`);
  const openOther = await bv(boss, 'POST', '', { workbench_id: W8 });
  const linkOther = await bv(boss, 'PUT', '/legacy-a/workbench', { workbench_id: W8 });
  const stillLegacy = await bv(boss, 'GET', `/${W8}/datasets`);
  const linkSelf = await bv(boss, 'PUT', `/${W8}/workbench`, { workbench_id: W8 });
  check(legacyRead.status === 200 && openOther.status === 409 && linkOther.status === 409 && stillLegacy.status === 200 && !db.prepare('SELECT 1 FROM bench_views WHERE slug = ?').get(`wb-${W8}`),
    '纯数字旧台：写数字照旧认到它；同号卡片开台库、把别的台对应过去都 409（旧台不会被遮住）', { legacyRead: legacyRead.status, openOther: openOther.text.slice(0, 160), linkOther: linkOther.status, stillLegacy: stillLegacy.status });
  check(linkSelf.status === 200 && linkSelf.json?.bench?.workbench_id === W8, '把旧台对应到同号的卡片本身：许（歧义消除）', linkSelf.text.slice(0, 160));
  // 启动时报出来：重启实例看日志
  db.prepare('INSERT INTO bench_views (slug, title, created_by, created_at) VALUES (?, ?, ?, ?)').run('424242', '另一个纯数字旧台', 'synthetic', Date.now());
  db.close();
  await srv.stop();
  const srv2 = await boot('on', { WM_BENCH_VIEWS: 'on' });
  await sleep(500);
  check(/有 2 个旧台的标识是纯数字/.test(srv2.log()) && srv2.log().includes('424242') && srv2.log().includes(String(W8)), '启动时报出纯数字标识的旧台（个数和标识）', srv2.log().split('\n').filter((l) => l.includes('纯数字')).join(' | ').slice(0, 300));

  console.log('七、WM_APP_DATA_STORE=bench：只删卡片也删提交和附件');
  const srv3 = await boot('app-bench', { WM_BENCH_VIEWS: 'on', WM_APP_DATA_STORE: 'bench', WM_APP_FILES_MAX: '3' });
  const db3 = srv3.db();
  db3.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run('syn-sub', '合成·有提交的台');
  const WS = Number(db3.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·有提交的台', '/apps/syn-sub/').lastInsertRowid);
  for (const n of [1, 2]) await srv3.call('POST', '/api/apps/syn-sub/data', { body: { data: { n } } });
  mkdirSync(join(srv3.data, 'uploads', 'syn'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(srv3.data, 'uploads', 'syn', 'f.txt'), 'abc');
  db3.prepare("INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by) VALUES ('syn-sub', 'f.txt', 'text/plain', 3, 'uploads/syn/f.txt', 'seed')").run();
  const token3 = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
  const subTok = await srv3.call('DELETE', `/api/workbenches/${WS}`, token3);
  const kept = { data: db3.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-sub'").get().n, files: db3.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = 'syn-sub'").get().n, card: !!db3.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(WS) };
  check(subTok.status === 409 && subTok.json?.code === 'bench_data_needs_management' && subTok.json?.bench_data?.submissions === 2 && subTok.json.bench_data.files === 1 && kept.data === 2 && kept.files === 1 && kept.card && !/abc|f\.txt|"n"/.test(subTok.text),
    'bench 档：只有管理口令删有提交的卡片 409，规模里有 2 条提交、1 个附件（不出现内容和文件名），什么都没删', { status: subTok.status, body: subTok.text.slice(0, 220), kept });
  const subOwner = await srv3.call('DELETE', `/api/workbenches/${WS}?confirm_bench_data=true`, {});
  const subGone = { data: db3.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-sub'").get().n, files: db3.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = 'syn-sub'").get().n, bytes: existsSync(join(srv3.data, 'uploads', 'syn', 'f.txt')), app: !!db3.prepare("SELECT 1 FROM apps WHERE slug = 'syn-sub'").get(), backup: readdirSync(join(srv3.data, 'bench-stores', '.deleted')).some((f) => f.startsWith(`wb-${WS}--`)) };
  check(subOwner.status === 200 && subGone.data === 0 && subGone.files === 0 && !subGone.bytes && subGone.app && subGone.backup,
    'bench 档：属主带确认删成——台库删前备份，主库里这个台的提交、附件和磁盘上的附件字节一起删了；台本身还在', { status: subOwner.status, body: subOwner.text.slice(0, 160), subGone });
  // 一个台两张卡片
  db3.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run('syn-two', '合成·两张卡片的台');
  const T1 = Number(db3.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·两张一', '/apps/syn-two/').lastInsertRowid);
  const T2 = Number(db3.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·两张二', '/sop/syn-two/').lastInsertRowid);
  for (const n of [1, 2]) await srv3.call('POST', '/api/apps/syn-two/data', { body: { data: { n } } });
  const twoRows = () => db3.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-two'").get().n;
  const delOther = await srv3.call('DELETE', `/api/workbenches/${T2}`, token3); // 不存数据的那张（数据在 id 小的那张）
  const afterOther = twoRows();
  const delData = await srv3.call('DELETE', `/api/workbenches/${T1}?confirm_bench_data=true`, {}); // 存数据的那张，但台还有…… 先把另一张补回来再删
  check(delOther.status === 200 && afterOther === 2, '一个台两张卡片：删不存数据的那张，提交不动（不要确认）', { status: delOther.status, body: delOther.text.slice(0, 160), afterOther });
  // 再造一次：存数据的那张先删、另一张还在
  db3.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run('syn-two2', '合成·两张卡片的台二');
  const U1 = Number(db3.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·二一', '/apps/syn-two2/').lastInsertRowid);
  const U2 = Number(db3.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·二二', '/sop/syn-two2/').lastInsertRowid);
  for (const n of [1, 2]) await srv3.call('POST', '/api/apps/syn-two2/data', { body: { data: { n } } });
  const rows2 = () => db3.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-two2'").get().n;
  const delFirst = await srv3.call('DELETE', `/api/workbenches/${U1}?confirm_bench_data=true`, {});
  const keptMain = rows2();
  const readOther = await srv3.call('GET', '/api/apps/syn-two2/data', { headers: { 'x-admin-token': ADMIN_TOKEN } });
  const delLast = await srv3.call('DELETE', `/api/workbenches/${U2}?confirm_bench_data=true`, {});
  check(delData.status === 200 && delFirst.status === 200 && keptMain === 2 && readOther.json?.count === 2 && delLast.status === 200 && rows2() === 0,
    '一个台两张卡片：删存数据的那张、另一张还在——主库那份留着，剩下的卡片读得到；删最后一张才连主库那份一起删', { delFirst: delFirst.status, keptMain, readOther: readOther.json?.count, delLast: delLast.status, after: rows2() });

  // 最后一个名额：上限 3，已有 2 个附件；三笔上传同时到
  db3.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run('syn-quota', '合成·快满的台');
  db3.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·快满的台', '/apps/syn-quota/');
  for (const n of [1, 2]) db3.prepare("INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by) VALUES ('syn-quota', ?, 'text/plain', 1, ?, 'seed')").run(`q${n}.txt`, `uploads/syn/q${n}.txt`);
  const upFiles = () => readdirSync(join(srv3.data, 'uploads'), { recursive: true }).filter((f) => /\.txt$/.test(String(f))).length;
  const filesBefore = upFiles();
  const up = (i) => { const fd = new FormData(); fd.append('file', new Blob([`内容${i}`], { type: 'text/plain' }), `r${i}.txt`); return fetch(`${srv3.base}/api/apps/syn-quota/files`, { method: 'POST', body: fd }).then((r) => r.status); };
  const ups = (await Promise.all([1, 2, 3].map(up))).sort().join(',');
  const quotaRows = db3.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = 'syn-quota' AND deleted_at = ''").get().n;
  check(ups === '201,413,413' && quotaRows === 3 && upFiles() === filesBefore + 1, '最后一个名额：三笔上传同时到，只进一笔，其余 413，磁盘上不留它们的文件', { ups, quotaRows, files: upFiles() - filesBefore });

  console.log('八、删台的门和删卡片之间不隔着远端调用');
  // LayerFS 替身：收到删项目的请求时，先往这个台提交一笔（bench 档下会是卡片台库的第一次写入），再回 200
  let srv4 = null, hookStatus = null, lfFail = false;
  const lfStub = createHttpServer(async (req, res) => {
    if (req.method === 'DELETE' && lfFail) { res.writeHead(500).end(); return; }
    if (req.method === 'DELETE' && /^\/v1\/projects\//.test(req.url ?? '')) {
      try { hookStatus = (await srv4.call('POST', '/api/apps/syn-window/data', { body: { data: { during: 'remote-delete' } } })).status; } catch { hookStatus = 'err'; }
      res.writeHead(200).end(); return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => lfStub.listen(0, '127.0.0.1', r));
  try {
    srv4 = await boot('window', { WM_BENCH_VIEWS: 'on', WM_APP_DATA_STORE: 'bench', LAYERFS_SERVICE_URL: `http://127.0.0.1:${lfStub.address().port}`, LAYERFS_SERVICE_TOKEN: 'synthetic-layerfs-token-0123456789abcdef' });
    const db4 = srv4.db();
    db4.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run('syn-window', '合成·删台窗口');
    const WW = Number(db4.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·删台窗口', '/apps/syn-window/').lastInsertRowid);
    const winDel = await srv4.call('DELETE', '/api/apps/syn-window', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN }, body: { reviewed_by: '合成审核人' } });
    const winAfter = { app: !!db4.prepare("SELECT 1 FROM apps WHERE slug = 'syn-window'").get(), card: !!db4.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(WW), bench: !!db4.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(WW), rows: db4.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-window'").get().n };
    check(hookStatus === 409 && winDel.status === 200 && !winAfter.app && !winAfter.card && !winAfter.bench && winAfter.rows === 0,
      '删远端项目的那几秒里有人提交：台已标成「删除中」，提交 409；台、卡片一起删掉，不留半截，也没有新行', { hookStatus, status: winDel.status, body: winDel.text.slice(0, 160), winAfter });
    // 远端删失败：台标成「删除中」，写入 409、读 404；重试删干净
    db4.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run('syn-retry', '合成·远端删失败');
    const WR = Number(db4.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·远端删失败', '/apps/syn-retry/').lastInsertRowid);
    await srv4.call('POST', '/api/apps/syn-retry/data', { body: { data: { n: 1 } } });
    const retryRows = () => db4.prepare("SELECT COUNT(*) AS n FROM app_data WHERE app_slug = 'syn-retry'").get().n;
    lfFail = true;
    const tok4 = { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } };
    const failDel = await srv4.call('DELETE', '/api/apps/syn-retry?confirm_bench_data=true', { body: { reviewed_by: '合成审核人' } }); // 本机命令行（属主）带确认
    const midRows = retryRows();
    const midSubmit = await srv4.call('POST', '/api/apps/syn-retry/data', { body: { data: { n: 2 } } });
    const fd = new FormData(); fd.append('file', new Blob(['x'], { type: 'text/plain' }), 'r.txt');
    const midUpload = (await fetch(`${srv4.base}/api/apps/syn-retry/files`, { method: 'POST', body: fd })).status;
    const midRead = await srv4.call('GET', '/api/apps/syn-retry/data', tok4);
    const midDetail = await srv4.call('GET', '/api/apps/syn-retry', tok4);
    const midList = ((await srv4.call('GET', '/api/apps', tok4)).json ?? []).some((x) => x.slug === 'syn-retry');
    const mid = { status: db4.prepare("SELECT status FROM apps WHERE slug = 'syn-retry'").get()?.status, card: !!db4.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(WR), bench: !!db4.prepare('SELECT 1 FROM bench_views WHERE workbench_id = ?').get(WR), rows: retryRows(), files: db4.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = 'syn-retry'").get().n };
    check(failDel.status === 502 && mid.status === 'deleting' && !mid.card && !mid.bench && midSubmit.status === 409 && midSubmit.json?.code === 'app_deleting' && midUpload === 409 && midRead.status === 404 && midDetail.status === 404 && !midList && mid.rows === midRows && mid.files === 0,
      '远端删失败：卡片已删、台标成「删除中」——提交和上传 409，读、详情 404，列表里没有它，没有新行', { failDel: failDel.status, mid, submit: midSubmit.status, upload: midUpload, read: midRead.status, detail: midDetail.status, list: midList });
    lfFail = false;
    const retryDel = await srv4.call('DELETE', '/api/apps/syn-retry', { ...tok4, body: { reviewed_by: '合成审核人' } }); // 卡片已经没了：门直接放过，只有管理口令也删得了
    check(retryDel.status === 200 && !db4.prepare("SELECT 1 FROM apps WHERE slug = 'syn-retry'").get() && retryRows() === 0,
      '重试删台：卡片已经没了，门直接放过（只有管理口令也行），台、提交都删干净', { status: retryDel.status, body: retryDel.text.slice(0, 160), rows: retryRows() });
  } finally { await new Promise((r) => lfStub.close(r)); }
} catch (e) {
  check(false, `没有中途抛错：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`bench-card-test: ${pass} passed / ${fail} failed`);
if (fail) process.exitCode = 1;
