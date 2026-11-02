#!/usr/bin/env node
/** MCP 上游聚合冒烟（GH #20 P2）：假上游 MCP 服务以 <prefix>__<tool> 并入市场 /mcp。
 *  覆盖：上游配置 CRUD、tools/list 聚合、tools/call 转发、上游不可达降级、本地面不受影响。 */
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
import { createServer } from 'node:http';

const PORT = Number(process.env.UP_PORT) > 0 ? Number(process.env.UP_PORT) : 20000 + Math.floor(Math.random() * 20000);
const PORT2 = PORT + 2;
const UP_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-upstr-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

// 假上游 MCP（StreamableHTTP JSON）：tools/list + tools/call
const upstream = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    const send = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result })); };
    if (msg.method === 'tools/list') {
      return send({ tools: [
        { name: 'rules', description: '读规则集', inputSchema: { type: 'object', properties: {} } },
        { name: 'record', description: '记一条判断', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      ] });
    }
    if (msg.method === 'tools/call') {
      if (msg.params?.name === 'rules') return send({ content: [{ type: 'text', text: JSON.stringify({ rules: ['r1', 'r2'], upstream: 'taste', client: req.headers['x-market-client'] ?? null }) }] });
      if (msg.params?.name === 'record') return send({ content: [{ type: 'text', text: JSON.stringify({ ok: true, recorded: msg.params?.arguments?.text ?? '' }) }] });
      return send({ content: [{ type: 'text', text: 'unknown tool' }], isError: true });
    }
    res.writeHead(400); res.end('{}');
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', ADMIN_TOKEN: '', PORT: String(PORT), DATA_DIR: `../${DATA}` }, stdio: ['ignore', 'pipe', 'pipe'], // ADMIN_TOKEN 显式清空：E2E 主实例合成 token 不继承，注释「未设→控制面 403」为真
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); process.exit(1); }

const AT = { 'X-Admin-Token': 'up-admin-tok' };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function rpc(method, params) {
  return call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params });
}

try {
  // 注意：本实例未设 ADMIN_TOKEN → 控制面 403（upstreams GET/PUT 属控制面）。
  // 冒烟用带 ADMIN_TOKEN 的实例：重新起一个？简化——直接写 settings 走 PUT 需 403 验证，
  // 真正的配置通过独立实例的 env 注入不可行，故此处以「控制面 403」+「无配置时工具面 17」两步，
  // 聚合功能由 E2E 主实例的 /api/mcp/upstreams（本机 loopback 无 token 也 403）不可达……
  // 结论：控制面需要 ADMIN_TOKEN，故本冒烟以 gateway-smoke 的 ADMIN_TOKEN 实例为宿主不可行。
  // 改为：本实例先验「无上游配置 → 工具面 17」与「控制面 403」；聚合验证放在带 ADMIN_TOKEN 的独立实例段。
  let r = await rpc('tools/list');
  ok('无上游配置工具面 28（24 本地+草稿 3·#178 +1·design_standard +1）', r.body?.result?.tools?.length === 28, JSON.stringify(r.body).slice(0, 120));
  r = await call('GET', '/api/mcp/upstreams');
  ok('控制面无口令 403', r.status === 403);
  // 上游不可达时列表不崩（用不存在的端口配置——需口令，跳过）
  ok('（上游配置用例在下面第二实例）', true);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
}

// ===== 第二实例：带 ADMIN_TOKEN，配好上游，验聚合 =====
const DATA2 = 'tmp/e2e-upstr-data2';
rmSync(DATA2, { recursive: true, force: true });
mkdirSync(DATA2, { recursive: true });
const child2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT2), DATA_DIR: `../${DATA2}`, ADMIN_TOKEN: 'up-admin-tok' }, stdio: ['ignore', 'pipe', 'pipe'], // MCP_GATEWAY 显式空：E2E 主实例 on 不继承，聚合面匿名可测
});
const B2 = `http://127.0.0.1:${PORT2}`;
await waitReady(B2 + '/api/health');
async function call2(method, path, body, headers = {}) {
  const r = await fetch(B2 + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function rpc2(method, params, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${B2}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
try {
  // ① 配上游（控制面，带口令）
  let r = await call2('POST', '/api/mcp/sessions', { name: 'agg-agent' }, AT);
  const tok = r.body.token;
  r = await call2('PUT', '/api/mcp/upstreams', { upstreams: [{ prefix: 'taste', url: `http://127.0.0.1:${UP_PORT}/`, headers: { 'X-Market-Client': 'agg-smoke' } }] }, AT);
  ok('配上游 200', r.status === 200 && r.body.upstreams?.[0]?.prefix === 'taste', JSON.stringify(r.body).slice(0, 120));
  // ② 坏 prefix 400
  r = await call2('PUT', '/api/mcp/upstreams', { upstreams: [{ prefix: 'Bad Prefix!', url: 'http://x/' }] }, AT);
  ok('坏 prefix 400', r.status === 400);
  // ③ 聚合工具面（网关 off，无令牌也全量）——本地 17 + 上游 2 = 19
  r = await rpc2('tools/list');
  const names = (r.body?.result?.tools ?? []).map((t) => t.name);
  ok('聚合 30 工具（28 本地 + 2 上游）', names.length === 30, String(names.length));
  ok('taste__rules 在场', names.includes('taste__rules'));
  ok('taste__record 在场', names.includes('taste__record'));
  // ④ 上游工具调用转发
  r = await rpc2('tools/call', { name: 'taste__rules', arguments: {} });
  const out = JSON.parse(r.body?.result?.content?.[0]?.text ?? '{}');  // 上游原样透传
  ok('taste__rules 转发成功', out.upstream === 'taste' && out.rules?.length === 2, JSON.stringify(out).slice(0, 100));
  ok('静态身份头透传（网关 off）', out.client === 'agg-smoke', String(out.client));
  r = await rpc2('tools/call', { name: 'taste__record', arguments: { text: '聚合测试' } });
  const rec = JSON.parse(r.body?.result?.content?.[0]?.text ?? '{}');
  ok('taste__record 参数透传', rec.ok === true && rec.recorded === '聚合测试', JSON.stringify(rec).slice(0, 100));
  // ⑤ 本地工具不受影响
  r = await rpc2('tools/call', { name: 'workbench_summary', arguments: {} });
  ok('本地工具照常', r.body?.result?.content?.[0]?.text?.includes('total') === true);
  // ⑥ 网关会话授权：grants 里可含上游工具名
  r = await call2('GET', '/api/mcp/sessions', null, AT);
  const sid = r.body[0].id;
  r = await call2('PUT', `/api/mcp/sessions/${sid}/grants`, { grants: ['taste__rules', 'workbench_summary'] }, AT);
  ok('上游工具名可授权', r.status === 200 && r.body.grants.includes('taste__rules'));
  // ⑦ 上游不可达降级：改成死端口后工具面回到 17（本地不受影响）
  r = await call2('PUT', '/api/mcp/upstreams', { upstreams: [{ prefix: 'dead', url: 'http://127.0.0.1:1/', toolCallTimeoutMs: 800 }] }, AT);
  ok('配死上游 200', r.status === 200);
  r = await rpc2('tools/list');
  ok('上游不可达 → 工具面回落 28 不崩（24+草稿 3+1+1）', (r.body?.result?.tools ?? []).length === 28, String(r.body?.result?.tools?.length));
} finally {
  child2.kill();
  await new Promise((r) => setTimeout(r, 400));
}

// ===== 第三实例：网关开（MCP_GATEWAY=on）+ 会话令牌 → 上游收到 mcp/<会话名> =====
const DATA3 = 'tmp/e2e-upstr-data3';
rmSync(DATA3, { recursive: true, force: true });
mkdirSync(DATA3, { recursive: true });
const child3 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, PORT: '9822', DATA_DIR: `../${DATA3}`, ADMIN_TOKEN: 'gw-tok', MCP_GATEWAY: 'on' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const B3 = 'http://127.0.0.1:9822';
await waitReady(B3 + '/api/health');
try {
  let r = await fetch(B3 + '/api/mcp/upstreams', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'gw-tok' }, body: JSON.stringify({ upstreams: [{ prefix: 'taste', url: `http://127.0.0.1:${UP_PORT}/`, headers: { 'X-Market-Client': 'static-fallback' } }] }) });
  ok('网关模式配上游', r.status === 200);
  r = await fetch(B3 + '/api/mcp/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'gw-tok' }, body: JSON.stringify({ name: 'agg-agent' }) });
  const sj = await r.json();
  const tok = sj.token;
  const sid = sj.id;
  await fetch(`${B3}/api/mcp/sessions/${sid}/grants`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'gw-tok' }, body: JSON.stringify({ grants: ['taste__rules'] }) });
  const callUp = async (name) => {
    const resp = await fetch(B3 + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) });
    return { status: resp.status, body: await resp.json() };
  };
  let g = await callUp('taste__rules');
  const gout = JSON.parse(g.body?.result?.content?.[0]?.text ?? '{}');
  ok('网关会话身份透传 → mcp/agg-agent', gout.client === 'mcp/agg-agent', String(gout.client));
  // 未授权工具（本地 app_publish 不在 grants）→ 与不存在同应答
  g = await callUp('app_publish');
  ok('网关授权面覆盖聚合工具（未授权=not found）', g.body?.error?.code === -32601, JSON.stringify(g.body).slice(0, 100));
  // tools/list 只列已授权
  const listR = await fetch(B3 + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const lj = await listR.json();
  ok('网关 tools/list 仅授权面（1 个）', (lj.result?.tools ?? []).length === 1 && lj.result?.tools?.[0]?.name === 'taste__rules', JSON.stringify((lj.result?.tools ?? []).map((t) => t.name)));
} finally {
  child3.kill();
  upstream.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 上游聚合冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
