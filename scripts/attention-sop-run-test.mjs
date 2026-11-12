#!/usr/bin/env node
/**
 * 待验收的派单 run 进「等你拍板」，当场验收（来源 sop-runs，答法 finish）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   列表：只列别的节点派进来、还在跑的 run（有派单来源）；自己开的、已完成的不列。看得到的人和完成接口里不靠上传令牌的那两条同一处（管理员、本机命令行）
 *   detail：哪条流程、哪次执行、谁派来的（团队、调用方、任务号）、各步骤填了没有（只给名字和填没填，不给内容）、
 *          附件数和文件名（不给内容）、现在能不能验收通过（和完成接口同一处校验）
 *   finish：和 POST /api/sop/runs/:id/finish 同一个执行——必填没填 400、run 照旧在跑、不记账可再答；填好了当场完成，条目消失
 *   员工：看不到、答不了，run 不动；旧完成接口对他同样 403（同一处判断）
 *   去重：看得到 sop-runs 的人，统一待办里的同一条不再列；/api/tasks 本身不变
 *
 *   node scripts/attention-sop-run-test.mjs              测本仓库
 *   node scripts/attention-sop-run-test.mjs --root DIR   测另一棵目录树
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
const OUT = join(HERE, '..', 'tmp', `attention-sop-run-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'sop-run-accept-synthetic-admin';
const SECRET = 'STEP-CONTENT-CANARY-51a9';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const YAML = `title: 合成验收流程
code: DEMO
steps:
  - key: check
    title: 核对结论
    body: '<input data-field="value" data-label="结论" required>'
  - key: note
    title: 备注
    body: '<textarea data-field="value"></textarea>'
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext'), join(data, 'apps', 'demo-sop', 'v1')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(data, 'apps', 'demo-sop', 'v1', 'sop.yaml'), YAML);
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    db.prepare("INSERT INTO apps (slug, title, kind, status, active_version) VALUES ('demo-sop', '合成验收流程', 'sop', 'published', 1)").run();
    const run = (data, status = 'running') => Number(db.prepare("INSERT INTO sop_runs (sop_slug, sop_version, status, started_by, data) VALUES ('demo-sop', 1, ?, 'a2a:peer', ?)").run(status, JSON.stringify(data)).lastInsertRowid);
    const ctx = (id, n) => db.prepare("INSERT INTO a2a_run_ctx (context_id, run_id, task_id, caller, team, receipt_status) VALUES (?, ?, ?, 'seat:checker', 'dsh/canvas/team-a', '')").run('ctx-' + n, id, 'task-' + n);
    const r1 = run({ note: { value: ${JSON.stringify(SECRET)} } }); ctx(r1, 1);
    const r2 = run({ check: { value: '对上了' } }); ctx(r2, 2);
    db.prepare("INSERT INTO sop_run_files (run_id, original_name, mime, size, storage_path, created_by) VALUES (?, '对账单.pdf', 'application/pdf', 3, 'nowhere', 'a2a:peer')").run(r2);
    const own = run({}); // 自己开的，没有派单来源
    const done = run({ check: { value: 'x' } }, 'finished'); ctx(done, 3);
    console.log('SEEDED ' + JSON.stringify({ r1, r2, own, done }));`], { env, encoding: 'utf8' });
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
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN }, SESSION_ADMIN = { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` };
  const q = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };
  const items = async (h) => (await call('GET', '/api/attention', h)).body?.items ?? [];
  const answer = (h, id) => call('POST', '/api/attention/answer', h, { source: 'sop-runs', source_id: String(id), answer: 'finish', input: {} });

  // ---------- 列表和 detail ----------
  const att = await items(ADMIN);
  const runs = att.filter((x) => x.source === 'sop-runs');
  check(show(runs.map((x) => Number(x.source_id)).sort((a, b) => a - b)) === show([S.r1, S.r2].sort((a, b) => a - b)), '只列派进来、还在跑的 run：自己开的、已完成的不列', show(runs.map((x) => x.source_id)));
  const one = runs.find((x) => Number(x.source_id) === S.r1), two = runs.find((x) => Number(x.source_id) === S.r2);
  check(one && one.category === 'accept' && one.kind === 'sop-run' && show(one.answers) === '["finish"]' && one.mine === true && one.title.includes('合成验收流程') && one.waiting_for === 'seat:checker',
    '条目：类别 accept、kind sop-run、答法只有 finish、标题写流程名、等的是派单方', show(one && { c: one.category, k: one.kind, a: one.answers, t: one.title, w: one.waiting_for }));
  const d1 = one?.detail ?? {};
  check(d1.sop === 'demo-sop' && d1.sop_title === '合成验收流程' && d1.run_id === S.r1 && show(d1.dispatcher) === show({ team: 'dsh/canvas/team-a', caller: 'seat:checker', task_id: 'task-1' }),
    'detail：哪条流程、哪次执行、谁派来的（团队、调用方、任务号）', show(d1));
  check(show(d1.steps) === show([{ key: 'check', title: '核对结论', filled: false }, { key: 'note', title: '备注', filled: true }]) && d1.ready === false && d1.problems?.length > 0,
    'detail：各步骤填了没有；必填没填时 ready:false，带上校验说的问题', show({ steps: d1.steps, ready: d1.ready, problems: d1.problems }));
  check(!JSON.stringify(att).includes(SECRET), 'detail 不给步骤内容（填的值不在应答里）');
  check(two?.detail?.ready === true && show(two.detail.attachments) === show({ count: 1, names: ['对账单.pdf'] }), 'detail：附件数和文件名（不给内容）；必填都填了 ready:true', show(two?.detail));

  // ---------- 去重 ----------
  const taskIds = att.filter((x) => x.source === 'tasks').map((x) => x.source_id);
  const inbox = ((await call('GET', '/api/tasks', ADMIN)).body?.tasks ?? []).map((x) => x.id);
  check(!taskIds.includes(`market:run-${S.r1}`) && inbox.includes(`market:run-${S.r1}`), '看得到 sop-runs 的人：统一待办里的同一条不再列；/api/tasks 本身照旧列着', show({ taskIds, inbox }));

  // ---------- 员工 ----------
  {
    const mine = await items(ALPHA);
    const r = await answer(ALPHA, S.r2);
    const old = await call('POST', `/api/sop/runs/${S.r2}/finish`, ALPHA, {});
    check(!mine.some((x) => x.source === 'sop-runs') && [401, 403, 404].includes(r.status) && old.status === 403 && q('SELECT status FROM sop_runs WHERE id = ?', S.r2)[0].status === 'running',
      '员工看不到、答不了；旧完成接口对他同样 403（同一处判断），run 不动', show({ seen: mine.filter((x) => x.source === 'sop-runs').length, r: r.status, old: old.status }));
  }

  // ---------- finish ----------
  {
    const bad = await answer(ADMIN, S.r1);
    check(bad.status === 400 && Array.isArray(bad.body?.result?.violations) && q('SELECT status FROM sop_runs WHERE id = ?', S.r1)[0].status === 'running'
      && q("SELECT 1 FROM attention_answers WHERE source = 'sop-runs' AND source_id = ?", String(S.r1)).length === 0,
      '必填没填就验收：400（和完成接口同一处校验），run 照旧在跑，不记账（填好可再答）', show(bad));
    const ok = await answer(SESSION_ADMIN, S.r2);
    check(ok.status === 200 && ok.body?.result?.status === 'finished' && q('SELECT status FROM sop_runs WHERE id = ?', S.r2)[0].status === 'finished', '会话登录的管理员当场验收通过：run 完成', show(ok));
    const again = await answer(SESSION_ADMIN, S.r2);
    check(again.status === 200 && again.body?.duplicate === true, '再答一次：返回第一次的结果（duplicate）', show(again));
    const left = (await items(ADMIN)).filter((x) => x.source === 'sop-runs').map((x) => Number(x.source_id));
    check(!left.includes(S.r2) && left.includes(S.r1), '验收过的从「等你拍板」里消失，没验收的还在', show(left));
    const save = await call('PUT', `/api/sop/runs/${S.r1}`, ADMIN, { stepKey: 'check', value: { value: '补上了' } });
    const later = (await items(ADMIN)).find((x) => x.source === 'sop-runs' && Number(x.source_id) === S.r1);
    const fin = await answer(ADMIN, S.r1);
    check(save.status === 200 && later?.detail?.ready === true && fin.status === 200, '补填必填之后：detail 变成 ready:true，再答就验收通过', show({ save: save.status, ready: later?.detail?.ready, fin: fin.status }));
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
