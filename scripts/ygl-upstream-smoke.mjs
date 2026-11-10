#!/usr/bin/env node
/** #474 ygl-trees 作为 MCP 上游（stdio）冒烟：用假的 ygl-trees 入口（经 PNPM_HOME 解析），起真实市场实例（网关开）。
 *  覆盖：配置校验（绝对路径/不存在/不能用服务端自己的 YGL_HOME/不能写命令）、tools/list 聚合与类别、tools/call 转发、
 *  子进程环境不含市场口令且 YGL_VERIFY_ALLOW_CMD 显式为空、按会话授权（只读会话调不了 write）、超时后杀进程并在下次调用时重启、改配置后换工作区。 */
import { spawn } from './owned-script-fixture.mjs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
async function reservePort() { const s = createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

const tmp = resolve('tmp/ygl-upstream-' + Date.now().toString(36));
const data = join(tmp, 'data'), pnpm = join(tmp, 'pnpm'), teamA = join(tmp, 'team-a'), teamB = join(tmp, 'team-b'), ownHome = join(tmp, 'own-home');
for (const d of [data, teamA, teamB, ownHome, join(pnpm, 'node_modules', 'ygl-trees', 'dist', 'bundle')]) mkdirSync(d, { recursive: true });
// 假 ygl-trees：按行读 JSON-RPC，回 initialize / tools/list / tools/call
writeFileSync(join(pnpm, 'node_modules', 'ygl-trees', 'dist', 'bundle', 'bin.cjs'), `
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-ygl', version: '0' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: ['read', 'write', 'verify', 'doctor'].map((name) => ({ name, description: name + ' tool', inputSchema: { type: 'object', properties: {} } })) } });
  if (m.method === 'tools/call') {
    const a = m.params.arguments || {};
    if (a.sleep) return setTimeout(() => out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'late' }] } }), a.sleep);
    const info = { fake: true, tool: m.params.name, pid: process.pid, home: process.env.YGL_HOME, cwd: process.cwd(), HOME: process.env.HOME,
      verifyAllowCmdSet: Object.prototype.hasOwnProperty.call(process.env, 'YGL_VERIFY_ALLOW_CMD'), verifyAllowCmd: process.env.YGL_VERIFY_ALLOW_CMD,
      leaked: Object.keys(process.env).filter((k) => /ADMIN|TOKEN|KEY|SECRET|PASSWORD|REDIS|ODOO|MCP_|WM_/i.test(k)) };
    return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(info) }] } });
  }
  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});
`);

const PORT = await reservePort(), BASE = `http://127.0.0.1:${PORT}`, AT = { 'X-Admin-Token': 'ygl-admin-tok' };
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: data, ADMIN_TOKEN: 'ygl-admin-tok', MCP_GATEWAY: 'on', PNPM_HOME: pnpm, YGL_HOME: ownHome, AI_GATEWAY_API_KEY: 'should-not-leak' },
});
async function waitReady(ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(BASE + '/api/health'); if (r.status < 500) return true; } catch { /* 未起 */ } await new Promise((r) => setTimeout(r, 250)); } return false; }
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}
async function rpc(token, method, params) {
  const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}
const text = (j) => { try { return JSON.parse(j?.result?.content?.[0]?.text ?? 'null'); } catch { return j?.result?.content?.[0]?.text ?? null; } };

try {
  ok('市场实例就绪', await waitReady());
  const put = (upstreams) => call('PUT', '/api/mcp/upstreams', { upstreams }, AT);
  let r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: 'relative/dir' }]);
  ok('Y1 ygl_home 必须是绝对路径', r.status === 400, JSON.stringify(r.body));
  r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: join(tmp, 'missing') }]);
  ok('Y1 ygl_home 不存在被拒', r.status === 400);
  r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: ownHome }]);
  ok('Y1 不能用服务端自己的 YGL_HOME', r.status === 400 && String(r.body?.error ?? '').includes('YGL_HOME'), JSON.stringify(r.body));
  r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: teamA, command: '/bin/sh' }]);
  ok('Y1 ygl-trees 上游不能写命令', r.status === 400);
  r = await put([{ prefix: 'ygla', kind: 'shell', ygl_home: teamA }]);
  ok('Y1 未知 kind 被拒', r.status === 400);
  r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: teamA }, { prefix: 'ygla', kind: 'ygl-trees', ygl_home: teamB }]);
  ok('Y1 前缀重复被拒', r.status === 400);
  r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: teamA, toolCallTimeoutMs: 1500 }]);
  ok('Y1 合法配置 200', r.status === 200 && r.body?.upstreams?.[0]?.kind === 'ygl-trees', JSON.stringify(r.body));

  const mk = async (name, grants) => { const s = await call('POST', '/api/mcp/sessions', { name }, AT); await call('PUT', `/api/mcp/sessions/${s.body.id}/grants`, { grants }, AT); return s.body.token; };
  const reader = await mk('team-reader', ['ygla__read']);
  const member = await mk('team-member', ['ygla__read', 'ygla__write', 'ygla__verify', 'ygla__doctor']);

  let j = await rpc(member, 'tools/list');
  const names = (j.result?.tools ?? []).map((t) => t.name);
  ok('Y2 聚合出 4 个 ygl 工具', ['read', 'write', 'verify', 'doctor'].every((n) => names.includes('ygla__' + n)), JSON.stringify(names));
  j = await rpc(member, 'tools/call', { name: 'access_info', arguments: {} });
  const cat = Object.fromEntries((text(j)?.catalog ?? []).map((t) => [t.name, t.category]));
  ok('Y2 read 归为 read，其余按 write', cat.ygla__read === 'read' && cat.ygla__write === 'write' && cat.ygla__verify === 'write', JSON.stringify(cat));

  j = await rpc(member, 'tools/call', { name: 'ygla__read', arguments: { domain: 'agent', action: 'brief' } });
  const info = text(j);
  ok('Y3 调用转发到假 ygl-trees', info?.fake === true && info.tool === 'read', JSON.stringify(j).slice(0, 200));
  ok('Y3 工作区与 cwd 是配置的目录', info?.home === teamA && resolve(info.cwd) === resolve(teamA), JSON.stringify(info));
  ok('Y3 HOME 指向工作区，不读宿主用户目录', info?.HOME === teamA);
  ok('Y4 YGL_VERIFY_ALLOW_CMD 显式为空（command 型检查一律 ERROR）', info?.verifyAllowCmdSet === true && info.verifyAllowCmd === '', JSON.stringify(info));
  ok('Y4 子进程环境里没有市场的口令、令牌、网关密钥', Array.isArray(info?.leaked) && info.leaked.length === 0, JSON.stringify(info?.leaked));

  j = await rpc(reader, 'tools/call', { name: 'ygla__write', arguments: {} });
  ok('Y5 只读会话调 write 被拒（同不存在）', j.error?.code === -32601, JSON.stringify(j).slice(0, 160));
  j = await rpc(reader, 'tools/call', { name: 'ygla__read', arguments: {} });
  ok('Y5 只读会话能调 read', text(j)?.tool === 'read');

  const pid1 = info.pid;
  j = await rpc(member, 'tools/call', { name: 'ygla__read', arguments: { sleep: 4000 } });
  ok('Y6 超时报错', !!j.error || j.result?.isError === true, JSON.stringify(j).slice(0, 200));
  j = await rpc(member, 'tools/call', { name: 'ygla__read', arguments: {} });
  ok('Y6 超时后下次调用重启子进程并恢复', text(j)?.tool === 'read' && text(j).pid !== pid1, JSON.stringify(text(j)));

  r = await put([{ prefix: 'ygla', kind: 'ygl-trees', ygl_home: teamB }]);
  j = await rpc(member, 'tools/call', { name: 'ygla__read', arguments: {} });
  ok('Y7 改配置后换到新工作区', text(j)?.home === teamB, JSON.stringify(text(j)));
  r = await call('GET', '/api/mcp/upstreams', null, AT);
  ok('Y7 管理端列表带 kind 与可达状态', r.body?.[0]?.kind === 'ygl-trees' && r.body[0].reachable === true, JSON.stringify(r.body));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n===== ygl-trees 上游冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
