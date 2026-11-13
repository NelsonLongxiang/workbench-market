/** 经验库的一条（/knowledge/:key）：GET /api/knowledge/:key（#717）给 { item, body（markdown）, evidence?（只有依据有） }。
 *  看不到的和不存在的同一个 404，一律写「没有这一条」；503 是暂时读不到，不当成空。条目编号只在地址里。
 *  正文用 react-markdown（不渲染原始 HTML）；依据的原文出处只认 http / https 的链接，在新标签页打开。 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import { Alert, Button, Card, Empty, List, Skeleton, Space, Tag, Typography } from 'antd';
import WmPage from '../../components/WmPage';
import RelTime from '../../components/RelTime';
import { getKnowledgeItem } from '../../api';
import { asItem, problemOf, safeUrl, stanceLabel, type KnowledgeEvidence, type KnowledgeItem as Item } from '../../knowledge-view';
import { kindTag, statusTag } from './Knowledge';

type State = { phase: 'loading' } | { phase: 'ok'; item: Item; body: string; evidence: KnowledgeEvidence[] } | { phase: 'error'; status: number };

const asEvidence = (v: unknown): KnowledgeEvidence[] => (Array.isArray(v) ? v.filter((e): e is KnowledgeEvidence => !!e && typeof e === 'object' && typeof (e as KnowledgeEvidence).quote === 'string') : []);

export default function KnowledgeItem() {
  const { key = '' } = useParams();
  const [s, setS] = useState<State>({ phase: 'loading' });
  const load = useCallback(async () => {
    setS({ phase: 'loading' });
    const r = await getKnowledgeItem(key);
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as { item?: unknown; body?: unknown; evidence?: unknown };
    const item = r.status === 200 ? asItem(b.item) : null;
    setS(item ? { phase: 'ok', item, body: typeof b.body === 'string' ? b.body : '', evidence: asEvidence(b.evidence) } : { phase: 'error', status: r.status === 200 ? 500 : r.status });
  }, [key]);
  useEffect(() => { void load(); }, [load]);

  if (s.phase === 'loading') return <WmPage trail={[{ title: '…' }]}><div className="wm-reading"><Card data-testid="kn-detail-loading"><Skeleton active paragraph={{ rows: 8 }} /></Card></div></WmPage>;
  if (s.phase === 'error') {
    const p = problemOf(s.status, 'detail')!;
    return <WmPage trail={[{ title: '一条经验' }]}>
      <div className="wm-reading" data-testid="kn-detail-problem">
        {s.status === 404
          ? <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={p.text}><Link to="/knowledge"><Button>回经验库</Button></Link></Empty></Card>
          : <Alert type={p.retry ? 'warning' : 'info'} showIcon message={p.text} action={p.retry ? <Button size="small" onClick={() => void load()}>再试一次</Button> : undefined} />}
      </div>
    </WmPage>;
  }
  const { item, body, evidence } = s;
  return <WmPage trail={[{ title: item.title }]}>
    <div className="wm-reading" data-testid="kn-detail">
      <Space direction="vertical" size={16} className="wm-w-full">
        <Card>
          <Space size={8} wrap>{kindTag(item.kind)}{statusTag(item.status)}{item.tags.map((t) => <Tag key={t} bordered={false}>{t}</Tag>)}</Space>
          <Typography.Title level={4} style={{ marginTop: 12 }} data-testid="kn-detail-title">{item.title}</Typography.Title>
          <Space size={12} wrap className="wm-caption">
            {item.scope_label && <Typography.Text type="secondary" className="wm-caption" data-testid="kn-detail-scope">谁能看：{item.scope_label}</Typography.Text>}
            <Typography.Text type="secondary" className="wm-caption">更新于 <RelTime value={item.updated || item.created} /></Typography.Text>
          </Space>
          {body
            ? <div className="wm-kn-body" data-testid="kn-detail-body"><Markdown>{body}</Markdown></div>
            : item.summary ? <Typography.Paragraph style={{ marginTop: 12 }} data-testid="kn-detail-body">{item.summary}</Typography.Paragraph> : null}
        </Card>
        {evidence.length > 0 && <Card size="small" title={`依据的原文 ${evidence.length}`} data-testid="kn-evidence">
          <List dataSource={evidence} renderItem={(e, i) => {
            const url = safeUrl(e.source?.url);
            return <List.Item key={i} data-testid="kn-evidence-row">
              <Space direction="vertical" size={4} className="wm-w-full">
                <Space size={8}>{stanceLabel(e.stance) && <Tag color={e.stance === 'refutes' ? 'red' : 'green'}>{stanceLabel(e.stance)}</Tag>}
                  {e.source?.title && (url ? <a href={url} target="_blank" rel="noopener noreferrer">{e.source.title}</a> : <Typography.Text type="secondary">{e.source.title}</Typography.Text>)}</Space>
                <blockquote className="wm-kn-quote">{e.quote}</blockquote>
                {e.note && <Typography.Text type="secondary">{e.note}</Typography.Text>}
              </Space>
            </List.Item>;
          }} />
        </Card>}
        <Link to="/knowledge" data-testid="kn-back">← 回经验库</Link>
      </Space>
    </div>
  </WmPage>;
}
