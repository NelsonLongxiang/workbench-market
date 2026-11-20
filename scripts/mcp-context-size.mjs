#!/usr/bin/env node
/**
 * 渐进开放第 0 步（docs/productization/16-progressive-capability-access.md）：量 MCP 会话一开局要吃掉多少上下文。
 * 起一个隔离实例（全新数据目录、NODE_ENV=test、不连任何外部系统），建三种会话，原样抓 initialize、tools/list、access_info 的应答：
 *   全授：目录里能按会话授予的工具全给（数据视图的工具要限定到台，不在其内）；
 *   缺省：新会话的样子，授予为空，只有免授权的那几个；
 *   参照：同「全授」，另外调一次 access_info 的单条查询（ref），作对照。
 * 量法：字节数（UTF-8）、字符数，以及估算的 token 数——中日韩字符按 1 个/字，其余按 4 字符/个。只是近似，用来比大小、看占比，不当计费依据。
 * 另外给出每个工具在 tools/list 里和在 access_info 目录里各占多少，从大到小排。
 *
 *   node scripts/mcp-context-size.mjs              打印表格
 *   node scripts/mcp-context-size.mjs --json FILE  另把全部数字写成 JSON
 *   node scripts/mcp-context-size.mjs --check      自检：数字都成形（接进 CI 用）
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `mcp-context-size-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-context-size-admin';
const jsonArg = process.argv.indexOf('--json');
const JSON_OUT = jsonArg >= 0 ? process.argv[jsonArg + 1] : null;
const CHECK = process.argv.includes('--check');

/** 中日韩统一表意文字、全角标点、假名、谚文按 1 个 token/字估，其余按 4 字符/个 */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/u;
export function measure(text) {
  const s = String(text);
  let cjk = 0, other = 0;
  for (const ch of s) { if (CJK.test(ch)) cjk++; else other++; }
  return { bytes: Buffer.byteLength(s, 'utf8'), chars: cjk + other, est_tokens: Math.round(cjk + other / 4) };
}

async function freePort() {
  const p = createServer();
  await new Promise((r) => p.listen(0, '127.0.0.1', r));
  const { port } = p.address();
  await new Promise((r) => p.close(r));
  return port;
}

let child = null, log = '';
async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 60000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);

  const admin = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const rpc = async (token, method, params = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return r.json();
  };
  const session = async (name, grants) => {
    const made = await admin('POST', '/api/mcp/sessions', { name });
    if (made.status !== 201) throw new Error(`建会话 ${name} 失败：${made.status}`);
    if (grants.length) {
      const g = await admin('PUT', `/api/mcp/sessions/${made.json.id}/grants`, { grants });
      if (g.status !== 200) throw new Error(`给 ${name} 授予失败：${g.status} ${JSON.stringify(g.json)}`);
    }
    return made.json.token;
  };

  const listed = await admin('GET', '/api/mcp/tools');
  const grantable = (listed.json ?? []).filter((t) => !t.always_allowed).map((t) => t.name);
  // 数据视图的工具不能整体授予（要限定到台），授予接口会拒；先试全部，被拒就按提示剔掉
  let fullGrants = grantable;
  const tokenAll = await (async () => {
    for (let i = 0; i < 3; i++) {
      try { return await session(`ctx-all-${i}`, fullGrants); } catch (e) {
        const m = /([a-z_]+) 是数据视图的工具/.exec(String(e.message));
        if (!m) throw e;
        fullGrants = fullGrants.filter((n) => !/^(dataset_|view_)/.test(n));
      }
    }
    throw new Error('全授会话建不起来');
  })();
  const tokenNone = await session('ctx-none', []);

  const one = async (token) => {
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'context-size', version: '0' } });
    const list = await rpc(token, 'tools/list');
    const info = await rpc(token, 'tools/call', { name: 'access_info', arguments: {} });
    const tools = list.result?.tools ?? [];
    const infoText = info.result?.content?.[0]?.text ?? '';
    let infoJson = null; try { infoJson = JSON.parse(infoText); } catch { /* 不是 JSON */ }
    return {
      tools_count: tools.length,
      initialize: measure(JSON.stringify(init.result ?? {})),
      tools_list: measure(JSON.stringify(tools)),
      access_info: measure(infoText),
      // 同一份应答不缩进（工具结果现在按缩进 2 格输出）、再去掉每项参数表各有多大：给第 1 步定目标用
      access_info_compact: infoJson ? measure(JSON.stringify(infoJson)) : null,
      access_info_index_only: infoJson ? measure(JSON.stringify({ ...infoJson, catalog: infoJson.catalog.map(({ input_schema, ...rest }) => rest) })) : null,
      catalog_count: infoJson?.catalog?.length ?? 0,
      per_tool_list: tools.map((t) => ({ name: t.name, ...measure(JSON.stringify(t)) })).sort((a, b) => b.est_tokens - a.est_tokens),
      per_tool_catalog: (infoJson?.catalog ?? []).map((t) => {
        const { input_schema, ...rest } = t;
        return { name: t.name, ...measure(JSON.stringify(t)), without_schema: measure(JSON.stringify(rest)).est_tokens, schema: measure(JSON.stringify(input_schema ?? {})).est_tokens };
      }).sort((a, b) => b.est_tokens - a.est_tokens),
      access_info_keys: infoJson ? Object.keys(infoJson) : [],
    };
  };
  const all = await one(tokenAll), none = await one(tokenNone);
  return { measured_at: new Date().toISOString(), method: '估算 token：中日韩字符 1 个/字，其余 4 字符/个；字节为 UTF-8', grantable_count: grantable.length, granted_in_full: fullGrants.length, sessions: { full: all, default: none } };
}

function table(r) {
  const row = (label, m) => `| ${label} | ${m.bytes} | ${m.chars} | ${m.est_tokens} |`;
  const lines = [];
  for (const [k, label] of [['full', '全授'], ['default', '缺省（新会话）']]) {
    const s = r.sessions[k];
    lines.push(`\n### ${label}：tools/list ${s.tools_count} 个工具，access_info 目录 ${s.catalog_count} 项\n`);
    lines.push('| 应答 | 字节 | 字符 | 估算 token |', '|---|---|---|---|');
    lines.push(row('initialize', s.initialize), row('tools/list', s.tools_list), row('access_info', s.access_info));
    if (s.access_info_compact) lines.push(row('access_info（同一份，不缩进）', s.access_info_compact), row('access_info（不缩进、去掉参数表）', s.access_info_index_only));
  }
  const top = r.sessions.full.per_tool_catalog.slice(0, 10);
  lines.push('\n### access_info 目录里最大的 10 项（全授会话，估算 token）\n', '| 工具 | 整项 | 去掉参数表 | 参数表 |', '|---|---|---|---|');
  for (const t of top) lines.push(`| ${t.name} | ${t.est_tokens} | ${t.without_schema} | ${t.schema} |`);
  return lines.join('\n');
}

let code = 0;
try {
  const r = await main();
  console.log(table(r));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(r, null, 2));
  if (CHECK) {
    const s = r.sessions;
    const okShape = s.full.tools_count > s.default.tools_count && s.full.access_info.est_tokens > 0 && s.default.access_info.est_tokens > 0 && s.full.catalog_count === s.default.catalog_count;
    console.log(okShape ? 'mcp-context-size: 数字成形' : 'mcp-context-size: 数字不成形');
    if (!okShape) code = 1;
  }
} catch (e) {
  console.error(`mcp-context-size: ${e?.message ?? e}`);
  code = 1;
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
process.exit(code);
