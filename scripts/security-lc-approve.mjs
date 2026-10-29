#!/usr/bin/env node
/** S3 生命周期审批写面对抗组（security-adversarial-smoke 调用；也可单跑）：
 *  隔离实例 + 替身 Odoo（/web/session/get_session_info）+ 替身引擎（记录 argv/环境，按动作回信封），不需要真 ygl-trees。
 *  正例拒（每例都核「引擎零调用」）：无会话/伪会话/缺头/text/plain/Origin null/外域/跨站/同站别端口/旗标注入/非法授权号/缺提议号。
 *  对照放行：命令行恰为 lc approve --proposal P --grant G；断言能用签发公钥核验、sub=user:<Odoo 登录名>、req 独立重算相等；
 *  子进程环境不带本进程的 LC_ACTOR/LC_CLOCK；两次审批两张 nonce；统一待办按查看人出现生命周期源。
 *  会话收割链：台（非 Odoo 上游）把门户转来的 Cookie 头（HTTP 与 WS）原样从服务端重放给审批接口 → 401、引擎零调用。
 *  引擎换包：LC_YGL_BIN 同一路径换成非钉版 → 不再调用。状态面要管理员口令。 */
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCaptureUpstream, wsUpgrade } from './portal-odoo-session-smoke.mjs';

const STUB = String.raw`const fs = require('fs'), path = require('path');
if (process.argv[2] === '--version') { console.log('0.116.1'); process.exit(0); }
const [action, ...rest] = process.argv.slice(3);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\n');
const item = { proposal_id: 'p-abc123def456', object: 'l-1', machine: 'identity_link', from: '待确认', to: '已确认', effective_at: '2026-10-29T08:00:00+08:00', proposed_by: 'agent:mapper', domain: '产品', approvals: 0, levels: 1, grant: 'g-pm', next: 'lc approve --proposal p-abc123def456 --grant g-pm' };
const data = action === 'inbox' ? { for: 'user:pm-a', kind: '人', items: [item] } : { proposal_id: rest[1], approvals: 1, levels: 1, seq: 9 };
console.log(JSON.stringify({ status: 'applied', data, checks: [], error: null, trace_id: 'tr-stub', next: [] }));
`;

function http(port, method, path, { headers = {}, body } = {}) {
  return new Promise((done) => {
    const rq = request({ host: '127.0.0.1', port, method, path, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (rs) => {
      let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, body: j, headers: rs.headers }); });
    });
    rq.on('error', (e) => done({ status: 0, body: { error: String(e) } }));
    if (body !== undefined) rq.write(body);
    rq.end();
  });
}
async function waitReady(port, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await http(port, 'GET', '/api/health'); if (r.status && r.status < 500) return true; await new Promise((x) => setTimeout(x, 250)); }
  return false;
}

export async function runLcApproveGroup() {
  let pass = 0, fail = 0;
  const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
  const dir = mkdtempSync(join(tmpdir(), 'wm-s3-lc-'));
  const DATA = resolve('tmp/sec-lc-' + Date.now().toString(36));
  mkdirSync(DATA, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('hex');
  const keyFile = join(dir, 'workbench.key');
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const stub = join(dir, 'ygl-stub.cjs'); writeFileSync(stub, STUB);
  const calls = () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const SID = 'sidAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  const odoo = createServer((rq, rs) => {
    let s = ''; rq.on('data', (c) => (s += c)); rq.on('end', () => {
      const sid = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(rq.headers.cookie ?? ''))?.[1];
      const body = rq.method === 'POST' && rq.url === '/web/session/get_session_info' && sid === SID
        ? { jsonrpc: '2.0', id: null, result: { uid: 7, username: 'pm-a', name: 'PM A', db: 'stub' } }
        : { jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } };
      rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise((x) => odoo.listen(0, '127.0.0.1', x));
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sec-lc',
      LC_YGL_BIN: stub, LC_YGL_HOME: join(dir, 'home'), LC_WORKBENCH_KEY_FILE: keyFile, LC_ODOO_URL: `http://127.0.0.1:${odoo.address().port}`,
      LC_ACTOR: 'agent:planted', LC_ACTOR_KIND: 'agent', LC_CLOCK: '2020-01-01T00:00:00Z', LC_TEST: '', LC_IDENTITY_FILE: '' },
  });
  try {
    if (!(await waitReady(PORT))) throw new Error('S3 隔离实例未就绪');
    const H = { 'content-type': 'application/json', 'x-wm-lifecycle': '1', cookie: `session_id=${SID}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' };
    const body = JSON.stringify({ proposal_id: 'p-abc123def456', grant: 'g-pm' });
    const approve = (headers, b = body) => http(PORT, 'POST', '/api/lifecycle/approve', { headers, body: b });
    const without = (k) => Object.fromEntries(Object.entries(H).filter(([x]) => x !== k));
    const NEG = [
      ['无 Odoo 会话 → 401', without('cookie'), body, 401],
      ['伪造会话（Odoo 报过期）→ 401', { ...H, cookie: 'session_id=forgedforgedforgedforged' }, body, 401],
      ['缺 X-WM-Lifecycle → 403', without('x-wm-lifecycle'), body, 403],
      ['text/plain 跨站表单形态 → 403', { ...H, 'content-type': 'text/plain' }, body, 403],
      ['Origin: null（sandbox 自产台）→ 403', { ...H, origin: 'null' }, body, 403],
      ['外域 Origin → 403', { ...H, origin: 'http://evil.example' }, body, 403],
      ['Sec-Fetch-Site=cross-site → 403', { ...H, 'sec-fetch-site': 'cross-site' }, body, 403],
      ['Sec-Fetch-Site=same-site（同主机别端口）→ 403', { ...H, 'sec-fetch-site': 'same-site' }, body, 403],
      ['旗标注入 proposal_id=--json → 400', H, JSON.stringify({ proposal_id: '--json', grant: 'g-pm' }), 400],
      ['授权号带空格 → 400', H, JSON.stringify({ proposal_id: 'p-abc123def456', grant: 'g pm --grant g-boss' }), 400],
      ['缺 proposal_id → 400', H, JSON.stringify({ grant: 'g-pm' }), 400],
    ];
    const holes = [];
    for (const [label, headers, b, want] of NEG) {
      const r = await approve(headers, b);
      if (r.status !== want || r.body?.ok !== false) holes.push(`${label}→${r.status}`);
    }
    ok(`S3a 对抗例全拒（${NEG.length} 例，状态码逐一相符）`, holes.length === 0, holes.join(','));
    ok('S3b 被拒请求一律没调引擎（零签发零出示）', calls().length === 0, `calls=${calls().length}`);

    const r1 = await approve(H);
    const c = calls();
    ok('S3c 对照放行：合法审批 200 applied', r1.status === 200 && r1.body?.ok === true && r1.body?.status === 'applied' && r1.body?.viewer === 'user:pm-a', JSON.stringify(r1.body));
    const last = c[c.length - 1] ?? { argv: [], env: {} };
    ok('S3d 命令行恰为 lc approve --proposal P --grant G', JSON.stringify(last.argv) === JSON.stringify(['lc', 'approve', '--proposal', 'p-abc123def456', '--grant', 'g-pm']), JSON.stringify(last.argv));
    const tok = String(last.env.LC_ASSERTION ?? '');
    const [p64, s64] = tok.split('.');
    let claim = {}; try { claim = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8')); } catch {}
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
    ok('S3e 断言用签发公钥核验通过', !!s64 && verify(null, Buffer.from(p64), key, Buffer.from(s64, 'base64url')));
    const req = createHash('sha256').update(JSON.stringify(['approve', [['grant', 'g-pm'], ['proposal', 'p-abc123def456']]])).digest('hex');
    ok('S3f 声明：iss=workbench sub=user:pm-a aud=lc，req 绑定这条命令，有效期 ≤600', claim.iss === 'workbench' && claim.sub === 'user:pm-a' && claim.aud === 'lc' && claim.req === req && claim.exp - claim.iat > 0 && claim.exp - claim.iat <= 600, JSON.stringify(claim));
    ok('S3g 子进程环境白名单：不带 LC_ACTOR/LC_ACTOR_KIND/LC_CLOCK/LC_TEST，YGL_SESSION=lc-proto', !('LC_ACTOR' in last.env) && !('LC_ACTOR_KIND' in last.env) && !('LC_CLOCK' in last.env) && !('LC_TEST' in last.env) && last.env.YGL_SESSION === 'lc-proto' && last.env.YGL_HOME === join(dir, 'home'), Object.keys(last.env).join(','));
    await approve(H);
    const c2 = calls();
    const nonces = c2.map((x) => { try { return JSON.parse(Buffer.from(String(x.env.LC_ASSERTION).split('.')[0], 'base64url').toString('utf8')).nonce; } catch { return null; } });
    ok('S3h 两次审批 = 两次调用、两张不同 nonce 的断言', c2.length === 2 && nonces[0] && nonces[0] !== nonces[1], JSON.stringify(nonces));

    const t1 = await http(PORT, 'GET', '/api/tasks', { headers: { cookie: `session_id=${SID}` } });
    const lcTasks = (t1.body?.tasks ?? []).filter((t) => t.source === 'lifecycle');
    ok('S3i 统一待办：登录人看到生命周期源（含批准所需提议与授权）', t1.status === 200 && t1.body?.sources?.lifecycle?.ok === true && t1.body.sources.lifecycle.viewer === 'user:pm-a' && lcTasks.length === 1 && lcTasks[0].lc?.proposal_id === 'p-abc123def456' && lcTasks[0].lc?.grant === 'g-pm', JSON.stringify(t1.body?.sources));
    const inboxCall = calls().find((x) => x.argv[1] === 'inbox');
    ok('S3j inbox 也现签断言且 req 绑定 inbox 请求', !!inboxCall && JSON.parse(Buffer.from(String(inboxCall.env.LC_ASSERTION).split('.')[0], 'base64url').toString('utf8')).req === createHash('sha256').update(JSON.stringify(['inbox', []])).digest('hex'));
    ok('S3k 响应不许中间缓存（随 Cookie 变）', /no-store/.test(String(t1.headers?.['cache-control'] ?? '')));
    const t0 = await http(PORT, 'GET', '/api/tasks');
    ok('S3l 未登录：生命周期源 ok=false 且不出条目，其它源照常', t0.status === 200 && t0.body?.sources?.lifecycle?.ok === false && !(t0.body?.tasks ?? []).some((t) => t.source === 'lifecycle') && t0.body?.sources?.market?.ok === true, JSON.stringify(t0.body?.sources?.lifecycle));
    const st0 = await http(PORT, 'GET', '/api/lifecycle/status');
    const st = await http(PORT, 'GET', '/api/lifecycle/status', { headers: { 'x-admin-token': 'sec-lc' } });
    ok('S3m 状态面要管理员口令；带口令给出签发公钥，不回私钥路径', st0.status === 403 && st.body?.pubkey === pubHex && st.body?.engine_version === '0.116.1' && !JSON.stringify(st.body).includes(dir), `${st0.status} ${JSON.stringify(st.body)}`);

    // 会话收割链：真实有效的 SID 经门户进台，台把收到的 Cookie 头从服务端重放（无 Origin、手加 X-WM-Lifecycle）。
    // 台含 agent 能登记的「假 Odoo」：type=odoo、地址带 :8069，再带同源脚本可伪造的 wm_sso_ok——本实例只设 LC_ODOO_URL（替身 Odoo 源），
    // 可信源只有它，台的类型/端口不参与判定
    const cap = await startCaptureUpstream();
    try {
      const reg = async (name, url, type) => (await http(PORT, 'POST', '/api/workbenches', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url, ...(type ? { type } : {}) }) })).body?.id;
      const targets = [['/t', await reg('S3-harvest', `http://127.0.0.1:${cap.port}/t`)], ['/fo', await reg('S3-fake-odoo', `http://127.0.0.1:${cap.port}/fo`, 'odoo')], ['/fp:8069', await reg('S3-fake-port', `http://127.0.0.1:${cap.port}/fp:8069`)]];
      for (const [, id] of targets) {
        await http(PORT, 'GET', `/go/${id}/page`, { headers: { cookie: `session_id=${SID}; wm_sso_ok_${id}=1; keep=1` } });
        await wsUpgrade(PORT, `/go/${id}/ws`, `session_id=${SID}; wm_sso_ok_${id}=1; keep=1`);
      }
      const before = calls().length;
      const replays = [];
      for (const [base] of targets) for (const url of [`${base}/page`, `${base}/ws`]) {
        const harvested = cap.last(url)?.cookie;
        const r = await approve({ 'content-type': 'application/json', 'x-wm-lifecycle': '1', ...(harvested ? { cookie: harvested } : {}) });
        replays.push(`${url}:${harvested ?? '(无 Cookie)'}→${r.status}`);
        if (r.status !== 401 || /session_id=/.test(String(harvested ?? ''))) replays.push('HOLE');
      }
      ok('S3n 普通台与假 Odoo 台（type=odoo / :8069 + 伪造 wm_sso_ok）收割门户转发的 Cookie（HTTP 与 WS）从服务端重放审批 → 401，引擎零调用', !replays.includes('HOLE') && calls().length === before && cap.seen.length >= 6, replays.join(' | '));
    } finally { cap.close(); }

    // 引擎换包：同一路径换成非钉版引擎后，下一次审批不再调用
    writeFileSync(stub, STUB.replace("'0.116.1'", "'0.117.0'"));
    utimesSync(stub, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const n0 = calls().length;
    const sw = await approve(H);
    ok('S3o LC_YGL_BIN 原地换成 0.117.0 → 503 拒调用（钉版缓存按文件身份）', sw.status === 503 && /钉版/.test(String(sw.body?.error ?? '')) && calls().length === n0, `${sw.status} ${JSON.stringify(sw.body)}`);
    writeFileSync(stub, STUB);
  } catch (e) {
    ok('S3 组运行', false, String(e?.message ?? e));
  } finally {
    child.kill(); odoo.close();
    await new Promise((x) => setTimeout(x, 400));
    rmSync(dir, { recursive: true, force: true }); rmSync(DATA, { recursive: true, force: true });
  }
  return { pass, fail };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await runLcApproveGroup();
  console.log(`S3 lc approve: ${r.pass} passed / ${r.fail} failed`);
  process.exitCode = r.fail ? 1 : 0;
}
