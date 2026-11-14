/** 驾驶舱右栏「AI 员工」的纯函数（不碰 React、不引别的文件，scripts/ai-staff-ui-unit.mjs 直接测）。
 *  数据：GET /api/teams/mine 的 members（分给我的成员）；负责人另从 GET /api/teams 里挑出自己负责的团队的成员。
 *  卡上写「手上在办 N 件」——那是这个成员一共多忙（active_items 按席位数），不叫「你的」；
 *  点进去是事项列表「我的 AI 员工手上的」视角按这个席位筛，那里只算你交给它的（协调裁定 2026-11-12）。 */

export type StaffCard = { key: string; seat: string; seat_id: string; name: string; team: string; online: boolean; active: number; initial: string };
export type LedTeam = { key: string; name: string; members: StaffCard[] };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 名字自带的「 (0a1b2c3d)」句柄后缀去掉（同 people.ts / names.ts 的写法） */
const clean = (name: string): string => name.replace(/\s*[（(][0-9a-f]{6,}[)）]\s*$/i, '').trim();
/** 团队显示名：画布团队（<区>/canvas/<名字>）写名字，别的照原样；服务端给了名字就用它 */
const teamName = (team: string, given = ''): string => given.trim() || (/^[^/]+\/canvas\/(.+)$/.exec(team)?.[1] ?? team);

/** 一个成员 → 卡。没名字用句柄；头像是名字的第一个字 */
export function staffCard(m: unknown, team = '', given = ''): StaffCard | null {
  const o = obj(m);
  if (!o || !str(o.seat)) return null;
  const seat = str(o.seat);
  const name = clean(str(o.name)) || seat;
  const active = typeof o.active_items === 'number' && Number.isFinite(o.active_items) && o.active_items > 0 ? Math.floor(o.active_items) : 0;
  return { key: `${seat}#${str(o.seat_id)}`, seat, seat_id: str(o.seat_id), name, team: teamName(str(o.team) || team, str(o.team_name) || given), online: o.online === true, active, initial: Array.from(name)[0] ?? '?' };
}

/** 分给我的成员（/api/teams/mine 的 members） */
export function myStaff(mine: unknown): StaffCard[] {
  return list(obj(mine)?.members).map((m) => staffCard(m)).filter((c): c is StaffCard => !!c);
}

/** 我负责的团队和它们的成员：/api/teams 里 leads 有我（principal）的团队；分给我的成员在上面那组已经有了，这里不再重复 */
export function ledTeams(teams: unknown, me: string, mineKeys: Set<string> = new Set()): LedTeam[] {
  if (!me) return [];
  const out: LedTeam[] = [];
  for (const d of list(obj(teams)?.departments)) {
    for (const t of list(obj(d)?.teams)) {
      const o = obj(t);
      if (!o || !list(o.leads).some((l) => str(obj(l)?.principal) === me)) continue;
      const team = str(o.team);
      const members = list(o.members).map((m) => staffCard(m, team, str(o.name))).filter((c): c is StaffCard => !!c && !mineKeys.has(c.key));
      out.push({ key: `${str(o.host)}/${team}`, name: teamName(team, str(o.name)), members });
    }
  }
  return out;
}

/** 卡上的忙闲：这个成员一共多忙，不是「你交给它的」 */
export const busyText = (active: number): string => (active > 0 ? `手上在办 ${active} 件` : '手上没有在办的');

/** 点卡去哪：事项列表「我的 AI 员工手上的」视角，按席位筛（有 seat_id 用它，没有用句柄） */
export function staffLink(c: Pick<StaffCard, 'seat' | 'seat_id'>): string {
  return `/work-items?${new URLSearchParams({ view: 'seats', seat: c.seat_id || c.seat })}`;
}
