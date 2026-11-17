/** P0 report projection. Deliberately not imported by production routes. */
import { useEffect, useRef } from 'react';
import { fmtNumber, toSeries } from '../bench-blocks/blocks-view';
import { cartesianOption, type ChartTokens } from '../bench-blocks/chart-option';
import { DESIGN_TOKENS as T } from '../design-tokens';
import type { FrozenReport, ResolvedNode } from './p0';
import './p0.css';

const TOKENS: ChartTokens = { series: [T.colors.primary, T.colors.success, T.colors.warning], muted: T.colors['border-strong'], tones: { danger: T.colors.danger, warning: T.colors.warning, success: T.colors.success }, text: T.colors.text, textSecondary: T.colors['text-secondary'], border: T.colors.border, surface: T.colors.surface, fontFamily: T.typography['family-sans'], fontSize: parseInt(T.typography.caption.fontSize, 10) };
function Chart({ node }: { node: ResolvedNode }) {
 const ref = useRef<HTMLDivElement>(null);
 useEffect(() => {
  let gone = false; let dispose: (() => void) | undefined;
  void Promise.all([import('echarts/core'), import('echarts/charts'), import('echarts/components'), import('echarts/renderers')]).then(([ec, charts, components, renderers]) => {
   if (gone || !ref.current || !node.data) return;
   ec.use([charts.BarChart, components.GridComponent, components.LegendComponent, components.TooltipComponent, renderers.SVGRenderer]);
   const chart = ec.init(ref.current, undefined, { renderer: 'svg' }); dispose = () => chart.dispose();
   const p = node.props ?? {}, model = toSeries(node.data, p.x ?? '', p.y ?? []);
   const option = cartesianOption('bar', model, TOKENS);
   chart.setOption({ ...option, animation: false });
   ref.current.dataset.ready = 'true';
  }).catch(e => { if (ref.current) { ref.current.dataset.error = 'true'; ref.current.textContent = String(e); } });
  return () => { gone = true; dispose?.(); };
 }, [node]);
 return <figure className="rp-chart-box" data-unsplittable><div ref={ref} className="rp-chart" data-report-chart role="img" aria-label="合成分类金额柱状图" /><figcaption>分类金额（CNY），图表与来源表使用同一份冻结数据。</figcaption></figure>;
}
function Blocks({ nodes, level = 1 }: { nodes: ResolvedNode[]; level?: number }) {
 return <>{nodes.map(n => {
  const key = n.id;
  if (n.type === 'cover') return <header className="rp-cover" key={key} data-node={key}><h1>{n.title}</h1><p>{n.content}</p><p className="rp-note">P0 技术试排 · 仅合成数据 · 不提供业务结论</p></header>;
  if (n.type === 'section') {
   const H = level <= 1 ? 'h2' : 'h3', children = n.children ?? [];
   const firstImage = children.findIndex(x => x.type === 'image');
   const lead = firstImage >= 0 && firstImage <= 1 ? firstImage + 1 : 0;
   return <section key={key} data-node={key}>{lead ? <div className="rp-section-lead" data-unsplittable><H>{n.title}</H><Blocks nodes={children.slice(0, lead)} level={level + 1} /></div> : <H>{n.title}</H>}<Blocks nodes={children.slice(lead)} level={level + 1} /></section>;
  }
  if (n.type === 'text') return <p key={key} data-node={key}>{n.content}</p>;
  if (n.type === 'grid') return <div key={key} data-node={key} data-unsplittable className={'rp-grid rp-grid-' + (n.columns ?? []).join('-')}><Blocks nodes={n.children ?? []} level={level} /></div>;
  if (n.type === 'page-break') return <div key={key} className="rp-page-break" />;
  if (n.type === 'image') return <figure key={key} data-node={key} data-unsplittable className="rp-figure"><img src={n.asset?.data_url} alt={n.alt} /><figcaption>{n.alt}</figcaption></figure>;
  if (n.type === 'data-view' && n.component === 'stat') { const value=n.data?.rows[0]?.[n.props?.value ?? '']; return <div key={key} className="rp-stat" data-node={key}><span>{n.data?.columns.find(c=>c.name===n.props?.value)?.label}</span><strong>{fmtNumber(value)}<small> {n.props?.unit}</small></strong></div>; }
  if (n.type === 'data-view' && n.component === 'bar') return <Chart key={key} node={n} />;
  if (n.type === 'data-view' && n.component === 'table') {
   const cols=(n.props?.columns ?? []).map(name=>n.data?.columns.find(c=>c.name===name)).filter((x): x is NonNullable<typeof x> => !!x);
   return <table key={key} data-node={key} className="rp-table"><thead><tr>{cols.map(c=><th key={c.name}>{c.label}</th>)}</tr></thead><tbody>{(n.data?.rows ?? []).map((r,i)=><tr key={i} data-report-row={String(r.id ?? i)}>{cols.map(c=><td key={c.name} className={['integer','decimal'].includes(c.type)?'rp-number':undefined}>{['integer','decimal'].includes(c.type)?fmtNumber(r[c.name]):String(r[c.name]??'—')}</td>)}</tr>)}</tbody></table>;
  }
  return null;
 })}</>;
}
export function P0Report({ report }: { report: FrozenReport }) {
 return <article className="rp-document" lang="zh-CN"><Blocks nodes={report.body} /><footer className="rp-provenance">冻结输入来源：{report.sources.map(s=>s.identity+' / '+s.slot+' / '+s.rows+'行').join('；')}</footer></article>;
}
