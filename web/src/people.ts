/** 「谁」的显示规则（全站共用一处）。席位只有一种画法（协调 2026-11-12：卡片头、时间线、列表、详情都一样）：
 *    名字——事项上的「名字 · 句柄」取名字；只有句柄时查名册；名册里也没有就写「一位 AI 员工」。句柄（<区>/<编号>）不露给人。
 *    seatLabel 和 seatNameOnly 是同一个函数的两个名字（老调用点不用改）。
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

/** 名册里也查不到名字的席位怎么说（不露句柄） */
export const UNNAMED_SEAT = '一位 AI 员工';
/** 像不像一个席位句柄（<区>/<编号>，例如 dsh/98b94be9）：像的不直接给人看。画布团队（<区>/canvas/<名字>）有三段，不算 */
export const looksLikeHandle = (s: string): boolean => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test((s || '').trim());

/** 席位：服务端给「名字 · 句柄」或只有句柄；只写名字（见文件头）。roster：句柄 → 名字（rosterNames 给的） */
export function seatLabel(seat: string, roster: Record<string, string> = {}): string {
  return seatNameOnly(seat, roster);
}

/** 日志行的「谁」：去掉 receiver:/human:/user:/seat: 这类前缀；receiver:<区> 是对端席位，有承接就用承接的名字；系统来源换成人话 */
const SOURCE: Record<string, string> = { market: '市场', attention: '关注', 'admin-token': '管理员', admin: '管理员', seed: '系统' };
export function actorLabel(raw: unknown, seat: string): string {
  const s = who(raw);
  if (!s) return '';
  if (/^receiver:/.test(s)) return seat ? seatLabel(seat) : UNNAMED_SEAT;
  if (SOURCE[s]) return SOURCE[s];
  const bare = s.replace(/^(human|user|seat|mcp):/, '');
  // 句柄（席位、对端节点）不露给人
  return looksLikeHandle(bare) ? UNNAMED_SEAT : bare;
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

/** 系统来源的中文名（卡片第一行「谁在等」用） */
const SYSTEM_WHO: Record<string, string> = { 'task-center': '任务中心', tasks: '任务中心', sop: 'SOP', market: '市场', attention: '关注', admin: '管理员', 'admin-token': '管理员', seed: '系统', system: '系统' };
/** 卡片第一行的「谁」：给人看「谁的事」，不露主体键、外部身份和来源代号。
 *  · 认得的人（和条目带的 creator 是同一个主体）写显示名；别的人写「一位同事」；
 *  · 外部账号（<提供方>:<外部号>）写「一个外部账号」；AI 会话（mcp:<名字>）写「AI 会话「名字」」；
 *  · 系统来源写中文；画布团队写团队名；席位有名字写名字、只有句柄写「一位 AI 员工」；对端地址写「一个对端节点」 */
export function waitingLabel(raw: string, opts: { seat?: string; people?: { principal?: string | null; display_name?: string | null }[]; name?: string | null } = {}): string {
  // 服务端给了名字（「关注」条目的 waiting_for_name，#657）就用它：它从来不是内部键本身；给的是 null 才按下面退化
  if (typeof opts.name === 'string' && opts.name.trim()) return opts.name.trim();
  const s = (raw || '').trim();
  if (!s) return '';
  for (const p of opts.people ?? []) if (p?.principal && p.principal === s) return (p.display_name || '').trim() || '一位同事';
  if (/^receiver:/.test(s)) return opts.seat ? waitingLabel(opts.seat) : '对方团队';
  if (/^(person|user|human):/.test(s)) return '一位同事';
  const mcp = /^mcp:(.+)$/.exec(s);
  if (mcp) return `AI 会话「${mcp[1]}」`;
  if (Object.hasOwn(SYSTEM_WHO, s)) return SYSTEM_WHO[s];
  if (/^https?:\/\//i.test(s)) return '一个对端节点';
  const k = s.lastIndexOf(' · ');
  if (k > 0) return s.slice(0, k);
  if (/^[^/\s]+\/canvas\/.+$/.test(s)) return teamLabel(s);
  if (/^[a-z0-9-]+\/[0-9a-f]{8}$/i.test(s)) return '一位 AI 员工';
  if (/^[a-z][a-z0-9_-]*:/i.test(s)) return '一个外部账号';
  return s;
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

/** 席位只写名字：事项上是「名字 · 句柄」取名字；只有句柄时查名册；查不到就写「一位 AI 员工」，不露句柄 */
export function seatNameOnly(seat: string, roster: Record<string, string> = {}): string {
  const s = (seat || '').trim();
  if (!s || s === '-') return '';
  const k = s.lastIndexOf(' · ');
  if (k > 0) return s.slice(0, k).trim() || UNNAMED_SEAT;
  if (Object.hasOwn(roster, s) && roster[s]) return roster[s];
  return looksLikeHandle(s) ? UNNAMED_SEAT : s;
}

/** 列表行里的「谁」（说话人）：来源标记 receiver:<区> 有承接席位就是它，没有就不写；
 *  画布团队（<区>/canvas/<名字>）只写团队名；席位查名册只写名字；别的去掉来源前缀 */
export function speakerName(actor: string, seat: string, roster: Record<string, string> = {}): string {
  const a = (actor || '').trim();
  if (!a) return '';
  if (/^receiver:/.test(a)) return seat ? seatNameOnly(seat, roster) : '';
  // 句柄先查名册（查到了写名字），查不到再按 actorLabel 说成「一位 AI 员工」
  const bare = a.replace(/^(human|user|seat|mcp):/, '');
  if (Object.hasOwn(roster, bare) && roster[bare]) return roster[bare];
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

/** 几个成员的说法：按不同的席位数人（不是按名字——两个查不到名字的成员是两个人）；有名字的列名字，没名字的合成「N 位 AI 员工」。
 *  返回 { n, text }：n 是不同席位的个数，text 是「小采、一位 AI 员工」这样；全都没名字时 text 是空串（只说几个成员） */
export function membersText(seats: string[], label: (s: string) => string = (s) => seatNameOnly(s)): { n: number; text: string } {
  const distinct = [...new Set(seats.map((s) => (s || '').trim()).filter((s) => s && s !== '-'))];
  const labels = distinct.map(label);
  const named = [...new Set(labels.filter((l) => l && l !== UNNAMED_SEAT))];
  const unnamed = labels.filter((l) => !l || l === UNNAMED_SEAT).length;
  if (!named.length) return { n: distinct.length, text: '' };
  const parts = [...named, ...(unnamed === 1 ? [UNNAMED_SEAT] : unnamed > 1 ? [`${unnamed} 位 AI 员工`] : [])];
  return { n: distinct.length, text: parts.join('、') };
}
