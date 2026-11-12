/** 往驾驶舱里挂数据视图的对话框（从「编辑」里的「数据视图」打开，能改这个驾驶舱的人才看得到；
 *  开没开由驾驶舱页面管，不放在「编辑」的浮层里面：浮层一收起，里面的东西就没了）：
 *  选台（只列你看得到的台）、选这个台的哪份视图、放「看板」还是「明细」；已经挂上的可以调次序、换页签、移除。
 *  每动一下就存一次。存下来的只是引用（台标识 + 视图键）：别人打开时看不看得到数据，取数那一刻按他的权限判。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Button, Empty, Modal, Segmented, Select, Typography, message } from 'antd';
import { api, getBenchViewDoc, listBenchViews } from '../../api';
import { benchViewRefs, type BenchViewRef } from '../../cockpit-frame-view';
import { TAB_LABEL, addRef, benchListState, moveRef, orderedRefs, removeRef, retabRef, viewChoices, type BenchListState, type Tab, type ViewChoice } from '../../cockpit-bench-view';
import type { PanelConfig } from '../../types';
import './bench-view.css';

type Views = { views: ViewChoice[]; text: string };
const TABS = (['board', 'detail'] as const).map((t) => ({ value: t, label: TAB_LABEL[t] }));

export default function BenchViewManage({ cockpit, open, onClose, onSaved }: { cockpit: { id: number; panels: unknown[] }; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [panels, setPanels] = useState<unknown[]>(cockpit.panels);
  const [saving, setSaving] = useState(false);
  const [list, setList] = useState<BenchListState | null>(null);
  const [docs, setDocs] = useState<Record<string, Views>>({});
  const [bench, setBench] = useState<string>();
  const [view, setView] = useState<string>();
  const [tab, setTab] = useState<Tab>('board');

  const loadDoc = useCallback(async (slug: string) => {
    const r = await getBenchViewDoc(slug);
    setDocs((cur) => ({ ...cur, [slug]: viewChoices(r.status, r.body) }));
  }, []);
  // 打开时：以存着的面板为准，取台的清单，再取已挂视图所在的台的视图名（显示用）
  useEffect(() => {
    if (!open) return;
    setPanels(cockpit.panels); setBench(undefined); setView(undefined); setList(null); setDocs({});
    void listBenchViews().then((r) => setList(benchListState(r.status, r.body)));
    for (const slug of new Set(benchViewRefs(cockpit.panels).map((x) => x.bench))) void loadDoc(slug);
  // 只在打开那一刻装一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const refs = orderedRefs(benchViewRefs, panels);
  const benchTitle = useMemo(() => new Map(list?.kind === 'ok' ? list.benches.map((b) => [b.slug, b.title]) : []), [list]);
  const name = (x: BenchViewRef) => `${docs[x.bench]?.views.find((v) => v.key === x.view)?.title ?? x.view} · ${benchTitle.get(x.bench) ?? x.bench}`;

  const save = async (next: unknown[]) => {
    setSaving(true);
    try {
      await api.updateCockpit(cockpit.id, { panels: next as PanelConfig[] });
      setPanels(next);
      onSaved();
    } catch (e) { message.error(`没存上：${(e as Error).message}`); } finally { setSaving(false); }
  };
  const add = () => {
    if (!bench || !view) return;
    const r = addRef(benchViewRefs, panels, { bench, view, tab });
    if (!r.ok) { message.warning(r.reason); return; }
    setView(undefined);
    void save(r.panels);
  };
  const picked = bench ? docs[bench] : undefined;
  const taken = new Set(refs.map((x) => x.i));

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="这个驾驶舱里的数据视图" width={640} destroyOnClose>
      <div data-testid="ck-bv-manage-panel">
        <Typography.Paragraph type="secondary">挂上的视图出现在中间一栏的「看板」「明细」页签里，从上到下照这里的次序。这里存的只是引用：别人打开这个驾驶舱时，他没有权限的台，那一块会告诉他看不到。</Typography.Paragraph>
        {(['board', 'detail'] as const).map((t) => {
          const mine = refs.filter((x) => x.tab === t);
          return <div key={t} className="wm-ck-bv-group" data-testid={`ck-bv-list-${t}`}>
            <Typography.Text strong>{TAB_LABEL[t]}</Typography.Text>
            {mine.length === 0 ? <div className="wm-ck-bv-none">还没有视图。</div> : <div className="wm-ck-bv-list">
              {mine.map((x, n) => <div key={x.i} className="wm-ck-bv-row" data-testid="ck-bv-row" data-ref={x.i}>
                <span className="wm-ck-bv-row-name" title={`${x.bench} / ${x.view}`}>{name(x)}</span>
                <Segmented size="small" options={TABS} value={x.tab} disabled={saving} onChange={(v) => void save(retabRef(benchViewRefs, panels, x.i, v as Tab))} />
                <Button size="small" type="text" icon={<ArrowUpOutlined />} aria-label="往前挪" disabled={saving || n === 0} onClick={() => void save(moveRef(benchViewRefs, panels, x.i, -1))} />
                <Button size="small" type="text" icon={<ArrowDownOutlined />} aria-label="往后挪" disabled={saving || n === mine.length - 1} onClick={() => void save(moveRef(benchViewRefs, panels, x.i, 1))} />
                <Button size="small" type="text" danger disabled={saving} onClick={() => void save(removeRef(benchViewRefs, panels, x.i))}>移除</Button>
              </div>)}
            </div>}
          </div>;
        })}
        <Typography.Text strong>加一份</Typography.Text>
        <div className="wm-ck-bv-addwrap">
          {list === null ? <Typography.Text type="secondary">正在取台的清单…</Typography.Text>
            : list.kind !== 'ok' ? <Typography.Text type="secondary" data-testid="ck-bv-list-state" data-kind={list.kind}>{list.text}</Typography.Text>
            : list.benches.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="你现在没有可以看的台，所以没有能挂的视图。" />
            : <div className="wm-ck-bv-add">
              <Select placeholder="选一个台" showSearch {...{ optionFilterProp: 'label' }} value={bench} data-testid="ck-bv-bench"
                options={list.benches.map((b) => ({ value: b.slug, label: b.title }))}
                onChange={(v: string) => { setBench(v); setView(undefined); if (!docs[v]) void loadDoc(v); }} />
              <Select placeholder={!bench ? '先选台' : !picked ? '正在取…' : '选一份视图'} value={view} disabled={!picked || picked.views.length === 0} data-testid="ck-bv-view"
                options={(picked?.views ?? []).map((v) => ({ value: v.key, label: v.title, disabled: taken.has(`bv-${bench}-${v.key}`) }))}
                onChange={(v: string) => setView(v)} />
              <Segmented options={TABS} value={tab} onChange={(v) => setTab(v as Tab)} />
              <Button type="primary" disabled={!bench || !view || saving} loading={saving} onClick={add} data-testid="ck-bv-add">加进来</Button>
              {picked?.text && <Typography.Text type="secondary" data-testid="ck-bv-view-state">{picked.text}</Typography.Text>}
            </div>}
        </div>
      </div>
    </Modal>
  );
}
