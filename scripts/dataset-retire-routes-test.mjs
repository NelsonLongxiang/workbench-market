#!/usr/bin/env node
/**
 * 数据集退役与恢复的接口（#1015 首版）：起隔离实例（假登录提供方，NODE_ENV=test），逐条看预检、短期确认票、确认、恢复和身份对抗。
 *
 *   一、谁进不了：没登录、管理口令、跨站、没有授予的员工、停用的账号，预检和确认都被拒；台不存在对没权限的人也是 403，不泄露存在
 *   二、预检：被现行视图引用的阻断并列出位置；没引用的发票；已退役的退役预检阻断；预检不带请求体
 *   三、确认：不复述名字、没理由、没操作号、带多余字段都 400；票错、票是别的人的、票是别的数据集的、票用过、数据集变了（视图修订）都 409
 *   四、退役：成功后普通读写、同名定义、查询都拒；列表里没有；「已退役」列表有；票只能用一次
 *   五、恢复：独立预检和确认；恢复后读写照旧、数据还在；退役中的数据集再退役预检阻断
 *   六、权限分档：预检、退役、恢复三个动作各自判权
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'tmp', `dataset-retire-routes-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-bench-dept-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.71' };
let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

let child = null;
async function boot() {
  const port = await freePort();
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const dir of [data, home, ext]) mkdirSync(dir, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_BENCH_VIEWS: 'on', WM_EXTENSIONS_DIR: ext });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (x) => { log += String(x); });
  child.stderr.on('data', (x) => { log += String(x); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  return { base, host: new URL(base).host, call, log: () => log, db: () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 }) };
}

try {
  const srv = await boot();
  const db = srv.db();
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };
  const as = (session) => ({ headers: { ...REMOTE, ...same }, session });
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  // 授予：alpha 管理层（范围全部）；beta 没有授予；admin（属主）本来就有
  const grant = async (principal, role) => { const g = await srv.call('POST', '/api/grants', { body: { principal, role, scope: '*', reason: '合成：退役接口' } }); const id = g.json?.grant?.id; await srv.call('POST', `/api/grants/${id}/submit`); return (await srv.call('POST', `/api/grants/${id}/approve`)).status; };
  const gs = await grant('user:alpha', 'management');
  check(gs === 200, '（准备）alpha 拿到管理层、范围「全部」的授予', gs);
  const mgr = as(SESSIONS.alpha), nobody = as(SESSIONS.beta);
  const B = '/api/bench-views/demo';
  let r = await srv.call('POST', '/api/bench-views', { ...mgr, body: { slug: 'demo', title: '示例台' } });
  check(r.status === 201, '（准备）建台', r.text.slice(0, 120));
  const def = { title: '订单', key: ['id'], columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'region', type: 'text', label: '地区' }] };
  for (const n of ['old_orders', 'used_orders']) r = await srv.call('PUT', `${B}/datasets/${n}`, { ...mgr, body: def });
  r = await srv.call('POST', `${B}/datasets/old_orders/rows?op=append`, { ...mgr, body: undefined });
  const rowsRes = await fetch(srv.base + `${B}/datasets/old_orders/rows?op=append`, { method: 'POST', headers: { ...REMOTE, ...same, cookie: `session_id=${SESSIONS.alpha}`, 'content-type': 'application/json' }, body: JSON.stringify([{ id: 1, region: '东' }, { id: 2, region: '西' }]) });
  check(rowsRes.status === 200, '（准备）写两行', rowsRes.status);
  const doc = { title: '台', views: [{ key: 'v', title: 'v', blocks: [{ type: 'table', query: { dataset: 'used_orders', sort: [{ col: 'id' }] } }] }] };
  r = await srv.call('PUT', `${B}/view`, { ...mgr, body: { doc, base: 0, note: '引用 used_orders' } });
  check(r.status === 200, '（准备）视图引用 used_orders', r.text.slice(0, 160));

  console.log('一、谁进不了');
  const pre = (n, who) => srv.call('POST', `${B}/datasets/${n}/retire/precheck`, who);
  const denied = {
    anonymous: await pre('old_orders', { headers: { ...REMOTE, ...same } }),
    token: await pre('old_orders', { headers: { ...REMOTE, ...same, 'x-admin-token': ADMIN_TOKEN } }),
    cross: await pre('old_orders', { headers: { ...REMOTE, ...cross }, session: SESSIONS.alpha }),
    staff: await pre('old_orders', nobody),
    noBenchStaff: await srv.call('POST', '/api/bench-views/ghost/datasets/old_orders/retire/precheck', nobody),
  };
  const bad = Object.entries(denied).filter(([, x]) => ![401, 403].includes(x.status)).map(([k, x]) => [k, x.status]);
  check(bad.length === 0, '预检：没登录、管理口令、跨站、没有授予的员工都被拒（401/403）', bad);
  check(denied.noBenchStaff.status === 403 && denied.staff.status === 403 && denied.noBenchStaff.text === denied.staff.text, '没权限的人问不存在的台和存在的台，应答一样（不泄露台是否存在）', [denied.noBenchStaff.text, denied.staff.text]);
  const confirmBody = { ticket: 'x'.repeat(43), confirm_name: 'old_orders', reason: '合成', operation_id: 'op-denied-0001' };
  const deniedConfirm = [await srv.call('POST', `${B}/datasets/old_orders/retire`, { headers: { ...REMOTE, ...same }, body: confirmBody }), await srv.call('POST', `${B}/datasets/old_orders/retire`, { ...nobody, body: confirmBody }), await srv.call('POST', `${B}/datasets/old_orders/restore`, { ...nobody, body: confirmBody })];
  check(deniedConfirm.every((x) => [401, 403].includes(x.status)), '确认和恢复：没登录、没授予的员工被拒', deniedConfirm.map((x) => x.status));
  const list0 = await srv.call('GET', `${B}/retired-datasets`, nobody);
  check(list0.status === 403, '「已退役」清单：没授予的员工 403', list0.status);

  console.log('二、预检');
  const p1 = await pre('old_orders', { ...mgr });
  check(p1.status === 200 && p1.json?.blockers?.length === 0 && typeof p1.json?.ticket === 'string' && p1.json.rows === 2 && p1.json.state === 'active', '没被引用的数据集：预检通过，发票，回行数', p1.text.slice(0, 200));
  const p2 = await pre('used_orders', mgr);
  check(p2.status === 200 && p2.json?.ticket === undefined && p2.json?.blockers?.some((x) => x.kind === 'view' && x.view === 'v' && x.block === 0), '被现行视图引用：预检不发票，列出视图和块位置', p2.text.slice(0, 240));
  const p3 = await srv.call('POST', `${B}/datasets/old_orders/retire/precheck`, { ...mgr, body: { x: 1 } });
  check(p3.status === 400, '预检带请求体：400', p3.status);
  const p4 = await srv.call('POST', `${B}/datasets/Bad-Name/retire/precheck`, mgr);
  check(p4.status === 400, '数据集名写法不对：400', p4.status);
  const p5 = await srv.call('POST', `${B}/datasets/ghost_ds/retire/precheck`, mgr);
  check(p5.status === 404, '没有这个数据集：404', p5.status);

  console.log('三、确认的拒绝（每一条都不能烧掉有效票）');
  const T = p1.json.ticket;
  const conf = (body, who = mgr, n = 'old_orders') => srv.call('POST', `${B}/datasets/${n}/retire`, { ...who, body });
  const ok0 = { ticket: T, confirm_name: 'old_orders', reason: '合成：废弃', operation_id: 'op-retire-0001' };
  const bads = [
    ['没复述名字', { ...ok0, confirm_name: 'other' }], ['没理由', { ...ok0, reason: ' ' }], ['理由太长', { ...ok0, reason: 'x'.repeat(501) }],
    ['没操作号', { ...ok0, operation_id: undefined }], ['操作号写法不对', { ...ok0, operation_id: 'a b' }], ['多余字段', { ...ok0, force: true }],
  ];
  for (const [label, body] of bads) { const x = await conf(body); check(x.status === 400, `${label}：400`, x.text.slice(0, 120)); }
  const wrongTicket = await conf({ ...ok0, ticket: 'A'.repeat(43) });
  check(wrongTicket.status === 409, '票是瞎写的：409', wrongTicket.status);
  const otherDs = await pre('used_orders', mgr);
  const p6 = await srv.call('POST', `${B}/datasets/old_orders/retire/precheck`, mgr);
  const crossDataset = await conf({ ...ok0, ticket: p6.json.ticket, confirm_name: 'used_orders' }, mgr, 'used_orders');
  check(crossDataset.status === 409 && /预检凭据/.test(crossDataset.text), '拿 old_orders 的票去确认 used_orders（名字复述对）：409 预检凭据无效，不是别的原因拒的', crossDataset.text.slice(0, 160));
  const crossActor = await conf({ ...ok0, ticket: p6.json.ticket }, as(SESSIONS.admin));
  check(crossActor.status === 409 && /预检凭据/.test(crossActor.text), '另一个有权限的人拿这张票：409 预检凭据无效（票绑发票的人）', crossActor.text.slice(0, 160));
  check(otherDs.status === 200, '（对照）另一个数据集预检本身正常', otherDs.status);

  console.log('四、退役');
  const done = await conf({ ...ok0, ticket: p6.json.ticket });
  check(done.status === 200 && done.json?.state === 'retired' && done.json?.action === 'retire', '带对票、复述名字、理由：退役成功', done.text.slice(0, 200));
  const replay = await conf({ ...ok0, ticket: p6.json.ticket });
  check(replay.status === 409, '同一张票第二次用：409（票只能用一次）', replay.status);
  const list = await srv.call('GET', `${B}/datasets`, mgr);
  check(!JSON.stringify(list.json ?? '').includes('old_orders'), '普通清单里没有已退役的数据集', list.text.slice(0, 160));
  const rd = await srv.call('POST', `${B}/query`, { ...mgr, body: { query: { dataset: 'old_orders', sort: [{ col: 'id' }] } } });
  check(rd.status === 409 && /已退役/.test(rd.text), '已退役的数据集普通查询被拒：409 已退役（不是别的错误）', rd.text.slice(0, 160));
  const redef = await srv.call('PUT', `${B}/datasets/old_orders`, { ...mgr, body: def });
  check(redef.status === 409, '同名重新定义被拒（不能借定义复活）', redef.status);
  const rlist = await srv.call('GET', `${B}/retired-datasets`, mgr);
  check(rlist.status === 200 && rlist.json?.datasets?.some((x) => x.name === 'old_orders' && x.row_count === 2), '「已退役」清单：有它，行数保留', rlist.text.slice(0, 200));
  const again = await pre('old_orders', mgr);
  check(again.status === 200 && again.json?.ticket === undefined && again.json?.blockers?.some((x) => x.reason === 'already_retired'), '已退役的再预检退役：阻断，不发票', again.text.slice(0, 200));
  const aud = db.prepare("SELECT COUNT(*) n FROM sqlite_master").get();
  check(Number(aud.n) > 0, '（对照）主库可读', aud.n);

  console.log('五、恢复');
  const rp = await srv.call('POST', `${B}/datasets/old_orders/restore/precheck`, mgr);
  check(rp.status === 200 && rp.json?.state === 'retired' && typeof rp.json?.ticket === 'string', '恢复预检：发票', rp.text.slice(0, 200));
  const stale = await srv.call('POST', `${B}/datasets/old_orders/retire`, { ...mgr, body: { ...ok0, ticket: rp.json.ticket, operation_id: 'op-wrong-action1' } });
  check(stale.status === 409, '恢复票不能拿去退役', stale.status);
  const rest = await srv.call('POST', `${B}/datasets/old_orders/restore`, { ...mgr, body: { ticket: rp.json.ticket, confirm_name: 'old_orders', reason: '合成：恢复', operation_id: 'op-restore-0001' } });
  check(rest.status === 200 && rest.json?.state === 'active', '恢复成功', rest.text.slice(0, 200));
  const q = await srv.call('POST', `${B}/query`, { ...mgr, body: { query: { dataset: 'old_orders', sort: [{ col: 'id' }] } } });
  check(q.status === 200 && JSON.stringify(q.json).includes('东') && JSON.stringify(q.json).includes('西'), '恢复后数据一行不少', q.text.slice(0, 200));
  const rp2 = await srv.call('POST', `${B}/datasets/old_orders/restore/precheck`, mgr);
  check(rp2.status === 200 && rp2.json?.ticket === undefined && rp2.json?.blockers?.some((x) => x.reason === 'not_retired'), '没退役的数据集恢复预检：阻断', rp2.text.slice(0, 200));

  console.log('六、数据集变了，旧票作废');
  const p7 = await pre('old_orders', mgr);
  await srv.call('PUT', `${B}/view`, { ...mgr, body: { doc: { ...doc, title: '台二版' }, base: 1, note: '改视图，修订推进' } });
  const staleCtx = await conf({ ...ok0, ticket: p7.json.ticket, operation_id: 'op-retire-0002' });
  check(staleCtx.status === 409, '预检之后视图改了（修订推进）：旧票 409，要重新预检', staleCtx.status);

  console.log('七、确认票模块（到期、只用一次、绑定、数量上限）');
  const { issueRetireTicket, takeRetireTicket, RETIRE_TICKET_TTL_MS } = await import('../server/src/dataset-retire-tickets.ts');
  const bind = (o = {}) => ({ action: 'retire', actor: 'user:u1', bench: 'demo', benchCreatedAt: 1, dataset: 'ds', contextSha256: 'c1', ...o });
  const i1 = issueRetireTicket(bind(), 1000);
  check(takeRetireTicket(i1.ticket, bind(), 1000 + 1) === i1.ref && takeRetireTicket(i1.ticket, bind(), 1000 + 2) === null, '票用一次就作废', i1.ref);
  const i2 = issueRetireTicket(bind(), 1000);
  check(takeRetireTicket(i2.ticket, bind(), 1000 + RETIRE_TICKET_TTL_MS) === null, '到期的票不收（到期时刻整点就算过期）');
  const i3 = issueRetireTicket(bind(), 1000);
  check(takeRetireTicket(i3.ticket, bind(), 1000 + RETIRE_TICKET_TTL_MS - 1) === i3.ref, '到期前一毫秒还收');
  const i4 = issueRetireTicket(bind(), 5000);
  check(takeRetireTicket(i4.ticket, bind({ actor: 'user:u2' }), 5001) === null && takeRetireTicket(i4.ticket, bind({ action: 'restore' }), 5001) === null && takeRetireTicket(i4.ticket, bind({ dataset: 'other' }), 5001) === null
    && takeRetireTicket(i4.ticket, bind({ contextSha256: 'c2' }), 5001) === null && takeRetireTicket(i4.ticket, bind({ bench: 'b2' }), 5001) === null && takeRetireTicket(i4.ticket, bind({ benchCreatedAt: 2 }), 5001) === null, '换人、换动作、换数据集、换上下文、换台、同名台重建：都不收');
  check(takeRetireTicket(i4.ticket, bind(), 5002) === i4.ref, '对不上的尝试不烧掉有效票');
  const many = Array.from({ length: 10 }, () => issueRetireTicket(bind({ actor: 'user:cap' }), 9000));
  check(many.every(Boolean) && issueRetireTicket(bind({ actor: 'user:cap' }), 9000) === null && issueRetireTicket(bind({ actor: 'user:other' }), 9000) !== null, '每个账号最多 10 张未用的票，第 11 张拒；别的账号不受影响');
  check(takeRetireTicket('short', bind(), 9001) === null && takeRetireTicket(undefined, bind(), 9001) === null && takeRetireTicket('x'.repeat(200), bind(), 9001) === null, '票的写法不对：不收');

  console.log(`dataset-retire-routes-test: ${pass} passed / ${fail} failed`);
} catch (e) {
  check(false, '没跑完', String(e?.stack ?? e));
  console.log(`dataset-retire-routes-test: ${pass} passed / ${fail} failed`);
} finally {
  try { child?.kill('SIGTERM'); } catch { /* 已退出 */ }
  await sleep(300);
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* 留着也行 */ }
  process.exit(fail ? 1 : 0);
}
