#!/usr/bin/env node
/**
 * 事项的优先级（#941 第 1a 步，docs/task-goal-verify-design.md 第 4、7 条）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   P1 安排时：不填是 P2；填 P0～P3 照记；记在事件的 recorded 那一行，不进发给接单团队的派工正文
 *   P2 安排时填错（P9、小写 p1、数字）：400 priority_invalid，并列出能填的
 *   P3 幂等：没填优先级的旧请求体哈希不变（同键重放还是同一件）；同一个键加上优先级就是不同的请求体，409；
 *      没填优先级时，库里记的请求体哈希和改动前的算法逐字节相同（钉成常量，#969 验收 q5）
 *   P4 改：建立人本人 200（as: creator），事项上的优先级跟着变，事件日志记一行 priority-changed（从几到几、谁、以什么身份）
 *   P5 谁不能改：没登录 401；跨站 403；看不到这件的人 404（不说有没有），只过了管理门的系统管理员也看不到、也 404；坏参数 400。
 *      看得到、不是建立人也没有管理层授予的（团队负责人，带不带管理口令）403，在 work-item-lead-release-test 里测；
 *      建立人本人、但事项只能由管理员处理（来源未验证）403；建立人的主体停用了 401（认不出）（#969 验收）
 *   P6 持有管理层授予的人：能改（as: management），详情的 can.priority 为真
 *   P7 事项结束了：409，优先级不变
 *   P8 列表带上优先级
 *   P9 重建：事项表清掉后全量回填，优先级按事件日志里最后一条 priority-changed 回来；没改过的按安排时填的
 *
 *   node scripts/work-item-priority-test.mjs              测本仓库
 *   node scripts/work-item-priority-test.mjs --root DIR   测另一棵目录树
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
const OUT = join(HERE, '..', 'tmp', `work-item-priority-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'priority-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
let keyN = 0;
const key = () => `priority-key-${String(++keyN).padStart(8, '0')}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid',
    // 假来源里的管理员 root-admin 只给一条 admin 授予（系统管理员，不是属主、没有管理层）：测「只过了管理门的改不了」；P6 再给他管理层授予
    IDENTITY_FAKE_ADMIN_GRANT: 'admin' };
  // 任务中心上一个通知团队：安排一件事派给它
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by, revoked_at) VALUES ('sop', 'task-center', 'dsh/canvas/team-a', 'notify', 'read', 'http://127.0.0.1:1', 'seed', '')").run();
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
  const ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, BETA = { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, ROOTA = { ...SAME, cookie: `session_id=${SESSIONS.admin}` };
  for (const h of [ALPHA, BETA, ROOTA]) await call('GET', '/api/auth/me', h); // 先认一次，主体表里才有
  await call('PUT', '/api/settings', { ...SAME, 'x-admin-token': ADMIN_TOKEN }, { arrange_rate_per_minute: '100' }); // alpha 要连着建好几件；限流由 arrange-test 测
  const dbr = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
    const q = (sql, ...a) => { const d = dbr(); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };
  const form = (extra = {}) => ({ title: '合成：对一下出货', intent: '合成：把出货单和对账单对一遍', deliverable: '合成：一张差异表', team: 'dsh/canvas/team-a', idempotency_key: key(), ...extra });
  const prio = (id, headers, body) => call('POST', `/api/work-items/${id}/priority`, headers, body);
  const detail = (id, headers = ALPHA) => call('GET', `/api/work-items/${id}`, headers);

  console.log('P1 安排时的优先级');
  const plain = await call('POST', '/api/work-items', ALPHA, form());
  const p0 = await call('POST', '/api/work-items', ALPHA, form({ priority: 'P0' }));
  const p3 = await call('POST', '/api/work-items', ALPHA, form({ priority: 'P3' }));
  const dPlain = await detail(plain.body?.item_id), dP0 = await detail(p0.body?.item_id), dP3 = await detail(p3.body?.item_id);
  const recOf = (ev) => q("SELECT detail FROM workbench_event_log WHERE event_id = ? AND action = 'recorded'", ev).map((r) => JSON.parse(r.detail))[0] ?? {};
  const msgOf = (ev) => q('SELECT message FROM workbench_event_deliveries WHERE event_id = ?', ev).map((r) => r.message);
  check(plain.status === 201 && p0.status === 201 && p3.status === 201 && dPlain.body?.priority === 'P2' && dP0.body?.priority === 'P0' && dP3.body?.priority === 'P3',
    'P1 不填是 P2；填 P0、P3 照记', show({ st: [plain.status, p0.status, p3.status], pr: [dPlain.body?.priority, dP0.body?.priority, dP3.body?.priority] }));
  check(recOf(p0.body?.event_id).priority === 'P0' && recOf(plain.body?.event_id).priority === undefined && msgOf(p0.body?.event_id).length === 1 && msgOf(p0.body?.event_id).every((m) => !m.includes('priority')),
    'P1 记在事件的 recorded 那一行（没填不写）；派工正文里没有优先级', show({ rec0: recOf(p0.body?.event_id), recPlain: recOf(plain.body?.event_id) }));

  console.log('P2 安排时填错');
  const bads = [];
  for (const v of ['P9', 'p1', 1, 'P0 ', ['P1']]) bads.push(await call('POST', '/api/work-items', ALPHA, form({ priority: v })));
  check(bads.every((r) => r.status === 400 && r.body?.error === 'priority_invalid' && show(r.body?.allowed) === show(['P0', 'P1', 'P2', 'P3'])),
    'P2 P9、小写 p1、数字、带空格、数组：都 400 priority_invalid，并列出能填的', show(bads.map((r) => [r.status, r.body?.error])));

  console.log('P3 幂等');
  const f = form();
  const first = await call('POST', '/api/work-items', ALPHA, f);
  const again = await call('POST', '/api/work-items', ALPHA, f);
  const withP = await call('POST', '/api/work-items', ALPHA, { ...f, priority: 'P1' });
  check(first.status === 201 && again.status === 200 && again.body?.duplicate === true && again.body?.item_id === first.body?.item_id && withP.status === 409 && withP.body?.error === 'idempotency_conflict',
    'P3 没填优先级的同键重放还是同一件；同一个键加上优先级是不同的请求体，409', show({ first: first.status, again: [again.status, again.body?.duplicate], withP: [withP.status, withP.body?.error] }));

  // 钉住哈希（#969 验收 q5）：没填优先级时请求体和改动前一样。常量照改动前（main 538e12f5）task-center.ts 的拼法算：
  //   JSON.stringify({ title, intent, deliverable, team, object, phase, due, review })，选填的不带；本 PR 不填优先级时必须一字不差
  const PINNED = [
    [{ title: '合成：钉住哈希', intent: '合成：只有必填项', deliverable: '合成：一行', team: 'dsh/canvas/team-a' }, 'b499cded6609495fbdd612fe02bb29cd1ab0344b0302e2b0f1df442054e4c297'],
    [{ title: '合成：钉住哈希二', intent: '合成：另带对象阶段截止', deliverable: '合成：一行', team: 'dsh/canvas/team-a', object: 'po:7', phase: 'p2', due: '2099-03-04', review: false }, 'daec930237692fc5162ac00239781fde809f66a0005ed83fb01d53d8bed77c4a'],
  ];
  const pinned = [];
  for (const [body, want] of PINNED) {
    const k = key();
    const r = await call('POST', '/api/work-items', ALPHA, { ...body, idempotency_key: k });
    pinned.push({ st: r.status, got: q('SELECT body_sha256 AS h FROM work_item_requests WHERE idem_key = ?', k)[0]?.h, want });
  }
  check(pinned.every((x) => x.st === 201 && x.got === x.want), 'P3 没填优先级：库里记的请求体哈希和改动前逐字节相同（两个钉住的常量）', show(pinned));

  console.log('P4 建立人改');
  const id = plain.body?.item_id, ev = plain.body?.event_id;
  const canAlpha = dPlain.body?.can?.priority;
  const ch = await prio(id, ALPHA, { priority: 'P1' });
  const same = await prio(id, ALPHA, { priority: 'P1' });
  const trail = q("SELECT actor, detail FROM workbench_event_log WHERE event_id = ? AND action = 'priority-changed' ORDER BY id", ev).map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));
  check(canAlpha === true && ch.status === 200 && ch.body?.priority === 'P1' && ch.body?.from === 'P2' && ch.body?.changed === true && ch.body?.as === 'creator' && (await detail(id)).body?.priority === 'P1',
    'P4 建立人本人（can.priority 为真）：P2 → P1，应答 as: creator，事项上的优先级跟着变', show({ canAlpha, ch }));
  check(same.status === 200 && same.body?.changed === false && trail.length === 2 && show(trail[0]) === show({ actor: 'user:alpha', from: 'P2', to: 'P1', as: 'creator' }) && trail[1].from === 'P1' && trail[1].to === 'P1',
    'P4 每次改都在事件日志记一行 priority-changed（从几到几、谁、以什么身份）；和原来一样也照记，应答 changed:false', show({ same: same.body, trail }));

  console.log('P5 谁不能改');
  const anon = await prio(id, { 'x-forwarded-for': '198.51.100.7' }, { priority: 'P3' });
  const cross = await prio(id, { cookie: `session_id=${SESSIONS.alpha}`, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, { priority: 'P3' });
  const beta = await prio(id, BETA, { priority: 'P3' });
  const betaNone = await prio('wi_wbe-0000000000000000', BETA, { priority: 'P3' });
  const rootNoGrant = await prio(id, ROOTA, { priority: 'P3' });
  const rootCan = (await detail(id, ROOTA)).body?.can?.priority;
  const badBody = [await prio(id, ALPHA, {}), await prio(id, ALPHA, { priority: 'P4' }), await prio(id, ALPHA, { priority: null })];
  const stillP1 = (await detail(id)).body?.priority;
  check(anon.status === 401, 'P5 没登录：401', show(anon));
  check(cross.status === 403 && cross.body?.error === 'work_items_cross_origin_denied', 'P5 跨站：403', show(cross));
  check(beta.status === 404 && betaNone.status === 404 && show(beta.body) === show(betaNone.body), 'P5 看不到这件的人：404，和不存在的一字不差', show({ beta, betaNone }));
  // 只过了管理门的系统管理员看不到事项（work-item-access 的 itemRoles），所以是 404，不是 403；看得到、不归他改的 403 在 work-item-lead-release-test（负责人）
  check(rootNoGrant.status === 404 && rootNoGrant.body?.error === 'work_item_not_found',
    'P5 只过了管理门、没有管理层授予的系统管理员：看不到事项，404（不归他改）', show({ rootNoGrant, rootCan }));
  check(badBody.every((r) => r.status === 400 && r.body?.error === 'priority_invalid') && stillP1 === 'P1', 'P5 没写、P4、null：400；被拒的都没改动', show({ bad: badBody.map((r) => r.status), stillP1 }));

  // 建立人本人、但事项只能由管理员处理（来源未验证、不是票据认出的：creatorCheck 为 not_eligible）：看得到、改不了（#969 验收）
  const mk = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    await root.plugin(WorkItemService);
    const it = root.get('workItems').create({ title: '合成：来源未验证', created_by: 'user:alpha', creator_principal: 'user:alpha', source_kind: 'agent', context: { submitter_kind: 'unverified' } });
    console.log('ITEM=' + it.id);`], { env, encoding: 'utf8' });
  const unv = /ITEM=(\S+)/.exec(mk.stdout)?.[1];
  if (!unv) throw new Error(`造来源未验证的事项没成：${mk.stderr.slice(-300)}`);
  const unvPost = await prio(unv, ALPHA, { priority: 'P0' });
  const unvCan = (await detail(unv)).body?.can?.priority;
  check(unvPost.status === 403 && unvPost.body?.error === 'work_item_priority_not_yours' && unvCan === false,
    'P5 建立人本人、但事项来源未验证（只能由管理员处理）：403，can.priority 为假', show({ unvPost, unvCan }));
  // 建立人不是启用的人（#969 验收）：身份服务每次现查主体状态，停用的认不出，401（不会走到「认得出、但不是启用的人」那一步）。
  // 主体表的约束又规定 user: 开头的只能是 person，所以经会话登录的人「认得出却不是启用的人」造不出来；priorityWriter 里那一道是兜底
  const setStatus = (v) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 }); try { d.prepare('UPDATE principals SET status = ? WHERE id = ?').run(v, 'user:alpha'); } finally { d.close(); } };
  let offPost, offRow;
  setStatus('disabled');
  try { offPost = await prio(id, ALPHA, { priority: 'P3' }); offRow = q('SELECT priority FROM work_items WHERE id = ?', id)[0]?.priority; } finally { setStatus('active'); }
  check(offPost.status === 401 && offRow === 'P1', 'P5 建立人的主体停用了：认不出，401，优先级不变', show({ offPost, offRow }));

  console.log('P6 持有管理层授予的人');
  const g = await call('POST', '/api/grants', {}, { principal: 'user:root-admin', role: 'management', scope: '*', reason: '合成：管理层改优先级' });
  if (!g.body?.grant?.id) throw new Error(`管理层授予起草失败：${show(g)}`);
  await call('POST', `/api/grants/${g.body.grant.id}/submit`, {}, {});
  const ga = await call('POST', `/api/grants/${g.body.grant.id}/approve`, {}, {});
  if (!(ga.status >= 200 && ga.status < 300)) throw new Error(`管理层授予没搭起来：${show(ga)}`);
  const mCan = (await detail(id, ROOTA)).body?.can?.priority;
  const m = await prio(id, ROOTA, { priority: 'P0' });
  const mTrail = q("SELECT actor, detail FROM workbench_event_log WHERE event_id = ? AND action = 'priority-changed' ORDER BY id DESC LIMIT 1", ev).map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))[0];
  check(mCan === true && m.status === 200 && m.body?.as === 'management' && m.body?.from === 'P1' && (await detail(id)).body?.priority === 'P0' && mTrail?.actor === 'user:root-admin' && mTrail?.as === 'management',
    'P6 持有管理层授予：can.priority 为真，P1 → P0，应答和留痕都记 as: management', show({ mCan, m, mTrail }));

  console.log('P7 事项结束了');
  // 事项状态只能经事项服务推进：等过目（held）的事项撤回就是 cancelled
  const wd = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    await root.plugin(WorkItemService);
    const r = root.get('workItems').apply(${JSON.stringify(p3.body?.item_id)}, { kind: 'withdraw', source: 'seed', id: 'priority-test-withdraw', actor: 'user:alpha' });
    console.log(r.ok && r.state === 'cancelled' ? 'WITHDRAWN' : 'FAIL ' + JSON.stringify(r));`], { env, encoding: 'utf8' });
  if (!wd.stdout.includes('WITHDRAWN')) throw new Error(`撤回没成：${wd.stdout.slice(-300)} ${wd.stderr.slice(-300)}`);
  const ended = await prio(p3.body?.item_id, ALPHA, { priority: 'P0' });
  const endedD = await detail(p3.body?.item_id);
  check(ended.status === 409 && ended.body?.error === 'work_item_ended' && endedD.body?.priority === 'P3' && endedD.body?.can?.priority === false
      && q("SELECT COUNT(*) AS n FROM workbench_event_log WHERE event_id = ? AND action = 'priority-changed'", p3.body?.event_id)[0].n === 0,
    'P7 结束了的事项：409，优先级不变、不留痕，can.priority 为假', show({ ended, pr: endedD.body?.priority }));

  console.log('P8 列表');
  const list = await call('GET', '/api/work-items', ALPHA);
  const rows = list.body?.items ?? list.body?.rows ?? [];
  const row = (rid) => rows.find((r) => r.id === rid);
  check(list.status === 200 && row(id)?.priority === 'P0' && row(p0.body?.item_id)?.priority === 'P0' && row(first.body?.item_id)?.priority === 'P2',
    'P8 列表每行带优先级', show({ st: list.status, keys: Object.keys(list.body ?? {}), row: row(id) }));

  console.log('P9 重建');
  {
    const prOf = (conn) => Object.fromEntries(conn.prepare("SELECT id, priority FROM work_items WHERE source_ref LIKE 'wbe-%' ORDER BY id").all().map((r) => [r.id, r.priority]));
    const live = dbr(); let before = {};
    const rebuildDir = join(OUT, 'rebuild');
    mkdirSync(rebuildDir, { recursive: true });
    try { before = prOf(live); live.exec(`VACUUM INTO '${join(rebuildDir, 'workbench-market.db').replace(/'/g, "''")}'`); } finally { live.close(); }
    const rw = new DatabaseSync(join(rebuildDir, 'workbench-market.db'));
    try { rw.exec('DROP TABLE work_item_log; DROP TABLE work_items;'); } finally { rw.close(); }
    const rb = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
      const { WorkItemService } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
      await root.plugin(WorkItemService); root.get('workItems').backfill(); console.log('BACKFILLED');`], { env: { PATH: process.env.PATH, HOME: home, DATA_DIR: rebuildDir, NODE_ENV: 'test' }, encoding: 'utf8' });
    let after = { error: rb.stderr.slice(-400) };
    if (rb.stdout.includes('BACKFILLED')) { const c = new DatabaseSync(join(rebuildDir, 'workbench-market.db'), { readOnly: true }); try { after = prOf(c); } finally { c.close(); } }
    check(before[id] === 'P0' && before[p0.body?.item_id] === 'P0' && before[p3.body?.item_id] === 'P3' && show(after) === show(before),
      'P9 事项表清掉后全量重建：改过的按最后一条 priority-changed 回来，没改过的按安排时填的，和重建前逐件相同', show({ before, after }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\nwork-item-priority-test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
