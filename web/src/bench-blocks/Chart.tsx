/**
 * 柱、线、饼。图表库用到时才加载（echarts-lite.ts）；颜色、字体、线条全部取设计 token（chart-option.ts）。
 * 系列最多 5 个，再多的并成「其他」并在图下说明。点图上的一格，把它对应的那几行数据交给调用方（onSelect）——
 * 驾驶舱用它做下钻和预填。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DESIGN_TOKENS as T } from '../design-tokens';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { MAX_SERIES, toSeries, toSlices } from './blocks-view';
import { cartesianOption, pieOption, type ChartTokens } from './chart-option';

type Row = Record<string, unknown>;
const TOKENS: ChartTokens = {
  // 系列的颜色只有 token 里这几种。危险色排最后：它本来的意思是「出问题了」，只有分到第五个系列才用上
  series: [T.colors.primary, T.colors.success, T.colors.warning, T.colors['text-secondary'], T.colors.danger],
  muted: T.colors['border-strong'], text: T.colors.text, textSecondary: T.colors['text-secondary'], border: T.colors.border, surface: T.colors.surface,
  fontFamily: T.typography['family-sans'], fontSize: parseInt(T.typography.caption.fontSize, 10),
};

type Picked = { name?: string; seriesName?: string; dataIndex?: number };
type Option = Record<string, unknown>;
function Canvas({ option, onPick, label }: { option: Option; onPick?: (p: Picked) => void; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<{ setOption: (o: Option, notMerge?: boolean) => void; resize: () => void; dispose: () => void; on: (e: string, f: (p: Picked) => void) => void; off: (e: string) => void } | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false, ro: ResizeObserver | null = null;
    import('./echarts-lite').then(({ default: echarts }) => {
      if (gone || !el.current) return;
      const c = echarts.init(el.current);
      chart.current = c as never;
      c.setOption(option, true);
      c.on('click', (p) => pick.current?.(p as Picked));
      ro = new ResizeObserver(() => c.resize());
      ro.observe(el.current);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null; };
    // 只在挂上去的时候建一次；配置变了走下面那个 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { chart.current?.setOption(option, true); }, [option]);
  if (failed) return <div className="wm-bb-truncated">图表没能加载出来，刷新页面再试。</div>;
  return <div ref={el} className={`wm-bb-canvas${onPick ? ' wm-bb-canvas-click' : ''}`} role="img" aria-label={label} />;
}

const mergedNote = <div className="wm-bb-truncated">分得太细了，只画了前 {MAX_SERIES - 1} 个，其余并在「其他」里。</div>;

interface CartesianProps extends BlockFrameProps {
  x: string; y: string | string[]; series?: string;
  /** 点了某个类目（柱或点）：给出这个类目对应的那几行 */
  onSelect?: (rows: Row[], category: string) => void;
}
function Cartesian({ kind, x, y, series, onSelect, flags, ...frame }: CartesianProps & { kind: 'bar' | 'line'; flags: { stacked?: boolean; horizontal?: boolean; area?: boolean } }) {
  const m = useMemo(() => toSeries(frame.data, x, y, series), [frame.data, x, y, series]);
  const option = useMemo(() => cartesianOption(kind, m, TOKENS, flags), [kind, m, flags.stacked, flags.horizontal, flags.area]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = `${typeof frame.title === 'string' ? frame.title : '图表'}：${m.categories.map((c, i) => `${c} ${m.series.map((s) => `${s.name} ${s.values[i] ?? '无'}`).join('，')}`).join('；')}`;
  return (
    <BlockFrame {...frame} kind={kind}>
      <Canvas option={option} label={label} onPick={onSelect ? (p) => { const i = m.categories.indexOf(String(p.name)); if (i >= 0) onSelect(m.rowsAt[i], m.categories[i]); } : undefined} />
      {m.merged ? mergedNote : null}
    </BlockFrame>
  );
}

export interface BarBlockProps extends CartesianProps { stacked?: boolean; horizontal?: boolean }
export function BarBlock({ stacked, horizontal, ...p }: BarBlockProps) { return <Cartesian {...p} kind="bar" flags={{ stacked, horizontal }} />; }

export interface LineBlockProps extends CartesianProps { area?: boolean }
export function LineBlock({ area, ...p }: LineBlockProps) { return <Cartesian {...p} kind="line" flags={{ area }} />; }

export interface PieBlockProps extends BlockFrameProps {
  label: string; value: string; donut?: boolean;
  onSelect?: (rows: Row[], name: string) => void;
}
export function PieBlock({ label, value, donut, onSelect, ...frame }: PieBlockProps) {
  const m = useMemo(() => toSlices(frame.data, label, value), [frame.data, label, value]);
  const option = useMemo(() => pieOption(m.slices, TOKENS, { donut, merged: m.merged }), [m, donut]);
  const aria = `${typeof frame.title === 'string' ? frame.title : '占比'}：${m.slices.map((s) => `${s.name} ${s.value}`).join('；')}`;
  return (
    <BlockFrame {...frame} kind="pie" data={m.slices.length ? frame.data : null}>
      <Canvas option={option} label={aria} onPick={onSelect ? (p) => { const s = m.slices.find((z) => z.name === p.name); if (s) onSelect(s.rows, s.name); } : undefined} />
      {m.merged ? mergedNote : null}
    </BlockFrame>
  );
}
