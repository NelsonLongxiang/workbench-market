#!/usr/bin/env node
/**
 * 一人一助理第 1 期 PR 1（助理主体）补充的对抗用例草稿。
 * 设计见 docs/assistant-phase1.md 第十一节；用例清单见统筹共享笔记 assistant-phase1-prep.md 第三节。
 * 这是**测试草稿**：先在没实现的 main 上跑，应当全红（助理这个类别还不存在）；PR 1 实现之后全绿。
 * 用例的编号和设计第九节的 A0～A22 接着排，PR 1 开工时并进 scripts/assistant-identity-test.mjs。
 *
 *   A7a 给助理起草授予：范围 *、dept:、存在的 area:、不存在的 area: → 都是 422 assistant_no_grants（次序：先于 area 核对）
 *   A7b 绕过服务直接往 grants 插主体是助理的行 → 触发器 grants_no_assistant 拒
 *   A7c 对助理调 migrate() → null，不写授予（进程内调服务方法）
 *   A7d 经部门负责人这条路径（setDepartmentLead → dept-lead-grant）给助理 → assistant_no_grants；领域第 1 步 PR3 让部门停写之后改成断言 410
 *   A7e 领域还在 pending-lead，属主起草「第一位负责人」给助理 → assistant_no_grants，领域状态不变（领域第 1 步 PR2 之后才有负责人预设）
 *   A23 把主体的类别连同标识改掉（人改成助理、助理改成人）→ 触发器拒（「kind 建好就不能改」）
 *   A24 本人有授予、助理没有：按主体问判定（GET /api/principals/:id/access?action=），助理一律 deny
 *   A25 部门 → 领域迁移（领域第 1 步 PR3）不迁出以助理为负责人或成员的东西 —— 迁移的入口等 PR3 定形，草稿先按 POST /api/areas/migrate 写
 *   A26 以助理为负责人建团队负责人的提议并放行 → 不会出现助理当负责人的行
 *       （草稿的局限：没有认领团队，main 上先回 team_not_claimed，到不了「负责人要是启用的人」那一步。
 *        PR 1 开工时照 teams-smoke 的做法先认领一个合成团队，并把断言收紧到 lead_not_person，否则变异 team-lead-any-kind 抓不到）
 *   A27 名字解析不给助理出名字 —— main 上已经守住（只认 user:），属于回归守护，不会先红
 *   A28 「记成经验」的写入人不会是助理 —— 第 1 期没有记经验的工具，留到第 2 期（助理工具表接经验库时）；这里只占位
 *
 *   node scripts/assistant-identity-extra-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `assistant-identity-extra-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-assistant-extra-admin';

let pass = 0, fail = 0, todo = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const pending = (label, why) => { todo++; console.log(`  … ${label}（${why}）`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
let child = null, log = '', base = '';
async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}
/** 本机命令行：回环、不带浏览器标记、不带口令（授予面和领域面上算属主） */
const cli = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
/** 管理口令（远程形态） */
const admin = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: json === undefined ? undefined : JSON.stringify(json) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const withDb = (fn) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 10_000 }); try { return fn(d); } finally { d.close(); } };
const principal = (id) => withDb((d) => d.prepare('SELECT id, kind, status, owner FROM principals WHERE id = ?').get(id) ?? null);
const errOf = (fn) => { try { fn(); return null; } catch (e) { return String(e?.message ?? e); } };

rmSync(OUT, { recursive: true, force: true });
for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
try {
  await start();

  // 前提：建人就建助理（A1 那一条守的是这个；这里先确认前提成立，不成立后面全算红）
  const made = await admin('POST', '/api/local-accounts', { username: 'alice', display_name: 'Synthetic alice' });
  const asst = principal('assistant:alice');
  check(made.status === 201 && asst?.kind === 'assistant' && asst.owner === 'user:alice', '前提：建站内账号 alice，同时有助理 assistant:alice（类别 assistant，责任人 user:alice）', { made: made.status, asst });

  console.log('A7 助理不给授予，各条写授予的路径');
  {
    const a = await cli('POST', '/api/areas', { id: 'syn-area', name: '合成领域' });
    const scopes = ['*', 'dept:syn-nope', 'area:syn-area', 'area:syn-zz-nonexistent'];
    const res = [];
    for (const scope of scopes) res.push([scope, (await cli('POST', '/api/grants', { principal: 'assistant:alice', role: 'member', scope, reason: '合成' })).json?.error ?? null]);
    check(!!asst && a.status === 201 && res.every(([, e]) => e === 'assistant_no_grants'),
      'A7a 给助理起草授予：范围 *、dept:、存在的 area:、不存在的 area: 都回 assistant_no_grants（不存在的 area: 不能先回 area_unknown）', { area: a.status, res });

    const ins = errOf(() => withDb((d) => d.prepare("INSERT INTO grants (principal_id, role, scope, reason, created_by, created_at, updated_at) VALUES ('assistant:alice', 'member', '*', '合成', 'cli', ?, ?)").run(Date.now(), Date.now())));
    check(!!asst && ins !== null && /grants_no_assistant/.test(ins), 'A7b 绕过服务直接插一行主体是助理的授予：被触发器 grants_no_assistant 拒', ins ?? '插进去了');

    // A7c：进程内调 GrantService.prototype.migrate（它只用 this.roleViews），对助理应当回 null、不写授予
    const probe = join(OUT, 'migrate-probe.mjs');
    writeFileSync(probe, `
      const { GrantService } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/grant.ts')).href)});
      const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
      const self = { roleViews: new Map([['member', {}]]) };
      let out;
      try { out = GrantService.prototype.migrate.call(self, 'assistant:alice', 'member', '合成', Date.now()); } catch (e) { out = 'threw:' + e.message; }
      const n = db.prepare("SELECT COUNT(*) AS n FROM grants WHERE principal_id = 'assistant:alice'").get().n;
      console.log(JSON.stringify({ out: out === null ? null : String(out?.id ?? out), n }));
    `);
    await stop();
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', probe], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 60000 });
    let mj = null; try { mj = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 没跑成 */ }
    check(!!asst && mj?.out === null && mj.n === 0, 'A7c 对助理调 migrate()：回 null，不写授予', mj ?? r.stderr.slice(-300));
    await start();

    const dl = await cli('PUT', '/api/departments/syn-dept', { name: '合成部门', lead: 'assistant:alice' });
    const dlOk = dl.status === 410 || dl.json?.error === 'assistant_no_grants';
    const noLeadGrant = withDb((d) => d.prepare("SELECT COUNT(*) AS n FROM grants WHERE principal_id = 'assistant:alice'").get().n) === 0;
    check(!!asst && dlOk && noLeadGrant, 'A7d 经部门负责人路径给助理：assistant_no_grants（领域 PR3 部门停写之后是 410），没有授予落库', { status: dl.status, error: dl.json?.error });

    const lead = await cli('POST', '/api/grants', { principal: 'assistant:alice', role: 'area-lead', scope: 'area:syn-area', reason: '合成：第一位负责人' });
    const areaAfter = (await cli('GET', '/api/areas/syn-area')).json?.area?.status ?? null;
    check(!!asst && lead.json?.error === 'assistant_no_grants' && areaAfter === 'pending-lead', 'A7e 领域还在 pending-lead，属主起草第一位负责人给助理：assistant_no_grants，领域仍是 pending-lead', { lead: [lead.status, lead.json?.error], areaAfter });
  }

  console.log('A23 主体的类别建好就不能改');
  {
    await admin('POST', '/api/local-accounts', { username: 'bob', display_name: 'Synthetic bob' });
    const toAsst = errOf(() => withDb((d) => d.prepare("UPDATE principals SET id = 'assistant:carol', id_key = 'assistant:carol', kind = 'assistant', owner = 'user:alice' WHERE id = 'user:bob'").run()));
    const toPerson = errOf(() => withDb((d) => d.prepare("UPDATE principals SET id = 'user:zed', id_key = 'user:zed', kind = 'person', owner = '' WHERE id = 'assistant:alice'").run()));
    // 改不动必须是因为「类别不能改」那个触发器，不是因为别的约束（main 上助理类别本身不存在，CHECK 也会拒，那不算）
    check(!!asst && /principal_kind_fixed/.test(toAsst ?? '') && /principal_kind_fixed/.test(toPerson ?? ''), 'A23 人改成助理、助理改成人（连标识一起改）：被触发器 principal_kind_fixed 拒', { toAsst, toPerson });
  }

  console.log('A24 判定不借本人的授予给助理');
  {
    // 先给本人一条生效的成员授予（本机命令行起草、提交、放行），好有一个「本人能做」的动作来比
    const g = await cli('POST', '/api/grants', { principal: 'user:alice', role: 'member', scope: '*', reason: '合成' });
    const gid = g.json?.grant?.id;
    if (gid) { await cli('POST', `/api/grants/${gid}/submit`, {}); await cli('POST', `/api/grants/${gid}/approve`, {}); }
    const me = await admin('GET', '/api/principals/user:alice/access');
    // 授予的权限是 { actions: [...] } 或 { kinds: [...] } 的形状：取一个点名的动作来比
    const perms = (me.json?.active ?? []).flatMap((x) => x.permissions ?? []).flatMap((p) => (Array.isArray(p?.actions) ? p.actions : [])).filter((a) => typeof a === 'string');
    const action = perms[0] ?? null;
    const mine = action ? (await admin('GET', `/api/principals/user:alice/access?action=${encodeURIComponent(action)}`)).json?.decision?.verdict : null;
    const theirs = action ? await admin('GET', `/api/principals/assistant:alice/access?action=${encodeURIComponent(action)}`) : null;
    check(!!asst && !!action && mine === 'allow' && theirs?.status === 200 && theirs.json?.decision?.verdict === 'deny',
      'A24 本人能做的动作，按助理主体问判定：deny（助理只有经确认门时才按本人算）', { action, mine, theirs: theirs ? [theirs.status, theirs.json?.decision ?? theirs.json?.error] : null });
  }

  console.log('A25 部门 → 领域迁移不碰助理');
  {
    withDb((d) => {
      try {
        d.prepare("INSERT INTO departments (id, name, created_at, updated_at) VALUES ('syn-mig', '合成迁移部门', 1, 1)").run();
        d.prepare("INSERT INTO department_members (department_id, principal_id, created_at) VALUES ('syn-mig', 'assistant:alice', 1)").run();
      } catch { /* 表结构以 PR3 时为准；插不进去时下面照样判红 */ }
    });
    const mig = await cli('POST', '/api/areas/migrate', {});
    const leaked = withDb((d) => d.prepare("SELECT COUNT(*) AS n FROM grants WHERE principal_id = 'assistant:alice'").get().n);
    check(!!asst && mig.status >= 200 && mig.status < 300 && leaked === 0, 'A25 迁移部门到领域（入口按领域第 1 步 PR3 定形后改）：不给助理迁出任何授予或负责人', { mig: mig.status, leaked });
  }

  console.log('A26 团队负责人的提议不能落到助理身上');
  {
    const id = withDb((d) => {
      try { return Number(d.prepare("INSERT INTO relation_proposals (kind, department_id, host, team, principal_id, proposed_by, proposed_by_principal, proposed_at) VALUES ('team-lead', '', 'syn-host', 'syn-team', 'assistant:alice', 'cli', NULL, ?)").run(Date.now()).lastInsertRowid); } catch { return null; }
    });
    const ap = id ? await cli('POST', `/api/relations/proposals/${id}/approve`, { reason: '合成' }) : null;
    const leads = withDb((d) => { try { return d.prepare("SELECT COUNT(*) AS n FROM team_leads WHERE principal_id = 'assistant:alice'").get().n; } catch { return -1; } });
    check(!!asst && !!ap && ap.status >= 400 && leads === 0, 'A26 放行以助理为负责人的团队负责人提议：被拒，team_leads 里没有助理', { ap: ap ? [ap.status, ap.json?.error] : null, leads });
  }

  console.log('A27、A28');
  pending('A27 名字解析不给助理出名字', 'main 上已经守住（attention-names 只认 user: 前缀和 kind=person），是回归守护；PR 1 里配变异「去掉 kind=person」证明它守着');
  pending('A28 记成经验的写入人不会是助理', '第 1 期没有记经验的工具；第 2 期把经验库接进助理工具表时补');
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  await stop();
  await sleep(300);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`assistant-identity-extra-test: ${pass} passed / ${fail} failed / ${todo} 待定`);
process.exit(fail ? 1 : 0);
