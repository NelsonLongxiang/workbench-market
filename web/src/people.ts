/** 「谁」的显示规则（事项详情页和全景卡片共用一处）：席位显示「名字（句柄）」，没有名字显示句柄；
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
