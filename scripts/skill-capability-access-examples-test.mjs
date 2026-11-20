#!/usr/bin/env node
/**
 * 技能 wm-capability-access 里写的都是真的（防漂移，渐进开放第 16 篇七之一）：
 *   - 标了 ```json mcp:<工具>``` 的代码块，按先后在隔离实例上经 /mcp 逐个调用，都要成功；
 *   - 标了 ```json rest:<工具>``` 的代码块，经 POST /api/mcp-rest/tools/<工具> 调用，都要 2xx；
 *   - {{ref}}、{{result_id}} 换成前面拿到的值：ref 是技能里 access_request 那一步的申请编号（这里由管理员当场批准，模拟「等批」），
 *     result_id 是脚本自己调出来的一份大结果的引用编号；
 *   - 技能里点名的字段（catalog 的四个键、how_to_detail、input_schema、ref、status、result_ref 的五个键、summary、how_to_fetch、
 *     text、total_chars、next_offset、openapi_url、rest_base、X-Content-Sha256）在真实应答里都有；
 *   - 技能里写的数（64 KB、32768、15 分钟、20 份，申请理由 500 字、每会话每小时 10 条）和代码里的常量对得上；
 *   - 技能里写的说法（MCP 没批回 Method not found；REST 没批 403、没这个工具 404；offset 越界回空）和真实行为一致。
 * 代码改了、技能没跟上，这里会红。隔离实例：全新数据目录、NODE_ENV=test、合成的管理口令，用测试专用的 WM_MCP_RESULT_LIMITS 把阈值调到 16 000 字节：目录（约 11 KB）照常整份回，设计规范（约 24 KB）给引用。
 *   node scripts/skill-capability-access-examples-test.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKILL = join(ROOT, 'skills', 'wm-capability-access', 'SKILL.md');
const ADMIN = 'skill-capability-synthetic-admin';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); } };
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const text = readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
const blocks = [...text.matchAll(/```json (mcp|rest):([a-z_]+)\n([\s\S]*?)```/g)].map((m, i) => ({ n: i + 1, via: m[1], tool: m[2], body: m[3] }));

const port = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${port}`;
const data = join(ROOT, 'tmp', `skill-capability-${Date.now().toString(36)}`);
rmSync(data, { recursive: true, force: true });
mkdirSync(join(data, 'home'), { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: ROOT,
  env: { PATH: process.env.PATH, HOME: join(data, 'home'), NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', REDIS_URL: '', MARKET_PUBLIC_URL: base, WM_MCP_RESULT_LIMITS: 'inline=16000,ttl=600000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += String(d); });
child.stderr.on('data', (d) => { log += String(d); });

try {
  let up = false;
  for (const end = Date.now() + 60000; !up && Date.now() < end && child.exitCode === null;) {
    try { up = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!up) await sleep(200);
  }
  if (!up) throw new Error('实例没起来\n' + log.slice(-1500));
  const AT = { 'x-admin-token': ADMIN };
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let json = null; try { json = JSON.parse(t); } catch { /* 不是 JSON */ }
    return { status: r.status, text: t, json, headers: r.headers };
  };
  const rpc = async (token, name, args) => {
    const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${token}` });
    const t = r.json?.result?.content?.[0]?.text ?? '';
    let payload = null; try { payload = JSON.parse(t); } catch { /* 出错时是一句话 */ }
    return { rpcError: r.json?.error ?? null, isError: r.json?.result?.isError === true, text: t, payload };
  };
  const made = await call('POST', '/api/mcp/sessions', { name: 'skill-agent' }, AT);
  const sess = { id: made.json?.id, token: made.json?.token };
  await call('PUT', `/api/mcp/sessions/${sess.id}/grants`, { grants: ['design_standard'] }, AT);
  const auth = { authorization: `Bearer ${sess.token}` };

  // 一份大结果：给 {{result_id}} 用，也用来核第五节写的字段
  const big = await rpc(sess.token, 'design_standard', {});
  const ref = big.payload?.result_ref;
  const vars = { result_id: ref?.id ?? '' };

  console.log('一、技能里的例子逐个真跑');
  ok('技能里有例子可验：四种调法都有（access_info、access_request、result_read、REST）', ['access_info', 'access_request', 'result_read'].every((t) => blocks.some((b) => b.via === 'mcp' && b.tool === t)) && blocks.some((b) => b.via === 'rest'), blocks.map((b) => `${b.via}:${b.tool}`));
  const seen = {};
  for (const b of blocks) {
    let args;
    try { args = JSON.parse(b.body.replace(/\{\{([a-z_]+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)); } catch (e) { ok(`第 ${b.n} 个例子（${b.via}:${b.tool}）是合法的 JSON`, false, e.message); continue; }
    const unresolved = JSON.stringify(args).match(/\{\{[a-z_]+\}\}/);
    if (unresolved) { ok(`第 ${b.n} 个例子（${b.via}:${b.tool}）的占位都换得上`, false, unresolved[0]); continue; }
    if (b.via === 'mcp') {
      const r = await rpc(sess.token, b.tool, args);
      ok(`第 ${b.n} 个例子（mcp:${b.tool} ${J(args).slice(0, 60)}）调得通`, !r.isError && !r.rpcError && r.payload !== null, r.rpcError ?? r.text.slice(0, 160));
      (seen[b.tool] ??= []).push({ args, out: r.payload });
      // access_request 那一步：记下编号，再由管理员当场批准（模拟「等批」），后面的 {ref} 和 REST 例子就有了授权
      if (b.tool === 'access_request' && r.payload?.request?.ref) {
        vars.ref = r.payload.request.ref;
        const appr = await call('POST', `/api/mcp/access-requests/${r.payload.request.id}/approve`, { note: '合成：技能例子' }, AT);
        ok('（准备）管理员批准技能里的那条申请', appr.status === 200, appr.text.slice(0, 120));
      }
    } else {
      const r = await call('POST', `/api/mcp-rest/tools/${b.tool}`, args, auth);
      ok(`第 ${b.n} 个例子（rest:${b.tool}）调得通`, r.status >= 200 && r.status < 300, `${r.status} ${r.text.slice(0, 120)}`);
    }
  }

  console.log('二、技能点名的字段在真实应答里都有');
  const idx = seen.access_info?.find((x) => Object.keys(x.args).length === 0)?.out;
  ok('access_info 默认：catalog 每项有 name、description、category、granted，不带 input_schema；有 how_to_detail、openapi_url、rest_base',
    Array.isArray(idx?.catalog) && idx.catalog.every((t) => typeof t.name === 'string' && typeof t.description === 'string' && typeof t.category === 'string' && typeof t.granted === 'boolean' && !('input_schema' in t))
    && typeof idx.how_to_detail === 'string' && typeof idx.openapi_url === 'string' && typeof idx.rest_base === 'string', Object.keys(idx ?? {}));
  const det = seen.access_info?.find((x) => x.args.tool)?.out;
  ok('access_info {tool}：tool 里有 name、description、category、granted、input_schema', ['name', 'description', 'category', 'granted', 'input_schema'].every((k) => det?.tool && k in det.tool), Object.keys(det?.tool ?? {}));
  const req = seen.access_request?.[0]?.out;
  ok('access_request：应答里有 ref（mcp-N），status 是 pending', /^mcp-\d+$/.test(req?.request?.ref ?? '') && req.request.status === 'pending', req);
  const byRef = seen.access_info?.find((x) => x.args.ref)?.out;
  ok('access_info {ref}：批了之后 status 是 approved', byRef?.request?.status === 'approved', byRef);
  ok('大结果：result_ref 有 id、url、sha256、bytes、expires_at，另有 summary、how_to_fetch', ref && ['id', 'url', 'sha256', 'bytes', 'expires_at'].every((k) => k in ref) && big.payload.summary && typeof big.payload.how_to_fetch === 'string', big.text.slice(0, 200));
  const got = await fetch(ref.url, { headers: auth });
  const gotText = await got.text();
  ok('用同一个令牌 GET result_ref.url：拿到原来那份，X-Content-Sha256 和 sha256 对得上', got.status === 200 && got.headers.get('x-content-sha256') === ref.sha256 && createHash('sha256').update(gotText).digest('hex') === ref.sha256, got.status);
  const rr = seen.result_read?.[0]?.out;
  ok('result_read：有 text、total_chars、next_offset', rr && typeof rr.text === 'string' && typeof rr.total_chars === 'number' && 'next_offset' in rr, rr && Object.keys(rr));
  for (const k of ['how_to_detail', 'input_schema', 'openapi_url', 'rest_base', 'result_ref', 'summary', 'how_to_fetch', 'total_chars', 'next_offset', 'X-Content-Sha256', 'scopable', 'granted']) {
    ok(`技能里写到了 \`${k}\``, text.includes(k));
  }

  console.log('三、技能写的数和代码里的常量对得上');
  const { MCP_RESULT_DEFAULTS } = await import('../server/src/mcp-result-limits.ts');
  const indexSrc = readFileSync(join(ROOT, 'server', 'src', 'index.ts'), 'utf8');
  const readMax = Number(/const MCP_RESULT_READ_MAX = (\d+);/.exec(indexSrc)?.[1]);
  const keep = Number(/const MCP_RESULT_KEEP = (\d+);/.exec(indexSrc)?.[1]);
  ok(`阈值 ${MCP_RESULT_DEFAULTS.inline / 1024} KB`, text.includes(`超过 ${MCP_RESULT_DEFAULTS.inline / 1024} KB`), MCP_RESULT_DEFAULTS);
  ok(`引用 ${MCP_RESULT_DEFAULTS.ttl / 60000} 分钟过期`, text.includes(`${MCP_RESULT_DEFAULTS.ttl / 60000} 分钟过期`), MCP_RESULT_DEFAULTS);
  ok(`result_read 一段最多 ${readMax} 个字符`, Number.isInteger(readMax) && text.includes(`一段最多 ${readMax} 个字符`), readMax);
  ok(`每个会话最多留最新的 ${keep} 份`, Number.isInteger(keep) && text.includes(`最多留最新的 ${keep} 份`), keep);
  const reasonMax = Number(/const ACCESS_REASON_MAX = (\d+);/.exec(indexSrc)?.[1]);
  const hourlyMax = Number(/const ACCESS_REQUEST_HOURLY_MAX = (\d+);/.exec(indexSrc)?.[1]);
  ok(`申请理由不超过 ${reasonMax} 字`, Number.isInteger(reasonMax) && text.includes(`不超过 ${reasonMax} 字`), reasonMax);
  ok(`每会话每小时最多 ${hourlyMax} 条申请`, Number.isInteger(hourlyMax) && text.includes(`每会话每小时最多 ${hourlyMax} 条`), hourlyMax);

  console.log('四、技能写的说法和真实行为一致');
  const notGrantedMcp = await rpc(sess.token, 'workbench_vars_set', { id: 1, key: 'x', value: 1 });
  const unknownMcp = await rpc(sess.token, 'no_such_tool', {});
  ok('MCP：没批和不存在同一句 Method not found', /Method not found/.test(notGrantedMcp.rpcError?.message ?? '') && notGrantedMcp.rpcError?.message === unknownMcp.rpcError?.message, [notGrantedMcp.rpcError, unknownMcp.rpcError]);
  const notGrantedRest = await call('POST', '/api/mcp-rest/tools/workbench_vars_set', { id: 1, key: 'x', value: 1 }, auth);
  const unknownRest = await call('POST', '/api/mcp-rest/tools/no_such_tool', {}, auth);
  ok('REST：没批 403 带 hint，没这个工具 404', notGrantedRest.status === 403 && typeof notGrantedRest.json?.hint === 'string' && unknownRest.status === 404, [notGrantedRest.status, unknownRest.status]);
  const past = await rpc(sess.token, 'result_read', { id: ref.id, offset: 10 ** 9 });
  ok('result_read 的 offset 超出末尾：不报错，回空的 text', !past.isError && past.payload?.text === '' && past.payload.next_offset === null, past.text.slice(0, 120));
  const longReason = await rpc(sess.token, 'access_request', { tools: ['workbench_list'], reason: '长'.repeat(reasonMax + 1) });
  const fitReason = await rpc(sess.token, 'access_request', { tools: ['workbench_list'], reason: '长'.repeat(reasonMax) });
  ok(`申请理由：${reasonMax + 1} 字被拒，${reasonMax} 字收下`, longReason.isError && !fitReason.isError && /^mcp-\d+$/.test(fitReason.payload?.request?.ref ?? ''), [longReason.text.slice(0, 80), fitReason.text.slice(0, 80)]);
  const unknownDetail = await rpc(sess.token, 'access_info', { tool: 'no_such_tool' });
  ok('按名字取详情：名字不在目录里会报错', unknownDetail.isError, unknownDetail.text.slice(0, 120));
  const listed = (await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, auth)).json?.result?.tools?.map((t) => t.name) ?? [];
  ok('tools/list 里有免授权的看目录、提申请、读技能、分段读大结果', ['access_info', 'access_request', 'skill_search', 'skill_read', 'result_read'].every((n) => listed.includes(n)), listed);
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.message ?? e}`);
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  rmSync(data, { recursive: true, force: true });
}
console.log(`skill-capability-access-examples-test: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
