#!/usr/bin/env node
/** #284 网关缺省开冒烟：未设 / 空串 / on 均要求会话令牌（匿名 initialize·tools/list·tools/call 全 401）；
 *  只有显式 off 才匿名可调且启动 stderr 告警；无法识别的值拒绝启动（不按关处理）。独立实例、合成数据目录、随机端口。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

function start(mode, tag) {
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const DATA = `tmp/e2e-gwdef-${tag}`;
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'gwdef-admin-tok' };
  delete env.MCP_GATEWAY;
  if (mode !== undefined) env.MCP_GATEWAY = mode;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { base: `http://127.0.0.1:${PORT}`, child, exited, stderr: () => err, DATA };
}
async function ready(inst, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (inst.child.exitCode !== null) return false;
    try { const r = await fetch(inst.base + '/api/health'); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function stop(inst) {
  if (inst.child.exitCode === null && inst.child.signalCode === null) { inst.child.kill(); await inst.exited; }
  rmSync(inst.DATA, { recursive: true, force: true });
}
const rpc = (base, method, params) => fetch(base + '/mcp', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});

for (const [label, mode] of [['未设', undefined], ['空串', ''], ['on', 'on']]) {
  const inst = start(mode, label === '未设' ? 'unset' : label === '空串' ? 'empty' : 'on');
  try {
    ok(`${label}：实例就绪`, await ready(inst), inst.stderr().slice(-300));
    for (const [m, p] of [['initialize', { protocolVersion: '2025-06-18' }], ['tools/list', {}], ['tools/call', { name: 'gwdef-nonexistent-probe', arguments: {} }]]) {
      const r = await rpc(inst.base, m, p);
      ok(`${label}：匿名 ${m} → 401`, r.status === 401 && /Bearer/.test(r.headers.get('www-authenticate') ?? ''), `status=${r.status}`);
    }
    ok(`${label}：无 off 告警`, !/MCP_GATEWAY=off/.test(inst.stderr()));
  } finally { await stop(inst); }
}

{
  const inst = start('off', 'off');
  try {
    ok('off：实例就绪', await ready(inst), inst.stderr().slice(-300));
    const r = await rpc(inst.base, 'tools/list', {});
    const j = await r.json().catch(() => null);
    ok('off：匿名 tools/list → 200（显式关闭的开发形态）', r.status === 200 && Array.isArray(j?.result?.tools), `status=${r.status}`);
    ok('off：启动 stderr 告警', /\[#284\] 警告：MCP_GATEWAY=off/.test(inst.stderr()));
  } finally { await stop(inst); }
}

for (const bad of ['OFF', 'false', '0', 'yes']) {
  const inst = start(bad, 'bad-' + bad);
  try {
    const code = await Promise.race([inst.exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    ok(`无法识别值 ${JSON.stringify(bad)}：拒绝启动（非 0 退出）`, typeof code === 'number' && code !== 0, `exit=${code}`);
    ok(`无法识别值 ${JSON.stringify(bad)}：stderr 点名拒绝`, /\[#284\] 拒绝启动/.test(inst.stderr()));
  } finally { await stop(inst); }
}

console.log(`gateway-default-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
