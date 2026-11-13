/**
 * 内置身份（阶段六 6c）：不是人、不是主体表里的行，权限按动作逐条列出。列的就是旧守卫今天实际放行的那些，
 * 切换（6d）对外零差异；旧行为里不合理的地方登记在 docs/judgment-legacy-differences.md，以后单独立项改。
 * 这份清单进快照（surfaces/actions.json 的 builtins），改它要过评审。列的动作都要在动作清单里：快照导出时核对，对不上导出失败（CI 红）。
 *
 * 认身份的先后（judgment-compare.ts）：有效的管理口令 → 登录认出来的主体 → 本机命令行（回环直连、没有浏览器标记）
 * → 本机页面（回环直连、带浏览器标记）→ 匿名。
 */

import type { Kind } from './roles.ts';

export type BuiltinName = 'admin-token' | 'local-cli' | 'local-page' | 'anonymous';
export type BuiltinIdentity = {
  name: BuiltinName;
  /** 给人看的名字 */
  label: string;
  /** 照哪几个角色的权限算（只有管理口令：系统管理员加管理层，就是今天口令能做的——系统和业务的读写管；决定类另见 actsForOwner） */
  roles?: readonly string[];
  /** 另外逐条列出的动作 */
  actions: readonly string[];
  /** 「口令持有人代属主行事」：这些决定类动作照旧放行，留痕里标明经口令或经本机（存量差异清单 D） */
  actsForOwner: readonly string[];
};

/**
 * 匿名今天能做的（登录门关着时开放的读面、匿名提交面）。本机页面由它推出来；登录认出来的主体判不过时也按它兜底
 * （今天匿名能做的，登录的人当然也能做，见 judgment.ts 的「匿名的底」）
 */
export const ANONYMOUS_ACTIONS: readonly string[] = [
  'admin-token.state',
  'admin.whoami',
  'agent-card.read',
  // 台数据与附件的三个读（app-data.list、files、download）不列：放不放行看台令牌，路由声明了「状态码不代表授权」（#548）
  'app-data.submit',
  'app-data.upload',
  'app.list',
  'app.page',
  'app.read',
  'attention.read',
  'auth.me', // 回答「你是谁」：没认出也是 200（登录门四条，阶段三搬进 routes/login-gate.ts）
  'cockpit.list',
  'cockpit.read',
  'cookie.list',
  'design-token.read',
  'health.read',
  'health.ready',
  'login.page', // 登录页本来就是给还没登录的人看的
  'market.export',
  'market.page', // 页面兜底：谁来都回同一个前端外壳（登录门开着时它在前面先挡）
  'setting.read',
  'skill.list',
  'skill.role-packs',
  'sop-run.active',
  'sop-run.file-download',
  'sop-run.file-refs',
  'sop-run.file-upload',
  'sop-run.files',
  // 保存一步、完成（sop-run.save、finish）不列：放不放行看 run 的写凭据，路由声明了「状态码不代表授权」（#554）
  'sop-run.list',
  'sop-run.read',
  'sop-run.start',
  'sop-run.upgrade-preflight',
  'sop.list',
  'sop.timeline',
  'sso.callback',
  'stats.read',
  'summary.read',
  'task-center.list',
  'task-center.policy',
  'task-center.template',
  'type.list',
  'workbench.list',
  'workbench.read',
];

export const BUILTINS: readonly BuiltinIdentity[] = [
  {
    // 管理口令照系统管理员加管理层算（系统和业务的读、写、管理类，就是今天口令能做的）；决定类里今天能做的六个登记为「代属主行事」（存量差异清单 D）
    name: 'admin-token', label: '管理口令（应急管理员）', roles: ['admin', 'management'],
    actions: [],
    actsForOwner: [
      'attention.answer',
      'change-request.approve',
      'change-request.reject',
      'mcp.access-approve',
      'mcp.access-reject',
      // 放行一次被扣住的投递：协调方定为决定类，管理口令今天能做，照搬登记成代属主行事（L11 #31，并入 L4）
      'workbench-event.release',
      // 事项的「全部」视角、看任何一件的详情：管理层的拍板类动作；管理口令今天看得到全部，照搬登记成代属主行事
      'work-items.view-all',
    ],
  },
  {
    // 本机命令行：过写请求总门的普通写、开放读面、主体与授予的管理面；各路由自己的管理门不认它的照样不列（存量差异清单 A2）
    name: 'local-cli', label: '本机命令行',
    actions: [
      'admin-token.first-set',
      'admin-token.state',
      'admin.whoami',
      'agent-card.read',
      'app-data.download',
      'app-data.files',
      'app-data.list',
      'app-data.submit',
      'app-data.upload',
      'app.delete',
      'app.list',
      'app.page',
      'app.read',
      'app.rollback',
      'app.sync',
      'attention.read',
      'auth.me',
      'cockpit.create',
      'cockpit.delete',
      'cockpit.list',
      'cockpit.read',
      'cockpit.update',
      'cookie.create',
      'cookie.delete',
      'cookie.list',
      'department.delete',
      'department.list',
      'department.member-add',
      'department.member-remove',
      'department.membership',
      'department.read',
      'department.upsert',
      'access.red-lines',
      'principal.access',
      'setup.wizard-approve',
      'setup.wizard-read',
      'setup.wizard-run',
      'relation.proposal-approve',
      'relation.proposal-list',
      'relation.proposal-reject',
      'team.assign',
      'team.claim',
      'team.lead-add',
      'team.lead-remove',
      'team.list',
      'team.mine',
      'team.reassign',
      'team.release',
      'team.unassign',
      'design-token.read',
      'grant.approve',
      'grant.create',
      'grant.list',
      'grant.read',
      'grant.revoke',
      'grant.revoke-migration',
      'grant.submit',
      'health.read',
      'health.ready',
      'judgment.report',
      // 经验库的同步状态：运维信息、不带条目内容，属主在本机看（没接入时原因只在这里）
      'knowledge.sync-status',
      'login.begin',
      'login.page',
      'market.export',
      'market.page',
      'principal.bind',
      'principal.bind-batch',
      'principal.disable',
      'principal.list',
      'principal.list-pending',
      'principal.reconcile',
      'principal.restore',
      'principal.unbind',
      'role.approve',
      'role.copy',
      'role.delete',
      'role.export',
      'role.list',
      'role.matrix',
      'role.update',
      'setting.read',
      'setting.update',
      'skill.download',
      'skill.export',
      'skill.list',
      'skill.role-packs',
      'skill.verify',
      'skill.versions',
      'sop-run.active',
      'sop-run.assign',
      'sop-run.file-download',
      'sop-run.file-refs',
      'sop-run.file-upload',
      'sop-run.files',
      'sop-run.finish',
      'sop-run.list',
      'sop-run.read',
      'sop-run.save',
      'sop-run.start',
      'sop-run.upgrade',
      'sop-run.upgrade-preflight',
      'sop.deprecate',
      'sop.list',
      'sop.publish',
      'sop.timeline',
      'sso.callback',
      'stats.read',
      'summary.read',
      'task-center.list',
      'task-center.policy',
      'task-center.read',
      'task-center.template',
      'type.create',
      'type.delete',
      'type.list',
      'type.update',
      'workbench.check',
      'workbench.check-all',
      'workbench.delete',
      'workbench.list',
      'workbench.read',
      // 工作台变量：本机命令行五条都能做（读写任意台、看留痕，常量的兜底维护也只认它）
      'workbench.vars-audit',
      'workbench.vars-delete',
      'workbench.vars-list',
      'workbench.vars-read',
      'workbench.vars-set',
    ],
    actsForOwner: [],
  },
  {
    // 本机页面：匿名能做的它都能做（回环直连的浏览器不比远程的少），另加还没设过口令时的首次设置（存量差异清单 C 的例外）。
    // 由匿名的清单推出来，不另抄一份，防两份漂移
    name: 'local-page', label: '本机页面（回环直连的浏览器）',
    actions: [...new Set([...ANONYMOUS_ACTIONS, 'admin-token.first-set'])].sort(),
    actsForOwner: [],
  },
  {
    // 匿名：登录门关着时今天开放的读面和匿名提交面（登录门开着时它在判定之前先挡，存量差异清单 C）
    name: 'anonymous', label: '匿名（登录门关着时）',
    actions: ANONYMOUS_ACTIONS,
    actsForOwner: [],
  },
];

export const builtin = (name: BuiltinName): BuiltinIdentity => BUILTINS.find((b) => b.name === name)!;

/**
 * 比角色和清单更严的动作：只有列出的这几种身份能做，别的哪怕有覆盖它的授予（比如迁移出来的 admin）、照管理员角色算，也拒绝。
 * owner 是有范围 * 的属主授予的主体；person 是任何启用的人（主体的 kind 是 person；停用的在第一步就拒了）；其余是内置身份的名字。
 * 进快照（surfaces/actions.json 的 builtins.narrowed）
 */
export type NarrowedAction = { action: string; only: readonly ('owner' | 'person' | BuiltinName)[]; why: string };
export const NARROWED: readonly NarrowedAction[] = [
  { action: 'content.observation', only: ['admin-token'], why: '门户观测状态今天只认管理口令，身份来源的管理员、本机命令行都不认（存量差异清单 E）' },
  { action: 'grant.revoke-migration', only: ['owner', 'local-cli'], why: '整批撤销迁移出来的授予只有属主能做（本机命令行在授予管理面上算属主），比管理员严' },
  { action: 'setup.wizard-approve', only: ['owner', 'local-cli'], why: '首次安装向导这一批只有属主能放行（本机命令行在授予管理面上算属主），比管理员严' },
  { action: 'role.approve', only: ['owner', 'local-cli'], why: '带管理类或决定类权限的自定义角色只有属主能放行（本机命令行在授予管理面上算属主），比管理员严' },
  { action: 'work-items.create', only: ['person'], why: '「安排一件事」只认人：建立人就是提需求的本人。任何启用的人都能安排（不靠角色给写权限）；管理口令、本机命令行、席位都不是人，一律不能' },
];
export const narrowed = (action: string): NarrowedAction | undefined => NARROWED.find((n) => n.action === action);

/** 启动时核对：列的动作都在动作清单里。返回不在的（空数组就是都在） */
export function unknownBuiltinActions(known: (action: string) => boolean): string[] {
  const out: string[] = [];
  for (const b of BUILTINS) for (const a of [...b.actions, ...b.actsForOwner]) if (!known(a)) out.push(`${b.name}: ${a}`);
  for (const n of NARROWED) if (!known(n.action)) out.push(`narrowed: ${n.action}`);
  for (const a of Object.keys(ASKED)) if (!known(a)) out.push(`asked: ${a}`);
  for (const a of SELF_DECIDED) if (!known(a)) out.push(`self-decided: ${a}`);
  return out;
}

/**
 * 问统一判定时用的类别，和路由登记的类别不一样的动作；以及哪些动作还按部门问（scopedVerdict）。
 *   global：问 judge 时用的类别（全公司那一档）；dept：按部门问 scopedVerdict 时用的类别，null 是不按部门问。
 * 路由（数据视图的台、经验库）放行时照这里取类别；scopedVerdict 只认 dept 不是 null 的动作、而且类别要对得上；
 * 「谁能做什么」的矩阵也照这里推（roles.ts 的 roleMatrix）——三处用同一份，矩阵和判定不会各说各的。
 * 不在这里的动作：问 judge 用登记的类别，不按部门问。进快照（surfaces/actions.json 的 builtins.asked），改它要过评审
 */
export const ASKED: Readonly<Record<string, { global: Kind; dept: Kind | null }>> = {
  // 数据视图的台：读和写是同一道门，都按「能不能写」问（普通员工的预设带着全部业务域的「看」，按「看」放行等于全公司可读）；
  // 登记、批 MCP 授予、批申请按部门问「拍板」；改绑、关联只有全公司那一档
  'bench-store.bench-list': { global: 'write', dept: 'write' },
  'bench-store.bench-create': { global: 'write', dept: 'decide' },
  'bench-store.bench-bind': { global: 'decide', dept: null },
  'bench-store.bench-link': { global: 'write', dept: null },
  'bench-store.dataset-define': { global: 'write', dept: 'write' },
  'bench-store.dataset-list': { global: 'write', dept: 'write' },
  'bench-store.rows-write': { global: 'write', dept: 'write' },
  'bench-store.query': { global: 'write', dept: 'write' },
  'bench-store.form-submit': { global: 'write', dept: 'write' },
  'bench-store.render': { global: 'write', dept: 'write' },
  'bench-store.snapshot-list': { global: 'write', dept: 'write' },
  'bench-store.snapshot-take': { global: 'write', dept: 'write' },
  'bench-store.snapshot-restore': { global: 'write', dept: 'write' },
  'bench-store.view-get': { global: 'write', dept: 'write' },
  'bench-store.view-put': { global: 'write', dept: 'write' },
  'bench-store.view-versions': { global: 'write', dept: 'write' },
  'bench-store.view-diff': { global: 'write', dept: 'write' },
  'bench-store.view-rollback': { global: 'write', dept: 'write' },
  'bench-store.log-list': { global: 'write', dept: 'write' },
  'bench-store.mcp-list': { global: 'write', dept: 'write' },
  'bench-store.mcp-grant': { global: 'decide', dept: 'decide' },
  'bench-store.mcp-decide': { global: 'decide', dept: 'decide' },
  // 经验库：部门级的条目按这个部门问「看」（services/knowledge.ts 的 visibility）
  'knowledge.read': { global: 'read', dept: 'read' },
};
/** 问 judge 用的类别：登记了就用登记的，没登记用路由的类别 */
export const askedKind = (action: string, declared: Kind): Kind => ASKED[action]?.global ?? declared;
/** 按部门问 scopedVerdict 用的类别；不按部门问的动作是 null */
export const deptKind = (action: string): Kind | null => ASKED[action]?.dept ?? null;

/**
 * 按关系对自己的事拍板的动作：不经授予，路由按「是不是建立人、是不是写信的那个人」判（routes/work-items.ts）。
 * 矩阵里普通员工「拍板·只限自己的」只算这几个（普通员工预设那条范围 self 的决定类权限就是在说它们）；别的动作上那条权限不起作用。
 * 进快照，改它要过评审
 */
export const SELF_DECIDED: readonly string[] = ['work-items.accept', 'work-items.asks-answer'];

/**
 * 「暂不切」（阶段六 6d）：判定切换的开关里写了这个域，这几个动作仍然按旧守卫。每条写原因；
 * 进快照（surfaces/actions.json 的 builtins.notSwitched），改它要过评审。现在一条都没有。
 */
export const NOT_SWITCHED: readonly { action: string; why: string }[] = [];

/**
 * 有副作用的读（阶段六 6d）：GET、HEAD 上类别是读或管理的动作，处理函数却会写东西或外呼。判定切换时按写的口径在处理之前拒，不走「让旧处理函数照跑」的读路径。
 * 进快照（surfaces/actions.json 的 builtins.readWithSideEffects），新增的读接口有副作用的要登记在这里。
 */
export const READ_WITH_SIDE_EFFECTS: readonly { action: string; why: string }[] = [
  { action: 'app.page', why: '冷版本经 LayerFS 服务回读文件（外呼）' },
  { action: 'grant.list', why: '列之前先把到期的授予标成过期（写）' },
  { action: 'judgment.report', why: '读报告之前先把攒着的比对记录写进比对库' },
  { action: 'sop-run.files', why: '列文件时给还没算过的文件懒补 sha256 并写回' },
];
