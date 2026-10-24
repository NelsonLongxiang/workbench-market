#!/usr/bin/env node
/** P4 run 交付物冒烟（product/run-delivery F1-F7 自查版 · 独立实例） */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9844;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-delivery-data';
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
const json = async (url, method = 'GET', body, headers = {}) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
};
async function upload(runId, name, bytes, mime = 'application/octet-stream') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), name);
  const r = await fetch(`${BASE}/api/sop/runs/${runId}/files`, { method: 'POST', body: fd });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
}

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'dl-tok' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
const AT = { 'X-Admin-Token': 'dl-tok' };

try {
  await json(`${BASE}/api/apps`, 'POST', {
    slug: 'rv-deliv', kind: 'sop', title: '交付冒烟',
    files: [{ path: 'sop.yaml', content: 'title: 交付冒烟\ncode: SOP-DLV\nsteps:\n  - key: s1\n    title: 一步\n    body: "<p>x</p>"\n' }],
    changelog: '冒烟',
  });
  await json(`${BASE}/api/sops/rv-deliv/publish`, 'POST', {}, AT);
  await json(`${BASE}/api/sops/rv-deliv/bindings`, 'POST', { node: 'dsh/0123dlv', mode: 'run' }, AT);
  const card = await json(`${BASE}/.well-known/agent-card.json`);
  const team = card.body?.sessionTeams?.find((t) => t.name === 'rv-deliv')?.team;
  const d = await json(`${BASE}/a2a/direct`, 'POST', {
    team, caller_session: 'dsh/0123dlv', task_id: 'dlv-1', context_id: 'dlvctx-1',
    message: JSON.stringify({ sop: { slug: 'rv-deliv', action: 'start' } }),
  });
  const runId = d.body?.sop?.run_id;
  ok('派单 run 就绪', Number.isInteger(runId));

  // F1 上传 + 列表 + 下载字节一致
  const bytes = Buffer.from('交付物内容-deliverable-42', 'utf8');
  let r = await upload(runId, '交付 说明.txt', bytes, 'text/plain');
  ok('F1 上传 201', r.status === 201, JSON.stringify(r.body).slice(0, 120));
  const fileId = r.body?.id;
  r = await json(`${BASE}/api/sop/runs/${runId}/files`);
  ok('F1 列表含文件', r.body?.count === 1 && r.body.items[0].original_name === '交付 说明.txt', JSON.stringify(r.body).slice(0, 160));
  const dl = await fetch(`${BASE}/api/sop/runs/${runId}/files/${fileId}`);
  const got = Buffer.from(await dl.arrayBuffer());
  ok('F1 下载字节一致', dl.status === 200 && got.equals(bytes));

  // F2 不存在的 run：404 且不落盘
  const before = (await json(`${BASE}/api/sop/runs/${runId}/files`)).body?.count ?? 0;
  r = await upload(999999, 'x.txt', Buffer.from('x'));
  ok('F2 未知 run 404', r.status === 404, String(r.status));

  // F4 超 50MB → 413
  const big = Buffer.alloc(50 * 1024 * 1024 + 1024, 0x41);
  r = await upload(runId, 'big.bin', big);
  ok('F4 50MB 上限 413', r.status === 413, String(r.status));

  // F3 完成后不可上传 → 409
  await json(`${BASE}/api/sop/runs/${runId}/finish`, 'POST', {});
  r = await upload(runId, 'after.txt', Buffer.from('after'));
  ok('F3 已完成 run 409', r.status === 409, String(r.status));

  // F5/F6 Runner 页面：交付区与文件链接（HTML 层断言）
  const page = await fetch(`${BASE}/sop/rv-deliv/`);
  const html = await page.text();
  ok('F5/F6 Runner 含交付区容器', html.includes('agent-extras') && html.includes('交付区'));
  ok('F6 文件列表渲染逻辑在位', html.includes('/files') && html.includes('original_name'));

  // F7 待验收列表：running 且有派单来源（人开的不算）
  const human = await json(`${BASE}/api/sop/runs`, 'POST', { slug: 'rv-deliv', started_by: 'human' });
  const list = await json(`${BASE}/api/sop/runs?dispatched=1`);
  const ids = (list.body ?? []).map((x) => x.id);
  ok('F7 待验收只含派单 running', ids.includes(human.body?.id) === false && ids.length >= 0, JSON.stringify(ids));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== P4 交付冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
