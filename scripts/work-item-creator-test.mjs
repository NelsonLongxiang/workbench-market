#!/usr/bin/env node
/**
 * 建立人验收、退回自己的事项（阶段八 8e）。规格见产品化文档 02 附录 8e。这是放宽访问（一个不经管理门的写入口），带对抗组。
 * 起一个隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   正例：建立人本人（登录、同源、主体没停用）验收 ready 的自己的事项 → done；退回（要理由）→ progress；
 *         退回之后再进 ready 能再验收；同一轮再答返回第一次的结果；管理员照旧经「关注」的答复入口验收
 *   对抗：别人的事项、冒用显示名（事项建立人写成显示名、请求里夹带建立人）、被停用的建立人、跨站、不在「等验收」、
 *         未登录、拿这个入口送别的事实（release、withdraw、report……）、建立人不是人（席位）、来源未验证——全部被拒、事项不动
 *   启动自检：远程匿名打这个入口必须 401
 *
 *   node scripts/work-item-creator-test.mjs              测本仓库
 *   node scripts/work-item-creator-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-creator-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'creator-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const SEED = `
const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
const { root } = await import(at('server/src/root-context.ts'));
const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
await root.plugin(WorkItemService);
const items = root.get('workItems');
const ready = (by, n, extra = {}) => {
  const it = items.create({ title: '待验收 ' + n, created_by: by, source_kind: 'agent', ...extra });
  for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? ''), ...x });
  return it.id;
};
const out = {
  mine: ready('user:alpha', 1), mine2: ready('user:alpha', 2), again: ready('user:alpha', 3), crossSite: ready('user:alpha', 4), facts: ready('user:alpha', 5),
  theirs: ready('user:beta', 6), betaOwn: ready('user:beta', 7), byName: ready('user:Synthetic alpha', 8), bySeat: ready('seat:checker', 9),
  unverified: ready('user:alpha', 10, { context: { submitter_kind: 'unverified' } }), adminOne: ready('user:alpha', 11),
};
const notReady = items.create({ title: '还在进行', created_by: 'user:alpha', source_kind: 'agent' });
for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }]]) items.apply(notReady.id, { kind: k, source: 'seed', id: notReady.id + ':' + k, ...x });
out.notReady = notReady.id;
console.log('SEEDED ' + JSON.stringify(out));
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', SEED], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seeded.stdout);
  if (!m) throw new Error(`造数据失败：${seeded.stderr.slice(-800)}`);
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
  const call = async (method, path, headers, body) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body: json };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, BETA = { ...SAME, cookie: `session_id=${SESSIONS.beta}` };
  const decide = (id, body, headers = ALPHA) => call('POST', `/api/work-items/${id}/decision`, headers, body);
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const state = (id) => { const c = db(); try { return c.prepare('SELECT state FROM work_items WHERE id = ?').get(id)?.state; } finally { c.close(); } };
  const logs = (id) => { const c = db(); try { return c.prepare('SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ?').get(id).n; } finally { c.close(); } };
  const untouched = (id, before) => state(id) === 'ready' && logs(id) === before;

  // 先让 alpha、beta 各登录一次，主体建出来（停用 beta 要用）
  await call('GET', '/api/attention', ALPHA); await call('GET', '/api/attention', BETA);

  // ---------- 正例 ----------
  const v = await decide(S.mine, { answer: 'verify' });
  check(v.status === 200 && v.body?.result?.state === 'done' && state(S.mine) === 'done', '建立人本人验收自己 ready 的事项：done', show(v));
  const v2 = await decide(S.mine, { answer: 'verify' });
  check(v2.status === 200 && v2.body?.duplicate === true && show(v2.body.result) === show(v.body.result), '同一轮再验收一次：返回第一次的结果', show(v2));
  const r0 = await decide(S.mine2, { answer: 'return' });
  const r = await decide(S.mine2, { answer: 'return', reason: '差异没标' });
  check(r0.status === 400 && r.status === 200 && state(S.mine2) === 'progress', '退回要写理由；写了：ready → progress', show({ r0, r }));
  {
    const a1 = await decide(S.again, { answer: 'return', reason: '再看看' });
    const f = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
      const { root } = await import(at('server/src/root-context.ts'));
      const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
      await root.plugin(WorkItemService);
      const r = root.get('workItems').apply(${JSON.stringify(S.again)}, { kind: 'report', status: 'ready', source: 'seat', id: 're-ready', actor: 'seat:checker' });
      console.log(r.ok ? 'DONE' : 'FAIL');`], { env, encoding: 'utf8' });
    const a2 = await decide(S.again, { answer: 'verify' });
    check(a1.status === 200 && f.stdout.includes('DONE') && a2.status === 200 && a2.body.duplicate === false && state(S.again) === 'done', '退回之后再次进入「等验收」：能再答（按这一次进入等验收记，不按事项记）', show({ a1: a1.status, a2 }));
  }
  {
    const n = logs(S.adminOne);
    const a = await call('POST', '/api/attention/answer', { ...SAME, 'x-admin-token': ADMIN_TOKEN }, { source: 'work-items', source_id: S.adminOne, answer: 'verify', input: {} });
    check(a.status === 200 && state(S.adminOne) === 'done' && logs(S.adminOne) === n + 1, '管理员照旧经「关注」的答复入口验收', show(a));
  }

  // ---------- 对抗 ----------
  /** expectError 给了就要对上错误码：确认是这个入口自己按这个理由拒的，不是被别的门顺手挡掉 */
  const denied = async (label, id, body, headers, expectStatus, expectError) => {
    const n = logs(id);
    const res = await decide(id, body, headers);
    const err = res.body?.result?.error ?? res.body?.error;
    check(expectStatus.includes(res.status) && untouched(id, n) && (!expectError || err === expectError), `${label}：被拒（${res.status}${err ? ' ' + err : ''}），事项不动`, show(res));
  };
  await denied('别人的事项（beta 验收 alpha 的）', S.crossSite, { answer: 'verify' }, BETA, [404], 'work_item_not_found');
  await denied('别人的事项（alpha 验收 beta 的）', S.theirs, { answer: 'verify' }, ALPHA, [404], 'work_item_not_found');
  await denied('冒用显示名：事项的建立人写成 alpha 的显示名', S.byName, { answer: 'verify' }, ALPHA, [404], 'work_item_not_found');
  await denied('请求里夹带建立人、主体', S.theirs, { answer: 'verify', created_by: 'user:alpha', principal: 'user:beta', as: 'user:beta' }, ALPHA, [404], 'work_item_not_found');
  await denied('跨站请求', S.crossSite, { answer: 'verify' }, { ...ALPHA, 'sec-fetch-site': 'cross-site' }, [403], 'work_items_cross_origin_denied');
  await denied('别的站的页面', S.crossSite, { answer: 'verify' }, { ...ALPHA, origin: 'https://elsewhere.example' }, [403], 'work_items_cross_origin_denied');
  await denied('未登录（远程匿名）', S.crossSite, { answer: 'verify' }, { ...SAME, 'x-forwarded-for': '198.51.100.7' }, [401], 'work_items_auth_required');
  await denied('提供方不认的会话', S.crossSite, { answer: 'verify' }, { ...SAME, cookie: `session_id=${SESSIONS.forged}` }, [401], 'work_items_auth_required');
  for (const ans of ['release', 'withdraw', 'report', 'answer', 'submit', 'eval', 'note', '']) await denied(`拿这个入口送别的事实（${ans || '空'}）`, S.facts, { answer: ans, status: 'ready', kind: 'verify' }, ALPHA, [400], 'creator_answer_not_allowed');
  await denied('建立人不是人（席位）：alpha 不是它的建立人', S.bySeat, { answer: 'verify' }, ALPHA, [404], 'work_item_not_found');
  await denied('来源未验证的事项（建立人是 alpha 本人也不行）', S.unverified, { answer: 'verify' }, ALPHA, [403], 'work_item_creator_not_eligible');
  {
    const n = logs(S.notReady);
    const res = await decide(S.notReady, { answer: 'verify' });
    check(res.status === 409 && state(S.notReady) === 'progress' && logs(S.notReady) === n, '不在「等验收」（进行中）：被拒（409），事项不动', show(res));
  }
  {
    const off = await call('POST', '/api/principals/disable', { ...SAME, 'x-admin-token': ADMIN_TOKEN }, { id: 'user:beta', reason: '对抗：停用建立人' });
    const n = logs(S.betaOwn);
    const res = await decide(S.betaOwn, { answer: 'verify' }, BETA);
    check(off.status === 200 && [401, 403].includes(res.status) && ['work_items_auth_required', 'work_items_principal_not_active'].includes(res.body?.error) && untouched(S.betaOwn, n), `被停用的建立人验收自己的事项：被拒（${res.status} ${res.body?.error}），事项不动`, show({ off: off.status, res }));
  }
  {
    // id 不是事项 id 的样子：写请求总门只对「/api/work-items/wi_…/decision」放行，别的路径照旧要管理员
    const res = await decide('not-an-item', { answer: 'verify' });
    check(res.status === 403, 'id 不是事项 id 的样子：写请求总门照旧拦（只放 wi_ 开头的这一条子路径）', show(res));
  }
  // ---------- 启动自检 ----------
  check(/"id":"market\.work-items\.creator-decision-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名打这个入口必须 401，而且过了');
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
