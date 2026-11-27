import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.WM_SEAT_SESSION_SMOKE_TMP ?? join(root, 'tmp', 'seat-sessions-smoke');
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, 'run-'));
const data = join(work, 'data');
const home = join(work, 'home');
const ext = join(work, 'ext');
for (const path of [data, home, ext]) mkdirSync(path);
const fakeVaultPassword = 'IsolatedVault!Market-Session-2026';
const token = 'dshod_synthetic-seats-test-only';
const pairSecret = 'one-off-pair-secret-test-only';
const line = '合成会话正文';
const input = '合成插话测试';
const scope = ['session.list', 'session.read', 'session.prompt', 'session.stop'];
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const fp = 'sha256:' + createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
const key = { host: fp.slice(7, 15), team: 'fixture/canvas/main', seat: 'fixture/11223344', seat_id: 'seat-workflow' };
const session = 'session-11223344-5566-7788-9900-aabbccddeeff';
const sessionRow = { id: session, team: key.seat, joined: true, live: true, archived: false };
const requests = [];
let echo = scope;
let pollState = 'waiting';
let duplicate = false;
let refuse = false;
let drop = false;
let wrongCard = false;
let cardRequests = 0;
let afterSessionList;
let child;
let db;
let count = 0;
let log = '';
const route = '/api/teams/seat-session';
const outbound = process.argv.includes('--outbound-off') ? 'off' : 'on';

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
const peer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/.well-known/agent-card.json') {
    cardRequests++;
    const signed = signCard({ capabilities: {}, expiresAt: Date.now() + 60_000, name: 'fixture', session: 'fixture', team: 'fixture' },
      wrongCard ? generateKeyPairSync('ed25519').privateKey : privateKey);
    return json(res, 200, signed);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method, body, headers: req.headers });
  if (url.pathname === '/__dsh_a2a/owner-delegates/pair') {
    if (body?.action === 'start') return json(res, 200, { ok: true, id: 'pair-fixture', code: 'ABC123', secret: pairSecret,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: echo });
    if (body?.action === 'poll' && body.secret === pairSecret) return json(res, 200, { state: pollState, token: pollState === 'approved' ? token : undefined, scope });
  }
  if (req.headers['x-dsh-owner-delegate'] !== token || refuse) {
    return json(res, 403, { ok: false, code: 'owner-delegate-scope', error: '合成节点拒绝 ' + token });
  }
  if (req.headers['x-api-key']) return json(res, 500, { ok: false, error: 'unexpected control key' });
  if (url.pathname === '/__dsh_a2a/user/sessions' && url.searchParams.get('team') === key.seat) {
    const sessions = duplicate ? [sessionRow, { ...sessionRow, id: 'session-11223344-0000-0000-0000-aabbccddeeff' }] : [sessionRow];
    afterSessionList?.();
    return json(res, 200, { sessions, count: sessions.length, truncated: false });
  }
  if (url.pathname === '/__dsh_a2a/user/session' && url.searchParams.get('id') === session) {
    return json(res, 200, { total: 2, from: 0, to: 1, stale: false, entries: [{ i: 0, role: 'user', text: line }], secret: token });
  }
  if (url.pathname === '/__dsh_a2a/user/session/prompt' && body?.id === session) {
    if (drop) { req.socket.destroy(); return; }
    return json(res, 200, { mode: body.mode, delivered: body.mode === 'steer' ? 'steered' : 'queued', secret: token });
  }
  if (url.pathname === '/__dsh_a2a/user/session/stop' && body?.id === session) return json(res, 200, { stopped: true, secret: token });
  return json(res, 404, { ok: false, error: 'fixture route not found' });
});

async function check(name, test) {
  await test();
  count++;
  console.log('  ✓ ' + name);
}

try {
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const peerRoot = 'http://127.0.0.1:' + peer.address().port;
  let port;
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const candidate = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    // owned-script-fixture accepts ports up to 65534.
    if (candidate <= 65534) { port = candidate; break; }
  }
  assert(port, 'could not allocate a fixture port below 65535');
  const base = 'http://127.0.0.1:' + port;
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { HOME: home, TMPDIR: work, TEMP: work, TMP: work, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data,
    NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN: 'fixture-market-admin-only', REDIS_URL: '', WM_OUTBOUND: outbound,
    WM_EXTENSIONS_DIR: ext, IDENTITY_SEAM_ROOT: root, IDENTITY_FAKE_ADMIN_GRANT: 'admin', DSH_VAULT_PASSWORD: fakeVaultPassword });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(root, 'scripts/identity-fake-preload.mjs')).href, 'src/index.ts'], {
    cwd: join(root, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { log += String(chunk); });
  child.stderr.on('data', chunk => { log += String(chunk); });
  async function call(method, path, body, viewer, headers = {}) {
    const headersOut = { ...headers };
    if (viewer) Object.assign(headersOut, { 'x-forwarded-for': '192.0.2.81', origin: base, 'sec-fetch-site': 'same-origin', cookie: 'session_id=' + viewer }, headers);
    const response = await fetch(base + path, { method, headers: { ...headersOut, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), redirect: 'manual' });
    const raw = await response.text();
    return { status: response.status, cache: response.headers.get('cache-control'), json: JSON.parse(raw) };
  }
  let ready = false;
  for (const deadline = Date.now() + 35_000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await call('GET', '/api/health')).status === 200; } catch { await sleep(100); }
  }
  assert(ready, 'market did not become ready: ' + log.split('\n').slice(-7).join('\n'));
  for (const viewer of [SESSIONS.alpha, SESSIONS.beta, SESSIONS.noAdminFlag]) await call('GET', '/api/auth/viewer', undefined, viewer);
  const file = join(data, 'workbench-market.db');
  db = new DatabaseSync(file, { timeout: 5_000 });
  legacySeed(file).department('fixture', '合成团队部门');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, public_key, registered_by, registered_at, updated_at) VALUES ('peer_ab12', ?, 'fixture', '合成节点', 'active', ?, ?, 'cli', ?, ?)")
    .run(peerRoot, fp, publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), now, now);
  db.prepare("INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES (?, ?, ?, 'fixture', ?, ?)")
    .run(key.host, peerRoot, fp, now, now);
  db.prepare("INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, '合成席位', 'member', 1, 0, '', ?)")
    .run(peerRoot, fp, key.host, key.team, key.seat, key.seat_id, now);
  assert.equal((await call('POST', '/api/teams/claim', { host: key.host, team: key.team, department: 'fixture' })).status, 200);
  assert.ok([200, 201].includes((await call('POST', '/api/teams/leads', { host: key.host, team: key.team, principal: 'user:beta' })).status));
  assert.ok([200, 201].includes((await call('POST', '/api/teams/assign', { ...key, principal: 'user:alpha' })).status));
  const start = () => call('POST', route + '/pair', { action: 'start', peer_id: 'peer_ab12' });
  const poll = handle => call('POST', route + '/pair', { action: 'poll', handle });
  const read = viewer => call('GET', route + '?' + new URLSearchParams({ ...key, before: '1', limit: '1' }), undefined, viewer);
  const write = (action, viewer = SESSIONS.alpha, headers) => call('POST', route, { ...key, action, text: input, request_id: 'fixture-' + action }, viewer, headers);

  if (outbound === 'off') {
    await check('outbound off denies read, queue, stop and pairing without reaching the node', async () => {
      for (const response of [await read(SESSIONS.alpha), await write('queue'), await write('stop'), await start()]) {
        assert.equal(response.status, 503);
        assert.equal(response.json.code, 'outbound_off');
      }
      assert.deepEqual(requests, []);
      assert.equal(cardRequests, 0);
    });
  } else {
    await check('anonymous, unrelated, cross-site and fake seat do not contact node', async () => {
      assert.equal((await read()).status, 401);
      assert.equal((await read(SESSIONS.noAdminFlag)).status, 404);
      assert.equal((await write('steer', SESSIONS.alpha, { origin: 'https://cross-site.invalid', 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal((await call('POST', route, { ...key, seat_id: 'forged', action: 'stop', request_id: 'fixture-forged' }, SESSIONS.alpha)).status, 404);
      assert.equal(requests.length, 0);
    });
    await check('pairing checks pin and missing scope before polling', async () => {
      wrongCard = true;
      assert.equal((await start()).status, 409);
      assert.equal(requests.length, 0);
      wrongCard = false;
      echo = undefined;
      const response = await start();
      assert.equal(response.json.code, 'seat_session_node_version');
      assert(!JSON.stringify(response.json).includes(pairSecret));
      echo = scope;
    });
    await check('owner starts and collects one scope-bound credential', async () => {
      const started = await start();
      assert.equal(started.status, 200);
      assert.deepEqual(Object.keys(started.json).sort(), ['code', 'expires_at', 'handle', 'ok']);
      assert.deepEqual(requests.at(-1).body.scope, scope);
      assert.equal((await poll(started.json.handle)).json.state, 'waiting');
      pollState = 'approved';
      const finished = await poll(started.json.handle);
      assert.deepEqual(finished.json, { ok: true, state: 'approved' });
      assert.equal((await poll(started.json.handle)).status, 404);
      assert(!readFileSync(join(data, 'vault/default.json'), 'utf8').includes(token));
    });
    await check('assigned person and team lead read via SDK using only the matched ID', async () => {
      const before = requests.length;
      const own = await read(SESSIONS.alpha);
      const led = await read(SESSIONS.beta);
      for (const res of [own, led]) {
        assert.equal(res.status, 200);
        assert.match(res.cache, /no-store/);
        assert.deepEqual(res.json, { ok: true, entries: [{ i: 0, role: 'user', text: line }], total: 2, from: 0, to: 1, stale: false });
      }
      assert.deepEqual(requests.slice(before).map(row => row.path), ['/__dsh_a2a/user/sessions','/__dsh_a2a/user/session','/__dsh_a2a/user/sessions','/__dsh_a2a/user/session']);
      assert.equal(requests[before].query.team, key.seat);
      assert.equal(requests[before+1].query.id, session);
      assert.equal(requests[before+1].query.before, '1');
      assert.equal(JSON.parse(requests[before+1].headers['x-dsh-on-behalf-of']).id, 'user:alpha');
    });
    await check('revalidates the pinned peer after session discovery before sending a write', async () => {
      const status = db.prepare("UPDATE a2a_peers SET status = ? WHERE id='peer_ab12'");
      afterSessionList = () => status.run('disabled');
      const before = requests.length;
      try {
        const result = await write('stop');
        assert.equal(result.json.code, 'seat_session_node_changed');
        assert.deepEqual(requests.slice(before).map(x => x.method), ['GET']);
      } finally {
        afterSessionList = undefined;
        status.run('active');
      }
    });
    await check('duplicate session identity refuses before sending any write', async () => {
      duplicate = true;
      const before = requests.length;
      assert.equal((await write('stop')).status, 404);
      assert.deepEqual(requests.slice(before).map(x => x.method), ['GET']);
      duplicate = false;
    });
    await check('steer, queue and stop send one POST with its request ID and no token in reply', async () => {
      const before = requests.length;
      const a = await write('steer');
      const b = await write('queue', SESSIONS.beta);
      const c = await write('stop');
      assert.deepEqual(a.json, { ok: true, delivered: 'steered', replayed: false });
      assert.deepEqual(b.json, { ok: true, delivered: 'queued', replayed: false });
      assert.deepEqual(c.json, { ok: true, stopped: true, replayed: false });
      const writes = requests.slice(before).filter(x => x.method === 'POST');
      assert.deepEqual(writes.map(x => [x.body.id, x.body.request_id]), [[session,'fixture-steer'],[session,'fixture-queue'],[session,'fixture-stop']]);
    });
    await check('node refusal preserves its code, redacts the delegate and does not send writes', async () => {
      refuse = true;
      const before = requests.length;
      const response = await write('queue');
      assert.equal(response.status, 403);
      assert.equal(response.json.code, 'owner-delegate-scope');
      assert.match(response.json.error, /合成节点拒绝/);
      assert(!response.json.error.includes(token));
      assert.equal(requests.length, before + 1);
      refuse = false;
    });
    await check('unanswered write does not retry', async () => {
      drop = true;
      const before = requests.length;
      assert.equal((await write('steer')).status, 502);
      assert.equal(requests.slice(before).filter(x => x.method === 'POST').length, 1);
      drop = false;
    });
    await check('disabled node and revoked seat cannot reuse the stored delegate', async () => {
      let before = requests.length;
      db.prepare("UPDATE a2a_peers SET status='disabled' WHERE id='peer_ab12'").run();
      assert.equal((await read(SESSIONS.alpha)).status, 404);
      db.prepare("UPDATE a2a_peers SET status='active' WHERE id='peer_ab12'").run();
      db.prepare("UPDATE seat_assignments SET ended_at=assigned_at WHERE principal_id='user:alpha'").run();
      assert.equal((await read(SESSIONS.alpha)).status, 404);
      assert.equal(requests.length, before);
    });
    await check('audit keeps actor, node, seat, action and result only', () => {
      const audit = log.split('\n').filter(row => row.startsWith('{') && row.includes('"source":"seat-sessions"')).map(row => JSON.parse(row));
      assert(audit.some(row => row.by === 'user:alpha' && row.action === 'steer' && row.status === 200));
      for (const row of audit) assert.deepEqual(Object.keys(row).sort(), ['action','at','by','host','seat','seat_id','source','status','team']);
      for (const secret of [input, line, token, pairSecret, fakeVaultPassword]) assert(!JSON.stringify(audit).includes(secret));
    });
  }
  console.log('seat-sessions-smoke: ' + count + ' passed / 0 failed (outbound ' + outbound + ')');
} finally {
  db?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await new Promise(resolve => peer.close(resolve));
  rmSync(work, { recursive: true, maxRetries: 5, retryDelay: 100 });
}
