#!/usr/bin/env node
/** MCP 权限可见 + 自助申请冒烟（独立实例：全新 DATA_DIR + ADMIN_TOKEN + MCP_GATEWAY=on；替身 GitHub 发一个带数据契约的中性台）。
 *  覆盖：未授权会话 access_info 看得到完整目录且 granted 正确、tools/list 始终列出两个免授权工具；
 *  access_request 校验、同组去重、每小时 10 条限频；非管理员（含会话令牌）批准 403；管理员批准 = 并集、tools/list 立即可见、审计同事务；
 *  驳回不动 grants；已吊销会话不能批准；app_data_submit 与 REST 同核——违约 400 + violations、合规写入、幂等键；匿名 /mcp 仍 401。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const PORT = Number(process.env.GW_PORT) > 0 ? Number(process.env.GW_PORT) : 20000 + Math.floor(Math.random() * 12000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-access-' + Date.now().toString(36);
const SLUG = 'access-demo';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const gh = await startFakeGithub();
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'acc-admin-tok', MCP_GATEWAY: 'on', WM_GITHUB_API: gh.api },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); child.kill(); process.exit(1); }

const AT = { 'X-Admin-Token': 'acc-admin-tok' };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
async function rpc(method, params, token) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  return call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, h);
}
/** tools/call → { isError, text, payload(JSON 解析后的正文；失败时解析 text 第二行的具名字段) } */
async function tool(token, name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args }, token);
  const text = r.body?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(r.body?.result?.isError ? text.split('\n').slice(1).join('\n') : text); } catch { /* 无结构 */ }
  return { status: r.status, rpcError: r.body?.error ?? null, isError: !!r.body?.result?.isError, text, payload };
}
async function newSession(name, grants = []) {
  const r = await call('POST', '/api/mcp/sessions', { name }, AT);
  if (grants.length) await call('PUT', `/api/mcp/sessions/${r.body.id}/grants`, { grants }, AT);
  return { id: r.body.id, token: r.body.token };
}
const listNames = async (token) => ((await rpc('tools/list', {}, token)).body?.result?.tools ?? []).map((t) => t.name);
const grantsOf = async (id) => ((await call('GET', '/api/mcp/sessions', null, AT)).body ?? []).find((s) => s.id === id)?.grants ?? null;

try {
  // ============ 准备：中性台 + 数据契约 ============
  const contract = {
    version: 1, type_fields: ['record_type'], unknown_types: 'reject',
    types: { task: { required: ['title', 'state'], enum: { state: ['todo', 'done'] }, file_ids: true } },
  };
  const pub = await ghPublish(BASE, gh, { slug: SLUG, title: 'Access demo', files: [
    { path: 'index.html', content: '<h1>demo</h1>' },
    { path: 'data-contract.json', content: JSON.stringify(contract) },
  ] }, AT);
  ok('准备：带契约的中性台同步发布 201', pub.status === 201, `status=${pub.status}`);

  // ============ 匿名仍 401 ============
  let r = await rpc('tools/list');
  ok('匿名 tools/list 401', r.status === 401);
  r = await rpc('tools/call', { name: 'access_info', arguments: {} });
  ok('匿名 access_info 401（免授权≠免认证）', r.status === 401);
  r = await rpc('tools/call', { name: 'access_info', arguments: {} }, 'f'.repeat(64));
  ok('无效令牌 access_info 401', r.status === 401);

  // ============ access_info：未授权会话看得到完整目录 ============
  const bare = await newSession('agent-bare');
  let names = await listNames(bare.token);
  ok('零授权会话 tools/list 只有免授权的五个（权限自助两个 + 读技能三个）', [...names].sort().join() === 'access_info,access_request,skill_read,skill_search,skills_list', JSON.stringify(names));
  let info = await tool(bare.token, 'access_info');
  ok('零授权会话 access_info 可调', !info.isError && info.payload?.session === 'agent-bare', info.text.slice(0, 120));
  const catalog = info.payload?.catalog ?? [];
  const adminTools = (await call('GET', '/api/mcp/tools', null, AT)).body ?? [];
  ok('目录与注册表一致（34 = 27 + access_info/access_request/app_data_submit + 技能传输 3 + skill_read）', catalog.length === 34 && adminTools.length === 34, `catalog=${catalog.length} admin=${adminTools.length}`);
  ok('目录每项带 name/description/category/granted', catalog.every((t) => t.name && typeof t.description === 'string' && ['read', 'write', 'admin'].includes(t.category) && typeof t.granted === 'boolean'));
  ok('零授权：只有免授权的五个 granted=true', catalog.filter((t) => t.granted).map((t) => t.name).sort().join() === 'access_info,access_request,skill_read,skill_search,skills_list');
  ok('类别标注：app_data_list=read · app_data_submit=write · workbench_register=admin',
    catalog.find((t) => t.name === 'app_data_list')?.category === 'read'
    && catalog.find((t) => t.name === 'app_data_submit')?.category === 'write'
    && catalog.find((t) => t.name === 'workbench_register')?.category === 'admin');
  ok('tools/list 不外露 category/exempt 内部字段', ((await rpc('tools/list', {}, bare.token)).body?.result?.tools ?? []).every((t) => !('category' in t) && !('exempt' in t)));

  const part = await newSession('agent-part', ['workbench_summary']);
  info = await tool(part.token, 'access_info');
  const g = Object.fromEntries((info.payload?.catalog ?? []).map((t) => [t.name, t.granted]));
  ok('部分授权：granted 标记正确', g.workbench_summary === true && g.app_data_submit === false && g.access_info === true, JSON.stringify(info.payload?.granted_tools));
  ok('granted_tools = 已授权 + 免授权', (info.payload?.granted_tools ?? []).sort().join() === 'access_info,access_request,skill_read,skill_search,skills_list,workbench_summary');
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: {} });
  ok('未授权 app_data_submit 仍按不存在应答', r.rpcError?.code === -32601);

  // ============ access_request：校验 / 去重 / 限频 ============
  r = await tool(bare.token, 'access_request', { tools: ['no_such_tool'], reason: 'x' });
  ok('目录外工具名拒绝', r.isError && r.text.includes('不在工具目录'));
  r = await tool(bare.token, 'access_request', { tools: ['app_data_list'], reason: '   ' });
  ok('reason 空拒绝', r.isError && r.text.includes('reason'));
  r = await tool(bare.token, 'access_request', { tools: ['app_data_list'], reason: '字'.repeat(501) });
  ok('reason 超 500 字拒绝', r.isError && r.text.includes('500'));
  r = await tool(bare.token, 'access_request', { tools: ['access_info'], reason: '已可用' });
  ok('只申请已可用工具拒绝', r.isError && r.text.includes('无需申请'));
  r = await tool(bare.token, 'access_request', { tools: [], reason: 'x' });
  ok('空 tools 拒绝', r.isError);

  const first = await tool(bare.token, 'access_request', { tools: ['app_data_list', 'app_data_submit'], reason: '登记任务数据' });
  ok('首次申请建 pending', !first.isError && first.payload?.duplicate === false && first.payload?.request?.status === 'pending', first.text.slice(0, 160));
  const dup = await tool(bare.token, 'access_request', { tools: ['app_data_submit', 'app_data_list', 'app_data_list'], reason: '换个说法' });
  ok('同组工具（顺序/重复不同）去重返回原申请', dup.payload?.duplicate === true && dup.payload?.request?.id === first.payload?.request?.id, dup.text.slice(0, 160));
  const singles = catalog.filter((t) => !t.granted && !['app_data_list', 'app_data_submit'].includes(t.name)).map((t) => t.name);
  let lastOk = null;
  for (let i = 0; i < 9; i++) lastOk = await tool(bare.token, 'access_request', { tools: [singles[i]], reason: `第 ${i + 2} 条` });
  ok('一小时内第 10 条仍可提', !lastOk.isError && lastOk.payload?.duplicate === false, lastOk.text.slice(0, 120));
  r = await tool(bare.token, 'access_request', { tools: [singles[9]], reason: '第 11 条' });
  ok('第 11 条限频拒绝', r.isError && r.text.includes('10'), r.text.slice(0, 120));
  r = await tool(bare.token, 'access_request', { tools: ['app_data_list', 'app_data_submit'], reason: '再问一次' });
  ok('限频后同组去重仍返回原申请（不新建）', r.payload?.duplicate === true && r.payload?.request?.id === first.payload?.request?.id);
  info = await tool(bare.token, 'access_info');
  ok('access_info 列出本会话 10 条申请及状态', (info.payload?.requests ?? []).length === 10 && info.payload.requests.every((q) => q.status === 'pending' && !('decided_by' in q)));

  // ============ 管理端：列表 / 非管理员 403 / 批准并集 ============
  r = await call('GET', '/api/mcp/access-requests');
  ok('列表无口令 403', r.status === 403);
  r = await call('GET', '/api/mcp/access-requests?status=bogus', null, AT);
  ok('坏 status 400', r.status === 400);
  r = await call('GET', '/api/mcp/access-requests?status=pending', null, AT);
  ok('管理员按 status 过滤列表', r.status === 200 && r.body.length === 10 && r.body.every((q) => q.status === 'pending' && q.session_name === 'agent-bare'), `len=${r.body?.length}`);

  const pr = await tool(part.token, 'access_request', { tools: ['app_data_submit', 'app_data_list'], reason: '往中性台登记任务并读回' });
  const prId = pr.payload?.request?.id;
  r = await call('POST', `/api/mcp/access-requests/${prId}/approve`, {});
  ok('无口令批准 403', r.status === 403, `status=${r.status}`);
  r = await call('POST', `/api/mcp/access-requests/${prId}/approve`, {}, { 'X-Admin-Token': 'wrong' });
  ok('错误口令批准 403', r.status === 403);
  r = await call('POST', `/api/mcp/access-requests/${prId}/approve`, {}, { Authorization: `Bearer ${part.token}` });
  ok('会话令牌不能自己批准 403', r.status === 403);
  r = await tool(part.token, 'access_approve', { id: prId });
  ok('MCP 面没有批准工具', r.rpcError?.code === -32601);
  ok('批准前 grants 未变', JSON.stringify(await grantsOf(part.id)) === '["workbench_summary"]');

  r = await call('POST', `/api/mcp/access-requests/${prId}/approve`, { note: '同意' }, AT);
  ok('管理员批准 200', r.status === 200 && r.body?.status === 'approved', JSON.stringify(r.body).slice(0, 160));
  ok('批准 = 并集（保留原有 workbench_summary）', JSON.stringify(r.body?.grants) === '["workbench_summary","app_data_list","app_data_submit"]', JSON.stringify(r.body?.grants));
  names = await listNames(part.token);
  ok('tools/list 立即多出所批工具', names.includes('app_data_submit') && names.includes('app_data_list') && names.includes('workbench_summary') && names.length === 8, JSON.stringify(names));
  r = await call('POST', `/api/mcp/access-requests/${prId}/approve`, {}, AT);
  ok('重复批准 409', r.status === 409);
  info = await tool(part.token, 'access_info');
  ok('会话在 access_info 看到 approved + 备注', info.payload?.requests?.[0]?.status === 'approved' && info.payload.requests[0].note === '同意');

  // ============ 驳回不改 grants ============
  const rj = await tool(part.token, 'access_request', { tools: ['workbench_register'], reason: '登记外部台' });
  const before = await grantsOf(part.id);
  r = await call('POST', `/api/mcp/access-requests/${rj.payload?.request?.id}/reject`, {});
  ok('无口令驳回 403', r.status === 403);
  r = await call('POST', `/api/mcp/access-requests/${rj.payload?.request?.id}/reject`, { note: '不需要' }, AT);
  ok('管理员驳回 200', r.status === 200 && r.body?.status === 'rejected');
  ok('驳回后 grants 不变', JSON.stringify(await grantsOf(part.id)) === JSON.stringify(before));
  ok('驳回后 tools/list 不含所申请工具', !(await listNames(part.token)).includes('workbench_register'));
  r = await call('POST', `/api/mcp/access-requests/${rj.payload?.request?.id}/approve`, {}, AT);
  ok('已驳回的申请不能再批准 409', r.status === 409);

  // ============ 已吊销会话不能批准 ============
  const gone = await newSession('agent-gone');
  const gr = await tool(gone.token, 'access_request', { tools: ['app_files_upload'], reason: '上传附件' });
  await call('DELETE', `/api/mcp/sessions/${gone.id}`, null, AT);
  r = await call('POST', `/api/mcp/access-requests/${gr.payload?.request?.id}/approve`, {}, AT);
  ok('已吊销会话批准 409', r.status === 409 && String(r.body?.error).includes('吊销'), JSON.stringify(r.body));
  ok('吊销会话 grants 仍为空', JSON.stringify(await grantsOf(gone.id)) === '[]');
  r = await call('GET', '/api/mcp/access-requests?status=pending', null, AT);
  const goneRow = (r.body ?? []).find((q) => q.id === gr.payload?.request?.id);
  ok('该申请仍 pending 且标记会话已吊销', goneRow?.status === 'pending' && goneRow.session_revoked === true);
  r = await call('POST', `/api/mcp/access-requests/${gr.payload?.request?.id}/reject`, {}, AT);
  ok('已吊销会话的申请可驳回', r.status === 200);

  // ============ 审计 ============
  {
    const db = new DatabaseSync(`${DATA}/workbench-market.db`, { readOnly: true });
    const rows = db.prepare('SELECT session_id, request_id, action, actor, grants_before, grants_after FROM mcp_grant_audit ORDER BY id').all();
    db.close();
    ok('审计：批准 1 + 驳回 2，审批人记录为 admin-token', rows.length === 3 && rows.every((x) => x.actor === 'admin-token') && rows.filter((x) => x.action === 'access_request_approve').length === 1, JSON.stringify(rows.map((x) => x.action)));
    const ap = rows.find((x) => x.action === 'access_request_approve');
    ok('审计：批准行记前后 grants', ap?.grants_before === '["workbench_summary"]' && ap.grants_after.includes('app_data_submit'));
    ok('审计：驳回行前后 grants 相同', rows.filter((x) => x.action === 'access_request_reject').every((x) => x.grants_before === x.grants_after));
  }

  // ============ app_data_submit：与 REST 同核 ============
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: { record_type: 'task', title: '', state: 'later' } });
  ok('契约违约 → isError + status 400 + violations', r.isError && r.payload?.status === 400 && Array.isArray(r.payload?.violations) && r.payload.violations.length >= 2, r.text.slice(0, 200));
  const rest = await call('POST', `/api/apps/${SLUG}/data`, { data: { record_type: 'task', title: '', state: 'later' } });
  ok('REST 同一数据 → 400 + 同一组 violations', rest.status === 400 && JSON.stringify(rest.body?.violations) === JSON.stringify(r.payload?.violations), JSON.stringify(rest.body).slice(0, 160));
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: { record_type: 'unknown', title: 't' } });
  ok('未声明类型按 unknown_types=reject 拒绝', r.isError && r.payload?.status === 400);
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: { record_type: 'task', title: '整理清单', state: 'todo', file_ids: [999] } });
  ok('file_ids 指向不存在文件被拦', r.isError && (r.payload?.violations ?? []).some((v) => v.includes('999')));

  const good = { record_type: 'task', title: '整理清单', state: 'todo' };
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: good, idempotency_key: 'job-1' });
  ok('合规写入 201', !r.isError && r.payload?.status === 201 && Number.isInteger(r.payload?.id), r.text.slice(0, 160));
  const firstId = r.payload?.id;
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: good, idempotency_key: 'job-1' });
  ok('同键同内容重试 → duplicate 返回原记录', r.payload?.duplicate === true && r.payload?.id === firstId && r.payload?.status === 200);
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: { ...good, state: 'done' }, idempotency_key: 'job-1' });
  ok('同键不同内容 409', r.isError && r.payload?.status === 409);
  r = await tool(part.token, 'app_data_submit', { slug: SLUG, data: good, idempotency_key: 'bad key!' });
  ok('坏幂等键 400', r.isError && r.text.includes('idempotency_key'));
  // 幂等键按提交方隔开：MCP 会话是一方，匿名的 REST 提交是另一方。同一个键，REST 那边照常写一条新的，不当成会话那条的重复
  const restDup = await call('POST', `/api/apps/${SLUG}/data`, { data: good, idempotency_key: 'job-1' });
  ok('匿名 REST 信封带会话用过的键 → 另写一条（提交方不同，不算重复）', restDup.status === 201 && Number.isInteger(restDup.body?.id) && restDup.body?.id !== firstId && !restDup.body?.duplicate, JSON.stringify(restDup.body));
  const list = await tool(part.token, 'app_data_list', { slug: SLUG });
  const mine = (list.payload?.items ?? []).filter((x) => x.data?.title === '整理清单');
  ok('数据面两行：会话那条 created_by 缺省为 mcp:<会话名>，REST 那条留空', mine.length === 2 && mine.some((x) => x.id === firstId && x.created_by === 'mcp:agent-part') && mine.some((x) => x.id === restDup.body?.id && x.created_by === ''), JSON.stringify(mine).slice(0, 200));
  r = await tool(part.token, 'app_data_submit', { slug: 'no-such-app', data: good });
  ok('不存在的台报错', r.isError);
} catch (e) {
  fail++;
  console.log(`  ✗ 异常 ${e?.stack ?? e}`);
} finally {
  child.kill();
  await gh.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nmcp-access-smoke: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
