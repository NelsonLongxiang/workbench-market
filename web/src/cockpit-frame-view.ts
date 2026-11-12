/** 驾驶舱骨架的纯函数（不碰 React、不引别的文件，scripts/cockpit-frame-unit.mjs 直接测）。
 *  骨架照产品化原型的驾驶舱那一屏：上面一排「看的是…」和右边的操作；下面三栏——左、中（上下两块）、右，
 *  栏之间可以拖宽窄，每一块可以放大到占满、再还原。 */

/** 三栏的尺寸：左栏宽、右栏宽、中间下面那块的高（像素）；中间上面那块吃剩下的 */
export type Sizes = { left: number; right: number; bottom: number };
export const DEFAULT_SIZES: Sizes = { left: 300, right: 340, bottom: 260 };
const RANGE: Record<keyof Sizes, [number, number]> = { left: [220, 480], right: [260, 520], bottom: [140, 520] };

/** 尺寸夹在各自的范围里；不是数字的退回缺省 */
export function clampSizes(s: Partial<Record<keyof Sizes, unknown>> | null | undefined): Sizes {
  const out = { ...DEFAULT_SIZES };
  for (const k of Object.keys(RANGE) as (keyof Sizes)[]) {
    const v = s?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(Math.min(RANGE[k][1], Math.max(RANGE[k][0], v)));
  }
  return out;
}

/** 拖分隔条：left 往右拖变宽；right、bottom 的分隔条在它们的左边 / 上边，往右 / 往下拖是变窄 / 变矮 */
export function dragSizes(start: Sizes, which: keyof Sizes, dx: number, dy: number): Sizes {
  const next = { ...start };
  if (which === 'left') next.left = start.left + dx;
  else if (which === 'right') next.right = start.right - dx;
  else next.bottom = start.bottom - dy;
  return clampSizes(next);
}

/** 存在本机的尺寸（每个驾驶舱一份）：读坏了、形状不对都退回缺省 */
export function parseSizes(raw: string | null | undefined): Sizes {
  if (!raw) return { ...DEFAULT_SIZES };
  try { return clampSizes(JSON.parse(raw) as Partial<Sizes>); } catch { return { ...DEFAULT_SIZES }; }
}

/** 放大 / 还原：点已经放大的那一块就还原；点别的块换成放大那一块 */
export const toggleMax = (cur: string | null, id: string): string | null => (cur === id ? null : id);

/** 「看的是」那一排的胶囊：只列有值的；没有任何筛选时返回空（那一排就不写「看的是」） */
export type Ctx = { label: string; value: string };
export function ctxChips(fields: { name: string; label: string }[], value: Record<string, unknown> | null | undefined): Ctx[] {
  return fields.map((f) => ({ label: f.label, value: value?.[f.name] })).filter((c): c is Ctx => typeof c.value === 'string' && c.value.trim() !== '').map((c) => ({ label: c.label, value: c.value.trim() }));
}

/** 页签：当前选的不在列表里（页签变了）就落到第一个 */
export const activeTab = (tabs: { key: string }[], cur: string | null | undefined): string => (tabs.some((t) => t.key === cur) ? String(cur) : tabs[0]?.key ?? '');
