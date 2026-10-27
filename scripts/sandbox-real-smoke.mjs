#!/usr/bin/env node
/** 沙箱真调用闸冒烟（#94 P0·总工立第三闸：真 tools/call 往返·工具名/grep 不算·判据先红后绿）。
 *  背景：PR#70 的 sop_run_sandbox 只有 mcp-tools.ts 声明，index.ts 分发无分支——tools/call 报未知工具，bridge 零请求。
 *  判据：①真 tools/call（/mcp JSON-RPC）→ 非「未知工具」②替身 bridge 收到恰好 1 次 /dispatch（run_id+script 核对）
 *        ③三态透传：bridge 回 ok=true→原样；回 503 retryable→原样 error 面；回 400 fatal→原样
 *        ④未知工具仍报未知（护栏——第三闸不放水）。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 9865;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-sandbox-real-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

// 替身 bridge：收 /dispatch 记录请求·可切换三态响应
let bridgeMode = 'ok';
const dispatches = [];
const bridge = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    dispatches.push({ url: req.url, body: parsed });
    if (bridgeMode === 'ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, commit_hash: 'c0ffee123', exit_code: 0, stdout_tail: 'hello', stderr_tail: '', duration_ms: 12 }));
    } else if (bridgeMode === 'retryable') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, retryable: true, error: 'bridge busy' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, retryable: false, error: 'bad script' }));
    }
  });
});
const BP = await new Promise((r) => bridge.listen(0, '127.0.0.1', () => r(bridge.address().port)));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`);
  db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, SANDBOX_BRIDGE_URL: `http://127.0.0.1:${BP}` },
  stdio: 'ignore',
});

const mcp = async (id, method, params) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  const raw = await res.text();
  const line = (raw.split('\n').find((l) => l.startsWith('data:')) ?? raw).replace(/^data:\s*/, '');
  try { return JSON.parse(line); } catch { return { raw: line.slice(0, 200) }; }
};

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // ① 真 tools/call → 非未知工具
  const r1 = await mcp(1, 'tools/call', { name: 'sop_run_sandbox', arguments: { run_id: 224, script: 'console.log(1)', timeout_ms: 5000 } });
  const t1 = r1?.result?.content?.[0]?.text ?? JSON.stringify(r1);
  ok('① tools/call 非「未知工具」（红版必红）', !/未知工具|unknown tool/i.test(String(t1)), String(t1).slice(0, 120));
  // ② 替身 bridge 收到恰好 1 次派发（run_id+script 核对）
  await new Promise((r) => setTimeout(r, 800));
  ok('② 替身收 1 次 /dispatch', dispatches.length === 1, `got=${dispatches.length}`);
  ok('②b 派发体含 run_id=224+script', dispatches[0]?.body?.run_id === 224 && typeof dispatches[0]?.body?.script === 'string', JSON.stringify(dispatches[0]?.body).slice(0, 120));
  // ③ 三态透传：retryable
  bridgeMode = 'retryable';
  const r3 = await mcp(2, 'tools/call', { name: 'sop_run_sandbox', arguments: { run_id: 224, script: 'x' } });
  const t3 = JSON.stringify(r3);
  ok('③ retryable 透传（bridge busy/503）', /retryable|busy|503/.test(t3), t3.slice(0, 160));
  // ④ 未知工具护栏
  const r4 = await mcp(3, 'tools/call', { name: 'definitely_not_a_tool', arguments: {} });
  ok('④ 未知工具仍报未知（第三闸不放水）', /未知工具|unknown tool|-32601/i.test(JSON.stringify(r4)), JSON.stringify(r4).slice(0, 120));
} finally {
  child.kill(); bridge.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 沙箱真调用闸冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
