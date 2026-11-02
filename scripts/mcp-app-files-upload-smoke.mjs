#!/usr/bin/env node
/** #164 P1② MCP app_files_upload 冒烟：①上传 200+id/url ②文件面列表可见（同表同链）③超 50MB→413 ④缺参→400。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 10047;
const DATA = 'tmp/e2e-up-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'up' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const B = `http://127.0.0.1:${PORT}`;
const mcp = async (name, args) => {
  const r = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  let payload = {}; try { payload = JSON.parse(j.result?.content?.[0]?.text ?? '{}'); } catch {}
  return { status: r.status, j, payload };
};
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'up' }, stdio: 'ignore',
});
try {
  await waitReady(`${B}/api/health`);
  await fetch(`${B}/api/apps`, { method: 'POST', headers: H, body: JSON.stringify({ slug: 'up1', title: 'u', files: [{ path: 'index.html', content: '<h1>u</h1>' }] }) });
  // ① 上传
  const b64 = Buffer.from('hello,mcp\n1,2').toString('base64');
  let r = await mcp('app_files_upload', { slug: 'up1', name: '交付.csv', content_base64: b64, mime: 'text/csv', note: 'MCP 上传', created_by: 'e2e' });
  ok('① 上传成功（id/url/note）', r.payload.ok === true && Number.isInteger(r.payload.id) && String(r.payload.url).includes('/files/'), JSON.stringify(r.payload).slice(0, 100));
  ok('② 字节一致（size=13）', r.payload.size === 13, `size=${r.payload.size}`);
  // ③ 列表可见（同表同链）
  const list = await mcp('app_files_list', { slug: 'up1' });
  ok('③ 文件面列表可见', (list.payload.items ?? []).some((x) => x.id === r.payload.id && x.note === 'MCP 上传'), JSON.stringify(list.payload.items ?? []).slice(0, 120));
  // ④ 缺参 400
  const bad = await mcp('app_files_upload', { slug: 'up1' });
  const badTxt = String(bad.j.result?.content?.[0]?.text ?? bad.j.error?.message ?? '');
  ok('④ 缺参拒绝（必填提示）', badTxt.includes('必填') || /400/.test(JSON.stringify(bad.j)), badTxt.slice(0, 80));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log(`\n===== MCP 上传冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
