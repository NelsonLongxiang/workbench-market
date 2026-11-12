#!/usr/bin/env node
/** MCP 网关 P1 冒烟（独立实例：DATA_DIR+ADMIN_TOKEN+MCP_GATEWAY=on 双 env 全开）。
 *  覆盖：会话 CRUD/令牌一次性/grants 校验、401+WWW-Authenticate、tools/list 过滤、
 *  未授权=不存在同应答、审计行（args_sha256 无原文）、last_used_at、软吊销即时生效。 */
import { spawn } from 'node:child_process';

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
import { rmSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.GW_PORT) > 0 ? Number(process.env.GW_PORT) : 20000 + Math.floor(Math.random() * 12000); // #164 随机端口根治并发撞
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-gw-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'gw-admin-tok', MCP_GATEWAY: 'on' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); process.exit(1); }

const AT = { 'X-Admin-Token': 'gw-admin-tok' };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
async function rpc(method, params, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, h);
}

try {
  // ============ 控制面 ============
  // 无口令 403
  let r = await call('POST', '/api/mcp/sessions', { name: 'test-sess' });
  ok('控制面无口令 403', r.status === 403);
  // 建会话：token 仅出现一次
  r = await call('POST', '/api/mcp/sessions', { name: 'agent-alpha' }, AT);
  ok('建会话 201 + token 出现', r.status === 201 && typeof r.body.token === 'string' && r.body.token.length === 64);
  const alphaToken = r.body.token;
  // 重名 400
  r = await call('POST', '/api/mcp/sessions', { name: 'agent-alpha' }, AT);
  ok('重名 400', r.status === 400);
  // 坏名 400
  r = await call('POST', '/api/mcp/sessions', { name: 'Bad Name!' }, AT);
  ok('坏名 400', r.status === 400);
  // 列表无 token 值
  r = await call('GET', '/api/mcp/sessions', null, AT);
  ok('列表无 token 值', Array.isArray(r.body) && r.body.length === 1 && !('token' in r.body[0]) && r.body[0].grants.length === 0);
  const sid = r.body[0].id;
  // grants 坏工具名 400
  r = await call('PUT', `/api/mcp/sessions/${sid}/grants`, { grants: ['not_a_tool'] }, AT);
  ok('grants 坏名 400', r.status === 400);
  // tools 面要口令
  r = await call('GET', '/api/mcp/tools');
  ok('GET /api/mcp/tools 无口令 403', r.status === 403);
  r = await call('GET', '/api/mcp/tools', null, AT);
  ok('tools 面 33 个（#178 skill_search +1·design_standard +1；11-02 来源收敛 app_publish→app_sync、草稿三工具移除 −3；#336 workbench_vars_get/set +2；权限自助 access_info/access_request +2·app_data_submit +1·技能传输 skill_file_put/skill_publish/skill_download +3）', Array.isArray(r.body) && r.body.length === 33, `len=${r.body?.length}`);
  // 授权两个
  r = await call('PUT', `/api/mcp/sessions/${sid}/grants`, { grants: ['workbench_summary', 'use_url'] }, AT);
  ok('grants 整体替换', r.status === 200 && r.body.grants.length === 2);

  // ============ /mcp 网关 ============
  // 无令牌 401 + WWW-Authenticate（含 initialize——无兼容期）
  r = await rpc('initialize', { protocolVersion: '2025-03-26' });
  ok('无令牌 initialize 401', r.status === 401);
  ok('WWW-Authenticate 头在场', /Bearer/.test(r.headers.get('www-authenticate') ?? ''));
  // 坏令牌 401
  r = await rpc('ping', {}, 'f'.repeat(64));
  ok('坏令牌 401', r.status === 401);
  // 有效令牌 ping
  r = await rpc('ping', {}, alphaToken);
  ok('有效令牌 ping OK', r.status === 200 && r.body?.result);
  // tools/list 过滤
  r = await rpc('tools/list', {}, alphaToken);
  const names = (r.body?.result?.tools ?? []).map((t) => t.name);
  ok('tools/list 按授权过滤=2 + 两个免授权工具', names.length === 4 && names.includes('workbench_summary') && names.includes('use_url') && names.includes('access_info') && names.includes('access_request'), JSON.stringify(names));
  // 未授权调用 = 与未知工具同应答
  const r1 = await rpc('tools/call', { name: 'app_sync', arguments: {} }, alphaToken);   // 未授权（存在但未授予）
  const r2 = await rpc('tools/call', { name: 'no_such_tool', arguments: {} }, alphaToken);  // 不存在
  ok('未授权=不存在同应答（不泄露）', r1.status === r2.status && JSON.stringify(r1.body?.error) === JSON.stringify(r2.body?.error),
     `auth:${JSON.stringify(r1.body?.error)} vs none:${JSON.stringify(r2.body?.error)}`);
  // 授权工具调用成功
  r = await rpc('tools/call', { name: 'workbench_summary', arguments: {} }, alphaToken);
  ok('授权工具调用 OK', r.status === 200 && r.body?.result?.content);
  // last_used_at 更新
  r = await call('GET', '/api/mcp/sessions', null, AT);
  ok('last_used_at 已更新', r.body[0].last_used_at !== '');
  // 审计行：有 args_sha256 无参数原文
  r = await call('GET', '/api/mcp/calls', null, AT);
  const calls = r.body;
  ok('审计行在场', Array.isArray(calls) && calls.length >= 4);
  ok('审计含 args_sha256（64hex）', calls.every((c) => /^[0-9a-f]{64}$/.test(c.args_sha256 ?? '')));
  ok('审计不存参数原文', !JSON.stringify(calls).includes('protocolVersion'));
  ok('审计含身份/方法/时长', calls.every((c) => c.session_name === 'agent-alpha' && c.method && typeof c.duration_ms === 'number'));
  ok('401 不进审计（无 unauthorized 行）', !calls.some((c) => /unauthorized/.test(c.error ?? '')));

  // ============ #379：注册表收缩时 grants 保存不死锁；上游可达状态可见 ============
  {
    await call('PUT', '/api/mcp/upstreams', { upstreams: [{ prefix: 'gone', url: 'http://127.0.0.1:9/mcp' }] }, AT);
    const lg = await call('POST', '/api/mcp/sessions', { name: 'agent-legacy' }, AT);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${DATA}/workbench-market.db`, { timeout: 5000 });
    db.prepare('UPDATE mcp_sessions SET grants = ? WHERE id = ?').run(JSON.stringify(['workbench_list', 'app_publish', 'gone__x']), lg.body.id);
    db.close();
    const ups = await call('GET', '/api/mcp/upstreams', null, AT);
    ok('上游带可达状态（不可达 + 错误原因）', ups.body?.[0]?.reachable === false && !!ups.body[0].last_error, JSON.stringify(ups.body).slice(0, 160));
    const same = await call('PUT', `/api/mcp/sessions/${lg.body.id}/grants`, { grants: ['workbench_list', 'app_publish', 'gone__x'] }, AT);
    ok('存量授权原样保存不再 400：已下线的剔除并列明', same.status === 200 && JSON.stringify(same.body.dropped) === '["app_publish"]', JSON.stringify(same.body));
    ok('上游暂不可达的存量授权保留', JSON.stringify(same.body.kept_unavailable) === '["gone__x"]' && same.body.grants.includes('gone__x'));
    const typo = await call('PUT', `/api/mcp/sessions/${lg.body.id}/grants`, { grants: ['workbench_list', 'no_such_tool'] }, AT);
    ok('新加的未知名仍 400', typo.status === 400);
    await call('PUT', '/api/mcp/upstreams', { upstreams: [] }, AT);
  }

  // ============ 请求体上限：只有有效会话才放大到 72MB ============
  {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { pad: 'x'.repeat(5 * 1024 * 1024) } });
    const anon = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    ok('无令牌 5MB → 413（不为匿名请求放大请求体）', anon.status === 413, String(anon.status));
    const bad = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + '0'.repeat(64) }, body: big });
    ok('无效令牌 5MB → 413', bad.status === 413, String(bad.status));
    const authed = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alphaToken}` }, body: big });
    ok('有效会话 5MB 不被请求体上限拦', authed.status !== 413, String(authed.status));
  }

  // ============ 软吊销即时生效 ============
  r = await call('DELETE', `/api/mcp/sessions/${sid}`, null, AT);
  ok('软吊销 200', r.status === 200);
  r = await rpc('ping', {}, alphaToken);
  ok('吊销后令牌即时失效 401', r.status === 401);

  // ============ 远程面收口（模拟非本机——直接测路径面在控制面的行为；真远程 IP 模拟需另一网卡，此处验逻辑面） ============
  // 注：本机测试环境 remoteAddress 恒 loopback——远程收口的分支由评审席在其验证器上以实际远程节点测；
  // 本冒烟钉住控制面 token 门与会话面语义。
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== MCP 网关 P1 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
