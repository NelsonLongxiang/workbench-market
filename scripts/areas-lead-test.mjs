#!/usr/bin/env node
/**
 * 领域负责人的服务层守护（docs/domains-step1.md 第二节第 1 小节，用例 28、29b；第 1 步 PR2b）。不起服务，只用临时数据目录。
 *
 *   L1 （#28 主测）领域是 pending-lead 时不能触发、验收：AreaService.workGate 回 409 area_no_lead；放行第一位负责人后回 null；撤了的回 409
 *   L2 负责人的授予到期（周期任务 expireDue）：领域在同一个事务里退回 pending-lead，留痕 lead-missing
 *   L3 （#29b）同一个领域两位负责人，两个进程同时各收回一位：只成一条，另一条 409 area_last_lead；领域始终至少一位负责人。
 *      两个子进程共用同一个库文件，各自在「数生效负责人」那一句之后停 400 毫秒（只在子进程里包一层 db.prepare，不改产品代码），
 *      所以检查要是不在写事务里，两边都会看到「还剩一位」、都收回成功——这一项就红
 *   L5 负责人本人停用时，领域的重算和停用在同一个写事务里：重算抛错，停用一起回滚，人还是启用的、领域还是 active；
 *      重算时 db.isTransaction 为真
 *   L6 （#21）迁移接口两个进程同时调：每个部门只成一个领域、负责人授予只起草一条，两边都回成功。
 *      两个子进程在「这个部门的领域在不在」那一句之后各停 400 毫秒；每个部门的建领域和起草授予要是不在同一个写事务里，就会撞或重复
 *   L7 （#22，PR3b）经验库：条目照写 dept:<x>，判定按领域问——持 area:<x> 的领域成员看得到 dept:<x> 的条目；领域撤了就看不到；
 *      部门还没迁成领域的，持 dept:<x> 照旧看得到；看不到别的部门的条目
 *   L4 旧库升级：PR1 建的 area_events（CHECK 里没有 lead-active / lead-missing）整表搬一次，行和编号原样，新种类能写，只增不改的触发器还在；再启动一次不重搬
 *
 *   node scripts/areas-lead-test.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { legacyDepartmentIn, legacyGrantIn } from './lib/legacy-dept-seed.mjs';
import { spawn } from 'node:child_process'; // 子进程不起服务、跑完自己退出，不用固定端口的夹具

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `areas-lead-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };

/** 子进程和主进程共用：装好角色表（动作清单取快照，含「细分」的动作） */
const SETUP = `
  const { svc } = await import(${JSON.stringify(at('server/src/context.ts'))});
  const roles = await import(${JSON.stringify(at('server/src/roles.ts'))});
  const { readFileSync } = await import('node:fs');
  const snap = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'surfaces', 'actions.json'))}, 'utf8'));
  const catalog = new Map();
  for (const line of snap.apps.flat()) {
    const m = /->\\s+([a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*)\\s+(read|write|decide|admin)/.exec(line);
    if (m) catalog.set(m[1], m[2]);
    for (const r of String(line).matchAll(/细分：([a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*)\\s+(read|write|decide|admin)/g)) catalog.set(r[1], r[2]);
  }
  svc('grants').setRoles(roles.buildRoles(roles.INITIAL_ORG_ROLES, catalog));
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { svc } = await import(at('server/src/context.ts'));
  const roles = await import(at('server/src/roles.ts'));
  const snap = JSON.parse(readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8'));
  const catalog = new Map();
  for (const line of snap.apps.flat()) {
    const m = /->\s+([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/.exec(line);
    if (m) catalog.set(m[1], m[2]);
    for (const r of String(line).matchAll(/细分：([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/g)) catalog.set(r[1], r[2]);
  }
  svc('grants').setRoles(roles.buildRoles(roles.INITIAL_ORG_ROLES, catalog));
  const { db } = await import(at('server/src/db.ts'));
  const grants = svc('grants'), areas = svc('areas');
  const cli = { by: 'cli', principal: null, owner: true };
  const person = (id) => db.prepare("INSERT INTO principals (id, id_key, kind) VALUES (?, ?, 'person')").run(id, id);
  const lead = (principal, area, expiresAt = null) => {
    const d = grants.draft({ principal, role: 'area-lead', scope: `area:${area}`, expiresAt, reason: '合成' }, cli);
    if (!d.ok) throw new Error(`起草 ${principal} 失败：${d.code}`);
    grants.submit(d.grant.id, cli);
    const a = grants.approve(d.grant.id, cli);
    if (!a.ok) throw new Error(`放行 ${principal} 失败：${a.code}`);
    return d.grant.id;
  };
  const kinds = (area) => db.prepare('SELECT kind FROM area_events WHERE area_id = ? ORDER BY seq').all(area).map((r) => r.kind);
  for (const p of ['user:la', 'user:lb', 'user:lc']) person(p);

  // ---- L1 ----
  {
    areas.create({ id: 'lone', name: '合成甲' }, cli, Date.now());
    const g0 = areas.workGate('lone');
    lead('user:la', 'lone');
    const g1 = areas.workGate('lone');
    areas.create({ id: 'gone', name: '合成乙' }, cli, Date.now());
    areas.retire('gone', '合成', { ...cli, owner: true }, Date.now());
    const g2 = areas.workGate('gone'), g3 = areas.workGate('nope');
    check(g0?.http === 409 && g0?.code === 'area_no_lead' && g1 === null && g2?.http === 409 && g3?.http === 404 && kinds('lone').includes('lead-active'),
      'L1（#28）pending-lead 时触发、验收的门回 409 area_no_lead；放行第一位负责人后放行（留痕 lead-active）；撤了的 409、不存在的 404', { g0, g1, g2, g3, k: kinds('lone') });
  }

  // ---- L2 ----
  {
    areas.create({ id: 'brief', name: '合成丙' }, cli, Date.now());
    lead('user:lb', 'brief', Date.now() + 1500); // 库里的触发器只认真到了期限的才能标成过期，所以真等一会儿
    const before = areas.get('brief').status;
    await new Promise((r) => setTimeout(r, 1800));
    const n = grants.expireDue();
    const after = areas.get('brief').status;
    check(before === 'active' && n === 1 && after === 'pending-lead' && kinds('brief').at(-1) === 'lead-missing',
      'L2 唯一一位负责人的授予到期：领域退回 pending-lead，留痕 lead-missing', { before, n, after, k: kinds('brief') });
  }

  // ---- L3 ----
  {
    areas.create({ id: 'twin', name: '合成丁' }, cli, Date.now());
    const ga = lead('user:la', 'twin'), gb = lead('user:lc', 'twin');
    const barrier = join(OUT, 'go');
    const child = (id) => {
      const code = `${SETUP}
        const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
        const { existsSync } = await import('node:fs');
        const orig = db.prepare.bind(db);
        const nap = new Int32Array(new SharedArrayBuffer(4));
        db.prepare = (sql) => {
          const st = orig(sql);
          if (!String(sql).includes('area-last-lead')) return st;
          return new Proxy(st, { get(t, k) { const v = t[k]; if (k === 'all' || k === 'get') return (...a) => { const r = v.apply(t, a); Atomics.wait(nap, 0, 0, 400); return r; }; return typeof v === 'function' ? v.bind(t) : v; } });
        };
        while (!existsSync(${JSON.stringify(barrier)})) Atomics.wait(nap, 0, 0, 5);
        const r = svc('grants').revoke(${id}, { by: 'cli', principal: null, owner: true }, '合成：并发收回');
        console.log('RESULT ' + JSON.stringify(r.ok ? { ok: true } : { ok: false, code: r.code }));
        process.exit(0);`;
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: OUT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += String(d); }); c.stderr.on('data', (d) => { out += String(d); });
      return new Promise((res) => c.on('exit', () => res(out)));
    };
    const runs = [child(ga), child(gb)];
    await new Promise((r) => setTimeout(r, 1500)); // 两个子进程都装好、停在门口
    writeFileSync(barrier, '');
    const outs = await Promise.all(runs);
    const res = outs.map((o) => { const m = /RESULT (.*)/.exec(o); return m ? JSON.parse(m[1]) : { error: o.trim().split('\n').slice(-3).join(' | ') }; });
    const left = db.prepare("SELECT COUNT(*) AS n FROM grants WHERE scope = 'area:twin' AND status = 'active'").get().n;
    const okN = res.filter((r) => r.ok).length, refused = res.filter((r) => r.code === 'area_last_lead').length;
    check(okN === 1 && refused === 1 && Number(left) === 1 && areas.get('twin').status === 'active',
      'L3（#29b）两个进程同时各收回一位负责人：只成一条，另一条 409 area_last_lead；领域还剩一位、仍是 active', { res, left });
  }

  // ---- L5 ----
  {
    areas.create({ id: 'tight', name: '合成戊' }, cli, Date.now());
    person('user:ld');
    lead('user:ld', 'tight');
    const principals = svc('principals');
    const orig = areas.reconcileLead.bind(areas);
    let inTx = null;
    areas.reconcileLead = (...a) => { inTx = db.isTransaction; throw new Error('合成：重算失败'); };
    let threw = false;
    try { principals.setStatus('user:ld', 'disabled', 'cli', '合成：离职'); } catch { threw = true; }
    areas.reconcileLead = orig;
    const p1 = principals.get('user:ld')?.status, a1 = areas.get('tight').status, gate1 = areas.workGate('tight');
    // 对照：重算正常时，停用之后领域退回 pending-lead
    principals.setStatus('user:ld', 'disabled', 'cli', '合成：离职');
    const p2 = principals.get('user:ld')?.status, a2 = areas.get('tight').status;
    check(threw && inTx === true && p1 === 'active' && a1 === 'active' && gate1 === null && p2 === 'disabled' && a2 === 'pending-lead',
      'L5 停用和领域重算同一个写事务：重算抛错时停用一起回滚（人仍启用、领域仍 active）；重算时在事务里；正常时停用后领域退回 pending-lead', { threw, inTx, p1, a1, gate1, p2, a2 });
  }

  // ---- L6 ----
  {
    person('user:le');
    // 部门已停写：c-sales 的负责人（字段 + 生效的 dept-lead 授予）是停写前就有的，直接写库造（scripts/lib/legacy-dept-seed.mjs）
    const dr = { ok: legacyDepartmentIn(db, 'c-sales', '合成并发销售', 'user:le') > 0 };
    svc('departments').upsert({ id: 'c-ops', name: '合成并发运营', functionCode: null, lead: null }, 'cli', Date.now());
    const barrier = join(OUT, 'go-migrate');
    const child = () => {
      const code = `${SETUP}
        const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
        const { existsSync } = await import('node:fs');
        const orig = db.prepare.bind(db);
        const nap = new Int32Array(new SharedArrayBuffer(4));
        db.prepare = (sql) => {
          const st = orig(sql);
          if (!String(sql).includes('area-migrate')) return st;
          return new Proxy(st, { get(t, k) { const v = t[k]; if (k === 'all' || k === 'get') return (...a) => { const r = v.apply(t, a); Atomics.wait(nap, 0, 0, 400); return r; }; return typeof v === 'function' ? v.bind(t) : v; } });
        };
        while (!existsSync(${JSON.stringify(barrier)})) Atomics.wait(nap, 0, 0, 5);
        try {
          const r = svc('areas').migrateDepartments({ by: 'cli', principal: null, owner: true }, Date.now());
          console.log('RESULT ' + JSON.stringify({ ok: true, created: r.created, drafted: r.drafted.length }));
        } catch (e) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(e?.message ?? e) })); }
        process.exit(0);`;
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: OUT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += String(d); }); c.stderr.on('data', (d) => { out += String(d); });
      return new Promise((res) => c.on('exit', () => res(out)));
    };
    const runs = [child(), child()];
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(barrier, '');
    const res = (await Promise.all(runs)).map((o) => { const m = /RESULT (.*)/.exec(o); return m ? JSON.parse(m[1]) : { error: o.trim().split('\n').slice(-3).join(' | ') }; });
    const areasN = Number(db.prepare("SELECT COUNT(*) AS n FROM areas WHERE id IN ('c-sales', 'c-ops')").get().n);
    const grantsN = Number(db.prepare("SELECT COUNT(*) AS n FROM grants WHERE scope = 'area:c-sales' AND reason = '由部门负责人迁移'").get().n);
    const evN = Number(db.prepare("SELECT COUNT(*) AS n FROM area_events WHERE kind = 'migrate' AND area_id IN ('c-sales', 'c-ops')").get().n);
    check(dr.ok && res.every((r) => r.ok) && areasN === 2 && grantsN === 1 && evN === 2,
      'L6（#21）两个进程同时调迁移：两边都成功，每个部门只成一个领域、一行 migrate 留痕，负责人授予只起草一条', { res, areasN, grantsN, evN });
  }

  // ---- L7 ----
  {
    const { visibility } = await import(at('server/src/services/knowledge.ts'));
    for (const p of ['user:km', 'user:kd', 'user:kl']) person(p);
    areas.create({ id: 'kx', name: '合成经验领域' }, cli, Date.now());
    lead('user:kl', 'kx');
    const issue = (principal, role, scope) => { const d = grants.draft({ principal, role, scope, expiresAt: null, reason: '合成' }, cli); if (!d.ok) throw new Error(`起草 ${principal} 失败：${d.code}`); grants.submit(d.grant.id, cli); grants.approve(d.grant.id, cli); };
    svc('departments').upsert({ id: 'kold', name: '合成没迁的部门', functionCode: null, lead: null }, 'cli', Date.now());
    issue('user:km', 'area-member', 'area:kx');
    legacyGrantIn(db, 'user:kd', 'dept-member', 'dept:kold', { reason: '合成' }); // 停写前就有的部门授予
    const actor = (id) => ({ type: 'principal', id, kind: 'person', status: 'active', owner: '' });
    const before = { kmKx: visibility(actor('user:km'))('dept:kx'), kmOld: visibility(actor('user:km'))('dept:kold'), kdOld: visibility(actor('user:kd'))('dept:kold'), kdKx: visibility(actor('user:kd'))('dept:kx') };
    areas.retire('kx', '合成', { ...cli, owner: true }, Date.now());
    const after = { kmKx: visibility(actor('user:km'))('dept:kx') };
    check(before.kmKx === true && before.kmOld === false && before.kdOld === true && before.kdKx === false && after.kmKx === false,
      'L7（#22）经验库：area:kx 的领域成员看得到 dept:kx 的条目、看不到别的部门的；没迁的部门 kold，持 dept:kold 照旧看得到；kx 撤了以后看不到', { before, after });
  }

  // ---- L4 ----
  {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = join(OUT, 'old');
    mkdirSync(dir, { recursive: true });
    const old = new DatabaseSync(join(dir, 'workbench-market.db'));
    old.exec(`CREATE TABLE area_events (seq INTEGER PRIMARY KEY, area_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'retire', 'spec-add', 'spec-activate', 'migrate')), version INTEGER,
      actor TEXT NOT NULL CHECK (actor <> ''), actor_principal TEXT, at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX idx_area_events_area ON area_events (area_id, seq);
      CREATE TRIGGER area_events_no_update BEFORE UPDATE ON area_events BEGIN SELECT RAISE(ABORT, 'area_events 只增不改'); END;
      CREATE TRIGGER area_events_no_delete BEFORE DELETE ON area_events BEGIN SELECT RAISE(ABORT, 'area_events 只增不改'); END;
      INSERT INTO area_events (seq, area_id, kind, version, actor, at, detail) VALUES (7, 'legacy', 'create', NULL, 'cli', 1, ''), (9, 'legacy', 'spec-add', 1, 'cli', 2, '第一版');`);
    old.close();
    const open = () => new Promise((res) => {
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(at('server/src/db.ts'))}); process.exit(0);`],
        { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += String(d); }); c.stderr.on('data', (d) => { out += String(d); });
      c.on('exit', (code) => res({ code, out }));
    });
    const first = await open(), second = await open();
    const d = new DatabaseSync(join(dir, 'workbench-market.db'));
    let rows = [], newKind = false, upd = false, del = false, leftover = null;
    try {
      rows = d.prepare('SELECT seq, kind, detail FROM area_events ORDER BY seq').all().map((r) => `${r.seq}:${r.kind}:${r.detail}`);
      d.prepare("INSERT INTO area_events (area_id, kind, actor, at, detail) VALUES ('legacy', 'lead-missing', 'cli', 3, '合成')").run(); newKind = true;
      try { d.prepare("UPDATE area_events SET detail = 'x' WHERE seq = 7").run(); } catch { upd = true; }
      try { d.prepare('DELETE FROM area_events WHERE seq = 7').run(); } catch { del = true; }
      leftover = d.prepare("SELECT name FROM sqlite_master WHERE name = 'area_events_pr1'").get() ?? null;
    } catch (e) { rows.push(String(e?.message ?? e)); } finally { d.close(); }
    check(first.code === 0 && second.code === 0 && JSON.stringify(rows) === JSON.stringify(['7:create:', '9:spec-add:第一版']) && newKind && upd && del && leftover === null,
      'L4 旧库升级：area_events 整表搬一次，行和编号原样，lead-missing 能写，改、删照旧被拒，没有留下中间表；再启动一次也没事', { first: first.code, second: second.code, rows, newKind, upd, del, leftover, out: first.out.slice(-300) });
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`areas-lead-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
