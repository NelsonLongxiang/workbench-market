/** #1099 视图页签条：只占一行，放不下就横向滚动，最右出「更多」，里面列出没露全的页签；当前页签始终滚到看得见的地方。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown } from 'antd';
import { DownOutlined } from '@ant-design/icons';

export default function ViewTabs({ views, view, onPick, children }: { views: { key: string; title: string }[]; view: string; onPick: (key: string) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOver(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check); ro.observe(el);
    return () => ro.disconnect();
  }, [views.length]);
  useEffect(() => {
    const el = ref.current;
    const cur = el?.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
    if (!el || !cur) return;
    // 只横着滚页签条本身，不动页面
    if (cur.offsetLeft < el.scrollLeft) el.scrollLeft = cur.offsetLeft;
    else if (cur.offsetLeft + cur.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = cur.offsetLeft + cur.offsetWidth - el.clientWidth;
  }, [view, over]);
  // 打开「更多」时算哪些页签没露全
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const tabs = [...el.querySelectorAll<HTMLElement>('[role=tab]')];
    setHidden(views.filter((_, i) => { const t = tabs[i]; return !t || t.offsetLeft < el.scrollLeft || t.offsetLeft + t.offsetWidth > el.scrollLeft + el.clientWidth + 1; }).map((v) => v.key));
  };
  const items = views.filter((v) => hidden.includes(v.key)).map((v) => ({ key: v.key, label: <span data-testid="bench-page-tabs-more-item">{v.title}</span> }));
  return (
    <div className="wm-bp-tabbar">
      <div ref={ref} className="wm-bp-tabs" role="tablist" aria-label="视图" onScroll={() => { if (hidden.length) measure(); }}>{children}</div>
      {over ? (
        <Dropdown trigger={['click']} onOpenChange={(o) => { if (o) measure(); }}
          menu={{ items, selectedKeys: [view], onClick: ({ key }) => onPick(String(key)) }}>
          <Button size="small" type="text" data-testid="bench-page-tabs-more">更多 <DownOutlined /></Button>
        </Dropdown>
      ) : null}
    </div>
  );
}
