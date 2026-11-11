#!/usr/bin/env node
/**
 * 市场名片声明 canvasMemberProvenance（阶段七）：声明即承诺，逐条义务各有正反例。
 *
 * 义务（出处：a2a-net docs/design/canvas-member-provenance.md 与 src/index.ts 转发门、src/peer-directory.ts memberRef）：
 *   ① sessionTeams 只列本节点自己服务的句柄，形如 <team>/<8 hex>，同一句柄只对应一个台；存量撞车的不上卡。
 *   ② 发给这些句柄的消息只在本节点投递，不转给别的宿主；查无、有歧义、带 @<fp> 后缀的一律 404（失败关闭）。
 *   ③ 句柄只由本节点密钥签发：市场签的 OriginClaim 能被上游 verifyOriginClaim 验过；同样的声明换一把钥匙签就验不过。
 *   ④ 换钥即换身份：重启后密钥、句柄都不变。
 * 开关：WM_A2A_MEMBER_PROVENANCE 缺省 on；off 时名片的 capabilities 与之前完全相同；其它值拒绝启动。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const originSrc = process.env.A2A_ORIGIN_SRC ?? resolve('..', 'dsh-open-a2a-net', 'src', 'origin-claim.ts');
const { verifyOriginClaim } = await import(pathToFileURL(originSrc).href);

const DATA = resolve('tmp/a2a-member-provenance');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const gh = await startFakeGithub();
const ADMIN = { 'X-Admin-Token': 'prov-admin' };
let child = null;
let out = '';
function boot(extra = {}) {
  out = '';
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: 'server',
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'prov-admin', MARKET_PUBLIC_URL: BASE, WM_GITHUB_API: gh.api, WM_A2A_MEMBER_PROVENANCE: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
}
async function stop() { if (!child || child.exitCode !== null) return; const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; }
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
const card = async () => (await fetch(BASE + '/.well-known/agent-card.json')).json();
async function call(method, path, body, headers = {}) { const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; }
const db = () => new DatabaseSync(join(DATA, 'workbench-market.db'));

// 「别的宿主」：市场若把消息转出去，这里会收到
let peerHits = 0;
const peerPort = await port();
const peerServer = createServer((req, res) => { peerHits++; res.writeHead(404); res.end(); });
await new Promise((r) => peerServer.listen(peerPort, '127.0.0.1', r));

try {
  console.log('开关');
  {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', env: { ...process.env, DATA_DIR: DATA, PORT: '0', WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', WM_A2A_MEMBER_PROVENANCE: 'yes' }, encoding: 'utf8', timeout: 30000 });
    ok('非法值拒绝启动', r.status !== 0 && /WM_A2A_MEMBER_PROVENANCE/.test(r.stderr + r.stdout), `status=${r.status}`);
  }

  boot();
  if (!(await ready())) throw new Error('实例未就绪：' + out.slice(-600));
  // 两个已发布、带准入绑定的 SOP
  for (const slug of ['prov-a', 'prov-b']) {
    const p = await ghPublish(BASE, gh, { slug, kind: 'sop', title: slug, changelog: 'x', files: [{ path: 'sop.yaml', content: `title: ${slug}\nsteps:\n  - key: a\n    title: A\n` }] });
    if (p.status !== 201) throw new Error('发布失败 ' + p.status);
    await call('POST', `/api/sops/${slug}/publish`, {}, ADMIN);
    await call('POST', '/api/bindings', { target_type: 'sop', target_slug: slug, agent_node: 'dsh/1a2b3c4d', mode: 'run', direction: 'admits' }, ADMIN);
  }
  { const d = db(); d.prepare("INSERT INTO settings (key, value) VALUES ('a2a_peers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([`http://127.0.0.1:${peerPort}`])); d.close(); }

  console.log('① 名片与句柄');
  const c1 = await card();
  ok('缺省声明 canvasMemberProvenance', c1.capabilities?.canvasMemberProvenance === true, JSON.stringify(c1.capabilities));
  ok('名片验签过（能力在签名面里）', verifyCard(c1, Date.now()).ok === true);
  const handles = (c1.sessionTeams ?? []).map((t) => t.team);
  ok('句柄形如 market/<8 hex>，前缀是名片 team', handles.length === 2 && handles.every((h) => /^market\/[0-9a-f]{8}$/.test(h) && h.startsWith(c1.team + '/')), JSON.stringify(handles));
  ok('句柄互不相同', new Set(handles).size === handles.length);

  console.log('② 只在本节点投递、失败关闭');
  const [ha] = handles;
  let r = await call('POST', '/a2a/direct', { team: ha, message: JSON.stringify({ sop: { action: 'start' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'prov-1' });
  ok('自己的句柄 → 本节点开 run', r.status === 200 && r.body?.task_status === 'TASK_STATE_DELIVERED', JSON.stringify(r.body).slice(0, 160));
  r = await call('POST', '/a2a/direct', { team: 'market/0badc0de', message: 'x', caller_session: 'dsh/1a2b3c4d', task_id: 'prov-2' });
  ok('查无的句柄 → 404', r.status === 404);
  r = await call('POST', '/a2a/direct', { team: `${ha}@0123abcd`, message: 'x', caller_session: 'dsh/1a2b3c4d', task_id: 'prov-3' });
  ok('带 @<fp> 后缀 → 404（不解释后缀）', r.status === 404);
  r = await call('POST', '/a2a/direct', { team: 'other/0badc0de', message: 'x', caller_session: 'dsh/1a2b3c4d', task_id: 'prov-4' });
  ok('别的 zone 的句柄 → 404', r.status === 404);
  ok('以上都没有转给别的宿主（配置的 peer 收到 0 次请求）', peerHits === 0, `hits=${peerHits}`);

  // 存量撞车：把 prov-b 的 node8 改成和 prov-a 一样
  const node8a = ha.split('/')[1];
  { const d = db(); d.prepare("UPDATE apps SET a2a_node8 = ? WHERE slug = 'prov-b'").run(node8a); d.close(); }
  const c2 = await card();
  ok('句柄撞车 → 不上卡', !(c2.sessionTeams ?? []).some((t) => t.team === ha), JSON.stringify(c2.sessionTeams));
  r = await call('POST', '/a2a/direct', { team: ha, message: JSON.stringify({ sop: { action: 'start' } }), caller_session: 'dsh/1a2b3c4d', task_id: 'prov-5' });
  ok('句柄撞车 → 入站 404（有歧义，失败关闭）', r.status === 404, JSON.stringify(r.body));
  { const d = db(); d.prepare("UPDATE apps SET a2a_node8 = ? WHERE slug = 'prov-b'").run(handles[1].split('/')[1]); d.close(); }

  console.log('③ 句柄只由本节点密钥签发');
  {
    const recvPort = await port();
    const verdicts = [];
    const recv = createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
        verdicts.push(await verifyOriginClaim(req, { cardCache: new Map(), audiences: [`http://127.0.0.1:${recvPort}`], unboundOpen: false, onUnbound: () => {}, now: Date.now(), fetch: (url, init) => fetch(url, init).then((x) => ({ ok: x.ok, status: x.status, text: () => x.text() })) }));
        res.writeHead(200); res.end('{}');
      });
    });
    await new Promise((x) => recv.listen(recvPort, '127.0.0.1', x));
    const target = `http://127.0.0.1:${recvPort}/a2a/direct`;
    // 市场自己的密钥签（同一 DATA_DIR 的 a2a-key.pem）
    const signer = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `const m = await import('./src/a2a.ts'); console.log(JSON.stringify(m.marketOriginClaim(m.a2aKeyPath(), { url: ${JSON.stringify(target)}, method: 'POST' })));`], { cwd: 'server', env: { ...process.env, DATA_DIR: DATA, MARKET_PUBLIC_URL: BASE, NODE_ENV: 'test' }, encoding: 'utf8' });
    const headers = JSON.parse(signer.stdout.trim().split('\n').pop());
    await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    ok('市场密钥签的 OriginClaim 被上游验过，身份是 market', verdicts[0]?.ok === true && (verdicts[0]?.caller ?? verdicts[0]?.zone ?? 'market') === 'market', JSON.stringify(verdicts[0]));
    // 同样的声明（caller=market、callerUrl=市场）换一把钥匙签
    const other = generateKeyPairSync('ed25519').privateKey;
    const ts = Date.now();
    const aud = `http://127.0.0.1:${recvPort}`;
    const forged = { 'X-A2A-Caller': 'market', 'X-A2A-Caller-Url': BASE, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud, 'X-A2A-Caller-Sig2': edSign(undefined, Buffer.from(JSON.stringify(['a2a-origin-claim/2', 'market', BASE, ts, aud, 'POST', '/a2a/direct'])), other).toString('base64') };
    await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', ...forged }, body: '{}' });
    ok('别的密钥冒充 market → 上游验不过', verdicts[1]?.ok === false, JSON.stringify(verdicts[1]));
    recv.close();
  }

  console.log('④ 换钥即换身份：重启后不变');
  await stop();
  boot();
  if (!(await ready())) throw new Error('重启未就绪');
  const c3 = await card();
  ok('重启后公钥不变', c3.publicKey === c1.publicKey);
  ok('重启后句柄不变', JSON.stringify((c3.sessionTeams ?? []).map((t) => t.team).sort()) === JSON.stringify([...handles].sort()));

  console.log('开关 off');
  await stop();
  boot({ WM_A2A_MEMBER_PROVENANCE: 'off' });
  if (!(await ready())) throw new Error('off 未就绪');
  const c4 = await card();
  ok('off：capabilities 与之前完全相同', JSON.stringify(c4.capabilities) === JSON.stringify({ sop: true, bindings: 'human-only', stage: 'P1-readonly' }), JSON.stringify(c4.capabilities));
  ok('off：名片验签过', verifyCard(c4, Date.now()).ok === true);
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  await stop();
  peerServer.close();
  await gh.close();
}

// sopNode8 生成避开已占用的（单元）
{
  const UNIT = resolve('tmp/a2a-member-provenance-unit');
  rmSync(UNIT, { recursive: true, force: true }); mkdirSync(UNIT, { recursive: true });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import('./src/db.ts');
    const { sopNode8 } = await import('./src/a2a.ts');
    db.prepare("INSERT INTO apps (slug, title, kind, status, a2a_node8) VALUES ('u1','u1','sop','published','aaaaaaaa')").run();
    db.prepare("INSERT INTO apps (slug, title, kind, status) VALUES ('u2','u2','sop','published')").run();
    db.prepare("INSERT INTO apps (slug, title, kind, status) VALUES ('u3','u3','sop','published')").run();
    const seq = ['aaaaaaaa', 'bbbbbbbb']; let i = 0;
    const got = sopNode8('u2', () => seq[i++]);
    let threw = '';
    try { sopNode8('u3', () => 'aaaaaaaa'); } catch (e) { threw = String(e.message); }
    const u3 = db.prepare("SELECT a2a_node8 FROM apps WHERE slug='u3'").get().a2a_node8;
    console.log(JSON.stringify({ got, threw, u3 }));`], { cwd: 'server', env: { ...process.env, DATA_DIR: UNIT, NODE_ENV: 'test' }, encoding: 'utf8' });
  let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  ok('生成 node8 时撞上已占用的 → 换一个', j?.got === 'bbbbbbbb', r.stdout + r.stderr.slice(-300));
  ok('一直撞 → 抛错，不写重复句柄', j?.threw.includes('撞车') && j?.u3 === '', JSON.stringify(j));
}

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
