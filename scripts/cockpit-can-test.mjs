#!/usr/bin/env node
/**
 * 驾驶舱读应答里的 can.edit（页面照它显示改名、加面板、删除这些编辑入口）。
 * 起隔离实例（假的登录提供方，NODE_ENV=test；合成口令）。can.edit 就是写请求总门对这个请求的判断，所以逐个身份核两件事：
 *   一、读清单、读单个，can.edit 是多少：本机命令行、有效口令（远程、同源浏览器）、身份来源认的管理员 → true；
 *       远程匿名、口令不对、普通员工、带对的口令但浏览器从别的站点来 → false
 *   二、同一个身份真的去改一下（PUT 改名）：过得了门的就是 can.edit 为 true 的那几个，一个不多一个不少
 *   三、读不存在的驾驶舱照旧 404（处理函数改成异步之后，出错照样交给错误中间件）
 *
 *   node scripts/cockpit-can-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'tmp', `cockpit-can-${process.pid}-${Date.now().toString(36)}`);
const TOKEN = 'synthetic-cockpit-can-admin';
let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
for (const d of ['data', 'home', 'ext']) mkdirSync(join(OUT, d), { recursive: true });
const env = {};
for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
Object.assign(env, { HOME: join(OUT, 'home'), PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: join(OUT, 'data'), NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext') });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const exited = () => child.exitCode !== null || child.signalCode !== null;
try {
  const end = Date.now() + 40000;
  for (;;) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* 还没起来 */ } if (Date.now() > end || exited()) throw new Error(`实例没起来：${log.slice(-400)}`); await new Promise((r) => setTimeout(r, 200)); }
  const call = async (method, path, headers = {}, body) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, json };
  };
  const made = await call('POST', '/api/cockpits', {}, { name: '合成·权限舱' });
  const id = made.json?.id;
  check(made.status === 201 && Number.isInteger(id), '（准备）本机命令行建一个驾驶舱', made);
  // 让假提供方认出的人进主体表
  for (const s of [SESSIONS.admin, SESSIONS.alpha]) await call('GET', '/api/auth/viewer', { cookie: `session_id=${s}` });

  const REMOTE = { 'x-forwarded-for': '198.51.100.7' };
  const SAME = { origin: base, 'sec-fetch-site': 'same-origin' };
  const who = [
    ['本机命令行', {}, true],
    ['远程、有效口令', { ...REMOTE, 'x-admin-token': TOKEN }, true],
    ['同源浏览器、有效口令', { ...SAME, 'x-admin-token': TOKEN }, true],
    ['远程同源浏览器、身份来源认的管理员（没有口令）', { ...REMOTE, ...SAME, cookie: `session_id=${SESSIONS.admin}` }, true],
    ['远程匿名', REMOTE, false],
    ['远程、口令不对', { ...REMOTE, 'x-admin-token': 'not-the-token' }, false],
    ['远程同源浏览器、普通员工', { ...REMOTE, ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, false],
    ['浏览器从别的站点来、带着对的口令', { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site', 'x-admin-token': TOKEN }, false],
    ['本机但带浏览器标记、没有口令', SAME, false],
  ];

  console.log('一、读的应答里的 can.edit');
  for (const [name, h, want] of who) {
    const list = await call('GET', '/api/cockpits', h);
    const one = await call('GET', `/api/cockpits/${id}`, h);
    const inList = Array.isArray(list.json) ? list.json.find((c) => c.id === id) : null;
    check(list.status === 200 && one.status === 200 && inList?.can?.edit === want && one.json?.can?.edit === want && Object.keys(one.json.can).join() === 'edit',
      `${name}：清单和单个都读得到，can.edit 是 ${want}`, { list: list.status, one: one.status, inList: inList?.can, single: one.json?.can });
  }

  console.log('二、能不能改，和 can.edit 说的一样');
  const mismatch = [];
  for (const [name, h, want] of who) {
    const r = await call('PUT', `/api/cockpits/${id}`, h, { name: `合成·${name}` });
    if ((r.status === 200) !== want) mismatch.push({ name, status: r.status, want });
  }
  check(mismatch.length === 0, '每个身份：PUT 改名过得了门的，正好是 can.edit 为 true 的那几个', mismatch);

  console.log('三、出错照旧');
  const missing = await call('GET', '/api/cockpits/999999');
  check(missing.status === 404, '读不存在的驾驶舱：404', missing);
  const bad = await call('GET', '/api/cockpits/abc');
  check(bad.status === 404, '编号不是数字：404', bad);
  check(!exited(), '实例还活着（异步处理函数出错没有掀翻进程）');
} catch (e) {
  fail++; console.log(`  ✗ ${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  if (!exited()) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  if (!exited()) child.kill('SIGKILL');
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* 删不掉只是留个临时目录 */ }
}
console.log(`cockpit-can-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
