/** 「谁」的显示规则（全站共用一处）。席位有两种画法：
 *    · 短的 seatNameOnly——只写名字，列表、卡片这类一眼扫过的地方用；查不到名字才显示句柄；
 *    · 全的 seatLabel——「名字（句柄）」，事项详情这类要对上是哪个席位的地方用；没有名字显示句柄。
 *  去掉 receiver: / human: / user: / seat: 这类来源前缀；系统来源说人话；团队显示团队名。纯函数，不碰 React。 */

/** 对端给的「谁」：可能是字符串，也可能是 { seat, name, team, role } 这样的对象。取名字，没有名字取席位，都没有给空串；永远返回字符串，不把对象交给页面 */
export function who(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['name', 'seat', 'team', 'id']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
  }
  return '';
}

/** 席位：服务端给「名字 · 句柄」或只有句柄；显示成「名字（句柄）」 */
export function seatLabel(seat: string): string {
  const s = (seat || '').trim();
  const k = s.lastIndexOf(' · ');
  return k > 0 ? `${s.slice(0, k)}（${s.slice(k + 3)}）` : s;
}

/** 日志行的「谁」：去掉 receiver:/human:/user:/seat: 这类前缀；receiver:<区> 是对端席位，有承接就用承接的名字；系统来源换成人话 */
const SOURCE: Record<string, string> = { market: '市场', attention: '关注', 'admin-token': '管理员', admin: '管理员', seed: '系统' };
export function actorLabel(raw: unknown, seat: string): string {
  const s = who(raw);
  if (!s) return '';
  if (/^receiver:/.test(s)) return seat ? seatLabel(seat) : s.replace(/^receiver:/, '');
  if (SOURCE[s]) return SOURCE[s];
  return s.replace(/^(human|user|seat|mcp):/, '');
}

/** 团队：画布团队（<区>/canvas/<名字>）显示名字；进程团队（<区>/<编号>）没有名字，显示句柄 */
export function teamLabel(team: string): string {
  const t = (team || '').trim();
  const m = /^[^/]+\/canvas\/(.+)$/.exec(t);
  return m ? m[1] : t;
}

/** 卡片上的「谁」：一个字段里可能是席位、来源标记或团队句柄；先按席位 / 来源规则，再把团队句柄换成团队名 */
export function cleanWho(s: string, seat = ''): string {
  return teamLabel(actorLabel(s, seat));
}

/** 节点报的名字有时自带「 (0a1b2c3d)」这样的句柄后缀：列表里只要名字，去掉 */
export const cleanSeatName = (name: string): string => (name || '').replace(/\s*[（(][0-9a-f]{6,}[)）]\s*$/i, '').trim();

/** 名册（GET /api/a2a/teams）拍平成「句柄 → 名字」；形状不对的项跳过，没有名字的不收 */
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

/** 席位的短画法——只写名字（列表、卡片用；句柄在详情里才带，那里用 seatLabel）：事项上是「名字 · 句柄」取名字；只有句柄时查名册，查不到才显示句柄 */
export function seatNameOnly(seat: string, roster: Record<string, string> = {}): string {
  const s = (seat || '').trim();
  if (!s || s === '-') return '';
  const k = s.lastIndexOf(' · ');
  if (k > 0) return s.slice(0, k);
  return Object.hasOwn(roster, s) ? roster[s] : s;
}

/** 列表行里的「谁」（说话人）：来源标记 receiver:<区> 有承接席位就是它，没有就不写；
 *  画布团队（<区>/canvas/<名字>）只写团队名；席位查名册只写名字；别的去掉来源前缀 */
export function speakerName(actor: string, seat: string, roster: Record<string, string> = {}): string {
  const a = (actor || '').trim();
  if (!a) return '';
  if (/^receiver:/.test(a)) return seat ? seatNameOnly(seat, roster) : '';
  const p = actorLabel(a, '');
  const team = /^[^/\s]+\/canvas\/(.+)$/.exec(p);
  return team ? team[1] : seatNameOnly(p, roster);
}

/** 人的名字：有显示名用显示名，没有就去掉标识的前缀（user:zhang → zhang）。用户卡、建立人、审核人都用它 */
export function personLabel(p: { principal?: unknown; display_name?: unknown } | null | undefined): string {
  if (!p) return '';
  const name = typeof p.display_name === 'string' ? p.display_name.trim() : '';
  return name || (typeof p.principal === 'string' ? p.principal.replace(/^[a-z]+:/, '') : '');
}
