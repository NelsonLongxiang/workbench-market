#!/usr/bin/env node
/**
 * 角色预设（单测）：七个内置预设在判定里各自能做什么——尤其是两处有意的改变：
 *   · 系统管理员默认不看业务数据（系统域的读写管，各处的管理类）；
 *   · 管理层有全公司的读、写、决定，没有管理类。
 * 还有：域两张清单盖住全部已登记动作；访客授予必须有期限；AI 员工只授予非人；管理口令照系统管理员加管理层算（今天的原样）。
 * 只用临时数据目录，动作清单取仓库里的快照（surfaces/actions.json），不起服务、不访问任何外部系统。
 *   node scripts/role-presets-test.mjs              测本仓库
 *   node scripts/role-presets-test.mjs --root DIR   测另一棵目录树
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `role-presets-${process.pid}-${Date.now().toString(36)}`);
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
  const { judgeBuiltin } = await import(at('server/src/judgment.ts'));
  const { MCP_TOOLS } = await import(at('server/src/mcp-tools.ts'));

  // 动作清单：快照里每条路由报的动作（含细分的）和 MCP 工具
  const snap = JSON.parse(readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8'));
  const catalog = new Map(MCP_TOOLS.map((t) => [t.name, t.category]));
  for (const line of snap.apps.flat()) {
    const m = /->\s+([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/.exec(line);
    if (m) catalog.set(m[1], m[2]);
    for (const r of String(line).matchAll(/细分：([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)\s+(read|write|decide|admin)/g)) catalog.set(r[1], r[2]);
  }
  const grants = svc('grants');
  grants.setRoles(roles.buildRoles([], catalog));

  // ---------- 一、七个预设、两张域清单 ----------
  const ids = grants.roles().filter((r) => r.platform).map((r) => r.id);
  check(show(ids) === show(['owner', 'admin', 'management', 'dept-lead', 'member', 'guest', 'ai-staff']), '内置预设七个：属主、系统管理员、管理层、部门负责人、普通员工、访客、AI 员工（沿用 6b 的 id）', show(ids));
  const names = Object.fromEntries(grants.roles().map((r) => [r.id, r.name]));
  check(names.admin === '系统管理员' && names.member === '普通员工' && names['dept-lead'] === '部门负责人', '沿用 id、只改显示名：admin 是系统管理员、member 是普通员工、dept-lead 升为内置', show(names));
  const loose = roles.unclassifiedDomains(catalog.keys());
  const both = roles.SYSTEM_DOMAINS.filter((d) => roles.BUSINESS_DOMAINS.includes(d));
  check(loose.length === 0 && both.length === 0, '每个已登记动作的域都归了类（系统或业务），没有两边都算的', show({ loose, both }));
  check(roles.domainOf('app-data.list') === 'app-data' && roles.domainOf('app_data_list') === 'mcp-tool', '动作的域：点号前面那段；MCP 工具都算 mcp-tool（业务）');

  // ---------- 二、判定里各自能做什么 ----------
  const now = Date.now();
  const insert = (id, kind = 'person', owner = '') => db.prepare('INSERT INTO principals (id, id_key, kind, owner) VALUES (?, ?, ?, ?)').run(id, id.toLowerCase(), kind, owner);
  const cliActor = { by: 'cli', principal: null, owner: true };
  // 授予一律从草稿开始（表上的触发器管着）：起草、提交、放行
  const give = (principal, role, scope = '*') => {
    const d = grants.draft({ principal, role, scope, expiresAt: null, reason: '合成' }, cliActor);
    if (!d.ok) throw new Error(`起草 ${principal} ${role} 失败：${d.code}`);
    grants.submit(d.grant.id, cliActor);
    const a = grants.approve(d.grant.id, cliActor);
    if (!a.ok) throw new Error(`放行 ${principal} ${role} 失败：${a.code}`);
  };
  for (const p of ['user:sys', 'user:boss', 'user:emp', 'user:both']) insert(p);
  give('user:sys', 'admin'); give('user:boss', 'management'); give('user:emp', 'member'); give('user:both', 'admin'); give('user:both', 'management');
  const actor = (id) => ({ type: 'principal', id, kind: 'person', status: 'active', owner: '' });
  const v = (who, action) => judgeBuiltin({ actor: typeof who === 'string' ? actor(who) : who, action, kind: catalog.get(action), declared: true, now }).verdict;
  const sys = { system: v('user:sys', 'principal.list'), systemWrite: v('user:sys', 'type.create'), businessRead: v('user:sys', 'work-item.read'), businessDecide: v('user:sys', 'change-request.approve'), adminAnywhere: v('user:sys', 'app-data.delete'), mcpTool: v('user:sys', 'app_data_list') };
  check(sys.system === 'allow' && sys.systemWrite === 'allow' && sys.businessRead === 'deny' && sys.businessDecide === 'deny' && sys.adminAnywhere === 'allow' && sys.mcpTool === 'deny',
    '系统管理员：系统域的读写、各处的管理类可以；业务数据读不到（事项、MCP 读台数据），不拍业务的板', show(sys));
  const boss = { businessRead: v('user:boss', 'work-item.read'), decide: v('user:boss', 'change-request.approve'), admin: v('user:boss', 'principal.disable'), adminBusiness: v('user:boss', 'app-data.delete') };
  check(boss.businessRead === 'allow' && boss.decide === 'allow' && boss.admin === 'deny' && boss.adminBusiness === 'deny',
    '管理层：全公司的读、拍板可以；管理类一律没有（管主体、删数据都不行）', show(boss));
  const bothV = { businessRead: v('user:both', 'work-item.read'), admin: v('user:both', 'principal.disable'), decide: v('user:both', 'change-request.approve') };
  check(Object.values(bothV).every((x) => x === 'allow'), '同时有系统管理员和管理层两条（迁移给现有管理员的）：等于今天的「什么都能看、能管」', show(bothV));
  const emp = { read: v('user:emp', 'work-item.read'), submit: v('user:emp', 'sop-run.start'), adminWrite: v('user:emp', 'type.create'), decideAny: v('user:emp', 'change-request.approve') };
  check(emp.read === 'allow' && emp.submit === 'allow' && emp.adminWrite === 'deny' && emp.decideAny === 'deny',
    '普通员工：看可以；提需求（开建 run）可以；系统的写、拍别人的板不行', show(emp));
  // 匿名的底：只有访客授予的人，匿名今天能做的（开放读面、提需求）照样能做；别的读不到
  insert('user:visitor');
  { const d = grants.draft({ principal: 'user:visitor', role: 'guest', scope: '*', expiresAt: now + 86_400_000, reason: '合成' }, cliActor); grants.submit(d.grant.id, cliActor); grants.approve(d.grant.id, cliActor); }
  const visitor = { open: v('user:visitor', 'sop-run.list'), submit: v('user:visitor', 'app-data.submit'), closed: v('user:visitor', 'work-item.read') };
  check(visitor.open === 'allow' && visitor.submit === 'allow' && visitor.closed === 'deny', '匿名的底：只有访客授予的人，匿名能做的照样能做（开放读面、提交台数据）；别的读不到', show(visitor));
  const token = { businessRead: v({ type: 'builtin', name: 'admin-token' }, 'work-item.read'), system: v({ type: 'builtin', name: 'admin-token' }, 'principal.disable') };
  check(token.businessRead === 'allow' && token.system === 'allow', '管理口令照系统管理员加管理层算：业务读、系统管理都照今天放行', show(token));

  // ---------- 三、授予的规则 ----------
  insert('seat:bot', 'seat', 'user:sys');
  const cli = { by: 'cli', principal: null, owner: true };
  const guestNoExpiry = grants.draft({ principal: 'user:emp', role: 'guest', scope: '*', expiresAt: null, reason: '合成' }, cli);
  const guestExpiry = grants.draft({ principal: 'user:emp', role: 'guest', scope: '*', expiresAt: now + 86_400_000, reason: '合成' }, cli);
  const aiToPerson = grants.draft({ principal: 'user:emp', role: 'ai-staff', scope: '*', expiresAt: null, reason: '合成' }, cli);
  const aiToSeat = grants.draft({ principal: 'seat:bot', role: 'ai-staff', scope: '*', expiresAt: null, reason: '合成' }, cli);
  const mgmtToSeat = grants.draft({ principal: 'seat:bot', role: 'management', scope: '*', expiresAt: null, reason: '合成' }, cli);
  check(guestNoExpiry.ok === false && guestNoExpiry.code === 'expiry_required' && guestExpiry.ok === true, '访客的授予必须有期限：没期限 422，有期限能起草', show({ no: guestNoExpiry.code, yes: guestExpiry.ok }));
  check(aiToPerson.ok === false && aiToPerson.code === 'non_person_only' && aiToSeat.ok === true && mgmtToSeat.ok === false && mgmtToSeat.code === 'decide_non_person',
    'AI 员工只授予非人主体：给人 422；给席位可以；带决定类的预设（管理层）给席位照 6b 的规则 422', show({ aiToPerson: aiToPerson.code, aiToSeat: aiToSeat.ok, mgmtToSeat: mgmtToSeat.code }));

  // ---------- 四、声明文件和内置预设同名：报错说清怎么改 ----------
  let msg = '';
  try { roles.buildRoles([{ id: 'management', name: '我们的管理层', permissions: [] }], catalog); } catch (e) { msg = String(e?.message ?? e); }
  check(/management/.test(msg) && /改法/.test(msg) && /改个 id 和名字，或者删掉它/.test(msg), '声明文件里有和内置预设同 id 的（升级前自己声明过 management）：拒绝，报错点名并说清改法', msg.slice(0, 200));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`role-presets-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
