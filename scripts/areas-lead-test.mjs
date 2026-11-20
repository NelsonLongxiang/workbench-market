#!/usr/bin/env node
/**
 * 领域负责人的服务层守护（docs/domains-step1.md 第二节第 1 小节，用例 28、29b；第 1 步 PR2b）。不起服务，只用临时数据目录。
 *
 *   L1 （#28 主测）领域是 pending-lead 时不能触发、验收：AreaService.workGate 回 409 area_no_lead；放行第一位负责人后回 null；撤了的回 409
 *   L2 负责人的授予到期（周期任务 expireDue）：领域在同一个事务里退回 pending-lead，留痕 lead-missing
 *   L3 （#29b）同一个领域两位负责人，两个进程同时各收回一位：只成一条，另一条 409 area_last_lead；领域始终至少一位负责人。
 *      两个子进程共用同一个库文件，各自在「数生效负责人」那一句之后停 400 毫秒（只在子进程里包一层 db.prepare，不改产品代码），
 *      所以检查要是不在写事务里，两边都会看到「还剩一位」、都收回成功——这一项就红
 *
 *   node scripts/areas-lead-test.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';

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
    const now = Date.now();
    lead('user:lb', 'brief', now + 60_000);
    const before = areas.get('brief').status;
    const n = grants.expireDue(now + 120_000);
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
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`areas-lead-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
