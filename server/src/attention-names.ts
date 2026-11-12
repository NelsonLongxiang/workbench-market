/**
 * 「关注」条目上的显示名（汇总那一层统一补，不在各来源里各写一遍）：waiting_for_name、creator_name。
 *
 * 口径和关系提议列表的显示名一致，页面不露主体键：
 *   · 人（user:…，席位提问前面带 receiver: 的去掉前缀再认）：只给这个看的人本来就看得到的人的名字——
 *     管理员（口令、管理员登录）和本机命令行、本人、管理层（全公司的业务都看得到），以及和这个人同在一个部门（成员或负责人）的；
 *     别的给 null，页面退化成「一位同事」。停用的、不是人的、不存在的也给 null。
 *   · MCP 会话（mcp:<名字>）：类型加名字，名字就是键里本来有的，不多给信息。
 *   · 席位、对端、节点、来源方这些别的键：null，不给内部键以外的新信息。
 */
import { svc } from './context.ts';
import type { PrincipalService } from './services/principal.ts';
import type { DepartmentService } from './services/department.ts';
import type { GrantService } from './services/grant.ts';

/** 看的人：管理员（含本机命令行）、认出来的主体（没有为 null） */
export type NameViewer = { admin: boolean; principal: string | null };

/** 给一个看的人做一个取名函数：同一次汇总里，看的人的部门、是不是管理层只查一次 */
export function nameResolver(viewer: NameViewer): (key: string | null | undefined) => string | null {
  const principals = svc<PrincipalService>('principals'), departments = svc<DepartmentService>('departments'), grants = svc<GrantService>('grants');
  const wide = viewer.admin || (!!viewer.principal && grants.isBusinessSide(viewer.principal));
  const mine = new Set(viewer.principal ? departments.of(viewer.principal).map((d) => d.id) : []);
  const cache = new Map<string, string | null>();
  const person = (id: string): string | null => {
    const p = principals.get(id) as { kind?: string; status?: string; display_name?: string } | null;
    if (!p || p.kind !== 'person' || p.status !== 'active') return null;
    const sees = wide || id === viewer.principal || departments.of(id).some((d) => mine.has(d.id));
    return sees && p.display_name?.trim() ? p.display_name.trim() : null;
  };
  return (key) => {
    if (!key) return null;
    if (cache.has(key)) return cache.get(key)!;
    const k = key.startsWith('receiver:') ? key.slice('receiver:'.length) : key;
    const name = k.startsWith('user:') ? person(k) : k.startsWith('mcp:') && k.length > 4 ? `MCP 会话 ${k.slice(4)}` : null;
    cache.set(key, name);
    return name;
  };
}
