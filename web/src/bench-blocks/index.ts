/** 数据视图组件：统计卡、表格、柱、线、饼、进度、筛选栏、表单。数据视图页和驾驶舱共用，只依赖设计 token，不依赖外壳。 */
export { BlockFrame, type BlockFrameProps, type BlockSpan } from './Frame';
export { StatBlock, type StatBlockProps } from './Stat';
export { ProgressBlock, type ProgressBlockProps } from './Progress';
export { TableBlock, type TableBlockProps } from './Table';
export { BarBlock, LineBlock, PieBlock, type BarBlockProps, type LineBlockProps, type PieBlockProps } from './Chart';
export { FilterBar, type FilterBarProps, type FilterField } from './FilterBar';
export { FormBlock, type FormBlockProps, type FormField } from './Form';
export { BenchView, type BenchViewProps, type ViewResult } from './BenchView';
export type { BlockData, BlockColumn, BlockError, CellKind } from './blocks-view';
