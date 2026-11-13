/**
 * 工作台市场（照产品化原型 3fbfd0b 的 #/market）：一个入口里按「工作台 / 流程 / 技能 / 连接器」分类浏览，卡片三列。
 * 原来分散的三页并进来：/market 的工作台、/sops 的已发布流程、/skills 的技能；「连接器」（MCP 上游）只给管理员。原型里的「质量评级」没有数据来源，不出现。
 * 卡片点了照原型直接「打开」；工作台卡片右下「打开 →」旁边另有一个次要的「详情」入口，去 /market/wb/:id（右上角是原型里质量评级那一格，不放东西）。
 * 管理（只对管理员露出）：工作台的登记、停用、删除、检测在 /market/manage（原来的表格）；流程的发布、停用、绑定在 /sops，技能的版本链在 /skills（原来的页面）。
 * 判断逻辑在 web/src/market-view.ts（有单测）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import './market.css';
import { Alert, Button, Dropdown, Empty, Skeleton } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import RelTime from '../../components/RelTime';
import WmPage from '../../components/WmPage';
import { getMarketConnectors, getMarketRunningSops, getMarketSkills, getMarketSops, getMarketWorkbenches } from '../../api';
import { adminActive, subscribeAdminToken } from '../../admin-token';
import { NO_DESCRIPTION, cardTags, cardsOf, connectorCards, emptyText, runningBySlug, skillCards, sopCards, sourceProblem, tabFromQuery, tabsFor, workbenchCards } from '../../market-view';
import type { MarketCard, MarketKind, MarketTab, SourceResult } from '../../market-view';

type Sources = { wb: SourceResult | null; sop: SourceResult | null; skill: SourceResult | null; running: SourceResult | null; conn: SourceResult | null };
const NONE: Sources = { wb: null, sop: null, skill: null, running: null, conn: null };
const ok = (r: SourceResult | null) => !!r && r.status >= 200 && r.status < 300;

/** 详情入口：只有工作台有详情页（/market/wb/:id）。放在卡片外面一层，免得链接套链接 */
const detailHref = (c: MarketCard): string | null => (c.kind === '工作台' && c.key.startsWith('wb-') ? `/market/wb/${c.key.slice(3)}` : null);

function Card({ c, tab }: { c: MarketCard; tab: MarketTab }) {
  const detail = detailHref(c);
  const tags = cardTags(c, tab);
  return (
    <div className="wm-mkt-cell">
    <Link to={c.href} className="wm-mkt-card" data-testid="mkt-card" data-kind={c.kind}>
      <div className="wm-mkt-card-head">
        <span className={c.initial ? 'wm-mkt-ic wm-mkt-ic-initial' : 'wm-mkt-ic'} aria-hidden>{c.icon}</span>
        <span className="wm-mkt-name-box">
          <b className="wm-mkt-name">{c.name}</b>
          {c.caption && <span className="wm-mkt-caption">{c.caption}</span>}
        </span>
      </div>
      {c.description ? <div className="wm-mkt-desc">{c.description}</div> : <div className="wm-mkt-desc wm-mkt-desc-none">{NO_DESCRIPTION}</div>}
      {tags.length > 0 && <div className="wm-mkt-tags">{tags.map((t) => <span key={t} className="wm-mkt-tag">{t}</span>)}</div>}
      <div className="wm-mkt-foot">
        <span className="wm-mkt-usage">{c.usage}{c.checkedAt && <> · <RelTime value={c.checkedAt} /></>}</span>
        <span className="wm-mkt-go">{c.action} →</span>
      </div>
    </Link>
    {detail && <Link to={detail} className="wm-mkt-detail" aria-label={`${c.name}的详情`} data-testid="mkt-detail">详情</Link>}
    </div>
  );
}

export default function Market() {
  const [params, setParams] = useSearchParams();
  const [admin, setAdmin] = useState(adminActive());
  // 连接器只给管理员：别人地址里带 ?k=连接器 也落「全部」
  const asked = tabFromQuery(params.get('k'));
  const tab: MarketTab = tabsFor(admin).includes(asked) ? asked : '全部';
  const [src, setSrc] = useState<Sources>(NONE);
  const [loading, setLoading] = useState(true);

  useEffect(() => subscribeAdminToken(() => setAdmin(adminActive())), []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    // 连接器只给管理员去问（不是管理员的不发这个请求）
    void Promise.all([getMarketWorkbenches(), getMarketSops(), getMarketSkills(), getMarketRunningSops(), admin ? getMarketConnectors() : Promise.resolve(null)]).then(([wb, sop, skill, running, conn]) => {
      if (!live) return;
      setSrc({ wb, sop, skill, running, conn });
      setLoading(false);
    });
    return () => { live = false; };
  }, [admin]);

  const cards = useMemo(() => [
    ...(ok(src.wb) ? workbenchCards(src.wb!.body) : []),
    ...(ok(src.sop) ? sopCards(src.sop!.body, ok(src.running) ? runningBySlug(src.running!.body) : null) : []),
    ...(ok(src.skill) ? skillCards(src.skill!.body) : []),
    ...(admin && ok(src.conn) ? connectorCards(src.conn!.body) : []),
  ], [src, admin]);
  const shown = cardsOf(cards, tab);
  const problems = ([['工作台', src.wb], ['流程', src.sop], ['技能', src.skill], ...(admin ? [['连接器', src.conn]] : [])] as [MarketKind, SourceResult | null][])
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
        {tabsFor(admin).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'wm-mkt-tab on' : 'wm-mkt-tab'} data-testid={`mkt-tab-${t}`} onClick={() => pick(t)}>
            {t}
          </button>
        ))}
      </div>
      {problems.map(({ k, p }) => <Alert key={k} className="wm-mkt-alert" type={p!.type} showIcon message={p!.text} />)}
      {loading ? <Skeleton active /> : shown.length > 0
        ? <div className="wm-mkt-grid">{shown.map((c) => <Card key={c.key} c={c} tab={tab} />)}</div>
        : problems.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText(tab, admin)} />}
    </WmPage>
  );
}
