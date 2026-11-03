#!/usr/bin/env node
/** MCP 工具 REST 开放冒烟（独立实例：全新 DATA_DIR + ADMIN_TOKEN + MCP_GATEWAY=on；替身 GitHub 发一个带数据契约的中性台；本机替身上游 MCP）。
 *  覆盖：/openapi.json 与 /api/mcp-rest/openapi.json 合法（3.1.x、每个 operation 有 operationId/requestBody、bearerAuth）、匿名/无效令牌 401、
 *  带会话只列可调用工具（含两个免授权工具与已授权的上游工具）并标 x-granted；
 *  POST /api/mcp-rest/tools/<name>：已授权 200 且与 /mcp 结果一致、未授权 403 带申请提示、未知 404、参数错误 400、app_data_submit 违约 400 + violations、
 *  上游工具经 REST 转发；mcp_calls 审计 channel=rest/mcp 分列；匿名 5MB 请求体 413。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const PORT = Number(process.env.GW_PORT) > 0 ? Number(process.env.GW_PORT) : 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-rest-' + Date.now().toString(36);
const SLUG = 'rest-demo';
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

// 替身上游 MCP（StreamableHTTP JSON）：一个只读工具 echo
const upstream = createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    const msg = JSON.parse(buf || '{}');
    const send = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
    if (msg.method === 'tools/list') return send({ tools: [{ name: 'echo', description: '回显 text', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
    if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: `echo:${msg.params?.arguments?.text ?? ''}` }] });
    send({});
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP_URL = `http://127.0.0.1:${upstream.address().port}/mcp`;

const gh = await startFakeGithub();
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'rest-admin-tok', MCP_GATEWAY: 'on', WM_GITHUB_API: gh.api },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); child.kill(); process.exit(1); }

const AT = { 'X-Admin-Token': 'rest-admin-tok' };
const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j, headers: r.headers };
}
const rest = (token, name, args) => call('POST', `/api/mcp-rest/tools/${encodeURIComponent(name)}`, args, bearer(token));
/** /mcp tools/call 的本地工具结果（text content 解析回对象） */
async function viaMcp(token, name, args = {}) {
  const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, bearer(token));
  return { raw: r.body?.result, payload: JSON.parse(r.body?.result?.content?.[0]?.text ?? 'null') };
}
async function newSession(name, grants = []) {
  const r = await call('POST', '/api/mcp/sessions', { name }, AT);
  if (grants.length) await call('PUT', `/api/mcp/sessions/${r.body.id}/grants`, { grants }, AT);
  return { id: r.body.id, token: r.body.token };
}

try {
  // ============ 准备：中性台 + 数据契约 + 上游 ============
  const contract = { version: 1, type_fields: ['record_type'], unknown_types: 'reject', types: { task: { required: ['title', 'state'], enum: { state: ['todo', 'done'] } } } };
  const pub = await ghPublish(BASE, gh, { slug: SLUG, title: 'REST demo', files: [
    { path: 'index.html', content: '<h1>demo</h1>' },
    { path: 'data-contract.json', content: JSON.stringify(contract) },
  ] }, AT);
  ok('准备：带契约的中性台同步发布 201', pub.status === 201, `status=${pub.status}`);
  let r = await call('PUT', '/api/mcp/upstreams', { upstreams: [{ prefix: 'up', url: UP_URL }] }, AT);
  ok('准备：登记替身上游', r.status === 200, JSON.stringify(r.body));
  const sess = await newSession('agent-rest', ['workbench_summary', 'app_data_submit', 'app_data_list', 'up__echo']);

  // ============ OpenAPI 文档 ============
  r = await call('GET', '/openapi.json');
  ok('匿名 /openapi.json 401 + WWW-Authenticate', r.status === 401 && /Bearer/.test(r.headers.get('www-authenticate') ?? ''));
  r = await call('GET', '/api/mcp-rest/openapi.json', undefined, bearer('f'.repeat(64)));
  ok('无效令牌 /api/mcp-rest/openapi.json 401', r.status === 401);

  r = await call('GET', '/openapi.json', undefined, bearer(sess.token));
  const doc = r.body ?? {};
  ok('带会话 200 且 openapi=3.1.x', r.status === 200 && /^3\.1\.\d+$/.test(doc.openapi ?? ''), `status=${r.status} openapi=${doc.openapi}`);
  ok('声明 bearerAuth 安全方案并全局要求', doc.components?.securitySchemes?.bearerAuth?.scheme === 'bearer' && doc.security?.[0]?.bearerAuth !== undefined);
  const ops = Object.entries(doc.paths ?? {}).map(([p, v]) => ({ path: p, op: v.post }));
  ok('每个 operation 有 operationId 与 requestBody（schema 即 inputSchema）', ops.length > 0 && ops.every((o) => o.op?.operationId && o.op?.requestBody?.content?.['application/json']?.schema && o.path === `/api/mcp-rest/tools/${o.op.operationId}`));
  const opNames = ops.map((o) => o.op.operationId).sort();
  ok('只列可调用工具（已授权 4 个 + 免授权 2 个；含上游 up__echo）', opNames.join() === ['access_info', 'access_request', 'app_data_list', 'app_data_submit', 'up__echo', 'workbench_summary'].sort().join(), JSON.stringify(opNames));
  ok('每个工具标 x-granted 与 x-category', ops.every((o) => o.op['x-granted'] === true && ['read', 'write', 'admin'].includes(o.op['x-category'])));
  ok('上游只读工具 x-category=read，本地写工具=write',
    ops.find((o) => o.op.operationId === 'up__echo')?.op['x-category'] === 'read' && ops.find((o) => o.op.operationId === 'app_data_submit')?.op['x-category'] === 'write');
  ok('operationId 唯一', new Set(opNames).size === opNames.length);
  const alias = await call('GET', '/api/mcp-rest/openapi.json', undefined, bearer(sess.token));
  ok('/api/mcp-rest/openapi.json 与 /openapi.json 同内容', JSON.stringify(alias.body?.paths) === JSON.stringify(doc.paths));
  const bare = await newSession('agent-rest-bare');
  r = await call('GET', '/openapi.json', undefined, bearer(bare.token));
  ok('零授权会话只看到两个免授权工具', Object.values(r.body?.paths ?? {}).map((v) => v.post.operationId).sort().join() === 'access_info,access_request');

  // ============ REST 调用 ============
  r = await rest(sess.token, 'workbench_summary', {});
  const m = await viaMcp(sess.token, 'workbench_summary');
  ok('已授权工具 200 且结果与 /mcp 一致', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(m.payload), `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await call('POST', '/api/mcp-rest/tools/workbench_summary', undefined, bearer(sess.token));
  ok('不带请求体按空参数调用 200', r.status === 200);
  r = await rest(sess.token, 'access_info', {});
  ok('免授权工具 access_info 经 REST 可调', r.status === 200 && r.body?.session === 'agent-rest');
  r = await rest(sess.token, 'workbench_register', { name: 'x', url: 'http://127.0.0.1:1/' });
  ok('未授权 403 且提示 access_info / access_request', r.status === 403 && /access_info/.test(r.body?.hint ?? '') && /access_request/.test(r.body?.hint ?? ''), JSON.stringify(r.body));
  r = await rest(sess.token, 'no_such_tool', {});
  ok('未知工具 404', r.status === 404, JSON.stringify(r.body));
  r = await rest(sess.token, 'nope__echo', {});
  ok('未登记的上游前缀 404', r.status === 404);
  r = await rest(sess.token, 'app_data_submit', { slug: SLUG });
  ok('参数错误（缺 data）400', r.status === 400 && /data/.test(r.body?.error ?? ''), JSON.stringify(r.body));
  r = await rest(sess.token, 'workbench_summary', [1, 2]);
  ok('请求体不是 JSON 对象 400', r.status === 400);
  r = await rest(sess.token, 'app_data_submit', { slug: SLUG, data: { record_type: 'task', title: '', state: 'later' } });
  ok('app_data_submit 违约 400 + violations', r.status === 400 && Array.isArray(r.body?.violations) && r.body.violations.length >= 2, JSON.stringify(r.body).slice(0, 200));
  const restViolations = r.body?.violations;
  const mv = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_data_submit', arguments: { slug: SLUG, data: { record_type: 'task', title: '', state: 'later' } } } }, bearer(sess.token));
  const mvText = mv.body?.result?.content?.[0]?.text ?? '';
  ok('违约 violations 与 /mcp 同一组', mv.body?.result?.isError && JSON.stringify(JSON.parse(mvText.split('\n').slice(1).join('\n')).violations) === JSON.stringify(restViolations));
  r = await rest(sess.token, 'app_data_submit', { slug: SLUG, data: { record_type: 'task', title: '整理清单', state: 'todo' }, idempotency_key: 'rest-1' });
  ok('合规写入 200（结果带 status=201 与 id）', r.status === 200 && r.body?.status === 201 && Number.isInteger(r.body?.id), JSON.stringify(r.body));
  r = await rest(sess.token, 'app_data_list', { slug: SLUG });
  ok('写入者为 mcp:<会话名>（与 /mcp 同一身份）', (r.body?.items ?? []).some((x) => x.created_by === 'mcp:agent-rest'), JSON.stringify(r.body).slice(0, 200));
  r = await rest(sess.token, 'up__echo', { text: 'hi' });
  ok('上游工具经 REST 转发', r.status === 200 && r.body?.content?.[0]?.text === 'echo:hi', JSON.stringify(r.body));
  r = await rest(null, 'access_info', {});
  ok('匿名 REST 调用 401', r.status === 401);
  r = await rest('0'.repeat(64), 'workbench_summary', {});
  ok('无效令牌 REST 调用 401', r.status === 401);

  // ============ 请求体上限 ============
  const big = JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024) });
  r = await call('POST', '/api/mcp-rest/tools/workbench_summary', big);
  ok('匿名 5MB 请求体 413', r.status === 413, `status=${r.status}`);
  r = await call('POST', '/api/mcp-rest/tools/workbench_summary', big, bearer('0'.repeat(64)));
  ok('无效令牌 5MB 请求体 413', r.status === 413, `status=${r.status}`);
  r = await call('POST', '/api/mcp-rest/tools/workbench_summary', big, bearer(sess.token));
  ok('有效会话 5MB 请求体不被体积拦（200）', r.status === 200, `status=${r.status}`);

  // ============ 审计 ============
  const calls = (await call('GET', '/api/mcp/calls?limit=1000', undefined, AT)).body ?? [];
  const mine = calls.filter((c) => c.session_name === 'agent-rest');
  ok('mcp_calls 记 channel=rest', mine.some((c) => c.channel === 'rest' && c.tool === 'workbench_summary' && c.ok === 1));
  ok('mcp_calls 记 channel=mcp（/mcp 调用）', mine.some((c) => c.channel === 'mcp' && c.tool === 'workbench_summary'));
  ok('未授权 REST 调用留失败审计', mine.some((c) => c.channel === 'rest' && c.tool === 'workbench_register' && c.ok === 0));
  ok('上游 REST 调用留审计', mine.some((c) => c.channel === 'rest' && c.tool === 'up__echo' && c.ok === 1));
  const dbx = new DatabaseSync(join(DATA, 'workbench-market.db'), { readOnly: true });
  const raw = dbx.prepare("SELECT COUNT(*) AS n FROM mcp_calls WHERE channel = 'rest'").get();
  dbx.close();
  ok('库内 channel 列落盘', raw.n > 0);
} catch (e) {
  fail++;
  console.log(`  ✗ 异常 ${e?.stack ?? e}`);
} finally {
  child.kill();
  await gh.close();
  upstream.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nmcp-rest-smoke: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
