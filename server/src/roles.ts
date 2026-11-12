/**
 * 角色声明（阶段六 6b）：角色和权限是声明，人写人审，改动走提交；谁有哪个角色是数据（授予，见 services/grant.ts）。
 *
 * 两层：
 *   · 平台的七个内置预设，写死在这里，不能被覆盖、不能改（要调整就复制成自定义角色，见 services/custom-role.ts）：
 *     owner 属主、admin 系统管理员、management 管理层、dept-lead 部门负责人、member 普通员工、guest 访客、ai-staff AI 员工。
 *     id 沿用阶段六 6b 的（admin、member、dept-lead 只改了显示名或升为内置），已有的授予不用动。
 *   · 组织角色：仓库里带一份通用的初始集合（dept-member 部门成员）；
 *     配了外部声明文件（WM_ROLES_FILE，JSON）就以它为准，初始集合不再用。外部文件放在仓库外，由部署方维护。
 *
 * 一个角色：{ id, name, includes?: [角色 id], permissions: [{ actions?: [动作], kinds?: [类别], domains?: [动作的域], scope?: 范围 }] }
 *   · id 是 ASCII（小写字母开头，字母、数字、连字符）；name 是给人看的名字。
 *   · 权限按动作列，或者按类别（read、write、decide、admin）整类给；两样可以都写。
 *   · domains 把按类别给的那部分圈在这几个动作的域里（动作名点号前面那段；MCP 工具名都算 mcp-tool 域）。
 *     域分两张清单：SYSTEM_DOMAINS（系统）和 BUSINESS_DOMAINS（业务），每个已登记动作的域都要在其中一张里，
 *     两边都不算的导出快照时报错。系统管理员只有系统域的读写——新长出来的域默认是业务，系统管理员默认看不到。
 *   · 范围通常不写，由授予给；写了的只能比授予更窄（授予时核对）。
 *
 * 范围的写法（库里和声明文件里都是 ASCII，中文只在界面和文档里）：
 *   *（全部）、domain:<名>（一个授权域，即动作名的域）、dept:<部门标识>（一个部门，标识见部门表）、bench:<slug>（一个台）、sop:<slug>、tool:<名>、self（仅本人创建的）、
 *   object:<不透明标识>（预留给观测层的对象或阶段范围：这里只存、只比相等，不解释含义）。
 *
 * 启动时校验，不合格拒绝启动：形状不对、id 重复、和平台角色同名（id 或名字）、includes 指向不存在的角色、
 * 角色循环包含、类别不认识、引用了不存在的动作、范围写法不对。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type Kind = 'read' | 'write' | 'decide' | 'admin';
export const KINDS: readonly Kind[] = ['read', 'write', 'decide', 'admin'];
export type Permission = { actions?: string[]; kinds?: Kind[]; domains?: string[]; scope?: string };
export type RoleDecl = { id: string; name: string; includes?: string[]; permissions: Permission[] };
/** 一个角色展开 includes 之后的全部权限 */
export type RoleView = RoleDecl & {
  platform: boolean; custom: boolean; closure: Permission[]; adminLevel: boolean; decides: boolean;
  /** 带业务域的写（整类给的写碰业务域，或按动作给了普通员工那几个之外的业务写）：授予要业务侧放行，见 approvalOf */
  businessWrite: boolean;
  /** 带业务域的拍板（只对自己的事拍板的不算）：授予要属主放行，见 approvalOf */
  businessDecide: boolean;
};

const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,47}$|^[a-z][a-z0-9_]{0,63}$/; // <域>.<动词>，或 MCP 工具名
const SCOPE_RE = /^(\*|self|(domain|bench|sop|tool):[\x21-\x7e]{1,128}|dept:[a-z][a-z0-9-]{0,47}|object:[\x21-\x7e]{1,256})$/;

/**
 * 动作的域：系统那几块（人、角色、授予、设置、MCP 网关、工作台登记、连接、登录……）。进快照（surfaces/actions.json 的 domains），改它要过评审。
 * 不在这里的都算业务——新长出来的域默认是业务，系统管理员默认看不到
 */
export const SYSTEM_DOMAINS: readonly string[] = [
  'a2a', 'a2a-peer', 'access', 'admin', 'admin-token', 'agent-card', 'app', 'auth', 'binding', 'content', 'cookie', 'department',
  'design-token', 'grant', 'health', 'judgment', 'login', 'market', 'mcp', 'principal', 'relation', 'remote-allow', 'role', 'setting', 'setup',
  'skill', 'sso', 'stats', 'team', 'type', 'workbench',
];
/** 明确算业务的域。和 SYSTEM_DOMAINS 一起要盖住全部已登记动作的域（扩展的动作另算，都是业务） */
export const BUSINESS_DOMAINS: readonly string[] = [
  'app-data', 'attention', 'change-request', 'cockpit', 'mcp-rest', 'mcp-tool', 'sop', 'sop-run', 'summary', 'task-center', 'tasks', 'work-item', 'work-items',
  // 工作台事件（派单投递的列表、详情、放行、接单回写）：和任务中心、事项同属派活，算业务
  'workbench-event',
  // 视图台的数据（数据集、视图描述、取数、表单）：台里的业务数据，系统管理员缺省看不到
  'bench-store',
];
/** 动作的域：点号前面那段；MCP 工具名（没有点）都算 mcp-tool */
export const domainOf = (action: string): string => (action.includes('.') ? action.slice(0, action.indexOf('.')) : 'mcp-tool');
/** 已登记的动作里，域两边都不算的（导出快照时用；空数组就是都分好了） */
/**
 * 这组权限碰不碰业务：按动作写的看动作的域（不在系统域清单里的都算业务，扩展和清单外新长出来的域也算）；
 * 按类别给的，没圈域就是全部域（当然含业务），圈了域的看其中有没有不在系统域清单里的。
 * 自定义角色碰了业务，建、改都要属主放行：系统管理员缺省看不到业务数据，也不能自己造一个角色把它转给别人。
 */
export function touchesBusiness(perms: readonly Permission[]): boolean {
  const system = new Set(SYSTEM_DOMAINS);
  return perms.some((p) => (p.actions ?? []).some((a) => !system.has(domainOf(a)))
    || ((p.kinds?.length ?? 0) > 0 && (p.domains === undefined || p.domains.some((d) => !system.has(d)))));
}

/**
 * 这组权限带不带业务域的写：整类给的写，没圈域（就是全部域）或圈的域里有业务域；或者按动作给了业务域的写动作，
 * 普通员工那几个（提需求、补充说明）除外——普通员工、访客这类日常开人的授予不因此多一道放行。
 */
export function writesBusiness(perms: readonly Permission[], catalog: ActionCatalog): boolean {
  const system = new Set(SYSTEM_DOMAINS);
  return perms.some((p) => ((p.kinds ?? []).includes('write') && (p.domains === undefined || p.domains.some((d) => !system.has(d))))
    || (p.actions ?? []).some((a) => catalog.get(a) === 'write' && !system.has(domainOf(a)) && !MEMBER_WRITE_ACTIONS.includes(a)));
}

/**
 * 这组权限带不带业务域的拍板：整类给的决定，没圈域或圈的域里有业务域；或者按动作给了业务域的决定动作。
 * 范围是 self 的（普通员工对自己提的事验收、答复）不算。
 */
export function decidesBusiness(perms: readonly Permission[], catalog: ActionCatalog): boolean {
  const system = new Set(SYSTEM_DOMAINS);
  return perms.some((p) => p.scope !== 'self' && (((p.kinds ?? []).includes('decide') && (p.domains === undefined || p.domains.some((d) => !system.has(d))))
    || (p.actions ?? []).some((a) => catalog.get(a) === 'decide' && !system.has(domainOf(a)))));
}

/**
 * 业务侧：全公司范围的写和决定都有（权限没圈域、没圈范围）——管理层、属主是；只有系统管理员的不是。按权限认，不按角色名。
 * 调用方只拿范围是 * 的生效授予的角色来问。
 */
export function isBusinessSide(perms: readonly Permission[]): boolean {
  const open = perms.filter((p) => p.domains === undefined && (p.scope === undefined || p.scope === '*'));
  return open.some((p) => (p.kinds ?? []).includes('write')) && open.some((p) => (p.kinds ?? []).includes('decide'));
}

/**
 * 一条授予谁能放行，三档（说法给页面原样显示）：
 *   · owner：管理员级的（属主、系统管理员、带管理类的），或带业务拍板的（管理层、部门负责人，范围不论）——要属主；
 *   · business：带业务写、不带业务拍板的（部门成员、AI 员工这类）——要业务侧（管理层或属主）；
 *   · admin：只带业务读、或不碰业务的（普通员工、访客、只碰系统域的）——管理员即可，日常开人一步完成。
 * 第二、三档的放行人要是认出来的人（或本机命令行，见 services/grant.ts）；管理口令不算数。
 */
export type Approval = 'owner' | 'business' | 'admin';
export const APPROVAL_TEXT: Readonly<Record<Approval, string>> = {
  owner: '只有属主能放行', business: '要管理层或属主放行', admin: '管理员即可放行',
};
export const approvalOf = (v: Pick<RoleView, 'adminLevel' | 'businessWrite' | 'businessDecide'>): Approval =>
  (v.adminLevel || v.businessDecide ? 'owner' : v.businessWrite ? 'business' : 'admin');

export function unclassifiedDomains(actions: Iterable<string>): string[] {
  const known = new Set([...SYSTEM_DOMAINS, ...BUSINESS_DOMAINS]);
  return [...new Set([...actions].map(domainOf))].filter((d) => !known.has(d)).sort();
}

/**
 * 界面上的七大块（「谁能做什么」的角色矩阵按它分行）：每个动作的域归且只归一块，每块里的域要么全是系统的、要么全是业务的。
 * 矩阵由服务端从角色定义算（roleMatrix），前端不自己拼
 */
export const BLOCKS: readonly { key: string; name: string; domains: readonly string[] }[] = [
  { key: 'overview', name: '全景', domains: ['cockpit', 'summary'] },
  { key: 'work', name: '事项与对话', domains: ['change-request', 'sop', 'sop-run', 'task-center', 'tasks', 'work-item', 'work-items', 'workbench-event'] },
  { key: 'attention', name: '关注', domains: ['attention'] },
  { key: 'bench-data', name: '工作台数据', domains: ['app-data', 'bench-store', 'mcp-rest', 'mcp-tool'] },
  { key: 'team', name: '团队与 AI 员工', domains: ['binding', 'department', 'principal', 'relation', 'team'] },
  { key: 'access', name: '权限与角色', domains: ['access', 'admin', 'admin-token', 'grant', 'judgment', 'role', 'setup'] },
  { key: 'system', name: '系统与节点', domains: ['a2a', 'a2a-peer', 'agent-card', 'app', 'auth', 'content', 'cookie', 'design-token', 'health', 'login', 'market', 'mcp', 'remote-allow', 'setting', 'skill', 'sso', 'stats', 'type', 'workbench'] },
];
export const MATRIX_KINDS: readonly { key: Kind; name: string }[] = [
  { key: 'read', name: '看' }, { key: 'write', name: '做' }, { key: 'decide', name: '拍板' }, { key: 'admin', name: '管理' },
];
/** 格子：all 全部；scoped 范围内（范围由授予给）；some 部分动作；self 只限自己的；none 不能；na 这一块没有这一类动作 */
export type Cell = 'all' | 'scoped' | 'some' | 'self' | 'none' | 'na';
const RANK: Record<Cell, number> = { na: -1, none: 0, self: 1, some: 2, scoped: 3, all: 4 };
/** 范围由授予给的预设：部门负责人、AI 员工、访客（矩阵里显示「范围内」） */
export const SCOPED_PRESETS: readonly string[] = ['dept-lead', 'ai-staff', 'guest'];

/** 一个角色（展开之后的权限）在七大块 × 四类上的格子 */
export function roleMatrix(roleId: string, closure: readonly Permission[], catalog: ActionCatalog): Record<string, Record<Kind, Cell>> {
  const out: Record<string, Record<Kind, Cell>> = {};
  for (const b of BLOCKS) {
    const row = { read: 'none', write: 'none', decide: 'none', admin: 'none' } as Record<Kind, Cell>;
    // 这一块里有哪几类动作（按动作清单）：没有的那一类格子是 na，不说能不能
    const present = new Set<Kind>();
    for (const [a, k] of catalog) if (b.domains.includes(domainOf(a))) present.add(k);
    for (const p of closure) {
      const wide: Cell = p.scope === 'self' ? 'self' : (p.scope !== undefined && p.scope !== '*') || SCOPED_PRESETS.includes(roleId) ? 'scoped' : 'all';
      for (const k of p.kinds ?? []) {
        if (p.domains && !p.domains.some((d) => b.domains.includes(d))) continue;
        if (RANK[wide] > RANK[row[k]]) row[k] = wide;
      }
      for (const a of p.actions ?? []) {
        const k = catalog.get(a);
        if (!k || !b.domains.includes(domainOf(a))) continue;
        const cell: Cell = wide === 'all' ? 'some' : wide;
        if (RANK[cell] > RANK[row[k]]) row[k] = cell;
      }
    }
    for (const k of KINDS) if (!present.has(k)) row[k] = 'na';
    out[b.key] = row;
  }
  return out;
}

/** 卡片上的四句白话：能看什么、能做什么、能拍什么板、不能做什么（从格子生成） */
export function matrixSummary(cells: Record<string, Record<Kind, Cell>>): { see: string; do: string; decide: string; cannot: string } {
  const WORD: Record<Cell, string> = { all: '全部', scoped: '范围内', some: '部分', self: '只限自己的', none: '', na: '' };
  const has = (c: Cell) => c !== 'none' && c !== 'na';
  const line = (k: Kind) => {
    const parts = BLOCKS.filter((b) => has(cells[b.key][k])).map((b) => `${b.name}（${WORD[cells[b.key][k]]}）`);
    return parts.length ? parts.join('、') : '无';
  };
  const cannot = MATRIX_KINDS.filter((k) => BLOCKS.every((b) => !has(cells[b.key][k.key]))).map((k) => k.name);
  const noBlocks = BLOCKS.filter((b) => MATRIX_KINDS.every((k) => !has(cells[b.key][k.key]))).map((b) => b.name);
  return {
    see: `能看：${line('read')}`,
    do: `能做：${line('write')}；能管：${line('admin')}`,
    decide: `能拍板：${line('decide')}`,
    cannot: [cannot.length ? `一律不能${cannot.join('、')}` : '', noBlocks.length ? `碰不到${noBlocks.join('、')}` : ''].filter(Boolean).join('；') || '没有整块碰不到的',
  };
}

/** 普通员工能写的：提需求、补充说明——开建 run、保存一步、完成、交附件，往台里提交数据和文件 */
export const MEMBER_WRITE_ACTIONS: readonly string[] = [
  'app-data.submit', 'app-data.upload', 'sop-run.file-refs', 'sop-run.file-upload', 'sop-run.finish', 'sop-run.save', 'sop-run.start',
];

/**
 * 平台的七个内置预设：不能被外部声明覆盖，不能改，只能复制成自定义角色。
 * 这些定义在阶段六切换（6d）之前不生效：放不放行照旧由各处的旧守卫决定，判定只算结论、和旧的比
 */
export const PLATFORM_ROLES: readonly RoleDecl[] = [
  { id: 'owner', name: '属主', permissions: [{ kinds: ['read', 'write', 'decide', 'admin'] }] },
  // 系统管理员：系统域的读写管；各处的「管理」类动作（台的切版本、删数据这类）也给；业务数据的读写没有；不拍业务的板
  { id: 'admin', name: '系统管理员', permissions: [{ kinds: ['read', 'write', 'admin'], domains: [...SYSTEM_DOMAINS] }, { kinds: ['admin'] }] },
  // 管理层：全公司的读、写、决定；不管系统
  // 驾驶舱的建、改、删是「管理」类（别的读写角色不会顺带拿到），只在这里点名给管理层（统筹 2026-11-12；cockpit-access.ts）
  { id: 'management', name: '管理层', permissions: [{ kinds: ['read', 'write', 'decide'] }, { actions: ['cockpit.create', 'cockpit.update', 'cockpit.delete'] }] },
  // 部门负责人：读、写、决定，部门是哪个由授予的范围（dept:<部门标识>）给，标识是部门表里的
  { id: 'dept-lead', name: '部门负责人', permissions: [{ kinds: ['read', 'write', 'decide'] }] },
  // 普通员工：看；写只给提需求、补充说明那几个；决定只给自己的事（验收、答复自己提的）
  { id: 'member', name: '普通员工', permissions: [{ kinds: ['read'] }, { actions: [...MEMBER_WRITE_ACTIONS] }, { kinds: ['decide'], scope: 'self' }] },
  // 访客只靠点名的资源范围授予，而且授予必须有期限（services/grant.ts）
  { id: 'guest', name: '访客', permissions: [] },
  // AI 员工：只授予非人主体（席位），读写范围由授予给（责任范围）；决定类永远不给（决定只认人）
  { id: 'ai-staff', name: 'AI 员工', permissions: [{ kinds: ['read', 'write'] }] },
];

/** 只能授予非人主体的预设、只能授予人的预设 */
export const NON_PERSON_ONLY_ROLES: readonly string[] = ['ai-staff'];
/** 访客：授予必须有期限 */
export const EXPIRY_REQUIRED_ROLES: readonly string[] = ['guest'];

/** 通用的组织角色初始集合（名字通用，不含业务）。部门是哪个，由授予的范围（dept:<部门标识>）给；部门标识就是部门表里的标识 */
export const INITIAL_ORG_ROLES: readonly RoleDecl[] = [
  { id: 'dept-member', name: '部门成员', permissions: [{ kinds: ['read', 'write'] }] },
];

/** 范围的写法对不对 */
export const scopeOk = (s: unknown): s is string => typeof s === 'string' && SCOPE_RE.test(s);

/** 权限里的范围 inner 是否在授予的范围 outer 之内（不写、self 总在之内；其余只有 * 包含一切，别的只认相等） */
export function scopeWithin(inner: string | undefined, outer: string): boolean {
  return inner === undefined || inner === 'self' || outer === '*' || inner === outer;
}

/** 动作清单：动作名到类别。校验「引用了不存在的动作」和判断管理员级、决定类时用 */
export type ActionCatalog = Map<string, Kind>;

function fail(msg: string): never { throw new Error(`角色声明：${msg}`); }

export function checkShape(raw: unknown, where: string): RoleDecl {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${where} 不是对象`);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['id', 'name', 'includes', 'permissions'].includes(k)) fail(`${where} 有不认识的键 ${k}`);
  if (typeof r.id !== 'string' || !ROLE_ID_RE.test(r.id)) fail(`${where} 的 id「${String(r.id)}」不对：小写字母开头，字母、数字、连字符`);
  const id = r.id;
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 64 || /[\x00-\x1f\x7f]/.test(r.name)) fail(`${id} 的 name 要是 1～64 个字符的文字`);
  if (r.includes !== undefined && (!Array.isArray(r.includes) || r.includes.some((x) => typeof x !== 'string' || !ROLE_ID_RE.test(x)))) fail(`${id} 的 includes 要是角色 id 的数组`);
  if (!Array.isArray(r.permissions)) fail(`${id} 的 permissions 要是数组`);
  const permissions = (r.permissions as unknown[]).map((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail(`${id} 的第 ${i + 1} 条权限不是对象`);
    const q = p as Record<string, unknown>;
    for (const k of Object.keys(q)) if (!['actions', 'kinds', 'domains', 'scope'].includes(k)) fail(`${id} 的第 ${i + 1} 条权限有不认识的键 ${k}`);
    if (q.domains !== undefined && (!Array.isArray(q.domains) || q.domains.length === 0 || q.domains.some((d) => typeof d !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(d)))) fail(`${id} 的第 ${i + 1} 条权限的 domains 要是动作域的数组`);
    if (q.domains !== undefined && !(q.kinds as unknown[] | undefined)?.length) fail(`${id} 的第 ${i + 1} 条权限写了 domains，要和 kinds 一起用（圈的是按类别给的那部分）`);
    if (q.actions !== undefined && (!Array.isArray(q.actions) || q.actions.some((a) => typeof a !== 'string' || !ACTION_RE.test(a)))) fail(`${id} 的第 ${i + 1} 条权限的 actions 写法不对`);
    if (q.kinds !== undefined && (!Array.isArray(q.kinds) || q.kinds.some((k) => !(KINDS as readonly unknown[]).includes(k)))) fail(`${id} 的第 ${i + 1} 条权限的 kinds 只能是 ${KINDS.join('、')}`);
    if (!(q.actions as unknown[] | undefined)?.length && !(q.kinds as unknown[] | undefined)?.length) fail(`${id} 的第 ${i + 1} 条权限既没有 actions 也没有 kinds`);
    if (q.scope !== undefined && !scopeOk(q.scope)) fail(`${id} 的第 ${i + 1} 条权限的范围「${String(q.scope)}」写法不对`);
    return { ...(q.actions ? { actions: [...q.actions as string[]] } : {}), ...(q.kinds ? { kinds: [...q.kinds as Kind[]] } : {}), ...(q.domains ? { domains: [...q.domains as string[]] } : {}), ...(q.scope !== undefined ? { scope: q.scope as string } : {}) };
  });
  return { id, name: r.name, ...(r.includes ? { includes: [...r.includes as string[]] } : {}), permissions };
}

/** 读外部声明文件：{ "roles": [ … ] }。路径要绝对，文件要在、要是合法 JSON */
export function readRolesFile(path: string): unknown[] {
  if (!isAbsolute(path)) fail(`WM_ROLES_FILE 要是绝对路径：${path}`);
  if (!existsSync(path)) fail(`WM_ROLES_FILE 指向的文件不存在：${path}`);
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`WM_ROLES_FILE 不是合法的 JSON：${(e as Error).message}`); }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { roles?: unknown }).roles)) fail('声明文件要是 { "roles": [ … ] }');
  for (const k of Object.keys(doc as object)) if (k !== 'roles') fail(`声明文件有不认识的键 ${k}`);
  return (doc as { roles: unknown[] }).roles;
}

/**
 * 校验并展开：平台角色 + 组织角色（外部的，或者初始集合）。任何一处不合格就抛错（调用方拒绝启动）。
 * catalog 给了就核对引用的动作都在里面，并据此判断管理员级、决定类（按动作的类别）。
 */
export function buildRoles(orgRaw: readonly unknown[], catalog: ActionCatalog, customIds: ReadonlySet<string> = new Set()): Map<string, RoleView> {
  const platform = PLATFORM_ROLES.map((r) => checkShape(r, `平台角色 ${r.id}`));
  const org = orgRaw.map((r, i) => checkShape(r, `第 ${i + 1} 个组织角色`));
  const platformIds = new Set(platform.map((r) => r.id)), platformNames = new Set(platform.map((r) => r.name));
  const all = new Map<string, RoleDecl>();
  for (const r of platform) all.set(r.id, r);
  for (const r of org) {
    if (platformIds.has(r.id) || platformNames.has(r.name)) {
      fail(`组织角色 ${r.id}（${r.name}）和平台内置预设同名（内置预设的 id：${[...platformIds].join('、')}；名字：${[...platformNames].join('、')}），平台的预设不能被覆盖。`
        + `改法：在声明文件（WM_ROLES_FILE）里把这个角色改个 id 和名字，或者删掉它改用内置预设（存量授予引用的是 id，改了 id 要同时迁授予）`);
    }
    if (all.has(r.id)) fail(`角色 id 重复：${r.id}`);
    all.set(r.id, r);
  }
  for (const r of all.values()) {
    for (const inc of r.includes ?? []) if (!all.has(inc)) fail(`${r.id} 包含的角色 ${inc} 不存在`);
    for (const p of r.permissions) for (const a of p.actions ?? []) if (!catalog.has(a)) fail(`${r.id} 引用的动作 ${a} 不存在`);
  }
  // 展开 includes，顺带查循环
  const closures = new Map<string, Permission[]>();
  const visiting = new Set<string>();
  const expand = (id: string, path: string[]): Permission[] => {
    const done = closures.get(id);
    if (done) return done;
    if (visiting.has(id)) fail(`角色循环包含：${[...path, id].join(' → ')}`);
    visiting.add(id);
    const r = all.get(id)!;
    const out = [...r.permissions];
    for (const inc of r.includes ?? []) out.push(...expand(inc, [...path, id]));
    visiting.delete(id);
    closures.set(id, out);
    return out;
  };
  const views = new Map<string, RoleView>();
  for (const r of all.values()) {
    const closure = expand(r.id, []);
    const kindsIn = new Set<Kind>();
    for (const p of closure) { for (const k of p.kinds ?? []) kindsIn.add(k); for (const a of p.actions ?? []) { const k = catalog.get(a); if (k) kindsIn.add(k); } }
    views.set(r.id, { ...r, platform: platformIds.has(r.id), custom: customIds.has(r.id), closure, adminLevel: r.id === 'owner' || r.id === 'admin' || kindsIn.has('admin'), decides: kindsIn.has('decide'), businessWrite: writesBusiness(closure, catalog), businessDecide: decidesBusiness(closure, catalog) });
  }
  return views;
}

/** 启动时读配置：WM_ROLES_FILE 设了就读外部文件，没设用初始集合。只读这一次 */
export function orgRolesFromConfig(env: NodeJS.ProcessEnv = process.env): { source: 'file' | 'initial'; roles: readonly unknown[] } {
  const path = env.WM_ROLES_FILE;
  if (path === undefined || path === '') return { source: 'initial', roles: INITIAL_ORG_ROLES };
  return { source: 'file', roles: readRolesFile(path) };
}
