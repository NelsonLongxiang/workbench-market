/** 驾驶舱的一块（原型的 pane）：头上一排页签（可带件数），右边「放大 / 还原」，下面是当前页签的内容。
 *  只有一个页签时它就是这一块的标题。 */
import { useState, type ReactNode } from 'react';
import { FullscreenExitOutlined, FullscreenOutlined } from '@ant-design/icons';
import { activeTab } from '../../cockpit-frame-view';

export type PaneTab = { key: string; label: string; count?: number | null; content: ReactNode };

export default function Pane({ id, tabs, maxed, onToggleMax, className }: { id: string; tabs: PaneTab[]; maxed: boolean; onToggleMax: (id: string) => void; className?: string }) {
  const [cur, setCur] = useState<string | null>(null);
  const on = activeTab(tabs, cur);
  const tab = tabs.find((t) => t.key === on);
  return <section className={['wm-ck-pane', maxed ? 'maxed' : '', className].filter(Boolean).join(' ')} data-testid={`ck-pane-${id}`} aria-label={tab?.label}>
    <div className="wm-ck-pane-h" role="tablist">
      {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={t.key === on} className={t.key === on ? 'wm-ck-tab on' : 'wm-ck-tab'} onClick={() => setCur(t.key)} data-testid={`ck-tab-${id}-${t.key}`}>
        {t.label}{t.count ? <span className="wm-ck-tab-n">{t.count}</span> : null}
      </button>)}
      <button type="button" className="wm-ck-max" onClick={() => onToggleMax(id)} aria-label={maxed ? '还原' : '放大'} title={maxed ? '还原（F）' : '放大（F）'} data-testid={`ck-max-${id}`}>
        {maxed ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
      </button>
    </div>
    <div className="wm-ck-pane-b" role="tabpanel">{tab?.content}</div>
  </section>;
}
