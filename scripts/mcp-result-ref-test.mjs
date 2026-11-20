#!/usr/bin/env node
/**
 * 渐进开放第 5 步（docs/productization/16-progressive-capability-access.md）：大结果给引用。安全面的对抗组。
 * 独立实例：全新数据目录、NODE_ENV=test、合成的管理口令、MCP_GATEWAY=on。用只在测试环境认的 WM_MCP_RESULT_LIMITS 把阈值和期限调小。
 *
 *  一、两条通道一致：结果超过阈值时，tools/call 和 REST 的工具调用都只回引用（地址、sha256、字节数、期限）和摘要；没超的原样回。
 *  二、拿引用去取（GET /api/mcp-rest/results/<id>）：同一个会话、同一个令牌才取得到，字节和 sha256 对得上；
 *      别的会话、不存在的编号同一个 404；匿名 401；收回原工具的授权之后同一个会话也取不到（403），再授予又能取。
 *  三、分段读（result_read，免授权）：纯聊天客户端按段读同一份结果；同样只认本会话、同样按原工具再判一次；它自己的结果不再套引用。
 *  四、过期：过了期限取不到（和不存在的同一句），过期的那一行在下次存的时候清掉。
 *  五、留痕：取和分段读都进审计，标原工具名。
 *  六、测试用的限值只在测试环境认：生产上设了就拒绝启动。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = 'result-ref-synthetic-admin';
const TTL_MS = 3000;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(name, extra = {}) {
  const port = 20000 + Math.floor(Math.random() * 12000);
  const data = `tmp/e2e-mcp-result-ref-${name}-${Date.now().toString(36)}`;
  rmSync(data, { recursive: true, force: true });
  mkdirSync(join(data, 'home'), { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    env: { PATH: process.env.PATH, HOME: join(data, 'home'), NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', REDIS_URL: '', MARKET_PUBLIC_URL: `http://127.0.0.1:${port}`, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  return { child, base: `http://127.0.0.1:${port}`, data, log: () => log };
}
async function waitUp(srv, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end && srv.child.exitCode === null;) {
    try { if ((await fetch(`${srv.base}/api/health`)).status === 200) return true; } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

const srv = boot('main', { WM_MCP_RESULT_LIMITS: `inline=1000,ttl=${TTL_MS}` });
try {
  if (!(await waitUp(srv))) throw new Error('实例没起来\n' + srv.log().slice(-1500));
  const AT = { 'X-Admin-Token': ADMIN };
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: r.status, text, json, headers: r.headers };
  };
  const rpc = (method, params, token) => call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, token ? { Authorization: `Bearer ${token}` } : {});
  const tool = async (token, name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args }, token);
    const text = r.json?.result?.content?.[0]?.text ?? '';
    let payload = null; try { payload = JSON.parse(text); } catch { /* 没有结构 */ }
    return { isError: !!r.json?.result?.isError, rpcError: r.json?.error ?? null, text, payload };
  };
  const session = async (name, grants = []) => {
    const r = await call('POST', '/api/mcp/sessions', { name }, AT);
    if (grants.length) await call('PUT', `/api/mcp/sessions/${r.json.id}/grants`, { grants }, AT);
    return { id: r.json.id, token: r.json.token };
  };
  const a = await session('ref-a', ['design_standard', 'workbench_summary']);
  const b = await session('ref-b', ['design_standard']);
  const auth = (s) => ({ Authorization: `Bearer ${s.token}` });

  console.log('一、两条通道一致');
  const small = await tool(a.token, 'workbench_summary');
  ok('没超阈值：原样回，不套引用', small.payload && !('result_ref' in small.payload), small.text.slice(0, 120));
  const big = await tool(a.token, 'design_standard');
  const ref = big.payload?.result_ref;
  ok('超了阈值（MCP）：只回引用和摘要，引用里有地址、sha256、字节数、期限', !big.isError && ref && /^[A-Za-z0-9_-]{22}$/.test(ref.id) && ref.url === `${srv.base}/api/mcp-rest/results/${ref.id}` && /^[0-9a-f]{64}$/.test(ref.sha256) && ref.bytes > 1000 && typeof ref.expires_at === 'string' && big.payload.summary && typeof big.payload.how_to_fetch === 'string',
    big.text.slice(0, 300));
  ok('超了阈值（MCP）：应答本身远小于原结果', big.text.length < ref?.bytes, `${big.text.length} / ${ref?.bytes}`);
  const restBig = await call('POST', '/api/mcp-rest/tools/design_standard', {}, auth(a));
  ok('超了阈值（REST 工具调用）：同样只回引用', restBig.status === 200 && restBig.json?.result_ref?.sha256 === ref?.sha256 && restBig.json.result_ref.id !== ref?.id, restBig.text.slice(0, 200));

  console.log('二、拿引用去取');
  const got = await fetch(ref.url, { headers: auth(a) });
  const gotText = await got.text();
  ok('同一个会话取得到：字节和 sha256 对得上，带 no-store', got.status === 200 && Buffer.byteLength(gotText) === ref.bytes && createHash('sha256').update(gotText).digest('hex') === ref.sha256 && got.headers.get('cache-control') === 'no-store' && got.headers.get('x-content-sha256') === ref.sha256,
    `${got.status} ${gotText.slice(0, 80)}`);
  ok('取到的就是原结果（能解析，和设计规范的工具结果一样有内容）', (() => { try { return typeof JSON.parse(gotText) === 'object'; } catch { return false; } })());
  const other = await call('GET', `/api/mcp-rest/results/${ref.id}`, undefined, auth(b));
  const none = await call('GET', `/api/mcp-rest/results/${'A'.repeat(22)}`, undefined, auth(a));
  ok('别的会话取：404，和不存在的编号同一句', other.status === 404 && none.status === 404 && other.json?.error === none.json?.error, J([other.status, other.json, none.json]));
  ok('匿名取：401', (await call('GET', `/api/mcp-rest/results/${ref.id}`)).status === 401);
  ok('编号写法不对：404', (await call('GET', '/api/mcp-rest/results/..%2F..%2Fetc', undefined, auth(a))).status === 404);
  await call('PUT', `/api/mcp/sessions/${a.id}/grants`, { grants: ['workbench_summary'] }, AT);
  const revoked = await call('GET', `/api/mcp-rest/results/${ref.id}`, undefined, auth(a));
  ok('收回原工具的授权之后：同一个会话也取不到（403）', revoked.status === 403, J([revoked.status, revoked.json]));
  const revokedRead = await tool(a.token, 'result_read', { id: ref.id });
  ok('收回之后分段读也不行', revokedRead.isError, revokedRead.text.slice(0, 120));
  await call('PUT', `/api/mcp/sessions/${a.id}/grants`, { grants: ['design_standard', 'workbench_summary'] }, AT);
  ok('再授予：又取得到', (await fetch(ref.url, { headers: auth(a) })).status === 200);

  console.log('三、分段读');
  const parts = [];
  let offset = 0, guard = 0;
  while (guard++ < 1000) {
    const r = await tool(a.token, 'result_read', { id: ref.id, offset, length: 700 });
    if (r.isError || typeof r.payload?.text !== 'string') { parts.push(null); break; }
    parts.push(r.payload.text);
    if (r.payload.next_offset === null) break;
    offset = r.payload.next_offset;
  }
  const joined = parts.every((p) => typeof p === 'string') ? parts.join('') : null;
  ok('result_read 分段读完拼起来就是原结果（sha256 对得上），它自己的结果不再套引用', joined !== null && createHash('sha256').update(joined).digest('hex') === ref.sha256 && parts.length > 1, `${parts.length} 段`);
  const rb = await tool(b.token, 'result_read', { id: ref.id });
  ok('别的会话分段读：和不存在的同一句', rb.isError && /没有这个结果/.test(rb.text), rb.text.slice(0, 120));
  const past = await tool(a.token, 'result_read', { id: ref.id, offset: 10 ** 9 });
  ok('offset 越界：返回空，不报错，没有下一段', !past.isError && past.payload?.text === '' && past.payload.next_offset === null, past.text.slice(0, 160));
  ok('length 超过上限按上限给', (await tool(a.token, 'result_read', { id: ref.id, length: 10 ** 9 })).payload?.text?.length <= 32768);
  const listed = ((await rpc('tools/list', {}, (await session('ref-c')).token)).json?.result?.tools ?? []).map((t) => t.name);
  ok('result_read 免授权：新会话的 tools/list 里有它', listed.includes('result_read'), J(listed));

  console.log('四、过期');
  await sleep(TTL_MS + 300);
  const expired = await call('GET', `/api/mcp-rest/results/${ref.id}`, undefined, auth(a));
  ok('过了期限：404，和不存在的同一句', expired.status === 404 && expired.json?.error === none.json?.error, J(expired.json));
  await tool(a.token, 'design_standard'); // 再存一份：顺带清掉过期的
  const db = new DatabaseSync(join(srv.data, 'workbench-market.db'), { readOnly: true });
  const left = db.prepare('SELECT count(*) AS n FROM mcp_result_refs WHERE id = ?').get(ref.id).n;
  ok('过期的那一行在下次存的时候清掉', left === 0, String(left));

  console.log('五、留痕');
  const audit = db.prepare("SELECT method, tool, ok, channel FROM mcp_calls WHERE method IN ('results/get', 'tools/call') AND tool IN ('design_standard', 'result_read') ORDER BY id").all();
  ok('取引用进审计，记原工具名，渠道 rest；收回授权那一次记失败', audit.some((r) => r.method === 'results/get' && r.tool === 'design_standard' && r.ok === 1 && r.channel === 'rest') && audit.some((r) => r.method === 'results/get' && r.ok === 0), J(audit.slice(-6)));
  db.close();
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.message ?? e}`);
} finally {
  srv.child.kill('SIGTERM');
  await sleep(300);
  rmSync(srv.data, { recursive: true, force: true });
}

console.log('六、测试用的限值只在测试环境认');
{
  const prod = boot('prod', { NODE_ENV: 'production', WM_MCP_RESULT_LIMITS: 'inline=1000,ttl=3000' });
  const up = await waitUp(prod, 30000);
  ok('不是测试环境却设了 WM_MCP_RESULT_LIMITS：拒绝启动', !up && /WM_MCP_RESULT_LIMITS/.test(prod.log()), prod.log().slice(-300));
  prod.child.kill('SIGKILL');
  await sleep(200);
  rmSync(prod.data, { recursive: true, force: true });
}

console.log(`mcp-result-ref-test: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
