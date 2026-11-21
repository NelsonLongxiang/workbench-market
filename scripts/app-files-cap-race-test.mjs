#!/usr/bin/env node
/** 自产台文件数上限的「排到了再核一次」（server/src/index.ts 的 appFileStoreCore）在缺省的 main 模式下有人守：
 *  上限 3、已有 2 个附件，三笔上传抢最后一个名额——两笔浏览器 multipart（POST /api/apps/:slug/files）、一笔 MCP REST 原始字节（PUT /api/mcp-rest/apps/:slug/files/:name）。
 *  三笔都先只发请求头和半个请求体：入口那道「收文件之前查一次」此刻都过了（还没有一笔应答回来），再一起发完。
 *  期望只进一笔（201），另两笔 413；库里正好 3 个附件；磁盘上只多一个文件。拿掉排到了再核的那一道，三笔都会进来——这一例会红。
 *  自起实例、空数据目录、合成数据、只听回环；不设 WM_APP_DATA_STORE（缺省 main）。 */
import { spawn } from './owned-script-fixture.mjs';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
mkdirSync('tmp', { recursive: true });
const data = mkdtempSync(resolve('tmp/app-files-cap-race-'));
const ADMIN = 'synthetic-cap-race-admin';
const env = { ...process.env, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, HOME: data, ADMIN_TOKEN: ADMIN, MCP_GATEWAY: 'on', NODE_ENV: 'test', REDIS_URL: '', WM_APP_FILES_MAX: '3' };
delete env.WM_APP_DATA_STORE;
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', stdio: ['ignore', 'ignore', 'pipe'], env });
let log = ''; child.stderr.on('data', (d) => { log += d; });
const B = `http://127.0.0.1:${port}`, AT = { 'X-Admin-Token': ADMIN, 'content-type': 'application/json' };
const j = async (r) => { try { return await r.json(); } catch { return null; } };
const SLUG = 'syn-cap-race';
const txtFiles = () => (existsSync(join(data, 'uploads')) ? readdirSync(join(data, 'uploads'), { recursive: true }).filter((f) => /\.txt$/.test(String(f))).length : 0);

/** 发一笔请求：先写请求头和 head，等 release() 再写 tail 收尾；返回 { done: Promise<status>, answered() } */
function staged(method, path, headers, head, tail) {
  let status = null, release;
  const go = new Promise((r) => { release = r; });
  const done = new Promise((res) => {
    const req = request(`${B}${path}`, { method, headers: { ...headers, 'content-length': String(Buffer.byteLength(head) + Buffer.byteLength(tail)) } }, (r) => { status = r.statusCode; r.resume(); r.on('end', () => res(status)); });
    req.on('error', (e) => res(`error:${e.message}`));
    req.write(head);
    go.then(() => req.end(tail));
  });
  return { done, release: () => release(), answered: () => status !== null };
}
function multipart(name, text) {
  const boundary = `----syn${Math.random().toString(16).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${text.slice(0, 4)}`;
  const tail = `${text.slice(4)}\r\n--${boundary}--\r\n`;
  return staged('POST', `/api/apps/${SLUG}/files`, { 'content-type': `multipart/form-data; boundary=${boundary}` }, head, tail);
}

try {
  let up = false;
  for (let i = 0; i < 160 && !up && child.exitCode === null; i++) { try { up = (await fetch(B + '/api/health')).ok; } catch { /* 还没起来 */ } if (!up) await sleep(250); }
  if (!up) throw new Error(`实例没起来：${log.trim().split('\n').slice(-3).join(' | ')}`);
  ok('实例就绪（缺省 main 模式，上限 3）', up);

  // 合成的台，已有 2 个附件：只剩最后一个名额
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
  try {
    db.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run(SLUG, '合成·快满的台');
    db.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run('合成·快满的台', `/apps/${SLUG}/`);
    for (const n of [1, 2]) db.prepare("INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by) VALUES (?, ?, 'text/plain', 1, ?, 'seed')").run(SLUG, `seed${n}.txt`, `uploads/seed/seed${n}.txt`);
  } finally { db.close(); }
  const rows = () => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 }); try { return Number(d.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = ? AND deleted_at = ''").get(SLUG).n); } finally { d.close(); } };
  ok('（前提）这个台已有 2 个附件', rows() === 2, rows());

  // MCP 会话：只授上传
  const s = await j(await fetch(B + '/api/mcp/sessions', { method: 'POST', headers: AT, body: JSON.stringify({ name: 'cap-race' }) }));
  await fetch(`${B}/api/mcp/sessions/${s?.id}/grants`, { method: 'PUT', headers: AT, body: JSON.stringify({ grants: ['app_files_upload'] }) });
  ok('（前提）有 MCP 会话令牌', typeof s?.token === 'string' && s.token.length > 0, s);

  const before = txtFiles();
  const raw = '合成·原始字节那一笔';
  const contenders = [
    multipart('race-a.txt', '合成·浏览器上传甲'),
    multipart('race-b.txt', '合成·浏览器上传乙'),
    staged('PUT', `/api/mcp-rest/apps/${SLUG}/files/race-c.txt`, { Authorization: `Bearer ${s?.token}`, 'content-type': 'text/plain' }, raw.slice(0, 3), raw.slice(3)),
  ];
  // 等三笔都过了入口那道：入口满了会立刻回 413；这时一笔应答都没有，说明三笔都在收请求体
  await sleep(800);
  ok('（前提）半个请求体发出去以后三笔都还没应答：入口那道都过了', contenders.every((c) => !c.answered()), contenders.map((c) => c.answered()));
  for (const c of contenders) c.release();
  const statuses = await Promise.all(contenders.map((c) => c.done));
  const sorted = [...statuses].map(String).sort().join(',');
  ok('三笔抢最后一个名额：只进一笔，另两笔 413', sorted === '201,413,413', statuses);
  ok('库里正好 3 个附件（没超上限）', rows() === 3, rows());
  ok('磁盘上只多一个文件（被拒的两笔不留文件）', txtFiles() === before + 1, { before, after: txtFiles() });
  const again = await fetch(`${B}/api/apps/${SLUG}/files`, { method: 'POST', body: (() => { const fd = new FormData(); fd.append('file', new Blob(['合成·满了以后'], { type: 'text/plain' }), 'late.txt'); return fd; })() });
  ok('满了以后再传：入口就回 413', again.status === 413, again.status);
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  if (child.exitCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill('SIGTERM'); await Promise.race([exited, sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(data, { recursive: true, force: true });
}
console.log(`app-files-cap-race-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
