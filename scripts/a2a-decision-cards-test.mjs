#!/usr/bin/env node
/**
 * 观察者落地 T8：团队的决策卡进「等你拍板」（信封 v1，统筹笔记 t8-decision-cards-proposal.md）。起隔离实例，两台假宿主（lab、evil）
 * 各自发名片；对端登记和名册直接写库（照 a2a-receipt-inbound-test 的做法）。
 *
 * 一、正例：lab 签名、团队在 lab 的名册里 → 200 stored；「关注」里出现一条（a2a-decisions，category ask，只展示、没有答法，
 *    detail 带等级、选项、推荐项、理由、文件名、去宿主拍板的完整地址）；定了之后从清单里消失。
 * 二、对抗组（都不落库、清单不变）：
 *    只带 Sig2（不绑正文）→ 401；签名对不上名片（伪造）→ 401；evil 冒充 lab 的地址用自己的钥匙签 → 401；
 *    名册里有、对端登记表里没钉住 → 401；对端停用 → 401（已有的卡也从清单里消失）；
 *    团队不在名册里 → 403；evil 给 lab 的团队报卡 → 403；
 *    形状不对（推荐项不在选项里、成员提的、等级不对、文件摘要不对、拍板地址是完整 URL）→ 400；
 *    同一个已签名请求原样重放 → 401（签名已用）。
 * 三、重复和乱序：同版同内容 → duplicate；同版不同内容 → stale；低版本 → stale；
 *    定了（rev 2）先到、建立（rev 1）后到 → stale，不复活；终态之后再来更高 rev 的建立 → stale，不复活。
 * 四、谁能看：本机命令行、属主看得到；管理层、系统管理员、管理口令看不到（来源不可见）。
 * 五、不是这种正文（版本号不对）→ 照原路，不落库。
 *
 *   node scripts/a2a-decision-cards-test.mjs              测本仓库
 *   node scripts/a2a-decision-cards-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); } };
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };

const DATA = join(HERE, '..', 'tmp', `a2a-decision-cards-${process.pid}`);
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const ADMIN_TOKEN = 'synthetic-decision-cards-admin';

// ---------- 假宿主：发名片 ----------
async function peer(zone) {
  const key = generateKeyPairSync('ed25519').privateKey;
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  const fp = 'sha256:' + createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  const p = await port();
  const url = `http://127.0.0.1:${p}`;
  const self = { zone, key, publicKey, fp, host: fp.slice(7, 15), url };
  self.server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: zone, session: zone, team: zone }, key)));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => self.server.listen(p, '127.0.0.1', r));
  return self;
}
const lab = await peer('lab');
const evil = await peer('evil');
const lab2 = await peer('labtwo');

const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const sign = (key, text) => edSign(undefined, Buffer.from(text, 'utf8'), key).toString('base64');
const digestOf = (raw) => createHash('sha256').update(raw).digest('base64url');
function signed(signer, raw, opts = {}) {
  const caller = opts.caller ?? signer.zone;
  const callerUrl = opts.callerUrl ?? signer.url;
  const ts = opts.ts ?? Date.now();
  const aud = opts.aud ?? BASE;
  const key = opts.key ?? signer.key;
  const h = { 'X-A2A-Caller': caller, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud };
  h['X-A2A-Caller-Sig2'] = sign(key, JSON.stringify(['a2a-origin-claim/2', caller, callerUrl, ts, aud, 'POST', '/a2a/direct']));
  if (opts.sig3 !== false) {
    const digest = digestOf(raw);
    h['X-A2A-Body-Sha256'] = digest;
    h['X-A2A-Caller-Sig3'] = sign(key, JSON.stringify(['a2a-origin-claim/3', caller, callerUrl, ts, aud, 'POST', '/a2a/direct', digest]));
  }
  return h;
}
const HEAD = '[A2A decision-card] v1';
const card = (over = {}) => ({ id: 'card-1', team: 'lab/canvas/Ops', proposer_kind: 'observer', level: 'P1', question: '合成：要不要把巡检改到夜里跑？', options: ['改到夜里', '保持白天'], recommended: '改到夜里', reason: '白天跑会和高峰撞', files: [{ name: '巡检记录.csv', size: 120, sha256: 'a'.repeat(64) }], created_at: '2026-11-20T08:00:00.000Z', ...over });
const env = (o = {}) => ({ event: 'created', rev: 1, card: card(o.card), decide_at: '/__dsh_a2a_nexus/?decisions=card-1', ...o, ...(o.card ? { card: card(o.card) } : {}) });
const bodyOf = (text) => JSON.stringify({ team: 'market/12345678', message: text, caller_session: 'superagent-team/a1b2c3d4e5f60718', context_id: 'decision-card', wait: false });
async function post(raw, headers) {
  const r = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  return { status: r.status, text, json };
}
/** 发一张卡：缺省 lab 签、Sig2+Sig3 */
async function send(e, opts = {}) {
  const raw = bodyOf(`${opts.head ?? HEAD}\n${typeof e === 'string' ? e : JSON.stringify(e)}`);
  const h = signed(opts.signer ?? lab, raw, opts);
  return { raw, h, r: await post(raw, h) };
}

// ---------- 市场实例 ----------
let child = null, out = '';
child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], {
  cwd: join(ROOT, 'server'),
  env: { ...process.env, DATA_DIR: DATA, HOME: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN, MARKET_PUBLIC_URL: BASE,
    WM_A2A_DIRECT_SIG: '', WM_LOGIN_GATE: '', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'admin' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const db = () => new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 });
const rows = () => { const d = db(); try { return d.prepare('SELECT team, card_id, rev, state FROM a2a_decision_cards ORDER BY team, card_id').all(); } finally { d.close(); } };
const attention = async (headers = {}) => (await fetch(BASE + '/api/attention', { headers })).json();
const cards = (v) => (v?.items ?? []).filter((x) => x.source === 'a2a-decisions');

try {
  let ready = false;
  for (const end = Date.now() + 40000; Date.now() < end && !ready;) { try { ready = (await fetch(BASE + '/api/health')).status === 200; } catch { /* 还没起来 */ } if (!ready) await new Promise((r) => setTimeout(r, 250)); }
  if (!ready) throw new Error('市场实例未就绪：' + out.slice(-800));

  // 对端登记（lab、evil 钉住、active；lab2 不登记）和名册（三台都有：lab 报 Ops、evil 报 Night、lab2 报 Two）
  {
    const d = db(); const now = new Date().toISOString();
    try {
      for (const p of [lab, evil]) d.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, public_key, key_fingerprint, status, registered_by, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 'test', ?, ?)").run(`peer_${p.zone}`, p.url, p.zone, `合成宿主 ${p.zone}`, p.publicKey, p.fp, now, now);
      for (const [p, team] of [[lab, 'lab/canvas/Ops'], [evil, 'evil/canvas/Night'], [lab2, 'labtwo/canvas/Two']]) {
        d.prepare('INSERT INTO a2a_roster_nodes (peer_root, key_fingerprint, host, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(p.url, p.fp, p.host, p.zone, now, now);
        d.prepare("INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, role, first_seen_at) VALUES (?, ?, ?, ?, ?, 'observer', ?)").run(p.url, p.fp, p.host, team, `${p.zone}/0000000${team.length % 10}`, now);
      }
    } finally { d.close(); }
  }

  console.log('一、正例');
  let s = await send(env());
  ok('lab 签名、团队在 lab 的名册里 → 200 stored', s.r.status === 200 && s.r.json?.status === 'stored', s.r.text);
  let v = await attention();
  let c = cards(v)[0];
  ok('「关注」（本机命令行）里有这一条：提问类、只展示、没有答法、没有答复地址', cards(v).length === 1 && c.category === 'ask' && c.kind === 'a2a-decision' && c.answers.length === 0 && c.answer_via === undefined, cards(v));
  ok('……detail：等级、选项、推荐项、理由、文件只有名字和大小、去宿主拍板的完整地址', c?.detail?.level === 'P1' && c.detail.options.join('|') === '改到夜里|保持白天' && c.detail.recommended === '改到夜里' && c.detail.reason === '白天跑会和高峰撞'
    && JSON.stringify(c.detail.files) === JSON.stringify([{ name: '巡检记录.csv', size: 120 }]) && c.detail.decide_at === `${lab.url}/__dsh_a2a_nexus/?decisions=card-1` && c.detail.proposer_kind === 'observer' && c.detail.team === 'lab/canvas/Ops', c?.detail);
  ok('……标题带等级和提的人', /^\[P1\] 观察者（/.test(c?.title ?? ''), c?.title);

  console.log('二、对抗组');
  const before = JSON.stringify(rows());
  const deny = async (name, e, opts, status, code) => { const x = await send(e, opts); ok(name, x.r.status === status && x.r.json?.error === code && JSON.stringify(rows()) === before, `${x.r.status} ${x.r.text}`); };
  await deny('只带 Sig2（不绑正文）→ 401', env({ card: { id: 'c-sig2' } }), { sig3: false }, 401, 'untrusted-origin');
  await deny('签名对不上名片（用别的钥匙伪造 lab）→ 401', env({ card: { id: 'c-forge' } }), { key: generateKeyPairSync('ed25519').privateKey }, 401, 'untrusted-origin');
  await deny('evil 冒充 lab 的地址、用自己的钥匙签 → 401', env({ card: { id: 'c-impersonate' } }), { signer: evil, callerUrl: lab.url, caller: 'lab' }, 401, 'untrusted-origin');
  await deny('名册里有、对端登记表里没钉住（lab2）→ 401', env({ card: { id: 'c-unpinned', team: 'labtwo/canvas/Two' } }), { signer: lab2 }, 401, 'untrusted-origin');
  await deny('团队不在 lab 的名册里 → 403', env({ card: { id: 'c-noteam', team: 'lab/canvas/Ghost' } }), {}, 403, 'team-not-bound');
  await deny('evil 给 lab 的团队报卡 → 403', env({ card: { id: 'c-cross', team: 'lab/canvas/Ops' } }), { signer: evil }, 403, 'team-not-bound');
  for (const [name, e] of [
    ['推荐项不在选项里', env({ card: { id: 'c-b1', recommended: '别的' } })],
    ['成员提的（proposer_kind member）', env({ card: { id: 'c-b2', proposer_kind: 'member' } })],
    ['等级不对', env({ card: { id: 'c-b3', level: 'P9' } })],
    ['文件摘要不对', env({ card: { id: 'c-b4', files: [{ name: 'x', size: 1, sha256: 'nothex' }] } })],
    ['拍板地址是完整 URL', env({ card: { id: 'c-b5' }, decide_at: 'https://evil.example/phish' })],
    ['rev 不是正整数', env({ card: { id: 'c-b6' }, rev: 0 })],
    ['选项只有一个', env({ card: { id: 'c-b7', options: ['只有这个'], recommended: '只有这个' } })],
  ]) await deny(`形状不对：${name} → 400`, e, {}, 400, 'decision-card-invalid');
  const bad = await send('{不是 JSON');
  ok('正文不是 JSON → 400', bad.r.status === 400 && JSON.stringify(rows()) === before, bad.r.text);
  // 原样重放：同一个已签名请求再发一次
  const fresh = await send(env({ card: { id: 'c-replay' } }));
  const replay = await post(fresh.raw, fresh.h);
  ok('同一个已签名请求原样重放 → 401（签名已用），不重复落库', fresh.r.json?.status === 'stored' && replay.status === 401 && rows().filter((x) => x.card_id === 'c-replay').length === 1, replay.text);

  console.log('三、重复和乱序');
  s = await send(env());
  ok('同版同内容（换了新签名）→ duplicate', s.r.status === 200 && s.r.json?.status === 'duplicate', s.r.text);
  s = await send(env({ card: { question: '同一版，内容改了' } }));
  ok('同版不同内容 → stale，不改', s.r.json?.status === 'stale' && cards(await attention())[0]?.detail?.question === card().question, s.r.text);
  s = await send(env({ rev: 3, event: 'created', card: { question: '第三版问题' } }));
  const s2 = await send(env({ rev: 2 }));
  ok('第 3 版之后来第 2 版 → stale', s.r.json?.status === 'stored' && s2.r.json?.status === 'stale' && rows().find((x) => x.card_id === 'card-1')?.rev === 3, [s.r.text, s2.r.text]);
  // 定了先到、建立后到：不复活
  s = await send(env({ rev: 2, event: 'decided', card: { id: 'c-order', decided_at: '2026-11-20T09:00:00.000Z', decided_option: '保持白天' } }));
  const late = await send(env({ rev: 1, card: { id: 'c-order' } }));
  const later = await send(env({ rev: 9, card: { id: 'c-order' } }));
  v = await attention();
  ok('定了（rev 2）先到、建立（rev 1）后到 → stale；更高 rev 的建立也 stale：终态不复活', s.r.json?.status === 'stored' && late.r.json?.status === 'stale' && later.r.json?.status === 'stale'
    && rows().find((x) => x.card_id === 'c-order')?.state === 'decided' && !cards(v).some((x) => x.source_id.endsWith(':c-order')), [s.r.text, late.r.text, later.r.text]);
  // 建立了的再定：从清单里消失
  await send(env({ card: { id: 'c-done' } }));
  const n1 = cards(await attention()).length;
  s = await send(env({ rev: 2, event: 'decided', card: { id: 'c-done', decided_at: '2026-11-20T10:00:00.000Z', decided_option: null } }));
  const n2 = cards(await attention()).length;
  ok('建立之后定了（属主自己写的决定，选项给 null）→ 从清单里消失', s.r.json?.status === 'stored' && n2 === n1 - 1, [n1, n2, s.r.text]);
  s = await send(env({ rev: 2, event: 'dropped', card: { id: 'c-replay' } }));
  ok('丢弃 → 从清单里消失', s.r.json?.status === 'stored' && !cards(await attention()).some((x) => x.source_id.endsWith(':c-replay')), s.r.text);

  console.log('四、谁能看');
  for (const sess of [SESSIONS.alpha, SESSIONS.beta, SESSIONS.admin]) await fetch(BASE + '/api/auth/viewer', { headers: { cookie: `session_id=${sess}` } });
  const grant = async (principal, role) => { const g = await (await fetch(BASE + '/api/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ principal, role, scope: '*', reason: '合成：决策卡可见性' }) })).json(); await fetch(BASE + `/api/grants/${g.grant?.id}/submit`, { method: 'POST' }); return (await fetch(BASE + `/api/grants/${g.grant?.id}/approve`, { method: 'POST' })).status; };
  const gOwner = await grant('user:alpha', 'owner');
  const gMgr = await grant('user:beta', 'management');
  const seen = {};
  // 带登录的请求要像浏览器那样从远端来（同源标记 + 远端地址）：本机回环、不带浏览器标记的算本机命令行
  const web = (session) => ({ cookie: `session_id=${session}`, origin: BASE, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '192.0.2.61' });
  for (const [name, headers] of [['属主', web(SESSIONS.alpha)], ['管理层', web(SESSIONS.beta)], ['系统管理员', web(SESSIONS.admin)], ['管理口令', { 'x-admin-token': ADMIN_TOKEN, 'x-forwarded-for': '192.0.2.9' }]]) {
    const x = await attention(headers); seen[name] = `${cards(x).length}/${x?.sources?.['a2a-decisions']?.visible}`;
  }
  const cliN = cards(await attention()).length;
  ok('属主看得到（和本机命令行一样多）；管理层、系统管理员、管理口令看不到，来源也不可见', gOwner === 200 && gMgr === 200 && cliN > 0 && seen['属主'] === `${cliN}/true`
    && seen['管理层'] === '0/false' && seen['系统管理员'] === '0/false' && seen['管理口令'] === '0/false', { gOwner, gMgr, cliN, seen });
  // 对端停用：它的卡不再显示，再推也不收
  { const d = db(); try { d.prepare("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?").run(lab.url); } finally { d.close(); } }
  const afterDisable = cards(await attention()).length;
  const blocked = await send(env({ card: { id: 'c-after-disable' } }));
  ok('lab 停用之后：它的卡从清单里消失，再推 401', afterDisable === 0 && blocked.r.status === 401 && !rows().some((x) => x.card_id === 'c-after-disable'), [afterDisable, blocked.r.text]);

  console.log('五、不是这种正文');
  const other = await send(env({ card: { id: 'c-v2' } }), { head: '[A2A decision-card] v2', signer: evil });
  ok('版本号不对（v2）→ 不走这条分流、不落库', other.r.json?.error !== 'decision-card-invalid' && other.r.json?.error !== 'team-not-bound' && !rows().some((x) => x.card_id === 'c-v2'), other.r.text);
  ok('服务端输出里没有签名值', !out.includes(fresh.h['X-A2A-Caller-Sig3']));
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; }
  for (const p of [lab, evil, lab2]) p.server.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`a2a-decision-cards-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
