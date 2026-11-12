/** 驾驶舱骨架（产品化原型的驾驶舱那一屏）：
 *  上面一排：左边「看的是 …」（传进来的筛选或说明），右边操作（比如「就这个安排一件事」）；
 *  下面三栏：左一块、中间上下两块、右一块。栏之间的分隔条可以拖，尺寸记在本机（每个驾驶舱一份）；
 *  每块可以放大到占满、再还原，键盘 F 放大 / 还原中间上面那块（原型的做法）。
 *  哪一块放什么由页面传：没有内容的块不传就不出现，布局自己收拢。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Pane, { type PaneTab } from './Pane';
import { dragSizes, parseSizes, toggleMax, type Sizes } from '../../cockpit-frame-view';

type Slot = { id: string; tabs: PaneTab[] } | null | undefined;

export default function CockpitFrame({ storageKey, bar, extra, left, main, bottom, right }: {
  storageKey: string; bar?: ReactNode; extra?: ReactNode; left?: Slot; main: { id: string; tabs: PaneTab[] }; bottom?: Slot; right?: Slot;
}) {
  // 只在拖过之后才记：没拖过的一直跟着缺省走（缺省改了，没拖过的人也跟着变）
  const key = `wm-ck-sizes2:${storageKey}`;
  const [sizes, setSizes] = useState<Sizes>(() => { try { return parseSizes(localStorage.getItem(key)); } catch { return parseSizes(null); } });
  const [max, setMax] = useState<string | null>(null);
  const onToggleMax = useCallback((id: string) => setMax((cur) => toggleMax(cur, id)), []);
  const drag = useRef<{ which: keyof Sizes; x: number; y: number; start: Sizes } | null>(null);

  const latest = useRef(sizes);
  latest.current = sizes;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key.toLowerCase() !== 'f' || e.metaKey || e.ctrlKey || e.altKey || (el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable))) return;
      setMax((cur) => (cur ? null : main.id));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [main.id]);

  const startDrag = (which: keyof Sizes) => (e: React.PointerEvent) => {
    e.preventDefault();
    drag.current = { which, x: e.clientX, y: e.clientY, start: sizes };
    const move = (ev: PointerEvent) => { const d = drag.current; if (d) setSizes(dragSizes(d.start, d.which, ev.clientX - d.x, ev.clientY - d.y)); };
    const up = () => { drag.current = null; try { localStorage.setItem(key, JSON.stringify(latest.current)); } catch { /* 存不了就只在本页有效 */ } window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const pane = (s: { id: string; tabs: PaneTab[] }, cls: string) => <Pane id={s.id} tabs={s.tabs} maxed={max === s.id} onToggleMax={onToggleMax} className={cls} />;
  const cols = [left ? `${sizes.left}px 8px` : '', 'minmax(0, 1fr)', right ? `8px ${sizes.right}px` : ''].filter(Boolean).join(' ');
  // 列宽、行高随拖动变，只能写在行内（和全景的表一样，是按数据算的尺寸）
  return <div className="wm-ck" data-testid="ck-frame">
    {(bar || extra) && <div className="wm-ck-bar" data-testid="ck-bar">{bar}<span className="wm-ck-bar-extra">{extra}</span></div>}
    <div className={max ? 'wm-ck-grid max' : 'wm-ck-grid'} style={{ gridTemplateColumns: cols }}>
      {left && <>{pane(left, 'wm-ck-left')}<div className="wm-ck-split v" onPointerDown={startDrag('left')} role="separator" aria-orientation="vertical" aria-label="调整左栏宽度" data-testid="ck-split-left" /></>}
      <div className="wm-ck-mid" style={{ gridTemplateRows: bottom ? `minmax(0, 1fr) 8px ${sizes.bottom}px` : 'minmax(0, 1fr)' }}>
        {pane(main, 'wm-ck-main')}
        {bottom && <><div className="wm-ck-split h" onPointerDown={startDrag('bottom')} role="separator" aria-orientation="horizontal" aria-label="调整下面一块的高度" data-testid="ck-split-bottom" />{pane(bottom, 'wm-ck-bottom')}</>}
      </div>
      {right && <><div className="wm-ck-split v" onPointerDown={startDrag('right')} role="separator" aria-orientation="vertical" aria-label="调整右栏宽度" data-testid="ck-split-right" />{pane(right, 'wm-ck-right')}</>}
    </div>
  </div>;
}
