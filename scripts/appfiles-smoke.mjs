#!/usr/bin/env node
/** 自产台文件提交面冒烟（独立实例）：所有资源类型——上传→列表→下载→校验→50MB 上限→删除清理。 */
import { spawn } from 'node:child_process';

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';

const PORT = 9817;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-appfiles-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, REDIS_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪（20s 超时）'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function uploadFile(slug, name, mime, bytes, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(`${BASE}/api/apps/${slug}/files`, { method: 'POST', body: fd });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  await call('POST', '/api/apps', { slug: 'fileprobe', title: 'F', files: [{ path: 'index.html', content: '<h1>x</h1>' }] });
  // ① 上传二进制（PNG 头）——所有类型
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let r = await uploadFile('fileprobe', '截图.png', 'image/png', png, { created_by: 'user-a', note: '证据截图' });
  ok('上传 PNG 201', r.status === 201 && r.body.ok && r.body.id > 0, JSON.stringify(r.body).slice(0, 120));
  ok('元数据回显', r.body.name === '截图.png' && r.body.mime === 'image/png' && r.body.size === png.length);
  const fileId = r.body.id;
  // ② 上传 PDF（不同 mime）
  r = await uploadFile('fileprobe', '报告.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test'), { created_by: 'user-b' });
  ok('上传 PDF 201', r.status === 201 && r.body.mime === 'application/pdf');
  // ③ 上传二进制流（未知 mime → octet-stream）
  r = await uploadFile('fileprobe', 'data.bin', '', Buffer.from([0, 1, 2, 3, 255]));
  ok('未知类型 octet-stream', r.status === 201 && (r.body.mime === '' || r.body.mime.includes('octet')));
  // ④ 列表倒序
  r = await call('GET', '/api/apps/fileprobe/files');
  ok('列表 3 条倒序', r.body.items.length === 3 && r.body.items[0].original_name === 'data.bin');
  // ⑤ 下载内容一致 + 头
  const dl = await fetch(`${BASE}/api/apps/fileprobe/files/${fileId}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  ok('下载内容一致', dl.status === 200 && buf.equals(png));
  ok('content-type 正确', (dl.headers.get('content-type') ?? '').includes('image/png'));
  ok('content-disposition inline（图片白名单）', (dl.headers.get('content-disposition') ?? '').startsWith('inline'));
  ok('nosniff', dl.headers.get('x-content-type-options') === 'nosniff');
  // ⑥ 未知 slug / 未知文件 id 404
  r = await uploadFile('no-such', 'x.txt', 'text/plain', Buffer.from('x'));
  ok('未知 slug 404', r.status === 404);
  const dl404 = await fetch(`${BASE}/api/apps/fileprobe/files/99999`);
  ok('未知文件 id 404', dl404.status === 404);
  // ⑦ 50MB 上限 → 413
  const big = Buffer.alloc(50 * 1024 * 1024 + 1024, 0x41);
  r = await uploadFile('fileprobe', 'big.bin', 'application/octet-stream', big);
  ok('50MB 上限 → 413', r.status === 413, `status=${r.status}`);
  // ⑧ 删台级联清文件
  await call('DELETE', '/api/apps/fileprobe');
  const dlAfter = await fetch(`${BASE}/api/apps/fileprobe/files/${fileId}`);
  ok('删台后文件 404（级联清理）', dlAfter.status === 404);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 文件面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
