#!/usr/bin/env node
/**
 * 建立人验收、退回自己的事项（阶段八 8e）。规格见产品化文档 02 附录 8e。这是放宽访问（一个不经管理门的写入口），带对抗组。
 * 起一个隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   正例：建立人本人（登录、同源、主体没停用）验收 ready 的自己的事项 → done；退回（要理由）→ progress；
 *         退回之后再进 ready 能再验收；同一轮再答返回第一次的结果；管理员照旧经「关注」的答复入口验收
 *   对抗：别人的事项、冒用显示名（事项建立人写成显示名、请求里夹带建立人）、被停用的建立人、跨站、不在「等验收」、
 *         未登录、拿这个入口送别的事实（release、withdraw、report……）、建立人不是人（席位）、来源未验证——全部被拒、事项不动
 *   建立人主体（「是不是他的」只认它）：
 *         自报的建立人名是别人的登录名——那个人看不到、答不了；建立人主体空着——对非管理员，「关注」、事项页、验收入口一致地都没有它；
 *         同一个登录名改绑到另一个主体之后，不再是建立人；任务中心发布：录入是匿名建的，发布的人认得出也不当建立人（8f），口令发布留空；
 *         回填重复跑结果相同
 *   启动自检：远程匿名打这个入口必须 401
 *   判定比对开着：建立人验收成功的请求记成「状态码不代表授权」，不出现不一致
 *
 *   node scripts/work-item-creator-test.mjs              测本仓库
 *   node scripts/work-item-creator-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
  // 建立人主体默认和显示名一致（就是那个人建的）；对抗用例在 extra 里另给
  const it = items.create({ title: '待验收 ' + n, created_by: by, creator_principal: /^user:\\S+$/.test(by) ? by : null, source_kind: 'agent', ...extra });
  for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? ''), ...x });
  return it.id;
};
const out = {
  mine: ready('user:alpha', 1), mine2: ready('user:alpha', 2), again: ready('user:alpha', 3), crossSite: ready('user:alpha', 4), facts: ready('user:alpha', 5),
  theirs: ready('user:beta', 6), betaOwn: ready('user:beta', 7), byName: ready('user:Synthetic alpha', 8), bySeat: ready('seat:checker', 9),
  unverified: ready('user:alpha', 10, { context: { submitter_kind: 'unverified' } }), adminOne: ready('user:alpha', 11),
  // 自报的建立人名是 alpha 的登录名，主体却不是 alpha：一条没有主体，一条主体是 beta
  claimsAlpha: ready('human:alpha', 12), claimsAlphaIsBeta: ready('user:alpha', 13, { creator_principal: 'user:beta' }),
  // 建立人主体空着（显示名就是 alpha）
  noPrincipal: ready('user:alpha', 14, { creator_principal: null }),
  // 改绑之前是 alpha 建的
  beforeRebind: ready('user:alpha', 15),
};
const notReady = items.create({ title: '还在进行', created_by: 'user:alpha', creator_principal: 'user:alpha', source_kind: 'agent' });
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
  const compareOut = join(OUT, 'judgment-compare.jsonl');
  // 并行比对开着：建立人验收成功的那一步也记下来，看新判定和旧结论对不对得上
  const env = { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: compareOut, PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
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
  {
    // 判定比对：建立人（不是管理员）验收成功是事项上的规则，路由声明了「状态码不代表授权」，记 not-verdict，不出现不一致
    await new Promise((r) => setTimeout(r, 300));
    const lines = existsSync(compareOut) ? readFileSync(compareOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const decided = lines.filter((l) => l.route === 'POST /api/work-items/:id/decision' && l.status === 200);
    const mismatches = lines.filter((l) => l.outcome === 'mismatch');
    check(decided.length >= 2 && decided.every((l) => l.outcome === 'not-verdict') && mismatches.length === 0,
      '判定比对：建立人验收成功的请求记成「状态码不代表授权」，整个过程没有不一致', show({ decided: decided.map((l) => l.outcome), mismatches }));
  }
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
  // ---------- 阶段七 R2：事项对话里的席位消息（看过、回复）——和验收入口同一个口径再加管理员 ----------
  {
    const read = (id, headers) => call('POST', `/api/work-items/${id}/messages/read`, headers, {});
    const reply = (id, mid, headers, text = '回一句') => call('POST', `/api/work-items/${id}/messages/${mid}/reply`, headers, { text });
    const ADMIN_H = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
    const cases = [
      ['别人的事项（alpha 看过 beta 的）', () => read(S.theirs, ALPHA), 404, 'work_item_not_found'],
      ['别人的事项（alpha 回复 beta 的）', () => reply(S.theirs, 1, ALPHA), 404, 'work_item_not_found'],
      ['跨站请求', () => read(S.crossSite, { ...ALPHA, 'sec-fetch-site': 'cross-site' }), 403, 'work_items_cross_origin_denied'],
      ['别的站的页面', () => reply(S.crossSite, 1, { ...ALPHA, origin: 'https://elsewhere.example' }), 403, 'work_items_cross_origin_denied'],
      ['未登录（远程匿名）看过', () => read(S.crossSite, { ...SAME, 'x-forwarded-for': '198.51.100.7' }), 401, 'work_items_auth_required'],
      ['未登录（远程匿名）回复', () => reply(S.crossSite, 1, { ...SAME, 'x-forwarded-for': '198.51.100.7' }), 401, 'work_items_auth_required'],
      ['提供方不认的会话', () => reply(S.crossSite, 1, { ...SAME, cookie: `session_id=${SESSIONS.forged}` }), 401, 'work_items_auth_required'],
      ['被停用的建立人', () => reply(S.betaOwn, 1, BETA), [401, 403], null],
      ['来源未验证的事项（建立人是 alpha 本人也不行）', () => reply(S.unverified, 1, ALPHA), 403, 'work_item_creator_not_eligible'],
      ['建立人不是人（席位）', () => read(S.bySeat, ALPHA), 404, 'work_item_not_found'],
      ['消息编号不是正整数（写请求总门只放数字编号，先拦）', () => reply(S.crossSite, '0x1', ALPHA), 403, null],
      ['回复正文为空', () => reply(S.crossSite, 1, ALPHA, '  '), 400, 'text_required'],
      ['这件事项上没有这条消息（编号是别的事项的也一样）', () => reply(S.crossSite, 1, ALPHA), 404, 'seat_message_not_found'],
    ];
    for (const [label, run, st, err] of cases) {
      const res = await run();
      const sts = Array.isArray(st) ? st : [st];
      check(sts.includes(res.status) && (!err || res.body?.error === err), `席位消息入口·${label}：被拒（${res.status} ${res.body?.error ?? ''}）`, show(res));
    }
    const own = await read(S.crossSite, ALPHA);
    check(own.status === 200 && own.body?.marked === 0, '建立人本人对自己的事项「看过」：200（没有消息，标了 0 条）', show(own));
    const adm = await read(S.theirs, ADMIN_H);
    check(adm.status === 200, '管理员对任何事项「看过」：200', show(adm));
    const notItem = await call('POST', '/api/work-items/not-an-item/messages/read', ALPHA, {});
    check(notItem.status === 403, '路径不是事项 id 的样子：写请求总门照旧拦', show(notItem));
    const other = await call('POST', `/api/work-items/${S.crossSite}/messages/1/delete`, ALPHA, {});
    check(other.status === 403, '同一前缀下别的子路径（messages/1/delete）：写请求总门照旧拦', show(other));
  }
  // ---------- 建立人主体：「是不是他的」只认它 ----------
  const attentionIds = async (headers) => { const r = await call('GET', '/api/attention', headers); return { status: r.status, ids: (r.body?.items ?? []).filter((x) => x.source === 'work-items').map((x) => x.source_id) }; };
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  /** 对这个人：「关注」里有没有、事项页能不能读、验收入口能不能答——三处要一致 */
  const threeWays = async (id, headers) => {
    const n = logs(id);
    const list = await attentionIds(headers);
    const page = await call('GET', `/api/work-items/${id}`, headers);
    const answer = await decide(id, { answer: 'verify' }, headers);
    return { listed: list.ids.includes(id), page: page.status, answer: answer.status, answerError: answer.body?.result?.error ?? answer.body?.error, untouched: untouched(id, n), list: list.status };
  };
  {
    const a = await threeWays(S.claimsAlpha, ALPHA);
    check(!a.listed && a.page === 404 && a.answer === 404 && a.answerError === 'work_item_not_found' && a.untouched, '自报的建立人名是 alpha 的登录名、没有建立人主体：alpha 在「关注」里看不到、事项页 404、验收 404，事项不动', show(a));
    const b = await threeWays(S.claimsAlphaIsBeta, ALPHA);
    check(!b.listed && b.page === 404 && b.answer === 404 && b.untouched, '显示名写成 user:alpha、建立人主体是 beta：alpha 看不到、答不了', show(b));
  }
  {
    const alpha = await threeWays(S.noPrincipal, ALPHA);
    check(alpha.list === 200 && !alpha.listed && alpha.page === 404 && alpha.answer === 404 && alpha.untouched, '建立人主体空着：对非管理员，「关注」不列、事项页 404、验收入口 404——三处一致', show(alpha));
    const adminList = await attentionIds(ADMIN);
    const adminPage = await call('GET', `/api/work-items/${S.noPrincipal}`, ADMIN);
    check(adminList.ids.includes(S.noPrincipal) && adminPage.status === 200 && adminPage.body?.item?.creator_principal === null, '建立人主体空着：管理员看得到（「关注」列出、事项页能读）', show({ adminList: adminList.ids.includes(S.noPrincipal), page: adminPage.status }));
  }
  // ---------- 任务中心发布：建立人主体只取身份服务认出来的人 ----------
  {
    const run = async () => {
      const r = await call('POST', '/api/sop/runs', {}, { slug: 'task-center' });
      for (const [k, v] of Object.entries({ title: '建立人主体', intent: '对抗', deliverable: '一行' })) await call('PUT', `/api/sop/runs/${r.body.id}`, {}, { stepKey: k, value: v });
      await call('POST', `/api/sop/runs/${r.body.id}/finish`, {}, {});
      return r.body.id;
    };
    const item = (eventId) => { const c = db(); try { return c.prepare('SELECT id, created_by, creator_principal FROM work_items WHERE id = ?').get(`wi_${eventId}`); } finally { c.close(); } };
    const bySession = await call('POST', '/api/task-center/tasks', { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, { intake_run_id: await run(), published_by: 'alpha' });
    const byToken = await call('POST', '/api/task-center/tasks', ADMIN, { intake_run_id: await run(), published_by: 'alpha' });
    const s = bySession.body?.event_id ? item(bySession.body.event_id) : null, t = byToken.body?.event_id ? item(byToken.body.event_id) : null;
    const adminPrincipal = (() => { const c = db(); try { return c.prepare("SELECT id FROM principals WHERE id = 'user:root-admin'").get()?.id ?? null; } finally { c.close(); } })();
    check(bySession.status === 201 && s && s.creator_principal === null && adminPrincipal !== null && s.created_by === 'human:alpha', '会话登录的管理员发布匿名建的录入（published_by 自填 alpha）：建立人主体留空——不拿发布的人顶替，也不认自填的名字（8f）', show({ bySession, s }));
    check(byToken.status === 201 && t && t.creator_principal === null && t.created_by === 'human:alpha', '口令发布（认不出人）：建立人主体留空，自填的 alpha 只进显示名', show({ byToken, t }));
    const page = t ? await call('GET', `/api/work-items/${t.id}`, ALPHA) : { status: 0 };
    check(page.status === 404, '自填 alpha 的那件事项：alpha 读不到（404）', show(page));
  }
  // ---------- 回填重复跑，结果相同 ----------
  {
    const snapshot = () => { const c = db(); try { return show(c.prepare('SELECT id, creator_principal FROM work_items ORDER BY id').all()); } finally { c.close(); } };
    const before = snapshot();
    const f = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
      const { root } = await import(at('server/src/root-context.ts'));
      const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
      await root.plugin(WorkItemService);
      const items = root.get('workItems'); items.backfill(); items.backfill();
      console.log('DONE');`], { env, encoding: 'utf8' });
    check(f.stdout.includes('DONE') && snapshot() === before, '回填再跑两遍：每件事项的建立人主体都不变（确定不了的照旧空着）', f.stderr.slice(-300));
  }
  // ---------- 改绑：同一个登录名、换了主体，就不是建立人 ----------
  {
    const c = db(); const provider = c.prepare("SELECT provider FROM principal_identities WHERE principal_id = 'user:alpha'").get()?.provider; c.close();
    const off = await call('POST', '/api/principals/unbind', ADMIN, { provider, external_id: 'alpha', reason: '对抗：改绑' });
    const on = await call('POST', '/api/principals/bind', ADMIN, { provider, external_id: 'alpha', principal: 'user:alpha-rebound', create: true, reason: '对抗：改绑' });
    const who = await call('GET', '/api/admin/whoami', ALPHA);
    const a = await threeWays(S.beforeRebind, ALPHA);
    check(off.status === 200 && on.status === 200 && !a.listed && a.page === 404 && a.answer === 404 && a.untouched, '同一个登录名 alpha 改绑到另一个主体之后：原来 alpha 建的事项看不到、答不了', show({ off: off.status, on: on.status, who: who.body, a }));
  }
  // ---------- 启动自检 ----------
  check(/"id":"market\.work-items\.creator-decision-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名打这个入口必须 401，而且过了');
  check(/"id":"market\.work-items\.seat-reply-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名回复席位消息必须 401，而且过了');
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
