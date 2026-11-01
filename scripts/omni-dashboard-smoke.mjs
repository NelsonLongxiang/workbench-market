#!/usr/bin/env node
/** 总览聚合卡冒烟（omni-inbox 补件）：Dashboard 页含 待办/进行中 深链卡（设计第 15 行）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9848;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-omni2-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: `../${DATA}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
try {
  // SPA 客户端渲染：裸 HTML 不含卡片文本——断言落在 bundle 上（入口 script 内容含卡片文案与 /tasks 深链）
  const html = await (await fetch(BASE + '/')).text();
  const srcs = [...html.matchAll(/src="([^"]+[.]js)"/g)].map((m) => m[1]);
  let bundle = '';
  for (const u of srcs) {
    try { const r = await fetch(BASE + u); bundle += await r.text(); } catch { /* 跳过 */ }
  }
  ok('总览页含「待办」聚合卡', bundle.includes('待办'));
  ok('总览页含「进行中」聚合卡', bundle.includes('进行中'));
  ok('聚合卡深链 /tasks 在 bundle', bundle.includes('/tasks'));
  const tasks = await (await fetch(BASE + '/api/tasks')).json();
  ok('聚合卡数据源与 /api/tasks 同源', Array.isArray(tasks?.tasks) && 'sources' in tasks);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 总览聚合卡冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
