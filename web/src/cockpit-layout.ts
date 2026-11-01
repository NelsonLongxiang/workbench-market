/** #320 驾驶舱布局吸附（PATTERNS.md §6）：面板宽度只取 3 / 4 / 6 / 12 列。
 *  已存布局按「读时迁移」处理：渲染前吸附，不回写；只有管理员真的拖动/缩放时才把吸附后的值存回去。
 *  任何面板都不丢、不改 i / workbenchId / kind / y / h。 */
export const COCKPIT_COLS = 12;
export const PANEL_WIDTHS = [3, 4, 6, 12] as const;

/** 取最近的一档；与两档等距时取较宽的（宁宽勿窄，内嵌页面更好用） */
export function snapW(w: number): number {
  const v = Number.isFinite(w) ? w : 6;
  let best: number = PANEL_WIDTHS[0];
  for (const c of PANEL_WIDTHS) if (Math.abs(c - v) <= Math.abs(best - v)) best = c;
  return best;
}

export function snapPanel<T extends { x: number; w: number }>(p: T, cols = COCKPIT_COLS): T {
  const w = snapW(p.w);
  const x = Math.min(Math.max(0, Number.isFinite(p.x) ? Math.round(p.x) : 0), cols - w);
  return w === p.w && x === p.x ? p : { ...p, w, x };
}

export function snapPanels<T extends { x: number; w: number }>(panels: T[], cols = COCKPIT_COLS): T[] {
  return panels.map((p) => snapPanel(p, cols));
}
