#!/usr/bin/env node
/**
 * 提需求的人（阶段八 8f-1）。规格见产品化文档 02 附录「PR 8f」。
 * 起一个隔离实例（假的登录提供方，NODE_ENV=test；台从本机的 GitHub 替身同步）：
 *
 *   正例：alpha 登录着建任务中心的录入 → run 上记下提需求的人 alpha（录入发布已退役：发布入口 404，「发布的人不当建立人」由
 *         「安排一件事」的建立人规则接着守，见 work-item-arrange-test）
 *   对抗：匿名建的录入不记人；请求体自报 started_by、requester_principal、principal 不认；
 *         提供方不认的会话、被停用的人建录入——照样 201，只是不记人；别人续填、完成 alpha 建的录入——还是 alpha；
 *         建录入的应答不多不少（不回提需求人）
 *   计数：只有通道、有没有登录凭据、认没认出、次数，没有内容列；任务中心建录入、台的 REST 提交按维度各记一笔
 *
 *   node scripts/submitter-requester-test.mjs              测本仓库
 *   node scripts/submitter-requester-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `submitter-requester-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'requester-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '', gh = null;
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  gh = await startFakeGithub();
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', WM_GITHUB_API: gh.api, PORT: String(port) };
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, body) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body: json };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const as = (s) => ({ ...SAME, cookie: `session_id=${SESSIONS[s]}` });
  const ALPHA = as('alpha'), BETA = as('beta'), SESSION_ADMIN = as('admin');
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const q = (sql, ...a) => { const c = db(); try { return c.prepare(sql).all(...a); } finally { c.close(); } };
  const requesterOf = (runId) => { try { return q('SELECT requester_principal AS p FROM sop_runs WHERE id = ?', runId)[0]?.p; } catch { return 'no-column'; } };
  const counts = () => { try { return countsOrThrow(); } catch { return {}; } }; // 旧代码没有这张表：每一项各自红
  const countsOrThrow = () => Object.fromEntries(q('SELECT channel, has_credential, resolved, SUM(n) AS n FROM submission_counts GROUP BY 1, 2, 3').map((r) => [`${r.channel}|${r.has_credential}|${r.resolved}`, r.n]));
  const delta = (before, after) => Object.fromEntries(Object.keys(after).filter((k) => after[k] !== (before[k] ?? 0)).map((k) => [k, after[k] - (before[k] ?? 0)]));

  // 先让各人登录一次，主体建出来（停用 beta、认会话管理员要用）
  for (const h of [ALPHA, BETA, SESSION_ADMIN]) await call('GET', '/api/attention', h);

  /** 建一个任务中心录入：headers 决定是谁建的；填完、完成用 fillAs（默认同一个人） */
  const intake = async (headers, extra = {}, fillAs = headers) => {
    const r = await call('POST', '/api/sop/runs', headers, { slug: 'task-center', ...extra });
    // 和执行页一样：保存、完成带上开建时拿到的这个 run 的写凭据
    const w = { ...fillAs, 'x-run-upload-token': String(r.body?.upload_token ?? '') };
    for (const [k, v] of Object.entries({ title: '提需求的人', intent: '对抗', deliverable: '一行' })) await call('PUT', `/api/sop/runs/${r.body?.id}`, w, { stepKey: k, value: v });
    await call('POST', `/api/sop/runs/${r.body?.id}/finish`, w, {});
    return r;
  };
  // 录入发布已退役（任务只经「安排一件事」建）：这里只守建录入时记下的提需求人和计数
  // ---------- 正例 ----------
  {
    const c0 = counts();
    const run = await intake(ALPHA);
    check(run.status === 201 && requesterOf(run.body.id) === 'user:alpha', 'alpha 登录着建录入：run 上记下提需求的人 alpha', show({ run: run.status, p: requesterOf(run.body?.id) }));
    const d = delta(c0, counts());
    check(d['task-center.intake|1|1'] === 1 && Object.keys(d).length === 1, '计数：建录入（带凭据、认出）一笔', show(d));
    const pub = await call('POST', '/api/task-center/tasks', ADMIN, { intake_run_id: run.body?.id, published_by: 'beta' });
    check(pub.status === 404, '录入发布入口已退役：管理口令来发也是 404，不建任务、不记发布计数', show({ pub: pub.status, d: delta(c0, counts()) }));
  }
  // ---------- 对抗 ----------
  {
    const c0 = counts();
    const run = await intake({ ...SAME });
    check(run.status === 201 && requesterOf(run.body.id) === null, '匿名建录入：不记提需求的人', show({ run: run.status, p: requesterOf(run.body?.id) }));
    const d = delta(c0, counts());
    check(d['task-center.intake|0|0'] === 1, '计数：匿名建录入（没凭据、没认出）', show(d));
  }
  {
    const run = await intake(ALPHA, { started_by: 'expert:beta', requester_principal: 'user:beta', principal: 'user:beta', requester: 'user:beta' });
    check(run.status === 201 && requesterOf(run.body.id) === 'user:alpha', '请求体自报 started_by、requester_principal、principal：都不认，记的是会话认出的 alpha', show({ p: requesterOf(run.body?.id) }));
    const anon = await intake({ ...SAME }, { requester_principal: 'user:alpha', principal: 'user:alpha' });
    check(anon.status === 201 && requesterOf(anon.body.id) === null, '没登录、请求体自报 alpha：不记', show({ p: requesterOf(anon.body?.id) }));
  }
  {
    const c0 = counts();
    const run = await intake(as('forged'));
    check(run.status === 201 && requesterOf(run.body.id) === null, '提供方不认的会话建录入：照样 201，只是不记人', show({ s: run.status, p: requesterOf(run.body?.id) }));
    const d = delta(c0, counts());
    check(d['task-center.intake|1|0'] === 1, '计数：带了凭据、没认出', show(d));
  }
  {
    const fill = await intake(ALPHA, {}, BETA);
    check(requesterOf(fill.body.id) === 'user:alpha', 'alpha 建的录入由 beta 续填、完成：提需求的人还是 alpha（只在建录入时认）', show({ p: requesterOf(fill.body?.id) }));
  }
  {
    const off = await call('POST', '/api/principals/disable', ADMIN, { id: 'user:beta', reason: '对抗：停用提需求的人' });
    const run = await intake(BETA);
    check(off.status === 200 && run.status === 201 && requesterOf(run.body.id) === null, '被停用的人建录入：照样 201，不记人', show({ off: off.status, run: run.status, p: requesterOf(run.body?.id) }));
    await call('POST', '/api/principals/restore', ADMIN, { id: 'user:beta', reason: '对抗：恢复' });
  }
  {
    const run = await call('POST', '/api/sop/runs', ALPHA, { slug: 'task-center' });
    check(run.status === 201 && !('requester_principal' in (run.body ?? {})) && !('requester' in (run.body ?? {})), '建录入的应答不回提需求的人（应答的字段和今天一样）', show(Object.keys(run.body ?? {})));
  }
  // ---------- 台的提交计数 ----------
  {
    const pr = await ghPublish(base, gh, { slug: 'req8f', title: 't', files: [{ path: 'index.html', content: '<html><head><title>x</title></head><body>ok</body></html>' }] }, { 'X-Admin-Token': ADMIN_TOKEN });
    const html = await (await fetch(`${base}/apps/req8f/`)).text();
    const tok = /name="wm-app-token" content="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
    const c0 = counts();
    const page = await call('POST', '/api/apps/req8f/data', { origin: 'null', 'x-app-token': tok }, { data: { a: 1 }, created_by: 'alpha' });
    const withCookie = await call('POST', '/api/apps/req8f/data', ALPHA, { data: { a: 2 } });
    const d = delta(c0, counts());
    check(pr.status === 201 && page.status === 201 && withCookie.status === 201 && d['app-data.rest|0|0'] === 1 && d['app-data.rest|1|0'] === 1,
      '台的 REST 提交：沙箱页面（没凭据）、带登录的同源请求各记一笔；今天都认不出人', show({ pr: pr.status, page: page.status, withCookie: withCookie.status, d }));
  }
  {
    const cols = q('PRAGMA table_info(submission_counts)').map((c) => c.name).sort();
    check(show(cols) === show(['channel', 'day', 'has_credential', 'n', 'resolved']), '计数表只有通道、日期、有没有凭据、认没认出、次数——没有内容列', show(cols));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  try { await gh?.close?.(); } catch { /* 替身已停 */ }
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
