#!/usr/bin/env node
/** MCP 网关 P1 冒烟（独立实例：DATA_DIR+ADMIN_TOKEN+MCP_GATEWAY=on 双 env 全开）。
 *  覆盖：会话 CRUD/令牌一次性/grants 校验、401+WWW-Authenticate、tools/list 过滤、
 *  未授权=不存在同应答、审计行（args_sha256 无原文）、last_used_at、软吊销即时生效。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9813;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-gw-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'gw-admin-tok', MCP_GATEWAY: 'on', REDIS_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 3500));

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
  ok('tools 面 15 个', Array.isArray(r.body) && r.body.length === 15);
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
  ok('tools/list 按授权过滤=2', names.length === 2 && names.includes('workbench_summary') && names.includes('use_url'), JSON.stringify(names));
  // 未授权调用 = 与未知工具同应答
  const r1 = await rpc('tools/call', { name: 'app_publish', arguments: {} }, alphaToken);   // 未授权
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
