#!/usr/bin/env node
/** #94 v3 S0 六件冒烟（总工 direct-b6cc7b7b·判据先红后绿）。
 *  ①多文件校验误判篡改（publish digest vs verify digest 同构化）
 *  ②子目录发布 500（docs/a.md → 201）
 *  ③slug/路径不校验（坏 slug/坏 path → 400）
 *  ④撤销不校验（不存在/错 slug → 404/400）
 *  ⑤暴露 DATA_DIR 绝对路径（发布响应 snapshot_path 不含 dataDir）
 *  ⑥bridge 未带 Bearer（鉴权头）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const PORT = 9868;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-s0-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 's0-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

// ⑥ 替身 bridge（带 Bearer 校验）
let sawAuth = null;
const bridge = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    sawAuth = req.headers.authorization ?? null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '2' });
    res.end('{}');
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
  env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's0-tok', SANDBOX_BRIDGE_URL: `http://127.0.0.1:${BP}`, SANDBOX_BRIDGE_TOKEN: 'br-tok' },
  stdio: 'ignore',
});

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  const pubSkill = (slug, files) => fetch(`${BASE}/api/skills/${slug}/versions`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ files, changelog: 's0', reviewed_by: 's0-smoke' }) });

  // ① 多文件 digest 同构（大小写排序分歧路径：'Zebra.txt' vs 'apple.txt'）
  const r1 = await pubSkill('s0:multi', [{ path: 'Zebra.txt', content: 'Z' }, { path: 'apple.txt', content: 'a' }]);
  ok('① 多文件发布 201', r1.status === 201, `status=${r1.status}`);
  const j1 = await r1.json().catch(() => ({}));
  // #601/#183 后 verify 封禁快照根外路径：钉装默认落快照路径（installed_path 缺省=target.snapshot_path）
  const inst1 = await fetch(`${BASE}/api/skills/s0:multi/install`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ version: j1.version ?? 1, installed_by: 's0' }) });
  ok('①b 钉装 201', inst1.status === 201, `status=${inst1.status}`);
  const inst1j = await inst1.json().catch(() => ({}));
  if (inst1j.ledger_id) {
    const v1 = await fetch(`${BASE}/api/skills/s0:multi/verify`).then((r) => r.json());
    ok('①c 多文件校验不误判篡改（ok:true）', v1.ok === true, JSON.stringify(v1).slice(0, 140));
  } else { ok('①c 多文件校验不误判篡改（ok:true）', false, '无 ledger'); }

  // ② 子目录发布
  const r2 = await pubSkill('s0:sub', [{ path: 'docs/a.md', content: '# a' }]);
  ok('② 子目录发布 201', r2.status === 201, `status=${r2.status}`);

  // ③ slug/路径校验
  const r3a = await pubSkill('s0:bad!', [{ path: 'a.md', content: 'x' }]);
  ok('③a 坏 slug 拒 400', r3a.status === 400, `status=${r3a.status}`);
  const r3b = await pubSkill('s0:badpath', [{ path: '..\\evil.md', content: 'x' }]);
  ok('③b 反斜杠穿越路径拒 400', r3b.status === 400, `status=${r3b.status}`);
  const r3c = await pubSkill('s0:badpath2', [{ path: 'C:\\abs.md', content: 'x' }]);
  ok('③c 绝对路径拒 400', r3c.status === 400, `status=${r3c.status}`);

  // ④ 撤销校验
  const r4a = await fetch(`${BASE}/api/skills/s0:multi/install/999999/revoke`, { method: 'POST', headers: ADMIN });
  ok('④a 撤销不存在 ledgerId → 404', r4a.status === 404, `status=${r4a.status}`);
  if (inst1j.ledger_id) {
    const r4b = await fetch(`${BASE}/api/skills/WRONG-SLUG/install/${inst1j.ledger_id}/revoke`, { method: 'POST', headers: ADMIN });
    ok('④b 错 slug 撤销 → 400/404', r4b.status === 400 || r4b.status === 404, `status=${r4b.status}`);
  } else { ok('④b 错 slug 撤销 → 400/404', false, '无 ledger'); }

  // ⑤ 不暴露 DATA_DIR（发布响应 snapshot_path 不含 dataDir 探针）
  const j2 = await (await pubSkill('s0:leak', [{ path: 'a.md', content: 'leak' }])).json().catch(() => ({}));
  const sp = String(j2.snapshot_path ?? '');
  ok('⑤ 响应不暴露 DATA_DIR 绝对路径', sp !== '' && !/[A-Za-z]:[\\/]|\/mnt\/|\/home\//.test(sp), sp.slice(0, 60) || '(空)');

  // ⑥ bridge Bearer
  const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sop_run_sandbox', arguments: { run_id: 1, script: 'x' } } }) }).then((r) => r.text());
  ok('⑥ bridge 收到 Bearer 鉴权头', /Bearer br-tok/.test(String(sawAuth ?? '')), String(sawAuth ?? '(无)'));
} finally {
  child.kill(); bridge.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`
===== #94 v3 S0 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
