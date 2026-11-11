#!/usr/bin/env node
/**
 * 设置的读按角色给（对抗组，回补到发布分支）：GET /api/settings、掩码导出、改设置的应答。真实的 server/src/index.ts，
 * Odoo 是本机的替身（session_id 前缀决定身份：adminsession 管理员、internalsession 内部员工 beta），只在 127.0.0.1 上，不访问任何外部系统。
 * 设置表里埋金丝雀（凭据类的值、内网地址、上游 headers），逐条看应答正文和服务端日志里有没有它。
 *
 *   别人（远程匿名、登录的非管理员 beta、口令错的、带有效口令的跨站，登录门开着时的 beta）：只给巡检参数和开关；
 *   管理员（口令、Odoo 管理员同源）：全部设置，凭据类的值只给 ****，上游 headers 掩掉；
 *   掩码导出、带 reveal 的导出、改设置的应答：都不带凭据类的值；服务端日志里没有任何一个凭据类的值。
 *
 *   node scripts/settings-read-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ADMIN_TOKEN = 'synthetic-settings-read-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.43' };
const SECRETS = ['CANARY-LAYERFS-TOKEN-81', 'CANARY-SANDBOX-TOKEN-82', 'CANARY-VENDOR-KEY-83', 'CANARY-UPSTREAM-HEADER-84'];
const ADDRESSES = ['canary-layerfs.invalid', 'canary-peer.invalid', 'canary-upstream.invalid'];
const PUBLIC = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'dispatch_sorting_enabled', 'run_upload_require_token', 'patrol_armed_at'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const leaksSecret = (t) => SECRETS.some((x) => t.includes(x));
const leaksAddress = (t) => ADDRESSES.some((x) => t.includes(x));

// Odoo 替身：session_id 前缀决定身份；其余路径 404
const odoo = createServer((req, res) => {
  const sid = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
  if (req.url === '/web/session/get_session_info') {
    const admin = sid.startsWith('adminsession'), internal = admin || sid.startsWith('internalsession');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(internal ? { result: { uid: admin ? 2 : 7, username: admin ? 'settings.admin' : 'beta', name: 'Synthetic', is_internal_user: true, is_admin: admin } } : { result: { uid: false } }));
  }
  res.statusCode = 404; res.end('odoo-fixture-404');
});
await new Promise((r) => odoo.listen(0, '127.0.0.1', r));
const ODOO = `http://127.0.0.1:${odoo.address().port}`;
const ADMIN_SID = 'adminsession-synthetic-0001', BETA_SID = 'internalsession-synthetic-beta';

async function freePort() {
  const probe = createNetServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

mkdirSync(resolve('tmp'), { recursive: true });
const running = [];
async function boot(tag, extra = {}) {
  const port = await freePort();
  const data = mkdtempSync(resolve('tmp', `settings-read-${tag}-`));
  const env = { ...process.env, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '', MCP_GATEWAY: 'off', ADMIN_TOKEN, WM_ODOO_URL: ODOO, WM_ODOO_ORIGINS: ODOO, ...extra };
  let child, out = '';
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
    const end = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < end && child.exitCode === null) {
      try { ready = (await fetch(base + '/api/health')).status === 200; } catch { /* 未起 */ }
      if (!ready) await sleep(200);
    }
    if (!ready) throw new Error(`实例 ${tag} 没起来：${out.trim().split('\n').slice(-4).join(' | ')}`);
  };
  const halt = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  await start();
  // 埋金丝雀，重起一次（带着它们走一遍启动）
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
  await halt();
  await start();
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: r.status, text, json };
  };
  const stop = async () => { await halt(); rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
  const srv = { base, host: new URL(base).host, call, stop, log: () => out };
  running.push(srv);
  return srv;
}

const onlyPublic = (r) => r.status === 200 && !leaksSecret(r.text) && !leaksAddress(r.text) && Object.keys(r.json ?? {}).every((k) => PUBLIC.includes(k));

try {
  // ---------- 一、登录门关着 ----------
  {
    const srv = await boot('off');
    const same = { origin: srv.base, 'sec-fetch-site': 'same-origin' };
    const who = {
      anonymous: await srv.call('GET', '/api/settings', { headers: REMOTE }),
      beta: await srv.call('GET', '/api/settings', { headers: { ...REMOTE, ...same }, session: BETA_SID }),
      wrongToken: await srv.call('GET', '/api/settings', { headers: { ...REMOTE, 'x-admin-token': 'wrong' } }),
      crossSite: await srv.call('GET', '/api/settings', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' } }),
    };
    const bad = Object.entries(who).filter(([, r]) => !onlyPublic(r)).map(([k, r]) => [k, r.status, Object.keys(r.json ?? {})]);
    check(bad.length === 0 && who.beta.json?.run_upload_require_token === '1',
      '别人（远程匿名、登录的非管理员 beta、口令错的、带有效口令的跨站）读设置：只有巡检参数和开关，凭据、内网地址、上游都没有', show(bad));
    const admin = await srv.call('GET', '/api/settings', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    const odooAdmin = await srv.call('GET', '/api/settings', { headers: { ...REMOTE, ...same }, session: ADMIN_SID });
    const j = admin.json ?? {};
    const up = JSON.parse(j.mcp_upstreams || '[]')[0] ?? {};
    check(admin.status === 200 && !leaksSecret(admin.text) && j.layerfs_service_token === '****' && j.sandbox_bridge_token === '****' && j.some_vendor_api_key === '****'
      && j.layerfs_service_url === 'http://canary-layerfs.invalid:9000' && up.headers?.Authorization === '****' && !('admin_token_sha256' in j)
      && odooAdmin.status === 200 && !leaksSecret(odooAdmin.text) && odooAdmin.json?.layerfs_service_url,
      '管理员（口令、Odoo 管理员同源）看全部设置：凭据类的值只给 ****，上游 headers 掩掉，没有口令哈希', show({ keys: Object.keys(j), odoo: odooAdmin.status }));
    const masked = await srv.call('GET', '/api/export', { headers: REMOTE });
    const reveal = await srv.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    const put = await srv.call('PUT', '/api/settings', { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { health_concurrency: 3 } });
    check(masked.status === 200 && !leaksSecret(masked.text) && reveal.status === 200 && !leaksSecret(reveal.text) && put.status === 200 && !leaksSecret(put.text),
      '掩码导出（匿名可拿）、reveal 导出、改设置的应答：都不带凭据类的值', show({ masked: masked.status, reveal: reveal.status, put: put.status }));
    check(!leaksSecret(srv.log()), '登录门关着：整个过程服务端的日志里没有任何一个凭据类的值', SECRETS.filter((x) => srv.log().includes(x)).join('、'));
    await srv.stop();
  }
  // ---------- 二、登录门开着：登录的非管理员 beta ----------
  {
    const srv = await boot('on', { WM_LOGIN_GATE: 'enforce' });
    const same = { origin: srv.base, 'sec-fetch-site': 'same-origin' };
    const beta = await srv.call('GET', '/api/settings', { headers: { ...REMOTE, ...same }, session: BETA_SID });
    const anon = await srv.call('GET', '/api/settings', { headers: REMOTE });
    const admin = await srv.call('GET', '/api/settings', { headers: { ...REMOTE, ...same }, session: ADMIN_SID });
    check(onlyPublic(beta) && anon.status === 401 && !leaksSecret(anon.text) && admin.status === 200 && admin.json?.layerfs_service_token === '****',
      '登录门开着：登录的非管理员 beta 读设置只有巡检参数和开关；远程匿名被登录门先拦 401；Odoo 管理员看全部（凭据只给 ****）', show({ beta: beta.status, betaKeys: Object.keys(beta.json ?? {}), anon: anon.status, admin: admin.status }));
    check(!leaksSecret(srv.log()), '登录门开着：服务端的日志里没有任何一个凭据类的值');
    await srv.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop().catch(() => {});
  await new Promise((r) => odoo.close(r));
}
console.log(`settings-read-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
