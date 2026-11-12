/** 全景（首页，产品化原型 #/home）：问候语 + 一句总结 → 对象 × 阶段的表 → 等你拍板。
 *  表：每条产品线一行、每个非终态阶段一列；走过的「已走完」、现在这一步「走到这一步」并标天数，有等你定的格子标红；
 *  点一格只看这条线这一步的事，再点回到全部。数据：生命周期只读接口（行和阶段）+「关注」（格子上的件数和下面的卡片）。
 *  生命周期没挂上时表这一块给空状态，下面的「等你拍板」照常。「安排一件事」等后端，先不放入口；「今天」没有可靠来源的格子不出现。 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, Skeleton, Tag, Typography } from 'antd';
import { CheckOutlined, PlusOutlined, DisconnectOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import DecisionCard from '../components/DecisionCard';
import ArrangeDrawer from '../components/ArrangeDrawer';
import { adminActive, subscribeAdminToken } from '../admin-token';
import { ATTENTION_CHANGED, getAttention, getAuthMe, getLifecycle } from '../api';
import { answerChoices, groupCards, type AttentionItem } from '../attention-view';
import { buildRows, splitRows, daysLabel, filterAttention, greeting, panoramaType, stageColumns, summaryLine, decideLine, downLine, DECIDE_DOWN, LINES_DOWN, toggleFocus, type Focus, type LcObject, type LcType } from '../home-view';

const MAX_PAGES = 10;

export default function Home() {
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const [name, setName] = useState<string | null>(null);
  const [type, setType] = useState<LcType | null>(null);
  const [objects, setObjects] = useState<LcObject[]>([]);
  const [lcState, setLcState] = useState<'loading' | 'ok' | 'none' | 'down'>('loading');
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  /** 身份服务连不上：等你拍板的事取不到，不能当成「没有」 */
  const [attDown, setAttDown] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const [arrange, setArrange] = useState(false);

  const loadAttention = useCallback(async () => {
    const r = await getAttention();
    setAttDown(r.identityDown);
    setAttention(r.status >= 200 && r.status < 300 ? r.items as AttentionItem[] : []);
  }, []);
  // 别处（侧栏、卡片）办完一件也跟着刷新
  useEffect(() => {
    const on = () => { void loadAttention(); };
    window.addEventListener(ATTENTION_CHANGED, on);
    return () => window.removeEventListener(ATTENTION_CHANGED, on);
  }, [loadAttention]);
  useEffect(() => { void loadAttention(); }, [loadAttention, admin]);
  useEffect(() => { void getAuthMe().then((m) => setName(m?.authenticated ? m.display_name || m.login || null : null)); }, []);
  useEffect(() => {
    void (async () => {
      const st = await getLifecycle<{ types: LcType[] }>('stages');
      if (st.identityDown) { setLcState('down'); return; }
      const t = st.body ? panoramaType(st.body.types) : null;
      if (!t) { setLcState('none'); return; }
      const all: LcObject[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const q: URLSearchParams = new URLSearchParams({ type: t.type, limit: '200', ...(cursor ? { cursor } : {}) });
        const r: { status: number; body: { items: LcObject[]; next_cursor: string | null } | null; identityDown?: boolean } = await getLifecycle<{ items: LcObject[]; next_cursor: string | null }>(`objects?${q}`);
        if (r.identityDown) { setLcState('down'); return; }
        if (!r.body) break;
        all.push(...r.body.items);
        cursor = r.body.next_cursor;
        if (!cursor) break;
      }
      setType(t); setObjects(all); setLcState('ok');
    })();
  }, []);

  const cols = type ? stageColumns(type) : [];
  const rows = useMemo(() => (type ? buildRows(type, objects, attention) : []), [type, objects, attention]);
  const { active, ended } = splitRows(rows);
  // 总结句按全部条目算（不随点格筛选变）：能当场办的才算「等你拍板」
  const all = groupCards(attention, (x) => answerChoices(admin, x));
  const cards = filterAttention(attention, focus);
  const { now, proxy, elsewhere } = groupCards(cards, (x) => answerChoices(admin, x));
  const card = (a: AttentionItem) => <DecisionCard key={`${a.source}:${a.source_id}`} item={a} admin={admin} onDone={() => undefined} />;
  const focusRow = focus ? rows.find((r) => r.id === focus.object) : null;
  const focusStage = focus ? cols.find((c) => c.code === focus.stage) : null;

  return <WmPage extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setArrange(true)} data-testid="arrange-open">安排一件事</Button>}>
    <div className="wm-home">
      <h1 className="wm-home-hi" data-testid="home-greeting">{greeting(new Date().getHours(), name)}</h1>
      <Typography.Paragraph type="secondary" className="wm-home-sum" data-testid="home-summary">
        {attDown ? downLine(lcState === 'ok' ? rows : null) : lcState === 'ok' ? summaryLine(rows, all.now.length, all.elsewhere.length, all.proxy.length) : decideLine(all.now.length, all.elsewhere.length, false, all.proxy.length)}
      </Typography.Paragraph>

      {lcState === 'loading' && <Skeleton active paragraph={{ rows: 4 }} />}
      {lcState === 'down' && <div className="wm-home-box wm-home-down" data-testid="home-lines-down"><DisconnectOutlined /><span>{LINES_DOWN}</span></div>}
      {lcState === 'none' && <div className="wm-home-box"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这里会显示公司正在走的每条线、各走到哪一步。" /></div>}
      {lcState === 'ok' && type && <>
        <div className="wm-grid" data-testid="home-grid" style={{ gridTemplateColumns: `200px repeat(${cols.length}, minmax(96px, 1fr))` }}>
          <div className="wm-grid-h"><b>{type.name}</b><span>一条线一行</span></div>
          {cols.map((c) => <div key={c.code} className="wm-grid-h"><b>{c.name}</b></div>)}
          {active.length === 0 && <div className="wm-grid-empty">还没有在走的线。</div>}
          {active.map((r) => <div key={r.id} className="wm-grid-row" data-testid="home-row">
            <div className="wm-grid-obj">
              <b title={r.id}>{r.label}</b>
              <span className="wm-caption">{daysLabel(r.days)}{r.flags.map((f) => <Tag key={f} className="wm-ml-1">{f}</Tag>)}</span>
            </div>
            {r.cells.map((c) => {
              const on = focus?.object === r.id && focus.stage === c.stage;
              const cls = ['wm-cell', `wm-cell-${c.state}`, c.pending ? 'wm-cell-pending' : '', on ? 'wm-cell-on' : ''].filter(Boolean).join(' ');
              return <button type="button" key={c.stage} className={cls} data-testid="home-cell" onClick={() => setFocus((f) => toggleFocus(f, { object: r.id, stage: c.stage }))}>
                {c.state === 'past' && <span className="wm-cell-done"><CheckOutlined /> 已走完</span>}
                {c.state === 'current' && <span className="wm-cell-cur">{r.terminal ? r.stageName : '走到这一步'}</span>}
                {c.state === 'future' && <span className="wm-cell-none">—</span>}
                {c.pending > 0 && <span className="wm-cell-badge">{c.pending} 件等你定</span>}
              </button>;
            })}
          </div>)}
        </div>
        {ended.length > 0 && <details className="wm-ended" data-testid="home-ended">
          <summary>已结束 {ended.length} 条</summary>
          <ul>{ended.map((r) => <li key={r.id}><b title={r.id}>{r.label}</b><span className="wm-caption">{r.stageName}</span></li>)}</ul>
        </details>}
        <Typography.Text type="secondary" className="wm-caption">点任意一格，下面只看这条线这一步的事；再点一次回到全部。</Typography.Text>
      </>}

      <div className="wm-sec-h">
        <h3>等你拍板</h3><span className="wm-sec-n" data-testid="home-decide-n">{attDown ? '暂时取不到' : now.length}</span>
        {focus && <Typography.Text type="secondary" className="wm-caption">只看 {focusRow?.label ?? focus.object} · {focusStage?.name ?? focus.stage}（<a onClick={() => setFocus(null)}>看全部</a> · <a onClick={() => setArrange(true)}>就这一步安排一件事</a>）</Typography.Text>}
        <Link to="/attention" className="wm-sec-more">全部 →</Link>
      </div>
      {attDown
        // 不用空态的图（那是「没有」的意思），写清是取不到
        ? <div className="wm-home-box wm-home-down" data-testid="home-decide-down"><DisconnectOutlined /><span>{DECIDE_DOWN}</span></div>
        : cards.length === 0
        ? <div className="wm-home-box"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={focus ? '这一步没有要你拍板的。' : '眼下没有要你拍板的。'} /></div>
        : <>
          {now.length > 0 && <div className="wm-decisions" data-testid="decisions-now">{now.map(card)}</div>}
          {proxy.length > 0 && <>
            <div className="wm-sub-h">别人的事，你可以代办<span className="wm-sec-n">{proxy.length}</span></div>
            <div className="wm-decisions" data-testid="decisions-proxy">{proxy.map(card)}</div>
          </>}
          {elsewhere.length > 0 && <>
            <div className="wm-sub-h">要到别处处理的<span className="wm-sec-n">{elsewhere.length}</span></div>
            <div className="wm-decisions" data-testid="decisions-elsewhere">{elsewhere.map(card)}</div>
          </>}
        </>}
    </div>
    <ArrangeDrawer open={arrange} onClose={() => setArrange(false)} preset={focus ? { object: focus.object, phase: focus.stage } : undefined}
      lines={active.map((r) => ({ id: r.id, label: r.label }))} stages={cols.map((c) => ({ code: c.code, name: c.name }))} />
  </WmPage>;
}
