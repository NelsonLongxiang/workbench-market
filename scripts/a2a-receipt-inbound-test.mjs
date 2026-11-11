#!/usr/bin/env node
/**
 * 阶段七 R3：席位的 A2A 回执进事项（superagent 回发的就是这种回执；格式取自本机实测 a2a-net 0.8.1-preview.10 的 CLI receipt）。
 *
 * 一、正例：签名方 = 当初投递到的那台宿主（名片 team + 根地址）。
 *    acknowledged → 已接手；completed → 等验收（没先收到 acknowledged 也行）；attention → 在问你（问题 = 摘要）；
 *    rejected → 没办成（理由「对方拒绝」）；abandoned → 放弃；failed → 没办成。只认绑定正文的 Sig3。
 * 二、对抗组：
 *    别人的任务号（伪造回执文本）→ 照原路，应答与非回执消息逐字节相同；
 *    我们的任务号、别的团队签 → 照原路 + 记「收到未采信」，状态不动；callerUrl 不是投递地址 → 同上；
 *    没签名 → 同上；只带 Sig2 → 未采信（签名不绑正文）；带 Sig3 但 body 被改 → 未采信；剥掉 Sig3 换正文重放（两种先后）→ 未采信；
 *    同一条合法回执原样重发（含重启之后）→ 409 幂等、不重复推进；
 *    同一回执换新签名再发 → 409 -32003，不重复记；outcome 词表外（含 expired）→ 只记录不改状态；
 *    idempotencyKey 不是这个任务号 → 只记录；回执外形夹带指令 → 不开 run；投递没记对端 → 未采信；
 *    「收到未采信」每次投递最多 20 行；提交方未验证的事件 → 只记「收到未采信」。
 * 三、留痕：事件日志与服务端输出里没有签名、头的值。
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

const DATA = resolve('tmp/a2a-receipt-inbound');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// ---------- 两台假对端：lab（我们投递到的）和 evil（别的团队）----------
async function peer(zone, opts = {}) {
  const key = generateKeyPairSync('ed25519').privateKey;
  const p = await port();
  const url = `http://127.0.0.1:${p}`;
  const self = { zone, key, url, cardHits: 0 };
  // cardTeam：名片上写的 team（模拟投递地址上换成了别的节点）；cardFail：取名片一律 500
  self.server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
      self.cardHits++;
      if (opts.cardFail) { res.writeHead(500); return res.end(); }
      const team = opts.cardTeam ?? zone;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: team, session: team, team }, key)));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => self.server.listen(p, '127.0.0.1', r));
  return self;
}
const lab = await peer('lab');
const evil = await peer('evil');

const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const sign = (key, text) => edSign(undefined, Buffer.from(text, 'utf8'), key).toString('base64');
const digestOf = (raw) => createHash('sha256').update(raw).digest('base64url');
/** 按 a2a-net 0.8 的样子签：Sig2 + Sig3（body 绑定）；opts 控制少带、篡改 */
function signed(signer, raw, opts = {}) {
  const caller = opts.caller ?? signer.zone;
  const callerUrl = opts.callerUrl ?? signer.url;
  const ts = opts.ts ?? Date.now();
  const aud = opts.aud ?? BASE;
  const h = { 'X-A2A-Caller': caller, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud };
  if (opts.sig2 !== false) h['X-A2A-Caller-Sig2'] = sign(signer.key, JSON.stringify(['a2a-origin-claim/2', caller, callerUrl, ts, aud, 'POST', '/a2a/direct']));
  if (opts.sig3 !== false) {
    const digest = digestOf(opts.signedBody ?? raw);
    h['X-A2A-Body-Sha256'] = digest;
    h['X-A2A-Caller-Sig3'] = sign(signer.key, JSON.stringify(['a2a-origin-claim/3', caller, callerUrl, ts, aud, 'POST', '/a2a/direct', digest]));
  }
  return h;
}
const receiptText = (task, summary, envelope) => `[A2A receipt] task ${task} ${summary}\n${JSON.stringify(envelope)}`;
const bodyOf = (task, message, inbound, ctx = 'wb:task-center:1') => JSON.stringify({ team: 'market/12345678', message, caller_session: 'superagent-team/a1b2c3d4e5f60718', context_id: ctx, wait: false, task_id: inbound ?? `receipt-${task}`, callback: 'superagent-team/a1b2c3d4e5f60718' });
async function post(raw, headers) {
  const r = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
  return { status: r.status, text: await r.text() };
}

// ---------- 市场实例 ----------
let child = null;
let out = '';
function boot() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: 'server',
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'rcpt-admin', MARKET_PUBLIC_URL: BASE, WM_A2A_DIRECT_SIG: '', WM_LOGIN_GATE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
}
async function stop() { if (!child || child.exitCode !== null) return; const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; }
boot();
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }

const db = () => new DatabaseSync(join(DATA, 'workbench-market.db'));
let n = 0;
/** 造一个已送达的事件（照 workbench-events 的列）+ 一次投递 + 我们发出的任务号；返回 { ev, task, delivery } */
function seedEvent({ zone = 'lab', root = lab.url, submitter = 'human', teams = 1 } = {}) {
  n++;
  const ev = `wbe-${n.toString(16).padStart(16, '0')}`;
  const d = db();
  try {
    d.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', ?, ?, ?, 'human:alice', 1, ?, 1, 'default')").run(ev, `task:${n}`, `wb:task-center:${n}`, submitter, 'x'.repeat(64));
    d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, NULL, 'market', 'recorded', '{}')").run(ev);
    const tasks = [];
    for (let t = 0; t < teams; t++) {
      const delivery = Number(d.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, sent_at) VALUES (?, ?, ?, 'market/12345678', 'sent', datetime('now'))").run(ev, `superagent-team/a1b2c3d4e5f6071${t}`, lab.url).lastInsertRowid);
      for (const action of ['queued', 'sent']) d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(ev, delivery, action);
      const task = `${ev}.d${delivery}.a1`;
      d.prepare('INSERT INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)').run(task, 'delivery', ev, delivery, root, zone);
      tasks.push(task);
    }
    return { ev, task: tasks[0], tasks, delivery: Number(tasks[0].split('.d')[1].split('.')[0]) };
  } finally { d.close(); }
}
const itemState = (ev) => { const d = db(); try { return d.prepare('SELECT state, open_asks FROM work_items WHERE id = ?').get(`wi_${ev}`) ?? null; } finally { d.close(); } };
const logRows = (ev) => { const d = db(); try { return d.prepare('SELECT action, actor, detail FROM workbench_event_log WHERE event_id = ? ORDER BY id').all(ev); } finally { d.close(); } };
const lastLog = (ev) => logRows(ev).at(-1);
/** 发一条回执（缺省 lab 签、Sig2+Sig3） */
async function receipt(task, summary, envelope, opts = {}) {
  const raw = bodyOf(task, receiptText(task, summary, envelope), opts.inbound);
  return post(opts.tamper ? opts.tamper(raw) : raw, signed(opts.signer ?? lab, raw, opts));
}

try {
  if (!(await ready())) throw new Error('市场实例未就绪：' + out.slice(-800));
  // 事件表在任务中心初始化时建；等它在
  for (let i = 0; i < 40; i++) { const d = db(); const t = d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workbench_events'").get(); d.close(); if (t) break; await new Promise((r) => setTimeout(r, 250)); }

  console.log('一、正例');
  {
    const a = seedEvent();
    let r = await receipt(a.task, '已接下，稍后给结果', { idempotencyKey: a.task, disposition: 'acknowledged' }, { inbound: `ack-${a.task}` });
    ok('acknowledged → 200 已记', r.status === 200 && JSON.parse(r.text).receipt === 'recorded', r.text);
    ok('……事项到「已接手」', itemState(a.ev)?.state === 'accepted', JSON.stringify(itemState(a.ev)));
    ok('……日志 actor 是对端 zone', lastLog(a.ev)?.action === 'receipt:acknowledged' && lastLog(a.ev)?.actor === 'receiver:lab');
    r = await receipt(a.task, '做完了', { outcome: 'completed', idempotencyKey: a.task, disposition: 'result' });
    ok('completed → 等验收', r.status === 200 && itemState(a.ev)?.state === 'ready', JSON.stringify(itemState(a.ev)));

    const b = seedEvent();
    await receipt(b.task, '直接给结果', { outcome: 'completed', idempotencyKey: b.task, disposition: 'result' });
    ok('没先收到 acknowledged 就来 completed → 等验收', itemState(b.ev)?.state === 'ready', JSON.stringify(itemState(b.ev)));

    const c = seedEvent();
    await receipt(c.task, '需要确认：发哪个仓库？', { idempotencyKey: c.task, disposition: 'attention' });
    const sc = itemState(c.ev);
    ok('attention → 在问你，问题 = 摘要', sc?.state === 'blocked' && JSON.parse(sc.open_asks).some((q) => q.question === '需要确认：发哪个仓库？'), JSON.stringify(sc));

    const d1 = seedEvent();
    await receipt(d1.task, '不接这个', { outcome: 'rejected', idempotencyKey: d1.task, disposition: 'result' });
    ok('rejected → 没办成', itemState(d1.ev)?.state === 'failed', JSON.stringify(itemState(d1.ev)));
    const e = seedEvent();
    await receipt(e.task, '关单', { outcome: 'abandoned', idempotencyKey: e.task, disposition: 'result' });
    ok('abandoned → 放弃', itemState(e.ev)?.state === 'dropped', JSON.stringify(itemState(e.ev)));
    const f = seedEvent();
    await receipt(f.task, '跑挂了', { outcome: 'failed', idempotencyKey: f.task, disposition: 'result' });
    ok('failed → 没办成', itemState(f.ev)?.state === 'failed');
    const g = seedEvent();
    r = await receipt(g.task, '已接下', { idempotencyKey: g.task, disposition: 'acknowledged' }, { inbound: `ack-${g.task}`, sig3: false });
    ok('只有 Sig2 → 不采信（签名不绑正文），状态不动', r.status !== 200 && itemState(g.ev)?.state === 'delivered' && JSON.parse(lastLog(g.ev).detail).reason === 'not-body-bound', `${r.status} ${JSON.stringify(lastLog(g.ev))}`);
  }

  console.log('一（续）、一个事件投给两个团队');
  {
    for (const outcome of ['rejected', 'abandoned']) {
      const m = seedEvent({ teams: 2 });
      await receipt(m.tasks[0], 'A 接下', { idempotencyKey: m.tasks[0], disposition: 'acknowledged' }, { inbound: `ack-${m.tasks[0]}` });
      await receipt(m.tasks[1], `B ${outcome}`, { outcome, idempotencyKey: m.tasks[1], disposition: 'result' });
      ok(`A 已接手后 B 回执 ${outcome} → 事项仍已接手，B 的回执只记录`, itemState(m.ev)?.state === 'accepted', JSON.stringify(itemState(m.ev)));
      const p = seedEvent({ teams: 2 });
      await receipt(p.tasks[1], `B ${outcome}`, { outcome, idempotencyKey: p.tasks[1], disposition: 'result' });
      ok(`都还没接手、A 仍活着时 B 回执 ${outcome} → 仍已转交`, itemState(p.ev)?.state === 'delivered', JSON.stringify(itemState(p.ev)));
    }
    const q = seedEvent({ teams: 2 });
    await receipt(q.tasks[0], 'A 接下', { idempotencyKey: q.tasks[0], disposition: 'acknowledged' }, { inbound: `ack-${q.tasks[0]}` });
    await receipt(q.tasks[1], 'B 拒', { outcome: 'rejected', idempotencyKey: q.tasks[1], disposition: 'result' });
    await receipt(q.tasks[0], 'A 做完', { outcome: 'completed', idempotencyKey: q.tasks[0], disposition: 'result' });
    ok('A 做完 → 等验收（B 早先的拒绝不影响）', itemState(q.ev)?.state === 'ready', JSON.stringify(itemState(q.ev)));
    const r1 = seedEvent();
    await receipt(r1.task, '接下', { idempotencyKey: r1.task, disposition: 'acknowledged' }, { inbound: `ack-${r1.task}` });
    await receipt(r1.task, '做完', { outcome: 'completed', idempotencyKey: r1.task, disposition: 'result' });
    ok('单个投递：等验收后同一投递再来回执被去重（一个任务只有一条终局回执）', itemState(r1.ev)?.state === 'ready');
  }

  console.log('一（表）、A 的状态 × B 回什么（一个事件投给两个团队）');
  {
    // A 先回（或不回），把事项带到某个状态；B 再回一条。期望的是 B 那条之后事项的状态
    const ENV = {
      acknowledged: (t) => ({ inbound: `ack-${t}`, env: { idempotencyKey: t, disposition: 'acknowledged' } }),
      attention: (t) => ({ env: { idempotencyKey: t, disposition: 'attention' } }),
      completed: (t) => ({ env: { outcome: 'completed', idempotencyKey: t, disposition: 'result' } }),
      failed: (t) => ({ env: { outcome: 'failed', idempotencyKey: t, disposition: 'result' } }),
      rejected: (t) => ({ env: { outcome: 'rejected', idempotencyKey: t, disposition: 'result' } }),
      abandoned: (t) => ({ env: { outcome: 'abandoned', idempotencyKey: t, disposition: 'result' } }),
    };
    const send = async (task, kind) => { const x = ENV[kind](task); return receipt(task, kind, x.env, x.inbound ? { inbound: x.inbound } : {}); };
    //            A 之后的状态  B: acknowledged  attention   completed  failed      rejected    abandoned
    const TABLE = {
      none:         ['delivered', 'accepted',     'blocked',  'ready',   'delivered', 'delivered', 'delivered'],
      acknowledged: ['accepted',  'accepted',     'blocked',  'ready',   'accepted',  'accepted',  'accepted'],
      attention:    ['blocked',   'accepted',     'blocked',  'ready',   'blocked',   'blocked',   'blocked'],
      completed:    ['ready',     'ready',        'ready',    'ready',   'ready',     'ready',     'ready'],
    };
    const B = ['acknowledged', 'attention', 'completed', 'failed', 'rejected', 'abandoned'];
    const misses = [];
    let cells = 0;
    for (const [a, row] of Object.entries(TABLE)) {
      for (let i = 0; i < B.length; i++) {
        const m = seedEvent({ teams: 2 });
        if (a !== 'none') await send(m.tasks[0], a);
        // 事项要先建出来（第一行回执日志触发）；A 不回时用 B 之前的状态核对
        const afterA = itemState(m.ev)?.state ?? 'delivered';
        if (afterA !== row[0]) misses.push(`A=${a} 之后应是 ${row[0]}，实际 ${afterA}`);
        await send(m.tasks[1], B[i]);
        const got = itemState(m.ev)?.state;
        cells++;
        if (got !== row[i + 1]) misses.push(`A=${a}，B=${B[i]}：应是 ${row[i + 1]}，实际 ${got}`);
      }
    }
    ok(`A 的四种状态 × B 的六种回执，${cells} 格全部符合（说不干了的只在没有别的团队在场时推终态）`, misses.length === 0, misses.join('；'));
    // 两个都说不干了：后说的那个才推终态
    for (const [first, second, end] of [['rejected', 'rejected', 'failed'], ['failed', 'abandoned', 'dropped'], ['abandoned', 'failed', 'failed']]) {
      const m = seedEvent({ teams: 2 });
      await send(m.tasks[1], first);
      const mid = itemState(m.ev)?.state;
      await send(m.tasks[0], second);
      ok(`B ${first} 之后 A ${second} → ${end}（B 说完时仍已转交）`, mid === 'delivered' && itemState(m.ev)?.state === end, `${mid} → ${itemState(m.ev)?.state}`);
    }
    // 单个团队：说不干了直接推终态
    for (const [kind, end] of [['failed', 'failed'], ['rejected', 'failed'], ['abandoned', 'dropped']]) {
      for (const pre of ['none', 'acknowledged', 'completed']) {
        const m = seedEvent();
        if (pre !== 'none') await send(m.task + (pre === 'completed' ? '' : ''), pre);
        // 同一任务的终局回执只有一条：已 completed 的单团队再来终局回执会被去重
        if (pre === 'completed') { await send(m.task, kind); ok(`单团队 completed 之后同一任务再回 ${kind} → 去重，仍等验收`, itemState(m.ev)?.state === 'ready'); continue; }
        await send(m.task, kind);
        ok(`单团队 ${pre === 'none' ? '' : '接单后'}回 ${kind} → ${end}`, itemState(m.ev)?.state === end, JSON.stringify(itemState(m.ev)));
      }
    }
  }

  console.log('一（续三）、任务号的字面规则（ack-<task> 只配接单回执，receipt-<task> 只配终局回执）');
  {
    const x1 = seedEvent();
    let rr = await receipt(x1.task, '接下', { idempotencyKey: x1.task, disposition: 'acknowledged' }, { inbound: `receipt-${x1.task}` });
    ok('接单回执骑在 receipt-<task> 上 → 只记录，状态不动', rr.status === 200 && lastLog(x1.ev)?.action === 'receipt:unaccepted' && itemState(x1.ev)?.state === 'delivered', rr.text);
    const x2 = seedEvent();
    rr = await receipt(x2.task, '做完', { outcome: 'completed', idempotencyKey: x2.task, disposition: 'result' }, { inbound: `ack-${x2.task}` });
    ok('结果回执骑在 ack-<task> 上 → 只记录', lastLog(x2.ev)?.action === 'receipt:unaccepted' && itemState(x2.ev)?.state === 'delivered');
    const x3 = seedEvent();
    rr = await receipt(x3.task, '做完', { outcome: 'completed', idempotencyKey: x3.task, disposition: 'result' }, { inbound: 'a2a-0123456789abcdef' });
    ok('回执头是我们的任务号、入站任务号却是别的 → 只记录', lastLog(x3.ev)?.action === 'receipt:unaccepted' && itemState(x3.ev)?.state === 'delivered');
    rr = await receipt(x3.task, '做完', { outcome: 'completed', idempotencyKey: x3.task, disposition: 'result' });
    ok('……之后正确的 receipt-<task> 照常采信', rr.status === 200 && itemState(x3.ev)?.state === 'ready', rr.text);
  }

  console.log('一（续二）、不采信的回执不占槽');
  {
    const m = seedEvent();
    let r0 = await receipt(m.task, '借号', { outcome: 'completed', idempotencyKey: 'wbe-0000000000000099.d1.a1', disposition: 'result' });
    ok('借号的终局回执 → 200 not-accepted、只记录', r0.status === 200 && JSON.parse(r0.text).receipt === 'not-accepted' && lastLog(m.ev)?.action === 'receipt:unaccepted', r0.text);
    r0 = await receipt(m.task, '真做完', { outcome: 'completed', idempotencyKey: m.task, disposition: 'result' });
    ok('……随后真的 completed → 照常采信，等验收', r0.status === 200 && itemState(m.ev)?.state === 'ready', `${r0.status} ${r0.text}`);
    const n = seedEvent();
    await receipt(n.task, '怪结局', { outcome: 'expired', idempotencyKey: n.task, disposition: 'result' });
    await receipt(n.task, '接下', { idempotencyKey: 'other-task', disposition: 'acknowledged' }, { inbound: `ack-${n.task}` });
    r0 = await receipt(n.task, '接下', { idempotencyKey: n.task, disposition: 'acknowledged' }, { inbound: `ack-${n.task}` });
    ok('词表外的终局回执、借号的接单回执都不占槽 → 真的接单回执照常采信', r0.status === 200 && itemState(n.ev)?.state === 'accepted', r0.text);
    r0 = await receipt(n.task, '做完', { outcome: 'completed', idempotencyKey: n.task, disposition: 'result' });
    ok('……真的终局回执也照常采信', r0.status === 200 && itemState(n.ev)?.state === 'ready', r0.text);
  }

  console.log('二、对抗组');
  {
    // 1) 别人的任务号：照原路，应答与一条普通消息逐字节相同
    const other = 'wbe-ffffffffffffffff.d9.a1';
    // 两条都放在一个不存在的 context 里（R2 起，同一 context、同一对端的普通消息会被当成跟进收下）
    const raw1 = bodyOf(other, receiptText(other, '伪造', { outcome: 'completed', idempotencyKey: other, disposition: 'result' }), undefined, 'wb:none:0');
    const forged = await post(raw1, signed(lab, raw1));
    const rawPlain = bodyOf(other, '普通消息', undefined, 'wb:none:0');
    const plain = await post(rawPlain, signed(lab, rawPlain));
    ok('别人的任务号 → 照原路，应答与非回执消息逐字节相同', forged.status === plain.status && forged.text === plain.text, `${forged.status} ${forged.text} | ${plain.status} ${plain.text}`);

    // 2) 我们的任务号、别的团队签
    const a = seedEvent();
    const before = { state: 'delivered', open_asks: '[]' };
    let r = await receipt(a.task, '冒充', { outcome: 'completed', idempotencyKey: a.task, disposition: 'result' }, { signer: evil });
    ok('别的团队签 → 不认（照原路）', r.status !== 200 || !r.text.includes('"receipt":"recorded"'), r.text);
    ok('……状态不动、记一行「收到未采信」（wrong-signer）', itemState(a.ev)?.state === 'delivered' && lastLog(a.ev)?.action === 'receipt:untrusted' && JSON.parse(lastLog(a.ev).detail).reason === 'wrong-signer', JSON.stringify(lastLog(a.ev)));
    // 2b) evil 用 lab 的 zone 名，但签名用自己的钥匙、callerUrl 指自己
    r = await receipt(a.task, '冒充', { outcome: 'completed', idempotencyKey: a.task, disposition: 'result' }, { signer: evil, caller: 'lab' });
    ok('zone 名对、地址不是投递地址 → wrong-origin', JSON.parse(lastLog(a.ev).detail).reason === 'wrong-origin' && itemState(a.ev)?.state === 'delivered');
    // 2c) zone 名、地址都对，钥匙不对
    r = await receipt(a.task, '冒充', { outcome: 'completed', idempotencyKey: a.task, disposition: 'result' }, { signer: { ...evil, zone: 'lab', url: lab.url } });
    ok('zone、地址都对、钥匙不对 → bad-sig', JSON.parse(lastLog(a.ev).detail).reason === 'bad-sig' && itemState(a.ev)?.state === 'delivered');

    // 3) 没签名
    const rawU = bodyOf(a.task, receiptText(a.task, '没签名', { outcome: 'completed', idempotencyKey: a.task, disposition: 'result' }));
    r = await post(rawU, {});
    ok('没签名 → 照原路（未绑定 404）、未采信 absent', r.status === 404 && JSON.parse(lastLog(a.ev).detail).reason === 'absent' && itemState(a.ev)?.state === 'delivered', `${r.status} ${JSON.stringify(lastLog(a.ev))}`);

    // 4) 带 Sig3 但 body 被改（Sig2 本身是对的）→ 不降级
    r = await receipt(a.task, '原文', { idempotencyKey: a.task, disposition: 'attention' }, { tamper: (raw) => raw.replace('原文', '改过') });
    ok('Sig3 在、body 被改 → 不降级到 Sig2（body-mismatch）', JSON.parse(lastLog(a.ev).detail).reason === 'body-mismatch' && itemState(a.ev)?.state === 'delivered');

    // 5) 原样重放同一签名
    const rawR = bodyOf(a.task, receiptText(a.task, '接下', { idempotencyKey: a.task, disposition: 'acknowledged' }), `ack-${a.task}`);
    const hR = signed(lab, rawR);
    r = await post(rawR, hR);
    ok('第一次 → 已接手', r.status === 200 && itemState(a.ev)?.state === 'accepted', r.text);
    const rows1 = logRows(a.ev).length;
    r = await post(rawR, hR);
    const j5 = (() => { try { return JSON.parse(r.text); } catch { return {}; } })();
    ok('同一条合法回执原样重发 → 409 幂等返回，不重复推进、不记未采信', r.status === 409 && j5.code === -32003 && j5.replay === true && logRows(a.ev).length === rows1, r.text);
    // 5b) 剥离重放（合法的先到）：去掉 Sig3 与 Body-Sha256，留 Sig2 等其余头，正文换成同一宿主另一个任务的 completed 回执
    {
      const victim = seedEvent();
      const legitRaw = bodyOf(a.task, receiptText(a.task, '做完', { outcome: 'completed', idempotencyKey: a.task, disposition: 'result' }));
      const legitH = signed(lab, legitRaw);
      r = await post(legitRaw, legitH);
      ok('合法的终局回执先到 → 采信', r.status === 200 && itemState(a.ev)?.state === 'ready', r.text);
      const stripped = { ...legitH }; delete stripped['X-A2A-Caller-Sig3']; delete stripped['X-A2A-Body-Sha256'];
      const forgedRaw = bodyOf(victim.task, receiptText(victim.task, '冒充做完', { outcome: 'completed', idempotencyKey: victim.task, disposition: 'result' }));
      r = await post(forgedRaw, stripped);
      ok('剥掉 Sig3 换正文（合法的先到）→ 不采信，被换的事项不动', !r.text.includes('"receipt":"recorded"') && itemState(victim.ev)?.state === 'delivered', `${r.status} ${r.text} ${JSON.stringify(itemState(victim.ev))}`);
      // 5c) 剥离重放（攻击的先到）：截获的合法请求还没送到，先剥掉 Sig3 换正文发出去
      const later = seedEvent();
      const legit2 = bodyOf(later.task, receiptText(later.task, '接下', { idempotencyKey: later.task, disposition: 'acknowledged' }), `ack-${later.task}`);
      const h2 = signed(lab, legit2);
      const strip2 = { ...h2 }; delete strip2['X-A2A-Caller-Sig3']; delete strip2['X-A2A-Body-Sha256'];
      const victim2 = seedEvent();
      r = await post(bodyOf(victim2.task, receiptText(victim2.task, '冒充', { outcome: 'completed', idempotencyKey: victim2.task, disposition: 'result' })), strip2);
      ok('剥掉 Sig3 换正文（攻击的先到）→ 不采信', !r.text.includes('"receipt":"recorded"') && itemState(victim2.ev)?.state === 'delivered', r.text);
      r = await post(legit2, h2);
      ok('……合法的随后到达 → 照常采信', r.status === 200 && itemState(later.ev)?.state === 'accepted', r.text);
      // 5d) 重启后重放已用过的签名
      await stop();
      boot();
      if (!(await ready())) throw new Error('重启未就绪');
      const before = logRows(later.ev).length;
      r = await post(legit2, h2);
      ok('重启后原样重放已用过的签名 → 409 幂等，不重复推进', r.status === 409 && logRows(later.ev).length === before && itemState(later.ev)?.state === 'accepted', r.text);
      r = await post(bodyOf(victim2.task, receiptText(victim2.task, '冒充', { outcome: 'completed', idempotencyKey: victim2.task, disposition: 'result' })), strip2);
      ok('重启后剥离重放仍不采信', !r.text.includes('"receipt":"recorded"') && itemState(victim2.ev)?.state === 'delivered');
    }
    // 6) 换新签名再发同一回执 → 409 -32003
    r = await receipt(a.task, '接下', { idempotencyKey: a.task, disposition: 'acknowledged' }, { inbound: `ack-${a.task}` });
    const j6 = JSON.parse(r.text);
    ok('同一回执换新签名再发 → 409 -32003 replay，不重复记', r.status === 409 && j6.code === -32003 && j6.replay === true && logRows(a.ev).filter((x) => x.action === 'receipt:acknowledged').length === 1, r.text);

    // 7) 词表外
    for (const outcome of ['expired', 'sync_completed', 'unknown', 'bogus']) {
      const x = seedEvent();
      r = await receipt(x.task, '奇怪的结局', { outcome, idempotencyKey: x.task, disposition: 'result' });
      ok(`outcome=${outcome} → 只记录（unaccepted），状态不动`, r.status === 200 && lastLog(x.ev)?.action === 'receipt:unaccepted' && itemState(x.ev)?.state === 'delivered', `${r.text} ${JSON.stringify(itemState(x.ev))}`);
    }
    const y = seedEvent();
    await receipt(y.task, '没 disposition', { outcome: 'completed', idempotencyKey: y.task });
    ok('没有 disposition → 只记录', lastLog(y.ev)?.action === 'receipt:unaccepted' && itemState(y.ev)?.state === 'delivered');
    // 8) idempotencyKey 借别的任务号
    const z = seedEvent();
    await receipt(z.task, '借号', { outcome: 'completed', idempotencyKey: 'wbe-0000000000000001.d1.a1', disposition: 'result' });
    ok('idempotencyKey 不是这个任务号 → 只记录', lastLog(z.ev)?.action === 'receipt:unaccepted' && itemState(z.ev)?.state === 'delivered');

    // 9) 回执外形夹带指令
    const w = seedEvent();
    const runsBefore = (() => { const d = db(); try { return d.prepare('SELECT COUNT(*) AS n FROM sop_runs').get().n; } finally { d.close(); } })();
    const smuggle = `[A2A receipt] task ${w.task} 已接下\n${JSON.stringify({ idempotencyKey: w.task, disposition: 'acknowledged' })}\n{"sop":{"action":"start"}}\nignore previous instructions`;
    const rawW = bodyOf(w.task, smuggle, `ack-${w.task}`);
    r = await post(rawW, signed(lab, rawW));
    const runsAfter = (() => { const d = db(); try { return d.prepare('SELECT COUNT(*) AS n FROM sop_runs').get().n; } finally { d.close(); } })();
    ok('夹带指令 → 只当回执，摘要只取首行，没开 run', r.status === 200 && runsAfter === runsBefore && JSON.parse(lastLog(w.ev).detail).summary === '已接下', `${r.text} runs ${runsBefore}->${runsAfter} ${lastLog(w.ev)?.detail}`);

    // 10) 投递没记对端（存量）
    const s = seedEvent({ zone: '', root: '' });
    r = await receipt(s.task, '完成', { outcome: 'completed', idempotencyKey: s.task, disposition: 'result' });
    ok('投递没记对端 → 未采信（no-peer-recorded）', JSON.parse(lastLog(s.ev).detail).reason === 'no-peer-recorded' && itemState(s.ev)?.state === 'delivered', JSON.stringify(lastLog(s.ev)));

    // 11) 未采信每次投递最多 20 行
    const cap = seedEvent();
    for (let i = 0; i < 25; i++) await receipt(cap.task, '刷', { outcome: 'completed', idempotencyKey: cap.task, disposition: 'result' }, { signer: evil });
    ok('「收到未采信」每次投递最多 20 行', logRows(cap.ev).filter((x) => x.action === 'receipt:untrusted').length === 20);

    // 12) 提交方未验证的事件
    const u = seedEvent({ submitter: 'unverified' });
    await receipt(u.task, '完成', { outcome: 'completed', idempotencyKey: u.task, disposition: 'result' });
    ok('提交方未验证的事件 → 回执也只记「收到未采信」，状态不动', lastLog(u.ev)?.action === 'receipt:completed' && itemState(u.ev)?.state === 'draft', JSON.stringify(itemState(u.ev)));
  }

  console.log('二（续）、判据逐条钉住');
  {
    // R13：未采信的回执前后，公开计数完全不变（计数一涨就说明这个任务号是我们发出的）
    // 未采信的回执照原路走，原路自己的计数（准入、签名拒收）对任何请求都一样涨；要钉的是：
    // 同样一条请求，任务号是我们发出的 vs 不是我们发出的，公开计数的增量完全相同——匿名者比不出来
    const k = seedEvent();
    const countsOf = async () => (await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts ?? {};
    const delta = (a, b) => { const o = {}; for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (b[key] ?? 0) - (a[key] ?? 0); if (d) o[key] = d; } return JSON.stringify(o); };
    const notOurs = 'wbe-00000000000fffff.d999.a1';
    const variants = [
      ['别的团队签', { signer: evil }],
      ['zone 对、钥匙不对', { signer: { ...evil, zone: 'lab', url: lab.url } }],
      ['没签名', { sig3: false, sig2: false }],
      ['只带 Sig2', { sig3: false }],
    ];
    const diffs = [];
    for (const [label, opts] of variants) {
      const b1 = await countsOf();
      await receipt(k.task, label, { outcome: 'completed', idempotencyKey: k.task, disposition: 'result' }, opts);
      const ours = delta(b1, await countsOf());
      const b2 = await countsOf();
      await receipt(notOurs, label, { outcome: 'completed', idempotencyKey: notOurs, disposition: 'result' }, opts);
      const theirs = delta(b2, await countsOf());
      if (ours !== theirs || /receipt:/.test(ours)) diffs.push(`${label}: 我们的 ${ours} / 别人的 ${theirs}`);
    }
    ok('R13 未采信的回执：任务号是不是我们发出的，公开计数的增量完全相同（且不出现 receipt: 桶）', diffs.length === 0, diffs.join('；'));
    ok('……这期间事项没动', itemState(k.ev)?.state === 'delivered');
    // R15：5 分钟以前签的合法回执
    const t15 = seedEvent();
    let rr = await receipt(t15.task, '旧签名', { outcome: 'completed', idempotencyKey: t15.task, disposition: 'result' }, { ts: Date.now() - 6 * 60_000 });
    ok('R15 6 分钟前签的合法回执 → 不采信（bad-ts），状态不动', !rr.text.includes('"receipt":"recorded"') && JSON.parse(lastLog(t15.ev).detail).reason === 'bad-ts' && itemState(t15.ev)?.state === 'delivered', JSON.stringify(lastLog(t15.ev)));
    // R16：签给别的主机的合法回执
    const t16 = seedEvent();
    rr = await receipt(t16.task, '别的受众', { outcome: 'completed', idempotencyKey: t16.task, disposition: 'result' }, { aud: 'http://other-host.invalid' });
    ok('R16 签给别的主机的回执转投到市场 → 不采信（wrong-audience）', !rr.text.includes('"receipt":"recorded"') && JSON.parse(lastLog(t16.ev).detail).reason === 'wrong-audience' && itemState(t16.ev)?.state === 'delivered', JSON.stringify(lastLog(t16.ev)));
    // R6：投递地址上换成了另一个节点（另一把钥匙、名片 team 不同），它冒用原来的 zone 签
    const swapped = await peer('newnode', { cardTeam: 'newnode' });
    const t6 = seedEvent({ root: swapped.url, zone: 'lab' });
    rr = await receipt(t6.task, '换了节点', { outcome: 'completed', idempotencyKey: t6.task, disposition: 'result' }, { signer: { ...swapped, zone: 'lab' } });
    ok('R6 投递地址上换成别的节点、冒用原 zone 签 → 不采信（wrong-signer）', !rr.text.includes('"receipt":"recorded"') && JSON.parse(lastLog(t6.ev).detail).reason === 'wrong-signer' && itemState(t6.ev)?.state === 'delivered', JSON.stringify(lastLog(t6.ev)));
    swapped.server.close();
    // R11：第三行再放一个信封，只认第二行
    const t11 = seedEvent();
    const msg11 = `[A2A receipt] task ${t11.task} 接下\n${JSON.stringify({ idempotencyKey: t11.task, disposition: 'acknowledged' })}\n${JSON.stringify({ outcome: 'completed', idempotencyKey: t11.task, disposition: 'result' })}`;
    const raw11 = bodyOf(t11.task, msg11, `ack-${t11.task}`);
    rr = await post(raw11, signed(lab, raw11));
    ok('R11 第三行再放一个 completed 信封 → 只认第二行（已接手，不是等验收）', rr.status === 200 && itemState(t11.ev)?.state === 'accepted' && lastLog(t11.ev)?.action === 'receipt:acknowledged', `${rr.text} ${JSON.stringify(itemState(t11.ev))}`);
    // R12：摘要截到 500 字
    const t12 = seedEvent();
    await receipt(t12.task, '长'.repeat(600), { idempotencyKey: t12.task, disposition: 'attention' });
    ok('R12 600 字的摘要进日志截到 500 字', JSON.parse(lastLog(t12.ev).detail).summary.length === 500, String(JSON.parse(lastLog(t12.ev).detail).summary.length));
    // R18：对端名片取不到时，冷却期内重复回执只打一次对端
    const dark = await peer('dark', { cardFail: true });
    const t18 = seedEvent({ root: dark.url, zone: 'dark' });
    for (let i = 0; i < 4; i++) await receipt(t18.task, `第 ${i} 次`, { outcome: 'completed', idempotencyKey: t18.task, disposition: 'result' }, { signer: dark });
    ok(`R18 名片取不到：冷却期内 4 条回执只取 ${dark.cardHits} 次名片（应为 1）、都不采信（no-card）`, dark.cardHits === 1 && JSON.parse(lastLog(t18.ev).detail).reason === 'no-card' && itemState(t18.ev)?.state === 'delivered', `hits=${dark.cardHits} ${JSON.stringify(lastLog(t18.ev))}`);
    dark.server.close();
  }

  console.log('三、留痕');
  {
    const d = db();
    const details = d.prepare("SELECT detail FROM workbench_event_log WHERE action LIKE 'receipt:%'").all().map((x) => x.detail).join('\n');
    d.close();
    ok('事件日志里没有签名、头的名字', !/x-a2a|caller-sig|Sig2|Sig3|[A-Za-z0-9+/]{80,}={0,2}/i.test(details), details.slice(0, 300));
    ok('服务端输出里没有签名值', !/x-a2a-caller-sig|[A-Za-z0-9+/]{86}==/.test(out), out.match(/[A-Za-z0-9+/]{86}==/)?.[0] ?? '');
    const h = await (await fetch(BASE + '/api/health')).json();
    ok('健康块的拒收计数不出未采信的回执（计数一涨就暴露任务号是我们的）', !('receipt:untrusted' in (h.a2a?.refused?.counts ?? {})) && (h.a2a?.refused?.counts?.['receipt:replay'] ?? 0) >= 1, JSON.stringify(h.a2a?.refused));
  }
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  await stop();
  lab.server.close();
  evil.server.close();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
