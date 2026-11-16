#!/usr/bin/env node
/**
 * 统一绑定表的启动迁移只补不改（server/src/db.ts）：旧的 sop_bindings、app_bindings 每次启动平移进 bindings，
 * 只插 bindings 里还没有的自然键（台型、台、节点、方向）；已有的行一律不碰，id 不变。
 * 隔离实例（NODE_ENV=test），同一个数据目录起三次：
 *   一、首启建表；停下后往旧表里放三行（SOP 两行、应用一行），再起：三行都平移进来
 *   二、经统一表撤销一行、改一行的 mode 和 notify_url；停下，旧表再加一个新的自然键，再起：
 *       撤销的仍是撤销、id 不变；改过的 mode、notify_url 保持、id 不变；应用那一行 id 不变；新的自然键补进来
 *
 *   node scripts/bindings-migrate-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `bindings-migrate-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-bindings-migrate';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
let child = null, log = '', base = '';

async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}
const call = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const withDb = (fn) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 10_000 }); try { return fn(d); } finally { d.close(); } };
const rows = (type, slug) => withDb((d) => d.prepare('SELECT id, agent_node, direction, mode, notify_url, revoked_at FROM bindings WHERE target_type = ? AND target_slug = ? ORDER BY agent_node').all(type, slug).map((r) => ({ ...r })));
const byNode = (list, node) => list.find((r) => r.agent_node === node);

rmSync(OUT, { recursive: true, force: true });
for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
try {
  // ---------- 一 ----------
  await start(); await stop();
  withDb((d) => {
    d.prepare("INSERT INTO apps (slug, title, kind, status) VALUES ('syn-sop', 'syn-sop', 'sop', 'published')").run();
    d.prepare("INSERT INTO sop_bindings (sop_slug, node, mode, remote_api_key, callback_url, created_by) VALUES ('syn-sop', 'dsh/aaaaaaaa', 'read', 'k-a', 'http://a.example', 'legacy')").run();
    d.prepare("INSERT INTO sop_bindings (sop_slug, node, mode, remote_api_key, callback_url, created_by) VALUES ('syn-sop', 'dsh/cccccccc', 'read', 'k-c', 'http://c-old.example', 'legacy')").run();
    d.prepare("INSERT INTO app_bindings (app_slug, node, base_url, created_by) VALUES ('syn-app', 'dsh/bbbbbbbb', 'http://b.example', 'legacy')").run();
  });
  await start();
  const sop1 = rows('sop', 'syn-sop'), app1 = rows('app', 'syn-app');
  const a1 = byNode(sop1, 'dsh/aaaaaaaa'), c1 = byNode(sop1, 'dsh/cccccccc'), b1 = byNode(app1, 'dsh/bbbbbbbb');
  check(!!a1 && !!c1 && !!b1 && a1.direction === 'admits' && a1.revoked_at === '' && c1.notify_url === 'http://c-old.example' && b1.direction === 'notify',
    '一、旧表三行（SOP 两行、应用一行）启动时平移进统一表', { sop1, app1 });

  // ---------- 二 ----------
  const rev = await call('DELETE', `/api/bindings/${a1?.id}`);
  const mod = await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'syn-sop', agent_node: 'dsh/cccccccc', direction: 'admits', mode: 'run', notify_url: 'http://c-new.example' });
  const before = rows('sop', 'syn-sop');
  const a2 = byNode(before, 'dsh/aaaaaaaa'), c2 = byNode(before, 'dsh/cccccccc');
  check(rev.status === 200 && a2?.revoked_at !== '' && mod.status === 201 && mod.json?.upserted === true && c2?.mode === 'run' && c2.notify_url === 'http://c-new.example',
    '二（准备）经统一表撤销 aaaaaaaa，把 cccccccc 改成 run、新的 notify_url', { rev: rev.status, mod: [mod.status, mod.json?.upserted], a2, c2 });
  await stop();
  withDb((d) => d.prepare("INSERT INTO sop_bindings (sop_slug, node, mode, remote_api_key, callback_url, created_by) VALUES ('syn-sop', 'dsh/dddddddd', 'run', 'k-d', 'http://d.example', 'legacy')").run());
  await start();
  const after = rows('sop', 'syn-sop'), appAfter = rows('app', 'syn-app');
  const a3 = byNode(after, 'dsh/aaaaaaaa'), c3 = byNode(after, 'dsh/cccccccc'), d3 = byNode(after, 'dsh/dddddddd'), b3 = byNode(appAfter, 'dsh/bbbbbbbb');
  check(!!a3 && a3.id === a1.id && a3.revoked_at !== '' && a3.revoked_at === a2.revoked_at,
    '二a 经统一表撤销的那一行，重启后仍是撤销状态，id 不变', { before: a2, after: a3 });
  check(!!c3 && c3.id === c1.id && c3.mode === 'run' && c3.notify_url === 'http://c-new.example',
    '二b 改过 mode、notify_url 的那一行，重启后值保持，id 不变', { before: c2, after: c3 });
  check(!!b3 && b3.id === b1.id, '二c 应用那一行重启后 id 不变', { before: b1, after: b3 });
  check(!!d3 && d3.mode === 'run' && d3.notify_url === 'http://d.example' && d3.revoked_at === '' && after.length === 3,
    '二d 旧表里新加的自然键，重启时补进统一表（只补这一行）', { after });
  // 接口看到的也是同一个结果：撤销的那一行不再算生效
  const listed = await call('GET', '/api/bindings?type=sop&slug=syn-sop');
  const la = (listed.json ?? []).find((r) => r.agent_node === 'dsh/aaaaaaaa');
  check(listed.status === 200 && !!la && la.revoked_at !== '' && (await call('DELETE', `/api/bindings/${a1.id}`)).status === 404,
    '二e 接口列出的也是撤销状态；再撤销一次 404（不是生效中的绑定）', { la });
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  await stop();
  await sleep(300);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`bindings-migrate-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
