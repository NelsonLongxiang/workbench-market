#!/usr/bin/env node
// 工作台事件层 v1 冒烟（契约：dsh-open-a2a-net docs/protocol/workbench-event.md）。
// 隔离 DATA_DIR + 本机回环假对端；对端用上游 verifyOriginClaim 按「不绑定窗已关」验每次投递。
// 判据：
//   W1 画布队名可作通知绑定的 agent_node（旧正则 400）
//   W2 开关没全开 → 投递 held，对端收 0；W3 release 后投出，信封字段齐、task_id=event_id、来源签名过验、明文 token 投后清空
//   W4 决定端点：错 token 404 / 缺理由 400 / ask→accept 200 / 终态后再写 409；业务面浏览器请求可达（远程豁免）
//   W5 两开关全开 → 自动投递；目标 SOP 台命中 → routed=target
//   W6 对端前两次 500 → 退避重试后 sent；对端一直拒 → 5 次后 dead
//   W7 无任何通知绑定 → routed=unrouted、零投递（不静默丢）
//   W8 自产台表单提交 → submitter_kind=unverified、dispatch:false、无 reply、旧字段保留
//   W9 只增日志：UPDATE/DELETE 被触发器拒
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
function makePeer() {
  const peer = { got: [], verdicts: [], failFirst: 0, alwaysFail: false };
  peer.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const verdict = await verifyOriginClaim(req, {
        cardCache: new Map(), audiences: [peer.base], unboundOpen: false, onUnbound: () => {}, now: Date.now(),
        fetch: (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, text: () => r.text() })),
      });
      peer.verdicts.push(verdict);
      if (peer.alwaysFail || peer.failFirst > 0) {
        peer.failFirst--;
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'down', code: -32000 })); return;
      }
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      peer.got.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: parsed.task_id, context_id: parsed.context_id }));
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
    assert.equal(ok.got[0].task_id, t1.event_id); assert.equal(ok.got[0].context_id, `wb:task-center:${t1.id}`);
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
  const t3 = await publishTask({ ...values, title: '重试' }, true);
  const settled = await waitFor(async () => { const e = await eventOf(t3.event_id); return e.deliveries.every((d) => d.status === 'sent' || d.status === 'dead'); }, 40_000);
  const e3 = await eventOf(t3.event_id);
  const by = Object.fromEntries(e3.deliveries.map((d) => [d.target_team, d]));
  await check('W6a 三个目标各一行投递', () => { assert.ok(settled, JSON.stringify(e3.deliveries)); assert.equal(e3.deliveries.length, 3); });
  await check('W6b 前两次失败 → 重试后 sent', () => { assert.equal(by['dsh/canvas/flaky'].status, 'sent'); assert.equal(by['dsh/canvas/flaky'].attempts, 2); });
  await check('W6c 一直拒 → 5 次后 dead（带最后错误）', () => { assert.equal(by['dsh/canvas/down'].status, 'dead'); assert.equal(by['dsh/canvas/down'].attempts, 5); assert.ok(by['dsh/canvas/down'].last_error.length > 0); });
  await check('W6d 同一事件给每个目标的 token 不同', () => {
    const tokens = [...ok.got, ...flaky.got].filter((g) => g.task_id === t3.event_id).map((g) => JSON.parse(g.message).reply.token);
    assert.equal(tokens.length, 2); assert.notEqual(tokens[0], tokens[1]);
  });

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
    assert.equal(ok.got.at(-1).context_id, `wb:wbe-form:${sub.j.id}`); assert.equal(ok.got.at(-1).task_id, env8.event_id);
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

  // 终态判据：每个 human 事件 = unrouted，或每个投递 ∈ {held, sent, dead}
  {
    const db = dbRead();
    const open = db.prepare("SELECT e.event_id FROM workbench_events e WHERE e.submitter_kind = 'human' AND e.routed != 'unrouted' AND EXISTS (SELECT 1 FROM workbench_event_deliveries d WHERE d.event_id = e.event_id AND d.status = 'pending')").all();
    const humans = db.prepare("SELECT COUNT(*) AS n FROM workbench_events WHERE submitter_kind = 'human'").get().n;
    db.close();
    await check(`终态：${humans} 个 human 事件全部有下文`, () => assert.deepEqual(open, []));
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
