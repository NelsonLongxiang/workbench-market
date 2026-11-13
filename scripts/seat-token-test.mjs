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
function seedHost(h, seats, status = 'active') {
  run(`INSERT INTO a2a_peers (id, root_url, zone, public_key, key_fingerprint, status, registered_by, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
    `peer_${h.fp}`, h.root, h.name, h.pk, 'sha256:x', status, t0, t0);
  run('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)', h.fp, h.root, h.name, t0, t0);
  for (const s of seats) run('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', h.fp, `${h.name}/canvas/demo`, s.seat, s.id, 'x', 'member', t0);
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
const exchange = async (body, headers = {}) => { const r = await fetch(BASE + '/api/a2a/seat-token', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j, text: JSON.stringify(j) }; };
const mcp = async (token, method, params, headers = {}) => { const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const REFUSED = JSON.stringify({ error: 'seat_token_refused' });

const A = host('alpha-node'), B = host('beta-node'), C = host('gamma-node'), D = host('delta-node'), E = host('eps-node');
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
  run("DELETE FROM a2a_roster_seats WHERE host = ? AND seat_id = 'seat-a1'", A.fp);
  m = await mcp(tok1, 'tools/list', {});
  ok('名册撤掉席位 → 已发的令牌下一次调用 401', m.status === 401, String(m.status));
  r = await exchange(req(A, 'seat-a1'));
  ok('……也换不出新令牌', r.status === 401 && r.text === REFUSED, r.text);
  run('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', A.fp, 'alpha-node/canvas/demo', 'alpha-node/a0000001', 'seat-a1', 'x', 'member', t0);
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
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  child.kill();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
