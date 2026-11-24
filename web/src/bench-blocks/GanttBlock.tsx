/**
 * 甘特图 gantt（docs/task-graph-step1.md 第四节之二）：只读。数据由 AI 经 MCP 写进台的数据集，这里只画。
 * 核对、派生状态、摘要与任务图共用 task-graph.ts 的 buildGraph；横条的排法、每条怎么画、箭头怎么画也在 task-graph.ts（纯函数，单测直接测）。
 * 图用 ECharts custom 系列（echarts-lite.ts 按需加载）；颜色只取设计 token，不写内联样式。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Segmented, Table } from 'antd';
import { DESIGN_TOKENS as T } from '../design-tokens';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { FLASH_MS, diagnosticText, partialText } from './DagBlock';
import { applyGanttOption, buildGraph, changedNodes, ganttChartOption, ganttLayout, graphHighlight, graphTableRows, type GanttChart, type GanttChartOption, type GanttTokens, type GraphModel, type GraphSpec } from './task-graph';

export interface GanttBlockProps extends BlockFrameProps {
  spec: Omit<GraphSpec, 'kind'> & { start_col: string; end_col: string; detail_cols?: string[] };
  graphMeta?: { filtered?: boolean } | null;
}

const TOK: GanttTokens = { bar: T.colors.primary, done: T.colors.success, danger: T.colors.danger, track: T.colors['primary-subtle'], line: T.colors['border-strong'], marker: T.colors.text };
const FONT = parseInt(T.typography.caption.fontSize, 10);

type Picked = { seriesName?: string; dataIndex?: number };
function GanttCanvas({ option, idAt, onPick, onHover, label }: { option: GanttChartOption; idAt: (index: number) => string | null; onPick: (id: string) => void; onHover: (id: string | null) => void; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<(GanttChart & { resize: () => void; dispose: () => void }) | null>(null);
  const callbacks = useRef({ idAt, onPick, onHover, option });
  callbacks.current = { idAt, onPick, onHover, option };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false, ro: ResizeObserver | null = null;
    import('./echarts-lite').then(({ default: echarts }) => {
      if (gone || !el.current) return;
      const c = echarts.init(el.current);
      chart.current = c as never;
      applyGanttOption(c as never, callbacks.current.option);
      const barId = (p: unknown): string | null => { const d = p as Picked; return d.seriesName === 'bars' && typeof d.dataIndex === 'number' ? callbacks.current.idAt(d.dataIndex) : null; };
      c.on('click', (p) => { const id = barId(p); if (id !== null) callbacks.current.onPick(id); });
      c.on('mouseover', (p) => callbacks.current.onHover(barId(p)));
      c.on('mouseout', () => callbacks.current.onHover(null));
      c.on('globalout', () => callbacks.current.onHover(null));
      ro = new ResizeObserver(() => c.resize()); ro.observe(el.current);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 悬停、选中、闪烁、实时刷新都会换配置：整份替换，但纵向可视范围先从图表读回、按新条数夹好再写进去（applyGanttOption）
  useEffect(() => { if (chart.current) applyGanttOption(chart.current, option); }, [option]);
  if (failed) return <div className="wm-bb-truncated">图没能加载出来，刷新页面再试，或切到表格看。</div>;
  return <div ref={el} className="wm-gantt-canvas" role="img" aria-label={label} />;
}

export function GanttBlock({ spec, graphMeta, ...frame }: GanttBlockProps) {
  const rows = useMemo(() => (frame.data?.rows ?? []) as Record<string, unknown>[], [frame.data]);
  const model = useMemo(() => buildGraph(rows, { ...spec, kind: 'gantt' }, { filtered: !!graphMeta?.filtered, truncated: !!frame.data?.truncated }), [rows, spec, graphMeta, frame.data]);
  // 「今天」随每次取数更新（实时刷新时也跟着走）
  const now = useMemo(() => Date.now(), [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const lay = useMemo(() => ganttLayout(model, spec, now), [model, spec, now]);
  const [mode, setMode] = useState<'graph' | 'table'>('graph');
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<{ model: GraphModel; id: string } | null>(null);
  const [terminal, setTerminal] = useState<{ model: GraphModel; id: string } | null>(null);
  const pickNode = (id: string) => {
    const node = model.nodes.find((n) => n.id === id && !n.placeholder);
    if (!node) return;
    setOpen(id);
    setHover(null);
    setTerminal(node.role === 'end' || node.role === 'branch_end' ? { model, id } : null);
  };
  const hoveredId = mode === 'graph' && hover?.model === model ? hover.id : null;
  const terminalId = terminal?.model === model ? terminal.id : null;
  const highlight = useMemo(() => graphHighlight(model, hoveredId, terminalId), [model, hoveredId, terminalId]);
  // 实时刷新后状态或进度变了的任务，短暂描边（第一次画不算）
  const prints = useRef<Map<string, string> | null>(null);
  const [flash, setFlash] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const { fingerprints, changed } = changedNodes(prints.current, model);
    prints.current = fingerprints;
    if (!changed.size) return;
    setFlash(changed);
    const t = setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => clearTimeout(t);
  }, [model]);
  const labelOf = (col: string) => frame.data?.columns.find((c) => c.name === col)?.label || col;
  const option = useMemo(() => ganttChartOption(lay, { tokens: TOK, font: FONT, colors: { text: T.colors.text, secondary: T.colors['text-secondary'], border: T.colors.border, danger: T.colors.danger }, highlight, flash, red: model.red, now }),
    [lay, model, highlight, flash, now]);
  const table = useMemo(() => {
    const at = new Map(model.nodes.map((n) => [n.id, n]));
    const v = (id: string, col: string) => { const x = at.get(id)?.row?.[col]; return x === null || x === undefined ? '' : String(x); };
    return graphTableRows(model).map((r) => ({ ...r, start: v(r.id, spec.start_col), end: v(r.id, spec.end_col), overdue: lay.items.find((i) => i.id === r.id)?.overdue ? '已过期' : '' }));
  }, [model, lay, spec.start_col, spec.end_col]);
  const s = model.summary;
  const partial = partialText(model);
  const problems = model.diagnostics;
  const overdue = lay.items.filter((i) => i.overdue).length;
  const current = open ? model.nodes.find((n) => n.id === open && !n.placeholder) ?? null : null;
  const summary = [`共 ${s.total} 个`, s.done !== null ? `完成 ${s.done}` : null, s.ready !== null ? `可开始 ${s.ready}` : null, s.waiting !== null ? `等前置 ${s.waiting}` : null,
    overdue ? `过期 ${overdue}` : null, s.errors ? `出错 ${s.errors}` : null, s.rate !== null ? `完成率 ${Math.round(s.rate * 100)}%` : null, s.remaining !== null ? `到主线终点还差 ${s.remaining} 个` : null, s.note ?? null].filter(Boolean).join(' · ');
  return (
    <BlockFrame {...frame} kind="gantt" empty={frame.empty ?? '还没有任务'}
      extra={<Segmented size="small" value={mode} onChange={(v) => { setHover(null); setMode(v as 'graph' | 'table'); }} options={[{ label: '图', value: 'graph' }, { label: '表格', value: 'table' }]} />}>
      <div className={`wm-dag-summary${s.errors || overdue ? ' wm-dag-summary-bad' : ''}`} role="status" data-testid="gantt-summary">{summary}</div>
      {partial && <div className="wm-bb-truncated" data-testid="gantt-partial">{partial}</div>}
      {lay.badDates.length > 0 && <div className="wm-bb-truncated" data-testid="gantt-bad-dates">这些任务的开始或截止读不出来，或截止不晚于开始，没画横条：{lay.badDates.slice(0, 8).join('、')}{lay.badDates.length > 8 ? ` 等 ${lay.badDates.length} 个` : ''}</div>}
      {problems.length > 0 && <Alert type="warning" showIcon className="wm-dag-problems" message={<ul>{problems.map((d, i) => <li key={i}>{diagnosticText(d)}</li>)}</ul>} />}
      {mode === 'graph'
        ? <>
          <GanttCanvas option={option} idAt={(k) => lay.items[k]?.id ?? null} onPick={pickNode} onHover={(id) => setHover(id === null ? null : { model, id })} label={`甘特图：${summary}`} />
          <nav className="wm-dag-keys" aria-label="任务（按 Tab 逐个聚焦，回车看详情）">
            {lay.items.map((i) => <Button key={i.id} size="small" type="text" onClick={() => pickNode(i.id)} onFocus={() => setHover({ model, id: i.id })} onBlur={() => setHover(null)}>{i.label}</Button>)}
          </nav>
        </>
        : <Table size="small" rowKey="id" dataSource={table} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="gantt-table"
            onRow={(r) => ({ onClick: () => pickNode(r.id), onKeyDown: (e) => { if (e.key === 'Enter') pickNode(r.id); }, tabIndex: 0 })}
            columns={[{ title: '名称', dataIndex: 'label' }, { title: '开始', dataIndex: 'start' }, { title: '截止', dataIndex: 'end' }, { title: '状态', dataIndex: 'status' }, { title: '派生状态', dataIndex: 'derived' },
              { title: '进度', dataIndex: 'progress' }, { title: '过期', dataIndex: 'overdue' }, { title: '前置', dataIndex: 'preds' }, { title: '后继', dataIndex: 'succs' }, { title: '角色', dataIndex: 'role' }]} />}
      <Drawer title={current?.label ?? ''} open={!!current} width={480} onClose={() => setOpen(null)}>
        {current && <Descriptions column={1} size="small" items={[
          { key: 'id', label: '编号', children: current.id },
          { key: 'start', label: labelOf(spec.start_col), children: String(current.row?.[spec.start_col] ?? '—') },
          { key: 'end', label: labelOf(spec.end_col), children: String(current.row?.[spec.end_col] ?? '—') },
          ...(current.role ? [{ key: 'role', label: '角色', children: { start: '起点', end: '主线终点', branch_end: '支线终点' }[current.role] }] : []),
          ...(model.derived.get(current.id) ? [{ key: 'd', label: '派生状态', children: { done: '已完成', ready: '可开始', waiting: '等前置' }[model.derived.get(current.id)!] }] : []),
          ...((model.missingReq.get(current.id) ?? []).length ? [{ key: 'mr', label: '缺的必需前置', children: model.missingReq.get(current.id)!.join('、') }] : []),
          ...((model.missingOpt.get(current.id) ?? []).length ? [{ key: 'mo', label: '缺的可选前置', children: model.missingOpt.get(current.id)!.join('、') }] : []),
          ...(spec.detail_cols ?? []).map((c) => ({ key: 'c-' + c, label: labelOf(c), children: <span className="wm-prewrap wm-wrap-any">{current.row?.[c] === null || current.row?.[c] === undefined ? '—' : String(current.row[c])}</span> })),
        ]} />}
      </Drawer>
    </BlockFrame>
  );
}
