#!/usr/bin/env node
/** 自产台数据提交面冒烟（独立实例）：写入→读回→游标分页→掩码边界→大小限制。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9816;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-appdata-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, REDIS_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 3500));

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  // 发布一个台（数据面挂接对象）
  await call('POST', '/api/apps', { slug: 'appdata-smoke', title: 'T', files: [{ path: 'index.html', content: '<h1>x</h1>' }] });
  // ① 写入（{data:...} 形态）
  let r = await call('POST', '/api/apps/appdata-smoke/data', { data: { form: 'owba', manifest: { version: 1 } }, created_by: 'user-a' });
  ok('写入 201', r.status === 201 && r.body.ok && r.body.id > 0);
  // ② 写入（直接 JSON 形态）
  r = await call('POST', '/api/apps/appdata-smoke/data', { note: '直接对象', value: 42 });
  ok('直接 JSON 形态兼容', r.status === 201);
  // ③ 读回
  r = await call('GET', '/api/apps/appdata-smoke/data');
  ok('读回 2 条倒序', r.body.items.length === 2 && r.body.items[0].data.note === '直接对象' && r.body.items[1].data.form === 'owba');
  ok('has_more=false', r.body.has_more === false);
  // ④ 游标分页（造 10 条，limit=3 分页）
  for (let i = 0; i < 10; i++) await call('POST', '/api/apps/appdata-smoke/data', { seq: i });
  r = await call('GET', '/api/apps/appdata-smoke/data?limit=3');
  ok('limit=3 第一页', r.body.items.length === 3 && r.body.has_more === true && r.body.next_before_id !== null);
  const bid = r.body.next_before_id;
  r = await call('GET', `/api/apps/appdata-smoke/data?limit=3&before_id=${bid}`);
  ok('游标翻页', r.body.items.length === 3 && r.body.items[0].id < bid);
  // ⑤ 未知 slug 404
  r = await call('POST', '/api/apps/no-such/data', { x: 1 });
  ok('未知 slug 404', r.status === 404);
  // ⑥ 1MB 上限
  r = await call('POST', '/api/apps/appdata-smoke/data', { big: 'x'.repeat(1024 * 1024 + 100) });
  ok('1MB 拒 400', r.status === 400);
  // 清理
  await call('DELETE', '/api/apps/appdata-smoke');
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 数据面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
