#!/usr/bin/env node
/**
 * Odoo 下线后的旧环境变量（server/src/retired-env.ts）：还设着时启动只告警、忽略，不拒绝启动。隔离实例（NODE_ENV=test）起两次：
 *   一、一个都没设：没有任何「已下线」告警
 *   二、9 个旧变量全设上，再加内容查看面的端口 WM_CONTENT_PORT：实例照常起来；每个旧变量各一行 ignored-env（点名、不重不漏），
 *       内容面一行 content-surface-disabled；内容面端口没有人监听
 *
 *   node scripts/retired-env-test.mjs
 */
import { createServer, connect } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `retired-env-${process.pid}-${Date.now().toString(36)}`);
const RETIRED = ['WM_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_ODOO_BROWSER_URL', 'WM_ODOO_LOGIN_PROXY', 'WM_CONTENT_ODOO_ORIGIN', 'LC_ODOO_URL', 'WM_CONTENT_IP', 'WM_CONTENT_MARKET_ORIGIN', 'WM_CONTENT_TARGETS'];

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }
const listening = (port) => new Promise((r) => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });

let child = null;
async function run(name, extra) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = join(OUT, name);
  for (const d of ['data', 'home', 'ext']) mkdirSync(join(dir, d), { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: join(dir, 'home'), PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: join(dir, 'data'), NODE_ENV: 'test', REDIS_URL: '', WM_EXTENSIONS_DIR: join(dir, 'ext'), MARKET_PUBLIC_URL: base, ...extra });
  let log = '';
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  await sleep(300); // 告警在启动收尾时打，等它落进日志
  const lines = log.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j?.source === 'odoo-offboarded');
  return { ready, lines, log };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}

rmSync(OUT, { recursive: true, force: true });
try {
  console.log('一、一个都没设');
  const none = await run('none', {});
  check(none.ready && none.lines.length === 0, '照常起来，没有「已下线」告警', { ready: none.ready, lines: none.lines });
  await stop();

  console.log('二、全设上');
  const contentPort = await freePort();
  const all = { WM_CONTENT_PORT: String(contentPort) };
  for (const k of RETIRED) all[k] = k === 'WM_CONTENT_TARGETS' ? 'synthetic-target' : k.endsWith('ORIGINS') || k.endsWith('ORIGIN') || k.endsWith('URL') || k.endsWith('PROXY') ? 'http://synthetic.invalid' : '192.0.2.1';
  const r = await run('all', all);
  const named = r.lines.filter((l) => l.event === 'ignored-env').map((l) => l.name).sort();
  check(r.ready, '9 个旧变量和内容面端口都设着：实例照常起来，不拒绝启动', r.log.split('\n').slice(-5).join(' | '));
  check(JSON.stringify(named) === JSON.stringify([...RETIRED].sort()), '每个旧变量各告警一行「已下线、忽略」，点名、不重不漏', named);
  check(r.lines.filter((l) => l.event === 'content-surface-disabled').length === 1, '内容查看面告警一行：不启动', r.lines);
  check(!(await listening(contentPort)), '内容面端口没有人监听', contentPort);
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  await stop();
  await sleep(300);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`retired-env-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
