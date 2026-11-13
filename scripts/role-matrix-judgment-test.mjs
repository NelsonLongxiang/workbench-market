#!/usr/bin/env node
/**
 * 「谁能做什么」的矩阵和真实判定逐格对照（单测）：矩阵（roles.ts 的 roleMatrix）说一个角色在某块某类上能做什么，
 * 就拿一个只持这个角色授予的人，把这一块里登记成这一类的每个动作都真的问一遍统一判定，按同样的口径归拢，结果必须逐格相同。
 *
 *   · 问判定用的类别、按不按部门问，照 judgment-builtins.ts 的 ASKED（和路由放行同一张表）；
 *   · 授予范围由部门给的角色（部门负责人、AI 员工、访客、组织角色）发到 dept:sales，其余发「全部」；
 *     AI 员工发给席位，席位的责任人持管理层授予（责任人复核过得去）；
 *   · 全公司那一档问 judge，部门那一档问 scopedVerdict（dept:sales），只限自己的只在 SELF_DECIDED 上、而且两档都拒时才算；
 *   · 守护：只持普通员工授予的人，台的每个动作统一判定都拒（台的读按「写」问）；
 *   · 还抽几格写死，看矩阵说的正是这次要改的那几处：普通员工、部门负责人在经验库的拍板那一格不能做；
 *     普通员工看台的数据不是「全部」（台的读按「写」问）；部门负责人只在台和经验库上「范围内」。
 * 只用临时数据目录，动作清单取仓库里的快照（surfaces/actions.json），不起服务。
 *
 *   node scripts/role-matrix-judgment-test.mjs
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `role-matrix-judgment-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { svc } = await import(at('server/src/context.ts'));
  const { db } = await import(at('server/src/db.ts'));
  const roles = await import(at('server/src/roles.ts'));
  const { judgeBuiltin, scopedVerdict } = await import(at('server/src/judgment.ts'));
  const { askedKind, deptKind, SELF_DECIDED } = await import(at('server/src/judgment-builtins.ts'));
  const { MCP_TOOLS } = await import(at('server/src/mcp-tools.ts'));

  const snap = JSON.parse(readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8'));
  const catalog = new Map(MCP_TOOLS.map((t) => [t.name, t.category]));
  for (const line of snap.apps.flat()) {
    const m = /->\s+([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/.exec(line);
    if (m) catalog.set(m[1], m[2]);
    for (const r of String(line).matchAll(/细分：([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/g)) catalog.set(r[1], r[2]);
  }
  const grants = svc('grants');
  grants.setRoles(roles.buildRoles(roles.INITIAL_ORG_ROLES, catalog));
  svc('departments').upsert({ id: 'sales', name: '合成 sales', functionCode: null, lead: null }, 'cli', Date.now());

  const now = Date.now();
  const cli = { by: 'cli', principal: null, owner: true };
  const insert = (id, kind = 'person', owner = '') => db.prepare('INSERT INTO principals (id, id_key, kind, owner) VALUES (?, ?, ?, ?)').run(id, id.toLowerCase(), kind, owner);
  const give = (principal, role, scope) => {
    const d = grants.draft({ principal, role, scope, expiresAt: role === 'guest' ? now + 86_400_000 : null, reason: '合成：矩阵对照' }, cli);
    if (!d.ok) throw new Error(`起草 ${principal} ${role} 失败：${d.code}`);
    grants.submit(d.grant.id, cli);
    const a = grants.approve(d.grant.id, cli);
    if (!a.ok) throw new Error(`放行 ${principal} ${role} 失败：${a.code}`);
  };

  const all = grants.roles();
  const byDept = (r) => roles.SCOPED_PRESETS.includes(r.id) || (!r.platform && !r.custom);
  // 每个角色一个只持这一条授予的主体
  insert('user:resp'); give('user:resp', 'management', '*');
  const holder = new Map();
  for (const r of all) {
    const nonPerson = roles.NON_PERSON_ONLY_ROLES.includes(r.id);
    const id = nonPerson ? `seat:mx-${r.id}` : `user:mx-${r.id}`;
    insert(id, nonPerson ? 'seat' : 'person', nonPerson ? 'user:resp' : '');
    give(id, r.id, byDept(r) ? 'dept:sales' : '*');
    holder.set(r.id, { type: 'principal', id, kind: nonPerson ? 'seat' : 'person', status: 'active', owner: nonPerson ? 'user:resp' : '' });
  }

  // 拿真实判定归拢出来的格子
  const derived = (r) => {
    const actor = holder.get(r.id);
    const selfPerm = (kind, action) => r.closure.some((p) => p.scope === 'self' && (p.kinds ?? []).includes(kind) && (!p.domains || p.domains.includes(roles.domainOf(action))));
    const out = {};
    for (const b of roles.BLOCKS) {
      out[b.key] = {};
      for (const k of roles.KINDS) {
        let n = 0, full = 0, scoped = 0, self = 0;
        for (const [a, declared] of catalog) {
          if (declared !== k || !b.domains.includes(roles.domainOf(a))) continue;
          n++;
          const ak = askedKind(a, k);
          if (judgeBuiltin({ actor, action: a, kind: ak, declared: true, now }).verdict === 'allow') { full++; continue; }
          const dk = deptKind(a);
          if (dk && scopedVerdict({ principal: actor.id, action: a, kind: dk, scope: 'dept:sales', now }).verdict === 'allow') { scoped++; continue; }
          if (SELF_DECIDED.includes(a) && selfPerm(ak, a)) self++;
        }
        out[b.key][k] = n === 0 ? 'na' : full === n ? 'all' : full > 0 ? 'some' : scoped > 0 ? 'scoped' : self > 0 ? 'self' : 'none';
      }
    }
    return out;
  };

  const mismatches = [];
  let cells = 0;
  for (const r of all) {
    const m = roles.roleMatrix(r, catalog), d = derived(r);
    for (const b of roles.BLOCKS) for (const k of roles.KINDS) { cells++; if (m[b.key][k] !== d[b.key][k]) mismatches.push(`${r.id}/${b.key}/${k}: 矩阵 ${m[b.key][k]}、判定 ${d[b.key][k]}`); }
  }
  check(mismatches.length === 0 && cells === all.length * roles.BLOCKS.length * roles.KINDS.length,
    `矩阵逐格和真实判定一致：${all.length} 个角色 × ${roles.BLOCKS.length} 块 × ${roles.KINDS.length} 类 = ${cells} 格，每格把这一块这一类的动作都问了一遍`, mismatches.slice(0, 12).join('；'));

  const mx = (id) => roles.roleMatrix(all.find((r) => r.id === id), catalog);
  const member = mx('member'), lead = mx('dept-lead');
  const picks = {
    memberKnowledgeDecide: member.knowledge.decide, leadKnowledgeDecide: lead.knowledge.decide,
    memberBenchRead: member['bench-data'].read, memberWorkDecide: member.work.decide,
    leadBenchRead: lead['bench-data'].read, leadKnowledgeRead: lead.knowledge.read, leadWorkRead: lead.work.read, leadTeamRead: lead.team.read,
  };
  check(picks.memberKnowledgeDecide === 'none' && picks.leadKnowledgeDecide === 'none' && picks.memberBenchRead !== 'all' && picks.memberWorkDecide === 'self'
      && picks.leadBenchRead === 'scoped' && picks.leadKnowledgeRead === 'scoped' && picks.leadWorkRead !== 'scoped' && picks.leadTeamRead === 'none',
    '抽格：经验库的拍板，普通员工、部门负责人都不能（不再显示「只限自己的」「范围内」）；普通员工看台的数据不是「全部」（台的读按「写」问）、事项的拍板只限自己的；部门负责人只在台和经验库上「范围内」', show(picks));
  // 守护：台里是业务数据。只持普通员工授予（全公司业务的「看」）的人，问任何一个台的动作，统一判定都要拒——
  // 台的读按「写」问（ASKED），不能因为普通员工能「看」就打开台的数据。把哪个台的动作改成按「看」问，这里就红
  const emp = holder.get('member');
  const leaked = [...catalog.keys()].filter((a) => a.startsWith('bench-store.'))
    .filter((a) => judgeBuiltin({ actor: emp, action: a, kind: askedKind(a, catalog.get(a)), declared: true, now }).verdict === 'allow');
  check(leaked.length === 0 && [...catalog.keys()].some((a) => a.startsWith('bench-store.')),
    '台的数据：只持普通员工授予的人，台的每个动作统一判定都拒（台的读按「写」问，「看」打不开）', leaked.join('、'));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`role-matrix-judgment-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
