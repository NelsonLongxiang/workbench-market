#!/usr/bin/env node
/**
 * 建立人验收、退回自己的事项（阶段八 8e）。规格见产品化文档 02 附录 8e。这是放宽访问（一个不经管理门的写入口），带对抗组。
 * 起一个隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   正例：建立人本人（登录、同源、主体没停用）验收 ready 的自己的事项 → done；退回（要理由）→ progress；
 *         退回之后再进 ready 能再验收；同一轮再答返回第一次的结果；只有管理口令的经「关注」验收被拒，持管理层授予的人代办（acting_for = creator）
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
  // L20：「关注」的答复入口对登录的人放开之后，经它验收
  viaAttn: ready('user:alpha', 16), viaAttnMgmt: ready('user:alpha', 17),
  // 重放答过的一条：先判权，再认重复
  replay: ready('user:alpha', 18),
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
  const out = {};
  const ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, BETA = { ...SAME, cookie: `session_id=${SESSIONS.beta}` };
  const decide = (id, body, headers = ALPHA) => call('POST', `/api/work-items/${id}/decision`, headers, body);
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const state = (id) => { const c = db(); try { return c.prepare('SELECT state FROM work_items WHERE id = ?').get(id)?.state; } finally { c.close(); } };
  const logs = (id) => { const c = db(); try { return c.prepare('SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ?').get(id).n; } finally { c.close(); } };
  const untouched = (id, before) => state(id) === 'ready' && logs(id) === before;
  const q = (sql, ...a) => { const c = db(); try { return c.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { c.close(); } };

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
    check(a.status === 400 && a.body?.error === 'attention_answer_not_offered' && state(S.adminOne) === 'ready' && logs(S.adminOne) === n, '只有管理口令（没有管理层授予）：经「关注」的答复入口验收被拒（400，答法不在条目上），事项不动', show(a));
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
  // ---------- L20：「关注」的答复入口对登录的人放开（写请求总门放行），能不能答仍由条目的来源判 ----------
  {
    const viaAttn = (id, headers, source = 'work-items', ans = 'verify') => call('POST', '/api/attention/answer', headers, { source, source_id: id, answer: ans, input: {} });
    // 管理层：看得到所有事项（itemRoles），但不是建立人
    const MGMT = { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` };
    await call('GET', '/api/auth/viewer', MGMT);
    const g = await call('POST', '/api/grants', {}, { principal: 'user:no-flag', role: 'management', scope: '*', reason: '合成：管理层' });
    await call('POST', `/api/grants/${g.body?.grant?.id}/submit`, {}); await call('POST', `/api/grants/${g.body?.grant?.id}/approve`, {});
    const mgmtItem = ((await call('GET', '/api/attention', MGMT)).body?.items ?? []).find((x) => x.source === 'work-items' && x.source_id === S.viaAttnMgmt);
    const mgmtSees = !!mgmtItem;
    const ownItem = ((await call('GET', '/api/attention', ALPHA)).body?.items ?? []).find((x) => x.source === 'work-items' && x.source_id === S.viaAttnMgmt);
    check(mgmtSees && JSON.stringify(mgmtItem.answers) === JSON.stringify(['verify', 'return']) && mgmtItem.mine === false && ownItem && JSON.stringify(ownItem.answers) === JSON.stringify(['verify', 'return']),
      '「关注」列表的答法只给答得了的人：持管理层授予的人看得到别人建的待验收，带验收、退回（代办，mine:false）；建立人自己的带', JSON.stringify({ mgmtItem, ownItem }));
    const n = logs(S.viaAttnMgmt);
    const anon = await viaAttn(S.viaAttnMgmt, { ...SAME, 'x-forwarded-for': '198.51.100.7' });
    const down = await viaAttn(S.viaAttnMgmt, { ...SAME, cookie: `session_id=${SESSIONS.hangs}` });
    const stillReady = untouched(S.viaAttnMgmt, n) && state(S.viaAttnMgmt) === 'ready';
    const byMgmt = await viaAttn(S.viaAttnMgmt, MGMT);
    const mgmtFact = q("SELECT actor, detail FROM work_item_log WHERE item_id = ? ORDER BY seq DESC LIMIT 1", S.viaAttnMgmt)[0];
    const own = await viaAttn(S.viaAttn, ALPHA);
    const ownDone = state(S.viaAttn) === 'done';
    const adminSource = await viaAttn('1', ALPHA, 'change-requests', 'approve');
    check(g.status === 201 && mgmtSees && stillReady && byMgmt.status === 200 && state(S.viaAttnMgmt) === 'done' && mgmtFact?.actor === 'user:no-flag' && JSON.parse(mgmtFact.detail).acting_for === 'creator'
      && own.status === 200 && ownDone && anon.status === 401 && adminSource.status === 403 && down.status === 502 && down.body?.error === 'identity_unavailable',
      '「关注」的答复入口对登录的人放开：建立人从这里验收自己的事项 200；持管理层授予的人代办验收 200（留痕记本人、acting_for = creator）；远程匿名 401；不是管理员答管理员的来源 403；身份来源不可达 502 identity_unavailable', JSON.stringify({ mgmtSees, stillReady, byMgmt: [byMgmt.status, byMgmt.body?.error], mgmtFact, own: [own.status, ownDone], anon: anon.status, adminSource: adminSource.status, down: [down.status, down.body?.error] }));
  }

  // ---------- 重放答过的一条：先过和第一次同样的判权，再认重复；无权的、换答法的拿到的和这一条不存在时一模一样 ----------
  {
    const viaAttn = (id, headers, ans = 'verify', input = {}) => call('POST', '/api/attention/answer', headers, { source: 'work-items', source_id: id, answer: ans, input });
    const MGMT = { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` };
    const ghost = 'wi_no_such_item_replay';
    const first = await viaAttn(S.replay, ALPHA);
    const strip = (r) => ({ status: r.status, body: { ...r.body, source_id: null } });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const bReplay = await viaAttn(S.replay, BETA), bGhost = await viaAttn(ghost, BETA);
    const mReplay = await viaAttn(S.replay, MGMT), mGhost = await viaAttn(ghost, MGMT);
    check(first.status === 200 && !first.body.duplicate && same(strip(bReplay), strip(bGhost)) && same(strip(mReplay), strip(mGhost)) && mReplay.status === 404 && !mReplay.body.result && !bReplay.body.result,
      '不是答这一条的人（被停用的同事、持管理层授予的人）重放一条已验收的：状态码、正文和这一条不存在时一模一样，不带 duplicate、不带上一次的结果',
      show({ first: first.status, bReplay, bGhost, mReplay, mGhost }));
    const aReplay = await viaAttn(S.replay, ALPHA);
    check(aReplay.status === 200 && aReplay.body.duplicate === true && same(aReplay.body.result, first.body.result), '建立人本人用同一种答法重放：照旧返回 duplicate 和第一次的结果', show(aReplay));
    const aOther = await viaAttn(S.replay, ALPHA, 'return', { reason: '换个答法' }), aGhost = await viaAttn(ghost, ALPHA, 'return', { reason: '换个答法' });
    check(same(strip(aOther), strip(aGhost)) && aOther.status === 404 && !aOther.body.result && state(S.replay) === 'done', '换一种答法重放：不返回上一次的正文，和不存在时一样；事项不动', show({ aOther, aGhost }));
    // 走事项自己的决定入口（同一本账）：别人答成过的这一轮，换答法不拿上一次的正文
    const dOther = await call('POST', `/api/work-items/${S.replay}/decision`, ALPHA, { answer: 'return', reason: '换个答法' });
    const dSame = await call('POST', `/api/work-items/${S.replay}/decision`, ALPHA, { answer: 'verify' });
    check(dOther.status === 409 && dOther.body?.duplicate === false && dOther.body?.result?.error === 'attention_already_answered' && !show(dOther.body).includes(show(first.body.result).slice(1, 30))
      && dSame.status === 200 && dSame.body?.duplicate === true && same(dSame.body.result, first.body.result) && state(S.replay) === 'done',
      '事项自己的决定入口（同一本账）：换答法回「已经处理过了」、不带上一次的结果；同一种答法照旧 duplicate', show({ dOther, dSame }));
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
  {
    const tm = await call('GET', '/api/a2a/teams', ALPHA), tf = await call('GET', '/api/a2a/teams', { ...SAME, cookie: `session_id=${SESSIONS.forged}` });
    check(tm.status === 200 && Array.isArray(tm.body?.teams) && tf.status === 401, '团队名册：登录的员工能读（只有席位信息）；提供方不认的会话 401', show({ tm: tm.status, tf: tf.status }));
  }
  // ---------- 阶段七：建立人回答自己事项上的席位提问 ----------
  {
    let seqAsk = 0;
    /** 直接往库里造一件「从工作台事件来、席位在问」的事项（事件、投递、receipt:attention 日志、事项与 ask 事实），返回 { item, delivery } */
    /** 往库里写一个「席位在问」的工作台事件（recorded 记下提需求人、投递已发、receipt:attention），事项由事项服务的回填按正常路径建出来 */
    const seedAsk = (creator) => {
      const c = new DatabaseSync(join(data, 'workbench-market.db'));
      c.exec('PRAGMA busy_timeout = 5000');
      try {
        seqAsk++;
        const ev = `wbe-${(0xc00 + seqAsk).toString(16).padStart(16, '0')}`, ctx = `wb:task-center:${9000 + seqAsk}`;
        c.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', ?, ?, 'human', 'human:alpha', 1, ?, 1, 'default')").run(ev, `task:${9000 + seqAsk}`, ctx, 'x'.repeat(64));
        c.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, NULL, 'market', 'recorded', ?)").run(ev, JSON.stringify(creator ? { requester: creator } : {}));
        const delivery = Number(c.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, sent_at) VALUES (?, 'lab/canvas/team', 'http://peer.synthetic.invalid', 'market/12345678', 'sent', datetime('now'))").run(ev).lastInsertRowid);
        for (const action of ['queued', 'sent']) c.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(ev, delivery, action);
        const qid = Number(c.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:lab', 'receipt:attention', ?)").run(ev, delivery, JSON.stringify({ summary: '结论用中文还是英文？', disposition: 'attention', task: `${ev}.d${delivery}.a1`, qid: 'q1', question: { id: 'q1', text: '结论用中文还是英文？', options: ['中文', '英文'], default: '中文' } })).lastInsertRowid);
        return { item: `wi_${ev}`, delivery, qid };
      } finally { c.close(); }
    };
    const mineA = seedAsk('user:alpha'), theirsA = seedAsk('user:beta'), noPrinA = seedAsk(null), raceA = seedAsk('user:alpha'), rebindA = seedAsk('user:alpha'), seqA = seedAsk('user:alpha'), closedA = seedAsk('user:alpha'), fourA = seedAsk('user:alpha'), fourB = seedAsk('user:alpha');
    // twiceA：同一投递先问 q1、再问 q2（q1 被 q2 合上）
    const twiceA = seedAsk('user:alpha');
    { const c = new DatabaseSync(join(data, 'workbench-market.db')); c.exec('PRAGMA busy_timeout = 5000'); try {
      const ev = twiceA.item.slice(3);
      twiceA.q2 = Number(c.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:lab', 'receipt:attention', ?)").run(ev, twiceA.delivery, JSON.stringify({ summary: '第二个问题', disposition: 'attention', task: `${ev}.d${twiceA.delivery}.a1`, qid: 'q2', question: { id: 'q2', text: '第二个问题' } })).lastInsertRowid);
    } finally { c.close(); } }
    // closedA：提问之后来了接单回执，这条提问被合上（没人答）
    { const c = new DatabaseSync(join(data, 'workbench-market.db')); c.exec('PRAGMA busy_timeout = 5000'); try {
      const ev = closedA.item.slice(3);
      c.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:lab', 'receipt:acknowledged', ?)").run(ev, closedA.delivery, JSON.stringify({ summary: '接下', disposition: 'acknowledged', task: `${ev}.d${closedA.delivery}.a1` }));
    } finally { c.close(); } }
    const bf = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
      const { root } = await import(at('server/src/root-context.ts'));
      const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
      await root.plugin(WorkItemService);
      root.get('workItems').backfill();
      console.log('DONE');`], { env, encoding: 'utf8' });
    const st = (a) => { const c = db(); try { return c.prepare('SELECT state, creator_principal FROM work_items WHERE id = ?').get(a.item); } finally { c.close(); } };
    check(bf.stdout.includes('DONE') && st(mineA)?.state === 'blocked' && st(mineA)?.creator_principal === 'user:alpha' && st(noPrinA)?.creator_principal === null, '造数据：事项服务按正常路径建出「在问你」的事项（建立人主体取自 recorded）', show({ out: bf.stdout.slice(-200), err: bf.stderr.slice(-300), mine: st(mineA), noPrin: st(noPrinA) }));
    const ADMIN_H = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
    const asks = async (headers) => { const r = await call('GET', '/api/attention', headers); return { status: r.status, ids: (r.body?.items ?? []).filter((x) => x.source === 'seat-asks').map((x) => x.source_id), count: r.body?.sources?.['seat-asks']?.count ?? null, visible: r.body?.sources?.['seat-asks']?.visible ?? null }; };
    const ans = (a, headers, body = { answer: '中文' }) => call('POST', `/api/work-items/${a.item}/asks/${a.qid}/answer`, headers, body);
    const answered = (a) => { const c = db(); try { return c.prepare("SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ? AND fact = 'answer' AND rejected = ''").get(a.item).n; } finally { c.close(); } };
    const sentAnswers = (a) => { const c = db(); try { return c.prepare("SELECT COUNT(*) AS n FROM workbench_event_replies WHERE kind = 'answer' AND delivery_id = ?").get(a.delivery).n; } finally { c.close(); } };

    const la = await asks(ALPHA);
    check(la.status === 200 && la.ids.includes(String(mineA.delivery)) && !la.ids.includes(String(theirsA.delivery)) && !la.ids.includes(String(noPrinA.delivery)) && la.count === la.ids.length,
      '「关注」：alpha 只看到自己事项上的席位提问；别人的、建立人主体为空的都不列，条数按看得到的算', show(la));
    const ad = await asks(ADMIN_H);
    check([mineA, theirsA, noPrinA].every((a) => ad.ids.includes(String(a.delivery))), '「关注」：管理员照旧看全部', show(ad.ids));
    const lb = await asks({ ...SAME, cookie: `session_id=${SESSIONS.forged}` });
    check(lb.ids.length === 0 && lb.visible === false && lb.count === 0, 'A5「关注」：提供方不认的会话——席位的提问不可见、0 条', show(lb));
    const lan = await asks({ ...SAME, 'x-forwarded-for': '198.51.100.7' });
    check(lan.ids.length === 0 && lan.visible === false && lan.count === 0, 'A5「关注」：远程匿名——席位的提问不可见、0 条', show(lan));

    const denials = [
      ['别人的事项（alpha 答 beta 的）', () => ans(theirsA, ALPHA), 404, 'work_item_not_found', theirsA],
      ['建立人主体为空（alpha 答）', () => ans(noPrinA, ALPHA), 404, 'work_item_not_found', noPrinA],
      ['跨站请求', () => ans(mineA, { ...ALPHA, 'sec-fetch-site': 'cross-site' }), 403, 'work_items_cross_origin_denied', mineA],
      ['别的站的页面', () => ans(mineA, { ...ALPHA, origin: 'https://elsewhere.example' }), 403, 'work_items_cross_origin_denied', mineA],
      ['未登录（远程匿名）', () => ans(mineA, { ...SAME, 'x-forwarded-for': '198.51.100.7' }), 401, 'work_items_auth_required', mineA],
      ['提供方不认的会话', () => ans(mineA, { ...SAME, cookie: `session_id=${SESSIONS.forged}` }), 401, 'work_items_auth_required', mineA],
      ['被停用的建立人（beta 答自己的）', () => ans(theirsA, BETA), [401, 403], null, theirsA],
      ['提问编号是别的事项的（alpha 拿 beta 事项上那条提问的编号）', () => call('POST', `/api/work-items/${mineA.item}/asks/${theirsA.qid}/answer`, ALPHA, { answer: '中文' }), 404, 'seat_ask_not_found', theirsA],
      ['正文为空', () => ans(mineA, ALPHA, { text: '  ' }), 400, 'text_required', mineA],
      ['带选项的提问，answer 不在选项里', () => ans(mineA, ALPHA, { answer: '法文' }), 400, 'answer_not_an_option', mineA],
      ['请求体夹带自报的主体、答法（只认文本，照样被认人拦）', () => ans(theirsA, ALPHA, { text: '中文', principal: 'user:beta', as: 'user:beta', answer: 'release' }), 404, 'work_item_not_found', theirsA],
    ];
    for (const [label, run, st, err, a] of denials) {
      const before = answered(a), sentBefore = sentAnswers(a);
      const res = await run();
      const sts = Array.isArray(st) ? st : [st];
      const e = res.body?.result?.error ?? res.body?.error;
      check(sts.includes(res.status) && (!err || e === err) && answered(a) === before && sentAnswers(a) === sentBefore, `答席位提问·${label}：被拒（${res.status} ${e ?? ''}），不记答复、不发回`, show(res));
    }
    const notItem = await call('POST', '/api/work-items/not-an-item/asks/1/answer', ALPHA, { text: '中文' });
    check(notItem.status === 403, '答席位提问·路径不是事项 id 的样子：写请求总门照旧拦', show(notItem));
    const badDel = await call('POST', `/api/work-items/${mineA.item}/asks/0x1/answer`, ALPHA, { text: '中文' });
    check(badDel.status === 403, '答席位提问·提问编号不合形状：写请求总门照旧拦', show(badDel));
    const page0 = await call('GET', `/api/work-items/${mineA.item}`, ALPHA);
    const a0 = (page0.body?.asks ?? []).find((x) => x.id === mineA.qid);
    check(page0.status === 200 && a0 && a0.status === 'open' && a0.question === '结论用中文还是英文？' && JSON.stringify(a0.options) === JSON.stringify(['中文', '英文']) && a0.default === '中文' && a0.answer === undefined,
      '事项详情带结构化的提问列表：id、question、options、default、status=open', show(page0.body?.asks));
    const pageB = await call('GET', `/api/work-items/${theirsA.item}`, ALPHA);
    check(pageB.status === 404 && pageB.body?.asks === undefined, '别人事项的详情（连同提问列表）alpha 读不到', show(pageB));

    const ok1 = await ans(mineA, ALPHA, { answer: '中文', text: '这句被忽略' });
    check(ok1.status === 200 && ok1.body?.result?.sent === true && answered(mineA) === 1 && sentAnswers(mineA) === 1, '建立人 alpha 答自己事项上的提问：记下答复，作为同一 context 的新任务排发', show(ok1));
    const page1 = await call('GET', `/api/work-items/${mineA.item}`, ALPHA);
    const a1 = (page1.body?.asks ?? []).find((x) => x.id === mineA.qid);
    check(a1?.status === 'answered' && a1.answer === '中文' && a1.answered_by === 'user:alpha' && typeof a1.answered_at === 'string' && (page1.body?.asks ?? []).filter((x) => x.id === mineA.qid).length === 1,
      '……详情里这条变 answered，带答了什么（选了选项时以选项为准）、谁答的；同一问题只出现一次', show(page1.body?.asks));
    const la2 = await asks(ALPHA);
    check(!la2.ids.includes(String(mineA.delivery)), '……答完「关注」里不再列', show(la2.ids));
    const again = await ans(mineA, ALPHA, { text: '英文' });
    check(again.status === 200 && again.body?.duplicate === true && answered(mineA) === 1 && sentAnswers(mineA) === 1, '……再答一次：返回第一次的结果，不再发', show(again));

    // A3：已合上（没人答、被接单回执合上）的提问再答 → 409，不记不发
    { const before = answered(closedA), sb = sentAnswers(closedA);
      const r3 = await ans(closedA, ALPHA, { answer: '中文' });
      check(r3.status === 409 && (r3.body?.result?.error ?? r3.body?.error) === 'seat_ask_not_pending' && answered(closedA) === before && sentAnswers(closedA) === sb, 'A3：已合上的提问再答：409 seat_ask_not_pending，不记答复、不发回', show(r3)); }
    // A3·同一投递再问：用被合上的 q1 的编号答 → 409，不能被记成对 q2 的答复
    { const before = answered(twiceA), sb = sentAnswers(twiceA);
      const r3b = await ans(twiceA, ALPHA, { text: '答的是 q1' });
      const askList = (await call('GET', `/api/work-items/${twiceA.item}`, ALPHA)).body?.asks ?? [];
      const q2 = askList.find((x) => x.id === twiceA.q2), q1 = askList.find((x) => x.id === twiceA.qid);
      check(r3b.status === 409 && (r3b.body?.result?.error ?? r3b.body?.error) === 'seat_ask_not_pending' && q2?.status === 'open' && q1?.status === 'closed' && answered(twiceA) === before && sentAnswers(twiceA) === sb,
        'A3：同一投递先问 q1、再问 q2，用 q1 的编号答：409，q2 仍在等，不记不发', show({ r3b, q1, q2 })); }
    // 持有管理层授予的人（user:no-flag，上面 L20 那一段授的）：能代办答提问
    const MGMT = { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` };
    // L21 口径：答席位的提问是替建立人做业务决定——建立人本人，或持有管理层授予的人；只过了管理门的（管理口令、没有管理层授予的会话管理员）不能答。
    // 四种身份分别看：详情的 can.answer、「关注」里给不给答法、事项入口真去答、「关注」入口真去答
    {
      const SADMIN = { ...SAME, cookie: `session_id=${SESSIONS.admin}` };
      // 身份来源说是管理员的人，第一次见到时只迁出 member、系统管理员两条，不迁管理层（judgment-compare 的 migrateOnSight，L6）：他就是「只过了管理门」的人
      await call('GET', '/api/auth/viewer', SADMIN); await call('GET', '/api/attention', SADMIN); await call('GET', `/api/work-items/${fourA.item}`, SADMIN);
      const active = ((await call('GET', '/api/grants?principal=user:root-admin&status=active', {})).body?.grants ?? []).map((g) => g.role ?? g.role_id);
      check(active.includes('admin') && !active.includes('management'), '造数据：会话管理员被迁了系统管理员、没有管理层授予（管理门照旧过）', show({ active }));
      const canAns = async (a, h) => (await call('GET', `/api/work-items/${a.item}`, h)).body?.can?.answer;
      const listed = async (a, h) => ((await call('GET', '/api/attention', h)).body?.items ?? []).find((x) => x.source === 'seat-asks' && x.source_id === String(a.delivery))?.answers ?? null;
      const viaAttn = (a, h, text) => call('POST', '/api/attention/answer', h, { source: 'seat-asks', source_id: String(a.delivery), answer: 'answer', input: { text } });
      for (const [who, h] of [['管理口令', ADMIN_H], ['会话登录的管理员（没有管理层授予）', SADMIN]]) {
        // 这两种身份过了读的门（管理门），事项详情读得到（200）——所以不能答回 403，不是 404（读不到的才和不存在一样回 404）
        const readable = (await call('GET', `/api/work-items/${fourA.item}`, h)).status;
        const c1 = await canAns(fourA, h), l1 = await listed(fourA, h);
        const b0 = answered(fourA) + answered(fourB), s0 = sentAnswers(fourA) + sentAnswers(fourB);
        const r1 = await ans(fourA, h), r2 = await viaAttn(fourB, h, '管理门答');
        const e1 = r1.body?.error ?? r1.body?.result?.error, e2 = r2.body?.error ?? r2.body?.result?.error;
        check(readable === 200 && c1 === false && (l1 === null || l1.length === 0) && r1.status === 403 && e1 === 'seat_ask_answer_forbidden' && [400, 403].includes(r2.status)
          && answered(fourA) + answered(fourB) === b0 && sentAnswers(fourA) + sentAnswers(fourB) === s0,
          `L21·${who}：读得到这件事项（详情 200），但 can.answer 为假、「关注」不给答法；事项入口 403（读得到、不能答）、「关注」入口被拒；不记答复、不发回`, show({ readable, c1, l1, r1: [r1.status, e1], r2: [r2.status, e2] }));
      }
      const cc = await canAns(fourA, ALPHA), lc = await listed(fourA, ALPHA);
      check(cc === true && JSON.stringify(lc) === JSON.stringify(['answer']), 'L21·建立人本人：详情 can.answer 为真、「关注」给答法', show({ cc, lc }));
      const cm = await canAns(fourA, MGMT), lm = await listed(fourA, MGMT);
      const m1 = await ans(fourA, MGMT, { answer: '英文' }), m2 = await viaAttn(fourB, MGMT, '管理层代办答');
      const late = await ans(fourA, ALPHA, { answer: '中文' });
      check(cm === true && JSON.stringify(lm) === JSON.stringify(['answer']) && m1.status === 200 && m1.body?.result?.ok === true && m2.status === 200 && m2.body?.result?.ok === true
        && answered(fourA) === 1 && answered(fourB) === 1 && sentAnswers(fourA) === 1 && sentAnswers(fourB) === 1 && late.status === 409,
        'L21·持有管理层授予的人：详情 can.answer 为真、「关注」给答法；事项入口、「关注」入口都答得了（代办），各记一次、各发一条；建立人再答 409', show({ cm, lm, m1: [m1.status, m1.body?.result], m2: [m2.status, m2.body?.result], late: late.status }));
    }
    // A8：管理层先在「关注」里代办答，建立人再在事项入口答同一条 → 只生效一次、只发一条
    { const a1 = await call('POST', '/api/attention/answer', MGMT, { source: 'seat-asks', source_id: String(seqA.delivery), answer: 'answer', input: { text: '管理层代办答' } });
      const a2 = await ans(seqA, ALPHA, { answer: '英文' });
      check(a1.status === 200 && a2.status === 409 && (a2.body?.result?.error ?? a2.body?.error) === 'attention_already_answered' && a2.body?.duplicate !== true && answered(seqA) === 1 && sentAnswers(seqA) === 1, 'A8：管理层（代办）和建立人先后答同一条：第二次 409 已处理（#657：别人答过的不给第一次的结果），只生效一次、只发一条', show({ a1: a1.status, a2: a2.status, body: a2.body })); }
    // 同一提问两个人同时答（管理层经「关注」代办、建立人经事项入口）：一个生效，另一个被告知已处理
    const [x, y] = await Promise.all([
      call('POST', '/api/attention/answer', MGMT, { source: 'seat-asks', source_id: String(raceA.delivery), answer: 'answer', input: { text: '管理层代办答' } }),
      ans(raceA, ALPHA, { text: '建立人答（自由文本）' }),
    ]);
    const xs = x.body?.result ?? x.body, ys = y.body?.result ?? y.body;
    const winners = [x.status === 200 && x.body?.duplicate !== true && xs?.ok === true, y.status === 200 && y.body?.duplicate !== true && ys?.ok === true].filter(Boolean).length;
    check(winners === 1 && answered(raceA) === 1 && sentAnswers(raceA) === 1, '同一提问管理层（代办）和建立人同时答：只有一个生效、只发一次，另一个被告知已处理', show({ x: [x.status, x.body?.duplicate, xs], y: [y.status, y.body?.duplicate, ys] }));
    out.rebindAsk = rebindA;
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
    const rb = out.rebindAsk;
    const rbList = await call('GET', '/api/attention', ALPHA);
    const rbAns = await call('POST', `/api/work-items/${rb.item}/asks/${rb.qid}/answer`, ALPHA, { answer: '中文' });
    check(!(rbList.body?.items ?? []).some((x) => x.source === 'seat-asks' && x.source_id === String(rb.delivery)) && rbAns.status === 404, '改绑之后同一个登录名 alpha：原来 alpha 事项上的席位提问看不到、答不了', show({ status: rbAns.status }));
  }
  // ---------- 启动自检 ----------
  check(/"id":"market\.work-items\.creator-decision-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名打这个入口必须 401，而且过了');
  check(/"id":"market\.work-items\.seat-reply-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名回复席位消息必须 401，而且过了');
  check(/"id":"market\.work-items\.seat-ask-answer-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名回答席位提问必须 401，而且过了');
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
