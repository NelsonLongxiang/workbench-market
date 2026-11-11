#!/usr/bin/env node
/**
 * 对端登记表（a2a_peers）。起隔离实例和几个回环上的假对端（各自出示签名名片，可以中途换钥、出示被改过的名片）：
 *
 *   升级回填：从现有绑定和投递用到的根地址建对端行（registered_by = system:migration），取得到名片的钉公钥、active；
 *             取不到的 pending_registration（不挡投递）；能按 registered_by 筛出来；重启再跑，行一行不变
 *   登记：取名片、验签、钉公钥；再登记同一个原样返回；坏地址 400；取不到、验签不过 422；没口令被拒
 *   公钥变了：不自动接受——key_changed、新指纹记成待确认、钉住的不变；进「关注」（管理员看得到，匿名看不到）；
 *             指纹对不上的确认被拒；对得上的才换，回到 active
 *   停用、重新启用：停用要写理由；停用期间看到新公钥也保持停用；重新启用回到停用前该有的状态
 *   停用是粘住的：没钉公钥就被停用的对端，名片取到了（管理员刷新、再登记同一个根地址）也保持停用，只把看到的公钥钉上；
 *             只有管理员显式重新启用才离开停用
 *   待登记的对端名片取到之后：钉公钥、改成 active
 *   canDeliver：active、待登记能发；key_changed、停用、没登记的不能，原因分得开
 *   健康：最近投递成功、失败（时间和原因）、回执、在途数、名片取到时间，都从现有的表算出来
 *   对外不给完整公钥，只给指纹
 *
 *   node scripts/a2a-peers-test.mjs              测本仓库
 *   node scripts/a2a-peers-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signCard, encodePublicKey } from '@nelsonlongxiang/dsh-open-a2a-net/card';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `a2a-peers-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;
const ADMIN_TOKEN = 'peers-synthetic-admin';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const fp = (key) => 'sha256:' + createHash('sha256').update(Buffer.from(encodePublicKey(key.publicKey), 'base64')).digest('hex');

/** 一个假对端：出示签名名片；key 可以换；tamper 为真时出示改过一个字的名片；down 为真时 404 */
async function fakePeer(team) {
  const state = { key: generateKeyPairSync('ed25519'), tamper: false, down: false, version: '1.0', posts: 0, paths: [] };
  const server = createServer((req, res) => {
    if (req.method === 'POST') { // 市场出站投递：记一次，回一个已投递
      state.posts++; state.paths.push(req.url); req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: 'peer-1', text: 'ok' }));
    }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json' && !state.down) {
      const card = signCard({ capabilities: { version: state.version, a2a: true }, expiresAt: Date.now() + 3600_000, name: team + '-node', session: team, team }, state.key.privateKey);
      const body = state.tamper ? JSON.stringify({ ...card, team: team + 'x' }) : JSON.stringify(card);
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(body);
    }
    res.writeHead(404); res.end();
  });
  const port = await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
  return { state, root: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const ENV = (dataDir) => ({ PATH: process.env.PATH, HOME: dataDir, DATA_DIR: dataDir, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0', WM_EXTENSIONS_DIR: join(dataDir, 'ext') });
async function start(dataDir) {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...ENV(dataDir), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error('服务退出：' + log.slice(-600));
    try { if ((await fetch(base + '/api/health')).status === 200) break; } catch { /* 还没起来 */ }
    if (i > 300) throw new Error('服务没起来：' + log.slice(-600));
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (method, path, body, headers = { 'x-admin-token': ADMIN_TOKEN }) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body: j };
  };
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); } };
  return { base, call, stop, log: () => log };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'data', 'ext'), { recursive: true });
const peers = [];
let inst = null;
try {
  const A = await fakePeer('team-a'), B = await fakePeer('team-b'), C = await fakePeer('team-c'), D = await fakePeer('team-d');
  peers.push(A, B, C, D);
  D.state.down = true; // 升级回填时取不到名片
  const data = join(OUT, 'data');
  // 存量：A、D 在绑定里，B 在投递里（带路径）；B 另有回执、失败重试、在途的投递
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
    const ev = await import(${JSON.stringify(at('server/src/workbench-events.ts'))});
    ev.initWorkbenchEvents();
    const bind = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('app', 'syn-app', ?, 'notify', 'read', ?, 'seed')");
    bind.run('syn/aaaaaaaa', ${JSON.stringify(A.root)} + '/'); bind.run('syn/dddddddd', ${JSON.stringify(D.root)});
    db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES ('wbe-00000000000000b1', 'task-center', 'task-center', 'task:1', 'wb:task-center:1', 'human', 'human:x', 1, ?, 1, 'target')").run('x'.repeat(64));
    const del = db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, sent_at, last_error) VALUES ('wbe-00000000000000b1', ?, ?, 'market/test', ?, ?, ?)");
    del.run('b-sent', ${JSON.stringify(B.root)} + '/a2a/direct', 'sent', '2026-11-10T08:00:00.000Z', '');
    const failed = Number(del.run('b-retry', ${JSON.stringify(B.root)} + '/a2a/direct', 'pending', '', '对端 503').lastInsertRowid);
    del.run('b-held', ${JSON.stringify(B.root)} + '/a2a/direct', 'held', '', '');
    db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail, at) VALUES ('wbe-00000000000000b1', ?, 'market', 'retry', '{}', '2026-11-10 09:00:00')").run(failed);
    db.prepare("INSERT INTO a2a_sent_tasks (task_id, event_id, delivery_id, peer_root, peer_zone) VALUES ('task-b-1', 'wbe-00000000000000b1', 1, ?, 'team-b')").run(${JSON.stringify(B.root)});
    db.prepare("INSERT INTO a2a_inbound_receipts (task_id, class, disposition, outcome, received_at) VALUES ('task-b-1', 'ack', 'acknowledged', '', '2026-11-10 10:00:00')").run();
    console.log('SEEDED');`], { env: ENV(data), encoding: 'utf8' });
  if (!seed.stdout.includes('SEEDED')) throw new Error('造数据失败：' + seed.stderr.slice(-800));

  inst = await start(data);
  const list = async (q = '') => (await inst.call('GET', '/api/a2a/peers' + q)).body ?? [];
  let rows = [];
  for (let i = 0; i < 200 && (rows = await list()).length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  const byRoot = (rs, root) => rs.find((p) => p.root_url === root);

  // ---------- 升级回填 ----------
  const a = byRoot(rows, A.root), b = byRoot(rows, B.root), d = byRoot(rows, D.root);
  check(a?.status === 'active' && a.registered_by === 'system:migration' && a.key_fingerprint === fp(A.state.key) && a.zone === 'team-a', '升级回填：绑定里的 A（带尾斜杠也规范成根）钉住公钥、active、登记人 system:migration', show(a));
  check(b?.status === 'active' && b.key_fingerprint === fp(B.state.key), '升级回填：投递用过的 B（target_url 带路径）也建出来、钉住公钥', show(b));
  check(d?.status === 'pending_registration' && d.key_fingerprint === '' && d.card_error !== '', '升级回填：取不到名片的 D 记成待登记（不挡投递），记下原因', show(d));
  const mig = await list('?registered_by=system%3Amigration');
  check(mig.length === 3 && rows.length === 3, '升级回填出来的能按 registered_by 筛出来（3 个）', show(mig.map((p) => p.root_url)));
  check(rows.every((p) => !('public_key' in p) && !('pending_public_key' in p)), '对外只给指纹，不给完整公钥');
  check(a?.card_version === '1.0' && a.card_capabilities?.a2a === true, '名片上声明的能力和版本记下了', show({ v: a?.card_version, c: a?.card_capabilities }));

  // ---------- 健康 ----------
  const h = b?.health;
  check(h?.last_sent_at === '2026-11-10T08:00:00.000Z' && h.last_failure_at === '2026-11-10 09:00:00' && h.last_failure_reason.includes('对端 503') && h.last_receipt_at === '2026-11-10 10:00:00' && h.in_flight === 2 && h.card_fetched_at !== '',
    '健康：最近投递成功、失败（时间和原因）、回执、在途数（held + pending）、名片取到时间', show(h));

  // ---------- 重启再跑：一行不变 ----------
  await inst.stop();
  inst = await start(data);
  await new Promise((r) => setTimeout(r, 1500));
  const again = await list();
  const strip = (rs) => show(rs.map(({ health: _h, ...p }) => p));
  check(strip(again) === strip(rows), '重启再跑升级回填：已有的行一行不变（重跑结果相同）');

  // ---------- 登记 ----------
  {
    const r1 = await inst.call('POST', '/api/a2a/peers', { root_url: C.root + '/some/path' });
    const r2 = await inst.call('POST', '/api/a2a/peers', { root_url: C.root });
    check(r1.status === 201 && r1.body?.peer?.root_url === C.root && r1.body.peer.key_fingerprint === fp(C.state.key) && r1.body.peer.registered_by === 'admin-token', '登记：取名片、验签、钉公钥（地址规范成根），登记人记下', show(r1));
    check(r2.status === 200 && r2.body?.created === false && r2.body.peer.id === r1.body?.peer?.id, '再登记同一个：原样返回，不重复建', show(r2));
    const bad = await inst.call('POST', '/api/a2a/peers', { root_url: 'ftp://elsewhere.invalid' });
    const unreach = await inst.call('POST', '/api/a2a/peers', { root_url: 'http://127.0.0.1:9' });
    const T = await fakePeer('team-t'); peers.push(T); T.state.tamper = true;
    const tampered = await inst.call('POST', '/api/a2a/peers', { root_url: T.root });
    check(bad.status === 400 && bad.body?.reason === 'bad_root', '坏地址（不是 http(s)）：400', show(bad));
    check(unreach.status === 422 && unreach.body?.reason === 'card_unreachable', '取不到名片：422，不登记', show(unreach));
    check(tampered.status === 422 && tampered.body?.reason === 'card_invalid' && !(await list()).some((p) => p.root_url === T.root), '名片被改过（验签不过）：422，不登记', show(tampered));
    const anon = await inst.call('POST', '/api/a2a/peers', { root_url: C.root }, { 'x-forwarded-for': '198.51.100.7' });
    const anonList = await inst.call('GET', '/api/a2a/peers', undefined, { 'x-forwarded-for': '198.51.100.7' });
    check([401, 403].includes(anon.status) && [401, 403].includes(anonList.status), '没口令（远程匿名）：登记、列出都被拒', show({ anon: anon.status, list: anonList.status }));
  }

  // ---------- 公钥变了 ----------
  const oldFp = fp(B.state.key);
  B.state.key = generateKeyPairSync('ed25519');
  const newFp = fp(B.state.key);
  {
    const r = await inst.call('POST', `/api/a2a/peers/${b.id}/refresh`);
    const p = r.body?.peer;
    check(r.status === 200 && p?.status === 'key_changed' && p.key_fingerprint === oldFp && p.pending_fingerprint === newFp, '名片公钥变了：不自动接受——key_changed，钉住的指纹不变，新指纹记成待确认', show(p));
    const att = await inst.call('GET', '/api/attention');
    const it = (att.body?.items ?? []).find((x) => x.source === 'a2a-peers' && x.source_id === b.id);
    check(it && it.category === 'grant' && it.title.includes(B.root) && it.title.includes(oldFp.slice(0, 19)) && it.title.includes(newFp.slice(0, 19)), '进「关注」：管理员看得到哪个对端、旧指纹、新指纹', show(it));
    const anonAtt = await inst.call('GET', '/api/attention', undefined, {});
    check(!(anonAtt.body?.items ?? []).some((x) => x.source === 'a2a-peers'), '匿名的「关注」里没有这一条');
    const wrong = await inst.call('POST', `/api/a2a/peers/${b.id}/confirm-key`, { fingerprint: 'sha256:' + '0'.repeat(64) });
    check(wrong.status === 409 && wrong.body?.reason === 'fingerprint_mismatch' && byRoot(await list(), B.root).status === 'key_changed', '确认时指纹对不上：409，状态不变', show(wrong));
    const ok = await inst.call('POST', `/api/a2a/peers/${b.id}/confirm-key`, { fingerprint: newFp });
    check(ok.status === 200 && ok.body?.peer?.status === 'active' && ok.body.peer.key_fingerprint === newFp && ok.body.peer.pending_fingerprint === '', '指纹对得上才换：钉住新公钥，回到 active', show(ok.body?.peer));
    const again2 = await inst.call('POST', `/api/a2a/peers/${b.id}/confirm-key`, { fingerprint: newFp });
    check(again2.status === 409 && again2.body?.reason === 'not_pending', '没有待确认的新公钥时确认：409');
  }

  // ---------- 停用、重新启用 ----------
  {
    const noReason = await inst.call('POST', `/api/a2a/peers/${a.id}/disable`, {});
    const off = await inst.call('POST', `/api/a2a/peers/${a.id}/disable`, { reason: '合成：节点下线' });
    A.state.key = generateKeyPairSync('ed25519');
    const seen = await inst.call('POST', `/api/a2a/peers/${a.id}/refresh`);
    check(noReason.status === 400 && off.status === 200 && off.body?.peer?.status === 'disabled' && off.body.peer.disabled_reason === '合成：节点下线', '停用要写理由；写了就停用', show({ noReason: noReason.status, off: off.body?.peer?.status }));
    check(seen.body?.peer?.status === 'disabled' && seen.body.peer.pending_fingerprint === fp(A.state.key), '停用期间名片公钥变了：保持停用，新指纹记成待确认', show(seen.body?.peer));
    const on = await inst.call('POST', `/api/a2a/peers/${a.id}/enable`, {});
    check(on.status === 200 && on.body?.peer?.status === 'key_changed', '重新启用：回到停用前该有的状态（看到过新公钥的回到 key_changed，等确认）', show(on.body?.peer));
  }

  // ---------- 待登记的对端名片取到了 ----------
  {
    D.state.down = false;
    const r = await inst.call('POST', `/api/a2a/peers/${d.id}/refresh`);
    check(r.body?.peer?.status === 'active' && r.body.peer.key_fingerprint === fp(D.state.key) && r.body.peer.registered_by === 'system:migration', '待登记的对端名片取到之后：钉公钥、改成 active（登记人保留）', show(r.body?.peer));
  }

  // ---------- 停用是粘住的：没钉公钥就被停用的对端，名片取到了也不复活 ----------
  {
    const E = await fakePeer('team-e'); peers.push(E);
    E.state.down = true;
    const ins = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      db.prepare("INSERT INTO a2a_peers (id, root_url, status, registered_by, registered_at, updated_at) VALUES ('peer_e00000000000', ?, 'pending_registration', 'system:migration', 'x', 'x')").run(${JSON.stringify(E.root)});
      console.log('OK');`], { env: ENV(data), encoding: 'utf8' });
    if (!ins.stdout.includes('OK')) throw new Error('造待登记的 E 失败：' + ins.stderr.slice(-500));
    const off = await inst.call('POST', '/api/a2a/peers/peer_e00000000000/disable', { reason: '合成：对端被停用' });
    check(off.body?.peer?.status === 'disabled' && off.body.peer.key_fingerprint === '', '停用一个还没钉公钥的待登记对端', show(off.body?.peer));
    E.state.down = false;
    const ref = await inst.call('POST', '/api/a2a/peers/peer_e00000000000/refresh');
    check(ref.body?.peer?.status === 'disabled' && ref.body.peer.disabled_reason === '合成：对端被停用' && ref.body.peer.key_fingerprint === fp(E.state.key),
      '名片能取到了、管理员点刷新：保持停用（只把看到的公钥钉上）', show(ref.body?.peer));
    const reg = await inst.call('POST', '/api/a2a/peers', { root_url: E.root });
    check(reg.body?.peer?.status === 'disabled' && reg.body.peer.disabled_reason === '合成：对端被停用', '再登记同一个根地址：保持停用', show(reg.body?.peer));
    E.state.key = generateKeyPairSync('ed25519');
    const ref2 = await inst.call('POST', '/api/a2a/peers/peer_e00000000000/refresh');
    check(ref2.body?.peer?.status === 'disabled' && ref2.body.peer.pending_fingerprint === fp(E.state.key), '停用期间公钥又变了：保持停用，新指纹记成待确认', show(ref2.body?.peer));
    const on = await inst.call('POST', '/api/a2a/peers/peer_e00000000000/enable', {});
    check(on.body?.peer?.status === 'key_changed' && on.body.peer.disabled_reason === '', '只有管理员显式重新启用才离开停用（看到过新公钥的回到 key_changed 等确认）', show(on.body?.peer));
  }
  // ---------- 出站两条管理面：state 只给管理员，send 只发给已登记且正常的对端 ----------
  {
    const anon = {}, cli = { 'user-agent': 'node' };
    const st = await inst.call('GET', '/api/a2a/state');
    check(st.status === 200 && typeof st.body?.team === 'string' && ['present', 'missing'].includes(st.body?.key) && st.body?.binding !== undefined, 'state：管理员读得到（团队、密钥在不在、名片概况、绑定数）', show(st));
    const stAnon = await inst.call('GET', '/api/a2a/state', undefined, anon);
    const stBad = await inst.call('GET', '/api/a2a/state', undefined, { 'x-admin-token': 'wrong-' + ADMIN_TOKEN });
    const stCase = await inst.call('GET', '/API/A2A/STATE', undefined, anon);
    check(stAnon.status === 403 && stBad.status === 403 && stCase.status === 403 && !('team' in (stAnon.body ?? {})) && !('card' in (stCase.body ?? {})), 'state：匿名、错口令、换大小写都 403，不给内容', show({ stAnon, stBad: stBad.status, stCase: stCase.status }));
    const card = await fetch(inst.base + '/.well-known/agent-card.json');
    check(card.status === 200, '名片本来就公开：匿名照样取得到', String(card.status));

    const send = (root, headers) => inst.call('POST', '/api/a2a/send', { target_url: root, team: 'syn/0a0b0c0d', message: '合成：出站探测' }, headers);
    // 正常对端：发得出
    const okB = B.state.posts;
    const sb = await send(B.root + '/', undefined);
    check(sb.status === 200 && sb.body?.ok === true && sb.body.target === B.root && B.state.posts === okB + 1, 'send：已登记的 active 对端发得出（发往登记的根地址）', show(sb));
    // 同一对端、请求里的地址带路径或尾部差异：按根查表，发往登记的根（/a2a/direct），不是请求里的原串（/x/a2a/direct）
    const variants = [B.root + '/x', B.root + '/x/', B.root + '//'];
    const vOut = [];
    for (const t of variants) { const before = B.state.paths.length; const r = await send(t, undefined); vOut.push({ t, status: r.status, target: r.body?.target, paths: B.state.paths.slice(before) }); }
    check(vOut.every((v) => v.status === 200 && v.target === B.root && v.paths.length === 1 && v.paths[0] === '/a2a/direct'),
      'send：同一对端、地址带路径（/x、/x/）、尾部多斜杠 → 都发往登记的根的 /a2a/direct，应答 target 是登记的根', show(vOut));
    const upBefore = B.state.posts, up = await send(B.root.replace('http://', 'HTTP://'), undefined);
    check(up.status === 400 && B.state.posts === upBefore, 'send：协议写成大写的地址过不了格式校验（400），不发', show(up));
    // 没登记的：不发
    const G = await fakePeer('team-g'); peers.push(G);
    const sg = await send(G.root, undefined);
    check(sg.status === 403 && sg.body?.error === 'a2a_send_peer_not_registered' && G.state.posts === 0, 'send：没登记的对端 403，一次都不发', show(sg));
    // 公钥待确认（A）、停用（C）、待登记（H）：不发
    const offC = await inst.call('POST', `/api/a2a/peers/${byRoot(await list(), C.root).id}/disable`, { reason: '合成：停用后不许出站' });
    const H = await fakePeer('team-h'); peers.push(H);
    const insH = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      db.prepare("INSERT INTO a2a_peers (id, root_url, status, registered_by, registered_at, updated_at) VALUES ('peer_h00000000000', ?, 'pending_registration', 'system:migration', 'x', 'x')").run(${JSON.stringify(H.root)});
      console.log('OK');`], { env: ENV(data), encoding: 'utf8' });
    if (!insH.stdout.includes('OK')) throw new Error('造待登记的 H 失败：' + insH.stderr.slice(-500));
    const [aPosts, cPosts] = [A.state.posts, C.state.posts];
    const sa = await send(A.root, undefined), sc = await send(C.root, undefined), sh = await send(H.root, undefined);
    check(offC.body?.peer?.status === 'disabled' && sa.status === 403 && sa.body?.status === 'key_changed' && sc.status === 403 && sc.body?.status === 'disabled' && sh.status === 403 && sh.body?.status === 'pending_registration',
      'send：公钥待确认、停用、待登记的对端都 403', show({ sa: sa.body, sc: sc.body, sh: sh.body }));
    check(A.state.posts === aPosts && C.state.posts === cPosts && H.state.posts === 0, 'send：被拒的对端一次都没收到', show({ a: A.state.posts - aPosts, c: C.state.posts - cPosts, h: H.state.posts }));
    // 谁能调：匿名、本机 CLI 不带口令、错口令、跨站带口令都不行（以前本机 CLI 免口令就能发给任意地址）
    const bPosts = B.state.posts;
    const r1 = await send(B.root, anon), r2 = await send(B.root, cli), r3 = await send(B.root, { 'x-admin-token': 'wrong-' + ADMIN_TOKEN });
    const r4 = await send(B.root, { 'x-admin-token': ADMIN_TOKEN, origin: 'http://evil.invalid', 'sec-fetch-site': 'cross-site' });
    check([r1, r2, r3, r4].every((r) => r.status === 403) && B.state.posts === bPosts, 'send：匿名、本机不带口令、错口令、跨站带口令都 403，不发', show([r1, r2, r3, r4].map((r) => r.status)));
    // 地址花样：查表和发往的是同一个根，拼不出别的去处
    const tricky = [`${G.root}#@${B.root.slice(7)}`, `${G.root}?x=${B.root}`, `http://user@${G.root.slice(7)}`];
    const outs = [];
    for (const t of tricky) outs.push(await send(t, undefined));
    check(outs.every((r) => r.status === 403) && G.state.posts === 0 && B.state.posts === bPosts, 'send：带片段、查询串、userinfo 的地址按真正的主机查表（没登记就不发）', show(outs.map((r) => r.status)));
    const badTarget = await send('ftp://x.invalid', undefined);
    check(badTarget.status === 400, 'send：不是 http(s) 的地址 400', show(badTarget));
  }
  await inst.stop(); inst = null;

  // ---------- canDeliver ----------
  {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
      const { A2aPeerService } = await import(${JSON.stringify(at('server/src/services/a2a-peers.ts'))});
      await root.plugin(A2aPeerService);
      const s = root.get('a2aPeers');
      db.prepare("INSERT INTO a2a_peers (id, root_url, status, registered_by, registered_at, updated_at) VALUES ('peer_eeeeeeeeeeee', 'http://127.0.0.1:1', 'pending_registration', 'system:migration', 'x', 'x')").run();
      const c = (u) => s.canDeliver(u);
      console.log('CD ' + JSON.stringify({ active: c(${JSON.stringify(B.root)} + '/a2a/direct'), keyChanged: c(${JSON.stringify(A.root)}), pending: c('http://127.0.0.1:1/x'), unknown: c('http://127.0.0.1:2'), bad: c('ftp://x') }));
      const { db: d2 } = await import(${JSON.stringify(at('server/src/db.ts'))});
      d2.prepare("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?").run(${JSON.stringify(C.root)});
      console.log('CD2 ' + JSON.stringify(c(${JSON.stringify(C.root)})));
      process.exit(0);`], { env: ENV(data), encoding: 'utf8' });
    const cd = JSON.parse(/CD (.*)/.exec(r.stdout)?.[1] ?? '{}'), cd2 = JSON.parse(/CD2 (.*)/.exec(r.stdout)?.[1] ?? '{}');
    check(cd.active?.ok === true && cd.pending?.ok === true, 'canDeliver：active、待登记的能发', show(cd));
    check(cd.keyChanged?.reason === 'peer_key_changed' && cd2?.reason === 'peer_disabled' && cd.unknown?.reason === 'peer_unknown' && cd.bad?.reason === 'peer_unknown', 'canDeliver：公钥待确认、停用、没登记的不能，原因分得开', show({ cd, cd2 }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (inst) console.log(inst.log().slice(-1500));
} finally {
  if (inst) await inst.stop();
  for (const p of peers) await p.close();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
