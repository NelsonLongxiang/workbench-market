/**
 * 柱、线、饼的图表配置：只从设计 token 取颜色、字体、线条，不带图表库自带的主题色。
 * 纯函数（token 由调用方给），不引用别的文件：单测直接用 Node 加载。
 */
export type ChartTokens = {
  series: string[]; /** 并出来的「其他」用的中性色 */ muted: string; text: string; textSecondary: string; border: string; surface: string; fontFamily: string; fontSize: number;
};
type Model = { categories: string[]; series: { name: string; values: (number | null)[] }[]; merged?: boolean };
type Slice = { name: string; value: number };

const base = (t: ChartTokens) => ({
  color: t.series,
  textStyle: { fontFamily: t.fontFamily, fontSize: t.fontSize, color: t.textSecondary },
  animationDuration: 200,
  tooltip: {
    backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, padding: [6, 10],
    textStyle: { color: t.text, fontFamily: t.fontFamily, fontSize: t.fontSize },
    extraCssText: 'box-shadow: var(--wm-shadow-2); border-radius: var(--wm-radius-md);',
  },
});
const legend = (t: ChartTokens, show: boolean) => ({
  show, top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 12,
  textStyle: { color: t.textSecondary, fontFamily: t.fontFamily, fontSize: t.fontSize },
});
const axisLabel = (t: ChartTokens) => ({ color: t.textSecondary, fontFamily: t.fontFamily, fontSize: t.fontSize });

/** 柱和线共用：细网格线、没有轴线刻度、图例在左上（只有一个系列时不画图例） */
export function cartesianOption(kind: 'bar' | 'line', m: Model, t: ChartTokens, o: { stacked?: boolean; horizontal?: boolean; area?: boolean } = {}) {
  const many = m.series.length > 1;
  const cat = { type: 'category', data: m.categories, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false }, axisLabel: { ...axisLabel(t), hideOverlap: true } };
  const val = { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: t.border, type: 'dashed' } }, axisLabel: axisLabel(t) };
  const horizontal = kind === 'bar' && !!o.horizontal;
  return {
    ...base(t),
    tooltip: { ...base(t).tooltip, trigger: 'axis', axisPointer: { type: kind === 'bar' ? 'shadow' : 'line', lineStyle: { color: t.border }, shadowStyle: { color: t.border, opacity: 0.35 } } },
    legend: legend(t, many),
    grid: { left: 4, right: 8, top: many ? 32 : 12, bottom: 4, containLabel: true },
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? { ...cat, inverse: true } : val,
    series: m.series.map((s, i) => ({ ...(m.merged && i === m.series.length - 1 ? { color: t.muted } : {}), ...(kind === 'bar'
      ? { type: 'bar', name: s.name, data: s.values, stack: o.stacked ? 'total' : undefined, barMaxWidth: 28, itemStyle: { borderRadius: o.stacked ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] } }
      : { type: 'line', name: s.name, data: s.values, symbol: 'circle', symbolSize: 6, showSymbol: m.categories.length <= 24, lineStyle: { width: 2 }, connectNulls: false, areaStyle: o.area ? { opacity: 0.08 } : undefined }) })),
  };
}

export function pieOption(slices: Slice[], t: ChartTokens, o: { donut?: boolean; merged?: boolean } = {}) {
  return {
    ...base(t),
    tooltip: { ...base(t).tooltip, trigger: 'item' },
    legend: { ...legend(t, true), orient: 'vertical', top: 'middle', left: 'auto', right: 0 },
    series: [{
      type: 'pie', data: slices.map((s, i) => ({ name: s.name, value: s.value, ...(o.merged && i === slices.length - 1 ? { itemStyle: { color: t.muted } } : {}) })),
      center: ['36%', '50%'], radius: o.donut ? ['48%', '72%'] : [0, '72%'],
      label: { show: false }, labelLine: { show: false },
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
      emphasis: { scale: true, scaleSize: 4 },
    }],
  };
}
