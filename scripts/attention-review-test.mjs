#!/usr/bin/env node
/**
 * 审核进「关注」（等你拍板）：变更申请当场批、看内容所需的最少字段、统一待办条目的类别。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   detail：要动的台或技能、现在第几版、回滚到第几版和那一版的说明、谁为什么申请；删除不可恢复（irreversible）、
 *           连带几个版本几个文件（只给计数）；台已经不在的 exists:false。不出文件内容
 *   可见范围不变：只有管理员看得到变更申请；员工的列表里没有，也答不了（申请不动）
 *   当场批：批准真的执行（台回滚把活跃版本切过去），审核人是认出来的管理员；旧入口照旧能用，和新入口同一处判断
 *   kind：统一待办条目带上 task / sop-run（它们不是审核，没有答法）
 *
 *   node scripts/attention-review-test.mjs              测本仓库
 *   node scripts/attention-review-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `attention-review-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'review-synthetic-admin';
const SECRET = 'FILE-CONTENT-CANARY-7f3a';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  // 台的版本目录：回滚要目标版本的物化目录在（里面放一个带金丝雀的文件，detail 不该带出它的内容）
  for (const v of [1, 2, 3]) { mkdirSync(join(data, 'apps', 'rb-app', `v${v}`), { recursive: true }); writeFileSync(join(data, 'apps', 'rb-app', `v${v}`, 'index.html'), SECRET); }
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    const app = (slug, active) => Number(db.prepare("INSERT INTO apps (slug, title, active_version) VALUES (?, ?, ?)").run(slug, '台 ' + slug, active).lastInsertRowid);
    const ver = (id, v, files, log) => db.prepare("INSERT INTO app_versions (app_id, version, file_count, changelog) VALUES (?, ?, ?, ?)").run(id, v, files, log);
    const rb = app('rb-app', 3); ver(rb, 1, 2, '第一版：最初的表单'); ver(rb, 2, 3, '第二版'); ver(rb, 3, 3, '第三版：改坏了');
    const del = app('del-app', 2); ver(del, 1, 4, 'a'); ver(del, 2, 5, 'b');
    const sk = Number(db.prepare("INSERT INTO skills (slug, name, layer, layer_name, source) VALUES ('rb-skill', '对账技能', 1, 'L1', 'synthetic')").run().lastInsertRowid);
    for (const v of [1, 2]) db.prepare("INSERT INTO skill_versions (skill_id, version, changelog, tree_digest, file_count) VALUES (?, ?, ?, ?, ?)").run(sk, v, '技能第' + v + '版', 'digest-' + v, v);
    const cr = (kind, slug, op, target) => Number(db.prepare("INSERT INTO change_requests (kind, slug, op, target_version, reason, requested_by) VALUES (?, ?, ?, ?, '合成的申请理由', 'mcp:synthetic')").run(kind, slug, op, target).lastInsertRowid);
    const out = { appRollback: cr('app', 'rb-app', 'rollback', 1), appDelete: cr('app', 'del-app', 'delete', null), skillRollback: cr('skill', 'rb-skill', 'rollback', 1), gone: cr('app', 'no-such-app', 'rollback', 1), old: cr('app', 'rb-app', 'rollback', 2) };
    db.prepare("INSERT INTO tasks (id, title, status, published_at, published_by) VALUES (901, '统一待办里的任务', 'published', '2026-01-01 00:00:00', 'alpha')").run();
    console.log('SEEDED ' + JSON.stringify(out));`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const S = JSON.parse(m[1]);
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
  const ADMIN = { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` };
  const q = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };
  const list = async (h) => (await call('GET', '/api/attention', h)).body?.items ?? [];
  const crOf = (items, id) => items.find((x) => x.source === 'change-requests' && x.source_id === String(id));

  // ---------- detail ----------
  const items = await list(ADMIN);
  {
    const d = crOf(items, S.appRollback)?.detail;
    check(d && d.kind === 'app' && d.op === 'rollback' && d.slug === 'rb-app' && d.title === '台 rb-app' && d.exists === true && d.current_version === 3 && d.target_version === 1
      && d.target_changelog === '第一版：最初的表单' && d.requested_by === 'mcp:synthetic' && d.reason === '合成的申请理由' && d.irreversible === false && !('impact' in d),
      '台回滚：现在第 3 版、回滚到第 1 版和那一版的说明、谁为什么申请；回滚可恢复（irreversible:false），不带 impact', show(d));
    const del = crOf(items, S.appDelete)?.detail;
    check(del && del.op === 'delete' && del.irreversible === true && del.target_version === null && show(del.impact) === show({ versions: 2, files: 9 }),
      '台删除：不可恢复（irreversible:true），连带 2 个版本、9 个文件（只给计数）', show(del));
    const sk = crOf(items, S.skillRollback)?.detail;
    check(sk && sk.kind === 'skill' && sk.title === '对账技能' && sk.current_version === 2 && sk.target_changelog === '技能第1版', '技能回滚：当前版本（没有指针时取最新）、目标版本的说明', show(sk));
    const gone = crOf(items, S.gone)?.detail;
    check(gone && gone.exists === false && gone.current_version === null && gone.title === '', '台已经不在：exists:false，不报错', show(gone));
    check(!JSON.stringify(items).includes(SECRET), 'detail 不出文件内容（版本目录里的金丝雀不在应答里）');
    const keys = show(Object.keys(crOf(items, S.appRollback)?.detail ?? {}).sort());
    check(keys === show(['created_at', 'current_version', 'exists', 'irreversible', 'kind', 'op', 'reason', 'requested_by', 'slug', 'target_changelog', 'target_version', 'title']), 'detail 的字段是定好的这几个', keys);
  }

  // ---------- kind ----------
  {
    const t = items.find((x) => x.source === 'tasks' && x.source_id === 'market:task-901');
    check(t && t.kind === 'task' && show(t.answers) === '[]', '统一待办里的任务中心任务：kind 是 task，没有答法', show(t));
    const kinds = new Set(items.filter((x) => x.source === 'tasks').map((x) => x.kind));
    check([...kinds].every((k) => ['task', 'sop-run', 'ygl', 'a2a', 'other'].includes(k)) && items.filter((x) => x.source !== 'tasks').every((x) => !('kind' in x)), 'kind 只在统一待办的条目上，取值在定好的五种里', show([...kinds]));
  }

  // ---------- 可见范围不变 ----------
  {
    const mine = await list(ALPHA);
    check(!mine.some((x) => x.source === 'change-requests'), '员工的「关注」里没有变更申请（只有管理员看得到）');
    const r = await call('POST', '/api/attention/answer', ALPHA, { source: 'change-requests', source_id: String(S.appRollback), answer: 'approve', input: {} });
    check([401, 403, 404].includes(r.status) && q('SELECT status FROM change_requests WHERE id = ?', S.appRollback)[0].status === 'pending', '员工答变更申请：被拒，申请不动', show(r));
  }

  // ---------- 当场批 ----------
  {
    const r = await call('POST', '/api/attention/answer', ADMIN, { source: 'change-requests', source_id: String(S.appRollback), answer: 'approve', input: { reviewed_by: '自报的名字' } });
    const row = q('SELECT status, reviewed_by, reviewed_by_principal FROM change_requests WHERE id = ?', S.appRollback)[0];
    const active = q("SELECT active_version FROM apps WHERE slug = 'rb-app'")[0].active_version;
    check(r.status === 200 && r.body?.result?.status === 'approved' && row.status === 'approved' && row.reviewed_by === 'odoo:root-admin' && row.reviewed_by_principal === 'odoo:root-admin' && active === 1,
      '当场批准：真的执行（台的活跃版本切到第 1 版），审核人是认出来的管理员，自报的名字不收', show({ r: r.body, row, active }));
    const gone = (await list(ADMIN)).some((x) => x.source === 'change-requests' && x.source_id === String(S.appRollback));
    check(!gone, '批完从「等你拍板」里消失');
    const old = await call('POST', `/api/change-requests/${S.old}/reject`, { ...SAME, 'x-admin-token': ADMIN_TOKEN }, { reviewed_by: '旧页面的人' });
    const orow = q('SELECT status, reviewed_by, reviewed_by_principal, review_note FROM change_requests WHERE id = ?', S.old)[0];
    check(old.status === 200 && orow.status === 'rejected' && orow.reviewed_by === '旧页面的人' && orow.reviewed_by_principal === 'admin-token' && orow.review_note === '',
      '旧入口照旧：收自填的 reviewed_by（只做显示）、理由可选；另记认出来的审核人', show({ old, orow }));
    const again = await call('POST', `/api/change-requests/${S.appRollback}/approve`, { ...SAME, 'x-admin-token': ADMIN_TOKEN }, { reviewed_by: 'x' });
    check(again.status === 400 && /已处理/.test(again.body?.error ?? ''), '已经批过的再从旧入口批：400（同一处判断，不可重复批准）', show(again));
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
