#!/usr/bin/env node
// 常量「谁写的谁维护」冒烟：隔离 DATA_DIR（合成数据），MCP 网关开着，用两个真实会话当两个席位。
// 判据：
//   O1 会话新建常量 → 作者记为 mcp:<会话名>
//   O2 别的会话带 override 改 → 403 const_override_forbidden；作者本人不写 reason → 400 reason_required；写 reason → 200，审计记作者
//   O3 口令管理员不是作者，改不了；它新建的常量不记作者（共享身份）。按台令牌不能新建常量见 workbench-vars-smoke V4
//   O4 本机命令行兜底：可修订（要 reason）、可移交作者（只认个人身份）；移交后新作者能改、旧作者不能
//   O5 删除：口令管理员删不了别人的常量；本机命令行带 reason 兜底删除（MCP 不提供删除）
//   O7 公共常量：作者本人带 owner=*、override、reason 设成公共；之后任何会话带 override 与 reason 可修订，管理员口令仍不行；收归个人、转变量只限本机命令行/管理员
//   O6 旧库升级：没有 owner 列的库启动后补列，常量按 mcp:/odoo: 最后写入者回填，共享身份留空
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

mkdirSync('tmp', { recursive: true });
const ADMIN = 'const-owner-admin';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(DATA) {
  const PORT = 22000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', (c) => (err += c));
  return { base: 'http://127.0.0.1:' + PORT, child, err: () => err };
}
async function ready(i) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { if ((await fetch(i.base + '/api/health', { signal: AbortSignal.timeout(1500) })).ok) return true; } catch { /* 未起 */ }
    if (i.child.exitCode !== null) return false;
    await sleep(200);
  }
  return false;
}
async function stop(i) { if (i.child.exitCode === null) { const ex = new Promise((r) => i.child.once('exit', r)); i.child.kill(); await ex; } }

// 头形态：CLI=回环无浏览器标记；ADM=经反代的口令管理员（不算本机）
const CLI = { 'content-type': 'application/json' };
const ADM = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'x-admin-token': ADMIN };
async function call(base, method, path, headers, body) {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* 无体 */ }
  return { status: r.status, body: j };
}
const vpath = (id, key) => `/api/workbenches/${id}/vars/${encodeURIComponent(key)}`;

const DATA = mkdtempSync(resolve('tmp', 'const-owner-'));
const i = start(DATA);
try {
  ok('实例就绪（MCP 网关开）', await ready(i), i.err().slice(-300));
  const wb = await call(i.base, 'POST', '/api/workbenches', CLI, { name: 'Const Owner', url: 'http://127.0.0.1:9/', type: 'web' });
  const W = wb.body?.id;
  ok('合成外部台登记', wb.status === 201 && Number.isInteger(W), JSON.stringify(wb.body));
  const mk = async (name) => {
    const r = await call(i.base, 'POST', '/api/mcp/sessions', ADM, { name });
    await call(i.base, 'PUT', `/api/mcp/sessions/${r.body?.id}/grants`, ADM, { grants: ['workbench_vars_get', 'workbench_vars_set'] });
    return r.body?.token;
  };
  const alice = await mk('sess-alice'), bob = await mk('sess-bob');
  ok('两个会话（两个席位）', typeof alice === 'string' && typeof bob === 'string');
  const rpc = async (token, args) => {
    const r = await fetch(i.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workbench_vars_set', arguments: args } }) });
    const j = await r.json().catch(() => null);
    const text = j?.result?.content?.[0]?.text ?? '';
    let out = null; try { out = JSON.parse(text); } catch { /* 错误文本 */ }
    return { isError: j?.result?.isError === true || !!j?.error, out, text };
  };

  console.log('▶ O1 作者');
  let m = await rpc(alice, { id: W, key: 'rules', value: { v: 1 }, kind: 'const' });
  ok('会话 sess-alice 新建常量 → 作者 mcp:sess-alice', !m.isError && m.out?.owner === 'mcp:sess-alice' && m.out?.kind === 'const', m.text.slice(0, 200));

  console.log('▶ O2 作者本人维护');
  m = await rpc(bob, { id: W, key: 'rules', value: { v: 2 }, revision: 1, override: true, reason: 'bob tries' });
  ok('别的会话带 override 改 → 拒绝 const_override_forbidden', m.isError && /const_override_forbidden|只能由作者/.test(m.text), m.text.slice(0, 200));
  m = await rpc(alice, { id: W, key: 'rules', value: { v: 2 }, revision: 1 });
  ok('作者不带 override 改 → const_locked', m.isError && /const_locked|不能直接修改/.test(m.text), m.text.slice(0, 200));
  m = await rpc(alice, { id: W, key: 'rules', value: { v: 2 }, revision: 1, override: true });
  ok('作者带 override 不写 reason → reason_required', m.isError && /reason/.test(m.text), m.text.slice(0, 200));
  m = await rpc(alice, { id: W, key: 'rules', value: { v: 2 }, revision: 1, override: true, reason: '口径更新' });
  ok('作者带 override 与 reason 修订 → revision=2，仍是常量，作者不变', !m.isError && m.out?.revision === 2 && m.out?.kind === 'const' && m.out?.owner === 'mcp:sess-alice' && m.out?.value?.v === 2, m.text.slice(0, 200));
  let r = await call(i.base, 'GET', vpath(W, 'rules') + '/audit', CLI);
  ok('审计记作者本人与理由', r.body?.items?.[0]?.action === 'const_override' && r.body?.items?.[0]?.actor === 'mcp:sess-alice' && r.body?.items?.[0]?.reason === '口径更新', JSON.stringify(r.body?.items?.[0]));

  console.log('▶ O3 管理员与台令牌');
  r = await call(i.base, 'PUT', vpath(W, 'rules'), ADM, { value: { v: 9 }, revision: 2, override: true, reason: 'admin' });
  ok('口令管理员不是作者 → 403 const_override_forbidden', r.status === 403 && r.body?.code === 'const_override_forbidden', JSON.stringify(r.body));
  r = await call(i.base, 'PUT', vpath(W, 'admin_rules'), ADM, { value: 1, kind: 'const' });
  ok('口令管理员新建常量 → 作者留空（共享身份）', r.status === 201 && r.body?.owner === '', JSON.stringify(r.body));

  console.log('▶ O4 本机兜底与移交');
  r = await call(i.base, 'PUT', vpath(W, 'rules'), ADM, { value: { v: 2 }, revision: 2, override: true, reason: 'x', owner: 'mcp:sess-bob' });
  ok('非本机移交作者 → 403', r.status === 403, JSON.stringify(r.body));
  r = await call(i.base, 'PUT', vpath(W, 'rules'), CLI, { value: { v: 2 }, revision: 2, override: true, reason: 'seat handover', owner: 'admin-token' });
  ok('移交给共享身份 → 400', r.status === 400, JSON.stringify(r.body));
  r = await call(i.base, 'PUT', vpath(W, 'rules'), CLI, { value: { v: 2 }, revision: 2, override: true, reason: 'seat handover', owner: 'mcp:sess-bob' });
  ok('本机命令行移交作者给 mcp:sess-bob → 200', r.status === 200 && r.body?.owner === 'mcp:sess-bob' && r.body?.revision === 3, JSON.stringify(r.body));
  m = await rpc(alice, { id: W, key: 'rules', value: { v: 4 }, revision: 3, override: true, reason: 'old owner' });
  ok('移交后旧作者改不了', m.isError, m.text.slice(0, 200));
  m = await rpc(bob, { id: W, key: 'rules', value: { v: 4 }, revision: 3, override: true, reason: '接手后更新' });
  ok('移交后新作者能改', !m.isError && m.out?.revision === 4 && m.out?.owner === 'mcp:sess-bob', m.text.slice(0, 200));

  console.log('▶ O7 公共常量');
  m = await rpc(alice, { id: W, key: 'shared', value: 'v1', kind: 'const' });
  ok('sess-alice 新建常量 shared', !m.isError && m.out?.owner === 'mcp:sess-alice', m.text.slice(0, 200));
  m = await rpc(bob, { id: W, key: 'shared', value: 'v1', revision: 1, override: true, reason: 'bob', owner: '*' });
  ok('别的会话设不了公共 → 拒绝', m.isError && /const_override_forbidden|只能由/.test(m.text), m.text.slice(0, 200));
  m = await rpc(alice, { id: W, key: 'shared', value: 'v1', revision: 1, override: true, owner: '*' });
  ok('作者设公共不写 reason → reason_required', m.isError && /reason/.test(m.text), m.text.slice(0, 200));
  m = await rpc(alice, { id: W, key: 'shared', value: 'v1', revision: 1, override: true, reason: '部门公共，大家按需维护', owner: '*' });
  ok('作者带 override、reason、owner=* → 仍是常量，owner=*', !m.isError && m.out?.kind === 'const' && m.out?.owner === '*' && m.out?.revision === 2, m.text.slice(0, 200));
  r = await call(i.base, 'GET', vpath(W, 'shared') + '/audit', CLI);
  ok('审计记 make_public、作者与理由', r.body?.items?.[0]?.action === 'make_public' && r.body?.items?.[0]?.actor === 'mcp:sess-alice' && r.body?.items?.[0]?.reason === '部门公共，大家按需维护', JSON.stringify(r.body?.items?.[0]));
  m = await rpc(bob, { id: W, key: 'shared', value: 'v2', revision: 2 });
  ok('公共常量不带 override 改 → const_locked', m.isError && /const_locked|不能直接修改/.test(m.text), m.text.slice(0, 200));
  m = await rpc(bob, { id: W, key: 'shared', value: 'v2', revision: 2, override: true });
  ok('公共常量不写 reason → reason_required', m.isError && /reason/.test(m.text), m.text.slice(0, 200));
  m = await rpc(bob, { id: W, key: 'shared', value: 'v2', revision: 2, override: true, reason: 'sess-bob：补一条' });
  ok('别的会话带 override 与 reason 修订公共常量 → 200，owner 仍是 *', !m.isError && m.out?.revision === 3 && m.out?.owner === '*' && m.out?.value === 'v2', m.text.slice(0, 200));
  r = await call(i.base, 'PUT', vpath(W, 'shared'), ADM, { value: 'v3', revision: 3, override: true, reason: 'admin' });
  ok('管理员口令改公共常量 → 403（共享身份）', r.status === 403 && r.body?.code === 'const_override_forbidden', JSON.stringify(r.body));
  m = await rpc(bob, { id: W, key: 'shared', value: 'v2', revision: 3, override: true, reason: 'take', owner: 'mcp:sess-bob' });
  ok('会话把公共常量收归自己 → owner_change_forbidden', m.isError && /owner_change_forbidden|只限部署机/.test(m.text), m.text.slice(0, 200));
  m = await rpc(bob, { id: W, key: 'shared', value: 'v2', kind: 'var', revision: 3, override: true, reason: 'unlock' });
  ok('会话把公共常量转成变量 → kind_change_forbidden', m.isError && /kind_change_forbidden|只限管理员/.test(m.text), m.text.slice(0, 200));
  r = await call(i.base, 'PUT', vpath(W, 'shared'), CLI, { value: 'v2', revision: 3, override: true, reason: 'handover', owner: 'mcp:sess-alice' });
  ok('本机命令行可把公共常量移交回个人作者', r.status === 200 && r.body?.owner === 'mcp:sess-alice', JSON.stringify(r.body));

  console.log('▶ O5 删除');
  r = await call(i.base, 'DELETE', vpath(W, 'rules') + '?revision=4&override=1&reason=retired', ADM);
  ok('口令管理员删别人的常量 → 403', r.status === 403 && r.body?.code === 'const_override_forbidden', JSON.stringify(r.body));
  r = await call(i.base, 'DELETE', vpath(W, 'rules') + '?revision=4&override=1&reason=retired', CLI);
  ok('本机命令行带 reason 删 → 200', r.status === 200 && r.body?.deleted === true, JSON.stringify(r.body));
} catch (e) {
  fail++; console.log('  ✗ 异常 ' + (e?.stack ?? e));
} finally {
  await stop(i);
  rmSync(DATA, { recursive: true, force: true });
}

console.log('▶ O6 旧库升级回填');
{
  const OLD = mkdtempSync(resolve('tmp', 'const-owner-old-'));
  const db = new DatabaseSync(resolve(OLD, 'workbench-market.db'), { timeout: 5000 });
  // 升级前的表结构（没有 owner 列）
  db.exec(`CREATE TABLE workbench_vars (workbench_id INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'var' CHECK (kind IN ('var','const')), value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (workbench_id, key));`);
  const ins = db.prepare('INSERT INTO workbench_vars (workbench_id, key, kind, value, updated_by) VALUES (1, ?, ?, ?, ?)');
  ins.run('c_mcp', 'const', '1', 'mcp:seat-old'); ins.run('c_odoo', 'const', '1', 'odoo:someone'); ins.run('c_app', 'const', '1', 'app:demo');
  ins.run('c_admin', 'const', '1', 'admin'); ins.run('v_mcp', 'var', '1', 'mcp:seat-old');
  db.close();
  const j = start(OLD);
  try {
    ok('旧库实例就绪', await ready(j), j.err().slice(-300));
  } finally { await stop(j); }
  const after = new DatabaseSync(resolve(OLD, 'workbench-market.db'), { readOnly: true });
  const own = Object.fromEntries(after.prepare('SELECT key, owner FROM workbench_vars WHERE workbench_id = 1').all().map((x) => [x.key, x.owner]));
  after.close();
  ok('回填：mcp:/odoo: 常量记作者，台令牌与 admin 留空，变量不记作者', own.c_mcp === 'mcp:seat-old' && own.c_odoo === 'odoo:someone' && own.c_app === '' && own.c_admin === '' && own.v_mcp === '', JSON.stringify(own));
  rmSync(OLD, { recursive: true, force: true });
}

console.log(`\n===== 常量作者冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
