#!/usr/bin/env node
/**
 * 提交人票据（阶段八 8f-2）。规格见产品化文档 02 附录「PR 8f」。台页面在沙箱里带不上登录：出 HTML 时给认得出的人一张票据，
 * 提交时放在信封的 submitter_ticket 里带回，验过才记下这个人。
 * 起隔离实例（假的登录提供方，NODE_ENV=test；台从本机的 GitHub 替身同步）。先在登录门关着的实例上测，再在登录门开着的实例上测一遍出票：
 *
 *   出票：顶层打开、iframe 嵌入都给；匿名、提供方不认的会话不给（缓存策略照旧）；带票据的页面 Cache-Control: private, no-store、按 Cookie 区分；
 *         两个人先后打开同一个台，各拿各的，不串；票据不在任何地址里
 *   验票：有效票据 → 记下提交人（数据行、事件 submitter_kind=human、事项建立人）；应答和不带票据时一样
 *   对抗：别的台的票据、过期的、有效期被改长的、改过一个字节的、主体已停用的 → 当没带（照样 201、留空）、记一笔「票据无效」、不回原因；
 *         请求体自报别人不认；票据拿去当会话 cookie、管理口令、台令牌、建立人验收、建任务中心录入——一律不认；直接形态（不套信封）不认
 *   不外泄：票据不进服务端日志、库里任何一张表（信封形态提交之后）
 *
 *   node scripts/submitter-ticket-test.mjs              测本仓库
 *   node scripts/submitter-ticket-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `submitter-ticket-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'ticket-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const TICKET_RE = /name="wm-submitter-ticket" content="([^"]+)"/;
const ticketIn = (html) => TICKET_RE.exec(html)?.[1] ?? '';
const decode = (t) => { try { return Buffer.from(t.split('.')[1], 'base64url').toString('utf8').split('\n'); } catch { return []; } };

const children = [];
async function start(dir, extraEnv) {
  const data = join(dir, 'data'), home = join(dir, 'home');
  for (const d of [data, home, join(dir, 'ext')]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(dir, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', PORT: String(port), ...extraEnv };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const inst = { child, log: '', data, base: `http://127.0.0.1:${port}` };
  child.stdout.on('data', (d) => { inst.log += String(d); }); child.stderr.on('data', (d) => { inst.log += String(d); });
  children.push(child);
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${inst.log.slice(-800)}`);
    try { ok = (await fetch(`${inst.base}/api/health`)).status < 500; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  return inst;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let gh = null;
try {
  gh = await startFakeGithub();
  const I = await start(join(OUT, 'off'), { WM_GITHUB_API: gh.api });
  const base = I.base;
  const call = async (method, path, headers, body) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const cookieOf = (s) => ({ cookie: `session_id=${SESSIONS[s]}` });
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const q = (sql, ...a) => { const c = new DatabaseSync(join(I.data, 'workbench-market.db'), { readOnly: true }); try { return c.prepare(sql).all(...a); } finally { c.close(); } };
  const tickets = () => Object.fromEntries((() => { try { return q('SELECT outcome, SUM(n) AS n FROM submitter_ticket_counts GROUP BY 1'); } catch { return []; } })().map((r) => [r.outcome, r.n]));

  for (const h of [cookieOf('alpha'), cookieOf('beta')]) await call('GET', '/api/attention', { ...SAME, ...h });
  for (const slug of ['tka', 'tkb']) {
    const pr = await ghPublish(base, gh, { slug, title: slug, files: [{ path: 'index.html', content: '<html><head><title>x</title></head><body>ok</body></html>' }] }, { 'X-Admin-Token': ADMIN_TOKEN });
    if (pr.status !== 201) throw new Error(`台 ${slug} 发布失败：${pr.status}`);
  }
  // 给 tka 一个通知绑定：提交会建事件，事项随之建出来（投递本身发不出去不要紧）
  const bind = await call('POST', '/api/bindings', ADMIN, { target_type: 'app', target_slug: 'tka', agent_node: 'syn/1a2b3c4d', direction: 'notify', notify_url: 'http://127.0.0.1:9' });
  if (bind.status !== 201) throw new Error(`绑定失败：${bind.status} ${bind.text.slice(0, 200)}`);

  const page = (slug, who, dest = 'document') => call('GET', `/apps/${slug}/`, { 'sec-fetch-dest': dest, ...(who ? cookieOf(who) : {}) });
  const appToken = (html) => /name="wm-app-token" content="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';

  check(/"source":"submitter-ticket","event":"self-check","verdict":"pass"/.test(I.log), '启动自检：票据模块自验过了（本台验得过；别的台、改一个字节、过期都验不过）');
  // ---------- 出票 ----------
  const top = await page('tka', 'alpha', 'document'), framed = await page('tka', 'alpha', 'iframe');
  const tA = ticketIn(top.text), tAf = ticketIn(framed.text);
  const nocache = (r) => /no-store/.test(r.headers.get('cache-control') ?? '') && /private/.test(r.headers.get('cache-control') ?? '') && /cookie/i.test(r.headers.get('vary') ?? '');
  check(top.status === 200 && tA && decode(tA)[0] === 'user:alpha' && decode(tA)[1] === 'tka' && top.text.includes(`window.WM_SUBMITTER_TICKET="${tA}"`) && nocache(top), '顶层打开：alpha 拿到绑着 alpha、tka 的票据（meta 和 window 变量），页面 private, no-store、按 Cookie 区分', show({ s: top.status, p: decode(tA), cc: top.headers.get('cache-control'), vary: top.headers.get('vary') }));
  check(framed.status === 200 && tAf && decode(tAf)[0] === 'user:alpha' && nocache(framed), 'iframe 嵌入：同样拿到 alpha 的票据，同样不许缓存', show({ s: framed.status, p: decode(tAf) }));
  check(Number(decode(tA)[3]) - Number(decode(tA)[2]) === 7200, '票据有效期两小时', show(decode(tA)));
  const anon = await page('tka', null), forged = await page('tka', 'forged');
  check(anon.status === 200 && !ticketIn(anon.text) && !anon.text.includes('WM_SUBMITTER_TICKET') && !/no-store/.test(anon.headers.get('cache-control') ?? ''), '匿名打开：不给票据，缓存头照旧（不加 no-store）', show({ cc: anon.headers.get('cache-control') }));
  check(forged.status === 200 && !ticketIn(forged.text), '提供方不认的会话：不给票据');
  const bTop = await page('tka', 'beta'), aAgain = await page('tka', 'alpha');
  const tB = ticketIn(bTop.text);
  check(tB && decode(tB)[0] === 'user:beta' && decode(ticketIn(aAgain.text))[0] === 'user:alpha', '两个人先后打开同一个台：各拿各的，不串', show({ b: decode(tB)[0], a: decode(ticketIn(aAgain.text))[0] }));
  const tBonB = ticketIn((await page('tkb', 'alpha')).text);
  check(decode(tBonB)[1] === 'tkb', '在别的台拿的票据绑着那个台');

  // ---------- 验票 ----------
  const tok = appToken(top.text);
  const PAGE = { origin: 'null', 'x-app-token': tok };
  const submit = (body, headers = PAGE) => call('POST', '/api/apps/tka/data', headers, body);
  const row = (id) => { try { return q('SELECT created_by, submitter_principal, data FROM app_data WHERE id = ?', id)[0]; } catch { return { submitter_principal: 'no-column' }; } }; // 旧代码没这一列：各项各自红
  const eventOf = (id) => q("SELECT event_id, submitter_kind, submitter FROM workbench_events WHERE source = 'app-data' AND item = ?", `item:${id}`)[0];
  const itemOf = (eventId) => q('SELECT creator_principal FROM work_items WHERE id = ?', `wi_${eventId}`)[0];
  {
    const t0 = tickets();
    const plain = await submit({ data: { n: 0 }, created_by: 'beta' });
    const ok = await submit({ data: { n: 1 }, created_by: 'beta', submitter_ticket: tA });
    const r = row(ok.body?.id), ev = eventOf(ok.body?.id), it = ev ? itemOf(ev.event_id) : null;
    const rec = ev ? JSON.parse(q("SELECT detail FROM workbench_event_log WHERE event_id = ? AND action = 'recorded'", ev.event_id)[0]?.detail ?? '{}') : {};
    check(ok.status === 201 && r?.submitter_principal === 'user:alpha' && r?.created_by === 'beta', '有效票据：数据行记下提交人 alpha；请求体自填的 beta 只进显示名', show({ s: ok.status, r }));
    check(ev?.submitter_kind === 'unverified' && ev?.submitter === 'beta' && rec.requester === 'user:alpha' && rec.via === 'ticket' && it?.creator_principal === 'user:alpha', '对外不升级信任：事件的提交方照旧 unverified、显示名照旧；市场内部 recorded 记下提需求的人（via:ticket），事项的建立人是 alpha', show({ ev, rec, it }));
    // 发给接收方的信封：不带票据的和今天逐字节相同的那一份对照；带票据的只多两个字段
    const env = (id) => { const e = eventOf(id); const m = e ? q('SELECT message FROM workbench_event_deliveries WHERE event_id = ?', e.event_id)[0]?.message : ''; try { return JSON.parse(m || '{}'); } catch { return {}; } };
    const eOk = env(ok.body?.id), ePlain = env(plain.body?.id);
    const extra = Object.keys(eOk).filter((k) => !(k in ePlain)).sort();
    check(eOk.submitter_kind === 'unverified' && eOk.submitter === ePlain.submitter && eOk.submitter_principal === 'user:alpha' && eOk.submitter_via === 'ticket' && show(extra) === show(['submitter_principal', 'submitter_via']) && !('submitter_principal' in ePlain) && !('submitter_via' in ePlain),
      '信封：submitter_kind 照旧 unverified，只多 submitter_principal、submitter_via:"ticket" 两个字段；不带票据的信封没有这两个字段', show({ extra, kind: eOk.submitter_kind, p: eOk.submitter_principal, via: eOk.submitter_via }));
    // 对外 kind 是 unverified，市场内部的建立人照样认：alpha 能读这件事项，验收入口按「不在等验收」拒（不是「来源未验证」）
    const page = await call('GET', `/api/work-items/wi_${ev?.event_id}`, { ...SAME, ...cookieOf('alpha') });
    const dec = await call('POST', `/api/work-items/wi_${ev?.event_id}/decision`, { ...SAME, ...cookieOf('alpha') }, { answer: 'verify' });
    check(page.status === 200 && dec.status === 409 && (dec.body?.result?.error ?? dec.body?.error) === 'work_item_not_ready', '对外 kind 仍是 unverified 时建立人照样记上：alpha 读得到事项，验收入口认他是建立人（只因不在等验收而拒）', show({ page: page.status, dec: dec.status, err: dec.body?.result?.error ?? dec.body?.error }));
    check(plain.status === 201 && show(Object.keys(plain.body ?? {}).sort()) === show(Object.keys(ok.body ?? {}).sort()), '带不带票据，应答的字段一样', show({ plain: plain.body, ok: ok.body }));
    const plainEv = eventOf(plain.body?.id);
    check(row(plain.body?.id)?.submitter_principal === null && plainEv?.submitter_kind === 'unverified', '不带票据：和今天一样（留空、unverified）', show(plainEv));
    check((tickets().valid ?? 0) - (t0.valid ?? 0) === 1 && (tickets().invalid ?? 0) === (t0.invalid ?? 0), '计数：有效一笔，不带的不记', show(tickets()));
  }
  {
    let key = Buffer.alloc(32); try { key = Buffer.from(readFileSync(join(I.data, '.wm-submitter-ticket.key'), 'utf8').trim(), 'hex'); } catch { /* 旧代码没有这把密钥 */ }
    const forge = (principal, slug, iat, exp) => { const payload = [principal, slug, String(iat), String(exp)].join('\n'); return `st1.${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', key).update('wm-submitter-ticket/v1\n' + payload).digest('base64url')}`; };
    const now = Math.floor(Date.now() / 1000);
    const sanity = forge('user:alpha', 'tka', now, now + 7200);
    const flip = (t) => { const i = t.length - 10; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1); };
    const flipBody = (t) => { const i = 6; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1); };
    const cases = [
      ['别的台（tkb）的票据', tBonB],
      ['过期的票据（同一把密钥签的）', forge('user:alpha', 'tka', now - 8000, now - 800)],
      ['有效期被改成更长（签名是对的）', forge('user:alpha', 'tka', now, now + 86400)],
      ['签发时间在将来', forge('user:alpha', 'tka', now + 3600, now + 3600 + 7200)],
      ['签名改了一个字节', flip(tA)],
      ['内容改了一个字节', flipBody(tA)],
      ['不是票据的形状', 'st1.x.y'],
      ['不是字符串', { principal: 'user:alpha' }],
    ];
    const t0 = tickets();
    const results = [];
    for (const [label, t] of cases) {
      const r = await submit({ data: { case: label }, submitter_ticket: t });
      const d = row(r.body?.id);
      results.push([label, r.status, d?.submitter_principal ?? null, show(r.body).includes('ticket') || show(r.body).includes('票据')]);
      check(r.status === 201 && d?.submitter_principal === null && !results.at(-1)[3], `${label}：当没带——照样 201、留空、不回原因`, show({ s: r.status, p: d?.submitter_principal, body: r.body }));
    }
    check((tickets().invalid ?? 0) - (t0.invalid ?? 0) === cases.length, `每一次都记一笔「票据无效」（${cases.length} 笔）`, show(tickets()));
    const good = await submit({ data: { case: 'sanity' }, submitter_ticket: sanity });
    check(row(good.body?.id)?.submitter_principal === 'user:alpha', '对照：同一把密钥按规矩签的票据验得过（上面的拒绝不是因为造票的办法不对）');
  }
  {
    const off = await call('POST', '/api/principals/disable', ADMIN, { id: 'user:beta', reason: '对抗：停用' });
    const t0 = tickets();
    const r = await submit({ data: { n: 'beta' }, submitter_ticket: tB });
    check(off.status === 200 && r.status === 201 && row(r.body?.id)?.submitter_principal === null && (tickets().invalid ?? 0) - (t0.invalid ?? 0) === 1, '主体已停用：票据在期限内也不认（照样 201、留空、记无效）', show({ off: off.status, s: r.status }));
    const page2 = await page('tka', 'beta');
    check(!ticketIn(page2.text), '停用之后再打开页面：不再给票据');
    await call('POST', '/api/principals/restore', ADMIN, { id: 'user:beta', reason: '对抗：恢复' });
  }
  {
    const r = await submit({ data: { n: 2, submitter_principal: 'user:beta', submitter_via: 'ticket' }, submitter_principal: 'user:beta', submitter_via: 'ticket', requester: 'user:beta', created_by: 'user:beta' });
    const e = eventOf(r.body?.id), m = e ? JSON.parse(q('SELECT message FROM workbench_event_deliveries WHERE event_id = ?', e.event_id)[0]?.message || '{}') : {};
    const rec = e ? JSON.parse(q("SELECT detail FROM workbench_event_log WHERE event_id = ? AND action = 'recorded'", e.event_id)[0]?.detail ?? '{}') : {};
    check(r.status === 201 && row(r.body?.id)?.submitter_principal === null && !('submitter_principal' in m) && !('submitter_via' in m) && rec.requester === undefined && rec.via === undefined,
      '请求体（信封外层和 data 里）自己带 submitter_principal、submitter_via、requester：不认，也不透传进信封外层', show({ m: Object.keys(m), rec }));
  }
  // ---------- 历史版本预览不出票 ----------
  {
    const pr = await ghPublish(base, gh, { slug: 'tka', title: 'tka', files: [{ path: 'index.html', content: '<html><head><title>v2</title></head><body>ok2</body></html>' }] }, { 'X-Admin-Token': ADMIN_TOKEN });
    const cur = await call('GET', '/apps/tka/', { 'sec-fetch-dest': 'document', ...cookieOf('alpha') });
    const old = await call('GET', '/apps/tka/?version=1', { 'sec-fetch-dest': 'document', ...cookieOf('alpha') });
    check([200, 201].includes(pr.status) && cur.headers.get('x-app-version') === 'v2' && ticketIn(cur.text) && old.status === 200 && old.headers.get('x-app-version') === 'v1' && !ticketIn(old.text) && !/no-store/.test(old.headers.get('cache-control') ?? ''),
      '历史版本预览（?version=1）：照常出页面，不出票；当前上架的版本照常出票', show({ pr: pr.status, cur: cur.headers.get('x-app-version'), old: old.headers.get('x-app-version'), oldTicket: Boolean(ticketIn(old.text)) }));
  }
  // ---------- 票据拿去打别的入口 ----------
  {
    const asCookie = await call('GET', '/api/attention', { ...SAME, cookie: `session_id=${tA}` });
    const nobody = await call('GET', '/api/attention', { ...SAME, ...cookieOf('forged') }); // 提供方不认的会话
    const asMarketSession = await call('GET', '/api/auth/viewer', { ...SAME, cookie: `wm_session=${tA}` });
    const asAdmin = await call('POST', '/api/principals/disable', { ...SAME, 'x-admin-token': tA, 'x-forwarded-for': '198.51.100.9' }, { id: 'user:alpha', reason: 'x' });
    const asAppToken = await call('GET', '/api/apps/tka/data', { origin: 'null', 'x-app-token': tA });
    const decide = await call('POST', '/api/work-items/wi_whatever/decision', SAME, { answer: 'verify', submitter_ticket: tA });
    const intake = await call('POST', '/api/sop/runs', SAME, { slug: 'task-center', submitter_ticket: tA });
    const runP = intake.body?.id ? q('SELECT requester_principal AS p FROM sop_runs WHERE id = ?', intake.body.id)[0]?.p : 'x';
    check(asCookie.status === nobody.status && show(asCookie.body?.sources) === show(nobody.body?.sources) && (asCookie.body?.items ?? []).length === 0 && Object.values(asCookie.body?.sources ?? {}).every((x) => !x.visible), '当会话 cookie：和提供方不认的会话一样（认不出人）', show({ a: asCookie.body?.sources, b: nobody.body?.sources }));
    check(!show(asMarketSession.body ?? {}).includes('alpha'), '当市场会话 cookie：认不出人', show(asMarketSession.body));
    check([401, 403].includes(asAdmin.status) && q("SELECT status FROM principals WHERE id = 'user:alpha'")[0]?.status === 'active', '当管理口令：被拒，什么都没改', show(asAdmin.status));
    check(asAppToken.headers.get('access-control-allow-origin') !== 'null', '当台令牌：不放行跨源读', show(asAppToken.headers.get('access-control-allow-origin')));
    check(decide.status === 401, '放进建立人验收的请求体：还是没登录（401）', show(decide.status));
    check(intake.status === 201 && runP === null, '放进建任务中心录入的请求体：不认（提需求的人留空）', show({ s: intake.status, runP }));
  }
  // ---------- 幂等键按提交方隔开：台页面的提交（带不带票据）是同一方，MCP 会话各是一方；页面里认不出是谁的匿名提交，重复时不回 id ----------
  {
    const env = (data, key, ticket) => ({ data, idempotency_key: key, ...(ticket ? { submitter_ticket: ticket } : {}) });
    const K = 'idem-scope-1';
    const a1 = await submit(env({ v: 'alpha' }, K, tA));
    const [b1, b2] = await Promise.all([submit(env({ v: 'beta' }, K, tB)), submit(env({ v: 'beta-again' }, K, tB))]);
    check(a1.status === 201 && b1.status === 409 && b1.body?.id === a1.body?.id && b2.status === 409,
      '两个登录的人用同一个固定键首次登记、内容不同（并发也一样）：先到的 201，后到的 409，带回那条的 id（台页面靠这个拦并发登记，行为不变）', show({ a: a1.status, b1: b1.body, b2: b2.status }));
    const b3 = await submit(env({ v: 'alpha' }, K, tB));
    check(b3.status === 200 && b3.body?.duplicate === true && b3.body?.id === a1.body?.id && typeof b3.body?.created_at === 'string', '另一个登录的人提交同键同内容：重复，带回 id 和时间（台页面靠 id 分「已登记」和「未确认」）', show(b3.body));
    const a2 = await submit(env({ v: 'alpha' }, K, tA));
    check(a2.status === 200 && a2.body?.duplicate === true && a2.body?.id === a1.body?.id, '本人原样重试：重复，带回第一次的 id', show(a2.body));
    const n1 = await submit(env({ v: 'alpha' }, K));
    check(n1.status === 200 && n1.body?.duplicate === true && !('id' in (n1.body ?? {})) && !('created_at' in (n1.body ?? {})), '认不出是谁的匿名提交，同键同内容：只说重复，不带那条的 id 和时间', show(n1.body));
    const n2 = await submit(env({ v: 'other' }, K));
    check(n2.status === 409 && !('id' in (n2.body ?? {})) && !('created_at' in (n2.body ?? {})) && !show(n2.body).includes(String(a1.body?.id)), '匿名同键不同内容：照旧 409，但不带那条的 id 和时间', show(n2.body));
    // 带着验不过的票据（别的台的、改过一个字节的）：认不出是谁，和匿名一样——重复不带 id 和时间，409 也不带
    const flip = (t) => t.slice(0, -2) + (t.at(-2) === 'A' ? 'B' : 'A') + t.at(-1);
    const badTickets = { 别的台的: tBonB, 改过一个字节的: flip(tA) };
    const badSeen = {};
    for (const [label, t] of Object.entries(badTickets)) {
      const same = await submit(env({ v: 'alpha' }, K, t)), diff = await submit(env({ v: `bad-${label}` }, K, t));
      badSeen[label] = { same: same.status, sameKeys: Object.keys(same.body ?? {}), diff: diff.status, diffKeys: Object.keys(diff.body ?? {}) };
    }
    check(Object.values(badSeen).every((x) => x.same === 200 && !x.sameKeys.includes('id') && !x.sameKeys.includes('created_at') && x.diff === 409 && !x.diffKeys.includes('id') && !x.diffKeys.includes('created_at')),
      '带验不过的票据（别的台的、改过一个字节的）：当成认不出是谁——同键同内容 200 不带 id 和时间，同键不同内容 409 也不带', badSeen);
    const K2 = 'idem-scope-2';
    const m1 = await submit(env({ v: 'anon-first' }, K2)), m2 = await submit(env({ v: 'anon-first' }, K2));
    check(m1.status === 201 && Number.isInteger(m1.body?.id) && m2.status === 200 && m2.body?.duplicate === true && !('id' in (m2.body ?? {})), '匿名首次提交照常 201 带 id；匿名再交一次：重复，不带 id', show({ m1: m1.body, m2: m2.body }));
    const stored = q('SELECT COUNT(*) AS n FROM app_data WHERE app_slug = ? AND idempotency_key = ?', 'tka', K)[0]?.n;
    check(stored === 0, '库里存的不是光秃秃的键（前面带着提交方），老代码按原键查不到这几条', show(stored));
    // 上线之前存的键（没有前缀）：按不存在处理
    const w = new DatabaseSync(join(I.data, 'workbench-market.db'));
    try { w.prepare("INSERT INTO app_data (app_slug, data, created_by, idempotency_key) VALUES ('tka', '{\"v\":\"legacy\"}', '', 'idem-legacy-1')").run(); } finally { w.close(); }
    const old = await submit(env({ v: 'legacy-different' }, 'idem-legacy-1', tA));
    check(old.status === 201, '上线之前存的键：按不存在处理，同键不同内容也照常写入（不 409）', show({ s: old.status, b: old.body }));
  }
  // ---------- 不外泄 ----------
  {
    const leaks = [];
    for (const { name } of q("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      const rows = q(`SELECT * FROM "${name}"`);
      if ([tA, tB, tAf].some((t) => show(rows).includes(t))) leaks.push(name);
    }
    check(leaks.length === 0, '信封形态提交之后，库里没有任何一张表存着票据', show(leaks));
    check(![tA, tB, tAf].some((t) => I.log.includes(t)), '服务端日志里没有票据');
  }
  {
    const r = await submit({ n: 3, submitter_ticket: tA });
    check(r.status === 201 && row(r.body?.id)?.submitter_principal === null, '直接形态（不套信封）带的 submitter_ticket：当数据，不认');
  }

  // ---------- 登录门开着：顶层打开和 iframe 嵌入都走查看凭证的跳转，照样拿到票据 ----------
  {
    const G = await start(join(OUT, 'on'), { WM_GITHUB_API: gh.api, WM_LOGIN_GATE: 'enforce' });
    await fetch(`${G.base}/api/attention`, { headers: { ...SAME, ...cookieOf('alpha') } });
    const pr = await ghPublish(G.base, gh, { slug: 'tkg', title: 'g', files: [{ path: 'index.html', content: '<html><head><title>x</title></head><body>ok</body></html>' }] }, { 'X-Admin-Token': ADMIN_TOKEN });
    const follow = async (dest, who) => {
      const h = { 'sec-fetch-dest': dest, accept: 'text/html', ...(who ? cookieOf(who) : {}) };
      let r = await fetch(`${G.base}/apps/tkg/`, { headers: h, redirect: 'manual' });
      const loc = r.headers.get('location') ?? '';
      if (r.status === 302 && loc.includes('/~wm/')) r = await fetch(new URL(loc, G.base), { headers: h, redirect: 'manual' });
      return { status: r.status, text: await r.text(), cc: r.headers.get('cache-control'), loc };
    };
    const t = await follow('document', 'alpha'), f = await follow('iframe', 'alpha'), a = await follow('document', null);
    check(pr.status === 201 && t.status === 200 && decode(ticketIn(t.text))[0] === 'user:alpha' && /no-store/.test(t.cc ?? '') && !t.loc.includes(ticketIn(t.text) || '#'), '登录门开着，顶层打开：跳到查看凭证地址后拿到票据（票据不在地址里），不许缓存', show({ pr: pr.status, s: t.status, cc: t.cc }));
    check(f.status === 200 && decode(ticketIn(f.text))[0] === 'user:alpha', '登录门开着，iframe 嵌入：同样拿到票据', show({ s: f.status }));
    check(a.status !== 200 || !ticketIn(a.text), '登录门开着，没登录：拿不到页面，更没有票据', show({ s: a.status }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  try { await gh?.close?.(); } catch { /* 替身已停 */ }
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
