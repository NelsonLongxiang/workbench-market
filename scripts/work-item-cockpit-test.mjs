#!/usr/bin/env node
/**
 * 事项记「从哪个驾驶舱安排的」，列表按驾驶舱筛。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   「安排一件事」带 cockpit_id：记在事件日志 recorded 那一行，事项从那里取；不带的是 null
 *   cockpit_id 形状不对 400 cockpit_id_invalid；驾驶舱不存在 400 cockpit_not_found
 *   幂等：同一个键、换了驾驶舱 409；没带驾驶舱的请求哈希和以前一样（同键同内容重放 200）
 *   列表 ?cockpit=<id>：只在当前视角里收窄（别人建的、同一个驾驶舱的事项，建立人仍看不到）；不存在的驾驶舱回空列表；形状不对才 400
 *   驾驶舱删了之后：事项上的 cockpit_id 照旧返回，按它筛照旧筛得出来
 *   详情、列表每行、「关注」里和事项挂钩的条目都带 cockpit_id
 *   旧库：开库时补上这一列，存量是 null；再开一次不重复补
 *
 *   node scripts/work-item-cockpit-test.mjs              测本仓库
 *   node scripts/work-item-cockpit-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-cockpit-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'cockpit-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
let keyN = 0;
const key = () => `cockpit-key-${String(++keyN).padStart(8, '0')}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  // ---------- 旧库：没有这一列的事项表，开库时补上，存量是 null ----------
  {
    const dir = join(OUT, 'old');
    mkdirSync(dir, { recursive: true });
    const first = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      db.exec('DROP INDEX IF EXISTS idx_work_items_cockpit');
      db.exec('ALTER TABLE work_items DROP COLUMN cockpit_id');
      db.prepare("INSERT INTO work_items (id, title, created_by, creator_principal, source_kind) VALUES ('wi_old', '存量', 'user:a', 'user:a', 'agent')").run();
      console.log('OK');`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
    const reopen = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      console.log('ROW ' + JSON.stringify(db.prepare("SELECT cockpit_id FROM work_items WHERE id = 'wi_old'").get()));`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
    const a = reopen(), b = reopen();
    const row = (r) => /ROW (.*)/.exec(r.stdout)?.[1];
    check(first.stdout.includes('OK') && row(a) === show({ cockpit_id: null }) && row(b) === row(a) && b.status === 0, '旧库开库时补上这一列，存量是 null（不回填）；再开一次不重复补', show({ first: first.stderr.slice(-200), a: row(a), err: b.stderr.slice(-200) }));
  }

  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
    db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', 'dsh/canvas/team-a', 'notify', 'read', 'http://127.0.0.1:1', 'seed')").run();
    console.log('SEEDED');`], { env, encoding: 'utf8' });
  if (!seed.stdout.includes('SEEDED')) throw new Error(`造数据失败：${seed.stderr.slice(-600)}`);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, BETA = { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  await call('GET', '/api/work-items/teams', ALPHA); await call('GET', '/api/work-items/teams', BETA);
  await call('PUT', '/api/settings', ADMIN, { arrange_rate_per_minute: '100' }); // 一个人要建好多件；限流不在这里测
  const mkc = async (name) => (await call('POST', '/api/cockpits', ADMIN, { name })).body?.id;
  const c1 = await mkc('合成驾驶舱一'), c2 = await mkc('合成驾驶舱二'), c3 = await mkc('合成驾驶舱三');
  if (!c1 || !c2 || !c3) throw new Error('驾驶舱建不起来');
  const form = (extra = {}) => ({ title: '合成：核对一批单子', intent: '把一批合成单据核一遍', deliverable: '一张差异表', team: 'dsh/canvas/team-a', idempotency_key: key(), ...extra });
  const q = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };

  // ---------- 安排时记下 ----------
  const A1 = await call('POST', '/api/work-items', ALPHA, form({ cockpit_id: c1 }));
  const A0 = await call('POST', '/api/work-items', ALPHA, form());
  const B1 = await call('POST', '/api/work-items', BETA, form({ cockpit_id: c1 }));
  const A2 = await call('POST', '/api/work-items', ALPHA, form({ cockpit_id: c2 }));
  const ids = { a1: A1.body?.item_id, a0: A0.body?.item_id, b1: B1.body?.item_id, a2: A2.body?.item_id };
  {
    const d1 = await call('GET', `/api/work-items/${ids.a1}`, ALPHA), d0 = await call('GET', `/api/work-items/${ids.a0}`, ALPHA);
    const rec = q("SELECT detail FROM workbench_event_log WHERE event_id = ? AND action = 'recorded'", A1.body?.event_id)[0];
    check([A1, A0, B1, A2].every((r) => r.status === 201) && d1.body?.item?.cockpit_id === c1 && d0.body?.item?.cockpit_id === null && JSON.parse(rec?.detail ?? '{}').cockpit_id === c1,
      '带驾驶舱安排：事件日志 recorded 那一行记下，事项上是这个 id；不带的是 null', show({ s: [A1, A0, B1, A2].map((r) => r.status), c: d1.body?.item?.cockpit_id, n: d0.body?.item?.cockpit_id, rec: rec?.detail }));
  }
  // ---------- 校验 ----------
  {
    const bad = await Promise.all([0, -1, 1.5, '1', 2 ** 31].map((v) => call('POST', '/api/work-items', ALPHA, form({ cockpit_id: v }))));
    const missing = await call('POST', '/api/work-items', ALPHA, form({ cockpit_id: 99999 }));
    check(bad.every((r) => r.status === 400 && r.body?.error === 'cockpit_id_invalid') && missing.status === 400 && missing.body?.error === 'cockpit_not_found',
      '形状不对 400 cockpit_id_invalid（0、负数、小数、字符串、超界）；驾驶舱不存在 400 cockpit_not_found', show({ bad: bad.map((r) => [r.status, r.body?.error]), missing: [missing.status, missing.body?.error] }));
    const nul = await call('POST', '/api/work-items', ALPHA, form({ cockpit_id: null }));
    const nd = await call('GET', `/api/work-items/${nul.body?.item_id}`, ALPHA);
    check(nul.status === 201 && nd.body?.item?.cockpit_id === null, 'cockpit_id: null 当没带', show(nul.status));
  }
  // ---------- 幂等 ----------
  {
    const k = key();
    const first = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k, cockpit_id: c3 }));
    const same = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k, cockpit_id: c3 }));
    const other = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k, cockpit_id: c2 }));
    const none = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k }));
    check(first.status === 201 && same.status === 200 && same.body?.duplicate === true && other.status === 409 && none.status === 409,
      '幂等：同键同驾驶舱重放 200；同键换驾驶舱、同键去掉驾驶舱都 409', show([first.status, same.status, other.status, none.status]));
    const k2 = key();
    const p = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k2 })), p2 = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k2 }));
    // 升级前存下的幂等记录照旧认：没带驾驶舱的请求，哈希和加这一项之前的算法逐字节相同
    const f = form({ idempotency_key: k2 });
    const old = createHash('sha256').update(JSON.stringify({ title: f.title, intent: f.intent, deliverable: f.deliverable, team: f.team, object: '', phase: '', due: '', review: true }), 'utf8').digest('hex');
    const stored = q('SELECT body_sha256 FROM work_item_requests WHERE idem_key = ?', k2)[0]?.body_sha256;
    check(p.status === 201 && p2.status === 200 && p2.body?.duplicate === true && stored === old, '没带驾驶舱：同键同内容重放照旧 200；请求哈希和以前的算法相同（升级前的幂等记录照旧认）', show({ s: [p.status, p2.status], same: stored === old }));
  }
  // ---------- 列表按驾驶舱筛 ----------
  const list = (h, qs) => call('GET', `/api/work-items${qs}`, h);
  const ids_ = (r) => (r.body?.items ?? []).map((x) => x.id).sort();
  {
    const a = await list(ALPHA, `?view=mine&cockpit=${c1}`);
    check(a.status === 200 && show(ids_(a)) === show([ids.a1]) && a.body.items[0].cockpit_id === c1 && a.body.total === 1,
      '建立人按驾驶舱筛：只剩自己的、这个驾驶舱的那一件；别人建的同一个驾驶舱的不出现（只收窄，不放宽）；每行带 cockpit_id', show({ s: a.status, ids: ids_(a), total: a.body?.total }));
    const all = await list(ADMIN, `?view=all&cockpit=${c1}`);
    check(show(ids_(all)) === show([ids.a1, ids.b1].sort()), '管理层按驾驶舱筛：这个驾驶舱的两件', show(ids_(all)));
    const none = await list(ALPHA, '?view=mine&cockpit=99999');
    check(none.status === 200 && ids_(none).length === 0 && none.body.total === 0, '不存在的驾驶舱：空列表（不报错）', show({ s: none.status, n: ids_(none).length }));
    const bad = await Promise.all(['0', '-1', 'x', '1.5', '', '99999999999'].map((v) => list(ALPHA, `?cockpit=${encodeURIComponent(v)}`)));
    check(bad.every((r) => r.status === 400 && r.body?.error === 'work_items_cockpit_invalid'), '形状不对才 400 work_items_cockpit_invalid', show(bad.map((r) => r.status)));
  }
  // ---------- 驾驶舱删了 ----------
  {
    const del = await call('DELETE', `/api/cockpits/${c2}`, ADMIN);
    const d = await call('GET', `/api/work-items/${ids.a2}`, ALPHA), l = await list(ALPHA, `?view=mine&cockpit=${c2}`);
    check(del.status >= 200 && del.status < 300 && d.body?.item?.cockpit_id === c2 && show(ids_(l)) === show([ids.a2]), '驾驶舱删了：事项上的 cockpit_id 照旧返回，按它筛照旧筛得出来', show({ del: del.status, c: d.body?.item?.cockpit_id, l: ids_(l) }));
  }
  // ---------- 「关注」 ----------
  {
    const att = (await call('GET', '/api/attention', ADMIN)).body?.items ?? [];
    const g = (id) => att.find((x) => x.source === 'work-items' && x.source_id === id);
    check(g(ids.a1)?.cockpit_id === c1 && g(ids.a0)?.cockpit_id === null && att.filter((x) => x.source !== 'work-items' && x.source !== 'seat-asks').every((x) => !('cockpit_id' in x)),
      '「关注」：事项的条目带 cockpit_id（没有是 null）；别的来源没有这个字段', show({ a1: g(ids.a1)?.cockpit_id, a0: g(ids.a0)?.cockpit_id }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
