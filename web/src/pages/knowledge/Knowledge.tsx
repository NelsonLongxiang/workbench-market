/** 经验库（照产品化原型 3fbfd0b 的 #/knowledge）：从事项里沉淀下来的依据、经验、方法、检查。
 *  数据来自 GET /api/knowledge（#717，只含这个人看得到的，新的在前）。顶上那一句照原型；下面按四类筛（地址带 ?k=），一条一行，点了看详情。
 *  这个实例没接上经验库的来源：中性地说「经验库未接入」；经验库还没同步成过：整页说「还在准备」；最近一轮没同步上：列表照常，上面轻提示可能不是最新的。读不到按状态码说（knowledge-view.ts 的 problemOf）。
 *  条目的编号只用在地址里，不写在页面的字上。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Empty, List, Segmented, Skeleton, Space, Tag, theme, Typography } from 'antd';
import { BookOutlined, BulbOutlined, CheckOutlined, SafetyOutlined } from '@ant-design/icons';
import WmPage from '../../components/WmPage';
import RelTime from '../../components/RelTime';
import { getKnowledge, getProjectDepts } from '../../api';
import {
  KNOWLEDGE_EMPTY, KNOWLEDGE_INTRO, KNOWLEDGE_KINDS, SOURCE_DEGRADED, SOURCE_NOT_CONNECTED, SOURCE_NOT_READY, asList, countsOf, emptyKindText, itemsOf, kindLabel, problemOf, statusOf, tabFromQuery,
  type KnowledgeItem, type KnowledgeKind, type KnowledgeSource, type KnowledgeTab,
} from '../../knowledge-view';

export const KIND_ICON: Record<KnowledgeKind, ReactNode> = { claim: <SafetyOutlined />, kb: <BookOutlined />, skill: <BulbOutlined />, verify: <CheckOutlined /> };
const KIND_COLOR: Record<string, string> = { claim: 'green', kb: 'blue', skill: 'purple', verify: 'cyan' };
export const kindTag = (kind: string) => <Tag color={KIND_COLOR[kind] ?? 'default'} data-testid="kn-item-kind">{kindLabel(kind)}</Tag>;
const TONE_COLOR: Record<string, string | undefined> = { success: 'green', error: 'red', warning: 'orange', default: undefined };
export const statusTag = (status: string | null) => { const s = statusOf(status); return s ? <Tag color={TONE_COLOR[s.tone]} data-testid="kn-item-status">{s.text}</Tag> : null; };

type State = { phase: 'loading' } | { phase: 'ok'; items: KnowledgeItem[]; source: KnowledgeSource } | { phase: 'error'; status: number };

export default function Knowledge() {
  const { token } = theme.useToken();
  // 底色用设计档位（tokens.css）：antd 主题里的 colorSuccessBg 这类在本站是灰的，不合原型的浅底。紫色没有档位，用 antd 的紫色预设
  const tone = { success: ['var(--wm-color-success-bg)', 'var(--wm-color-success)'], info: ['var(--wm-color-info-bg)', 'var(--wm-color-info)'], purple: [token['purple-1'], token['purple-6']] } as const;
  const [q, setQ] = useSearchParams();
  const tab = tabFromQuery(q.get('k'));
  const [s, setS] = useState<State>({ phase: 'loading' });
  const load = useCallback(async () => {
    setS({ phase: 'loading' });
    const r = await getKnowledge();
    setS(r.status === 200 ? { phase: 'ok', ...asList(r.body) } : { phase: 'error', status: r.status });
  }, []);
  useEffect(() => { void load(); }, [load]);
  // 「项目对应的部门」的入口：只给读得了那张表的人（接口回 200 的，管理层和属主），别人连入口都没有
  const [canProjects, setCanProjects] = useState(false);
  useEffect(() => { let live = true; void getProjectDepts().then((r) => { if (live) setCanProjects(r.status === 200); }); return () => { live = false; }; }, []);

  const kinds = <List size="small" dataSource={KNOWLEDGE_KINDS} rowKey="key" renderItem={(k) => (
    <List.Item data-testid="kn-kind" data-kind={k.key}>
      <List.Item.Meta
        avatar={<span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: token.controlHeight, height: token.controlHeight, borderRadius: token.borderRadius, background: tone[k.tone][0], color: tone[k.tone][1] }}>{KIND_ICON[k.key]}</span>}
        title={k.label}
        description={k.meaning} />
    </List.Item>
  )} />;

  let body: ReactNode;
  if (s.phase === 'loading') body = <Card data-testid="kn-loading"><Skeleton active paragraph={{ rows: 5 }} /></Card>;
  else if (s.phase === 'error') {
    const p = problemOf(s.status, 'list')!;
    body = <Alert type={p.retry ? 'warning' : 'info'} showIcon data-testid="kn-problem" message={p.text} action={p.retry ? <Button size="small" onClick={() => void load()}>再试一次</Button> : undefined} />;
  } else if (s.source === 'not_connected') {
    // 没接上不是出错：中性的空态，不用警示色、不给「再试一次」
    body = <Card data-testid="kn-not-connected"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={SOURCE_NOT_CONNECTED} />{kinds}</Card>;
  } else if (s.source === 'not_ready') {
    body = <Card data-testid="kn-not-ready"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={SOURCE_NOT_READY} />{kinds}</Card>;
  } else if (s.items.length === 0) {
    body = <Card data-testid="kn-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={KNOWLEDGE_EMPTY} />{kinds}</Card>;
  } else {
    const counts = countsOf(s.items);
    const shown = itemsOf(s.items, tab);
    body = <Space direction="vertical" size={16} className="wm-w-full">
      {s.source === 'degraded' && <Alert type="info" showIcon data-testid="kn-degraded" message={SOURCE_DEGRADED} />}
      <Segmented<KnowledgeTab> value={tab} data-testid="kn-tabs" onChange={(v) => setQ(v === 'all' ? {} : { k: v })}
        options={[{ label: `全部 ${counts.all}`, value: 'all' }, ...KNOWLEDGE_KINDS.map((k) => ({ label: `${k.label} ${counts[k.key]}`, value: k.key }))]} />
      {shown.length === 0
        ? <Card data-testid="kn-kind-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyKindText(tab)} /></Card>
        : <Card size="small" data-testid="kn-list"><List dataSource={shown} rowKey="key" renderItem={(x) => (
          <List.Item data-testid="kn-item">
            <List.Item.Meta
              title={<Space size={8} wrap>{kindTag(x.kind)}<Link to={`/knowledge/${encodeURIComponent(x.key)}`} data-testid="kn-item-title">{x.title}</Link>{statusTag(x.status)}</Space>}
              description={<Space direction="vertical" size={4} className="wm-w-full">
                {x.summary && <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{x.summary}</Typography.Paragraph>}
                <Space size={8} wrap className="wm-caption">
                  {x.scope_label && <Typography.Text type="secondary" className="wm-caption" data-testid="kn-item-scope">{x.scope_label}</Typography.Text>}
                  {x.tags.slice(0, 3).map((t) => <Tag key={t} bordered={false}>{t}</Tag>)}
                  <RelTime value={x.updated || x.created} />
                </Space>
              </Space>} />
          </List.Item>
        )} /></Card>}
    </Space>;
  }

  return <WmPage extra={canProjects ? <Link to="/knowledge/projects" data-testid="kn-projects-link"><Button type="text" size="small">项目对应的部门</Button></Link> : undefined}>
    <div className="wm-reading">
      <Typography.Paragraph className="wm-page-intro" data-testid="kn-intro">{KNOWLEDGE_INTRO}</Typography.Paragraph>
      {body}
    </div>
  </WmPage>;
}
