#!/usr/bin/env node
// 待属主看板端到端冒烟：隔离 DATA_DIR + 合成 Odoo（boss、mallory 都是 Odoo 管理员）+ MCP 网关开，跑真实写入链，再用页面同一份逻辑（web/src/owner-pending.ts）合成看板。
// 判据：
//   B1 看板台：外部台卡片地址为 /owner-pending，页面按路径找到它；台令牌读不到外部台变量
//   B2 属主登记：boss 浏览器 Odoo 会话（同源、不带口令）建 config.owner → 作者 odoo:boss，页面采信；mallory 改不了
//   B3 事项：登记会话 owner-board 建 item.* 常量 → 采信；别的会话建的 item 点名不采信；别的会话改不了 owner-board 的事项
//   B4 答复：boss 建 answer.* → 已答复；mallory、口令管理员、别的会话写的答复都不采信；boss 带 override 改自己的答复
//   B5 MCP 只授三个工具：会话调 app_data_submit 被拒
//   B6 轮换：属主带 override 修订 config.owner 加新登记身份；新会话写的事项采信；旧会话吊销后写不进，它以前写的事项照常采信；别人改不了
//   B7 抢先登记：属主登记前被别的 Odoo 管理员抢先——页面显示的属主是抢先者（看得出来），真属主登记回冲突，其答复不被采信
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { answerBody, buildBoard, configRevisionBody, findBoardWorkbench, parseConfig } from '../web/src/owner-pending.ts';

mkdirSync('tmp', { recursive: true });
const ADMIN = 'owner-board-admin';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIDS = { 'boss-session-0123456789': 'boss', 'mallory-session-0123456789': 'mallory' };
const odoo = createServer((rq, rs) => {
  let b = ''; rq.on('data', (c) => (b += c)); rq.on('end', () => {
    const u = SIDS[/session_id=([^;\s]+)/.exec(String(rq.headers.cookie ?? ''))?.[1] ?? ''];
    rs.setHeader('content-type', 'application/json');
    rs.end(JSON.stringify(u ? { jsonrpc: '2.0', id: null, result: { uid: 7, name: u, username: u, is_admin: true, is_internal_user: true } } : { jsonrpc: '2.0', id: null, result: { uid: false } }));
  });
});
await new Promise((x) => odoo.listen(0, '127.0.0.1', x));

const DATA = mkdtempSync(resolve('tmp', 'owner-board-'));
const PORT = 22000 + Math.floor(Math.random() * 20000);
const base = 'http://127.0.0.1:' + PORT;
const env = { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '', WM_ODOO_URL: `http://127.0.0.1:${odoo.address().port}` };
for (const k of ['WM_EXTENSIONS_DIR', 'WM_ODOO_ORIGINS', 'WM_LOGIN_GATE']) delete env[k];
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; child.stderr.on('data', (c) => (err += c));

const CLI = { 'content-type': 'application/json' };
const ADM = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'x-admin-token': ADMIN };
// 浏览器同源页面，只带 Odoo 会话（页面 ownerPut 的形态：不带管理员口令）
const odooPage = (sid) => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: base, cookie: `session_id=${sid}` });
async function call(method, path, headers, body) {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 无体 */ }
  return { status: r.status, body: j };
}
const vpath = (id, key) => `/api/workbenches/${id}/vars/${encodeURIComponent(key)}`;
const rpc = async (token, name, args) => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json().catch(() => null);
  const text = j?.result?.content?.[0]?.text ?? j?.error?.message ?? '';
  let out = null; try { out = JSON.parse(text); } catch { /* 错误文本 */ }
  return { isError: j?.result?.isError === true || !!j?.error, out, text };
};
const board = async (W) => {
  const r = await call('GET', `/api/workbenches/${W}/vars`, ADM);
  const items = r.body?.items ?? [];
  const cfg = parseConfig(items.find((v) => v.key === 'config.owner'));
  return { cfg, ...(cfg && !('error' in cfg) ? buildBoard(items, cfg) : { rows: [], anomalies: [] }) };
};

try {
  const end = Date.now() + 20000; let up = false;
  while (Date.now() < end && !up) { try { up = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(1500) })).ok; } catch { /* 未起 */ } if (!up) await sleep(200); }
  ok('实例就绪（MCP 网关开、合成 Odoo）', up, err.slice(-300));

  console.log('▶ B1 看板台');
  const wb = await call('POST', '/api/workbenches', CLI, { name: '待属主看板', url: `${base}/owner-pending`, type: 'web' });
  const W = wb.body?.id;
  ok('外部台卡片登记（地址为本站 /owner-pending）', wb.status === 201 && Number.isInteger(W), JSON.stringify(wb.body));
  await call('POST', '/api/workbenches', CLI, { name: '别的台', url: 'http://127.0.0.1:9/', type: 'web' });
  const list = await call('GET', '/api/workbenches', ADM);
  const found = findBoardWorkbench(list.body ?? [], base);
  ok('页面按路径找到看板台', 'id' in found && found.id === W, JSON.stringify(found));
  const anon = await call('GET', `/api/workbenches/${W}/vars`, { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' });
  ok('匿名读不到看板台变量', anon.status === 401 || anon.status === 403, String(anon.status));
  const tok = await call('GET', `/api/workbenches/${W}/vars`, { 'x-app-token': 'f'.repeat(64), 'x-forwarded-for': '203.0.113.9' });
  ok('台令牌读不到外部台变量', tok.status === 403, String(tok.status));

  console.log('▶ B2 属主登记');
  let r = await call('PUT', vpath(W, 'config.owner'), odooPage('boss-session-0123456789'), { value: { owner_login: 'boss', writers: ['mcp:owner-board'] }, kind: 'const', reason: '属主登记看板' });
  ok('boss（Odoo 管理员、同源、不带口令）建 config.owner → 作者 odoo:boss', r.status === 201 && r.body?.owner === 'odoo:boss', JSON.stringify(r.body));
  r = await call('PUT', vpath(W, 'config.owner'), odooPage('mallory-session-0123456789'), { value: { owner_login: 'mallory', writers: ['mcp:x'] }, kind: 'const', override: true, revision: 1, reason: '抢' });
  ok('mallory 改不了 config.owner', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  r = await call('PUT', vpath(W, 'config.owner'), ADM, { value: { owner_login: 'mallory', writers: ['mcp:x'] }, kind: 'const', override: true, revision: 1, reason: '抢' });
  ok('口令管理员改不了 config.owner', r.status === 403, `${r.status}`);
  let B = await board(W);
  ok('页面采信 config.owner', B.cfg && B.cfg.ownerLogin === 'boss', JSON.stringify(B.cfg));

  console.log('▶ B3 事项');
  const mk = async (name, grants) => {
    const s = await call('POST', '/api/mcp/sessions', ADM, { name });
    await call('PUT', `/api/mcp/sessions/${s.body?.id}/grants`, ADM, { grants });
    return { token: s.body?.token, id: s.body?.id };
  };
  const THREE = ['workbench_vars_get', 'workbench_vars_set', 'workbench_list'];
  const W1 = await mk('owner-board', THREE), I1 = await mk('intruder', THREE);
  const writer = W1.token, intruder = I1.token;
  ok('两个会话（登记身份、另一个会话）', typeof writer === 'string' && typeof intruder === 'string');
  const item = (q) => ({ question: q, checked: '记忆、仓库', waiting_for: '属主', first_raised: '2026-11-05', last_change: '2026-11-05', source: '监督席' });
  let m = await rpc(writer, 'workbench_vars_set', { id: W, key: 'item.1', value: item('要不要做 A'), kind: 'const' });
  ok('登记会话建 item.1 → 作者 mcp:owner-board', !m.isError && m.out?.owner === 'mcp:owner-board', m.text.slice(0, 200));
  m = await rpc(writer, 'workbench_vars_set', { id: W, key: 'item.2', value: item('要不要做 B'), kind: 'const' });
  m = await rpc(writer, 'workbench_vars_set', { id: W, key: 'item.3', value: { ...item('迁移项'), history_answer: { summary: '已在会话里答复', date: '2026-11-05' } }, kind: 'const' });
  m = await rpc(intruder, 'workbench_vars_set', { id: W, key: 'item.4', value: item('冒名事项'), kind: 'const' });
  ok('别的会话也写得进 item.4（授权不限台，靠作者核验）', !m.isError && m.out?.owner === 'mcp:intruder', m.text.slice(0, 200));
  m = await rpc(intruder, 'workbench_vars_set', { id: W, key: 'item.1', value: item('改掉'), kind: 'const', override: true, revision: 1, reason: 'x' });
  ok('别的会话改不了 owner-board 的事项', m.isError && /const_override_forbidden|作者/.test(m.text), m.text.slice(0, 200));
  m = await rpc(writer, 'workbench_vars_set', { id: W, key: 'item.2', value: { ...item('要不要做 B'), status: 'withdrawn' }, kind: 'const', override: true, revision: 1, reason: '监督席：提出方撤回' });
  ok('登记会话带 override 与 reason 撤回 item.2', !m.isError && m.out?.revision === 2, m.text.slice(0, 200));

  console.log('▶ B4 答复');
  r = await call('PUT', vpath(W, 'answer.1'), odooPage('mallory-session-0123456789'), answerBody('mallory 冒答', '2026-11-06', null));
  ok('mallory 写得进 answer.1（Odoo 管理员都能写，靠作者核验）', r.status === 201 && r.body?.owner === 'odoo:mallory', JSON.stringify(r.body));
  r = await call('PUT', vpath(W, 'answer.3'), ADM, answerBody('口令冒答', '2026-11-06', null));
  ok('口令管理员写的答复没有作者', r.status === 201 && r.body?.owner === '', JSON.stringify(r.body));
  m = await rpc(intruder, 'workbench_vars_set', { id: W, key: 'answer.4', value: { summary: '会话冒答' }, kind: 'const' });
  B = await board(W);
  const by = Object.fromEntries(B.rows.map((x) => [x.no, x]));
  const why = Object.fromEntries(B.anomalies.map((a) => [a.key, a.reason]));
  ok('冒答不算：item.1 仍待办，answer.1 点名 odoo:mallory', by['1']?.status === 'open' && /odoo:mallory/.test(why['answer.1'] || ''), JSON.stringify({ row: by['1'], why }));
  ok('口令写的答复点名「无」作者', /作者「无」/.test(why['answer.3'] || ''), why['answer.3']);
  ok('冒名事项 item.4 点名 mcp:intruder，不进看板', !by['4'] && /mcp:intruder/.test(why['item.4'] || ''), JSON.stringify(why));
  ok('撤回与历史答复（历史答复单独成 history）', by['2']?.status === 'withdrawn' && by['3']?.status === 'history' && by['3']?.answer?.historical === true);

  // answer.1 被 mallory 占了：属主新建会冲突、也改不了别人的常量——页面列为来源不符，清理走部署机本机命令行
  r = await call('PUT', vpath(W, 'answer.1'), odooPage('boss-session-0123456789'), answerBody('boss 答', '2026-11-06', null));
  ok('被占的答复键：属主新建回冲突（页面点名，命令行清理）', r.status === 409 || r.status === 428 || r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  r = await call('DELETE', vpath(W, 'answer.1') + '?revision=1&override=1&reason=' + encodeURIComponent('清理冒答'), CLI);
  ok('部署机本机命令行可清理冒答', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  r = await call('PUT', vpath(W, 'answer.1'), odooPage('boss-session-0123456789'), answerBody('可以做 A', '2026-11-06', null));
  ok('boss 答复 answer.1 → 作者 odoo:boss', r.status === 201 && r.body?.owner === 'odoo:boss', JSON.stringify(r.body));
  r = await call('PUT', vpath(W, 'answer.1'), odooPage('boss-session-0123456789'), answerBody('可以做 A，下周', '2026-11-07', 1));
  ok('boss 带 override 改自己的答复', r.status === 200 && r.body?.revision === 2, JSON.stringify(r.body));
  B = await board(W);
  const one = B.rows.find((x) => x.no === '1');
  ok('看板：item.1 已答复，显示最新答复', one?.status === 'answered' && one.answer?.summary === '可以做 A，下周' && one.answer?.by === 'odoo:boss', JSON.stringify(one));
  const audit = await call('GET', vpath(W, 'answer.1') + '/audit', ADM);
  ok('审计记操作人 odoo:boss', (audit.body?.items ?? []).some((a) => a.actor === 'odoo:boss'), JSON.stringify(audit.body).slice(0, 200));

  console.log('▶ B5 授权范围');
  m = await rpc(writer, 'app_data_submit', { slug: 'x', data: {} });
  ok('只授三个工具：调 app_data_submit 被拒', m.isError && /not_granted|未授权|授权|Method not found/.test(m.text), m.text.slice(0, 200));

  console.log('▶ B6 轮换登记身份');
  const W2 = await mk('owner-board-2', THREE);
  let cur = (await board(W)).cfg;
  r = await call('PUT', vpath(W, 'config.owner'), odooPage('mallory-session-0123456789'), configRevisionBody(cur, ['mcp:owner-board', 'mcp:mallory-seat']));
  ok('别的 Odoo 管理员修订不了 config.owner', r.status === 403, `${r.status}`);
  r = await call('PUT', vpath(W, 'config.owner'), odooPage('boss-session-0123456789'), configRevisionBody(cur, ['mcp:owner-board', 'mcp:owner-board-2']));
  ok('属主带 override 与当前 revision 修订 config.owner', r.status === 200 && r.body?.owner === 'odoo:boss' && r.body?.revision === cur.revision + 1, JSON.stringify(r.body));
  cur = (await board(W)).cfg;
  ok('回读：登记身份含新会话、属主不变', cur && cur.ownerLogin === 'boss' && JSON.stringify(cur.writers) === '["mcp:owner-board","mcp:owner-board-2"]', JSON.stringify(cur));
  m = await rpc(W2.token, 'workbench_vars_set', { id: W, key: 'item.7', value: item('新会话登记的事项'), kind: 'const' });
  ok('新会话建 item.7', !m.isError && m.out?.owner === 'mcp:owner-board-2', m.text.slice(0, 200));
  r = await call('DELETE', `/api/mcp/sessions/${W1.id}`, ADM);
  ok('吊销旧会话', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  m = await rpc(writer, 'workbench_vars_set', { id: W, key: 'item.8', value: item('旧会话吊销后再写'), kind: 'const' });
  ok('旧会话吊销后写不进', m.isError || !m.out?.owner, m.text.slice(0, 120));
  B = await board(W);
  const ids = B.rows.map((x) => x.no);
  ok('看板：新会话的 item.7 采信，旧会话以前写的 item.1 照常采信，没有 item.8', ids.includes('7') && ids.includes('1') && !ids.includes('8'), JSON.stringify(ids));

  console.log('▶ B7 抢先登记');
  const wb2 = await call('POST', '/api/workbenches', CLI, { name: '看板（抢先场景）', url: 'http://127.0.0.1:9/owner-pending-preempt', type: 'web' });
  const P = wb2.body?.id;
  r = await call('PUT', vpath(P, 'config.owner'), odooPage('mallory-session-0123456789'), { value: { owner_login: 'mallory', writers: ['mcp:owner-board-2'] }, kind: 'const', reason: '抢先' });
  ok('别的 Odoo 管理员抢先登记成功（服务端不知道谁是真属主）', r.status === 201 && r.body?.owner === 'odoo:mallory', JSON.stringify(r.body));
  r = await call('PUT', vpath(P, 'config.owner'), odooPage('boss-session-0123456789'), { value: { owner_login: 'boss', writers: ['mcp:owner-board-2'] }, kind: 'const', reason: '属主登记' });
  ok('真属主再登记被拒（常量已锁，不会被静默覆盖）', r.status === 403 || r.status === 409 || r.status === 428, `${r.status}`);
  await rpc(W2.token, 'workbench_vars_set', { id: P, key: 'item.1', value: item('事项'), kind: 'const' });
  await call('PUT', vpath(P, 'answer.1'), odooPage('boss-session-0123456789'), answerBody('真属主的答复', '2026-11-06', null));
  const pr = await call('GET', `/api/workbenches/${P}/vars`, ADM);
  const pc = parseConfig(pr.body.items.find((x) => x.key === 'config.owner'));
  const pb = buildBoard(pr.body.items, pc);
  ok('页面顶部显示的属主是抢先者 odoo:mallory（看得出来，可据此作废本机清理）', pc && pc.ownerLogin === 'mallory', JSON.stringify(pc));
  ok('真属主的答复不被当作属主答复，点名作者', pb.rows[0]?.status === 'open' && pb.anomalies.some((a) => a.key === 'answer.1' && /odoo:boss/.test(a.reason)), JSON.stringify(pb));
  const au = await call('GET', vpath(P, 'config.owner') + '/audit', ADM);
  ok('审计能查出抢先者：config.owner 的 create actor = odoo:mallory', (au.body?.items ?? []).some((a) => a.action === 'create' && a.actor === 'odoo:mallory'), JSON.stringify(au.body).slice(0, 200));
} finally {
  if (child.exitCode === null) { const ex = new Promise((x) => child.once('exit', x)); child.kill(); await ex; }
  odoo.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nowner-pending-board-smoke: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
