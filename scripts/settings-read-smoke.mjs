#!/usr/bin/env node
/**
 * 设置的读（对抗组）：设置表里埋金丝雀（凭据类的值、内网地址、上游 headers），看各种身份从各个出口拿到什么。
 *   · 别人（远程匿名、登录的员工、口令错的、带有效口令的跨站）：只拿到白名单（巡检参数、巡检状态和开关），内网地址和凭据都没有；
 *   · 管理员（口令、同源）：全部设置，凭据类的值只说有没有（****），上游 headers 的值掩掉，管理口令哈希没有；
 *   · 导出（掩码的匿名可拿、带 reveal 的只给管理员）和改设置的应答：凭据类的值都不出。
 * 只在本机起隔离实例，身份来源是合成的（identity-fake-preload），不访问任何外部系统。
 *   node scripts/settings-read-smoke.mjs              测本仓库
 *   node scripts/settings-read-smoke.mjs --root DIR   测另一棵目录树
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `settings-read-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-settings-read-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.97' };
const SECRETS = ['CANARY-LAYERFS-TOKEN-71', 'CANARY-SANDBOX-TOKEN-72', 'CANARY-OTHER-SECRET-73', 'CANARY-UPSTREAM-HEADER-74'];
const ADDRESSES = ['canary-layerfs.invalid', 'canary-peer.invalid', 'canary-upstream.invalid'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

let child = null;
try {
  const port = await freePort();
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error('隔离实例没起来');
  const call = async (method, path, headers = {}, body) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };

  // 埋金丝雀：凭据类的值、内网地址、上游的 headers
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      put.run('layerfs_service_token', SECRETS[0]);
      put.run('sandbox_bridge_token', SECRETS[1]);
      put.run('some_vendor_api_key', SECRETS[2]);
      put.run('layerfs_service_url', 'http://canary-layerfs.invalid:9000');
      put.run('a2a_peers', JSON.stringify([{ node: 'peer', url: 'http://canary-peer.invalid' }]));
      put.run('mcp_upstreams', JSON.stringify([{ prefix: 'up', url: 'http://canary-upstream.invalid/mcp', headers: { Authorization: `Bearer ${SECRETS[3]}` } }]));
      put.run('run_upload_require_token', '1');
    } finally { db.close(); }
  }
  const leaksSecret = (t) => SECRETS.some((x) => t.includes(x));
  const leaksAddress = (t) => ADDRESSES.some((x) => t.includes(x));

  // ---------- 一、别人只拿到白名单 ----------
  {
    const who = {
      anonymous: await call('GET', '/api/settings', REMOTE),
      staff: await call('GET', '/api/settings', { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` }),
      wrongToken: await call('GET', '/api/settings', { ...REMOTE, 'x-admin-token': 'wrong' }),
      crossSite: await call('GET', '/api/settings', { ...REMOTE, 'x-admin-token': ADMIN_TOKEN, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }),
    };
    const bad = Object.entries(who).filter(([, r]) => r.status !== 200 || leaksSecret(r.text) || leaksAddress(r.text) || Object.keys(r.json ?? {}).some((k) => !['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'dispatch_sorting_enabled', 'run_upload_require_token', 'patrol_armed_at'].includes(k)));
    check(bad.length === 0 && who.staff.json?.run_upload_require_token === '1' && 'health_interval_seconds' in (who.staff.json ?? {}),
      '别人（远程匿名、登录的员工、口令错的、带有效口令的跨站）读设置：只有巡检参数和开关；凭据、内网地址、上游一样都没有', show(bad.map(([k, r]) => [k, r.status, Object.keys(r.json ?? {})])));
  }
  // ---------- 二、管理员看全部，凭据类的值只说有没有 ----------
  {
    const admin = await call('GET', '/api/settings', { ...REMOTE, 'x-admin-token': ADMIN_TOKEN });
    const odooAdmin = await call('GET', '/api/settings', { ...REMOTE, cookie: `session_id=${SESSIONS.admin}` });
    const j = admin.json ?? {};
    const up = JSON.parse(j.mcp_upstreams || '[]')[0] ?? {};
    check(admin.status === 200 && !leaksSecret(admin.text) && j.layerfs_service_token === '****' && j.sandbox_bridge_token === '****' && j.some_vendor_api_key === '****'
      && j.layerfs_service_url === 'http://canary-layerfs.invalid:9000' && up.url === 'http://canary-upstream.invalid/mcp' && up.headers?.Authorization === '****' && j.run_upload_require_token === '1'
      && !('admin_token_sha256' in j) && odooAdmin.status === 200 && !leaksSecret(odooAdmin.text) && odooAdmin.json?.layerfs_service_url,
      '管理员（口令、身份来源的管理员）看全部设置：凭据类的值只给 ****，上游 headers 掩掉，开关照常；管理口令哈希没有', show({ keys: Object.keys(j) }));
  }
  // ---------- 三、导出和改设置的应答：凭据都不出 ----------
  {
    const masked = await call('GET', '/api/export', REMOTE);
    const reveal = await call('GET', '/api/export?reveal=1', { ...REMOTE, 'x-admin-token': ADMIN_TOKEN });
    const put = await call('PUT', '/api/settings', { 'x-admin-token': ADMIN_TOKEN }, { health_concurrency: 3 });
    check(masked.status === 200 && !leaksSecret(masked.text) && reveal.status === 200 && !leaksSecret(reveal.text) && put.status === 200 && !leaksSecret(put.text) && put.json?.health_concurrency === '3',
      '导出（匿名的掩码导出、管理员的 reveal 导出）和改设置的应答：凭据类的值都不出', show({ masked: masked.status, reveal: reveal.status, put: put.status }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await sleep(500); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`settings-read-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
