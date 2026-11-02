#!/usr/bin/env node
/** 发布内容门禁冒烟（S1·采购席反馈 P1/v16 事故锚·判据先红后绿）。
 *  材料①实证：13:06 空 content 照发上线 v16（发布器零告警）→ served 0 bytes 2 分钟。
 *  三闸（服务端 publish 入口）：①空 content 拒 ②体积骤降>50% 拒（显式 force 可越）
 *  ③HTML div 开闭配对失衡拒。判据另含：正常发布不受影响（护栏）+ sop kind 同门（对齐）。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9854;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-pubgate-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const publish = async (body) => await fetch(`${BASE}/api/apps`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA },
  stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  console.log('实例就绪', BASE);

  const page = (n) => `<!doctype html><html><body><h1>v${n}</h1><div>a</div><div>b</div><script>console.log(${n})</script></body></html>`;
  // ⓪ 基线：正常发布（护栏·绿前后都应 200/201）
  const p0 = await publish({ slug: 'pubgate-demo', title: '门禁演示', files: [{ path: 'index.html', content: page(1) }] });
  ok('⓪ 正常发布放行', p0.status === 200 || p0.status === 201, `status=${p0.status}`);

  // ① 空 content 拒（v16 事故复现·红判据第一条）
  const p1 = await publish({ slug: 'pubgate-demo', files: [{ path: 'index.html', content: '' }] });
  ok('① 空 content 拒发 400', p1.status === 400, `status=${p1.status}`);
  ok('①b 拒因明示「空」', /空|empty/i.test(String(p1.body?.error ?? '')), String(p1.body?.error ?? '').slice(0, 80));

  // ② 体积骤降 >50% 拒（v1≈320B → 50B）
  const p2 = await publish({ slug: 'pubgate-demo', files: [{ path: 'index.html', content: '<p>tiny</p>' }] });
  ok('② 体积骤降>50% 拒发 400', p2.status === 400, `status=${p2.status}`);
  // ②b 显式 force 可越（合法瘦身通道·文档化）
  const p2b = await publish({ slug: 'pubgate-demo', force: true, files: [{ path: 'index.html', content: '<p>tiny-on-purpose</p>' }] });
  ok('②b 显式 force 越门放行', p2b.status === 200 || p2b.status === 201, `status=${p2b.status}`);

  // ③ div 配对失衡拒（开 3 闭 2）
  const p3 = await publish({ slug: 'pubgate-demo', files: [{ path: 'index.html', content: '<div><div><div>x</div></div>' }] });
  ok('③ div 配对失衡拒发 400', p3.status === 400, `status=${p3.status}`);

  // ④ 新台（无前版）不受体积门影响：小台首发布放行
  const p4 = await publish({ slug: 'pubgate-fresh', title: '小台', files: [{ path: 'index.html', content: '<p>small first version ok</p>' }] });
  ok('④ 新台首版放行（无体积基线）', p4.status === 200 || p4.status === 201, `status=${p4.status}`);

  // ⑤ sop kind 同门：空 content 拒
  const p5 = await publish({ slug: 'pubgate-sop', kind: 'sop', code: 'SOP-TEST-1', changelog: 'test', files: [{ path: 'sop.yaml', content: '' }] });
  ok('⑤ sop 台空 content 同拒 400', p5.status === 400, `status=${p5.status}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 发布门禁冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
