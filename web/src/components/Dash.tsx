/** 看板的 12 列栅格（PATTERNS.md §6）：数据视图（bench-blocks）把块放在里面，块的宽度只取 3 / 4 / 6 / 12。
 *  原来总览用的四类卡片（指标、列表、趋势、状态）和卡片外框随旧总览一起删了（属主 2026-11-11：旧版页面弃用）；
 *  数据视图的块有自己的外框（bench-blocks/Frame.tsx），样式类名沿用 .wm-dash-card。 */
import type { ReactNode } from 'react';

/** top：一行里的块各按自己的高度、顶端对齐（数据视图用：统计卡、进度卡不被同一行的图拉高）。缺省一行等高 */
export function DashGrid({ children, top }: { children: ReactNode; top?: boolean }) {
  return <div className={top ? 'wm-dash-grid wm-dash-grid-top' : 'wm-dash-grid'}>{children}</div>;
}
