#!/usr/bin/env node
/**
 * 阶段七：对端登记表里钉住的公钥接上入站和出站（services/a2a-peers.ts）。
 *
 * 一、入站（回执、跟进、名册都经 verifyReceiptSigner）：
 *    对照：对端 active、钉住的就是签名用的那把 → 回执采信、跟进记下、名册收下。
 *    钉住的是旧键、名片已换成新键（新键签）→ 不采信，事项不动；
 *    key_changed（钉住的还是签名这把，但等管理员确认）、disabled → 不采信、不记跟进、不收名册。
 * 二、出站（事件投递、回给团队的消息）投递前过 canDeliver：
 *    disabled、key_changed 的对端：挂起（仍 pending、attempts 不加、不判死、对端什么也没收到），留一行 held；
 *    恢复 active 之后照常发出；连挂几轮只留一行（事件投递的 held、答复的 reply-held 都是），换了原因再记一行。
 * 三、跟进按根地址认（不按区）：同一个区下两台宿主（根地址不同），限频各算各的；同一个 context 投给了两台，跟进按发来的根地址找到自己那次投递。
 * 测试数据都是编的：节点、区、团队都是合成值。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = resolve('tmp/a2a-pinned-peer');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pk: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}
/** 一台假对端：名片用 cardKey（可换）、收投递并记下 */
async function peer(zone) {
  const kp = keyPair();
  const p = await port();
  const self = { zone, ...kp, url: `http://127.0.0.1:${p}`, got: [] };
  self.server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: zone, session: zone, team: zone }, self.key)));
    }
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch {}
      self.got.push(j);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: j.task_id, context_id: j.context_id }));
    });
  });
  await new Promise((r) => self.server.listen(p, '127.0.0.1', r));
  return self;
}
const fpOf = (pk) => 'sha256:' + createHash('sha256').update(Buffer.from(pk, 'base64')).digest('hex');
const host8 = (pk) => createHash('sha256').update(Buffer.from(pk, 'base64')).digest('hex').slice(0, 8);

const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const sign = (key, text) => edSign(undefined, Buffer.from(text, 'utf8'), key).toString('base64');
function signed(signer, raw) {
  const caller = signer.zone, callerUrl = signer.url, ts = Date.now(), aud = BASE;
  const digest = createHash('sha256').update(raw).digest('base64url');
  return { 'X-A2A-Caller': caller, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud, 'X-A2A-Body-Sha256': digest,
    'X-A2A-Caller-Sig3': sign(signer.key, JSON.stringify(['a2a-origin-claim/3', caller, callerUrl, ts, aud, 'POST', '/a2a/direct', digest])) };
}
const post = async (raw, headers) => { const r = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw }); return { status: r.status, text: await r.text() }; };

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'pin-admin', MARKET_PUBLIC_URL: BASE, WM_A2A_DIRECT_SIG: '', WM_LOGIN_GATE: '', WM_OUTBOUND: '', WM_A2A_FOLLOWUP_RATE_10MIN: '3' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }
const db = () => { const d = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 }); d.exec('PRAGMA busy_timeout = 5000'); return d; };
const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const run = (sql, ...a) => { const d = db(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
async function waitFor(fn, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; }

const t0 = new Date().toISOString();
/** 登记对端：钉住 pinnedPk（缺省就是它现在的键），状态 status */
function register(p, status = 'active', pinnedPk = p.pk) {
  run(`INSERT INTO a2a_peers (id, root_url, zone, name, public_key, key_fingerprint, status, pending_public_key, pending_fingerprint, registered_by, registered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)
       ON CONFLICT(root_url) DO UPDATE SET public_key = excluded.public_key, key_fingerprint = excluded.key_fingerprint, status = excluded.status,
         pending_public_key = excluded.pending_public_key, pending_fingerprint = excluded.pending_fingerprint, updated_at = excluded.updated_at`,
    `peer_${p.zone}`, p.url, p.zone, p.zone, pinnedPk, fpOf(pinnedPk), status,
    status === 'key_changed' ? p.pk : '', status === 'key_changed' ? fpOf(p.pk) : '', t0, t0);
}
let n = 0;
/** 一个已送达的事件 + 一次投递 + 我们发出的任务号（对端是 p） */
function seedEvent(p, deliveryStatus = 'sent') {
  n++;
  const ev = `wbe-${(0xb00 + n).toString(16).padStart(16, '0')}`;
  const ctx = `wb:task-center:${2000 + n}`;
  const d = db();
  try {
    d.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', ?, ?, 'human', 'human:alice', 1, ?, 1, 'default')").run(ev, `task:${n}`, ctx, 'x'.repeat(64));
    d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, NULL, 'market', 'recorded', '{}')").run(ev);
    const sentAt = deliveryStatus === 'sent' ? "datetime('now')" : "''";
    const delivery = Number(d.prepare(`INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, message, status, sent_at) VALUES (?, 'superagent-team/a1b2c3d4e5f60718', ?, 'market/12345678', '{"task":{"title":"合成"}}', ?, ${sentAt})`).run(ev, p.url, deliveryStatus).lastInsertRowid);
    for (const action of deliveryStatus === 'sent' ? ['queued', 'sent'] : ['queued']) d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(ev, delivery, action);
    const task = `${ev}.d${delivery}.a1`;
    if (deliveryStatus === 'sent') d.prepare('INSERT INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)').run(task, 'delivery', ev, delivery, p.url, p.zone);
    return { ev, ctx, task, delivery };
  } finally { d.close(); }
}
const state = (ev) => q('SELECT state FROM work_items WHERE id = ?', `wi_${ev}`)[0]?.state ?? null;
const bodyOf = (msg, ctx, task) => JSON.stringify({ team: 'market/12345678', message: msg, caller_session: 'superagent-team/a1b2c3d4e5f60718', context_id: ctx, wait: false, task_id: task, callback: 'superagent-team/a1b2c3d4e5f60718' });
const receipt = async (p, e, outcome = 'completed', signer = p) => {
  const raw = bodyOf(`[A2A receipt] task ${e.task} 合成交付\n${JSON.stringify({ outcome, idempotencyKey: e.task, disposition: 'result' })}`, e.ctx, `receipt-${e.task}`);
  return post(raw, signed(signer, raw));
};
const followup = async (p, e, inbound) => { const raw = bodyOf('合成的跟进：还要再确认一下范围', e.ctx, inbound); return post(raw, signed(p, raw)); };
const followups = (delivery) => q('SELECT COUNT(*) AS c FROM workbench_event_followups WHERE delivery_id = ?', delivery)[0].c;
const roster = async (p, at = new Date().toISOString()) => {
  const h = host8(p.pk);
  const msg = `[A2A roster] ${h} ${at}\n${JSON.stringify({ host: h, at, seats: [{ seat: `${p.zone}/0000000a`, seatId: 'seat-x1', name: '合成成员', team: `${p.zone}/canvas/demo`, role: 'member' }] })}`;
  const raw = bodyOf(msg, 'roster', `roster-${n}-${Date.now()}`);
  return post(raw, signed(p, raw));
};
const rosterOf = (p) => q('SELECT host FROM a2a_roster_nodes WHERE peer_root = ?', p.url).length;

try {
  if (!(await ready())) throw new Error('实例未就绪：' + out.slice(-600));
  for (let i = 0; i < 40; i++) { if (q("SELECT 1 FROM sqlite_master WHERE name = 'workbench_events'").length) break; await sleep(250); }

  console.log('一、入站：签名用的公钥要等于钉住的；改钥待确认、停用的对端不收');
  const good = await peer('pgood'), rotated = await peer('protated'), changed = await peer('pchanged'), off = await peer('poff');
  register(good);
  const oldKey = keyPair();
  register(rotated, 'active', oldKey.pk);        // 钉住的是旧键，名片和签名已换成新键（没经管理员确认）
  register(changed, 'key_changed', keyPair().pk); // 名片换键、等管理员确认：钉住的还是旧的
  register(off, 'disabled');

  const g = seedEvent(good);
  const rg = await receipt(good, g);
  ok('对照：active、钉住的就是签名这把 → 回执采信，事项推到等验收', rg.status === 200 && state(g.ev) === 'ready', `${rg.status} ${state(g.ev)}`);
  const r = seedEvent(rotated); const s0r = state(r.ev);
  await receipt(rotated, r);
  ok('钉住的是旧键、名片已换新键并用新键签 → 不采信，事项没推到等验收', state(r.ev) !== 'ready', `${s0r} → ${state(r.ev)}`);
  const c = seedEvent(changed); const s0c = state(c.ev);
  await receipt(changed, c);
  ok('对端 key_changed（等管理员确认新键）→ 回执不采信，事项没推到等验收', state(c.ev) !== 'ready', `${s0c} → ${state(c.ev)}`);
  const o = seedEvent(off); const s0o = state(o.ev);
  await receipt(off, o);
  ok('对端 disabled → 回执不采信，事项没推到等验收', state(o.ev) !== 'ready', `${s0o} → ${state(o.ev)}`);

  const gf = seedEvent(good); await followup(good, gf, 'fu-good-1');
  const of = seedEvent(off); await followup(off, of, 'fu-off-1');
  const rf = seedEvent(rotated); await followup(rotated, rf, 'fu-rot-1');
  ok('跟进：active 钉住的键签的记下；disabled、钉住的不是签名这把的不记', followups(gf.delivery) === 1 && followups(of.delivery) === 0 && followups(rf.delivery) === 0,
    JSON.stringify([followups(gf.delivery), followups(of.delivery), followups(rf.delivery)]));

  await roster(good); await roster(off); await roster(changed); await roster(rotated);
  ok('名册：active 钉住的键签的收下；disabled、key_changed、钉住的不是签名这把的不收', rosterOf(good) === 1 && rosterOf(off) === 0 && rosterOf(changed) === 0 && rosterOf(rotated) === 0,
    JSON.stringify([rosterOf(good), rosterOf(off), rosterOf(changed), rosterOf(rotated)]));

  console.log('二、出站：投递前过 canDeliver；不能发的挂起，不判死');
  const hold = await peer('phold');
  register(hold, 'disabled');
  const h = seedEvent(hold, 'pending');
  const hk = await peer('pholdkey');
  register(hk, 'key_changed', keyPair().pk);
  const hk1 = seedEvent(hk, 'pending');
  const ctl = await peer('pctl');
  register(ctl);
  const ct = seedEvent(ctl, 'pending');
  const ctlSent = await waitFor(() => q('SELECT status FROM workbench_event_deliveries WHERE id = ?', ct.delivery)[0]?.status === 'sent');
  await sleep(6000); // 再多等一轮
  const dh = q('SELECT status, attempts FROM workbench_event_deliveries WHERE id = ?', h.delivery)[0];
  const dk = q('SELECT status, attempts FROM workbench_event_deliveries WHERE id = ?', hk1.delivery)[0];
  const heldLog = q("SELECT detail FROM workbench_event_log WHERE delivery_id = ? AND action = 'held'", h.delivery);
  ok('对照：active 的对端照常发出', ctlSent && ctl.got.length >= 1, JSON.stringify(ctl.got.length));
  ok('disabled 的对端：投递挂起（仍 pending、attempts 0、对端没收到），留一行 held（原因 peer_disabled），不刷屏',
    dh?.status === 'pending' && dh.attempts === 0 && hold.got.length === 0 && heldLog.length === 1 && JSON.parse(heldLog[0].detail).reason === 'peer_disabled', JSON.stringify({ dh, got: hold.got.length, heldLog }));
  ok('key_changed 的对端：同样挂起，对端没收到', dk?.status === 'pending' && dk.attempts === 0 && hk.got.length === 0, JSON.stringify({ dk, got: hk.got.length }));
  run("UPDATE a2a_peers SET status = 'active' WHERE root_url = ?", hold.url);
  run("UPDATE workbench_event_deliveries SET next_at = '2000-01-01 00:00:00' WHERE id = ?", h.delivery); // 挂起的隔一分钟再看：这里把下次再看的时间提前，不干等
  const released = await waitFor(() => q('SELECT status FROM workbench_event_deliveries WHERE id = ?', h.delivery)[0]?.status === 'sent');
  ok('恢复 active 之后照常发出', released && hold.got.length >= 1, JSON.stringify({ released, got: hold.got.length }));

  // 回给团队的消息（答复）同样过 canDeliver
  const rp = await peer('preply');
  register(rp);
  const re = seedEvent(rp);
  run("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?", rp.url);
  run(`INSERT INTO workbench_event_replies (kind, event_id, delivery_id, ref, team, caller_session, context_id, target_url, message, next_at, created_at)
       VALUES ('answer', ?, ?, 1, 'superagent-team/a1b2c3d4e5f60718', 'market/12345678', ?, ?, ?, ?, ?)`, re.ev, re.delivery, re.ctx, rp.url, JSON.stringify({ text: '合成的答复', by: 'user:alpha' }), '2000-01-01 00:00:00', t0);
  await sleep(11000);
  const rr = q("SELECT status, attempts FROM workbench_event_replies WHERE delivery_id = ?", re.delivery)[0];
  ok('回给 disabled 对端的答复：挂起（仍 pending、attempts 0、对端没收到）', rr?.status === 'pending' && rr.attempts === 0 && rp.got.length === 0, JSON.stringify({ rr, got: rp.got.length }));
  run("UPDATE a2a_peers SET status = 'active' WHERE root_url = ?", rp.url);
  run("UPDATE workbench_event_replies SET next_at = '2000-01-01 00:00:00' WHERE delivery_id = ?", re.delivery);
  const rSent = await waitFor(() => q("SELECT status FROM workbench_event_replies WHERE delivery_id = ?", re.delivery)[0]?.status === 'sent');
  ok('……恢复 active 之后照常发出', rSent && rp.got.length >= 1, JSON.stringify({ rSent, got: rp.got.length }));

  // 挂起不刷屏（答复这一侧）：key_changed 的对端连挂几轮只留一行 reply-held；换了原因（改成停用）再记一行；恢复之后发出
  const rk = await peer('preplykc');
  register(rk, 'key_changed', keyPair().pk);
  const rke = seedEvent(rk);
  run(`INSERT INTO workbench_event_replies (kind, event_id, delivery_id, ref, team, caller_session, context_id, target_url, message, next_at, created_at)
       VALUES ('answer', ?, ?, 1, 'superagent-team/a1b2c3d4e5f60718', 'market/12345678', ?, ?, ?, ?, ?)`, rke.ev, rke.delivery, rke.ctx, rk.url, JSON.stringify({ text: '合成的答复（挂几轮）', by: 'user:alpha' }), '2000-01-01 00:00:00', t0);
  const heldLines = () => q("SELECT detail FROM workbench_event_log WHERE delivery_id = ? AND action = 'reply-held'", rke.delivery).map((x) => JSON.parse(x.detail).reason);
  // 一轮：把下次再看的时间提前到过去，等 worker 再挂一次（next_at 又被推到将来）
  const oneRound = async () => { run("UPDATE workbench_event_replies SET next_at = '2000-01-01 00:00:00' WHERE delivery_id = ?", rke.delivery); return waitFor(() => (q('SELECT next_at FROM workbench_event_replies WHERE delivery_id = ?', rke.delivery)[0]?.next_at ?? '') > '2001'); };
  const rounds = [await waitFor(() => heldLines().length >= 1), await oneRound(), await oneRound(), await oneRound()];
  const afterRounds = heldLines();
  const rkRow = q('SELECT status, attempts FROM workbench_event_replies WHERE delivery_id = ?', rke.delivery)[0];
  ok('答复挂在 key_changed 的对端上连挂四轮：只留一行 reply-held（原因 peer_key_changed），仍 pending、attempts 0、对端没收到',
    rounds.every(Boolean) && JSON.stringify(afterRounds) === JSON.stringify(['peer_key_changed']) && rkRow?.status === 'pending' && rkRow.attempts === 0 && rk.got.length === 0, JSON.stringify({ rounds, afterRounds, rkRow, got: rk.got.length }));
  run("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?", rk.url);
  const switched = [await oneRound(), await oneRound()];
  ok('……原因换成停用：再记一行（peer_disabled），之后不再重复', switched.every(Boolean) && JSON.stringify(heldLines()) === JSON.stringify(['peer_key_changed', 'peer_disabled']), JSON.stringify({ switched, lines: heldLines() }));
  run("UPDATE a2a_peers SET status = 'active' WHERE root_url = ?", rk.url);
  run("UPDATE workbench_event_replies SET next_at = '2000-01-01 00:00:00' WHERE delivery_id = ?", rke.delivery);
  const rkSent = await waitFor(() => q('SELECT status FROM workbench_event_replies WHERE delivery_id = ?', rke.delivery)[0]?.status === 'sent');
  ok('……恢复 active 之后发出，挂起那几轮没有多记', rkSent && rk.got.length >= 1 && heldLines().length === 2, JSON.stringify({ rkSent, got: rk.got.length, lines: heldLines() }));

  // 截止变更的通知（同 context 的新任务，.n 任务号）也过 canDeliver：对端在通知发出之前变成 key_changed → 挂起（一行 reply-held、仍 pending、attempts 0、
  // 对端没收到）；恢复之后用 .n 任务号发出，原投递的结局不变
  const dn = await peer('pdue');
  register(dn);
  const de = seedEvent(dn); // 原投递已发出
  const dlv0 = q('SELECT status, attempts FROM workbench_event_deliveries WHERE id = ?', de.delivery)[0];
  run("UPDATE a2a_peers SET status = 'key_changed', pending_public_key = ?, pending_fingerprint = ? WHERE root_url = ?", keyPair().pk, 'sha256:' + '9'.repeat(64), dn.url);
  run(`INSERT INTO workbench_event_replies (kind, event_id, delivery_id, ref, team, caller_session, context_id, target_url, message, next_at, created_at)
       VALUES ('answer', ?, ?, 1, 'superagent-team/a1b2c3d4e5f60718', 'market/12345678', ?, ?, ?, ?, ?)`, de.ev, de.delivery, de.ctx, dn.url,
    JSON.stringify({ text: '[截止变更] 截止从 2099-01-01 改成 2099-01-02', by: 'user:alpha', notice: 'due-changed' }), '2000-01-01 00:00:00', t0);
  const noticeHeld = () => q("SELECT detail FROM workbench_event_log WHERE delivery_id = ? AND action = 'reply-held'", de.delivery).map((x) => JSON.parse(x.detail).reason);
  const firstHold = await waitFor(() => noticeHeld().length >= 1);
  run("UPDATE workbench_event_replies SET next_at = '2000-01-01 00:00:00' WHERE delivery_id = ?", de.delivery);
  await waitFor(() => (q('SELECT next_at FROM workbench_event_replies WHERE delivery_id = ?', de.delivery)[0]?.next_at ?? '') > '2001');
  const nRow = q('SELECT status, attempts FROM workbench_event_replies WHERE delivery_id = ?', de.delivery)[0];
  ok('截止变更通知：对端在发出之前变成 key_changed → 挂起（只一行 reply-held、仍 pending、attempts 0、对端没收到），不判死',
    firstHold && JSON.stringify(noticeHeld()) === JSON.stringify(['peer_key_changed']) && nRow?.status === 'pending' && nRow.attempts === 0 && dn.got.length === 0, JSON.stringify({ firstHold, held: noticeHeld(), nRow, got: dn.got.length }));
  run("UPDATE a2a_peers SET status = 'active', pending_public_key = '', pending_fingerprint = '' WHERE root_url = ?", dn.url);
  run("UPDATE workbench_event_replies SET next_at = '2000-01-01 00:00:00' WHERE delivery_id = ?", de.delivery);
  const nSent = await waitFor(() => q('SELECT status FROM workbench_event_replies WHERE delivery_id = ?', de.delivery)[0]?.status === 'sent');
  const sentTask = String(dn.got.at(-1)?.task_id ?? '');
  const dlv1 = q('SELECT status, attempts FROM workbench_event_deliveries WHERE id = ?', de.delivery)[0];
  ok('……恢复之后用 .n 任务号发出（同一 context），原投递的结局不变', nSent && new RegExp(`^${de.ev}\\.d${de.delivery}\\.n\\d+\\.a1$`).test(sentTask) && dn.got.at(-1)?.context_id === de.ctx
    && JSON.stringify(dlv1) === JSON.stringify(dlv0), JSON.stringify({ nSent, sentTask, ctx: dn.got.at(-1)?.context_id, dlv0, dlv1 }));

  console.log('三、跟进按根地址认，不按区');
  const s1 = await peer('pshared'), s2 = await peer('pshared'); // 同一个区，两台宿主
  register(s1); run("UPDATE a2a_peers SET id = 'peer_s1' WHERE root_url = ?", s1.url);
  run(`INSERT INTO a2a_peers (id, root_url, zone, name, public_key, key_fingerprint, status, registered_by, registered_at, updated_at) VALUES ('peer_s2', ?, 'pshared', 'pshared', ?, ?, 'active', 'test', ?, ?)`, s2.url, s2.pk, fpOf(s2.pk), t0, t0);
  // 限频（这个实例设成 10 分钟 3 条）：s1 发满 3 条、第 4 条限频；s2 是另一台宿主，照常记正文
  const fs1 = [];
  for (let i = 0; i < 4; i++) { const e = seedEvent(s1); await followup(s1, e, `fu-s1-${i}`); fs1.push(q('SELECT status FROM workbench_event_followups WHERE delivery_id = ?', e.delivery)[0]?.status); }
  const e2 = seedEvent(s2); await followup(s2, e2, 'fu-s2-0');
  const s2Status = q('SELECT status FROM workbench_event_followups WHERE delivery_id = ?', e2.delivery)[0]?.status;
  ok('限频按根地址：同一个区下 s1 发满 3 条后第 4 条限频，另一台 s2 的照常记正文', JSON.stringify(fs1) === JSON.stringify(['open', 'open', 'open', 'rate-limited']) && s2Status === 'open', JSON.stringify({ fs1, s2Status }));
  // 同一个 context 先投给 s1、后投给 s2：s1 发来的跟进按它的根地址找到投给它的那次，不被后投的 s2 那次挡住
  const shared = seedEvent(s1);
  const d2 = Number(run(`INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, message, status, sent_at) VALUES (?, 'superagent-team/b1b2c3d4e5f60718', ?, 'market/12345678', '{}', 'sent', datetime('now'))`, shared.ev, s2.url).lastInsertRowid);
  run("UPDATE a2a_sent_tasks SET created_at = '2000-01-01 00:00:00' WHERE task_id = ?", shared.task);
  run('INSERT INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)', `${shared.ev}.d${d2}.a1`, 'delivery', shared.ev, d2, s2.url, 'pshared');
  const fromS1 = await followup(s1, shared, 'fu-shared-s1');
  ok('同一个 context 投给了同区的两台：s1 发来的跟进记在投给 s1 的那次投递上', followups(shared.delivery) === 1 && followups(d2) === 0, JSON.stringify({ st: fromS1.status, s1: followups(shared.delivery), s2: followups(d2) }));
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  child.kill();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
