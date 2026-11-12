/**
 * 工作台市场（照产品化原型 3fbfd0b 的 #/market）：一个入口里按「工作台 / 流程 / 技能」分类浏览，卡片三列。
 * 原来分散的三页并进来：/market 的工作台、/sops 的已发布流程、/skills 的技能。原型里的「连接器」和「质量评级」现在没有数据来源，不出现。
 * 管理（只对管理员露出）：工作台的登记、停用、删除、检测在 /market/manage（原来的表格）；流程的发布、停用、绑定在 /sops，技能的版本链在 /skills（原来的页面）。
 * 判断逻辑在 web/src/market-view.ts（有单测）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Dropdown, Empty, Skeleton } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import RelTime from '../../components/RelTime';
import WmPage from '../../components/WmPage';
import { getMarketRunningSops, getMarketSkills, getMarketSops, getMarketWorkbenches } from '../../api';
import { adminActive, subscribeAdminToken } from '../../admin-token';
import { MARKET_TABS, NO_DESCRIPTION, cardsOf, emptyText, extraTags, runningBySlug, skillCards, sopCards, sourceProblem, tabFromQuery, workbenchCards } from '../../market-view';
import type { MarketCard, MarketKind, MarketTab, SourceResult } from '../../market-view';

type Sources = { wb: SourceResult | null; sop: SourceResult | null; skill: SourceResult | null; running: SourceResult | null };
const NONE: Sources = { wb: null, sop: null, skill: null, running: null };
const ok = (r: SourceResult | null) => !!r && r.status >= 200 && r.status < 300;

function Card({ c }: { c: MarketCard }) {
  return (
    <Link to={c.href} className="wm-mkt-card" data-testid="mkt-card" data-kind={c.kind}>
      <div className="wm-mkt-card-head">
        <span className={c.initial ? 'wm-mkt-ic wm-mkt-ic-initial' : 'wm-mkt-ic'} aria-hidden>{c.icon}</span>
        <span className="wm-mkt-name-box">
          <b className="wm-mkt-name">{c.name}</b>
          {c.caption && <span className="wm-mkt-caption">{c.caption}</span>}
        </span>
      </div>
      {c.description ? <div className="wm-mkt-desc">{c.description}</div> : <div className="wm-mkt-desc wm-mkt-desc-none">{NO_DESCRIPTION}</div>}
      {extraTags(c).length > 0 && <div className="wm-mkt-tags">{extraTags(c).map((t) => <span key={t} className="wm-mkt-tag">{t}</span>)}</div>}
      <div className="wm-mkt-foot">
        <span className="wm-mkt-usage">{c.usage}{c.checkedAt && <> · <RelTime value={c.checkedAt} /></>}</span>
        <span className="wm-mkt-go">{c.action} →</span>
      </div>
    </Link>
  );
}

export default function Market() {
  const [params, setParams] = useSearchParams();
  const tab = tabFromQuery(params.get('k'));
  const [src, setSrc] = useState<Sources>(NONE);
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState(adminActive());

  useEffect(() => subscribeAdminToken(() => setAdmin(adminActive())), []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([getMarketWorkbenches(), getMarketSops(), getMarketSkills(), getMarketRunningSops()]).then(([wb, sop, skill, running]) => {
      if (!live) return;
      setSrc({ wb, sop, skill, running });
      setLoading(false);
    });
    return () => { live = false; };
  }, [admin]);

  const cards = useMemo(() => [
    ...(ok(src.wb) ? workbenchCards(src.wb!.body) : []),
    ...(ok(src.sop) ? sopCards(src.sop!.body, ok(src.running) ? runningBySlug(src.running!.body) : null) : []),
    ...(ok(src.skill) ? skillCards(src.skill!.body) : []),
  ], [src]);
  const shown = cardsOf(cards, tab);
  const problems = ([['工作台', src.wb], ['流程', src.sop], ['技能', src.skill]] as [MarketKind, SourceResult | null][])
    .filter(([k]) => tab === '全部' || tab === k)
    .map(([k, r]) => ({ k, p: sourceProblem(k, r) }))
    .filter((x) => x.p);
  const pick = (t: MarketTab) => setParams(t === '全部' ? {} : { k: t }, { replace: true });

  return (
    <WmPage extra={admin ? (
      <Dropdown trigger={['click']} menu={{ items: [
        { key: 'wb', label: <Link to="/market/manage">管理工作台</Link> },
        { key: 'sop', label: <Link to="/sops">流程的发布与绑定</Link> },
        { key: 'skill', label: <Link to="/skills">技能的版本</Link> },
      ] }}>
        <Button data-testid="mkt-manage">管理 <DownOutlined /></Button>
      </Dropdown>
    ) : undefined}>
      <div className="wm-mkt-tabs" role="tablist">
        {MARKET_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'wm-mkt-tab on' : 'wm-mkt-tab'} data-testid={`mkt-tab-${t}`} onClick={() => pick(t)}>
            {t}
          </button>
        ))}
      </div>
      {problems.map(({ k, p }) => <Alert key={k} className="wm-mkt-alert" type={p!.type} showIcon message={p!.text} />)}
      {loading ? <Skeleton active /> : shown.length > 0
        ? <div className="wm-mkt-grid">{shown.map((c) => <Card key={c.key} c={c} />)}</div>
        : problems.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText(tab, admin)} />}
    </WmPage>
  );
}
