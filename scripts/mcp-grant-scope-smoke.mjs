#!/usr/bin/env node
/** #452 MCP 授权限定到单个台（工具@台）冒烟（独立实例：全新 DATA_DIR + ADMIN_TOKEN + MCP_GATEWAY=on）。
 *  覆盖：grants 收 workbench_vars_get/set@台、台不存在/不支持按台的工具 400；台内可调、台外 MCP 与 REST 都按未授权拒绝并记审计；
 *  全局授权行为不变；access_info 标出限定的台；access_request 申请 工具@台、批准后生效；台删除后旧的 工具@台 在下次保存时剔除。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const PORT = Number(process.env.GW_PORT) > 0 ? Number(process.env.GW_PORT) : 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-grant-scope-' + Date.now().toString(36);
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
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'scope-admin-tok', MCP_GATEWAY: 'on', WM_GITHUB_API: gh.api },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); child.kill(); process.exit(1); }

const AT = { 'X-Admin-Token': 'scope-admin-tok' };
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

const wbCreate = async (name) => { const r = await call('POST', '/api/workbenches', { name, url: `http://127.0.0.1:9/${name}/`, type: 'web' }, AT); if (r.status !== 201 && r.status !== 200) throw new Error(`建台失败 ${r.status} ${JSON.stringify(r.body)}`); return r.body.id; };
const rest = (token, name, args) => call('POST', `/api/mcp-rest/tools/${name}`, args, { Authorization: `Bearer ${token}` });
const scopeDenials = async (channel) => ((await call('GET', '/api/mcp/calls?limit=500', null, AT)).body ?? []).filter((c) => c.tool === 'workbench_vars_set' && c.error === 'not granted: workbench scope' && (c.channel ?? 'mcp') === channel).length;

try {
  const A = await wbCreate('scope-a'), B = await wbCreate('scope-b');
  ok('准备：两张台', Number.isInteger(A) && Number.isInteger(B) && A !== B, `${A} ${B}`);

  // ============ 授权格式 ============
  const s = await newSession('agent-scoped');
  let r = await call('PUT', `/api/mcp/sessions/${s.id}/grants`, { grants: [`workbench_vars_set@${A}`, `workbench_vars_get@${A}`] }, AT);
  ok('grants 收 工具@台', r.status === 200 && JSON.stringify(r.body?.grants) === JSON.stringify([`workbench_vars_set@${A}`, `workbench_vars_get@${A}`]), JSON.stringify(r.body));
  r = await call('PUT', `/api/mcp/sessions/${s.id}/grants`, { grants: ['workbench_vars_set@999999'] }, AT);
  ok('台不存在 400', r.status === 400 && String(r.body?.error).includes('台不存在'), JSON.stringify(r.body));
  r = await call('PUT', `/api/mcp/sessions/${s.id}/grants`, { grants: [`app_data_list@${A}`] }, AT);
  ok('不支持按台的工具 400', r.status === 400 && String(r.body?.error).includes('暂不支持按台授权'), JSON.stringify(r.body));
  r = await call('PUT', `/api/mcp/sessions/${s.id}/grants`, { grants: [`no_such_tool@${A}`] }, AT);
  ok('未知工具@台 400', r.status === 400 && String(r.body?.error).includes('未知工具名'), JSON.stringify(r.body));
  ok('非法保存不改动原授权', JSON.stringify(await grantsOf(s.id)) === JSON.stringify([`workbench_vars_set@${A}`, `workbench_vars_get@${A}`]));
  const tools = (await call('GET', '/api/mcp/tools', null, AT)).body ?? [];
  ok('/api/mcp/tools 标出可按台授权的工具', tools.filter((t) => t.scopable).map((t) => t.name).sort().join() === 'workbench_vars_get,workbench_vars_set');

  // ============ 台内可调、台外拒绝（MCP 与 REST） ============
  ok('tools/list 列出限定到台的工具', (await listNames(s.token)).includes('workbench_vars_set'));
  r = await tool(s.token, 'workbench_vars_set', { id: A, key: 'k1', value: 1 });
  ok('MCP 写台 A 成功', !r.rpcError && !r.isError, r.text.slice(0, 160));
  r = await tool(s.token, 'workbench_vars_set', { id: B, key: 'k1', value: 1 });
  ok('MCP 写台 B 按未授权拒绝（-32601，与未知工具同应答）', r.rpcError?.code === -32601, JSON.stringify(r.rpcError));
  r = await tool(s.token, 'workbench_vars_set', { key: 'k1', value: 1 });
  ok('MCP 不带 id 也拒绝', r.rpcError?.code === -32601);
  r = await tool(s.token, 'workbench_vars_get', { id: A, key: 'k1' });
  ok('MCP 读台 A 成功', !r.rpcError && !r.isError, r.text.slice(0, 160));
  r = await rest(s.token, 'workbench_vars_set', { id: A, key: 'k2', value: 2 });
  ok('REST 写台 A 成功', r.status === 200, JSON.stringify(r.body).slice(0, 160));
  r = await rest(s.token, 'workbench_vars_set', { id: B, key: 'k2', value: 2 });
  ok('REST 写台 B 403', r.status === 403, JSON.stringify(r.body).slice(0, 160));
  r = await rest(s.token, 'workbench_vars_set', { id: String(B), key: 'k2', value: 2 });
  ok('REST 写台 B（字符串 id）同样 403', r.status === 403);
  const vb = await call('GET', `/api/workbenches/${B}/vars`, null, AT);
  ok('台 B 没有被写入', vb.status === 200 && !JSON.stringify(vb.body ?? '').includes('"k1"') && !JSON.stringify(vb.body ?? '').includes('"k2"'), JSON.stringify(vb.body).slice(0, 160));
  ok('审计记下台外拒绝（MCP 2 次、REST 2 次）', (await scopeDenials('mcp')) === 2 && (await scopeDenials('rest')) === 2, `${await scopeDenials('mcp')} ${await scopeDenials('rest')}`);

  // ============ access_info / access_request ============
  let info = await tool(s.token, 'access_info');
  const setItem = (info.payload?.catalog ?? []).find((t) => t.name === 'workbench_vars_set');
  ok('access_info 标出限定的台', setItem?.granted === true && JSON.stringify(setItem?.granted_workbenches) === JSON.stringify([A]) && setItem?.scopable === true, JSON.stringify(setItem));
  r = await tool(s.token, 'access_request', { tools: [`app_data_list@${A}`], reason: '试' });
  ok('申请不支持按台的工具@台拒绝', r.isError && r.text.includes('暂不支持按台申请'), r.text.slice(0, 120));
  r = await tool(s.token, 'access_request', { tools: ['workbench_vars_set@999999'], reason: '试' });
  ok('申请不存在的台拒绝', r.isError && r.text.includes('台不存在'), r.text.slice(0, 120));
  r = await tool(s.token, 'access_request', { tools: [`workbench_vars_set@${A}`], reason: '试' });
  ok('申请已持有的 工具@台 无需申请', r.isError && r.text.includes('无需申请'), r.text.slice(0, 120));
  r = await tool(s.token, 'access_request', { tools: [`workbench_vars_set@${B}`], reason: '要写台 B 的看板变量' });
  ok('申请 工具@台 建 pending', !r.isError && r.payload?.request?.status === 'pending', r.text.slice(0, 160));
  r = await call('POST', `/api/mcp/access-requests/${r.payload.request.id}/approve`, { note: '同意' }, AT);
  ok('批准后并入授权', r.status === 200 && r.body?.grants?.includes(`workbench_vars_set@${B}`) && r.body?.grants?.includes(`workbench_vars_set@${A}`), JSON.stringify(r.body).slice(0, 200));
  r = await tool(s.token, 'workbench_vars_set', { id: B, key: 'k3', value: 3 });
  ok('批准后写台 B 成功', !r.rpcError && !r.isError, r.text.slice(0, 160));
  ok('对照：读变量接口能看到台 B 刚写入的 k3', JSON.stringify((await call('GET', `/api/workbenches/${B}/vars`, null, AT)).body ?? '').includes('"k3"'));

  // ============ 全局授权不变 ============
  const g = await newSession('agent-global', ['workbench_vars_set']);
  r = await tool(g.token, 'workbench_vars_set', { id: B, key: 'g1', value: 1 });
  ok('全局授权：写任意台照旧', !r.rpcError && !r.isError, r.text.slice(0, 160));
  info = await tool(g.token, 'access_info');
  ok('全局授权：access_info 不标限定台', !('granted_workbenches' in ((info.payload?.catalog ?? []).find((t) => t.name === 'workbench_vars_set') ?? {})));
  r = await tool(g.token, 'access_request', { tools: [`workbench_vars_set@${A}`], reason: '试' });
  ok('已有全局授权再申请 工具@台 无需申请', r.isError && r.text.includes('无需申请'), r.text.slice(0, 120));

  // ============ 台删除后 ============
  r = await call('DELETE', `/api/workbenches/${A}`, null, AT);
  ok('删除台 A', r.status === 200 || r.status === 204, JSON.stringify(r.body));
  r = await call('PUT', `/api/mcp/sessions/${s.id}/grants`, { grants: [`workbench_vars_set@${A}`, `workbench_vars_set@${B}`] }, AT);
  ok('台已删除：已持有的 工具@台 保存时剔除并列明', r.status === 200 && JSON.stringify(r.body?.grants) === JSON.stringify([`workbench_vars_set@${B}`]) && JSON.stringify(r.body?.dropped) === JSON.stringify([`workbench_vars_set@${A}`]), JSON.stringify(r.body));
  r = await call('PUT', `/api/mcp/sessions/${s.id}/grants`, { grants: [`workbench_vars_set@${B}`, `workbench_vars_set@${A}`] }, AT);
  ok('台已删除：新加它的 工具@台 400', r.status === 400 && String(r.body?.error).includes('台不存在'), JSON.stringify(r.body));
} catch (e) {
  fail++;
  console.log(`  ✗ 异常 ${e?.stack ?? e}`);
} finally {
  child.kill();
  await gh.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nmcp-grant-scope-smoke: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
