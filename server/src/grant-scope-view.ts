/** 授予的范围给人看的两样：授予列表、单条（routes/grants.ts）和本人的 /api/auth/me（index.ts 的 roles）用同一份，页面照它显示。 */
import { svc } from './context.ts';
import type { AreaService } from './services/area.ts';
import type { DepartmentService } from './services/department.ts';

export type ScopeEffect = 'all' | 'area' | 'dept' | 'none';
/** 范围给人看的两样（授予页照这个显示，以服务端判定为准）：
 *  scope_name：部门范围给部门名、领域范围给领域名（撤了的领域照样给名字，状态看 scope_effect 和领域本身）；读不到、别的范围给 null。
 *    能读到这条授予的人就能看到名字：授予本身已经露了部门、领域的标识，名字不多露什么。
 *  scope_effect：这个范围在判定里起不起作用（只看范围前缀，和授予状态无关；页面只在 status=active 时用）——
 *    'all' 范围是 *；'area' area:<x>，在这个领域上算数（areaVerdict 只认范围正好是它）；
 *    'dept' dept:<x>，只在数据视图的台和经验库里起作用（scopedVerdict）；'none' bench:、sop:、tool:、object:、self，统一判定还不认（遗留差异 L13）。
 *  口径由领域第 1 步的后端定（11-20）。 */
export function scopeView(scope: string): { scope_name: string | null; scope_effect: ScopeEffect } {
  const s = String(scope ?? '').trim();
  if (s === '*') return { scope_name: null, scope_effect: 'all' };
  const area = /^area:(.+)$/.exec(s);
  if (area) return { scope_name: svc<AreaService>('areas').get(area[1])?.name ?? null, scope_effect: 'area' };
  if (s.startsWith('dept:')) return { scope_name: svc<DepartmentService>('departments').scopeName(s), scope_effect: 'dept' };
  return { scope_name: null, scope_effect: 'none' };
}

