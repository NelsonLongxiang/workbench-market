#!/usr/bin/env node
// 工作台事件层 v1 冒烟（契约：dsh-open-a2a-net docs/protocol/workbench-event.md）。
// 隔离 DATA_DIR + 本机回环假对端；对端用上游 verifyOriginClaim 按「不绑定窗已关」验每次投递。
// 判据：
//   W1 画布队名可作通知绑定的 agent_node（旧正则 400）
//   W2 开关没全开 → 投递 held，对端收 0；W3 release 后投出，信封字段齐、task_id=event_id、来源签名过验、明文 token 投后清空
//   W4 决定端点：错 token 404 / 缺理由 400 / ask→accept 200 / 终态后再写 409；业务面浏览器请求可达（远程豁免）
//   W5 两开关全开 → 自动投递；目标 SOP 台命中 → routed=target
//   W6 对端前两次「登记幂等键后拒投」→ 退避重试后真的送达（不把 -32003 当已送达）；一直拒 → 5 次后 dead；
//      同机两个画布队各自送达（task_id 每次尝试唯一，不撞 -32002）；notify+both 双绑定按节点去重
//   W7 无任何通知绑定 → routed=unrouted、零投递（不静默丢）
//   W8 自产台表单提交 → submitter_kind=unverified、dispatch:false、无 reply、旧字段保留
//   W9 只增日志：UPDATE/DELETE 被触发器拒
//   W10 撤回 → 未发出的投递 cancelled、release 409；未送达的投递不能回写决定；token 送达 7 天后过期 410
//   W11 超过传输上限的载荷 → 一次即 dead（不重试 5 次）；W12 画布名与上游同规则（中文可、>40 / 纯数字拒）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const originSrc = process.env.A2A_ORIGIN_SRC ?? resolve('..', 'dsh-open-a2a-net', 'src', 'origin-claim.ts');
const { verifyOriginClaim } = await import(pathToFileURL(originSrc).href);

mkdirSync('tmp', { recursive: true });
const data = mkdtempSync(resolve('tmp', 'wbe-'));
const port = 21000 + Math.floor(Math.random() * 20000);
const base = 'http://127.0.0.1:' + port;
const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_TOKEN: 'wbe-test', MCP_GATEWAY: 'off', REDIS_URL: '', LAYERFS_SERVICE_URL: '', MARKET_PUBLIC_URL: base, A2A_OUTBOX_BACKOFF_SCALE: '0.0001' };
let child, logs = '', pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log('PASS ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假对端：mode 决定应答；每次投递都过上游裁判
// 假对端按上游 /a2a/direct 的顺序：先验来源、再按 task_id 登记幂等键（全机唯一，指纹=team+caller+message+wait），
// 登记之后才判能否投递——拒投时回 200 + -32000，同一 task_id 再来就是 409 -32003/-32002。
function makePeer() {
  const peer = { got: [], verdicts: [], claims: new Map(), failFirst: 0, alwaysFail: false };
  peer.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const verdict = await verifyOriginClaim(req, {
        cardCache: new Map(), audiences: [peer.base], unboundOpen: false, onUnbound: () => {}, now: Date.now(),
        fetch: (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, text: () => r.text() })),
      });
      peer.verdicts.push(verdict);
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const fp = JSON.stringify([parsed.team, parsed.caller_session, parsed.message, parsed.wait]);
      if (peer.claims.has(parsed.task_id)) {
        const replay = peer.claims.get(parsed.task_id) === fp;
        return reply(409, { error: replay ? 'duplicate task id within the idempotency window' : 'task id reused with a different payload', code: replay ? -32003 : -32002, task_id: parsed.task_id, replay });
      }
      peer.claims.set(parsed.task_id, fp);
      if (peer.alwaysFail || peer.failFirst > 0) {
        peer.failFirst--;
        return reply(200, { error: 'No live DSH session node accepts team ' + parsed.team, code: -32000, team: parsed.team, task_status: 'TASK_STATE_FAILED' });
      }
      peer.got.push(parsed);
      reply(200, { routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: parsed.task_id, context_id: parsed.context_id });
    });
  });
  return new Promise((r) => peer.server.listen(0, '127.0.0.1', () => { peer.base = 'http://127.0.0.1:' + peer.server.address().port; r(peer); }));
}

async function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => (logs += c)); child.stderr.on('data', (c) => (logs += c));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} if (child.exitCode !== null) break; await sleep(150); }
  throw new Error('fixture boot failed ' + logs.slice(-800));
}
async function stop() { if (child?.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } }
async function call(path, body, method = 'POST', headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'wbe-test', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j; try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, j };
}
async function waitFor(cond, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(100); } return false; }
const dbRead = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });

async function publishTask(values, agentDispatch) {
  const run = await call('/api/sop/runs', { slug: 'task-center' });
  assert.equal(run.status, 201, JSON.stringify(run.j));
  for (const [k, v] of Object.entries(values)) assert.equal((await call('/api/sop/runs/' + run.j.id, { stepKey: k, value: v }, 'PUT')).status, 200);
  await call('/api/sop/runs/' + run.j.id + '/finish', {});
  const pub = await call('/api/task-center/tasks', { intake_run_id: run.j.id, published_by: 'owner', agent_dispatch: agentDispatch });
  assert.equal(pub.status, 201, JSON.stringify(pub.j));
  return pub.j;
}
const eventOf = async (id) => (await call('/api/workbench-events/' + id, undefined, 'GET')).j;

const peers = [];
try {
  const ok = await makePeer(); const flaky = await makePeer(); const down = await makePeer();
  peers.push(ok, flaky, down);
  await start();

  const bind = await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/intake', direction: 'notify', notify_url: ok.base });
  await check('W1 画布队名可作通知绑定的 agent_node', () => assert.equal(bind.status, 201, JSON.stringify(bind.j)));

  // W2：中心开关默认关 → held
  const values = { title: '采购对账', intent: '核对十月 PO', references: [], deliverable: '差异表', target: '', due: '2026-11-09' };
  const t1 = await publishTask(values, true);
  await check('W2a 发布返回 event_id', () => assert.match(String(t1.event_id), /^wbe-[0-9a-f]{16}$/));
  const e1 = await eventOf(t1.event_id);
  await check('W2b 事件 human / 默认接单团队 / 投递 held', () => {
    assert.equal(e1.submitter_kind, 'human'); assert.equal(e1.submitter, 'human:owner'); assert.equal(e1.routed, 'default');
    assert.equal(e1.data_sha256, t1.material_sha256);
    assert.equal(e1.deliveries.length, 1); assert.equal(e1.deliveries[0].status, 'held'); assert.equal(e1.deliveries[0].target_team, 'dsh/canvas/intake');
  });
  await sleep(600);
  await check('W2c held 时对端收 0', () => assert.equal(ok.got.length, 0));

  // W3：release → 投出
  const rel = await call('/api/workbench-events/' + t1.event_id + '/release', {});
  await check('W3a release 200', () => assert.equal(rel.status, 200, JSON.stringify(rel.j)));
  await waitFor(() => ok.got.length >= 1);
  const env1 = JSON.parse(ok.got[0].message ?? '{}');
  await check('W3b 信封字段齐（契约 v1）', () => {
    assert.equal(ok.got[0].task_id, `${t1.event_id}.d${e1.deliveries[0].id}.a1`); assert.equal(ok.got[0].context_id, `wb:task-center:${t1.id}`);
    assert.equal(ok.got[0].team, 'dsh/canvas/intake'); assert.match(String(ok.got[0].caller_session), /^market\/[0-9a-f]{8}$/);
    assert.equal(ok.got[0].wait, false);
    assert.equal(env1.type, 'workbench-event'); assert.equal(env1.v, 1); assert.equal(env1.event_id, t1.event_id);
    assert.equal(env1.submitter_kind, 'human'); assert.equal(env1.dispatch, true); assert.equal(env1.data_sha256, t1.material_sha256);
    assert.equal(env1.task.title, '采购对账'); assert.equal(env1.task.due, '2026-11-09');
    assert.equal(env1.reply.url, `${base}/api/workbench-events/${t1.event_id}/decision`); assert.ok(env1.reply.token.length >= 32);
  });
  await check('W3c 来源签名过上游裁判（窗已关·绑定形式）', () => assert.deepEqual([ok.verdicts.at(-1).ok, ok.verdicts.at(-1).bound], [true, true]));
  await waitFor(async () => (await eventOf(t1.event_id)).deliveries[0].status === 'sent');
  {
    const db = dbRead();
    const row = db.prepare('SELECT status, message, reply_token_sha256 FROM workbench_event_deliveries WHERE event_id = ?').get(t1.event_id);
    db.close();
    await check('W3d sent 后明文信封清空、只留 token 哈希', () => { assert.equal(row.status, 'sent'); assert.equal(row.message, ''); assert.equal(row.reply_token_sha256.length, 64); });
  }
  await check('W3e 读面不出现 token', async () => assert.ok(!JSON.stringify(await eventOf(t1.event_id)).includes(env1.reply.token)));
  await check('W3f 再次 release → 409', async () => assert.equal((await call('/api/workbench-events/' + t1.event_id + '/release', {})).status, 409));

  // W4：决定端点（模拟业务面上的远程/浏览器请求：带 Sec-Fetch-Site、不带口令）
  const remote = { 'X-Admin-Token': '', 'Sec-Fetch-Site': 'cross-site' };
  const dpath = '/api/workbench-events/' + t1.event_id + '/decision';
  const bad = await call(dpath, { token: 'wrong', decision: 'accept', reason: 'x' }, 'POST', remote);
  await check('W4a 错 token → 404', () => assert.equal(bad.status, 404, JSON.stringify(bad.j)));
  await check('W4b 缺理由 / 非法决定 → 400', async () => {
    assert.equal((await call(dpath, { token: env1.reply.token, decision: 'accept' }, 'POST', remote)).status, 400);
    assert.equal((await call(dpath, { token: env1.reply.token, decision: 'merge', reason: 'x' }, 'POST', remote)).status, 400);
  });
  const ask = await call(dpath, { token: env1.reply.token, decision: 'ask', reason: '需要确认对账口径', by: 'dsh/66abc2cf' }, 'POST', remote);
  await check('W4c ask 200（远程面可达）', () => assert.equal(ask.status, 200, JSON.stringify(ask.j)));
  const acc = await call(dpath, { token: env1.reply.token, decision: 'accept', reason: '口径已确认', ref: 'https://github.com/NelsonLongxiang/dsh-open-a2a-net/issues/1', by: 'dsh/66abc2cf' }, 'POST', remote);
  await check('W4d ask 之后 accept 200', () => assert.equal(acc.status, 200, JSON.stringify(acc.j)));
  const again = await call(dpath, { token: env1.reply.token, decision: 'decline', reason: '改主意' }, 'POST', remote);
  await check('W4e 终态后再写 → 409', () => assert.equal(again.status, 409));
  const e1b = await eventOf(t1.event_id);
  await check('W4f 决定落在投递行、日志按序', () => {
    assert.equal(e1b.deliveries[0].decision, 'accept'); assert.equal(e1b.deliveries[0].decided_by, 'dsh/66abc2cf');
    assert.deepEqual(e1b.log.map((l) => l.action), ['recorded', 'held', 'released', 'sent', 'decision:ask', 'decision:accept']);
  });
  await check('W4g 列表需口令', async () => assert.equal((await call('/api/workbench-events', undefined, 'GET', { 'X-Admin-Token': '' })).status, 403));

  // W5：两开关全开 → 自动；目标台命中 → routed=target
  assert.equal((await call('/api/task-center/policy', { agent_dispatch_enabled: true }, 'PUT')).status, 200);
  const before = ok.got.length;
  const t2 = await publishTask({ ...values, title: '自动派发', target: 'task-center' }, true);
  await waitFor(() => ok.got.length > before);
  const e2 = await eventOf(t2.event_id);
  await check('W5 自动投递 + routed=target', () => { assert.equal(ok.got.length, before + 1); assert.equal(e2.routed, 'target'); assert.notEqual(e2.deliveries[0].status, 'held'); });
  const t2b = await publishTask({ ...values, title: '任务级关' }, false);
  await check('W5b 任务级开关关 → 仍 held', async () => assert.equal((await eventOf(t2b.event_id)).deliveries[0].status, 'held'));

  // W6：重试与 dead（worker 每 5s 一轮；退避倍率压到毫秒级）
  flaky.failFirst = 2; down.alwaysFail = true;
  await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/flaky', direction: 'notify', notify_url: flaky.base });
  await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/down', direction: 'notify', notify_url: down.base });
  await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/beta', direction: 'notify', notify_url: ok.base }); // 与 intake 同一台主机
  const dual = await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/intake', direction: 'both', notify_url: ok.base }); // 同节点再来一行 both
  await check('W6-pre notify+both 双绑定可建', () => assert.equal(dual.status, 201));
  const t3 = await publishTask({ ...values, title: '重试' }, true);
  const settled = await waitFor(async () => { const e = await eventOf(t3.event_id); return e.deliveries.every((d) => d.status === 'sent' || d.status === 'dead'); }, 40_000);
  const e3 = await eventOf(t3.event_id);
  const by = Object.fromEntries(e3.deliveries.map((d) => [d.target_team, d]));
  await check('W6a 四个目标各一行投递（双绑定按节点去重、发布不 500）', () => { assert.ok(settled, JSON.stringify(e3.deliveries)); assert.equal(e3.deliveries.length, 4); });
  await check('W6b 登记后拒投两次 → 重试后对端真的收到（-32003 不算送达）', () => {
    assert.equal(by['dsh/canvas/flaky'].status, 'sent'); assert.equal(by['dsh/canvas/flaky'].attempts, 2);
    assert.equal(flaky.got.filter((g) => JSON.parse(g.message).event_id === t3.event_id).length, 1);
  });
  await check('W6e 同机两个画布队都送达（不撞 -32002）', () => {
    assert.equal(by['dsh/canvas/intake'].status, 'sent'); assert.equal(by['dsh/canvas/beta'].status, 'sent');
    assert.deepEqual(ok.got.filter((g) => JSON.parse(g.message).event_id === t3.event_id).map((g) => g.team).sort(), ['dsh/canvas/beta', 'dsh/canvas/intake']);
  });
  await check('W6c 一直拒 → 5 次后 dead（带最后错误）', () => { assert.equal(by['dsh/canvas/down'].status, 'dead'); assert.equal(by['dsh/canvas/down'].attempts, 5); assert.ok(by['dsh/canvas/down'].last_error.length > 0); });
  await check('W6d 同一事件给每个目标的 token 不同', () => {
    const tokens = [...ok.got, ...flaky.got].filter((g) => g.task_id.startsWith(t3.event_id + '.')).map((g) => JSON.parse(g.message).reply.token);
    assert.equal(tokens.length, 3); assert.equal(new Set(tokens).size, 3);
  });

  // W10：撤回、未送达不能回写、token 过期
  {
    const tw = await publishTask({ ...values, title: '将撤回' }, false); // 任务级关 → held
    const heldRows = (await eventOf(tw.event_id)).deliveries;
    const wd = await call('/api/task-center/tasks/' + tw.id + '/withdraw', {});
    await check('W10a 撤回 → 未发出的投递全部 cancelled', async () => {
      assert.equal(wd.status, 200, JSON.stringify(wd.j)); assert.equal(wd.j.cancelled_deliveries, heldRows.length);
      assert.ok((await eventOf(tw.event_id)).deliveries.every((d) => d.status === 'cancelled'));
    });
    await check('W10b 撤回后 release → 409', async () => assert.equal((await call('/api/workbench-events/' + tw.event_id + '/release', {})).status, 409));
    const th = await publishTask({ ...values, title: '未送达回写' }, false);
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    const heldMsg = db.prepare("SELECT message FROM workbench_event_deliveries WHERE event_id = ? LIMIT 1").get(th.event_id).message;
    const heldToken = JSON.parse(heldMsg).reply.token;
    const early = await call('/api/workbench-events/' + th.event_id + '/decision', { token: heldToken, decision: 'accept', reason: '抢答' }, 'POST', remote);
    await check('W10c held（未送达）的投递不能回写决定 → 409', () => assert.equal(early.status, 409));
    const t3intake = ok.got.find((g) => g.team === 'dsh/canvas/intake' && JSON.parse(g.message).event_id === t3.event_id);
    const t3token = JSON.parse(t3intake.message).reply.token;
    db.prepare("UPDATE workbench_event_deliveries SET sent_at = datetime('now', '-8 days') WHERE event_id = ? AND target_team = 'dsh/canvas/intake'").run(t3.event_id);
    db.close();
    const late = await call('/api/workbench-events/' + t3.event_id + '/decision', { token: t3token, decision: 'accept', reason: '晚了' }, 'POST', remote);
    await check('W10d 送达 7 天后 token 过期 → 410', () => assert.equal(late.status, 410, JSON.stringify(late.j)));
  }

  // W11：超过传输上限 → 一次即 dead
  {
    assert.ok([200, 201].includes((await call('/api/apps', { slug: 'wbe-big', title: 'B', files: [{ path: 'index.html', content: '<h1>b</h1>' }] })).status));
    await call('/api/bindings', { target_type: 'app', target_slug: 'wbe-big', agent_node: 'dsh/66abc2cf', direction: 'notify', notify_url: ok.base });
    const big = await call('/api/apps/wbe-big/data', { data: { blob: 'x'.repeat(600_000) } }, 'POST', { 'X-Admin-Token': '' });
    assert.equal(big.status, 201);
    // 201 先于事件落库返回（推送不阻塞提交），等投递落到终态再读
    const readBig = () => { const db = dbRead(); const r = db.prepare("SELECT d.status, d.attempts, d.last_error FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE e.workbench = 'wbe-big'").get(); db.close(); return r; };
    await waitFor(() => ['sent', 'dead'].includes(readBig()?.status));
    const row = readBig();
    await check('W11 超限载荷一次即 dead', () => { assert.equal(row.status, 'dead'); assert.equal(row.attempts, 1); assert.match(row.last_error, /transport cap/); });
  }

  // W12：画布名规则与上游 canvas-store 一致
  {
    const zh = await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/采购组', direction: 'notify', notify_url: ok.base });
    const long = await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/' + 'a'.repeat(41), direction: 'notify', notify_url: ok.base });
    const digits = await call('/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: 'dsh/canvas/12345', direction: 'notify', notify_url: ok.base });
    await check('W12 中文画布名 201 / >40 字 400 / 纯数字 400', () => { assert.equal(zh.status, 201); assert.equal(long.status, 400); assert.equal(digits.status, 400); });
  }

  // W7：撤掉全部通知绑定 → unrouted
  const binds = (await call('/api/bindings?type=sop&slug=task-center', undefined, 'GET')).j;
  for (const b of Array.isArray(binds) ? binds : []) if (!b.revoked_at) await call('/api/bindings/' + b.id, undefined, 'DELETE');
  const t4 = await publishTask({ ...values, title: '无人接' }, true);
  const e4 = await eventOf(t4.event_id);
  await check('W7 无绑定 → routed=unrouted、零投递、事件仍在', () => { assert.equal(e4.routed, 'unrouted'); assert.equal(e4.deliveries.length, 0); assert.equal(e4.submitter_kind, 'human'); });

  // W8：自产台表单提交
  assert.ok([200, 201].includes((await call('/api/apps', { slug: 'wbe-form', title: 'F', files: [{ path: 'index.html', content: '<h1>x</h1>' }] })).status));
  await call('/api/bindings', { target_type: 'app', target_slug: 'wbe-form', agent_node: 'dsh/66abc2cf', direction: 'notify', notify_url: ok.base });
  const n0 = ok.got.length;
  const sub = await call('/api/apps/wbe-form/data', { data: { po: 'PO-1' }, created_by: 'someone' }, 'POST', { 'X-Admin-Token': '' });
  await check('W8a 提交 201', () => assert.equal(sub.status, 201));
  await waitFor(() => ok.got.length > n0);
  const env8 = JSON.parse(ok.got.at(-1).message);
  await check('W8b unverified、dispatch:false、无 reply、旧字段保留', () => {
    assert.equal(env8.type, 'app-data-submitted'); assert.equal(env8.slug, 'wbe-form'); assert.equal(env8.id, sub.j.id); assert.deepEqual(env8.data, { po: 'PO-1' });
    assert.equal(env8.submitter_kind, 'unverified'); assert.equal(env8.dispatch, false); assert.equal(env8.reply, undefined);
    assert.equal(ok.got.at(-1).context_id, `wb:wbe-form:${sub.j.id}`); assert.ok(ok.got.at(-1).task_id.startsWith(env8.event_id + '.d'));
  });

  // W9：只增日志
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    let updateRefused = false, deleteRefused = false, eventDeleteRefused = false;
    try { db.exec("UPDATE workbench_event_log SET action = 'x'"); } catch { updateRefused = true; }
    try { db.exec('DELETE FROM workbench_event_log'); } catch { deleteRefused = true; }
    try { db.exec('DELETE FROM workbench_events'); } catch { eventDeleteRefused = true; }
    db.close();
    await check('W9 日志 UPDATE/DELETE 与事件 DELETE 被拒', () => { assert.ok(updateRefused); assert.ok(deleteRefused); assert.ok(eventDeleteRefused); });
  }

  // 终态判据（契约 §9）：每个 human 事件 = unrouted，或每个投递 ∈ {sent, dead, cancelled}；held 是等人确认，超过 72h 判不通过
  {
    const db = dbRead();
    const open = db.prepare("SELECT d.event_id, d.status FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE e.submitter_kind = 'human' AND (d.status = 'pending' OR (d.status = 'held' AND d.created_at < datetime('now', '-72 hours')))").all();
    const held = db.prepare("SELECT COUNT(*) AS n FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE e.submitter_kind = 'human' AND d.status = 'held'").get().n;
    const humans = db.prepare("SELECT COUNT(*) AS n FROM workbench_events WHERE submitter_kind = 'human'").get().n;
    db.close();
    await check(`终态：${humans} 个 human 事件无 pending、无超时 held（${held} 个 held 在 72h 内等确认）`, () => assert.deepEqual(open, []));
  }
  console.log(`workbench-events-smoke: ${pass} PASS`);
} catch (e) {
  console.error('FAIL', e?.stack ?? e);
  console.error(logs.slice(-1500));
  process.exitCode = 1;
} finally {
  await stop();
  for (const p of peers) p.server.close();
}
