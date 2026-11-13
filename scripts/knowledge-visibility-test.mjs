#!/usr/bin/env node
/**
 * 经验库的逐条可见（单测，不起服务）：services/knowledge.ts 的 visibility 对席位（非人主体）的判法。
 *   席位看部门的条目，除了自己要有正好是这个部门范围的授予，责任人复核也只认正好是这个部门的——
 *   责任人人人都有的那条范围「全部」的普通员工授予，不能让席位借去看每个部门的。
 * 临时数据目录，动作清单取仓库里的快照（surfaces/actions.json），不访问任何外部系统。
 *   node scripts/knowledge-visibility-test.mjs              测本仓库
 *   node scripts/knowledge-visibility-test.mjs --root DIR   测另一棵目录树（变异用）
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `knowledge-visibility-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
process.env.WM_KNOWLEDGE_SYNC_MINUTES = '0';
try {
  const { svc } = await import(at('server/src/context.ts'));
  const { db } = await import(at('server/src/db.ts'));
  const roles = await import(at('server/src/roles.ts'));
  const { MCP_TOOLS } = await import(at('server/src/mcp-tools.ts'));
  const { visibility } = await import(at('server/src/services/knowledge.ts'));

  const snap = JSON.parse(readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8'));
  const catalog = new Map(MCP_TOOLS.map((t) => [t.name, t.category]));
  for (const line of snap.apps.flat()) {
    const m = /->\s+([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/.exec(line);
    if (m) catalog.set(m[1], m[2]);
  }
  const grants = svc('grants');
  grants.setRoles(roles.buildRoles(roles.INITIAL_ORG_ROLES, catalog));
  const now = Date.now();
  const cli = { by: 'cli', principal: null, owner: true };
  const insert = (id, kind = 'person', owner = '') => db.prepare('INSERT INTO principals (id, id_key, kind, owner) VALUES (?, ?, ?, ?)').run(id, id.toLowerCase(), kind, owner);
  const on = (principal, role, scope) => {
    const d = grants.draft({ principal, role, scope, expiresAt: null, reason: '合成' }, cli);
    if (!d.ok) throw new Error(`起草 ${principal} ${role} ${scope}：${d.code}`);
    grants.submit(d.grant.id, cli, now);
    const a = grants.approve(d.grant.id, cli, now);
    if (!a.ok) throw new Error(`放行 ${principal} ${role} ${scope}：${a.code}`);
  };
  for (const id of ['sales', 'ops']) svc('departments').upsert({ id, name: `合成 ${id}`, functionCode: null, lead: null }, 'cli', now);

  // 责任人只有人人都有的「全部」普通员工授予；席位有销售部的 AI 员工授予
  insert('user:own'); insert('seat:kb-bot', 'seat', 'user:own');
  on('user:own', 'member', '*');
  on('seat:kb-bot', 'ai-staff', 'dept:sales');
  // 对照：责任人自己也有销售部的授予
  insert('user:own2'); insert('seat:kb-bot2', 'seat', 'user:own2');
  on('user:own2', 'member', '*'); on('user:own2', 'dept-member', 'dept:sales');
  on('seat:kb-bot2', 'ai-staff', 'dept:sales');

  const seat = (id, owner) => visibility({ type: 'principal', id, kind: 'seat', status: 'active', owner });
  const v1 = seat('seat:kb-bot', 'user:own'), v2 = seat('seat:kb-bot2', 'user:own2');
  const got = { bot: { sales: v1('dept:sales'), ops: v1('dept:ops'), star: v1('*') }, bot2: { sales: v2('dept:sales'), ops: v2('dept:ops') } };
  check(got.bot.sales === false && got.bot.ops === false,
    '席位：责任人只有范围「全部」的普通员工授予，借不到——销售部的条目看不到（责任人复核也只认正好是这个部门的）', show(got));
  check(got.bot2.sales === true && got.bot2.ops === false,
    '对照：责任人自己有销售部的授予，席位看得到销售部的；运营部的照样看不到', show(got));
} catch (e) {
  fail++; console.log(`  ✗ 出错：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`knowledge-visibility-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
