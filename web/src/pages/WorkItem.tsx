/** 事项页（阶段八 8d）：一件事项从头到尾在这一页看清——现在卡在哪、谁在承接、进展和拆出的子项、等你处理的、
 *  席位的消息与回复、结果和依据、时间线。
 *  数据来自 GET /api/work-items/:id：管理员看全部，登录的人只看自己建立的。
 *  阶段七 R2：席位发来的消息落在「对话」里（不进「关注」）：打开页面时有未读就标成已读，每条可回复（同一 context 发回那个团队）。
 *  等你处理的（席位提问、等验收、过目放行）取自 GET /api/attention 里链接到这件事项的条目：给不给答法由各来源的守卫决定，
 *  答复走和「关注」页同一套入口；你看不到的这里也没有。
 *  日志只增不改：每条事实一行；被拒的（表里没有、终态之后才到）也留一行「收到，未采信」，带原因。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, App, Badge, Button, Card, Col, Descriptions, Empty, Flex, Input, List, Radio, Row, Segmented, Space, Tag, Timeline, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { adminActive, apiFetch, subscribeAdminToken } from '../admin-token';
import { answerChoices, answerRoute, describe, type AttentionItem, type LogRow } from '../attention-view';
import { getWorkItem, postAskAnswer, postCreatorDecision, postSeatMessageReply, postSeatMessagesRead } from '../api';
import { PROGRESS_STATE, artifactHref, artifactsFromLog, mergeArtifacts, askAnswerBody, initialChoice, lastAskAnswered, parseArtifacts, pendingFor, progressLine, stateHint, type Artifact, type SeatAsk, type SeatProgress } from '../work-item-view';

type Item = { id: string; title: string; state: string; created_by: string; created_at: string; updated_at: string; source_kind: string; source_ref: string; target_team: string; seat: string; eval: string; eval_reason: string; progress_summary: string; receipt_outcome: string; object: string; phase: string; open_asks: string; outputs: string; evidence: string };

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
type Data = { item: Item; log: LogRow[]; messages?: SeatMessage[]; unread?: number; progress?: SeatProgress | null; asks?: SeatAsk[] };
const MSG_STATUS: Record<SeatMessage['status'], { label: string; color: string }> = {
  unread: { label: '未读', color: 'blue' }, read: { label: '看过', color: 'default' }, replied: { label: '已回复', color: 'green' }, 'over-cap': { label: '超出上限', color: 'default' },
};
const SENT_REASON: Record<string, string> = { queued: '已发回团队', event_not_dispatched: '这件事项只通知、没派出去，回复只记在事项上', not_queued: '回复已记下，但没有可发回的投递' };
const REPLY_ERROR: Record<string, string> = { text_required: '先写点什么', text_too_long: '太长了，最多 4000 字', seat_message_not_found: '这条消息不在了', seat_message_not_open: '这条消息已经回复过或超出上限，不能再回复', work_items_cross_origin_denied: '请从市场页面里操作（跨站请求被拒）', work_items_principal_not_active: '你的账号还没启用，不能回复', work_item_creator_not_eligible: '这件事项不归你处理' };

/** 等你处理的：答法、要填的东西和「关注」页一致（各来源自己定，入口原样转交） */
const CATEGORY: Record<string, { label: string; color: string }> = { ask: { label: '席位提问', color: 'gold' }, accept: { label: '等验收', color: 'green' }, glance: { label: '过目', color: 'default' }, review: { label: '审核', color: 'blue' }, grant: { label: '授权', color: 'purple' } };
const ANSWER: Record<string, string> = { answer: '答复', verify: '验收通过', return: '退回', release: '放行', withdraw: '撤回' };
const FIELDS: Record<string, Record<string, { key: string; label: string; required: boolean }>> = {
  'seat-asks': { answer: { key: 'text', label: '你的答复（会发回提问的席位）', required: true } },
  'work-items': { return: { key: 'reason', label: '退回理由（席位会照这个改）', required: true } },
};

function PendingAction({ item, admin, onDone }: { item: AttentionItem; admin: boolean; onDone: () => void }) {
  const { message } = App.useApp();
  const choices = answerChoices(admin, item);
  const [answer, setAnswer] = useState(choices.length === 1 ? choices[0] : '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = answer ? FIELDS[item.source]?.[answer] : undefined;
  const submit = async () => {
    setBusy(true);
    try {
      if (answerRoute(admin, item) === 'creator') {
        const { status, body } = await postCreatorDecision(item.source_id, answer, text);
        if (status === 401) throw Error('请先登录');
        if (status < 200 || status >= 300) throw Error(body?.result?.error || body?.error || '处理失败');
        void message.success(body?.duplicate ? '这一条已经处理过了' : '已处理');
      } else {
        const r = await apiFetch('/api/attention/answer', { method: 'POST', body: JSON.stringify({ source: item.source, source_id: item.source_id, answer, input: field ? { [field.key]: text } : {} }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw Error(body?.result?.error || body?.error || '处理失败');
        void message.success(body?.duplicate ? '这一条已经处理过了' : '已处理');
      }
      setText(''); onDone();
    } catch (e) { void message.error(e instanceof Error ? e.message : '处理失败'); }
    finally { setBusy(false); }
  };
  const cat = CATEGORY[item.category] ?? { label: item.category, color: 'default' };
  return <Flex vertical gap="small" data-testid="pending-action">
    <Space wrap size={4}><Tag color={cat.color}>{cat.label}</Tag><Typography.Text strong>{item.title}</Typography.Text></Space>
    {choices.length === 0
      ? <Typography.Text type="secondary">这一条要管理员处理，你这里只能看。</Typography.Text>
      : <>
        {choices.length > 1 && <Segmented value={answer} onChange={(v) => setAnswer(String(v))} options={choices.map((a) => ({ label: ANSWER[a] ?? a, value: a }))} />}
        {field && <Input.TextArea aria-label={field.label} placeholder={field.label} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />}
        <Space>
          <Button type="primary" loading={busy} disabled={!answer || (!!field?.required && !text.trim())} onClick={() => void submit()}>{answer ? ANSWER[answer] ?? answer : '选一种答法'}</Button>
        </Space>
      </>}
  </Flex>;
}

const ASK_ERROR: Record<string, string> = {
  text_required: '选一个答法，或者写一句', answer_not_an_option: '这个答法不在选项里', seat_ask_not_pending: '这条提问已经不在等答复了（可能别人刚答过）',
  seat_ask_not_found: '这条提问不在这件事项上', seat_ask_id_invalid: '提问号不对', work_items_cross_origin_denied: '请从市场页面里操作（跨站请求被拒）',
  work_items_principal_not_active: '你的账号还没启用，不能答复',
};

function AskRow({ itemId, ask, onDone }: { itemId: string; ask: SeatAsk; onDone: () => void }) {
  const { message } = App.useApp();
  const [choice, setChoice] = useState(initialChoice(ask));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const body = askAnswerBody(choice, text);
  const submit = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const { status, body: r } = await postAskAnswer(itemId, ask.id, body);
      if (status === 401) throw Error('请先登录');
      if (status === 404 && !r.error) throw Error('你不能答这件事项上的提问');
      if (status < 200 || status >= 300) throw Error(ASK_ERROR[r.error ?? ''] ?? r.error ?? '答复失败');
      void message.success(r.duplicate ? '这条已经答过了' : r.result?.sent ? '已答复，发回了席位' : '已答复');
      setText(''); onDone();
    } catch (e) { void message.error(e instanceof Error ? e.message : '答复失败'); }
    finally { setBusy(false); }
  };
  return <List.Item data-testid="seat-ask">
    <Flex vertical gap="small" className="wm-w-full">
      <Space wrap size={6}>
        <Typography.Text strong>{ask.question || '（没写问题）'}</Typography.Text>
        {ask.status === 'answered' && <Tag color="green">已答复</Tag>}
        {ask.status === 'closed' && <Tag>已合上</Tag>}
        <Typography.Text type="secondary">{ask.asked_by}</Typography.Text><RelTime value={ask.at} />
      </Space>
      {ask.status === 'answered' && <Typography.Text>答：{ask.answer}<Typography.Text type="secondary">（{ask.answered_by}{ask.answered_at ? ' · ' : ''}</Typography.Text>{ask.answered_at && <RelTime value={ask.answered_at} />}<Typography.Text type="secondary">）</Typography.Text></Typography.Text>}
      {ask.status === 'closed' && <Typography.Text type="secondary">没人答，后来的提问、接单或结果把它合上了。</Typography.Text>}
      {ask.status === 'open' && <>
        {ask.options.length > 0 && <Radio.Group value={choice} onChange={(e) => setChoice(String(e.target.value))} optionType="button" buttonStyle="solid" data-testid="seat-ask-options"
          options={ask.options.map((o) => ({ label: o === ask.default ? `${o}（缺省）` : o, value: o }))} />}
        <Input.TextArea aria-label="答复" autoSize={{ minRows: 1, maxRows: 6 }} maxLength={4000} value={text} disabled={!!choice}
          placeholder={ask.options.length ? (choice ? '已选了答法；要自己写，先取消选择' : '或者自己写一句') : '写下你的答复（会发回提问的席位）'} onChange={(e) => setText(e.target.value)} />
        <Space>
          <Button type="primary" loading={busy} disabled={!body} onClick={() => void submit()}>答复</Button>
          {choice && <Button onClick={() => setChoice('')}>取消选择</Button>}
        </Space>
      </>}
    </Flex>
  </List.Item>;
}

function SeatMessages({ itemId, messages, onChanged }: { itemId: string; messages: SeatMessage[]; onChanged: () => void }) {
  const { message } = App.useApp();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const reply = async (m: SeatMessage) => {
    const text = (drafts[m.id] ?? '').trim();
    if (!text) return;
    setBusy(m.id);
    try {
      const { status, body } = await postSeatMessageReply(itemId, m.id, text);
      if (status === 401) throw Error('请先登录');
      if (status === 404 && !body.error) throw Error('你不能回复这件事项上的消息');
      if (status !== 200) throw Error(REPLY_ERROR[body.error ?? ''] ?? body.error ?? '回复失败');
      void message.success(SENT_REASON[body.reason ?? ''] ?? '已回复');
      setDrafts((d) => ({ ...d, [m.id]: '' }));
      onChanged();
    } catch (e) { void message.error(e instanceof Error ? e.message : '回复失败'); }
    finally { setBusy(null); }
  };
  if (!messages.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="席位还没发来消息" />;
  return <List itemLayout="vertical" size="small" dataSource={messages} rowKey="id" renderItem={(m) => <List.Item data-testid="seat-message">
    <Space wrap size={4}>
      <Typography.Text strong>{m.sender || m.peer}</Typography.Text>
      <Tag color={MSG_STATUS[m.status].color}>{MSG_STATUS[m.status].label}</Tag>
      <RelTime value={m.at} />
    </Space>
    <Typography.Paragraph className="wm-m-0 wm-prewrap" ellipsis={{ rows: 6, expandable: 'collapsible', symbol: (open) => (open ? '收起' : '展开全文') }}>{m.text}{m.truncated ? '（已截断）' : ''}</Typography.Paragraph>
    {(m.status === 'unread' || m.status === 'read') && <Space.Compact block>
      <Input.TextArea aria-label="回复" autoSize={{ minRows: 1, maxRows: 6 }} maxLength={4000} placeholder="回复这条消息（发回这个团队）" value={drafts[m.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [m.id]: e.target.value }))} />
      <Button type="primary" loading={busy === m.id} disabled={!(drafts[m.id] ?? '').trim()} onClick={() => void reply(m)}>回复</Button>
    </Space.Compact>}
  </List.Item>} />;
}

function Artifacts({ list, empty }: { list: Artifact[]; empty: string }) {
  if (!list.length) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return <List size="small" dataSource={list} rowKey={(a) => `${a.kind}:${a.id}`} renderItem={(a) => {
    const href = artifactHref(a);
    return <List.Item data-testid="artifact">
      <Space size={6}><Tag>{a.kind}</Tag>{href ? <Link to={href}>{a.id}</Link> : <Typography.Text className="wm-mono">{a.id}</Typography.Text>}</Space>
    </List.Item>;
  }} />;
}

const REJECTED: Record<string, string> = { not_allowed: '这时候不该有这条事实', terminal: '事项已经结束之后才到' };
const stateTag = (s: string) => <Tag color={STATE[s]?.color ?? 'default'}>{STATE[s]?.label ?? s}</Tag>;

export default function WorkItem() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const [data, setData] = useState<Data | null>(null);
  const [pending, setPending] = useState<AttentionItem[]>([]);
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
      // 等你处理的：读不到（没登录、来源守卫不给）就当没有，事项本身照看
      try {
        const r = await apiFetch('/api/attention');
        const v = await r.json().catch(() => ({})) as { items?: AttentionItem[] };
        setPending(r.ok ? pendingFor(v.items ?? [], id) : []);
      } catch { setPending([]); }
    } catch (e) { setData(null); setPending([]); setError(e instanceof Error ? e.message : '读取失败'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const item = data?.item;
  const asks = data?.asks;
  // 详情带了 asks（阶段七）就以它为准：在这里答，「关注」里的同一条提问不再重复列
  const shownPending = asks ? pending.filter((p) => p.source !== 'seat-asks') : pending;
  const openAsks = asks ? asks.filter((a) => a.status === 'open').length : 0;
  const hint = item ? stateHint(item.state, item.seat, asks ? openAsks === 0 && asks.length > 0 : lastAskAnswered(data?.log ?? [])) : null;
  const progress = data?.progress ?? null;
  // 结果：事项的 outputs 列（现在还没人写）加上日志里回执带来的产物，去重
  const outputs = mergeArtifacts(parseArtifacts(item?.outputs), artifactsFromLog(data?.log ?? []));
  const evidence = parseArtifacts(item?.evidence);
  return <WmPage title={item?.title ?? '事项'} detail={item?.title} onBack={() => navigate('/work-items')}
    extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>}>
    {error && <Alert type="error" showIcon message={error} data-testid="work-item-error" />}
    {item && <Row gutter={16}>
      <Col span={16}>
        <Flex vertical gap="middle">
          <Card title={<Space>{stateTag(item.state)}<span>{item.title}</span></Space>} data-testid="work-item-summary">
            <Flex vertical gap="small">
              {hint && <Alert type={hint.type} showIcon message={hint.text} data-testid="work-item-hint" />}
              <Descriptions column={2} size="small" items={[
                { key: 'seat', label: '承接', children: item.seat || <Typography.Text type="secondary">还没有席位接手</Typography.Text> },
                { key: 'team', label: '派给', children: item.target_team || '—' },
                { key: 'by', label: '建立人', children: item.created_by },
                { key: 'obj', label: '对象 / 阶段', children: [item.object, item.phase].filter(Boolean).join(' / ') || '—' },
                { key: 'eval', label: '接单判断', children: item.eval ? `${item.eval}${item.eval_reason ? `（${item.eval_reason}）` : ''}` : '—' },
                { key: 'at', label: '最近变化', children: <RelTime value={item.updated_at} /> },
              ]} />
            </Flex>
          </Card>
          {asks && asks.length > 0 && <Card size="small" title={<Space>席位提问{openAsks > 0 && <Badge count={openAsks} title="在等你答复" />}</Space>} data-testid="seat-asks">
            <List size="small" dataSource={asks} rowKey="id" renderItem={(a) => <AskRow itemId={id} ask={a} onDone={() => void load()} />} />
          </Card>}
          {shownPending.length > 0 && <Card size="small" title={<Space>等你处理<Badge count={shownPending.length} /></Space>} data-testid="work-item-pending">
            <Flex vertical gap="middle">{shownPending.map((p) => <PendingAction key={`${p.source}:${p.source_id}`} item={p} admin={admin} onDone={() => void load()} />)}</Flex>
          </Card>}
          {progress && <Card size="small" title="正在处理" data-testid="work-item-progress">
            <Flex vertical gap="small">
              <Space wrap size={6}><Typography.Text strong>{progressLine(progress)}</Typography.Text>{progress.by && <Typography.Text type="secondary">{progress.by}</Typography.Text>}<RelTime value={progress.at || progress.received_at} /></Space>
              {progress.summary && <Typography.Paragraph className="wm-m-0">{progress.summary}</Typography.Paragraph>}
              {progress.tickets.length > 0 && <List size="small" header={<Typography.Text type="secondary">拆出的子项 {progress.tickets.length} 件</Typography.Text>} dataSource={progress.tickets} rowKey="id"
                renderItem={(t) => <List.Item data-testid="work-item-ticket" extra={<Tag>{PROGRESS_STATE[t.state] ?? t.state}{t.outcome ? ` · ${t.outcome}` : ''}</Tag>}>
                  <Space size={6}><span>{t.title || t.id}</span>{t.seat && <Typography.Text type="secondary">{t.seat}</Typography.Text>}</Space>
                </List.Item>} />}
            </Flex>
          </Card>}
          <Card size="small" data-testid="seat-messages"
            title={<Space>对话{(data?.unread ?? 0) > 0 && <Badge count={data?.unread} title="未读的席位消息" />}</Space>}>
            <SeatMessages itemId={id} messages={data?.messages ?? []} onChanged={() => void load()} />
          </Card>
          <Card title="时间线" size="small">
            {data!.log.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有记录" /> : <Timeline items={data!.log.map((row) => ({
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
          </Card>
        </Flex>
      </Col>
      <Col span={8}>
        <Flex vertical gap="middle">
          <Card size="small" title={`结果${outputs.length ? ` ${outputs.length}` : ''}`} data-testid="work-item-outputs">
            <Flex vertical gap="small">
              {item.receipt_outcome && <Space size={6}><Typography.Text type="secondary">回执</Typography.Text><Tag>{item.receipt_outcome}</Tag></Space>}
              <Artifacts list={outputs} empty="还没有产出" />
            </Flex>
          </Card>
          <Card size="small" title={`依据${evidence.length ? ` ${evidence.length}` : ''}`}><Artifacts list={evidence} empty="还没有依据" /></Card>
          <Card size="small" title="细节">
            <Descriptions column={1} size="small" items={[
              { key: 'id', label: '事项号', children: <Typography.Text copyable className="wm-num">{item.id}</Typography.Text> },
              { key: 'src', label: '来源', children: `${item.source_kind}${item.source_ref ? ` · ${item.source_ref}` : ''}` },
              { key: 'created', label: '建立', children: <RelTime value={item.created_at} /> },
            ]} />
          </Card>
        </Flex>
      </Col>
    </Row>}
  </WmPage>;
}
