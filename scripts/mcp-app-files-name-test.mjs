#!/usr/bin/env node
/**
 * #815：MCP 工具 app_files_upload（base64）的文件名照原样存，不当 latin1 乱码去「修」，并和 REST 原始字节上传同样校验。
 * 独立实例：全新 DATA_DIR、合成的管理口令、MCP_GATEWAY=on、GitHub 替身仓库发一个合成自产台。
 *  一、UTF-8 名字原样存：合成.csv（修之前被存成 "\b\u0010.csv"）、交付.csv、emoji、本来就带 Ã 的名字、英文名
 *  二、不合法的名字拒收、不保存：带 /、\、..、控制字符、. 和 ..、超 255 字符
 *  三、DEL（0x7f）和方向控制符（U+202A～202E、U+2066～2069、U+200E/200F、U+061C）：base64、上传票、REST 原始字节三个入口都拒收
 * 测试数据都是合成的。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

const PORT = 20000 + Math.floor(Math.random() * 12000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-mcp-files-name-' + Date.now().toString(36);
const ADMIN = 'files-name-synthetic-admin';
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const gh = await startFakeGithub();
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  env: { PATH: process.env.PATH, HOME: join(DATA, 'home'), NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', REDIS_URL: '', WM_GITHUB_API: gh.api },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const end = Date.now() + 60000;
let up = false;
while (!up && Date.now() < end && child.exitCode === null) {
  try { up = (await fetch(BASE + '/api/health')).status === 200; } catch { /* 还没起来 */ }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.log('  ✗ 实例没起来\n' + log.slice(-1500)); child.kill(); await gh.close?.(); process.exit(1); }

const AT = { 'X-Admin-Token': ADMIN };
async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
  return { status: r.status, body: j };
}
async function tool(token, name, args = {}) {
  const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { Authorization: `Bearer ${token}` });
  const text = r.body?.result?.content?.[0]?.text ?? '';
  let payload = null; try { payload = JSON.parse(text); } catch { /* 错误是一句话 */ }
  return { isError: !!r.body?.result?.isError, text, payload, rpcError: r.body?.error ?? null };
}

try {
  const pub = await ghPublish(BASE, gh, { slug: 'name-app', title: '合成文件名台', files: [{ path: 'index.html', content: '<h1>合成</h1>' }] }, AT);
  ok('准备：合成自产台发布成功', pub.status === 201, `status=${pub.status}`);
  const s = await call('POST', '/api/mcp/sessions', { name: 'files-name' }, AT);
  await call('PUT', `/api/mcp/sessions/${s.body.id}/grants`, { grants: ['app_files_upload', 'app_files_list'] }, AT);
  const token = s.body.token;
  const up = (name) => tool(token, 'app_files_upload', { slug: 'name-app', name, content_base64: Buffer.from('合成内容').toString('base64') });
  const listed = async () => ((await tool(token, 'app_files_list', { slug: 'name-app', limit: 100 })).payload?.items ?? []).map((f) => f.original_name);

  console.log('一、UTF-8 名字原样存');
  for (const name of ['合成.csv', '交付.csv', '📄报告.txt', 'Ã¤.txt', 'report.txt', '名字 带 空格.md']) {
    const r = await up(name);
    ok(`「${name}」：存下、应答里的名字一样`, !r.isError && r.payload?.name === name, r.text.slice(0, 160));
  }
  const names = await listed();
  ok('文件面列表里每个名字都和传的一样（没有被当 latin1 修成控制字符）', ['合成.csv', '交付.csv', '📄报告.txt', 'Ã¤.txt', 'report.txt', '名字 带 空格.md'].every((n) => names.includes(n)) && !names.some((n) => /[\x00-\x1f]/.test(n)), J(names));

  console.log('二、不合法的名字拒收、不保存');
  const before = (await listed()).length;
  for (const name of ['../x.txt', 'a/b.txt', 'a\\b.txt', 'x\u0001.txt', 'x\n.txt', '.', '..', 'x'.repeat(256)]) {
    const r = await up(name);
    ok(`${J(name.length > 40 ? name.slice(0, 12) + '…(' + name.length + ')' : name)}：拒收`, r.isError && /文件名不合法/.test(r.text), r.text.slice(0, 120));
  }
  ok('上面这些一个都没进文件面', (await listed()).length === before);

  console.log('三、DEL 和方向控制符：三个入口（base64、上传票、REST 原始字节）都拒收');
  // U+202E 能把「txt.exe」显示成「exe.txt」那类倒序；DEL 和 C0 一样是控制字符
  const sneaky = ['x\u007f.txt', 'x‮.txt', 'x‪.txt', 'x⁦.txt', 'x⁩.txt', 'x‎.txt', 'x‏.txt', 'x؜.txt'];
  const bytes = Buffer.from('合成内容');
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  for (const name of sneaky) {
    const label = J(name).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const b64 = await up(name);
    ok(`${label} base64：拒收`, b64.isError && /文件名不合法/.test(b64.text), b64.text.slice(0, 120));
    const ticket = await tool(token, 'app_files_upload', { slug: 'name-app', name, size: bytes.length, sha256: sha });
    ok(`${label} 申请上传票：拒收，不发票`, ticket.isError && /文件名不合法/.test(ticket.text), ticket.text.slice(0, 120));
    const r = await fetch(`${BASE}/api/mcp-rest/apps/name-app/files/${encodeURIComponent(name)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: bytes });
    const t = await r.text();
    ok(`${label} REST 原始字节：400`, r.status === 400 && /文件名不合法/.test(t), `status=${r.status} ${t.slice(0, 120)}`);
  }
  ok('三里的名字一个都没进文件面', (await listed()).length === before);
  const fine = await up('普通‐连字符 «引号».txt');
  ok('不是方向控制符的 Unicode 标点照样能存', !fine.isError, fine.text.slice(0, 80));
  const edge = await up('x'.repeat(255));
  ok('正好 255 个字符：可以', !edge.isError && edge.payload?.name === 'x'.repeat(255), edge.text.slice(0, 80));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  child.kill();
  await new Promise((x) => setTimeout(x, 400));
  await gh.close?.();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`mcp-app-files-name-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
