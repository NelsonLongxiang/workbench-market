/** 「等你拍板」的完整列表（全景「等你拍板」的「全部 →」链过来）：按新外壳和原型重写——
 *  和全景同一张卡（DecisionCard，当场能办）、同一个计数函数（groupCards / decideCount，侧栏角标、全景的总结句也用它），
 *  分三组：轮到你能当场办的、别人的事你可以代办的、要到别处处理的。上面一排按类别筛（在问、等验收、等过目、待核准、等审核），
 *  筛只影响下面的卡，总结句照全部算。数据来自 GET /api/attention；别处办完一件（卡片会广播）这里跟着重读。 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Empty, Segmented, Skeleton, Typography } from 'antd';
import { adminActive, subscribeAdminToken } from '../admin-token';
import WmPage from '../components/WmPage';
import DecisionCard from '../components/DecisionCard';
import { ATTENTION_CHANGED, getAttention } from '../api';
import { answerChoices, groupCards, type AttentionItem, type Category } from '../attention-view';
import { decideLine } from '../home-view';

/** 筛的类别和说法（同卡片标签的叫法） */
const CATS: { key: Category; label: string }[] = [
  { key: 'ask', label: '在问' }, { key: 'accept', label: '等验收' }, { key: 'glance', label: '等过目' }, { key: 'grant', label: '待核准' }, { key: 'review', label: '等审核' },
];

export default function Attention() {
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [status, setStatus] = useState(0);
  const [cat, setCat] = useState<Category | 'all'>('all');

  const load = useCallback(async () => {
    const r = await getAttention();
    setStatus(r.status);
    setItems(r.status >= 200 && r.status < 300 ? r.items as unknown as AttentionItem[] : []);
  }, []);
  useEffect(() => { void load(); }, [load, admin]);
  useEffect(() => {
    const on = () => { void load(); };
    window.addEventListener(ATTENTION_CHANGED, on);
    return () => window.removeEventListener(ATTENTION_CHANGED, on);
  }, [load]);

  const choicesOf = useCallback((x: AttentionItem) => answerChoices(admin, x), [admin]);
  // 总结句照全部算；下面的卡按选的类别筛
  const all = useMemo(() => groupCards(items ?? [], choicesOf), [items, choicesOf]);
  const shown = useMemo(() => groupCards((items ?? []).filter((x) => cat === 'all' || x.category === cat), choicesOf), [items, cat, choicesOf]);
  const n = (c: Category) => (items ?? []).filter((x) => x.category === c).length;
  const card = (a: AttentionItem) => <DecisionCard key={`${a.source}:${a.source_id}`} item={a} admin={admin} onDone={() => undefined} />;
  const failed = items !== null && (status < 200 || status >= 300);
  const empty = shown.now.length + shown.proxy.length + shown.elsewhere.length === 0;

  return <WmPage title="等你拍板">
    <div className="wm-home">
      <Typography.Paragraph type="secondary" className="wm-home-sum" data-testid="attention-summary">
        {items === null ? '正在读……' : failed ? (status === 401 ? '请先登录。' : '这会儿读不到等你拍板的事，稍后再试。') : decideLine(all.now.length, all.elsewhere.length, false, all.proxy.length)}
      </Typography.Paragraph>
      {items !== null && !failed && <Segmented value={cat} onChange={(v) => setCat(v as Category | 'all')} data-testid="attention-filter"
        options={[{ label: `全部 ${items.length}`, value: 'all' }, ...CATS.filter((c) => n(c.key) > 0).map((c) => ({ label: `${c.label} ${n(c.key)}`, value: c.key }))]} />}
      {items === null && <Skeleton active paragraph={{ rows: 4 }} />}
      {items !== null && !failed && empty && <div className="wm-home-box"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={cat === 'all' ? '眼下没有要你拍板的。' : '这一类没有要你拍板的。'} /></div>}
      {shown.now.length > 0 && <>
        <div className="wm-sec-h"><h3>等你拍板</h3><span className="wm-sec-n" data-testid="attention-now-n">{shown.now.length}</span></div>
        <div className="wm-decisions" data-testid="attention-now">{shown.now.map(card)}</div>
      </>}
      {shown.proxy.length > 0 && <>
        <div className="wm-sub-h">别人的事，你可以代办<span className="wm-sec-n">{shown.proxy.length}</span></div>
        <div className="wm-decisions" data-testid="attention-proxy">{shown.proxy.map(card)}</div>
      </>}
      {shown.elsewhere.length > 0 && <>
        <div className="wm-sub-h">要到别处处理的<span className="wm-sec-n">{shown.elsewhere.length}</span></div>
        <div className="wm-decisions" data-testid="attention-elsewhere">{shown.elsewhere.map(card)}</div>
      </>}
    </div>
  </WmPage>;
}
