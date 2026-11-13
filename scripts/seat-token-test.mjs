#!/usr/bin/env node
/**
 * 阶段七：席位用节点签名换短期 MCP 令牌（POST /api/a2a/seat-token，services/seat-tokens.ts）。对抗组：
 *   一、换得到：节点 active、钉住的公钥签、席位在这台宿主的名册里 → 200，令牌 1 小时；令牌能调 /mcp，审计记下席位。
 *   二、换不到（一律同一个 401，不透露存不存在）：别的键签的、别的宿主冒名、席位不在名册、节点停用 / 公钥待确认 / 待登记、
 *       时间窗外、受众不是本市场、同一个签名第二次；请求体不成形 → 400。
 *   三、每次调用复核：名册撤掉席位、停用节点、吊销主体、到期之后，已发的令牌下一次调用就 401；恢复之后没到期的照常。
 *   四、授权挂在席位上：两次换到的令牌落在同一个主体上，给主体批的授权跨令牌保留；存量会话的授权不自动并过来。
 *   五、X-Team-Seat 不认作身份：只带它没有令牌 401；带着别的席位名调用，审计里的席位仍是令牌认出来的，自报的只进 claimed_seat。
 *   六、限频：同一席位一小时最多发 12 张；同一来源十分钟最多 60 次。
 *   七、管理员建会话不能用 seat- 开头的名字。
 *   八、每次换令牌单独记一行（成不成都记）：节点、席位、时间、结果、拒的原因；换到的令牌引用对得上调用审计；记录只给管理员看。
 *   九、席位主体按（根地址，公钥完整指纹，seat_id）认：同一宿主号换了根地址或换了键来换，是另一个从空授权开始的主体，拿不到旧主体的授权，旧令牌也失效。
 *   限频按真实来源：可信反代（本机回环）后面不同 X-Real-IP 各算各的，记录里的来源也是它。
 * 测试数据都是编的：节点、团队、席位都是合成值。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer as netServer } from 'node:net';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const DATA = resolve('tmp/seat-token');
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });

const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN: 'seat-admin', MARKET_PUBLIC_URL: BASE, WM_LOGIN_GATE: '', WM_OUTBOUND: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }
const db = () => { const d = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 }); d.exec('PRAGMA busy_timeout = 5000'); return d; };
const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const run = (sql, ...a) => { const d = db(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const ADMIN = { 'x-admin-token': 'seat-admin', 'sec-fetch-site': 'same-origin' };
const admin = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: { ...ADMIN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };

/** 一台合成的宿主：节点键、根地址、指纹 */
function host(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pk = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { name, key: privateKey, pk, fp: createHash('sha256').update(Buffer.from(pk, 'base64')).digest('hex').slice(0, 8), root: `https://${name}.example.test` };
}
const t0 = new Date().toISOString();
/** 公钥的完整指纹（写法同 a2a_peers.key_fingerprint）：对端登记钉住的和名册记的是同一把 */
const fullFp = (pk) => 'sha256:' + createHash('sha256').update(Buffer.from(pk, 'base64')).digest('hex');
function seedHost(h, seats, status = 'active') {
  run(`INSERT INTO a2a_peers (id, root_url, zone, public_key, key_fingerprint, status, registered_by, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
    `peer_${h.fp}`, h.root, h.name, h.pk, fullFp(h.pk), status, t0, t0);
  run('INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?, ?)', h.fp, h.root, fullFp(h.pk), h.name, t0, t0);
  for (const s of seats) run('INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', h.root, fullFp(h.pk), h.fp, `${h.name}/canvas/demo`, s.seat, s.id, 'x', 'member', t0);
}
let nonceN = 0;
const nonce = () => `n${String(++nonceN).padStart(15, '0')}`;
/** 签一份换令牌的请求。over：覆盖签名里的字段或签名后改字段 */
function req(h, seatId, over = {}) {
  const b = { v: 1, root: h.root, host: h.fp, seat_id: seatId, ts: Date.now(), nonce: nonce(), aud: BASE, ...(over.signed ?? {}) };
  const text = JSON.stringify(['wm-seat-token/1', b.root, b.host, b.seat_id, b.ts, b.nonce, b.aud]);
  const sig = edSign(undefined, Buffer.from(text, 'utf8'), over.key ?? h.key).toString('base64');
  return { ...b, sig, ...(over.after ?? {}) };
}
// 计数换令牌的请求：不是 JSON 的正文在全局解析那一步就 400 了，到不了路由，不计也不记（它也没有节点、席位可记）
let exchanges = 0;
const exchange = async (body, headers = {}) => { if (typeof body !== 'string') exchanges++; const r = await fetch(BASE + '/api/a2a/seat-token', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j, text: JSON.stringify(j) }; };
const mcp = async (token, method, params, headers = {}) => { const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const REFUSED = JSON.stringify({ error: 'seat_token_refused' });

const A = host('alpha-node'), B = host('beta-node'), C = host('gamma-node'), D = host('delta-node'), E = host('eps-node'), F = host('zeta-node');
try {
  if (!(await ready())) throw new Error('实例未就绪：' + out.slice(-600));
  seedHost(A, [{ seat: 'alpha-node/a0000001', id: 'seat-a1' }, { seat: 'alpha-node/a0000002', id: 'seat-a2' }, { seat: 'alpha-node/a0000003', id: 'seat-a3' }]);
  seedHost(B, [{ seat: 'beta-node/b0000001', id: 'seat-b1' }]);
  seedHost(C, [{ seat: 'gamma-node/c0000001', id: 'seat-c1' }], 'key_changed');
  seedHost(D, [{ seat: 'delta-node/d0000001', id: 'seat-d1' }], 'disabled');
  seedHost(E, [{ seat: 'eps-node/e0000001', id: 'seat-e1' }], 'pending_registration');

  console.log('一、换得到');
  let r = await exchange(req(A, 'seat-a1'));
  const tok1 = r.body?.token ?? '';
  ok('节点 active、节点键签、席位在名册 → 200，Bearer 令牌，1 小时到期，带回 host 和 seat_id', r.status === 200 && /^[0-9a-f]{64}$/.test(tok1) && r.body.token_type === 'Bearer' && r.body.expires_in === 3600
    && Math.abs(Date.parse(r.body.expires_at) - Date.now() - 3_600_000) < 60_000 && r.body.seat?.host === A.fp && r.body.seat?.seat_id === 'seat-a1', r.text);
  ok('库里只存令牌的 sha256，不存原文', q('SELECT COUNT(*) AS c FROM a2a_seat_tokens WHERE token_sha256 = ?', createHash('sha256').update(tok1).digest('hex'))[0].c === 1
    && q('SELECT COUNT(*) AS c FROM a2a_seat_tokens WHERE token_sha256 = ?', tok1)[0].c === 0);
  let m = await mcp(tok1, 'tools/list', {}, { 'x-team-seat': 'alpha-node/a0000002' });
  ok('换来的令牌能调 /mcp（tools/list 200，有免授权的工具）', m.status === 200 && Array.isArray(m.body?.result?.tools) && m.body.result.tools.some((t) => t.name === 'access_info'), JSON.stringify(m.body).slice(0, 200));
  const audit = q("SELECT session_name, seat, claimed_seat FROM mcp_calls WHERE method = 'tools/list' ORDER BY id DESC LIMIT 1")[0];
  ok('五、审计记下的席位从令牌认出来（host:seat_id）；X-Team-Seat 自报的另一个席位只进 claimed_seat', audit?.seat === `${A.fp}:seat-a1` && audit?.claimed_seat === 'alpha-node/a0000002' && audit?.session_name.startsWith('seat-'), JSON.stringify(audit));
  m = await mcp('', 'tools/list', {}, { 'x-team-seat': 'alpha-node/a0000001' });
  ok('……只带 X-Team-Seat、没有令牌 → 401', m.status === 401, String(m.status));

  console.log('二、换不到');
  const cases = [
    ['别的键签的（B 的键签 A 的席位）', req(A, 'seat-a1', { key: B.key })],
    ['别的宿主冒名：B 的键签、host 写 A、席位是 A 的', req(B, 'seat-a1', { signed: { host: A.fp, root: A.root } })],
    ['别的宿主的席位：B 自己签、host 写 B、席位是 A 的', req(B, 'seat-a1')],
    ['root 写成别的宿主（签名照 A 的键签）', req(A, 'seat-a1', { signed: { root: B.root } })],
    ['席位不在名册', req(A, 'seat-zz')],
    ['节点公钥变了待确认（key_changed）', req(C, 'seat-c1')],
    ['节点停用（disabled）', req(D, 'seat-d1')],
    ['节点待登记（pending_registration）', req(E, 'seat-e1')],
    ['时间戳早了 6 分钟', req(A, 'seat-a1', { signed: { ts: Date.now() - 6 * 60_000 } })],
    ['时间戳晚了 6 分钟', req(A, 'seat-a1', { signed: { ts: Date.now() + 6 * 60_000 } })],
    ['受众不是本市场', req(A, 'seat-a1', { signed: { aud: 'https://other-market.example.test' } })],
    ['签完改了 seat_id', req(A, 'seat-a1', { after: { seat_id: 'seat-a2' } })],
    ['签完改了 nonce', req(A, 'seat-a1', { after: { nonce: 'zzzzzzzzzzzzzzzzzzzz' } })],
  ];
  for (const [name, body] of cases) {
    r = await exchange(body);
    ok(`${name} → 401，和别的拒法同一句`, r.status === 401 && r.text === REFUSED, `${r.status} ${r.text}`);
  }
  const once = req(A, 'seat-a2');
  const r1 = await exchange(once), r2 = await exchange(once);
  ok('同一个签名第二次 → 401（第一次 200）', r1.status === 200 && r2.status === 401 && r2.text === REFUSED, `${r1.status} ${r2.status}`);
  for (const [name, body] of [['不是 JSON', '{x'], ['少了 sig', { ...req(A, 'seat-a1'), sig: undefined }], ['v 不是 1', { ...req(A, 'seat-a1'), v: 2 }], ['host 不是 8 位十六进制', { ...req(A, 'seat-a1'), host: 'ABCDEFGH' }], ['ts 是字符串', { ...req(A, 'seat-a1'), ts: String(Date.now()) }], ['nonce 太短', { ...req(A, 'seat-a1'), nonce: 'abc' }]]) {
    r = await exchange(body);
    ok(`请求体不成形（${name}）→ 400`, r.status === 400, `${r.status} ${r.text}`);
  }
  ok('拒掉的都没发出令牌（库里只有成功的两张）', q('SELECT COUNT(*) AS c FROM a2a_seat_tokens')[0].c === 2, String(q('SELECT COUNT(*) AS c FROM a2a_seat_tokens')[0].c));

  console.log('三、每次调用复核');
  run("DELETE FROM a2a_roster_node_seats WHERE host = ? AND seat_id = 'seat-a1'", A.fp);
  m = await mcp(tok1, 'tools/list', {});
  ok('名册撤掉席位 → 已发的令牌下一次调用 401', m.status === 401, String(m.status));
  r = await exchange(req(A, 'seat-a1'));
  ok('……也换不出新令牌', r.status === 401 && r.text === REFUSED, r.text);
  run('INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', A.root, fullFp(A.pk), A.fp, 'alpha-node/canvas/demo', 'alpha-node/a0000001', 'seat-a1', 'x', 'member', t0);
  m = await mcp(tok1, 'tools/list', {});
  ok('名册恢复这个席位 → 没到期的令牌照常', m.status === 200, String(m.status));
  run("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?", A.root);
  m = await mcp(tok1, 'tools/list', {});
  ok('停用节点 → 下一次调用 401', m.status === 401, String(m.status));
  run("UPDATE a2a_peers SET status = 'key_changed' WHERE root_url = ?", A.root);
  ok('公钥变了待确认 → 401', (await mcp(tok1, 'tools/list', {})).status === 401);
  run("UPDATE a2a_peers SET status = 'active' WHERE root_url = ?", A.root);
  ok('恢复 active → 照常', (await mcp(tok1, 'tools/list', {})).status === 200);
  const other = host('alpha-node');
  run('UPDATE a2a_peers SET public_key = ? WHERE root_url = ?', other.pk, A.root);
  ok('钉住的公钥换成了别的（管理员确认了新键）→ 指纹不再是 host，401', (await mcp(tok1, 'tools/list', {})).status === 401);
  run('UPDATE a2a_peers SET public_key = ? WHERE root_url = ?', A.pk, A.root);
  run('UPDATE a2a_seat_tokens SET expires_at = ? WHERE token_sha256 = ?', Date.now() - 1, createHash('sha256').update(tok1).digest('hex'));
  ok('到期 → 401（不续期）', (await mcp(tok1, 'tools/list', {})).status === 401);

  console.log('四、授权挂在席位上');
  const ra = await exchange(req(A, 'seat-a3')), rb = await exchange(req(A, 'seat-a3'));
  const subj = q("SELECT session_id FROM a2a_seat_subjects WHERE host = ? AND seat_id = 'seat-a3'", A.fp);
  ok('同一席位两次换到不同的令牌，落在同一个主体上', ra.status === 200 && rb.status === 200 && ra.body.token !== rb.body.token && subj.length === 1
    && q('SELECT COUNT(DISTINCT session_id) AS c FROM a2a_seat_tokens WHERE seat_id = ?', 'seat-a3')[0].c === 1, `${ra.status} ${rb.status}`);
  const sid = subj[0]?.session_id;
  ok('主体一开始没有任何授权（存量不放宽）', q('SELECT grants FROM mcp_sessions WHERE id = ?', sid)[0]?.grants === '[]');
  const g = await admin('PUT', `/api/mcp/sessions/${sid}/grants`, { grants: ['sop_run_list'] });
  const rc = await exchange(req(A, 'seat-a3'));
  const listed = (await mcp(rc.body?.token, 'tools/list', {})).body?.result?.tools ?? [];
  ok('给主体批的授权，下一张令牌照样有（跨令牌保留）', g.status === 200 && rc.status === 200 && listed.some((t) => t.name === 'sop_run_list'), JSON.stringify(g.body).slice(0, 160));
  run('INSERT INTO bench_mcp_grants (session_id, bench, tool, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)', sid, 'demo-bench', 'bench_rows_read', 'test', Date.now());
  ok('按台批的授予记在主体（session_id）上，令牌轮换不动它', q('SELECT COUNT(*) AS c FROM bench_mcp_grants WHERE session_id = ?', sid)[0].c === 1);
  const legacy = await admin('POST', '/api/mcp/sessions', { name: 'legacy-team' });
  if (legacy.body?.id) await admin('PUT', `/api/mcp/sessions/${legacy.body.id}/grants`, { grants: ['sop_run_list', 'workbench_list'] });
  const rd = await exchange(req(B, 'seat-b1'));
  const bsid = q("SELECT session_id FROM a2a_seat_subjects WHERE host = ? AND seat_id = 'seat-b1'", B.fp)[0]?.session_id;
  ok('存量的长期会话有授权，席位主体不自动并过来（新席位的主体仍是空的）', [200, 201].includes(legacy.status) && rd.status === 200 && q('SELECT grants FROM mcp_sessions WHERE id = ?', bsid)[0]?.grants === '[]', JSON.stringify(legacy.body).slice(0, 120));
  const before = rc.body?.token;
  const del = await admin('DELETE', `/api/mcp/sessions/${sid}`);
  ok('吊销主体 → 这个席位已发的令牌 401，也换不出新的', del.status === 200 && (await mcp(before, 'tools/list', {})).status === 401 && (await exchange(req(A, 'seat-a3'))).text === REFUSED, String(del.status));

  console.log('九、席位主体绑完整指纹和根地址');
  seedHost(F, [{ seat: 'zeta-node/f0000001', id: 'seat-f1' }]);
  const rf = await exchange(req(F, 'seat-f1'));
  const fsid = q("SELECT session_id FROM a2a_seat_subjects WHERE host = ? AND seat_id = 'seat-f1'", F.fp)[0]?.session_id;
  const fBound = (() => { try { return q("SELECT key_fingerprint, peer_root FROM a2a_seat_subjects WHERE session_id = ?", fsid)[0]; } catch { return undefined; } })(); // 旧库没有这两列：判红而不是跑不下去
  await admin('PUT', `/api/mcp/sessions/${fsid}/grants`, { grants: ['sop_run_list'] });
  ok('建主体时记下公钥的完整指纹（sha256 全长）和根地址', rf.status === 200 && fBound?.key_fingerprint === 'sha256:' + createHash('sha256').update(Buffer.from(F.pk, 'base64')).digest('hex') && fBound?.peer_root === F.root, JSON.stringify(fBound));
  const grantsOf = (id) => q('SELECT grants FROM mcp_sessions WHERE id = ?', id)[0]?.grants;
  // 同一宿主号、同一把键，名册和对端登记改到另一个根地址来换：是另一个主体，从空授权开始；旧主体上已发的令牌失效
  const movedRoot = 'https://zeta-moved.example.test';
  run('UPDATE a2a_peers SET root_url = ? WHERE root_url = ?', movedRoot, F.root);
  run('UPDATE a2a_roster_nodes SET peer_root = ? WHERE host = ?', movedRoot, F.fp); run('UPDATE a2a_roster_node_seats SET peer_root = ? WHERE host = ?', movedRoot, F.fp);
  const moved = await exchange(req({ ...F, root: movedRoot }, 'seat-f1'));
  const movedSid = moved.body?.token ? q('SELECT session_id FROM a2a_seat_tokens WHERE token_sha256 = ?', createHash('sha256').update(moved.body.token).digest('hex'))[0]?.session_id : undefined;
  const movedTools = (await mcp(moved.body?.token, 'tools/list', {})).body?.result?.tools ?? [];
  const movedOld = (await mcp(rf.body?.token, 'tools/list', {})).status;
  ok('同一宿主号换了根地址来换 → 另一个主体（空授权，没有旧主体批的工具）；旧主体上已发的令牌 401',
    moved.status === 200 && movedSid !== undefined && movedSid !== fsid && grantsOf(movedSid) === '[]' && !movedTools.some((t) => t.name === 'sop_run_list') && grantsOf(fsid) === JSON.stringify(['sop_run_list']) && movedOld === 401,
    JSON.stringify({ st: moved.status, movedSid, fsid, movedOld }));
  run('UPDATE a2a_peers SET root_url = ? WHERE root_url = ?', F.root, movedRoot);
  run('UPDATE a2a_roster_nodes SET peer_root = ? WHERE host = ?', F.root, F.fp); run('UPDATE a2a_roster_node_seats SET peer_root = ? WHERE host = ?', F.root, F.fp);
  // 换一把键算出同一个 8 位宿主号要 2^32 量级，测试里造不出来：改成让旧主体记着的是另一把键的完整指纹（旧主体当初是别的键建的），
  // 现在这把键签、宿主号和根地址都对得上：也是另一个主体，拿不到旧主体的授权，旧主体的令牌失效
  const backOk = (await mcp(rf.body?.token, 'tools/list', {})).status;
  // （主体名字里也带着建时的指纹算出的几位：真换了键名字自然不同，这里键没真换，旧主体一并改个名，免得撞名）
  try { run('UPDATE a2a_seat_subjects SET key_fingerprint = ? WHERE session_id = ?', 'sha256:' + 'f'.repeat(64), fsid); } catch { /* 旧库没有这一列：下面判红 */ }
  run("UPDATE mcp_sessions SET name = name || '-prev' WHERE id = ?", fsid);
  const otherKey = await exchange(req(F, 'seat-f1'));
  const okSid = otherKey.body?.token ? q('SELECT session_id FROM a2a_seat_tokens WHERE token_sha256 = ?', createHash('sha256').update(otherKey.body.token).digest('hex'))[0]?.session_id : undefined;
  const otherKeyTools = (await mcp(otherKey.body?.token, 'tools/list', {})).body?.result?.tools ?? [];
  const otherKeyOld = (await mcp(rf.body?.token, 'tools/list', {})).status;
  ok('旧主体记着的完整指纹和此刻钉住的公钥不一样（宿主号、根地址、seat_id 都相同）→ 另一个空授权的主体；旧主体的令牌 401',
    backOk === 200 && otherKey.status === 200 && okSid !== undefined && okSid !== fsid && grantsOf(okSid) === '[]' && !otherKeyTools.some((t) => t.name === 'sop_run_list') && otherKeyOld === 401,
    JSON.stringify({ backOk, st: otherKey.status, okSid, fsid, otherKeyOld }));

  console.log('九之二、同一个节点号下两个节点（撞号）');
  {
    // 另一个根地址、另一把键也报了 A 的节点号（对端启用）：按节点号认不出是哪一台，两个都不算——换不到令牌，A 已发的令牌也失效；停用撞号那台后恢复
    const SQ = 'https://squatter.example.test', SQFP = 'sha256:' + 'e'.repeat(64);
    run('INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?, ?)', A.fp, SQ, SQFP, 'squatter', t0, t0);
    run(`INSERT INTO a2a_peers (id, root_url, zone, public_key, key_fingerprint, status, registered_by, registered_at, updated_at) VALUES ('peer_squat', ?, 'squatter', ?, ?, 'active', 'test', ?, ?)`, SQ, B.pk, SQFP, t0, t0);
    const before = await exchange(req(A, 'seat-a1'));
    const beforeCall = before.body?.token ? 0 : -1;
    run("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?", SQ);
    const after = await exchange(req(A, 'seat-a1'));
    const afterCall = after.status === 200 ? (await mcp(after.body?.token, 'tools/list', {})).status : 0;
    ok('撞号：同一节点号下来了另一个节点（对端启用）→ 换令牌 401；停用撞号那台之后照常换得到、调得通', before.text === REFUSED && beforeCall === -1 && after.status === 200 && afterCall === 200, `${before.status} ${after.status} ${afterCall}`);
  }

  console.log('八、换令牌的记录');
  // 启动自检那一次（编出来的 wm-self-probe）也记了一行，这里不算它
  const logRows = () => q("SELECT * FROM a2a_seat_token_log WHERE seat_id <> 'wm-self-probe' ORDER BY id");
  const L = logRows();
  ok('每次换令牌都单独记了一行（到这里为止，请求次数 = 记录行数）', L.length === exchanges, `${L.length} vs ${exchanges}`);
  const tok1Ref = createHash('sha256').update(tok1).digest('hex').slice(0, 16);
  const issued1 = L.find((x) => x.token_ref === tok1Ref);
  ok('换到的那次：outcome = issued、verified = 1、节点和席位、到期时间、主体都记下', issued1?.outcome === 'issued' && issued1.verified === 1 && issued1.host === A.fp && issued1.seat_id === 'seat-a1' && issued1.root === A.root
    && issued1.expires_at > issued1.at && issued1.session_id > 0, JSON.stringify(issued1));
  const calls = q('SELECT DISTINCT token_ref, seat FROM mcp_calls WHERE token_ref = ?', tok1Ref);
  ok('……它的 token_ref 对得上调用审计（这张令牌拿去调了什么）', calls.length === 1 && calls[0].seat === `${A.fp}:seat-a1`, JSON.stringify(calls));
  const byReason = (reason) => L.filter((x) => x.outcome === 'refused' && x.reason === reason);
  ok('拒的记下原因：别的键签 bad-sig、席位不在名册 / 节点停用 not-live、时间窗 bad-ts、受众 wrong-audience，这些 verified = 0（host、席位只是自称）',
    byReason('bad-sig').length >= 3 && byReason('not-live').length >= 4 && byReason('bad-ts').length === 2 && byReason('wrong-audience').length === 1
      && [...byReason('bad-sig'), ...byReason('not-live'), ...byReason('bad-ts')].every((x) => x.verified === 0 && x.token_ref === ''), JSON.stringify(L.filter((x) => x.outcome === 'refused').map((x) => x.reason)));
  ok('重放记成 refused / replay、verified = 1（签名是真的）；主体被吊销记成 subject-revoked', byReason('replay').length === 1 && byReason('replay')[0].verified === 1 && byReason('subject-revoked').length === 1, JSON.stringify(byReason('replay')));
  ok('请求体不成形的也记（bad-request），字段按收到的截短', L.filter((x) => x.outcome === 'bad-request').length === 5 && L.some((x) => x.host === 'ABCDEFGH'));
  ok('启动自检编的那次换令牌不写进换令牌记录（服务端认自检请求，不看请求体）', q("SELECT COUNT(*) AS c FROM a2a_seat_token_log WHERE seat_id = 'wm-self-probe'")[0].c === 0);
  {
    // 外部匿名请求带上和自检一模一样的请求体：照常记一行，删不掉记录里的任何一行
    const PROBE_BODY = JSON.stringify({ v: 1, root: 'https://wm-self-probe.invalid', host: '00000000', seat_id: 'wm-self-probe', ts: 1, nonce: 'wm-self-probe-nonce-0000', aud: 'https://wm-self-probe.invalid', sig: 'A'.repeat(86) + '==' });
    const idsBefore = q('SELECT id FROM a2a_seat_token_log ORDER BY id').map((r) => r.id);
    const f1 = await exchange(PROBE_BODY, { 'x-real-ip': '198.51.100.7' });
    const f2 = await exchange(PROBE_BODY, { 'x-real-ip': '198.51.100.7' });
    const idsAfter = new Set(q('SELECT id FROM a2a_seat_token_log ORDER BY id').map((r) => r.id));
    const mine = q("SELECT COUNT(*) AS c FROM a2a_seat_token_log WHERE seat_id = 'wm-self-probe' AND source = '198.51.100.7' AND outcome = 'refused'")[0].c;
    ok('外部匿名请求冒用自检的请求体两次 → 两次都 401、记录多两行，之前的行一行不少', f1.status === 401 && f2.status === 401 && idsAfter.size === idsBefore.length + 2 && idsBefore.every((id) => idsAfter.has(id)) && mine === 2,
      `${f1.status} ${f2.status} ${idsBefore.length}→${idsAfter.size} ${mine}`);
  }
  const anon = await fetch(BASE + '/api/a2a/seat-token/log', { headers: { 'x-forwarded-for': '192.0.2.9' } });
  const viaAdmin = await admin('GET', `/api/a2a/seat-token/log?host=${A.fp}&seat_id=seat-a1&limit=500`);
  ok('记录只给管理员看：远程匿名读不到；管理员按节点、席位筛', anon.status === 403 && viaAdmin.status === 200 && viaAdmin.body.entries.length > 0 && viaAdmin.body.entries.every((x) => x.host === A.fp && x.seat_id === 'seat-a1'), `${anon.status} ${viaAdmin.status}`);

  console.log('七、会话名');
  const bad = await admin('POST', '/api/mcp/sessions', { name: 'seat-squatter' });
  ok('管理员建 seat- 开头的会话 → 400', bad.status === 400, JSON.stringify(bad.body));

  console.log('六、限频');
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await exchange(req(A, 'seat-a2'))).status);
  ok('同一席位一小时发到第 12 张之后（前面已发过 1 张），再要 → 429', statuses.slice(0, 11).every((s) => s === 200) && statuses[11] === 429, JSON.stringify(statuses));
  let last = 0, n = 0;
  while (n < 80) { n++; last = (await exchange({ v: 9 })).status; if (last === 429) break; }
  ok('同一来源十分钟内超过 60 次 → 429（不管成不成）', last === 429 && n <= 61, `${n} ${last}`);
  const rl = q("SELECT reason, COUNT(*) AS c FROM a2a_seat_token_log WHERE outcome = 'rate-limited' GROUP BY reason ORDER BY reason");
  ok('限频拒掉的也记（按席位 rate-limited、按来源 per-source），总行数仍 = 请求次数', JSON.stringify(rl) === JSON.stringify([{ reason: 'per-source', c: 1 }, { reason: 'rate-limited', c: 1 }]) && q("SELECT COUNT(*) AS c FROM a2a_seat_token_log WHERE seat_id <> 'wm-self-probe'")[0].c === exchanges, JSON.stringify(rl));
  // 可信反代（本机回环）后面：按反代写进来的 X-Real-IP 算来源，不同来源各算各的；记录里的来源也是它
  const viaProxy = (ip) => exchange({ v: 9 }, { 'x-real-ip': ip });
  const p1 = await viaProxy('203.0.113.5');
  let pn = 0, plast = 0;
  while (pn < 80) { pn++; plast = (await viaProxy('203.0.113.6')).status; if (plast === 429) break; }
  const p1again = await viaProxy('203.0.113.5');
  ok('可信反代后面按真实来源限频：本机回环那个来源已到上限，X-Real-IP 不同的来源照常；一个来源打满了不影响另一个', p1.status === 400 && plast === 429 && pn <= 61 && p1again.status === 400, `${p1.status} ${pn} ${plast} ${p1again.status}`);
  const srcs = q("SELECT source, COUNT(*) AS c FROM a2a_seat_token_log WHERE source IN ('203.0.113.5', '203.0.113.6') GROUP BY source ORDER BY source");
  ok('……换令牌记录里的来源是真实来源（X-Real-IP），不是反代自己', srcs.length === 2 && srcs[0].c === 2 && srcs[1].c === pn, JSON.stringify(srcs));
  // 启动自检的那次请求以 192.0.2.1 为来源（远程匿名的样子）：它不该占这个来源的额度，这个来源照样能发满 60 次
  let qn = 0, qlast = 0;
  while (qn < 80) { qn++; qlast = (await exchange('{}', { 'x-real-ip': '192.0.2.1' })).status; if (qlast === 429) break; }
  ok('启动自检那次不占来源额度：自检用的来源十分钟内照样发满 60 次，第 61 次才 429', qlast === 429 && qn === 61, `${qn} ${qlast}`);
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  child.kill();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
