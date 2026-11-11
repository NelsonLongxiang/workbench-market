/**
 * 内置身份（阶段六 6c）：不是人、不是主体表里的行，权限按动作逐条列出。列的就是旧守卫今天实际放行的那些，
 * 切换（6d）对外零差异；旧行为里不合理的地方登记在 docs/judgment-legacy-differences.md，以后单独立项改。
 * 这份清单进快照（surfaces/actions.json 的 builtins），改它要过评审。列的动作都要在动作清单里：快照导出时核对，对不上导出失败（CI 红）。
 *
 * 认身份的先后（judgment-compare.ts）：有效的管理口令 → 登录认出来的主体 → 本机命令行（回环直连、没有浏览器标记）
 * → 本机页面（回环直连、带浏览器标记）→ 匿名。
 */

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
  'cockpit.list',
  'cockpit.read',
  'cookie.list',
  'design-token.read',
  'health.read',
  'health.ready',
  'market.export',
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
    // 管理口令照系统管理员加管理层算（系统和业务的读、写、管理类，就是今天口令能做的）；决定类里今天能做的五个登记为「代属主行事」（存量差异清单 D）
    name: 'admin-token', label: '管理口令（应急管理员）', roles: ['admin', 'management'],
    actions: [],
    actsForOwner: [
      'attention.answer',
      'change-request.approve',
      'change-request.reject',
      'mcp.access-approve',
      'mcp.access-reject',
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
      'cockpit.create',
      'cockpit.delete',
      'cockpit.list',
      'cockpit.read',
      'cockpit.update',
      'cookie.create',
      'cookie.delete',
      'cookie.list',
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
      'login.begin',
      'market.export',
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
  { action: 'role.approve', only: ['owner', 'local-cli'], why: '带管理类或决定类权限的自定义角色只有属主能放行（本机命令行在授予管理面上算属主），比管理员严' },
  { action: 'work-items.create', only: ['person'], why: '「安排一件事」只认人：建立人就是提需求的本人。任何启用的人都能安排（不靠角色给写权限）；管理口令、本机命令行、席位都不是人，一律不能' },
];
export const narrowed = (action: string): NarrowedAction | undefined => NARROWED.find((n) => n.action === action);

/** 启动时核对：列的动作都在动作清单里。返回不在的（空数组就是都在） */
export function unknownBuiltinActions(known: (action: string) => boolean): string[] {
  const out: string[] = [];
  for (const b of BUILTINS) for (const a of [...b.actions, ...b.actsForOwner]) if (!known(a)) out.push(`${b.name}: ${a}`);
  for (const n of NARROWED) if (!known(n.action)) out.push(`narrowed: ${n.action}`);
  return out;
}
