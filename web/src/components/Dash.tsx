/** 看板的 12 列栅格（PATTERNS.md §6）：数据视图（bench-blocks）把块放在里面，块的宽度只取 3 / 4 / 6 / 12。
 *  原来总览用的四类卡片（指标、列表、趋势、状态）和卡片外框随旧总览一起删了（属主 2026-11-11：旧版页面弃用）；
 *  数据视图的块有自己的外框（bench-blocks/Frame.tsx），样式类名沿用 .wm-dash-card。 */
import type { ReactNode } from 'react';

export function DashGrid({ children }: { children: ReactNode }) {
  return <div className="wm-dash-grid">{children}</div>;
}
