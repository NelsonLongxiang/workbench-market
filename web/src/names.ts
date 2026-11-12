/** 把代号换成名字的纯函数（不碰 React、不引别的文件，单测由 Node 直接加载）：
 *  席位句柄 → 名册里的名字（GET /api/a2a/teams）；线和阶段的代号 → 生命周期里的名字（GET /api/lifecycle/…）。
 *  名字只当显示用；查不到名字时不把代号露给人（线写「未命名的线」，阶段不写），席位才退回显示句柄。 */

/** 节点报的名字有时自带「 (98b94be9)」这样的句柄后缀，去掉 */
export const cleanSeatName = (name: string): string => (name || '').replace(/\s*[（(][0-9a-f]{6,}[)）]\s*$/i, '').trim();

/** 名册拍平成「句柄 → 名字」；形状不对的项跳过，没有名字的不收 */
export function rosterNames(teams: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(teams)) return out;
  for (const t of teams) {
    const seats = t && typeof t === 'object' && Array.isArray((t as { seats?: unknown }).seats) ? (t as { seats: unknown[] }).seats : [];
    for (const x of seats) {
      const o = x as { seat?: unknown; name?: unknown } | null;
      if (o && typeof o.seat === 'string' && typeof o.name === 'string' && cleanSeatName(o.name)) out[o.seat] = cleanSeatName(o.name);
    }
  }
  return out;
}

/** 事项上的席位只有句柄时，补上名册里的名字，写成服务端「名字 · 句柄」的样子（页面再按各自的规则显示）；
 *  已经带名字的、名册里查不到的原样返回 */
export function withRoster(seat: string, roster: Record<string, string>): string {
  const s = (seat || '').trim();
  if (!s || s.includes(' · ')) return s;
  return roster[s] ? `${roster[s]} · ${s}` : s;
}

export type Names = { objects: Record<string, string>; stages: Record<string, string> };
export const NO_NAMES: Names = { objects: {}, stages: {} };
export const UNNAMED_LINE = '未命名的线';
export const lineName = (id: string | null | undefined, names: Names = NO_NAMES): string => (id ? names.objects[id] || UNNAMED_LINE : '');
export const stageName = (code: string | null | undefined, names: Names = NO_NAMES): string => (code ? names.stages[code] || '' : '');

/** 把生命周期的阶段码表和对象列表拍平成名字表；形状不对的项跳过，没有名字的不收 */
export function lifecycleNames(types: unknown, objects: unknown): Names {
  const out: Names = { objects: {}, stages: {} };
  for (const t of Array.isArray(types) ? types : []) {
    const st = t && typeof t === 'object' && Array.isArray((t as { stages?: unknown }).stages) ? (t as { stages: unknown[] }).stages : [];
    for (const x of st) { const o = x as { code?: unknown; name?: unknown } | null; if (o && typeof o.code === 'string' && typeof o.name === 'string' && o.name.trim()) out.stages[o.code] = o.name.trim(); }
  }
  for (const x of Array.isArray(objects) ? objects : []) { const o = x as { id?: unknown; name?: unknown } | null; if (o && typeof o.id === 'string' && typeof o.name === 'string' && o.name.trim()) out.objects[o.id] = o.name.trim(); }
  return out;
}
