/** 驾驶舱「看板」或「明细」页签的内容：这个页签上的几份数据视图，一份接一份。
 *  筛选不由每份视图各画各的：把它们认的筛选项按名字合成顶上一排，选了之后按名字传给每一份（认这个名字的生效，不认的不受影响）。
 *  人选的值按驾驶舱记（scope），两个页签共用：「看板」上选了月份，切到「明细」还是这个月。只记在这一页的内存里，刷新就没了。
 *  每份视图上面一行小标题（视图名 · 台名），几份来自不同的台时分得清。 */
import { useCallback, useState, useSyncExternalStore } from 'react';
import BenchViewPanel from './BenchViewPanel';
import { FilterBar } from '../../bench-blocks/FilterBar';
import type { ViewResult } from '../../bench-blocks/BenchView';
import type { BenchViewRef } from '../../cockpit-frame-view';
import { filtersOf, mergeFilters, nextChosen, paramsFor, shownParams } from '../../cockpit-bench-view';
import './bench-view.css';

// 人选的筛选值：一个驾驶舱一份，「看板」「明细」两个页签看的是同一份
const NONE: Record<string, string> = {};
const picked = new Map<string, Record<string, string>>();
const watchers = new Set<() => void>();
const watch = (f: () => void) => { watchers.add(f); return () => { watchers.delete(f); }; };

export default function BenchViewTab({ refs, scope }: { refs: BenchViewRef[]; scope: string }) {
  const chosen = useSyncExternalStore(watch, () => picked.get(scope) ?? NONE);
  const setChosen = (next: Record<string, string>) => { picked.set(scope, next); watchers.forEach((f) => f()); };
  const [loaded, setLoaded] = useState<Record<string, ViewResult | null>>({});
  const onLoaded = useCallback((i: string, r: ViewResult | null) => setLoaded((cur) => (cur[i] === r ? cur : { ...cur, [i]: r })), []);
  const lists = refs.map((x) => filtersOf(loaded[x.i]));
  const merged = mergeFilters(lists);
  const shown = shownParams(refs.map((x) => loaded[x.i]?.params ?? {}), chosen);
  return <>
    {merged.length > 0 && <div className="wm-ck-bv-filters" data-testid="ck-bv-filters">
      <FilterBar frame="none" fields={merged} value={shown} onChange={(next) => setChosen(nextChosen(chosen, merged, next))} />
    </div>}
    {refs.map((x, n) => <BenchViewPanel key={x.i} refItem={x} shared heading onLoaded={onLoaded}
      // 还没取到第一次之前不知道它认哪些筛选项，先全给（入口对不认的名字本来就忽略）
      params={loaded[x.i] ? paramsFor(lists[n], shown) : shown} />)}
  </>;
}
