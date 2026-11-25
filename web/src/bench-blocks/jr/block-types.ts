/** 十二种块的类型名（与 server/src/bench-views.ts 的 BLOCK_TYPES 一致）。运行时注册表只要名字，不带 schema。 */
export const BLOCK_TYPE_LIST = ["filter-bar","stat","table","records","bar","line","pie","progress","form","dag","gantt","flow"] as const;
