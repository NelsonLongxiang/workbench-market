/** 全景首页的纯函数：不碰 React，scripts/home-ui-unit.mjs 直接测。
 *  数据：GET /api/lifecycle/stages（阶段码表与显示名）、/api/lifecycle/objects（每条线走到哪一步），
 *  格子上「等你定」的件数来自市场自己的「关注」（按条目的 object、phase 对到格子），不来自生命周期。 */
import type { AttentionItem } from './attention-view';

export type LcStage = { code: string; name: string; order: number; terminal: boolean; lane?: string };
export type LcType = { type: string; name: string; panorama_row: boolean; lane?: string; parent_type: string | null; stages: LcStage[]; flags: { code: string; name: string }[] };
export type LcObject = { id: string; type: string; name: string | null; stage: string; since: string | null; days: number | null; lane?: string; parents: string[]; flags: string[] };

/** 进全景的行：只有 panorama_row 为真的类型（产品线）；部门对象挂在产品下面，不单独成行 */
export function panoramaType(types: LcType[]): LcType | null {
  return types.find((t) => t.panorama_row) ?? null;
}

/** 全景的列：这一类的非终态阶段，按 order 排。终态（退市、取消这类）不成列，在行上标出来 */
export function stageColumns(t: LcType): LcStage[] {
  return [...t.stages].filter((s) => !s.terminal).sort((a, b) => a.order - b.order);
}

/** 对象的显示名：name 现在多为 null，先显示 id（去掉回放批次前缀之外不做任何改写） */
export const objectLabel = (o: Pick<LcObject, 'id' | 'name'>): string => (o.name && o.name.trim()) || o.id;

export type Cell = { stage: string; state: 'past' | 'current' | 'future'; pending: number };
export type Row = { id: string; label: string; stage: string; stageName: string; terminal: boolean; days: number | null; flags: string[]; cells: Cell[]; pending: number };

/** 一条线一行：现在的阶段之前「已走完」、就是这一步「走到这一步」、之后「—」。
 *  已经结束的线（终态：退市、取消这类）不知道停在哪一步——取消可能发生在开发中——所以格子不标「已走完」，一律「—」，行上标终态名 */
export function buildRows(t: LcType, objects: LcObject[], attention: AttentionItem[]): Row[] {
  const cols = stageColumns(t);
  const byCode = new Map(t.stages.map((s) => [s.code, s]));
  const flagName = new Map(t.flags.map((f) => [f.code, f.name]));
  return objects.filter((o) => o.type === t.type).map((o) => {
    const cur = byCode.get(o.stage);
    const terminal = !!cur?.terminal;
    const cells: Cell[] = cols.map((c) => {
      const pending = attention.filter((a) => a.object === o.id && a.phase === c.code).length;
      const state: Cell['state'] = !cur || terminal ? 'future' : c.code === o.stage ? 'current' : c.order < cur.order ? 'past' : 'future';
      return { stage: c.code, state, pending };
    });
    return {
      id: o.id, label: objectLabel(o), stage: o.stage, stageName: cur?.name ?? o.stage, terminal, days: o.days,
      flags: o.flags.map((f) => flagName.get(f) ?? f), cells, pending: cells.reduce((n, c) => n + c.pending, 0),
    };
  });
}

/** 进行中的线进表；已经结束的线（终态）收到表底下「已结束 N 条」，只写名字和结束原因（协调裁定） */
export function splitRows(rows: Row[]): { active: Row[]; ended: Row[] } {
  return { active: rows.filter((r) => !r.terminal), ended: rows.filter((r) => r.terminal) };
}

/** 天数：null（直接播种、没有业务时间）显示「未知」 */
export const daysLabel = (d: number | null): string => (d === null || d === undefined ? '天数未知' : `已 ${d} 天`);

/** 一句总结：几条线在走（只数进行中的）、几件等你拍板（「关注」里给你的条数）；有待定的格子时指一句「红色标出来的格子」 */
export function summaryLine(rows: Row[], pendingTotal: number, elsewhere = 0): string {
  const going = rows.filter((r) => !r.terminal).length;
  const spots = rows.reduce((n, r) => n + r.cells.filter((c) => c.pending > 0).length, 0);
  const head = `公司现在有 ${going} 条线在走，`;
  return `${head}${decideLine(pendingTotal, elsewhere, spots > 0)}`;
}

/** 等你拍板的那半句：只数能当场办的；要到别处处理的另说一句（协调裁定）。全景表读不到时页面单用这一句 */
export function decideLine(now: number, elsewhere: number, redCells = false): string {
  const more = elsewhere > 0 ? `另有 ${elsewhere} 件要到别处处理。` : '';
  if (!now) return elsewhere > 0 ? `眼下没有要你当场拍板的，${more}` : '眼下没有要你拍板的。';
  return `有 ${now} 件等你拍板${redCells ? '——红色标出来的格子就是' : ''}。${more}`;
}

/** 席位提问卡的标题是「<团队> 问：<问题>（可选：a / b）」：拆成问题本身和选项；不是这个样子的原样返回、没有选项 */
export function splitAskTitle(title: string): { question: string; options: string[] } {
  let q = (title || '').replace(/^\S+ 问：/, '');
  let options: string[] = [];
  const m = /（可选：([^（）]*)）$/.exec(q);
  if (m) { options = m[1].split(' / ').map((x) => x.trim()).filter(Boolean); q = q.slice(0, m.index); }
  return { question: q.trim(), options };
}

/** 「你」只给这件事本来该找的人：答复、验收找建立人。「关注」只把自己的事项给非管理员看，所以非管理员看到的就是自己的；
 *  管理员看到的是替建立人代办（卡片不知道建立人的名字，写「建立人」） */
export function cardWording(category: string, admin: boolean): { label: string; proxy: boolean } {
  const proxy = admin && (category === 'ask' || category === 'accept');
  const LABEL: Record<string, [string, string]> = { ask: ['在问你', '在问建立人'], accept: ['等你验收', '等建立人验收'], glance: ['等你过目', '等你过目'], review: ['等你审核', '等你审核'], grant: ['待你核准', '待你核准'] };
  const l = LABEL[category];
  // 不认识的类别（服务端以后会加：卡住的事、团队待认领、负责人缺位……）先写中性的「等你处理」，不把代号露出来（规范 14 第十节）
  return { label: l ? l[proxy ? 1 : 0] : '等你处理', proxy };
}

/** 问候：按本地时间段 */
export function greeting(hour: number, name: string | null): string {
  const part = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  return name ? `${part}，${name}。` : `${part}。`;
}

/** 点了一格就只看这条线这一步的事；再点同一格回到全部 */
export type Focus = { object: string; stage: string } | null;
export const toggleFocus = (cur: Focus, next: { object: string; stage: string }): Focus =>
  cur && cur.object === next.object && cur.stage === next.stage ? null : next;
export function filterAttention(items: AttentionItem[], focus: Focus): AttentionItem[] {
  return focus ? items.filter((a) => a.object === focus.object && a.phase === focus.stage) : items;
}
