/**
 * 任务图 dag（docs/task-graph-step1.md）：只读。数据由 AI 经 MCP 写进台的数据集，这里只画。
 * 解析、核对、派生状态、闭包与布局都在 task-graph.ts（纯函数，单测直接测）；这里只管画图、等价表格、摘要和详情。
 * 图用 ECharts graph 系列（echarts-lite.ts 按需加载），坐标用自写分层布局（layout: 'none'）；颜色只取设计 token，不写内联样式。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Segmented, Table } from 'antd';
import { DESIGN_TOKENS as T } from '../design-tokens';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { valueLabel } from './blocks-view';
import { buildGraph, graphTableRows, layoutGraph, type Diagnostic, type GraphModel, type GraphSpec, type GNode } from './task-graph';

export interface DagBlockProps extends BlockFrameProps {
  spec: Omit<GraphSpec, 'kind'> & { detail_cols?: string[]; direction?: 'LR' | 'TB' };
  graphMeta?: { filtered?: boolean } | null;
  valueLabels?: unknown;
}

const tone: Record<string, string> = { success: T.colors.success, warning: T.colors.warning, danger: T.colors.danger, default: T.colors['text-secondary'] };
const derivedColor = { done: T.colors.success, ready: T.colors.primary, waiting: T.colors['border-strong'] } as const;

export function diagnosticText(d: Diagnostic): string {
  const list = (ids: string[]) => ids.slice(0, 8).join('、') + (ids.length > 8 ? ` 等 ${ids.length} 个` : '');
  switch (d.code) {
    case 'cycle': return `依赖有环：${d.path.join(' → ')}`;
    case 'bad-id': return `有 ${d.rows} 行的编号为空、重复、超过 64 字或含逗号、等号、竖线、问号，没画`;
    case 'bad-deps': return `任务 ${d.node} 有看不懂的依赖：${d.items.slice(0, 5).join('，')}`;
    case 'self-dep': return `这些任务的依赖里写了自己，已忽略：${list(d.nodes)}`;
    case 'missing': return `有 ${d.ids.length} 条依赖指向不存在的任务：${list(d.ids)}`;
    case 'start-count': return d.ids.length ? `起点要恰好一个，现在有 ${d.ids.length} 个：${list(d.ids)}` : '缺起点（角色列写 start）';
    case 'end-count': return d.ids.length ? `主线终点要恰好一个，现在有 ${d.ids.length} 个：${list(d.ids)}` : '缺主线终点（角色列写 end）';
    case 'start-has-deps': return `起点 ${d.id} 不能有前置`;
    case 'unconfirmed-leaf': return `支线没确认终点：${list(d.ids)}（没有后继的任务要标 end 或 branch_end）`;
    case 'cannot-reach-end': return `这些任务走不到任何终点：${list(d.ids)}`;
    case 'unreachable-from-start': return `从起点走不到这些任务：${list(d.ids)}`;
    case 'too-complex': return '依赖太复杂，未算完成率';
    case 'early-start': return `提前开工（前置还没完成）：${list(d.ids)}`;
    case 'done-without-source': return `已完成但没留来源：${list(d.ids)}`;
  }
}

export function partialText(m: GraphModel): string | null {
  if (m.full) return null;
  const why: string[] = [];
  if (m.partialReasons.includes('filtered')) why.push('筛选了');
  if (m.partialReasons.includes('rows')) why.push(`超过 500 个，只画了前 ${m.drawn} 个`);
  if (m.partialReasons.includes('deps')) why.push('有任务的依赖超过 50 项，多出的没画');
  if (m.partialReasons.includes('edges')) why.push('连线超过 5000 条，多出的没画');
  if (m.partialReasons.includes('placeholders')) why.push(`范围外的任务太多，另有 ${m.placeholderOverflow} 个没画`);
  return `当前是部分任务（${why.join('；')}），终点核对和完成率只在看全部任务时做。`;
}

function nodeColor(n: GNode, m: GraphModel, labels: unknown, statusCol?: string): string {
  if (n.placeholder) return T.colors.border;
  const hit = statusCol && n.status !== null ? valueLabel(labels, statusCol, n.status) : null;
  if (hit?.tone && tone[hit.tone]) return tone[hit.tone];
  const d = m.derived.get(n.id);
  return d ? derivedColor[d] : T.colors.primary;
}

function GraphCanvas({ option, onPick, label }: { option: Record<string, unknown>; onPick: (id: string) => void; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<{ setOption: (o: unknown, n?: boolean) => void; resize: () => void; dispose: () => void } | null>(null);
  const pick = useRef(onPick); pick.current = onPick;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false, ro: ResizeObserver | null = null;
    import('./echarts-lite').then(({ default: echarts }) => {
      if (gone || !el.current) return;
      const c = echarts.init(el.current);
      chart.current = c as never;
      c.setOption(option, true);
      c.on('click', (p) => { const d = (p as { dataType?: string; data?: { id?: string } }); if (d.dataType === 'node' && d.data?.id) pick.current(d.data.id); });
      ro = new ResizeObserver(() => c.resize()); ro.observe(el.current);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { chart.current?.setOption(option, true); }, [option]);
  if (failed) return <div className="wm-bb-truncated">图没能加载出来，刷新页面再试，或切到表格看。</div>;
  return <div ref={el} className="wm-dag-canvas" role="img" aria-label={label} />;
}

export function DagBlock({ spec, graphMeta, valueLabels, ...frame }: DagBlockProps) {
  const rows = useMemo(() => (frame.data?.rows ?? []) as Record<string, unknown>[], [frame.data]);
  const model = useMemo(() => buildGraph(rows, { ...spec, kind: 'dag' }, { filtered: !!graphMeta?.filtered, truncated: !!frame.data?.truncated }), [rows, spec, graphMeta, frame.data]);
  const lay = useMemo(() => (model.blocked ? null : layoutGraph(model, spec.direction ?? 'LR')), [model, spec.direction]);
  const [mode, setMode] = useState<'graph' | 'table'>('graph');
  const [open, setOpen] = useState<string | null>(null);
  const labelOf = (col: string) => frame.data?.columns.find((c) => c.name === col)?.label || col;
  const option = useMemo(() => {
    if (!lay) return {};
    const node = (n: GNode) => {
      const p = lay.placed.get(n.id)!;
      const color = nodeColor(n, model, valueLabels, spec.status_col);
      return { id: n.id, name: n.placeholder ? `${n.placeholder === 'missing' ? '缺失' : '范围外'}：${n.id}` : n.label, x: p.x, y: p.y, symbol: n.role === 'start' || n.role === 'end' || n.role === 'branch_end' ? 'roundRect' : 'rect',
        symbolSize: [150, 40], itemStyle: { color: T.colors.surface, borderColor: model.red.has(n.id) ? T.colors.danger : color, borderWidth: model.red.has(n.id) || n.role ? 3 : 2, borderType: n.placeholder ? 'dashed' : 'solid' },
        label: { show: true, color: T.colors.text, fontSize: parseInt(T.typography.caption.fontSize, 10), formatter: n.progress === null ? '{b}' : `{b}\n${n.progress}%` } };
    };
    return {
      animation: false, tooltip: { show: false },
      series: [{ type: 'graph', layout: 'none', roam: true, edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 8,
        data: model.nodes.map(node),
        links: lay.edges.map((e) => ({ source: e.from, target: e.to, lineStyle: { color: T.colors['border-strong'], type: e.kind === 'opt' ? 'dashed' : 'solid', curveness: e.back ? 0.3 : 0 }, ...(e.label ? { label: { show: true, formatter: e.label } } : {}) })) }],
    };
  }, [lay, model, valueLabels, spec.status_col]);
  const table = useMemo(() => graphTableRows(model), [model]);
  const s = model.summary;
  const partial = partialText(model);
  const problems = model.diagnostics.filter((d) => d.code !== 'cycle');
  const current = open ? model.nodes.find((n) => n.id === open && !n.placeholder) ?? null : null;
  const summary = [`共 ${s.total} 个`, s.done !== null ? `完成 ${s.done}` : null, s.ready !== null ? `可开始 ${s.ready}` : null, s.waiting !== null ? `等前置 ${s.waiting}` : null,
    s.errors ? `出错 ${s.errors}` : null, s.rate !== null ? `完成率 ${Math.round(s.rate * 100)}%` : null, s.remaining !== null ? `到主线终点还差 ${s.remaining} 个` : null, s.note ?? null].filter(Boolean).join(' · ');
  return (
    <BlockFrame {...frame} kind="dag" empty={frame.empty ?? '还没有任务'}
      extra={<Segmented size="small" value={mode} onChange={(v) => setMode(v as 'graph' | 'table')} options={[{ label: '图', value: 'graph' }, { label: '表格', value: 'table' }]} />}>
      <div className={`wm-dag-summary${s.errors ? ' wm-dag-summary-bad' : ''}`} role="status" data-testid="dag-summary">{summary}</div>
      {s.branches.length > 0 && <div className="wm-dag-branches">{s.branches.map((b) => <span key={b.id}>支线 {b.id}：{b.done}/{b.size}</span>)}</div>}
      {partial && <div className="wm-bb-truncated" data-testid="dag-partial">{partial}</div>}
      {problems.length > 0 && <Alert type="warning" showIcon className="wm-dag-problems" message={<ul>{problems.map((d, i) => <li key={i}>{diagnosticText(d)}</li>)}</ul>} />}
      {mode === 'graph' ? (model.blocked
        ? <Alert type="error" showIcon data-testid="dag-cycle" message={diagnosticText(model.diagnostics.find((d) => d.code === 'cycle')!)} description="有环的依赖图画不出先后，请改依赖；也可以切到表格看。" />
        : <>
          <GraphCanvas option={option} onPick={setOpen} label={`任务依赖图：${summary}`} />
          <nav className="wm-dag-keys" aria-label="任务（按 Tab 逐个聚焦，回车看详情）">
            {model.nodes.filter((n) => !n.placeholder).map((n) => <Button key={n.id} size="small" type="text" onClick={() => setOpen(n.id)}>{n.label}</Button>)}
          </nav>
        </>)
        : <Table size="small" rowKey="id" dataSource={table} pagination={{ pageSize: 50, hideOnSinglePage: true }} data-testid="dag-table"
            onRow={(r) => ({ onClick: () => setOpen(r.id), onKeyDown: (e) => { if (e.key === 'Enter') setOpen(r.id); }, tabIndex: 0 })}
            columns={[{ title: '名称', dataIndex: 'label' }, { title: '状态', dataIndex: 'status' }, { title: '派生状态', dataIndex: 'derived' }, { title: '进度', dataIndex: 'progress' },
              { title: '前置', dataIndex: 'preds' }, { title: '后继', dataIndex: 'succs' }, { title: '角色', dataIndex: 'role' }]} />}
      <Drawer title={current?.label ?? ''} open={!!current} width={480} onClose={() => setOpen(null)}>
        {current && <Descriptions column={1} size="small" items={[
          { key: 'id', label: '编号', children: current.id },
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
