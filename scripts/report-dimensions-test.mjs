#!/usr/bin/env node
/**
 * 报告的维度和模板（docs/report-step1.md 报告第 1 步 PR A：两张表加复核、留痕，维度服务，report.dimension-* 路由，area-report 预设和收窄规则）的对抗组。
 * 隔离实例（NODE_ENV=test），站内账号走浏览器的真实路径。照 scripts/areas-test.mjs 的做法起实例、登录。
 * 合成的人：olga 属主、mona 管理层（范围 *）、sam 系统管理员、tom 普通员工、nina 没有授予；
 * leo 是 zeta 领域的负责人（让 zeta 变 active）；rex、ria 持 zeta 的 area-report；sid 持 zeta 的 area-spec（定规范，不是定报告维度）；
 * cal 持只列 report.dimension-set 的自定义角色（一条范围 *、一条范围 area:zeta）。
 *
 *   R1 （规格第五节 #1）管理层、系统管理员、管理口令、普通员工、没授予的人、列了 report.dimension-set 的自定义角色（范围 * 和 area:zeta）
 *      建维度、发模板：403，库里没有变化；属主（浏览器）、本机命令行：201
 *   R2 （#2）持 zeta 的 area-report：在 zeta 建维度、发模板成；在 eta、跨领域的建或发 403；持 area-spec 的不算（硬规则按角色名）；
 *      area-report、只列定报告维度的自定义角色带领域范围：起草只有属主（和定规范同一条红线，按权限覆盖判）
 *   R2c 持一个标识正好是 null 的领域的 area-report：定不了跨领域的维度（跨领域不会被拼成 area:null）
 *   R3 （#3）库里直接改、删模板版本、复核、留痕：触发器拒；同 (维度, 版本) 再插：拒；生效指针指没复核的判据类版本或不存在的版本：拒；
 *      作者本人复核（直接写库）：拒；撤了的维度直接改：拒；判据没复核过却记成 layout（直接写库）：拒
 *   R3b 库里写进一行判据摘要抄了复核过那一版、正文判据却改了的版本：移指针时服务按正文重算摘要，409（库核不了 sha256）
 *   R4 （#4）模板形状不对：reason_required 不是 true、min 大于 max、kind 重复、不认识的键、schema_version 不是 2、不是对象、超 200 KB、sha256 对不上：400
 *   R5 （#5）请求里写 kind：400；kind 和判据摘要由服务算：还没有复核过的版本时都是 criteria；只改版式的判据摘要不变
 *   R5b2（#926 增量验收）判据五块（claims、responses、gate、slots、parameters）各自单独改：都算 criteria、摘要两两不同、没复核生效 409
 *   R5a（属主 2026-11-21）判据类版本没复核就移成生效 409；在没复核的版本上只改标题的也 409（#926 独立验收，路径一）；
 *      别的持有人复核 200、再复核 409；复核过后生效 200；判据和复核过的版本一样的版本不用另外复核就能生效
 *   R5b～R5e（复核人口径，统筹 11-21 裁定）：作者本人 403（换个留痕写法、主体相同也算）；本机命令行、管理口令不能复核 403；
 *      本机命令行不能发判据类版本 403；跨领域维度属主自己发的，属主自己、本机命令行都复核不了
 *   R5f（#926 独立验收，路径二）偷换生效的判据：在没复核的判据上只改标题仍是 criteria、不能生效，命令行也借不了道；
 *      判据和复核过的版本一样的才是 layout；按判据内容认复核（复核了 v3，判据一样的 v2 也能生效）
 *   R5h（#926 独立验收 E1、E2）复核人是判据一样的任何一版的作者都算本人：借别人只改标题的那一版复核自己的判据 403，库里也拒
 *   R5g（统筹 #926 增量验收条件 1）停用了的人带管理口令加会话复核：会话认不出，硬规则先拦 403，走不到复核（证明这一支到不了认人）
 *   R6 读：登录的人都能读（普通员工、没授予的人也行）；远程匿名读、写 401；跨站来的写 403
 *   R7 不存在的维度、版本 404；撤了的维度：发版、复核、移指针、再撤 409，读照常
 *
 *   node scripts/report-dimensions-test.mjs
 */
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `report-dimensions-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-report-dimensions-admin-token';
const BUSY_MS = 10_000;
const PUBLIC_ORIGIN = 'https://market.example.test:9443';
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const children = [];
let log = '';
rmSync(OUT, { recursive: true, force: true });

async function boot(publicMarket = false) {
  const port = await freePort();
  const controlPort = publicMarket ? await freePort() : 0;
  const base = `http://127.0.0.1:${port}`;
  const fixture = join(OUT, publicMarket ? 'public' : 'direct');
  const data = join(fixture, 'data'), home = join(fixture, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: String(controlPort), DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', MARKET_PUBLIC_URL: publicMarket ? PUBLIC_ORIGIN : base, WM_TRUSTED_PROXIES: '127.0.0.1', ADMIN_TOKEN });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);

  /** 浏览器：同源标记 + 自己的 cookie 罐 + 自己的来源地址；跟着页面上新的表单地址走（state 一次性） */
  const browser = (ip) => {
    const jar = new Map(), moved = new Map();
    const latest = (p) => { let q = p; for (let i = 0; i < 100 && moved.has(q); i++) q = moved.get(q); return q; };
    const go = async (method, path0, { form, json, headers = {} } = {}) => {
      const path = method === 'POST' ? latest(path0) : path0;
      const h = { 'sec-fetch-site': 'same-origin', origin: base, 'x-real-ip': ip, ...headers };
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let body;
      if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(new URL(path, base), { method, headers: h, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1); if (/max-age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v); }
      const text = await res.text();
      const act = /<form method="post" action="([^"]+)"/.exec(text)?.[1];
      if (method === 'POST' && act && act !== path) moved.set(path, act);
      let j = null; try { j = JSON.parse(text); } catch { /* 页面 */ }
      return { status: res.status, location: res.headers.get('location') ?? '', text, json: j };
    };
    return { go, jar };
  };
  const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? '';
  async function login(username, password, newPw, ip) {
    const b = browser(ip);
    const r0 = await b.go('GET', '/login/local?next=/');
    const form = r0.location ? new URL(r0.location).pathname + new URL(r0.location).search : '';
    let r = await b.go('POST', form, { form: { username, password } });
    if (r.status === 200 && ticketOf(r.text)) r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: newPw, confirm: newPw } });
    if (r.status === 302) await b.go('GET', new URL(r.location).pathname + new URL(r.location).search);
    return b;
  }
  /** 本机命令行（回环、不带浏览器标记）：属主 */
  const cli = (method, path, json) => fetch(new URL(path, base), { method, headers: json === undefined ? {} : { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  /** 远程来的请求（经受信代理报的来源地址），可带管理口令 */
  const remote = (method, path, { json, token, headers = {} } = {}) => fetch(new URL(path, base), {
    method, headers: { 'x-real-ip': '198.51.100.9', ...(token ? { 'x-admin-token': token } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 应答 */ }
    return { status: r.status, json, text };
  });
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成' }); const id = d.json?.grant?.id; await cli('POST', `/api/grants/${id}/submit`); const a = await cli('POST', `/api/grants/${id}/approve`); return { id, status: a.status }; };
  const person = async (username, pw, ip) => { const t = (await cli('POST', '/api/local-accounts', { username })).json?.temp_password ?? ''; return login(username, t, pw, ip); };
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS });
  const publicPost = (path, { actor, headers = {}, body = {}, control = false, method = 'POST' } = {}) => {
    const h = { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin', 'x-real-ip': '192.0.2.99', ...headers };
    if (actor?.jar.size) h.cookie = [...actor.jar].map(([key, value]) => key + '=' + value).join('; ');
    for (const key of Object.keys(h)) if (h[key] === undefined) delete h[key];
    const payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
    h['content-length'] = String(Buffer.byteLength(payload));
    // fetch 会替换 Host。只连本机隔离监听，用 node:http 保留要测试的 Host。
    return new Promise((resolve, reject) => {
      const req = httpRequest(new URL(path, control ? 'http://127.0.0.1:' + controlPort : base),
        { method, headers: h, signal: AbortSignal.timeout(15000) }, res => {
          let text = '';
          res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('error', reject).on('end', () => {
            let json = null;
            try { json = JSON.parse(text); } catch { /* 控制面也可能返回文本 */ }
            resolve({ status: res.statusCode, json });
          });
        });
      req.on('error', reject).end(payload);
    });
  };
  return { base, browser, login, cli, remote, grant, person, db, publicPost, controlPort };
}

/** 库里的维度、模板、复核、留痕各有几行（看「库里没有变化」） */
const counts = (A) => {
  const d = A.db();
  try {
    const n = (sql) => Number(d.prepare(sql).get().n);
    return {
      dims: n('SELECT COUNT(*) AS n FROM report_dimensions'), tpls: n('SELECT COUNT(*) AS n FROM report_templates'),
      reviews: n('SELECT COUNT(*) AS n FROM report_template_reviews'), events: n('SELECT COUNT(*) AS n FROM report_dimension_events'),
      active: n('SELECT COUNT(*) AS n FROM report_dimensions WHERE active_version IS NOT NULL'), retired: n("SELECT COUNT(*) AS n FROM report_dimensions WHERE status = 'retired'"),
    };
  } catch (e) { return { error: String(e?.message ?? e) }; } finally { d.close(); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const sqlThrows = (A, sql, ...args) => { const d = A.db(); try { return throws(() => d.prepare(sql).run(...args)); } finally { d.close(); } };

/** 一份合格的模板（第三节的形状）；over 覆盖顶层键 */
const tpl = (over = {}) => ({
  schema_version: 2, title: '合成·经营维度',
  parameters: { period: { type: 'month', required: true } }, fields: { summary: { required: true, max_length: 2000 } },
  slots: { details: { columns: [{ name: 'id', type: 'integer', label: '编号' }], key: ['id'], max_rows: 500, completeness: 'all' } },
  body: [{ id: 'cover', type: 'cover', title: ['合成'] }],
  claims: [{ kind: 'conclusion', label: '结论', min: 1, max: 3 }, { kind: 'risk', label: '风险', min: 0, max: 10 }],
  responses: { stances: ['agree', 'dispute', 'supplement'], reason_required: true },
  gate: { open_dispute_blocks_acceptance: false },
  ...over,
});

try {
  const A = await boot();
  const olga = await A.person('olga', 'Olga-pass-00001', '192.0.2.71'); const go = await A.grant('user:olga', 'owner');
  const mona = await A.person('mona', 'Mona-pass-00001', '192.0.2.72'); const gm = await A.grant('user:mona', 'management');
  const sam = await A.person('sam', 'Sam-pass-000001', '192.0.2.73'); const gs = await A.grant('user:sam', 'admin');
  const tom = await A.person('tom', 'Tom-pass-000001', '192.0.2.74'); const gt = await A.grant('user:tom', 'member');
  const nina = await A.person('nina', 'Nina-pass-00001', '192.0.2.75');
  const leo = await A.person('leo', 'Leo-pass-000001', '192.0.2.76');
  const rex = await A.person('rex', 'Rex-pass-000001', '192.0.2.77');
  const ria = await A.person('ria', 'Ria-pass-000001', '192.0.2.78');
  const sid = await A.person('sid', 'Sid-pass-000001', '192.0.2.79');
  const cal = await A.person('cal', 'Cal-pass-000001', '192.0.2.80');
  await A.cli('POST', '/api/areas', { id: 'zeta', name: '己领域' });
  await A.cli('POST', '/api/areas', { id: 'eta', name: '庚领域' });
  /** 本机命令行起草、提交、放行一条授予（属主那一档） */
  const cliGrant = async (principal, role, scope) => {
    const d = await A.cli('POST', '/api/grants', { principal, role, scope, reason: '合成' }); const id = d.json?.grant?.id;
    await A.cli('POST', `/api/grants/${id}/submit`); const a = await A.cli('POST', `/api/grants/${id}/approve`);
    return { id, status: a.status, draft: d.status, error: d.json?.error ?? null };
  };
  const lead = await cliGrant('user:leo', 'area-lead', 'area:zeta');
  const leadEta = await cliGrant('user:leo', 'area-lead', 'area:eta');
  const rexG = await cliGrant('user:rex', 'area-report', 'area:zeta');
  const riaG = await cliGrant('user:ria', 'area-report', 'area:zeta');
  const sidG = await cliGrant('user:sid', 'area-spec', 'area:zeta');
  // 一个标识正好是 null 的领域，rex 持它的 area-report：跨领域的维度（area 为空）不能被它冒充成 area:null（R2c）
  await A.cli('POST', '/api/areas', { id: 'null', name: '名叫 null 的领域' });
  const leadNull = await cliGrant('user:leo', 'area-lead', 'area:null');
  const rexNull = await cliGrant('user:rex', 'area-report', 'area:null');
  // 只列 report.dimension-set 的自定义角色：一条范围 *，一条范围 area:zeta
  await A.cli('POST', '/api/roles/guest/copy', { id: 'report-setter', name: '合成只定报告维度' });
  await A.cli('PUT', '/api/roles/report-setter', { permissions: [{ actions: ['report.dimension-set'] }] });
  await A.cli('POST', '/api/roles/report-setter/approve');
  const calStar = await cliGrant('user:cal', 'report-setter', '*');
  const calZeta = await cliGrant('user:cal', 'report-setter', 'area:zeta');
  check([go, gm, gs, gt, lead, leadEta, rexG, riaG, sidG, calStar, calZeta, leadNull, rexNull].every((g) => g.status === 200),
    '（准备）属主、管理层、系统管理员、普通员工；zeta、eta 的负责人；rex、ria 持 zeta 的 area-report；sid 持 zeta 的 area-spec；cal 持只列定报告维度的自定义角色（* 和 area:zeta）',
    { go, gm, gs, gt, lead, leadEta, rexG, riaG, sidG, calStar, calZeta, leadNull, rexNull });

  // ---- R1 只有属主、本机命令行和本领域 area-report 持有人能定 ----
  {
    await A.cli('POST', '/api/report-dimensions', { id: 'ops-cli', title: '本机建的', area: 'zeta' });
    const before = counts(A);
    const tries = [];
    for (const [who, b] of [['mona', mona], ['sam', sam], ['tom', tom], ['nina', nina], ['cal', cal], ['sid', sid]]) {
      tries.push([`${who}:create`, (await b.go('POST', '/api/report-dimensions', { json: { id: `by-${who}`, title: '合成', area: 'zeta' } })).status]);
      tries.push([`${who}:template`, (await b.go('POST', '/api/report-dimensions/ops-cli/templates', { json: { body: tpl() } })).status]);
    }
    tries.push(['admin-token:create', (await A.remote('POST', '/api/report-dimensions', { json: { id: 'by-token', title: '合成', area: 'zeta' }, token: ADMIN_TOKEN })).status]);
    tries.push(['admin-token:template', (await A.remote('POST', '/api/report-dimensions/ops-cli/templates', { json: { body: tpl() }, token: ADMIN_TOKEN })).status]);
    const after = counts(A);
    check(tries.every(([, s]) => s === 403) && same(before, after),
      'R1a 管理层（范围 *）、系统管理员、普通员工、没授予的人、只列定报告维度的自定义角色（* 和 area:zeta）、持 area-spec 的人、管理口令：建维度、发模板 403，库里没有变化', { tries, before, after });
    const byOwner = await olga.go('POST', '/api/report-dimensions', { json: { id: 'ops', title: '经营', area: 'zeta' } });
    const byOwnerCross = await olga.go('POST', '/api/report-dimensions', { json: { id: 'company', title: '公司整体' } });
    const byCliCross = await A.cli('POST', '/api/report-dimensions', { id: 'company-cli', title: '本机建的跨领域' });
    check(byOwner.status === 201 && byOwner.json?.dimension?.area_id === 'zeta' && byOwnerCross.status === 201 && byOwnerCross.json?.dimension?.area_id === null && byCliCross.status === 201,
      'R1b 属主（浏览器）建领域维度、跨领域维度，本机命令行建跨领域维度：201', { o: byOwner.status, oc: byOwnerCross.status, c: byCliCross.status });
  }

  // ---- R2 area-report 持有人只能定本领域的 ----
  {
    await A.cli('POST', '/api/report-dimensions', { id: 'eta-dim', title: '庚领域的', area: 'eta' });
    const own = await rex.go('POST', '/api/report-dimensions', { json: { id: 'rex-dim', title: 'rex 建的', area: 'zeta' } });
    const ownTpl = await rex.go('POST', '/api/report-dimensions/rex-dim/templates', { json: { body: tpl(), note: '第一版' } });
    const before = counts(A);
    const other = await rex.go('POST', '/api/report-dimensions', { json: { id: 'rex-eta', title: '合成', area: 'eta' } });
    const cross = await rex.go('POST', '/api/report-dimensions', { json: { id: 'rex-cross', title: '合成' } });
    const otherTpl = await rex.go('POST', '/api/report-dimensions/eta-dim/templates', { json: { body: tpl() } });
    const crossTpl = await rex.go('POST', '/api/report-dimensions/company/templates', { json: { body: tpl() } });
    const crossRetire = await rex.go('POST', '/api/report-dimensions/company/retire', { json: {} });
    check(own.status === 201 && ownTpl.status === 201 && [other, cross, otherTpl, crossTpl, crossRetire].every((r) => r.status === 403) && same(before, counts(A)),
      'R2a 持 zeta 的 area-report：在 zeta 建维度、发模板 201；在 eta、跨领域的建、发版、撤 403，库里没有变化',
      { own: own.status, ownTpl: ownTpl.status, other: other.status, cross: cross.status, otherTpl: otherTpl.status, crossTpl: crossTpl.status, crossRetire: crossRetire.status });
    // area-report 带领域范围：起草、放行只有属主（和定规范同一条红线，按权限覆盖判）
    const samDraft = await sam.go('POST', '/api/grants', { json: { principal: 'user:tom', role: 'area-report', scope: 'area:zeta', reason: '合成' } });
    const monaDraft = await mona.go('POST', '/api/grants', { json: { principal: 'user:tom', role: 'area-report', scope: 'area:zeta', reason: '合成' } });
    const leoDraft = await leo.go('POST', '/api/grants', { json: { principal: 'user:tom', role: 'area-report', scope: 'area:zeta', reason: '合成' } });
    const starDraft = await A.cli('POST', '/api/grants', { principal: 'user:tom', role: 'area-report', scope: '*', reason: '合成' });
    // 也核拒绝的原因。系统管理员过得了写请求总门，拦它的是「只有属主能起草」（area_owner_only）这条红线，不是角色不存在之类别的原因；
    // 只列 report.dimension-set 的自定义角色带 area: 范围，同样被这条红线拦（按权限覆盖判，不按角色名）。管理层、领域负责人不是管理员，在总门就 403
    const customDraft = await sam.go('POST', '/api/grants', { json: { principal: 'user:tom', role: 'report-setter', scope: 'area:zeta', reason: '合成' } });
    check(samDraft.status === 403 && samDraft.json?.error === 'area_owner_only' && customDraft.status === 403 && customDraft.json?.error === 'area_owner_only'
        && monaDraft.status === 403 && leoDraft.status === 403 && starDraft.status === 422 && starDraft.json?.error === 'area_scope_required' && rexG.draft === 201,
      'R2b area-report 和只列定报告维度的自定义角色带领域范围：系统管理员起草 403 area_owner_only（和定规范同一条红线）；管理层、领域负责人 403；area-report 不能带范围 *（422 area_scope_required）；属主起草得了',
      { sam: `${samDraft.status}:${samDraft.json?.error}`, custom: `${customDraft.status}:${customDraft.json?.error}`, mona: monaDraft.status, leo: leoDraft.status, star: `${starDraft.status}:${starDraft.json?.error}`, owner: rexG.draft });
  }

  // ---- R2c 跨领域不会被冒充成一个叫 null 的领域 ----
  {
    const before = counts(A);
    const crossCreate = await rex.go('POST', '/api/report-dimensions', { json: { id: 'rex-cross-2', title: '合成' } });
    const crossTpl = await rex.go('POST', '/api/report-dimensions/company/templates', { json: { body: tpl() } });
    const inNull = await rex.go('POST', '/api/report-dimensions', { json: { id: 'in-null', title: '建在 null 领域', area: 'null' } });
    const after = counts(A);
    check(crossCreate.status === 403 && crossTpl.status === 403 && inNull.status === 201 && after.dims === before.dims + 1 && after.tpls === before.tpls,
      'R2c 持「名叫 null 的领域」的 area-report：建跨领域维度、给跨领域维度发模板仍然 403；建在 null 领域里的照常 201', { crossCreate: crossCreate.status, crossTpl: crossTpl.status, inNull: inNull.status });
  }

  // ---- R3 触发器 ----
  {
    // 判据类版本作者要认得出是谁（统筹 11-21 裁定）：第一版由属主在浏览器里发，不再由本机命令行发
    await olga.go('POST', '/api/report-dimensions/ops/templates', { json: { body: tpl(), note: '属主发的第一版' } });
    const t = [
      ['改模板', sqlThrows(A, "UPDATE report_templates SET note = 'x' WHERE dimension_id = 'ops' AND version = 1")],
      ['删模板', sqlThrows(A, "DELETE FROM report_templates WHERE dimension_id = 'ops' AND version = 1")],
      ['同版本再插', sqlThrows(A, "INSERT INTO report_templates (dimension_id, version, body, sha256, criteria_sha256, kind, note, created_at, created_by, created_by_principal) VALUES ('ops', 1, '{}', ?, ?, 'criteria', '', 1, 'x', 'user:olga')", 'a'.repeat(64), 'a'.repeat(64))],
      ['指针指没复核的判据类', sqlThrows(A, "UPDATE report_dimensions SET active_version = 1 WHERE id = 'ops'")],
      ['指针指不存在的版本', sqlThrows(A, "UPDATE report_dimensions SET active_version = 99 WHERE id = 'ops'")],
      ['作者本人复核（写库）', sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('ops', 1, 'user:olga', 'user:olga', 1)")],
      // 换个留痕写法、主体还是作者（统筹 #926 增量验收条件 2）：只命中触发器里比主体的那一半
      ['作者本人换个写法复核（写库）', sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('ops', 1, 'admin-token', 'user:olga', 1)")],
      ['复核人主体为空（写库，本机命令行那种）', sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('ops', 1, 'cli', NULL, 1)")],
      ['判据类版本作者主体为空（写库）', sqlThrows(A, "INSERT INTO report_templates (dimension_id, version, body, sha256, criteria_sha256, kind, note, created_at, created_by, created_by_principal) VALUES ('ops', 2, '{}', ?, ?, 'criteria', '', 1, 'cli', NULL)", 'b'.repeat(64), 'b'.repeat(64))],
      // 判据没有复核过的版本记成版式类（#926 独立验收 D3）：库也拒
      ['判据没复核过却记成版式类（写库）', sqlThrows(A, "INSERT INTO report_templates (dimension_id, version, body, sha256, criteria_sha256, kind, note, created_at, created_by, created_by_principal) VALUES ('ops', 2, '{}', ?, ?, 'layout', '', 1, 'user:olga', 'user:olga')", 'b'.repeat(64), 'c'.repeat(64))],
      ['复核不存在的版本', sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_at) VALUES ('ops', 9, 'user:ria', 1)")],
      ['删留痕', sqlThrows(A, "DELETE FROM report_dimension_events WHERE dimension_id = 'ops'")],
      ['改留痕', sqlThrows(A, "UPDATE report_dimension_events SET detail = 'x' WHERE dimension_id = 'ops'")],
      ['删维度', sqlThrows(A, "DELETE FROM report_dimensions WHERE id = 'ops'")],
      ['改维度所属领域', sqlThrows(A, "UPDATE report_dimensions SET area_id = 'eta' WHERE id = 'ops'")],
    ];
    const okReview = await ria.go('POST', '/api/report-dimensions/ops/templates/1/review', { json: { note: '看过' } });
    const t2 = [
      ['改复核', sqlThrows(A, "UPDATE report_template_reviews SET note = 'x' WHERE dimension_id = 'ops' AND version = 1")],
      ['删复核', sqlThrows(A, "DELETE FROM report_template_reviews WHERE dimension_id = 'ops' AND version = 1")],
    ];
    // 库里写进一行判据摘要抄了复核过那一版、正文的判据却改了的版本：库这一层核不了摘要（SQLite 没有 sha256），移指针时服务按正文重算，409
    const d = A.db();
    let forged = false;
    try {
      const v1c = d.prepare("SELECT criteria_sha256 AS c FROM report_templates WHERE dimension_id = 'ops' AND version = 1").get()?.c;
      const body = JSON.stringify(tpl({ claims: [{ kind: 'conclusion', label: '结论', min: 0, max: 3 }] }));
      d.prepare("INSERT INTO report_templates (dimension_id, version, body, sha256, criteria_sha256, kind, note, created_at, created_by, created_by_principal) VALUES ('ops', 2, ?, ?, ?, 'layout', '', 1, 'user:olga', 'user:olga')")
        .run(body, sha(body), v1c);
      forged = true;
    } catch { /* 下面判 */ } finally { d.close(); }
    const forgedActivate = await olga.go('POST', '/api/report-dimensions/ops/activate', { json: { version: 2 } });
    check(t.every(([, x]) => x) && okReview.status === 200 && t2.every(([, x]) => x), 'R3 库里直接改删模板、复核、留痕、维度，同版本再插，指针指没复核的判据类或不存在的版本，作者本人复核，复核人或判据类作者主体为空，判据没复核过却记成版式类：触发器都拒', { t, okReview: okReview.status, t2 });
    check(forged && forgedActivate.status === 409 && forgedActivate.json?.error === 'report_template_criteria_mismatch',
      'R3b 库里写进一行判据摘要和正文对不上的版本（抄了复核过那一版的摘要）：移指针时服务按正文重算，409 criteria_mismatch', { forged, forgedActivate: `${forgedActivate.status}:${forgedActivate.json?.error ?? ''}` });
  }

  // ---- R4 模板形状 ----
  {
    await A.cli('POST', '/api/report-dimensions', { id: 'shape', title: '形状', area: 'zeta' });
    const before = counts(A);
    const bad = {
      reasonFalse: tpl({ responses: { stances: ['agree'], reason_required: false } }),
      minOverMax: tpl({ claims: [{ kind: 'conclusion', label: '结论', min: 3, max: 1 }] }),
      dupKind: tpl({ claims: [{ kind: 'a', label: 'a', min: 0, max: 1 }, { kind: 'a', label: 'b', min: 0, max: 1 }] }),
      unknownKey: { ...tpl(), script: 'x' },
      v1: tpl({ schema_version: 1 }),
      badStance: tpl({ responses: { stances: ['like'], reason_required: true } }),
      noGate: (() => { const x = tpl(); delete x.gate; return x; })(),
      gateNotBool: tpl({ gate: { open_dispute_blocks_acceptance: 'yes' } }),
      notObject: ['x'],
      tooLarge: tpl({ body: [{ id: 'big', type: 'text', content: ['x'.repeat(210_000)] }] }),
    };
    const r = {};
    for (const [k, body] of Object.entries(bad)) r[k] = (await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body } })).status;
    r.shaMismatch = (await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl(), sha256: 'f'.repeat(64) } })).status;
    check(Object.values(r).every((s) => s === 400) && same(before, counts(A)), 'R4 模板形状不对（回应不要理由、min 大于 max、kind 重复、不认识的键、版本不是 2、立场不认识、缺验收声明、声明不是真假、不是对象、超 200 KB、sha256 对不上）：400，库里没有变化', r);
  }

  // ---- R5 kind 由服务端比出来 ----
  {
    const withKind = await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl(), kind: 'layout' } });
    const v1 = await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl() } });
    const v2 = await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl({ title: '改了标题', body: [{ id: 'cover', type: 'cover', title: ['改了'] }] }) } });
    const v3 = await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl({ title: '改了标题', claims: [{ kind: 'conclusion', label: '结论', min: 2, max: 3 }] }) } });
    const v4 = await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl({ title: '改了标题', claims: [{ kind: 'conclusion', label: '结论', min: 2, max: 3 }], gate: { open_dispute_blocks_acceptance: true } }) } });
    const v5 = await rex.go('POST', '/api/report-dimensions/shape/templates', { json: { body: tpl({ title: '改了标题', claims: [{ kind: 'conclusion', label: '结论', min: 2, max: 3 }], gate: { open_dispute_blocks_acceptance: true }, slots: {} }) } });
    const kinds = [v1, v2, v3, v4, v5].map((r) => `${r.json?.template?.version}:${r.json?.template?.kind}`);
    const shaOk = v1.json?.template?.sha256?.length === 64;
    const crit = [v1, v2, v3, v4, v5].map((r) => r.json?.template?.criteria_sha256);
    const critOk = crit.every((c) => /^[0-9a-f]{64}$/.test(c ?? '')) && crit[0] === crit[1] && new Set(crit.slice(1)).size === 4;
    check(withKind.status === 400 && kinds.join(',') === '1:criteria,2:criteria,3:criteria,4:criteria,5:criteria' && shaOk && critOk,
      'R5 请求里写 kind：400；还没有复核过的版本时，第一版、只改标题和文档结构的、改论断要求、验收声明、数据槽的都是 criteria；回 sha256 和判据摘要（只改版式的判据摘要不变）', { withKind: withKind.status, kinds, crit });
  }

  // ---- R5b2 判据的五块各自单独改，都算判据：摘要两两不同、记 criteria、没复核不能生效（#926 增量验收：responses、parameters 漏出摘要时测试照样绿） ----
  {
    const err = (r) => `${r.status}:${r.json?.error ?? ''}`;
    await rex.go('POST', '/api/report-dimensions', { json: { id: 'blocks', title: '五块判据', area: 'zeta' } });
    const base = await rex.go('POST', '/api/report-dimensions/blocks/templates', { json: { body: tpl() } });
    const rv = await ria.go('POST', '/api/report-dimensions/blocks/templates/1/review', { json: {} });
    // 每一版只改一块，其余和复核过的第 1 版一模一样
    const only = {
      claims: tpl({ claims: [{ kind: 'conclusion', label: '结论', min: 1, max: 4 }, { kind: 'risk', label: '风险', min: 0, max: 10 }] }),
      responses: tpl({ responses: { stances: ['agree', 'dispute'], reason_required: true } }),
      gate: tpl({ gate: { open_dispute_blocks_acceptance: true } }),
      slots: tpl({ slots: { details: { columns: [{ name: 'id', type: 'integer', label: '编号' }], key: ['id'], max_rows: 400, completeness: 'all' } } }),
      parameters: tpl({ parameters: { period: { type: 'month', required: false } } }),
    };
    const got = {};
    for (const [block, body] of Object.entries(only)) {
      const r = await rex.go('POST', '/api/report-dimensions/blocks/templates', { json: { body } });
      const v = r.json?.template?.version;
      const act = await rex.go('POST', '/api/report-dimensions/blocks/activate', { json: { version: v } });
      got[block] = { kind: r.json?.template?.kind, crit: r.json?.template?.criteria_sha256, activate: err(act) };
    }
    const crits = [base.json?.template?.criteria_sha256, ...Object.values(got).map((x) => x.crit)];
    check(rv.status === 200 && Object.values(got).every((x) => x.kind === 'criteria' && x.activate === '409:report_template_unreviewed') && new Set(crits).size === 6 && crits.every((c) => /^[0-9a-f]{64}$/.test(c ?? '')),
      'R5b2 判据的五块（论断、回应、验收声明、数据槽、参数）各自单独改：都记 criteria，判据摘要和复核过的版本、彼此都不同，没复核生效 409', { rv: rv.status, got });
  }

  // ---- R5a 判据类版本要作者以外、认得出的人复核过才能生效（属主 2026-11-21；复核人口径按统筹 11-21 裁定） ----
  {
    const err = (r) => `${r.status}:${r.json?.error ?? ''}`;
    const unreviewed = await rex.go('POST', '/api/report-dimensions/shape/activate', { json: { version: 1 } });
    const layoutNoReview = await rex.go('POST', '/api/report-dimensions/shape/activate', { json: { version: 2 } });
    // 作者本人：浏览器里复核自己发的；同一个人换个写法（带管理口令，留痕写法不同、主体相同）也算本人
    const selfReview = await rex.go('POST', '/api/report-dimensions/shape/templates/1/review', { json: {} });
    const crossWay = await rex.go('POST', '/api/report-dimensions/shape/templates/1/review', { json: {}, headers: { 'x-admin-token': ADMIN_TOKEN } });
    // 认不出是谁的不能复核：本机命令行（属主那一档，权限过得了）、只带管理口令的
    const cliReview = await A.cli('POST', '/api/report-dimensions/shape/templates/1/review', {});
    const tokenReview = await A.remote('POST', '/api/report-dimensions/shape/templates/1/review', { json: {}, token: ADMIN_TOKEN });
    // 认不出是谁的不能发判据类版本（判不了谁是本人）：本机命令行发第一版（第一版也算判据类）403，库里没有多一版
    const before = counts(A);
    const cliPublish = await A.cli('POST', '/api/report-dimensions/company-cli/templates', { body: tpl() });
    const afterCli = counts(A);
    // 跨领域的维度只有属主能定：属主自己发的，属主自己、本机命令行都复核不了（要另一位持属主授予的人）
    const ownerPub = await olga.go('POST', '/api/report-dimensions/company/templates', { json: { body: tpl() } });
    const ownerSelf = await olga.go('POST', '/api/report-dimensions/company/templates/1/review', { json: {} });
    const cliOnOwner = await A.cli('POST', '/api/report-dimensions/company/templates/1/review', {});
    const tomReview = await tom.go('POST', '/api/report-dimensions/shape/templates/1/review', { json: {} });
    const riaReview = await ria.go('POST', '/api/report-dimensions/shape/templates/1/review', { json: { note: '看过了' } });
    const again = await olga.go('POST', '/api/report-dimensions/shape/templates/1/review', { json: {} });
    const layoutAfter = await rex.go('POST', '/api/report-dimensions/shape/activate', { json: { version: 2 } });
    const activate = await rex.go('POST', '/api/report-dimensions/shape/activate', { json: { version: 1 } });
    const meta = (await nina.go('GET', '/api/report-dimensions/shape')).json;
    const v1 = meta?.templates?.find((t) => t.version === 1);
    check(unreviewed.status === 409 && err(layoutNoReview) === '409:report_template_unreviewed' && tomReview.status === 403
        && riaReview.status === 200 && again.status === 409 && layoutAfter.status === 200 && activate.status === 200 && meta?.dimension?.active_version === 1 && v1?.review?.reviewed_by === 'user:ria' && v1?.active === true,
      'R5a 判据类没复核就生效 409；第一版没复核时，在它上面只改标题的第二版也不能生效 409（#926 独立验收，路径一）；没有定报告维度权限的人复核 403；别的持有人复核 200、再复核 409；第一版复核过以后，判据和它一样的第二版不用另外复核就能生效 200；复核过的第一版生效 200',
      { unreviewed: unreviewed.status, layoutNoReview: err(layoutNoReview), layoutAfter: layoutAfter.status, tomReview: tomReview.status, riaReview: riaReview.status, again: again.status, activate: activate.status, active: meta?.dimension?.active_version, v1 });
    check(err(selfReview) === '403:report_template_self_review' && err(crossWay) === '403:report_template_self_review',
      'R5b 作者本人复核 403（规格 5a）；同一个人带管理口令换个留痕写法复核自己的，主体相同，也算本人 403', { selfReview: err(selfReview), crossWay: err(crossWay) });
    check(err(cliReview) === '403:report_template_reviewer_unidentified' && tokenReview.status === 403,
      'R5c 认不出是谁的不能复核：本机命令行（权限过得了）403 reviewer_unidentified；只带管理口令的 403', { cliReview: err(cliReview), tokenReview: err(tokenReview) });
    check(err(cliPublish) === '403:report_template_author_unidentified' && same(before, afterCli),
      'R5d 认不出是谁的不能发判据类版本：本机命令行发第一版 403 author_unidentified，库里没有变化', { cliPublish: err(cliPublish), before, afterCli });
    check(ownerPub.status === 201 && err(ownerSelf) === '403:report_template_self_review' && err(cliOnOwner) === '403:report_template_reviewer_unidentified',
      'R5e 跨领域维度：属主发的判据类版本，属主自己复核 403（本人），本机命令行复核 403（认不出是谁）——要另一位持属主授予的人', { ownerPub: ownerPub.status, ownerSelf: err(ownerSelf), cliOnOwner: err(cliOnOwner) });
  }

  // ---- R5f 偷换生效的判据（#926 独立验收，路径二）：没复核的判据上面再发一版只改标题的，照样要复核；按判据内容认复核 ----
  {
    const err = (r) => `${r.status}:${r.json?.error ?? ''}`;
    const kindOf = (r) => `${r.status}:${r.json?.template?.kind ?? r.json?.error ?? ''}`;
    await rex.go('POST', '/api/report-dimensions', { json: { id: 'swap', title: '偷换', area: 'zeta' } });
    const loose = [{ kind: 'conclusion', label: '结论', min: 0, max: 3 }, { kind: 'risk', label: '风险', min: 0, max: 10 }];
    const v1 = await rex.go('POST', '/api/report-dimensions/swap/templates', { json: { body: tpl() } });
    const r1 = await ria.go('POST', '/api/report-dimensions/swap/templates/1/review', { json: {} });
    const a1 = await rex.go('POST', '/api/report-dimensions/swap/activate', { json: { version: 1 } });
    const v2 = await rex.go('POST', '/api/report-dimensions/swap/templates', { json: { body: tpl({ claims: loose }) } });                       // 放宽论断：criteria
    const v3 = await rex.go('POST', '/api/report-dimensions/swap/templates', { json: { body: tpl({ claims: loose, title: '只改标题' }) } });     // 在没复核的 v2 上只改标题：还是 criteria
    const a3 = await rex.go('POST', '/api/report-dimensions/swap/activate', { json: { version: 3 } });
    const a2 = await rex.go('POST', '/api/report-dimensions/swap/activate', { json: { version: 2 } });
    const cli5 = await A.cli('POST', '/api/report-dimensions/swap/templates', { body: tpl({ claims: loose, title: '命令行只改标题' }) });     // 命令行也不能借道
    const cli4 = await A.cli('POST', '/api/report-dimensions/swap/templates', { body: tpl({ title: '命令行改复核过那一版的标题' }) });          // 判据和复核过的 v1 一样：layout
    const a4 = await A.cli('POST', '/api/report-dimensions/swap/activate', { version: 4 });
    const midActive = (await nina.go('GET', '/api/report-dimensions/swap')).json?.dimension?.active_version;
    const r3 = await ria.go('POST', '/api/report-dimensions/swap/templates/3/review', { json: { note: '放宽论断看过了' } });
    const a2b = await rex.go('POST', '/api/report-dimensions/swap/activate', { json: { version: 2 } });                                       // 判据和复核过的 v3 一样
    check(v1.status === 201 && r1.status === 200 && a1.status === 200 && kindOf(v2) === '201:criteria' && kindOf(v3) === '201:criteria'
        && err(a3) === '409:report_template_unreviewed' && err(a2) === '409:report_template_unreviewed'
        && err(cli5) === '403:report_template_author_unidentified' && kindOf(cli4) === '201:layout' && a4.status === 200 && midActive === 4
        && r3.status === 200 && a2b.status === 200,
      'R5f 生效的版本复核过；再发一版放宽论断（criteria），在它上面只改标题的一版仍是 criteria；这两版都不能生效 409；命令行在它上面只改标题 403；'
      + '命令行只改复核过那一版的标题是 layout、能生效；放宽论断的那一版有人复核后，判据一样的另一版也能生效',
      { v1: v1.status, r1: r1.status, a1: a1.status, v2: kindOf(v2), v3: kindOf(v3), a3: err(a3), a2: err(a2), cli5: err(cli5), cli4: kindOf(cli4), a4: a4.status, midActive, r3: r3.status, a2b: a2b.status });
  }

  // ---- R5h 借别人只改标题的版本复核自己的判据（#926 独立验收 E1、E2）：判据一样的版本的作者都算本人 ----
  {
    const err = (r) => `${r.status}:${r.json?.error ?? ''}`;
    await rex.go('POST', '/api/report-dimensions', { json: { id: 'borrow', title: '借道', area: 'zeta' } });
    const v1 = await olga.go('POST', '/api/report-dimensions/borrow/templates', { json: { body: tpl() } });                        // 属主写的判据，没人复核
    const v2 = await rex.go('POST', '/api/report-dimensions/borrow/templates', { json: { body: tpl({ title: '只改标题' }) } });     // 别人在上面只改标题
    const olgaOnV2 = await olga.go('POST', '/api/report-dimensions/borrow/templates/2/review', { json: {} });
    const a1 = await olga.go('POST', '/api/report-dimensions/borrow/activate', { json: { version: 1 } });
    const e2 = sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('borrow', 1, 'user:rex', 'user:rex', 1)");
    const riaOnV2 = await ria.go('POST', '/api/report-dimensions/borrow/templates/2/review', { json: { note: '第三个人看过' } });
    const a1b = await olga.go('POST', '/api/report-dimensions/borrow/activate', { json: { version: 1 } });
    check(v1.status === 201 && v2.json?.template?.criteria_sha256 === v1.json?.template?.criteria_sha256
        && err(olgaOnV2) === '403:report_template_self_review' && err(a1) === '409:report_template_unreviewed',
      'R5h（E1）甲写的判据没人复核，乙在上面只改标题发一版；甲去复核乙那一版 403（判据一样的版本的作者都算本人），甲那一版仍不能生效 409', { v1: v1.status, olgaOnV2: err(olgaOnV2), a1: err(a1) });
    // 说法点明是哪一版让她算作者；复核自己发的那一版时照旧那一句（#926 验收建议）
    const olgaOnV1 = await olga.go('POST', '/api/report-dimensions/borrow/templates/1/review', { json: {} });
    check(/第 1 版是你发的/.test(olgaOnV2.json?.message ?? '') && /第 2 版/.test(olgaOnV2.json?.message ?? '') && olgaOnV1.json?.message === '模板版本不能由作者本人复核，要作者以外的人',
      'R5h 本人复核的说法：借别人那一版时说清「第 1 版是你发的、判据和第 2 版一样」；复核自己发的那一版照旧', { v2msg: olgaOnV2.json?.message, v1msg: olgaOnV1.json?.message });
    // 同一个人发了两版判据一样的（先 v1、再只改标题的 v2），复核后发的 v2：v2 就是他发的，说法照旧，不说「第 1 版是你发的」（#944 验收 x2）
    await rex.go('POST', '/api/report-dimensions', { json: { id: 'twice', title: '发两版', area: 'zeta' } });
    await rex.go('POST', '/api/report-dimensions/twice/templates', { json: { body: tpl() } });
    await rex.go('POST', '/api/report-dimensions/twice/templates', { json: { body: tpl({ title: '只改标题' }) } });
    const rexOnV2 = await rex.go('POST', '/api/report-dimensions/twice/templates/2/review', { json: {} });
    check(rexOnV2.status === 403 && rexOnV2.json?.message === '模板版本不能由作者本人复核，要作者以外的人',
      'R5h 同一个人发了两版判据一样的，复核后发的那一版：说法照旧（被复核的这一版就是他发的）', { rexOnV2: [rexOnV2.status, rexOnV2.json?.message] });
    check(e2 && riaOnV2.status === 200 && a1b.status === 200,
      'R5h（E2）库里直接写：乙复核甲那一版（乙是判据一样的另一版的作者）触发器拒；第三个人复核以后，甲那一版能生效', { e2, riaOnV2: riaOnV2.status, a1b: a1b.status });
  }

  // ---- R5g 管理口令加会话的路径（统筹 #926 增量验收条件 1）：路由这一支不核主体的 kind、status，只靠复核里的认人 ----
  {
    const dan = await A.person('dan', 'Dan-pass-000001', '192.0.2.81');
    const danG = await cliGrant('user:dan', 'area-report', 'area:zeta');
    const dis = await A.cli('POST', '/api/principals/disable', { id: 'user:dan', reason: '合成：停用' });
    const before = counts(A);
    const r = await dan.go('POST', '/api/report-dimensions/swap/templates/2/review', { json: {}, headers: { 'x-admin-token': ADMIN_TOKEN } });
    const sess = await dan.go('GET', '/api/report-dimensions');
    // 走不到复核里的认人：停用了的人的会话认不出（自己读也是 401），这一支拿到的主体是空的，定报告维度的硬规则先拦下（403 set_forbidden）。
    // 非人的主体（服务、组）没有登录会话，也到不了这一支。所以「认人只看主体非空」这个变异在 HTTP 上打不红，由 R3 的触发器用例和这条一起说明
    check(danG.status === 200 && dis.status === 200 && sess.status === 401 && r.status === 403 && r.json?.error === 'report_dimension_set_forbidden' && same(before, counts(A)),
      'R5g 停用了的人带管理口令加自己的会话复核：会话已经认不出（自己读 401），硬规则先拦 403 set_forbidden，走不到复核；库里没有变化',
      { danG: danG.status, dis: dis.status, sess: sess.status, r: `${r.status}:${r.json?.error ?? ''}` });
  }

  // ---- R5o 属主本人发版并激活免作者以外复核（属主 2026-11-25 裁定）：只放开属主本人的、只放开 activate；其他人、命令行、混了别人版本的照旧 409 ----
  {
    const err = (r) => `${r.status}:${r.json?.error ?? ''}`;
    await olga.go('POST', '/api/report-dimensions', { json: { id: 'owner-self', title: '属主自发', area: 'zeta' } });
    const v1 = await olga.go('POST', '/api/report-dimensions/owner-self/templates', { json: { body: tpl(), note: '属主发的' } });
    const byRex = await rex.go('POST', '/api/report-dimensions/owner-self/activate', { json: { version: 1 } });            // 不是属主：照旧要复核
    const byCli = await A.cli('POST', '/api/report-dimensions/owner-self/activate', { version: 1 });                        // 命令行认不出人：照旧要复核
    const byOwner = await olga.go('POST', '/api/report-dimensions/owner-self/activate', { json: { version: 1 } });
    const d = A.db();
    let exemption = null, event = null;
    try {
      exemption = d.prepare("SELECT owner_principal, ruling, criteria_sha256 FROM report_template_owner_exemptions WHERE dimension_id = 'owner-self' AND version = 1").get() ?? null;
      event = d.prepare("SELECT actor_principal, detail FROM report_dimension_events WHERE dimension_id = 'owner-self' AND kind = 'activate' ORDER BY seq DESC LIMIT 1").get() ?? null;
    } finally { d.close(); }
    check(v1.status === 201 && err(byRex) === '409:report_template_unreviewed' && byCli.status === 409 && byOwner.status === 200 && byOwner.json?.dimension?.active_version === 1
        && exemption?.owner_principal === 'user:olga' && exemption?.criteria_sha256 === v1.json?.template?.criteria_sha256 && /属主本人发版并激活/.test(exemption?.ruling ?? '')
        && event?.actor_principal === 'user:olga' && /2026-11-25 裁定免复核/.test(event?.detail ?? ''),
      'R5o 属主本人发的判据，属主本人激活 200，记一行豁免并在激活留痕写明裁定；别人激活 409、本机命令行激活 409',
      { v1: v1.status, byRex: err(byRex), byCli: byCli.status, byOwner: err(byOwner), exemption, event });
    // 判据一样的版本里有别人发的（rex 只改标题再发），就不算属主本人发的：属主激活自己那一版照旧 409（借道 R5h 的 borrow 维度，那里有人复核过之后才 200，这里另起一个）
    await olga.go('POST', '/api/report-dimensions', { json: { id: 'owner-mixed', title: '混了别人', area: 'zeta' } });
    await olga.go('POST', '/api/report-dimensions/owner-mixed/templates', { json: { body: tpl() } });
    await rex.go('POST', '/api/report-dimensions/owner-mixed/templates', { json: { body: tpl({ title: '只改标题' }) } });
    const mixed = await olga.go('POST', '/api/report-dimensions/owner-mixed/activate', { json: { version: 1 } });
    // 复核接口不放开：属主复核自己那一版照旧 403
    const selfReview = await olga.go('POST', '/api/report-dimensions/owner-self/templates/1/review', { json: {} });
    // 库这一层：豁免只能记在作者就是这个主体的那一版上；记在 rex 发的那一版上（主体写成 olga）拒；改、删、覆盖都拒；没有复核也没有豁免的版本仍不能生效
    const db1 = [
      ['豁免记在别人发的版本上（写库）', sqlThrows(A, "INSERT INTO report_template_owner_exemptions (dimension_id, version, criteria_sha256, owner_principal, at, ruling) SELECT 'owner-mixed', 2, criteria_sha256, 'user:olga', 1, 'x' FROM report_templates WHERE dimension_id = 'owner-mixed' AND version = 2")],
      ['豁免判据摘要对不上（写库）', sqlThrows(A, "INSERT INTO report_template_owner_exemptions (dimension_id, version, criteria_sha256, owner_principal, at, ruling) VALUES ('owner-mixed', 1, ?, 'user:olga', 1, 'x')", 'd'.repeat(64))],
      ['改豁免', sqlThrows(A, "UPDATE report_template_owner_exemptions SET ruling = 'x' WHERE dimension_id = 'owner-self'")],
      ['删豁免', sqlThrows(A, "DELETE FROM report_template_owner_exemptions WHERE dimension_id = 'owner-self'")],
      ['同版本再记豁免', sqlThrows(A, "INSERT INTO report_template_owner_exemptions (dimension_id, version, criteria_sha256, owner_principal, at, ruling) SELECT 'owner-self', 1, criteria_sha256, 'user:olga', 2, 'x' FROM report_templates WHERE dimension_id = 'owner-self' AND version = 1")],
      ['指针指没复核也没豁免的判据类（写库）', sqlThrows(A, "UPDATE report_dimensions SET active_version = 1 WHERE id = 'owner-mixed'")],
    ];
    check(err(mixed) === '409:report_template_unreviewed' && err(selfReview) === '403:report_template_self_review' && db1.every(([, x]) => x),
      'R5o 判据一样的版本里有别人发的，属主激活照旧 409；复核接口不放开（属主复核自己 403）；库里豁免只能记在本人发、摘要对得上的那一版，不改不删不覆盖，没复核也没豁免的仍不能生效',
      { mixed: err(mixed), selfReview: err(selfReview), db1 });
  }

  // ---- R5p 历史豁免不能当通行证（#1057 非作者评审 B1）：豁免已经记过以后，每次激活仍重核当前激活人与判据作者集合，每次都写明裁定；库里按版本对，同判据别人发的版本借不到 ----
  {
    const err = (r) => `${r.status}:${r.json?.error ?? ''}`;
    const exemptions = () => { const d = A.db(); try { return d.prepare("SELECT version FROM report_template_owner_exemptions WHERE dimension_id = 'owner-self' ORDER BY version").all().map((x) => x.version); } finally { d.close(); } };
    const lastActivate = () => { const d = A.db(); try { return d.prepare("SELECT actor_principal, detail FROM report_dimension_events WHERE dimension_id = 'owner-self' AND kind = 'activate' ORDER BY seq DESC LIMIT 1").get() ?? null; } finally { d.close(); } };
    // 属主本人再激活一次自己那一版：照旧 200，留痕再写一次裁定，豁免行不重复记
    const again = await olga.go('POST', '/api/report-dimensions/owner-self/activate', { json: { version: 1 } });
    const againEvent = lastActivate();
    // 豁免已经有了：不是属主的人、本机命令行照旧 409
    const rexAfter = await rex.go('POST', '/api/report-dimensions/owner-self/activate', { json: { version: 1 } });
    const cliAfter = await A.cli('POST', '/api/report-dimensions/owner-self/activate', { version: 1 });
    // 别人在同一维度发一版判据一样的（只改标题）：判据作者混了别人，属主激活哪一版都 409
    const v2 = await rex.go('POST', '/api/report-dimensions/owner-self/templates', { json: { body: tpl({ title: '只改标题' }) } });
    const ownerV2 = await olga.go('POST', '/api/report-dimensions/owner-self/activate', { json: { version: 2 } });
    const ownerV1 = await olga.go('POST', '/api/report-dimensions/owner-self/activate', { json: { version: 1 } });
    // 库这一层：豁免只记在第 1 版，指针直接写到同判据的第 2 版拒
    const ptrV2 = sqlThrows(A, "UPDATE report_dimensions SET active_version = 2 WHERE id = 'owner-self'");
    const active = (await olga.go('GET', '/api/report-dimensions/owner-self')).json?.dimension?.active_version;
    check(again.status === 200 && /2026-11-25 裁定免复核/.test(againEvent?.detail ?? '') && againEvent?.actor_principal === 'user:olga'
        && err(rexAfter) === '409:report_template_unreviewed' && cliAfter.status === 409
        && v2.status === 201,
      'R5p 豁免记过以后属主本人再激活：200，留痕再写一次裁定；别人激活 409、本机命令行激活 409',
      { again: err(again), againEvent, rexAfter: err(rexAfter), cliAfter: cliAfter.status, v2: v2.status });
    check(err(ownerV2) === '409:report_template_unreviewed' && err(ownerV1) === '409:report_template_unreviewed' && ptrV2 && active === 1 && JSON.stringify(exemptions()) === '[1]',
      'R5p 同判据混进别人发的版本后，属主激活第 2 版、再激活自己的第 1 版都 409；库里指针写到第 2 版拒（豁免按版本对）；生效的仍是第 1 版，豁免只有第 1 版一行',
      { ownerV2: err(ownerV2), ownerV1: err(ownerV1), ptrV2, active, exemptions: exemptions() });
  }

  // ---- R6 读、匿名、跨站 ----
  {
    const reads = {
      tomList: (await tom.go('GET', '/api/report-dimensions')).status, ninaOne: (await nina.go('GET', '/api/report-dimensions/ops')).status,
      ninaTpl: (await nina.go('GET', '/api/report-dimensions/ops/templates/1')).status, token: (await A.remote('GET', '/api/report-dimensions', { token: ADMIN_TOKEN })).status,
    };
    const body = (await nina.go('GET', '/api/report-dimensions/ops/templates/1')).json?.template?.body;
    const before = counts(A);
    const anon = {
      list: (await A.remote('GET', '/api/report-dimensions')).status, one: (await A.remote('GET', '/api/report-dimensions/ops')).status,
      create: (await A.remote('POST', '/api/report-dimensions', { json: { id: 'anon', title: 'x', area: 'zeta' } })).status,
      tpl: (await A.remote('POST', '/api/report-dimensions/ops/templates', { json: { body: tpl() } })).status,
      retire: (await A.remote('POST', '/api/report-dimensions/ops/retire', { json: {} })).status,
    };
    const cross = (await olga.go('POST', '/api/report-dimensions/ops/retire', { json: {}, headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' } })).status;
    check(Object.values(reads).every((s) => s === 200) && body?.schema_version === 2 && Object.values(anon).every((s) => s === 401) && cross === 403 && same(before, counts(A)),
      'R6 登录的人都能读（普通员工、没授予的人、管理口令），模板正文原样回；远程匿名读写 401；跨站来的写（属主的 cookie）403；库里没有变化', { reads, anon, cross });
  }

  // ---- R7 不存在、撤了的 ----
  {
    const nf = {
      one: (await olga.go('GET', '/api/report-dimensions/ghost')).status, tpl: (await olga.go('GET', '/api/report-dimensions/ops/templates/99')).status,
      add: (await olga.go('POST', '/api/report-dimensions/ghost/templates', { json: { body: tpl() } })).status, act: (await olga.go('POST', '/api/report-dimensions/ops/activate', { json: { version: 99 } })).status,
      review: (await olga.go('POST', '/api/report-dimensions/ops/templates/99/review', { json: {} })).status, badVersion: (await olga.go('GET', '/api/report-dimensions/ops/templates/01')).status,
      badId: (await olga.go('GET', '/api/report-dimensions/Ops')).status, dup: (await olga.go('POST', '/api/report-dimensions', { json: { id: 'ops', title: '重复', area: 'zeta' } })).status,
      areaGhost: (await olga.go('POST', '/api/report-dimensions', { json: { id: 'in-ghost', title: '合成', area: 'ghost' } })).status,
    };
    const retire = await rex.go('POST', '/api/report-dimensions/rex-dim/retire', { json: { reason: '合成' } });
    const before = counts(A);
    const after = {
      add: (await rex.go('POST', '/api/report-dimensions/rex-dim/templates', { json: { body: tpl() } })).status,
      review: (await ria.go('POST', '/api/report-dimensions/rex-dim/templates/1/review', { json: {} })).status,
      act: (await rex.go('POST', '/api/report-dimensions/rex-dim/activate', { json: { version: 1 } })).status,
      again: (await rex.go('POST', '/api/report-dimensions/rex-dim/retire', { json: {} })).status,
      read: (await tom.go('GET', '/api/report-dimensions/rex-dim')).status,
    };
    const dbRetired = sqlThrows(A, "UPDATE report_dimensions SET title = 'x' WHERE id = 'rex-dim'");
    check(nf.one === 404 && nf.tpl === 404 && nf.add === 404 && nf.act === 400 && nf.review === 404 && nf.badVersion === 400 && nf.badId === 400 && nf.dup === 409 && nf.areaGhost === 404,
      'R7a 不存在的维度、版本 404（移指针到不存在的版本 400）；写法不对 400；同标识再建 409；建在不存在的领域 404', nf);
    check(retire.status === 200 && retire.json?.dimension?.status === 'retired' && after.add === 409 && after.review === 409 && after.act === 409 && after.again === 409 && after.read === 200 && dbRetired && same(before, counts(A)),
      'R7b 撤了的维度：发版、复核、移指针、再撤 409，读照常；库里直接改也拒；库里没有变化', { retire: retire.status, after, dbRetired });
  }
  // 维度治理：用已登录的真实合成账户、网关会话和接入申请 API。
  {
    const db = A.db();
    try {
      const fixtureToken = 'a'.repeat(64);
      db.prepare("INSERT INTO mcp_sessions (name, token_sha256, responsible_principal) VALUES ('governance-dimension-fixture', ?, 'user:ria')").run(sha(fixtureToken));
      const headers = { Authorization: 'Bearer ' + fixtureToken };
      const propose = (id, extra = {}) => A.remote('POST', '/api/report-governance/proposals', { headers, json: {
        op: 'dimension-create', idempotency_key: id, args: { area: 'zeta', id, title: '  合成维度  ', ...extra },
      } });
      const blocked = await propose('governance-register');
      const apply = await A.remote('POST', '/api/mcp-rest/tools/access_request', { headers, json: {
        area: 'zeta', actions: ['report.governance-dimension-create'], reason: '合成治理登记',
      } });
      const requestId = apply.json?.request?.ref?.slice(5);
      const grant = await olga.go('POST', '/api/areas/zeta/access-requests/' + requestId + '/approve', { json: {} });
      const wrongArea = await propose('governance-register', { area: 'eta' });
      const missingArea = await propose('governance-register', { area: 'absent-area' });
      const badArgs = await propose('governance-register', { area_status: 'active' });
      const countBefore = counts(A);
      const pending = await propose('governance-register');
      const mcp = await A.remote('POST', '/mcp', { headers, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'invoke', arguments: { target: 'report.governance-propose', args: {
          op: 'dimension-create', idempotency_key: 'governance-register', args: { area: 'zeta', id: 'governance-register', title: '合成维度' },
        } },
      } } });
      const repeat = JSON.parse(mcp.json?.result?.content?.[0]?.text ?? '{}');
      check(blocked.status === 403 && grant.status === 200 && wrongArea.status === 403 && same(wrongArea.json, missingArea.json) && badArgs.status === 400 &&
        pending.status === 202 && pending.json?.status === 'pending' && repeat.id === pending.json?.id && same(countBefore, counts(A)),
        'RGD1 维度登记须在批准领域内，归一标题的提案重放且不写维度，拒绝代填冻结字段', { blocked, apply, grant, wrongArea, missingArea, badArgs, pending, repeat });
      const inbox = async id => (await rex.go('GET', '/api/report-governance/inbox')).json?.proposals?.find(row => row.id === id);
      const confirm = (actor, id, digest) => actor.go('POST', '/api/report-governance/inbox/' + id + '/confirm', { json: { snapshot_sha256: digest } });
      const frozen = await inbox(pending.json?.id);
      if (!frozen) throw Error('登记提案未出现：' + JSON.stringify(pending));
      const noPermission = await confirm(mona, frozen.id, frozen.snapshot_sha256);
      const wrongDigest = await confirm(rex, frozen.id, 'b'.repeat(64));
      const created = await confirm(rex, frozen.id, frozen.snapshot_sha256);
      const again = await confirm(rex, frozen.id, frozen.snapshot_sha256);
      const read = await rex.go('GET', '/api/report-dimensions/governance-register');
      const receipt = await A.remote('GET', '/api/report-governance/proposals/' + frozen.id, { headers });
      check(noPermission.status === 403 && wrongDigest.status === 409 && created.json?.status === 'confirmed' && same(created.json, again.json) &&
        read.json?.dimension?.title === '合成维度' && read.json.dimension.area_id === 'zeta' && read.json.dimension.active_version === null &&
        read.json.dimension.created_by === 'user:rex' && receipt.json?.result?.dimension === 'governance-register' && counts(A).dims === countBefore.dims + 1,
        'RGD2 由本人对冻结摘要确认，登记一次、无生效模板，查询只回维度标识', { frozen, noPermission, wrongDigest, created, again, read, receipt });

      const collision = await propose('governance-collision');
      const colliding = await inbox(collision.json?.id);
      await rex.go('POST', '/api/report-dimensions', { json: { id: 'governance-collision', area: 'zeta', title: '先提交' } });
      const collided = await confirm(rex, colliding.id, colliding.snapshot_sha256);
      const tx = await propose('governance-atomic');
      const atomic = await inbox(tx.json?.id);
      db.exec("CREATE TRIGGER fixture_registration_failure BEFORE UPDATE ON report_governance_proposals WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, 'fixture: fail dimension receipt'); END");
      let failed;
      try { failed = await confirm(rex, atomic.id, atomic.snapshot_sha256); }
      finally { db.exec('DROP TRIGGER fixture_registration_failure'); }
      const afterFailure = await rex.go('GET', '/api/report-dimensions/governance-atomic');
      const retry = await confirm(rex, atomic.id, atomic.snapshot_sha256);
      check(collided.json?.status === 'conflict' && failed.status === 500 && afterFailure.status === 404 && retry.json?.status === 'confirmed',
        'RGD3 标识被占用时冲突，确认回执落库失败则回滚维度和领取状态，修复后可重试', { collided, failed, afterFailure, retry });

      const stale = await propose('governance-revoked');
      const staleFrozen = await inbox(stale.json?.id);
      const revoked = await A.cli('POST', '/api/grants/' + riaG.id + '/revoke', { reason: '合成：提案责任人失权' });
      const denied = await confirm(rex, staleFrozen.id, staleFrozen.snapshot_sha256);
      const none = await rex.go('GET', '/api/report-dimensions/governance-revoked');
      const hidden = await A.remote('GET', '/api/report-governance/proposals/' + staleFrozen.id, { headers });
      check(revoked.status === 200 && denied.json?.status === 'conflict' && denied.json?.reason === 'authorization_changed' && none.status === 404 && hidden.status === 403,
        'RGD4 确认时重验发起人当前领域授予，失权不登记也不再返回结果', { revoked, denied, none, hidden });

      const restored = await cliGrant('user:ria', 'area-report', 'area:zeta');
      const publishAccess = await A.remote('POST', '/api/mcp-rest/tools/access_request', { headers, json: {
        area: 'zeta', actions: ['report.governance-template-publish'], report_scope: { dimension: 'governance-register' }, reason: '合成治理发布',
      } });
      const publishApproval = await olga.go('POST', '/api/areas/zeta/access-requests/' + publishAccess.json?.request?.ref?.slice(5) + '/approve', { json: {} });
      const reference = await rex.go('GET', '/api/report-dimensions/ops/templates/1');
      const body = tpl({ title: '合成：发布的模板' });
      const criteria = reference.json?.template?.criteria_sha256;
      const input = { dimension: 'governance-register', body, body_sha256: sha(JSON.stringify(body)), criteria_sha256: criteria,
        expected_kind: 'criteria', expected_latest_version: 0, note: '合成稿' };
      const publish = (key, extra = {}) => A.remote('POST', '/api/report-governance/proposals', { headers, json: {
        op: 'template-publish', idempotency_key: key, args: { ...input, ...extra },
      } });
      const beforePublish = counts(A);
      const targetDenied = await publish('wrong-dimension', { dimension: 'ops' });
      const targetMissing = await publish('missing-dimension', { dimension: 'unknown-governance' });
      const digestDenied = await publish('wrong-template-hash', { body_sha256: '0'.repeat(64) });
      const criteriaDenied = await publish('wrong-criteria-hash', { criteria_sha256: '0'.repeat(64) });
      const kindDenied = await publish('wrong-kind', { expected_kind: 'layout' });
      const publishPending = await publish('template-publish');
      const publishDuplicate = await publish('template-publish');
      const racePending = await publish('template-publish-race');
      check(restored.status === 200 && publishApproval.status === 200 && targetDenied.status === 403 && same(targetDenied.json, targetMissing.json) &&
        [digestDenied, criteriaDenied, kindDenied].every(r => r.status === 409) && publishPending.status === 202 &&
        publishPending.json?.id === publishDuplicate.json?.id && racePending.status === 202 && same(beforePublish, counts(A)),
        'RGP1 发版须有精确维度批准；摘要、分类和版本匹配时只提案，不发版', { publishAccess, publishApproval, targetDenied, targetMissing, digestDenied, criteriaDenied, kindDenied, publishPending, racePending });
      const publishFrozen = await inbox(publishPending.json?.id);
      const publishRace = await inbox(racePending.json?.id);
      if (!publishFrozen || !publishRace) throw Error('发版提案未冻结：' + JSON.stringify(publishPending));
      const published = await confirm(rex, publishFrozen.id, publishFrozen.snapshot_sha256);
      const publishedAgain = await confirm(rex, publishFrozen.id, publishFrozen.snapshot_sha256);
      const superseded = await confirm(rex, publishRace.id, publishRace.snapshot_sha256);
      const version = await rex.go('GET', '/api/report-dimensions/governance-register/templates/1');
      const row = db.prepare("SELECT body, created_by_principal, draft_author_principal FROM report_templates WHERE dimension_id = 'governance-register' AND version = 1").get();
      check(published.json?.status === 'confirmed' && published.json?.result?.version === 1 && same(publishedAgain.json, published.json) &&
        superseded.json?.status === 'conflict' && version.json?.template?.sha256 === input.body_sha256 && version.json?.template?.active === false &&
        row?.body === JSON.stringify(body) && row.created_by_principal === 'user:rex' && row.draft_author_principal === 'user:ria' && counts(A).tpls === beforePublish.tpls + 1,
        'RGP2 同事务发不可变版、正文摘要和归属，基版漂移冲突，生效指针不动', { published, superseded, version, row });
      const newManual = await rex.go('POST', '/api/report-dimensions/governance-register/templates', { json: { body: tpl({ title: '合成：只改版式' }) } });
      const draftReview = await ria.go('POST', '/api/report-dimensions/governance-register/templates/2/review', { json: {} });
      const rawReview = sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('governance-register', 2, 'user:ria', 'user:ria', 1)");
      const independent = await olga.go('POST', '/api/report-dimensions/governance-register/templates/2/review', { json: {} });
      const activateReviewed = await rex.go('POST', '/api/report-dimensions/governance-register/activate', { json: { version: 1 } });
      check(newManual.status === 201 && draftReview.status === 403 && draftReview.json?.error === 'report_template_self_review' && rawReview &&
        independent.status === 200 && activateReviewed.status === 200,
        'RGP3 起草共同作者经存量人工入口跨版本复核仍拒，独立复核可复用同判据', { newManual, draftReview, rawReview, independent, activateReviewed });
      const byFormerReviewer = await olga.go('POST', '/api/report-dimensions/governance-register/templates', { json: { body: tpl({ title: '合成：复核者也成了作者' }) } });
      const staleReview = await rex.go('POST', '/api/report-dimensions/governance-register/activate', { json: { version: 3 } });
      const ninaGrant = await cliGrant('user:nina', 'area-report', 'area:zeta');
      const newReview = await nina.go('POST', '/api/report-dimensions/governance-register/templates/3/review', { json: {} });
      const activated = await rex.go('POST', '/api/report-dimensions/governance-register/activate', { json: { version: 3 } });
      check(byFormerReviewer.status === 201 && staleReview.status === 409 && staleReview.json?.error === 'report_template_unreviewed' &&
        ninaGrant.status === 200 && newReview.status === 200 && activated.json?.dimension?.active_version === 3,
        'RGP4 同判据复核人后来成为作者，历史复核不能激活，独立人复核后恢复', { byFormerReviewer, staleReview, newReview, activated });

      {
        const dimensionId = 'governance-register';
        const dimensionPath = '/api/report-dimensions/' + dimensionId;
        const activateRequest = (key, changes = {}) => A.remote('POST', '/api/report-governance/proposals', { headers, json: {
          op: 'dimension-activate', idempotency_key: key, args: { dimension: dimensionId, version: 1,
            body_sha256: input.body_sha256, criteria_sha256: criteria, expected_active_version: 3, review_version: 3, ...changes },
        } });
        const beforeActivate = await activateRequest('activate-before-approval');
        const badArgs = { version: 0 };
        const invalidBeforeApproval = await activateRequest('activate-invalid-before-approval', badArgs);
        check(beforeActivate.status === 403 && beforeActivate.json?.code === 'report_governance_forbidden' &&
          invalidBeforeApproval.status === 403 && invalidBeforeApproval.json?.code === 'report_governance_forbidden' &&
          typeof beforeActivate.text === 'string' && beforeActivate.text.length > 0 && invalidBeforeApproval.text === beforeActivate.text,
          'RGA3 未取得精确激活批准时，非法参数也先返回同一个 403', { beforeActivate, invalidBeforeApproval });
        const activationAccess = await A.remote('POST', '/api/mcp-rest/tools/access_request', { headers, json: {
          area: 'zeta', actions: ['report.governance-dimension-activate'], report_scope: { dimension: dimensionId }, reason: '合成治理回退',
        } });
        const access = await olga.go('POST', '/api/areas/zeta/access-requests/' + activationAccess.json?.request?.ref?.slice(5) + '/approve', { json: {} });
        const start = counts(A);
        const wrongDimension = await activateRequest('activate-wrong-dimension', { dimension: 'governance-racing' });
        const wrongActivationHash = await activateRequest('activate-bad-target', { body_sha256: '0'.repeat(64) });
        const invalidAfterApproval = await activateRequest('activate-invalid-after-approval', badArgs);
        const wrongCriteria = await activateRequest('activate-bad-criteria', { criteria_sha256: '0'.repeat(64) });
        check(access.status === 200 && invalidAfterApproval.status === 400 &&
          wrongCriteria.status === 409 && wrongCriteria.json?.code === 'report_governance_target_changed',
          'RGA4 获准后参数结构不合返 400，唯请求判据摘要与目标不符返 409', { access, invalidAfterApproval, wrongCriteria });
        const wrongReview = await activateRequest('activate-bad-review', { review_version: 2 });
        const good = await activateRequest('activate-exact-review');
        const repeat = await activateRequest('activate-exact-review');
        const frozenActivation = await inbox(good.json?.id);
        if (!frozenActivation) throw Error('激活提案冻结失败：' + JSON.stringify({ beforeActivate, activationAccess, access, good }));
        const pinned = frozenActivation.frozen.snapshot;
        const recordedReview = newReview.json?.template?.review;
        check(newReview.status === 200 && recordedReview?.reviewed_by === 'user:nina' &&
          Number.isSafeInteger(recordedReview?.reviewed_at) && recordedReview.reviewed_at > 0 &&
          pinned.review.version === newReview.json.template.version && pinned.review.principal === recordedReview.reviewed_by &&
          pinned.review.at === recordedReview.reviewed_at,
          'RGA5 冻结的复核版本、主体和时点等于人工复核入口实存的记录', { recordedReview, pinnedReview: pinned.review });
        const beforeConfirm = await rex.go('GET', dimensionPath);
        const noPermission = await tom.go('POST', '/api/report-governance/inbox/' + frozenActivation.id + '/confirm', { json: { snapshot_sha256: frozenActivation.snapshot_sha256 } });
        const done = await confirm(rex, frozenActivation.id, frozenActivation.snapshot_sha256);
        const doneAgain = await confirm(rex, frozenActivation.id, frozenActivation.snapshot_sha256);
        const back = await rex.go('GET', dimensionPath);
        check(beforeActivate.status === 403 && access.status === 200 && wrongDimension.status === 403 && wrongActivationHash.status === 409 && wrongReview.status === 409 &&
          good.status === 202 && same(good.json, repeat.json) && pinned.active?.version === 3 && pinned.target.version === 1 && pinned.review.version === 3 &&
          pinned.review.principal === 'user:nina' && pinned.target.body_sha256 === input.body_sha256 && beforeConfirm.json?.dimension?.active_version === 3 &&
          noPermission.status === 403 && done.json?.status === 'confirmed' && done.json?.result?.version === 1 && same(doneAgain.json, done.json) &&
          back.json?.dimension?.active_version === 1 && counts(A).tpls === start.tpls && counts(A).reviews === start.reviews,
          'RGA1 精确操作批准与本人共同核对旧版复核，确认原子回退指针，同号重放不添版本和复核', { beforeActivate, access, wrongDimension, wrongActivationHash, wrongReview, good, pinned, noPermission, done, back });
        await rex.go('POST', dimensionPath + '/activate', { json: { version: 3 } });
        const race = await activateRequest('activate-current-pointer');
        const staleReviewRef = await activateRequest('activate-review-changed', { expected_active_version: 1 });
        const manual = await rex.go('POST', dimensionPath + '/activate', { json: { version: 1 } });
        const raceFrozen = await inbox(race.json?.id);
        const activationStaleReview = await activateRequest('activate-review-after-move', { expected_active_version: 1 });
        const staleFrozen = await inbox(activationStaleReview.json?.id);
        if (!raceFrozen || !staleFrozen) throw Error('激活竞态正控失败');
        const raceOutcome = await confirm(rex, raceFrozen.id, raceFrozen.snapshot_sha256);
        // 旧版复核人发布相同判据成为作者。另一个人的有效复核不能替换冻结的那一条。
        const ere = await A.person('ere', 'review-reset-ere-1', '192.0.2.176');
        const validAlternative = await cliGrant('user:ere', 'area-report', 'area:zeta');
        const alternateReview = await ere.go('POST', dimensionPath + '/templates/1/review', { json: {} });
        const authorNow = await nina.go('POST', dimensionPath + '/templates', { json: { body: tpl({ title: '合成：激活前复核人成为作者' }) } });
        const staleOutcome = await confirm(rex, staleFrozen.id, staleFrozen.snapshot_sha256);
        const unchanged = await rex.go('GET', dimensionPath);
        check(staleReviewRef.status === 409 && manual.status === 200 && raceOutcome.json?.status === 'conflict' && raceOutcome.json?.reason === 'target_changed' &&
          validAlternative.status === 200 && alternateReview.status === 200 && authorNow.status === 201 &&
          staleOutcome.json?.status === 'conflict' && staleOutcome.json?.reason === 'target_changed' && unchanged.json?.dimension?.active_version === 1,
          'RGA2 生效指针并发变化或指定复核人成为作者时冲突，别的有效复核不能代换', { staleReviewRef, manual, raceOutcome, validAlternative, alternateReview, authorNow, staleOutcome, unchanged });
      }

      const inviteRequest = await A.remote('POST', '/api/mcp-rest/tools/access_request', { headers, json: {
        area: 'zeta', actions: ['report.governance-review-invite'], report_scope: { dimension: 'governance-register' }, reason: '合成复核邀请',
      } });
      const inviteApproval = await olga.go('POST', '/api/areas/zeta/access-requests/' + inviteRequest.json?.request?.ref?.slice(5) + '/approve', { json: {} });
      const publishManual = min => rex.go('POST', '/api/report-dimensions/governance-register/templates', { json: {
        body: tpl({ claims: [{ kind: 'conclusion', label: '结论', min, max: 6 }] }),
      } });
      const target = (await publishManual(2)).json?.template;
      const inviteArgs = { dimension: 'governance-register', version: target?.version, body_sha256: target?.sha256,
        criteria_sha256: target?.criteria_sha256, invitees: ['user:nina', 'user:olga'] };
      const invokeInvite = (key, extra = {}) => A.remote('POST', '/api/report-governance/proposals', { headers, json: {
        op: 'review-invite', idempotency_key: key, args: { ...inviteArgs, ...extra },
      } });
      const beforeInvite = counts(A);
      const author = await invokeInvite('invite-author', { invitees: ['user:rex', 'user:nina'] });
      const noGrant = await invokeInvite('invite-no-grant', { invitees: ['user:tom'] });
      const wrongHash = await invokeInvite('invite-hash', { body_sha256: '0'.repeat(64) });
      const createdInvite = await invokeInvite('invite-one');
      const identical = await invokeInvite('invite-one', { invitees: ['user:olga', 'user:nina'] });
      const altered = await invokeInvite('invite-one', { invitees: ['user:nina'] });
      const invitePath = '/api/report-governance/review-invites/' + createdInvite.json?.id;
      const agentResult = () => A.remote('GET', '/api/report-governance/proposals/' + createdInvite.json?.id, { headers });
      const resultInvite = await agentResult();
      const rejectedConfirm = await confirm(rex, createdInvite.json?.id, 'a'.repeat(64));
      const inviteCount = db.prepare('SELECT COUNT(*) AS n FROM report_governance_invites').get().n;
      const peopleCount = db.prepare('SELECT COUNT(*) AS n FROM report_governance_invitees').get().n;
      check(inviteApproval.status === 200 && author.status === 400 && same(author.json, noGrant.json) && wrongHash.status === 409 &&
        createdInvite.status === 202 && /^i-[1-9]/.test(createdInvite.json?.id) && same(createdInvite.json, identical.json) && altered.status === 409 &&
        resultInvite.json?.kind === 'invite' && resultInvite.json?.status === 'active' && !('invitees' in resultInvite.json) && rejectedConfirm.status === 403 &&
        same(beforeInvite, counts(A)) && inviteCount === 1 && peopleCount === 2,
        'RGI1 精确复核邀请整组验资格，同号不重发，结果不泄露邀请人且不能当提案确认', { inviteApproval, author, noGrant, wrongHash, createdInvite, altered, resultInvite, rejectedConfirm, inviteCount, peopleCount });
      const invited = await nina.go('GET', invitePath);
      const uninvited = await ria.go('GET', invitePath);
      const inboxInvite = await nina.go('GET', '/api/attention');
      const robot = await A.remote('GET', invitePath, { headers });
      check(invited.status === 200 && invited.json?.template?.sha256 === target.sha256 && uninvited.status === 403 && robot.status === 403 &&
        inboxInvite.json?.items?.filter(x => x.source === 'report-review-invitations' && x.source_id === createdInvite.json.id).length === 1,
        'RGI2 站内待办只发指定人一次，打开重新判权查看精确版本', { invited, uninvited, robot, inbox: inboxInvite.status });
      const revokedInvitee = await A.cli('POST', '/api/grants/' + ninaGrant.id + '/revoke', { reason: '合成：复核人失权' });
      const vanished = await nina.go('GET', invitePath);
      const voided = await agentResult();
      const other = await invokeInvite('invite-other', { invitees: ['user:olga'] });
      const newer = await publishManual(3);
      const supersededInvite = await A.remote('GET', '/api/report-governance/proposals/' + other.json?.id, { headers });
      check(revokedInvitee.status === 200 && vanished.status === 403 && voided.json?.status === 'void' && voided.json?.reason === 'ineligible' &&
        other.status === 202 && newer.status === 201 && supersededInvite.json?.reason === 'superseded',
        'RGI3 复核人失权与不同判据新版本都会令邀请作废', { revokedInvitee, vanished, voided, other, newer: newer.status, supersededInvite });
    } finally { db.close(); }
  }
  // 公网 Host 与 Origin 用真实 HTTP 发给本机隔离监听；控制面使用独立端口。
  {
    const P = await boot(true);
    const owner = await P.person('ownerweb', 'Owner-pass-00001', '192.0.2.101');
    const reporter = await P.person('reportweb', 'Report-pass-00001', '192.0.2.102');
    const drafter = await P.person('draftweb', 'Draft-pass-00001', '192.0.2.103');
    const stranger = await P.person('otherweb', 'Other-pass-00001', '192.0.2.104');
    const dormant = await P.person('pausedweb', 'Paused-pass-00001', '192.0.2.105');
    const scopedGrant = async (principal, role, scope) => {
      const draft = await P.cli('POST', '/api/grants', { principal, role, scope, reason: '合成来源用例' });
      const id = draft.json?.grant?.id;
      const sent = await P.cli('POST', '/api/grants/' + id + '/submit');
      const approved = await P.cli('POST', '/api/grants/' + id + '/approve');
      if (draft.status !== 201 || sent.status !== 200 || approved.status !== 200) throw Error('公共市场授予夹具未准备好：' + JSON.stringify({ draft, sent, approved }));
    };
    const area = 'public-fixture';
    await P.cli('POST', '/api/areas', { id: area, name: '合成公共领域' });
    await scopedGrant('user:ownerweb', 'owner', '*');
    await scopedGrant('user:ownerweb', 'area-lead', 'area:' + area);
    await scopedGrant('user:reportweb', 'area-report', 'area:' + area);
    await scopedGrant('user:draftweb', 'area-report', 'area:' + area);
    await scopedGrant('user:pausedweb', 'owner', '*');
    await P.cli('POST', '/api/areas', { id: 'outside-fixture', name: '合成其他领域' });
    await scopedGrant('user:otherweb', 'area-lead', 'area:outside-fixture');
    const dimension = await P.cli('POST', '/api/report-dimensions', { area, id: 'public-template', title: '合成模板' });
    const template = await reporter.go('POST', '/api/report-dimensions/public-template/templates', { json: { body: tpl() } });
    const review = await drafter.go('POST', '/api/report-dimensions/public-template/templates/1/review', { json: {} });
    const spec = await P.cli('POST', '/api/areas/' + area + '/specs', { body: '合成规范' });
    const db = P.db();
    try {
      // 部门写面已停止；只模拟其历史留下的待确认记录。批准与新领域授予走原有服务。
      const rel = db.prepare("INSERT INTO relation_proposals (kind, department_id, principal_id, proposed_by, proposed_at) VALUES ('dept-lead', ?, 'user:draftweb', 'admin-token', ?) RETURNING id");
      const approvePath = '/api/relations/proposals/' + rel.get(area, Date.now()).id + '/approve';
      const rejectPath = '/api/relations/proposals/' + rel.get(area, Date.now()).id + '/reject';
      const act = '/api/report-dimensions/public-template/activate';
      const specAct = '/api/areas/' + area + '/specs/activate';
      const token = 'd'.repeat(64);
      db.prepare("INSERT INTO mcp_sessions (name, token_sha256, responsible_principal) VALUES ('public-governance-fixture', ?, 'user:draftweb')").run(sha(token));
      const bearer = { authorization: 'Bearer ' + token };
      const requestAccess = () => P.remote('POST', '/api/mcp-rest/tools/access_request', { headers: bearer, json: {
        area, actions: ['report.governance-dimension-create'], reason: '合成公共治理',
      } });
      const request = await requestAccess();
      const areaRequests = '/api/areas/' + area + '/access-requests/';
      const approvalPath = areaRequests + request.json?.request?.ref?.slice(5) + '/approve';
      const approveArea = await P.publicPost(approvalPath, { actor: owner });
      const secondRequest = await requestAccess();
      const rejectAreaPath = areaRequests + secondRequest.json?.request?.ref?.slice(5) + '/reject';
      const propose = (id) => P.remote('POST', '/api/report-governance/proposals', { headers: bearer, json: {
        op: 'dimension-create', idempotency_key: id, args: { area, id, title: '公共治理' },
      } });
      const pending = await propose('public-governance');
      const pendingReject = await propose('public-governance-reject');
      const inbox = await reporter.go('GET', '/api/report-governance/inbox');
      const frozen = inbox.json?.proposals?.find(p => p.id === pending.json?.id);
      if (!frozen) throw Error('公共市场治理夹具失败：' + JSON.stringify({ dimension, template, review, spec, request, approveArea, pending, inbox }));
      const gov = '/api/report-governance/inbox/' + frozen.id + '/confirm';
      const confirmation = { snapshot_sha256: frozen.snapshot_sha256 };
      const actions = [
        [approvePath, owner, {}], [rejectPath, owner, {}], [act, reporter, { version: 1 }],
        [gov, reporter, confirmation], [specAct, owner, { version: 1 }], [approvalPath, owner, {}], [rejectAreaPath, owner, {}],
      ];
      const forge = [
        { origin: 'https://elsewhere.example.test' }, { origin: 'http://market.example.test:9443' }, { origin: 'null' }, { origin: undefined },
        { host: 'gateway.example.test', 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' },
        { origin: undefined, host: 'gateway.example.test', forwarded: 'host=' + PUBLIC_HOST + ';proto=https' },
        { origin: 'https://elsewhere.example.test', 'sec-fetch-site': 'same-origin', 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' },
        { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
      ];
      const denied = [];
      for (const [path, actor, body] of actions) {
        for (const headers of forge) denied.push(await P.publicPost(path, { actor, body, headers }));
      }
      check(denied.every(r => r.status === 403 && r.json?.error === 'business_confirmation_origin_denied'),
        'PUB1 每条确认先拒伪造 Origin、Host、反代头、跨站与缺失来源', denied.filter(r => r.status !== 403 || r.json?.error !== 'business_confirmation_origin_denied'));
      const control = await Promise.all(actions.map(([path, actor, body]) => P.publicPost(path, { actor, body, control: true })));
      check(control.every(r => r.status === 403 || r.status === 404), 'PUB2 同样的公共 Host 和 Origin 不放行控制面', control);
      const anon = await Promise.all(actions.map(([path, , body]) => P.publicPost(path, { body })));
      const tokens = await Promise.all(actions.map(([path, actor, body]) => P.publicPost(path, { actor, body, headers: { 'x-admin-token': ADMIN_TOKEN } })));
      const sessionConfirm = await P.publicPost(gov, { actor: reporter, body: confirmation, headers: bearer });
      const off = await P.cli('POST', '/api/principals/disable', { id: 'user:pausedweb', reason: '合成停用' });
      const disabled = await P.publicPost(approvePath, { actor: dormant });
      check(anon.every(r => r.status === 401) && tokens.every(r => r.status === 403) && sessionConfirm.status === 403 && off.status === 200 && [401, 403].includes(disabled.status),
        'PUB3 真同源也要活跃自然人，无登录、管理口令、网关令牌和停用身份均不能确认', { anon, tokens, sessionConfirm, off, disabled });
      const noAccess = await Promise.all(actions.map(([path, , body]) => P.publicPost(path, { actor: stranger, body })));
      const mismatchedDigest = await P.publicPost(gov, { actor: reporter, body: { snapshot_sha256: '1'.repeat(64) } });
      const missingTarget = await P.publicPost('/api/report-dimensions/no-public-dimension/activate', { actor: reporter, body: { version: 1 } });
      check(noAccess.every(r => [403, 404].includes(r.status)) && noAccess[2].json?.error === 'report_dimension_set_forbidden' &&
        noAccess[4].json?.error === 'areas_spec_holder_only' && mismatchedDigest.status === 409 && missingTarget.status === 404,
        'PUB4 公共来源通过后仍核各自角色、作用域、对象与冻结摘要', { noAccess, mismatchedDigest, missingTarget });
      const neighboring = await P.publicPost('/api/report-dimensions/public-template/retire', { actor: owner });
      const limit = await P.publicPost('/api/areas/' + area + '/access-limits/1', { actor: owner, method: 'PUT' });
      const admin = await P.publicPost('/api/workbenches', { actor: owner, headers: { 'x-admin-token': ADMIN_TOKEN }, control: true });
      const controlHost = '127.0.0.1:' + P.controlPort;
      // 同一有效口令在控制面自身的来源可进正常参数验证。
      const localControl = await P.publicPost('/api/workbenches', { control: true, headers: { host: controlHost, origin: 'http://' + controlHost, 'x-admin-token': ADMIN_TOKEN } });
      check(neighboring.status === 403 && limit.status === 403 && admin.status === 403 && localControl.status === 400,
        'PUB5 未接入的维度撤销、领域上限与控制管理写不获公共来源例外，控制面自身同源照旧', { neighboring, limit, admin, localControl });
      const relationship = await P.publicPost(approvePath, { actor: owner });
      const declined = await P.publicPost(rejectPath, { actor: owner });
      const activated = await P.publicPost(act, { actor: reporter, body: { version: 1 } });
      const confirmed = await P.publicPost(gov, { actor: reporter, body: confirmation });
      const refusedProposal = await P.publicPost('/api/report-governance/inbox/' + pendingReject.json?.id + '/reject', { actor: reporter });
      const specActive = await P.publicPost(specAct, { actor: owner, body: { version: 1 } });
      const rejectedArea = await P.publicPost(rejectAreaPath, { actor: owner });
      check([dimension.status, template.status, review.status, spec.status, approveArea.status].join(',') === '201,201,200,201,200' &&
        relationship.json?.proposal?.status === 'approved' && declined.json?.proposal?.status === 'rejected' && activated.json?.dimension?.active_version === 1 &&
        confirmed.json?.status === 'confirmed' && refusedProposal.json?.status === 'rejected' && specActive.json?.area?.spec_version === 1 && rejectedArea.json?.request?.status === 'rejected',
        'PUB6 公共 HTTPS 真同源且有授权的人完成关系、维度、报告治理、领域规范及接入的业务确认',
        { relationship, declined, activated, confirmed, refusedProposal, specActive, approveArea, rejectedArea });
    } finally { db.close(); }
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await sleep(500);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`report-dimensions-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
