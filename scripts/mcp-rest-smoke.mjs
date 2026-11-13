#!/usr/bin/env node
/** MCP 工具 REST 开放冒烟（独立实例：全新 DATA_DIR + ADMIN_TOKEN + MCP_GATEWAY=on；替身 GitHub 发一个带数据契约的中性台；本机替身上游 MCP）。
 *  覆盖：/openapi.json 与 /api/mcp-rest/openapi.json 合法（3.1.x、每个 operation 有 operationId/requestBody、bearerAuth）、匿名/无效令牌 401、
 *  带会话只列可调用工具（含两个免授权工具与已授权的上游工具）并标 x-granted；
 *  POST /api/mcp-rest/tools/<name>：已授权 200 且与 /mcp 结果一致、未授权 403 带申请提示、未知 404、参数错误 400、app_data_submit 违约 400 + violations、
 *  上游工具经 REST 转发；mcp_calls 审计 channel=rest/mcp 分列；匿名 5MB 请求体 413。
 *  文件与资源（MCP 内嵌）：99MB 原始字节流式上传 sha256 前后一致、multipart 上传、Range/ETag/304/416 下载、列文件带 quota、读台数据、
 *  SOP run 元数据/附件（run 读授权）、未授权 403、匿名 401、内容不符 415；initialize 与 access_info 带 openapi_url / rest_base；openapi 写对二进制类型。 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const PORT = Number(process.env.GW_PORT) > 0 ? Number(process.env.GW_PORT) : 20000 + Math.floor(Math.random() * 12000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-rest-' + Date.now().toString(36);
// --login-gate：同一套判据在 WM_LOGIN_GATE=enforce 下再跑一遍；被测的 /mcp、/openapi.json、/api/mcp-rest/* 请求带 X-Forwarded-For 冒充远程
// （不享本机命令行豁免，只能靠网关会话令牌过登录门），准备步骤照旧走本机命令行
const GATE = process.argv.includes('--login-gate');
const remoteFor = (path) => (GATE && /^\/(mcp$|openapi\.json$|api\/mcp-rest\/)/.test(String(path).replace(BASE, '').split('?')[0]) ? { 'X-Forwarded-For': '198.51.100.9' } : {});
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
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'rest-admin-tok', MCP_GATEWAY: 'on', WM_GITHUB_API: gh.api, ...(GATE ? { WM_LOGIN_GATE: 'enforce' } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); child.kill(); process.exit(1); }

const AT = { 'X-Admin-Token': 'rest-admin-tok' };
const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...remoteFor(path), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
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
  if (GATE) {
    const h = await (await fetch(BASE + '/api/health')).json();
    const anon = await fetch(BASE + '/api/apps', { headers: { 'X-Forwarded-For': '198.51.100.9' } });
    ok('登录门 enforce 生效：远程匿名 /api/apps 被登录门 401', h.login_gate === 'enforce' && anon.status === 401 && anon.headers.get('x-wm-login-required') === '1');
    for (const [m, pth] of [['GET', '/openapi.json'], ['GET', '/api/mcp-rest/openapi.json'], ['POST', '/api/mcp-rest/tools/app_list']]) {
      const r = await call(m, pth, m === 'POST' ? {} : undefined);
      ok(`登录门下远程匿名 ${m} ${pth} → 网关 401（不是登录门 401）`, r.status === 401 && /Bearer/.test(r.headers.get('www-authenticate') ?? '') && r.headers.get('x-wm-login-required') !== '1');
    }
  }
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
  const ops = Object.entries(doc.paths ?? {}).filter(([p]) => p.startsWith('/api/mcp-rest/tools/')).map(([p, v]) => ({ path: p, op: v.post }));
  ok('每个 operation 有 operationId 与 requestBody（schema 即 inputSchema）', ops.length > 0 && ops.every((o) => o.op?.operationId && o.op?.requestBody?.content?.['application/json']?.schema && o.path === `/api/mcp-rest/tools/${o.op.operationId}`));
  const opNames = ops.map((o) => o.op.operationId).sort();
  ok('只列可调用工具（已授权 4 个 + 免授权 5 个；含上游 up__echo）', opNames.join() === ['access_info', 'access_request', 'app_data_list', 'app_data_submit', 'skill_read', 'skill_search', 'skills_list', 'up__echo', 'workbench_summary'].sort().join(), JSON.stringify(opNames));
  ok('每个工具标 x-granted 与 x-category', ops.every((o) => o.op['x-granted'] === true && ['read', 'write', 'admin'].includes(o.op['x-category'])));
  ok('上游只读工具 x-category=read，本地写工具=write',
    ops.find((o) => o.op.operationId === 'up__echo')?.op['x-category'] === 'read' && ops.find((o) => o.op.operationId === 'app_data_submit')?.op['x-category'] === 'write');
  ok('operationId 唯一', new Set(opNames).size === opNames.length);
  const alias = await call('GET', '/api/mcp-rest/openapi.json', undefined, bearer(sess.token));
  ok('/api/mcp-rest/openapi.json 与 /openapi.json 同内容', JSON.stringify(alias.body?.paths) === JSON.stringify(doc.paths));
  const bare = await newSession('agent-rest-bare');
  r = await call('GET', '/openapi.json', undefined, bearer(bare.token));
  ok('零授权会话只看到免授权的五个工具（无文件与资源接口）', Object.values(r.body?.paths ?? {}).map((v) => v.post?.operationId).sort().join() === 'access_info,access_request,skill_read,skill_search,skills_list');

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
  r = await rest(sess.token, 'app_data_submit', { slug: SLUG, data: { record_type: 'task', title: '整理清单', state: 'todo' }, idempotency_key: 'rest-1' });
  ok('同一个会话原样重试：重复，带回第一次的 id', r.status === 200 && r.body?.duplicate === true && Number.isInteger(r.body?.id), JSON.stringify(r.body));
  r = await call('POST', `/api/apps/${SLUG}/data`, { data: { record_type: 'task', title: '另一份', state: 'todo' }, idempotency_key: 'rest-1' });
  ok('幂等键按提交方隔开：匿名的 REST 提交用 MCP 会话用过的键，照常写入（不 409）', r.status === 201, JSON.stringify(r.body));
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


  // ============ 文件与资源（MCP 内嵌 REST） ============
  const filer = await newSession('agent-files', ['app_files_upload', 'app_files_list', 'app_data_list', 'sop_run_get']);
  const FB = `/api/mcp-rest/apps/${SLUG}/files`;
  const raw = (method, path, body, headers = {}) => fetch(BASE + path, { method, headers: { ...remoteFor(path), ...headers }, body, ...(body && typeof body.getReader === 'function' ? { duplex: 'half' } : {}) });

  r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, bearer(filer.token));
  ok('initialize 结果带 openapi_url 与 rest_base', /\/openapi\.json$/.test(r.body?.result?.openapi_url ?? '') && /\/api\/mcp-rest$/.test(r.body?.result?.rest_base ?? ''), JSON.stringify(r.body?.result).slice(0, 200));
  const ai = await viaMcp(filer.token, 'access_info');
  ok('access_info 带 openapi_url 与 rest_base', ai.payload?.openapi_url === r.body?.result?.openapi_url && ai.payload?.rest_base === r.body?.result?.rest_base);
  const tl = (await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, bearer(filer.token))).body?.result?.tools ?? [];
  ok('app_files_upload / app_files_list 描述提示大文件走 REST', ['app_files_upload', 'app_files_list'].every((n) => /REST/.test(tl.find((t) => t.name === n)?.description ?? '')));

  const fdoc = (await call('GET', '/openapi.json', undefined, bearer(filer.token))).body ?? {};
  const putOp = fdoc.paths?.['/api/mcp-rest/apps/{slug}/files/{name}']?.put;
  const dlOp = fdoc.paths?.['/api/mcp-rest/apps/{slug}/files/{id}']?.get;
  ok('openapi 含原始字节上传（application/octet-stream 二进制请求体）', putOp?.requestBody?.content?.['application/octet-stream']?.schema?.format === 'binary' && putOp?.['x-requires-tool'] === 'app_files_upload');
  ok('openapi 含 multipart 上传', fdoc.paths?.['/api/mcp-rest/apps/{slug}/files']?.post?.requestBody?.content?.['multipart/form-data'] !== undefined);
  ok('openapi 下载响应为二进制，含 206', dlOp?.responses?.['200']?.content?.['application/octet-stream']?.schema?.format === 'binary' && !!dlOp?.responses?.['206']);
  ok('openapi 含 SOP 附件下载与读数据接口', !!fdoc.paths?.['/api/mcp-rest/sop/runs/{id}/files/{fileId}']?.get && !!fdoc.paths?.['/api/mcp-rest/apps/{slug}/data']?.get);
  const allOps = Object.values(fdoc.paths ?? {}).flatMap((v) => Object.values(v));
  ok('所有 operation 都有唯一 operationId', allOps.every((o) => o.operationId) && new Set(allOps.map((o) => o.operationId)).size === allOps.length);
  ok('PUT/POST operation 都有 requestBody', allOps.filter((o) => o.requestBody === undefined).every((o) => !Object.entries(fdoc.paths).some(([, v]) => (v.put === o || v.post === o))));

  // 99MB 原始字节：边生成边上传，本地同时算 sha256
  const BIG = 99 * 1024 * 1024;
  const CH = 1024 * 1024;
  const seed = randomBytes(CH); seed[0] = 0x00; seed[1] = 0x01; // 避开可执行文件签名
  const hBig = createHash('sha256');
  let sent = 0;
  const bigStream = new ReadableStream({
    pull(ctrl) {
      if (sent >= BIG) return ctrl.close();
      const chunk = Buffer.from(seed); chunk.writeUInt32BE(sent / CH, 4);
      hBig.update(chunk); sent += chunk.length; ctrl.enqueue(chunk);
    },
  });
  const tUp = Date.now();
  let rr = await raw('PUT', `${FB}/big.bin?note=${encodeURIComponent('大文件')}`, bigStream, { ...bearer(filer.token), 'Content-Type': 'application/octet-stream' });
  const up = await rr.json().catch(() => null);
  const bigSha = hBig.digest('hex');
  ok(`99MB 原始字节上传 201（${Date.now() - tUp}ms）`, rr.status === 201 && up?.size === BIG, `${rr.status} ${JSON.stringify(up)}`);
  ok('上传返回 sha256 与本地一致，带 id/mime/url', up?.sha256 === bigSha && Number.isInteger(up?.id) && typeof up?.mime === 'string' && up?.url === `${FB}/${up?.id}`);
  ok('created_by 缺省为 mcp:<会话名>、note 落库', up?.note === '大文件');
  rr = await raw('GET', `${FB}/${up?.id}`, undefined, bearer(filer.token));
  const hDown = createHash('sha256');
  for await (const c of rr.body) hDown.update(c);
  ok('整份下载 sha256 与上传前一致', rr.status === 200 && hDown.digest('hex') === bigSha);
  ok('下载头：attachment + nosniff + ETag=sha256 + Accept-Ranges', /^attachment/.test(rr.headers.get('content-disposition') ?? '') && rr.headers.get('x-content-type-options') === 'nosniff'
    && rr.headers.get('etag') === `"${bigSha}"` && rr.headers.get('accept-ranges') === 'bytes' && rr.headers.get('x-content-sha256') === bigSha);
  rr = await raw('GET', `${FB}/${up?.id}`, undefined, { ...bearer(filer.token), 'If-None-Match': `"${bigSha}"` });
  ok('If-None-Match 命中 304', rr.status === 304);

  // 小文件：Range
  const small = Buffer.from(Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join(''));
  rr = await raw('PUT', `${FB}/${encodeURIComponent('说明 v1.txt')}`, small, { ...bearer(filer.token), 'Content-Type': 'text/plain' });
  const sm = await rr.json();
  ok('中文文件名 txt 上传 201，mime 按内容识别', rr.status === 201 && sm.name === '说明 v1.txt' && /^text\/plain/.test(sm.mime) && sm.sha256 === createHash('sha256').update(small).digest('hex'), JSON.stringify(sm));
  rr = await raw('GET', `${FB}/${sm.id}`, undefined, { ...bearer(filer.token), Range: 'bytes=100-199' });
  let part = Buffer.from(await rr.arrayBuffer());
  ok('Range bytes=100-199 → 206 + Content-Range + 正确片段', rr.status === 206 && rr.headers.get('content-range') === `bytes 100-199/${small.length}` && part.equals(small.subarray(100, 200)));
  rr = await raw('GET', `${FB}/${sm.id}`, undefined, { ...bearer(filer.token), Range: 'bytes=-10' });
  part = Buffer.from(await rr.arrayBuffer());
  ok('后缀 Range bytes=-10 → 最后 10 字节', rr.status === 206 && part.equals(small.subarray(small.length - 10)));
  rr = await raw('GET', `${FB}/${sm.id}`, undefined, { ...bearer(filer.token), Range: `bytes=${small.length}-` });
  ok('越界 Range → 416 + bytes */size', rr.status === 416 && rr.headers.get('content-range') === `bytes */${small.length}`);
  rr = await raw('GET', `${FB}/${sm.id}`, undefined, { ...bearer(filer.token), Range: 'bytes=0-9', 'If-Range': '"stale"' });
  ok('If-Range 不符 → 忽略 Range 回整份 200', rr.status === 200 && Buffer.from(await rr.arrayBuffer()).equals(small));

  // application/json 的原始字节上传：全局 JSON 解析必须让路，请求体原样落盘（5MB 超过匿名 4MB 口径，也不能被当成 JSON 解析）
  const bigJson = Buffer.from(JSON.stringify({ rows: Array.from({ length: 5 * 1024 * 1024 / 64 }, (_, i) => ({ i, v: 'x'.repeat(48) })) }));
  rr = await raw('PUT', `${FB}/data.json`, bigJson, { ...bearer(filer.token), 'Content-Type': 'application/json' });
  const js = await rr.json().catch(() => ({}));
  ok(`5MB data.json + application/json → 201，sha256 一致（${bigJson.length}B）`, rr.status === 201 && js.size === bigJson.length && js.sha256 === createHash('sha256').update(bigJson).digest('hex') && js.mime === 'application/json', `${rr.status} ${JSON.stringify(js).slice(0, 160)}`);
  rr = await raw('PUT', `${FB}/small.json`, Buffer.from('{"a":1}'), { ...bearer(filer.token), 'Content-Type': 'application/json' });
  const sj = await rr.json().catch(() => ({}));
  ok('小 data.json + application/json → 201（不报请求体为空）', rr.status === 201 && sj.size === 7, `${rr.status} ${JSON.stringify(sj)}`);
  rr = await raw('PUT', `${FB}/broken.json`, Buffer.from('{not json'), { ...bearer(filer.token), 'Content-Type': 'application/json' });
  ok('非法 JSON 的 .json 按内容判不符 415（不是 JSON 解析的 400）', rr.status === 415, `status=${rr.status}`);
  // 绝对形式请求目标（PUT http://host/api/…，#299）同样不经 JSON 解析
  const absBody = Buffer.from('{"abs":true}');
  const absRes = await new Promise((resolve, reject) => {
    const q = httpRequest({ host: '127.0.0.1', port: PORT, method: 'PUT', path: `${BASE}${FB}/abs.json`, headers: { ...remoteFor(`${FB}/abs.json`), ...bearer(filer.token), 'Content-Type': 'application/json', 'Content-Length': absBody.length } }, (resp) => {
      let b = ''; resp.on('data', (c) => { b += c; }); resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(b || '{}') }));
    });
    q.on('error', reject); q.end(absBody);
  });
  ok('绝对形式请求目标的 application/json 上传 → 201 原样落盘', absRes.status === 201 && absRes.body.size === absBody.length && absRes.body.sha256 === createHash('sha256').update(absBody).digest('hex'), JSON.stringify(absRes));

  // multipart
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('{"a":1}')], { type: 'application/json' }), 'cfg.json');
  fd.append('note', 'multipart');
  rr = await raw('POST', FB, fd, bearer(filer.token));
  const mp = await rr.json();
  ok('multipart 上传 201，带 sha256', rr.status === 201 && mp.sha256 === createHash('sha256').update('{"a":1}').digest('hex') && mp.mime === 'application/json' && mp.note === 'multipart', JSON.stringify(mp));

  // 浏览器上传（入库不存 sha256）的存量行：首次 REST 下载算一次并回写，ETag 仍为 sha256
  const bfd = new FormData();
  bfd.append('file', new Blob([small], { type: 'text/plain' }), 'browser.txt');
  const bu = await (await raw('POST', `/api/apps/${SLUG}/files`, bfd)).json();
  rr = await raw('GET', `${FB}/${bu.id}`, undefined, bearer(filer.token));
  await rr.arrayBuffer();
  ok('未存 sha256 的文件下载 ETag 仍为 sha256', rr.status === 200 && rr.headers.get('etag') === `"${createHash('sha256').update(small).digest('hex')}"`, JSON.stringify(bu));
  const shaDb = new DatabaseSync(join(DATA, 'workbench-market.db'), { readOnly: true });
  const shaRows = Object.fromEntries(shaDb.prepare(`SELECT id, sha256 FROM app_files WHERE app_slug = ?`).all(SLUG).map((x) => [x.id, x.sha256]));
  shaDb.close();
  ok('REST 上传入库即存 sha256；存量行首次下载后回写', shaRows[up?.id] === bigSha && shaRows[bu.id] === createHash('sha256').update(small).digest('hex'), JSON.stringify(shaRows));

  // 415 / 403 / 401 / 404 / 400
  rr = await raw('PUT', `${FB}/fake.png`, Buffer.from('not really a png'), { ...bearer(filer.token), 'Content-Type': 'image/png' });
  ok('内容与扩展名不符 → 415', rr.status === 415, `status=${rr.status}`);
  rr = await raw('PUT', `${FB}/tool.txt`, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]), bearer(filer.token));
  ok('可执行文件 → 415', rr.status === 415);
  rr = await raw('PUT', `${FB}/x.txt`, Buffer.from('hi'), bearer(bare.token));
  let jb = await rr.json().catch(() => ({}));
  ok('未授权上传 403，提示 access_request 与所需工具', rr.status === 403 && /access_request/.test(jb.hint ?? '') && jb.required_tool === 'app_files_upload', JSON.stringify(jb));
  rr = await raw('GET', `${FB}/${sm.id}`, undefined, bearer(bare.token));
  ok('未授权下载 403', rr.status === 403);
  rr = await raw('GET', FB, undefined, bearer(sess.token));
  ok('只有 app_data_list 的会话列文件 403', rr.status === 403);
  rr = await raw('PUT', `${FB}/x.txt`, Buffer.from('hi'));
  ok('匿名上传 401', rr.status === 401);
  rr = await raw('GET', `${FB}/${sm.id}`);
  ok('匿名下载 401', rr.status === 401);
  rr = await raw('GET', `${FB}/${sm.id}`, undefined, bearer('0'.repeat(64)));
  ok('无效令牌下载 401', rr.status === 401);
  rr = await raw('GET', `${FB}/999999`, undefined, bearer(filer.token));
  ok('不存在的文件 404', rr.status === 404);
  rr = await raw('PUT', `/api/mcp-rest/apps/no-such-app/files/x.txt`, Buffer.from('hi'), bearer(filer.token));
  ok('不存在的台 404', rr.status === 404);
  rr = await raw('PUT', `${FB}/empty.txt`, Buffer.alloc(0), bearer(filer.token));
  ok('空请求体 400', rr.status === 400);
  rr = await raw('PUT', `${FB}/${encodeURIComponent('a\\b.txt')}`, Buffer.from('hi'), bearer(filer.token));
  ok('非法文件名（含路径分隔符）400', rr.status === 400);
  const before = (await call('GET', `${FB}?limit=200`, undefined, bearer(filer.token))).body?.items?.length;
  ok('被拒的上传不留记录（6 个 REST 上传 + 1 个浏览器上传）', before === 7, `items=${before}`);

  // 列文件 / 读数据
  r = await call('GET', `${FB}?limit=2`, undefined, bearer(filer.token));
  ok('列文件分页 + quota + REST 下载地址', r.status === 200 && r.body?.items?.length === 2 && r.body?.has_more === true && Number.isInteger(r.body?.next_before_id)
    && r.body?.quota?.max_file_bytes === 100 * 1024 * 1024 && r.body.items.every((it) => it.url === `${FB}/${it.id}`), JSON.stringify(r.body).slice(0, 200));
  r = await call('GET', `${FB}?limit=2&before_id=${r.body?.next_before_id}`, undefined, bearer(filer.token));
  ok('列文件翻页', r.status === 200 && r.body?.items?.length === 2 && r.body?.has_more === true);
  r = await call('GET', `/api/mcp-rest/apps/${SLUG}/data?limit=10`, undefined, bearer(filer.token));
  const mviaData = await viaMcp(filer.token, 'app_data_list', { slug: SLUG, limit: 10 });
  ok('读台数据 200，与 app_data_list 一致', r.status === 200 && JSON.stringify(r.body) === JSON.stringify(mviaData.payload) && (r.body?.items ?? []).length >= 1);

  // SOP run 元数据与附件
  const sopYaml = ['title: REST SOP', 'code: RS', 'steps:', '  - key: s1', '    title: a', '    body: "<p>x</p>"', ''].join('\n');
  await ghPublish(BASE, gh, { slug: 'rest-sop', kind: 'sop', title: 'REST SOP', files: [{ path: 'sop.yaml', content: sopYaml }], changelog: 'v1' }, AT);
  await call('POST', '/api/sops/rest-sop/publish', {}, AT);
  const run = (await call('POST', '/api/sop/runs', { slug: 'rest-sop', started_by: 'smoke' })).body ?? {};
  ok('准备：SOP run 建行', Number.isInteger(run.id), JSON.stringify(run).slice(0, 120));
  const rfd = new FormData();
  rfd.append('file', new Blob([small], { type: 'text/plain' }), 'run-note.txt');
  const ru = await (await raw('POST', `/api/sop/runs/${run.id}/files`, rfd, AT)).json();
  ok('准备：run 附件上传', Number.isInteger(ru.id), JSON.stringify(ru));
  r = await call('GET', `/api/mcp-rest/sop/runs/${run.id}`, undefined, bearer(filer.token));
  ok('读 SOP run 元数据 200', r.status === 200 && Number(r.body?.id ?? r.body?.run_id) === run.id, JSON.stringify(r.body).slice(0, 160));
  rr = await raw('GET', `/api/mcp-rest/sop/runs/${run.id}/files/${ru.id}`, undefined, bearer(filer.token));
  ok('无 run 读授权下载附件 403', rr.status === 403);
  r = await call('PUT', `/api/sop/runs/${run.id}/read-grants`, { subject: 'mcp:agent-files' }, AT);
  ok('准备：给会话播种 run 读授权', r.status === 201, JSON.stringify(r.body));
  r = await call('GET', `/api/mcp-rest/sop/runs/${run.id}/files`, undefined, bearer(filer.token));
  ok('列 run 附件，url 指向 REST', r.status === 200 && r.body?.items?.[0]?.url === `/api/mcp-rest/sop/runs/${run.id}/files/${ru.id}`);
  rr = await raw('GET', `/api/mcp-rest/sop/runs/${run.id}/files/${ru.id}`, undefined, { ...bearer(filer.token), Range: 'bytes=0-9' });
  part = Buffer.from(await rr.arrayBuffer());
  ok('run 附件 Range 下载 206 + attachment + nosniff', rr.status === 206 && part.equals(small.subarray(0, 10)) && /^attachment/.test(rr.headers.get('content-disposition') ?? '') && rr.headers.get('x-content-type-options') === 'nosniff');
  rr = await raw('GET', `/api/mcp-rest/sop/runs/${run.id}/files/${ru.id}`, undefined, bearer(sess.token));
  ok('无 sop_run_get 授权的会话 403', rr.status === 403);
  rr = await raw('GET', `/api/mcp-rest/sop/runs/999999/files`, undefined, bearer(filer.token));
  ok('不存在的 run 404', rr.status === 404);

  const fcalls = ((await call('GET', '/api/mcp/calls?limit=1000', undefined, AT)).body ?? []).filter((c) => c.session_name === 'agent-files');
  ok('文件接口审计 channel=rest：上传/下载/run 附件', ['rest/file_upload', 'rest/file_download', 'rest/sop_run_file_download'].every((m) => fcalls.some((c) => c.method === m && c.channel === 'rest' && c.ok === 1)));
  ok('被拒上传留失败审计（415）', fcalls.some((c) => c.method === 'rest/file_upload' && c.ok === 0 && /类型不符/.test(c.error)));
  ok('未授权文件调用留失败审计', ((await call('GET', '/api/mcp/calls?limit=1000', undefined, AT)).body ?? []).some((c) => c.session_name === 'agent-rest-bare' && c.method === 'rest/file_upload' && c.ok === 0));

  // ============ 审计 ============
  const calls = (await call('GET', '/api/mcp/calls?limit=1000', undefined, AT)).body ?? [];
  const mine = calls.filter((c) => c.session_name === 'agent-rest');
  ok('mcp_calls 记 channel=rest', mine.some((c) => c.channel === 'rest' && c.tool === 'workbench_summary' && c.ok === 1));
  ok('mcp_calls 记 channel=mcp（/mcp 调用）', mine.some((c) => c.channel === 'mcp' && c.tool === 'workbench_summary'));
  ok('未授权 REST 调用留失败审计', mine.some((c) => c.channel === 'rest' && c.tool === 'workbench_register' && c.ok === 0));
  ok('上游 REST 调用留审计', mine.some((c) => c.channel === 'rest' && c.tool === 'up__echo' && c.ok === 1));
  const dbx = new DatabaseSync(join(DATA, 'workbench-market.db'), { readOnly: true });
  const restRows = dbx.prepare("SELECT COUNT(*) AS n FROM mcp_calls WHERE channel = 'rest'").get();
  dbx.close();
  ok("库内 channel 列落盘", restRows.n > 0);
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
