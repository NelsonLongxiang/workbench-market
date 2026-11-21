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
 *      作者本人复核（直接写库）：拒；撤了的维度直接改：拒
 *   R4 （#4）模板形状不对：reason_required 不是 true、min 大于 max、kind 重复、不认识的键、schema_version 不是 2、不是对象、超 200 KB、sha256 对不上：400
 *   R5 （#5）请求里写 kind：400；第一版算 criteria；只改标题和文档结构是 layout；改论断要求、验收声明、数据槽是 criteria
 *   R5a（属主 2026-11-21）判据类版本没复核就移成生效 409；别的持有人复核 200、再复核 409；复核过后生效 200；版式类不复核也能生效
 *   R5b～R5e（复核人口径，统筹 11-21 裁定）：作者本人 403（换个留痕写法、主体相同也算）；本机命令行、管理口令不能复核 403；
 *      本机命令行不能发判据类版本 403；跨领域维度属主自己发的，属主自己、本机命令行都复核不了
 *   R6 读：登录的人都能读（普通员工、没授予的人也行）；远程匿名读、写 401；跨站来的写 403
 *   R7 不存在的维度、版本 404；撤了的维度：发版、复核、移指针、再撤 409，读照常
 *
 *   node scripts/report-dimensions-test.mjs
 */
import { createServer } from 'node:net';
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

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const children = [];
let log = '';
rmSync(OUT, { recursive: true, force: true });

async function boot() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', MARKET_PUBLIC_URL: base, WM_TRUSTED_PROXIES: '127.0.0.1', ADMIN_TOKEN });
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
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成' }); const id = d.json?.grant?.id; await cli('POST', `/api/grants/${id}/submit`); const a = await cli('POST', `/api/grants/${id}/approve`); return { id, status: a.status }; };
  const person = async (username, pw, ip) => { const t = (await cli('POST', '/api/local-accounts', { username })).json?.temp_password ?? ''; return login(username, t, pw, ip); };
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS });
  return { base, browser, login, cli, remote, grant, person, db };
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
      ['同版本再插', sqlThrows(A, "INSERT INTO report_templates (dimension_id, version, body, sha256, kind, note, created_at, created_by) VALUES ('ops', 1, '{}', ?, 'layout', '', 1, 'x')", 'a'.repeat(64))],
      ['指针指没复核的判据类', sqlThrows(A, "UPDATE report_dimensions SET active_version = 1 WHERE id = 'ops'")],
      ['指针指不存在的版本', sqlThrows(A, "UPDATE report_dimensions SET active_version = 99 WHERE id = 'ops'")],
      ['作者本人复核（写库）', sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('ops', 1, 'user:olga', 'user:olga', 1)")],
      ['复核人主体为空（写库，本机命令行那种）', sqlThrows(A, "INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at) VALUES ('ops', 1, 'cli', NULL, 1)")],
      ['判据类版本作者主体为空（写库）', sqlThrows(A, "INSERT INTO report_templates (dimension_id, version, body, sha256, kind, note, created_at, created_by, created_by_principal) VALUES ('ops', 2, '{}', ?, 'criteria', '', 1, 'cli', NULL)", 'b'.repeat(64))],
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
    check(t.every(([, x]) => x) && okReview.status === 200 && t2.every(([, x]) => x), 'R3 库里直接改删模板、复核、留痕、维度，同版本再插，指针指没复核的判据类或不存在的版本，作者本人复核，复核人或判据类作者主体为空：触发器都拒', { t, okReview: okReview.status, t2 });
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
    check(withKind.status === 400 && kinds.join(',') === '1:criteria,2:layout,3:criteria,4:criteria,5:criteria' && shaOk,
      'R5 请求里写 kind：400；第一版 criteria；只改标题和文档结构 layout；改论断要求、验收声明、数据槽 criteria；回 sha256', { withKind: withKind.status, kinds });
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
    const activate = await rex.go('POST', '/api/report-dimensions/shape/activate', { json: { version: 1 } });
    const meta = (await nina.go('GET', '/api/report-dimensions/shape')).json;
    const v1 = meta?.templates?.find((t) => t.version === 1);
    check(unreviewed.status === 409 && layoutNoReview.status === 200 && tomReview.status === 403
        && riaReview.status === 200 && again.status === 409 && activate.status === 200 && meta?.dimension?.active_version === 1 && v1?.review?.reviewed_by === 'user:ria' && v1?.active === true,
      'R5a 判据类没复核就生效 409；版式类不复核也能生效；没有定报告维度权限的人复核 403；别的持有人复核 200、再复核 409；复核过后生效 200',
      { unreviewed: unreviewed.status, layoutNoReview: layoutNoReview.status, tomReview: tomReview.status, riaReview: riaReview.status, again: again.status, activate: activate.status, active: meta?.dimension?.active_version, v1 });
    check(err(selfReview) === '403:report_template_self_review' && err(crossWay) === '403:report_template_self_review',
      'R5b 作者本人复核 403（规格 5a）；同一个人带管理口令换个留痕写法复核自己的，主体相同，也算本人 403', { selfReview: err(selfReview), crossWay: err(crossWay) });
    check(err(cliReview) === '403:report_template_reviewer_unidentified' && tokenReview.status === 403,
      'R5c 认不出是谁的不能复核：本机命令行（权限过得了）403 reviewer_unidentified；只带管理口令的 403', { cliReview: err(cliReview), tokenReview: err(tokenReview) });
    check(err(cliPublish) === '403:report_template_author_unidentified' && same(before, afterCli),
      'R5d 认不出是谁的不能发判据类版本：本机命令行发第一版 403 author_unidentified，库里没有变化', { cliPublish: err(cliPublish), before, afterCli });
    check(ownerPub.status === 201 && err(ownerSelf) === '403:report_template_self_review' && err(cliOnOwner) === '403:report_template_reviewer_unidentified',
      'R5e 跨领域维度：属主发的判据类版本，属主自己复核 403（本人），本机命令行复核 403（认不出是谁）——要另一位持属主授予的人', { ownerPub: ownerPub.status, ownerSelf: err(ownerSelf), cliOnOwner: err(cliOnOwner) });
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
