/**
 * 角色声明（阶段六 6b）：角色和权限是声明，人写人审，改动走提交；谁有哪个角色是数据（授予，见 services/grant.ts）。
 *
 * 两层：
 *   · 平台四个内置角色，写死在这里，不能被覆盖：owner 属主、admin 管理员、member 成员、guest 访客。
 *   · 组织角色：仓库里带一份通用的初始集合（dept-member 部门成员、dept-lead 部门负责人）；
 *     配了外部声明文件（WM_ROLES_FILE，JSON）就以它为准，初始集合不再用。外部文件放在仓库外，由部署方维护。
 *
 * 一个角色：{ id, name, includes?: [角色 id], permissions: [{ actions?: [动作], kinds?: [类别], scope?: 范围 }] }
 *   · id 是 ASCII（小写字母开头，字母、数字、连字符）；name 是给人看的名字。
 *   · 权限按动作列，或者按类别（read、write、decide、admin）整类给；两样可以都写。
 *   · 范围通常不写，由授予给；写了的只能比授予更窄（授予时核对）。
 *
 * 范围的写法（库里和声明文件里都是 ASCII，中文只在界面和文档里）：
 *   *（全部）、domain:<名>（一个授权域）、bench:<slug>（一个台）、sop:<slug>、tool:<名>、self（仅本人创建的）、
 *   object:<不透明标识>（预留给观测层的对象或阶段范围：这里只存、只比相等，不解释含义）。
 *
 * 启动时校验，不合格拒绝启动：形状不对、id 重复、和平台角色同名（id 或名字）、includes 指向不存在的角色、
 * 角色循环包含、类别不认识、引用了不存在的动作、范围写法不对。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type Kind = 'read' | 'write' | 'decide' | 'admin';
export const KINDS: readonly Kind[] = ['read', 'write', 'decide', 'admin'];
export type Permission = { actions?: string[]; kinds?: Kind[]; scope?: string };
export type RoleDecl = { id: string; name: string; includes?: string[]; permissions: Permission[] };
/** 一个角色展开 includes 之后的全部权限 */
export type RoleView = RoleDecl & { platform: boolean; closure: Permission[]; adminLevel: boolean; decides: boolean };

const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,47}$|^[a-z][a-z0-9_]{0,63}$/; // <域>.<动词>，或 MCP 工具名
const SCOPE_RE = /^(\*|self|(domain|bench|sop|tool):[\x21-\x7e]{1,128}|object:[\x21-\x7e]{1,256})$/;

/** 平台内置角色：不能被外部声明覆盖 */
export const PLATFORM_ROLES: readonly RoleDecl[] = [
  { id: 'owner', name: '属主', permissions: [{ kinds: ['read', 'write', 'decide', 'admin'] }] },
  // 决定类只认人，不放进管理员的缺省权限：要决定权的由授予另加
  { id: 'admin', name: '管理员', permissions: [{ kinds: ['read', 'write', 'admin'] }] },
  { id: 'member', name: '成员', permissions: [{ kinds: ['read'] }] },
  // 访客只靠点名的资源范围授予
  { id: 'guest', name: '访客', permissions: [] },
];

/** 通用的组织角色初始集合（名字通用，不含业务）。部门是哪个，由授予的范围（domain:<部门>）给 */
export const INITIAL_ORG_ROLES: readonly RoleDecl[] = [
  { id: 'dept-member', name: '部门成员', permissions: [{ kinds: ['read', 'write'] }] },
  { id: 'dept-lead', name: '部门负责人', includes: ['dept-member'], permissions: [{ kinds: ['decide'] }] },
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

function checkShape(raw: unknown, where: string): RoleDecl {
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
    for (const k of Object.keys(q)) if (!['actions', 'kinds', 'scope'].includes(k)) fail(`${id} 的第 ${i + 1} 条权限有不认识的键 ${k}`);
    if (q.actions !== undefined && (!Array.isArray(q.actions) || q.actions.some((a) => typeof a !== 'string' || !ACTION_RE.test(a)))) fail(`${id} 的第 ${i + 1} 条权限的 actions 写法不对`);
    if (q.kinds !== undefined && (!Array.isArray(q.kinds) || q.kinds.some((k) => !(KINDS as readonly unknown[]).includes(k)))) fail(`${id} 的第 ${i + 1} 条权限的 kinds 只能是 ${KINDS.join('、')}`);
    if (!(q.actions as unknown[] | undefined)?.length && !(q.kinds as unknown[] | undefined)?.length) fail(`${id} 的第 ${i + 1} 条权限既没有 actions 也没有 kinds`);
    if (q.scope !== undefined && !scopeOk(q.scope)) fail(`${id} 的第 ${i + 1} 条权限的范围「${String(q.scope)}」写法不对`);
    return { ...(q.actions ? { actions: [...q.actions as string[]] } : {}), ...(q.kinds ? { kinds: [...q.kinds as Kind[]] } : {}), ...(q.scope !== undefined ? { scope: q.scope as string } : {}) };
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
export function buildRoles(orgRaw: readonly unknown[], catalog: ActionCatalog): Map<string, RoleView> {
  const platform = PLATFORM_ROLES.map((r) => checkShape(r, `平台角色 ${r.id}`));
  const org = orgRaw.map((r, i) => checkShape(r, `第 ${i + 1} 个组织角色`));
  const platformIds = new Set(platform.map((r) => r.id)), platformNames = new Set(platform.map((r) => r.name));
  const all = new Map<string, RoleDecl>();
  for (const r of platform) all.set(r.id, r);
  for (const r of org) {
    if (platformIds.has(r.id) || platformNames.has(r.name)) fail(`组织角色 ${r.id}（${r.name}）和平台内置角色同名，平台角色不能被覆盖`);
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
    views.set(r.id, { ...r, platform: platformIds.has(r.id), closure, adminLevel: r.id === 'owner' || r.id === 'admin' || kindsIn.has('admin'), decides: kindsIn.has('decide') });
  }
  return views;
}

/** 启动时读配置：WM_ROLES_FILE 设了就读外部文件，没设用初始集合。只读这一次 */
export function orgRolesFromConfig(env: NodeJS.ProcessEnv = process.env): { source: 'file' | 'initial'; roles: readonly unknown[] } {
  const path = env.WM_ROLES_FILE;
  if (path === undefined || path === '') return { source: 'initial', roles: INITIAL_ORG_ROLES };
  return { source: 'file', roles: readRolesFile(path) };
}
