/** 事项页（阶段八 8d）：一件事项的摘要，和直接按事项日志渲染的时间线。
 *  阶段七 R2：席位发来的消息落在这里的「对话」里（不进「关注」）：打开页面时有未读就标成已读，每条可回复（同一 context 发回那个团队）。
 *  数据来自 GET /api/work-items/:id：管理员看全部，登录的人只看自己建立的。
 *  日志只增不改：每条事实一行；被拒的（表里没有、终态之后才到）也留一行「收到，未采信」，带原因。 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Descriptions, Empty, Input, Space, Tag, Timeline, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import { describe, type LogRow } from '../attention-view';
import { getWorkItem, postSeatMessageReply, postSeatMessagesRead } from '../api';

type Item = { id: string; title: string; state: string; created_by: string; created_at: string; updated_at: string; source_kind: string; source_ref: string; target_team: string; eval: string; eval_reason: string; progress_summary: string; receipt_outcome: string; object: string; phase: string; open_asks: string };

export const STATE: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' }, held: { label: '搁置', color: 'default' }, delivered: { label: '已转交', color: 'blue' },
  accepted: { label: '已接手', color: 'cyan' }, progress: { label: '进行中', color: 'geekblue' }, waiting: { label: '在等外部', color: 'orange' },
  blocked: { label: '在问你', color: 'gold' }, ready: { label: '等验收', color: 'green' }, done: { label: '办完', color: 'success' },
  failed: { label: '没办成', color: 'error' }, dropped: { label: '放弃', color: 'default' }, cancelled: { label: '撤回', color: 'default' },
};
const FACT: Record<string, string> = {
  create: '建立', submit: '提交', release: '放行', withdraw: '撤回', delivery: '投递结果', eval: '接单判断', report: '进展上报', ask: '提问',
  receipt: '回执', verify: '验收', return: '退回', answer: '答复', note: '备注',
};
type SeatMessage = { id: number; sender: string; peer: string; text: string; truncated: boolean; at: string; status: 'unread' | 'read' | 'replied' | 'over-cap' };
type Data = { item: Item; log: LogRow[]; messages?: SeatMessage[]; unread?: number };
const MSG_STATUS: Record<SeatMessage['status'], { label: string; color: string }> = {
  unread: { label: '未读', color: 'blue' }, read: { label: '看过', color: 'default' }, replied: { label: '已回复', color: 'green' }, 'over-cap': { label: '超出上限', color: 'default' },
};
const SENT_REASON: Record<string, string> = { queued: '已发回团队', event_not_dispatched: '这件事项只通知、没派出去，回复只记在事项上', not_queued: '回复已记下，但没有可发回的投递' };

function SeatMessages({ itemId, messages, onChanged }: { itemId: string; messages: SeatMessage[]; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const reply = async (m: SeatMessage) => {
    const text = (drafts[m.id] ?? '').trim();
    if (!text) return;
    setBusy(m.id);
    try {
      const { status, body } = await postSeatMessageReply(itemId, m.id, text);
      if (status !== 200) throw Error(body.error || '回复失败');
      void message.success(SENT_REASON[body.reason ?? ''] ?? '已回复');
      setDrafts((d) => ({ ...d, [m.id]: '' }));
      onChanged();
    } catch (e) { void message.error(e instanceof Error ? e.message : '回复失败'); }
    finally { setBusy(null); }
  };
  return <Space direction="vertical" size="small" style={{ width: '100%' }}>
    {messages.map((m) => <div key={m.id} data-testid="seat-message">
      <Space wrap size={4}>
        <Typography.Text strong>{m.sender || m.peer}</Typography.Text>
        <Tag color={MSG_STATUS[m.status].color}>{MSG_STATUS[m.status].label}</Tag>
        <Typography.Text type="secondary">{m.at}</Typography.Text>
      </Space>
      <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}{m.truncated ? '（已截断）' : ''}</div>
      {(m.status === 'unread' || m.status === 'read') && <Space.Compact style={{ width: '100%', marginTop: 4 }}>
        <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} maxLength={4000} placeholder="回复这条消息（发回这个团队）" value={drafts[m.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [m.id]: e.target.value }))} />
        <Button type="primary" loading={busy === m.id} disabled={!(drafts[m.id] ?? '').trim()} onClick={() => void reply(m)}>回复</Button>
      </Space.Compact>}
    </div>)}
  </Space>;
}

const REJECTED: Record<string, string> = { not_allowed: '这时候不该有这条事实', terminal: '事项已经结束之后才到' };
const stateTag = (s: string) => <Tag color={STATE[s]?.color ?? 'default'}>{STATE[s]?.label ?? s}</Tag>;

export default function WorkItem() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { status, body } = await getWorkItem(id);
      if (status === 401) throw Error('请先登录');
      if (status === 404) throw Error('没有这件事项，或者你看不到它');
      if (status !== 200) throw Error((body as { error?: string })?.error || '读取失败');
      const d = body as Data;
      setData(d);
      // 打开就算看过：有未读才标（不是待决，只是提示）；标不了（没权限写）不影响看
      if ((d.unread ?? 0) > 0) void postSeatMessagesRead(id).catch(() => undefined);
    } catch (e) { setData(null); setError(e instanceof Error ? e.message : '读取失败'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const item = data?.item;
  return <WmPage title={item?.title ?? '事项'} onBack={() => navigate('/attention')}
    extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>}>
    <Space direction="vertical" size="middle" className="wm-reading">
      {error && <Alert type="error" showIcon message={error} />}
      {item && <Card title={<Space>{stateTag(item.state)}<span>{item.title}</span></Space>}>
        <Descriptions column={2} size="small" items={[
          { key: 'by', label: '建立人', children: item.created_by },
          { key: 'src', label: '来源', children: `${item.source_kind}${item.source_ref ? ` · ${item.source_ref}` : ''}` },
          { key: 'team', label: '承接', children: item.target_team || '—' },
          { key: 'eval', label: '接单判断', children: item.eval ? `${item.eval}${item.eval_reason ? `（${item.eval_reason}）` : ''}` : '—' },
          { key: 'progress', label: '最近进展', children: item.progress_summary || '—' },
          { key: 'receipt', label: '回执', children: item.receipt_outcome || '—' },
          { key: 'obj', label: '对象 / 阶段', children: [item.object, item.phase].filter(Boolean).join(' / ') || '—' },
          { key: 'at', label: '建立 / 最近变化', children: `${item.created_at} / ${item.updated_at}` },
        ]} />
      </Card>}
      {data && (data.messages?.length ?? 0) > 0 && <Card size="small" data-testid="seat-messages"
        title={<Space>席位消息{(data.unread ?? 0) > 0 && <Badge count={data.unread} title="未读的席位消息" />}</Space>}>
        <SeatMessages itemId={id} messages={data.messages ?? []} onChanged={() => void load()} />
      </Card>}
      {data && <Card title="时间线" size="small">
        {data.log.length === 0 ? <Empty /> : <Timeline items={data.log.map((row) => ({
          key: row.seq,
          color: row.rejected ? 'gray' : row.from_state !== row.to_state ? 'blue' : 'green',
          children: <div data-testid="timeline-row">
            <Space wrap size={4}>
              <Typography.Text strong>{FACT[row.fact] ?? row.fact}</Typography.Text>
              {row.from_state !== row.to_state ? <>{stateTag(row.from_state)}→{stateTag(row.to_state)}</> : null}
              {row.rejected && <Tag color="default">收到，未采信：{REJECTED[row.rejected] ?? row.rejected}</Tag>}
            </Space>
            <div><Typography.Text type="secondary">{row.at} · {row.actor || row.fact_source}</Typography.Text></div>
            {describe(row) && <div>{describe(row)}</div>}
          </div>,
        }))} />}
      </Card>}
    </Space>
  </WmPage>;
}
