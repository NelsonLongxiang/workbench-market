/** 事项页（阶段八 8d）：一件事项从头到尾在这一页看清——现在卡在哪、谁在承接、进展和拆出的子项、等你处理的、
 *  席位的消息与回复、结果和依据、时间线。
 *  数据来自 GET /api/work-items/:id：管理员看全部，登录的人只看自己建立的。
 *  阶段七 R2：席位发来的消息落在「对话」里（不进「关注」）：打开页面时有未读就标成已读，每条可回复（同一 context 发回那个团队）。
 *  等你处理的（席位提问、等验收、过目放行）取自 GET /api/attention 里链接到这件事项的条目：给不给答法由各来源的守卫决定，
 *  答复走和「关注」页同一套入口；你看不到的这里也没有。
 *  日志只增不改：每条事实一行；被拒的（表里没有、终态之后才到）也留一行「收到，未采信」，带原因。 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, App, Badge, Button, Card, Col, DatePicker, Descriptions, Empty, Flex, Input, List, Popover, Radio, Row, Segmented, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { apiFetch } from '../admin-token';
import { OUTCOME, VERDICT, type AttentionItem, type LogRow } from '../attention-view';
import { getLifecycleNameSources, getRosterTeams, getWorkItem, postAskAnswer, postCreatorDecision, postSeatMessageReply, postSeatMessagesRead } from '../api';
import dayjs from 'dayjs';
import SectionBoundary from '../components/SectionBoundary';
import WorkItemTimeline, { STATE, stateTag } from '../components/WorkItemTimeline';

export { STATE };
import { choicesFor, routeFor, viewerOf, type Can, seatLine, showProgress, subitemsOf, ticketStateLabel } from '../work-item-view';
import { teamLabel } from '../people';
import { attachmentsOf, dueEditable, dueErrorText, dueLabel, dueOf, hasDueField, overdueOf, sizeLabel } from '../work-item-extras';
import { getAuthMe, setWorkItemDue } from '../api';
import { NO_NAMES, cleanSeatName, lifecycleNames, lineName, rosterNames, stageName, withRoster, type Names } from '../names';
import { actorLabel, seatLabel, askerLabel, textOf, who, PROGRESS_STATE, TERMINAL, creatorLabel, hiddenInTimeline, artifactHref, artifactsFromLog, mergeArtifacts, askAnswerBody, initialChoice, lastAskAnswered, parseArtifacts, pendingFor, progressLine, stateHint, type Artifact, type SeatAsk, type SeatProgress } from '../work-item-view';

type Item = { id: string; title: string; state: string; created_by: string; creator_principal?: string | null; created_at: string; updated_at: string; source_kind: string; source_ref: string; target_team: string; seat: string; eval: string; eval_reason: string; progress_summary: string; receipt_outcome: string; object: string; phase: string; open_asks: string; outputs: string; evidence: string };

type SeatMessage = { id: number; sender: string; peer: string; text: string; truncated: boolean; at: string; status: 'unread' | 'read' | 'replied' | 'over-cap' };
type Data = { item: Item; log: LogRow[]; messages?: SeatMessage[]; unread?: number; progress?: SeatProgress | null; asks?: SeatAsk[]; subitems?: unknown; can?: unknown; turn?: unknown; creator?: unknown };
const MSG_STATUS: Record<SeatMessage['status'], { label: string; color: string }> = {
  unread: { label: '未读', color: 'blue' }, read: { label: '看过', color: 'default' }, replied: { label: '已回复', color: 'green' }, 'over-cap': { label: '超出上限', color: 'default' },
};
const SENT_REASON: Record<string, string> = { queued: '已发回团队', event_not_dispatched: '这件事项只通知、没派出去，回复只记在事项上', not_queued: '回复已记下，但没有可发回的投递' };
const REPLY_ERROR: Record<string, string> = { text_required: '先写点什么', text_too_long: '太长了，最多 4000 字', seat_message_not_found: '这条消息不在了', seat_message_not_open: '这条消息已经回复过或超出上限，不能再回复', work_items_cross_origin_denied: '请从市场页面里操作（跨站请求被拒）', work_items_principal_not_active: '你的账号还没启用，不能回复', work_item_creator_not_eligible: '这件事项不归你处理' };

/** 等你处理的：答法、要填的东西和「关注」页一致（各来源自己定，入口原样转交） */
const CATEGORY: Record<string, { label: string; color: string }> = { ask: { label: '席位提问', color: 'gold' }, accept: { label: '等验收', color: 'green' }, glance: { label: '过目', color: 'default' }, review: { label: '审核', color: 'blue' }, grant: { label: '授权', color: 'purple' } };
const ANSWER: Record<string, string> = { answer: '答复', verify: '验收通过', return: '打回重做', release: '派出去', withdraw: '撤回' };
const FIELDS: Record<string, Record<string, { key: string; label: string; required: boolean }>> = {
  'seat-asks': { answer: { key: 'text', label: '你的答复（会发回提问的席位）', required: true } },
  'work-items': { return: { key: 'reason', label: '打回的理由（席位会照这个改）', required: true } },
};

/** 替建立人办的答法：管理员代答、代为验收、代为打回 */
const PROXY: Record<string, string> = { answer: '代答', verify: '代为验收', return: '代为打回' };
function PendingAction({ item, can, proxy, onDone }: { item: AttentionItem; can: Can; proxy: boolean; onDone: () => void }) {
  const label = (a: string) => (proxy && PROXY[a]) || ANSWER[a] || a;
  const { message } = App.useApp();
  const choices = choicesFor(item, can);
  const [answer, setAnswer] = useState(choices.length === 1 ? choices[0] : '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = answer ? FIELDS[item.source]?.[answer] : undefined;
  const submit = async () => {
    setBusy(true);
    try {
      if (routeFor(item) === 'creator') {
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
        {choices.length > 1 && <Segmented value={answer} onChange={(v) => setAnswer(String(v))} options={choices.map((a) => ({ label: label(a), value: a }))} />}
        {field && <Input.TextArea aria-label={field.label} placeholder={field.label} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />}
        <Space>
          <Button type="primary" loading={busy} disabled={!answer || (!!field?.required && !text.trim())} onClick={() => void submit()}>{answer ? label(answer) : '选一种答法'}</Button>
        </Space>
      </>}
  </Flex>;
}

const ASK_ERROR: Record<string, string> = {
  text_required: '选一个答法，或者写一句', answer_not_an_option: '这个答法不在选项里', seat_ask_not_pending: '这条提问已经不在等答复了（可能别人刚答过）',
  seat_ask_not_found: '这条提问不在这件事项上', seat_ask_id_invalid: '提问号不对', work_items_cross_origin_denied: '请从市场页面里操作（跨站请求被拒）',
  work_items_principal_not_active: '你的账号还没启用，不能答复',
};

function AskRow({ itemId, ask, seat, proxy, onDone }: { itemId: string; ask: SeatAsk; seat: string; proxy: boolean; onDone: () => void }) {
  const { message } = App.useApp();
  const [choice, setChoice] = useState(initialChoice(ask));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const body = askAnswerBody(choice, text);
  const submit = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const { status, body: r } = await postAskAnswer(itemId, String(ask.id), body);
      if (status === 401) throw Error('请先登录');
      if (status === 404 && !r.error) throw Error('你不能答这件事项上的提问');
      if (status < 200 || status >= 300) throw Error(ASK_ERROR[r.error ?? ''] ?? r.error ?? '答复失败');
      void message.success(r.duplicate ? '这条已经答过了' : r.result?.sent ? '已答复，发回了席位' : '已答复');
      setText(''); onDone();
    } catch (e) { void message.error(e instanceof Error ? e.message : '答复失败'); }
    finally { setBusy(false); }
  };
  return <List.Item data-testid="seat-ask" id={`ask-${ask.id}`}>
    <Flex vertical gap="small" className="wm-w-full">
      <Space wrap size={6}>
        <Typography.Text strong>{textOf(ask.question) || '（没写问题）'}</Typography.Text>
        {ask.status === 'answered' && <Tag color="green">已答复</Tag>}
        {ask.status === 'closed' && <Tag>已合上</Tag>}
        <Typography.Text type="secondary">{askerLabel(ask.asked_by, seat)}</Typography.Text><RelTime value={ask.at} />
      </Space>
      {ask.status === 'answered' && <Typography.Text>答：{textOf(ask.answer)}<Typography.Text type="secondary">（{who(ask.answered_by)}{ask.answered_at ? ' · ' : ''}</Typography.Text>{ask.answered_at && <RelTime value={ask.answered_at} />}<Typography.Text type="secondary">）</Typography.Text></Typography.Text>}
      {ask.status === 'closed' && <Typography.Text type="secondary">没人答，后来的提问、接单或结果把它合上了。</Typography.Text>}
      {ask.status === 'open' && <>
        {ask.options.length > 0 && <Radio.Group value={choice} onChange={(e) => setChoice(String(e.target.value))} optionType="button" buttonStyle="solid" data-testid="seat-ask-options"
          options={ask.options.map((o) => ({ label: o === ask.default ? `${o}（席位建议）` : o, value: o }))} />}
        <Input.TextArea aria-label="答复" autoSize={{ minRows: 1, maxRows: 6 }} maxLength={4000} value={text} disabled={!!choice}
          placeholder={ask.options.length ? (choice ? '已选了答法；要自己写，先取消选择' : '或者自己写一句') : '写下你的答复（会发回提问的席位）'} onChange={(e) => setText(e.target.value)} />
        <Space>
          <Button type="primary" loading={busy} disabled={!body} onClick={() => void submit()}>{proxy ? '代答' : '答复'}</Button>
          {choice && <Button onClick={() => setChoice('')}>取消选择</Button>}
        </Space>
      </>}
    </Flex>
  </List.Item>;
}

function SeatMessages({ itemId, messages, closed, onChanged }: { itemId: string; messages: SeatMessage[]; closed: boolean; onChanged: () => void }) {
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
  return <>{closed && <Typography.Text type="secondary" data-testid="seat-messages-closed">事项已经结束，不能再回复。</Typography.Text>}<List itemLayout="vertical" size="small" dataSource={messages} rowKey="id" renderItem={(m) => <List.Item data-testid="seat-message">
    <Space wrap size={4}>
      <Typography.Text strong>{cleanSeatName(who(m.sender) || who(m.peer))}</Typography.Text>
      <Tag color={MSG_STATUS[m.status].color}>{MSG_STATUS[m.status].label}</Tag>
      <RelTime value={m.at} />
    </Space>
    <Typography.Paragraph className="wm-m-0 wm-prewrap" ellipsis={{ rows: 6, expandable: 'collapsible', symbol: (open) => (open ? '收起' : '展开全文') }}>{textOf(m.text)}{m.truncated ? '（已截断）' : ''}</Typography.Paragraph>
    {!closed && (m.status === 'unread' || m.status === 'read') && <Space.Compact block>
      <Input.TextArea aria-label="回复" autoSize={{ minRows: 1, maxRows: 6 }} maxLength={4000} placeholder="回复这条消息（发回这个团队）" value={drafts[m.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [m.id]: e.target.value }))} />
      <Button type="primary" loading={busy === m.id} disabled={!(drafts[m.id] ?? '').trim()} onClick={() => void reply(m)}>回复</Button>
    </Space.Compact>}
  </List.Item>} /></>;
}

function Artifacts({ list, empty }: { list: Artifact[]; empty: string }) {
  if (!list.length) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return <List size="small" dataSource={list} rowKey={(a) => `${a.kind}:${a.id}`} renderItem={(a) => {
    const href = artifactHref(a);
    return <List.Item data-testid="artifact">
      <Flex vertical gap={2}>
        <Space size={6}><Tag>{a.kind}</Tag>{href ? <Link to={href}>{a.title || a.id}</Link> : <Typography.Text className={a.title ? undefined : 'wm-mono'}>{a.title || a.id}</Typography.Text>}</Space>
        {(a.submitted_by || a.at) && <Space size={6}>{a.submitted_by && <Typography.Text type="secondary" className="wm-caption">{who(a.submitted_by)} 交的</Typography.Text>}{a.at && <RelTime value={a.at} />}</Space>}
      </Flex>
    </List.Item>;
  }} />;
}


/** 期限那一行：日期加离今天多远，过期了标红（照服务端的 overdue）；没有期限写「不限」。建立人能改、能清掉 */
function DueLine({ itemId, due, overdue, editable, onSaved }: { itemId: string; due: string | null; overdue: boolean; editable: boolean; onSaved: () => void }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(due);
  const [busy, setBusy] = useState(false);
  const save = async (v: string | null) => {
    setBusy(true);
    const r = await setWorkItemDue(itemId, v);
    setBusy(false);
    if (r.status >= 200 && r.status < 300) {
      setOpen(false);
      const n = Number(r.body?.notified) || 0;
      void message.success(v ? `期限改成 ${v}${n ? '，已告诉在办的席位' : ''}` : `期限清掉了${n ? '，已告诉在办的席位' : ''}`);
      onSaved();
    } else void message.error(dueErrorText(r.status, typeof r.body?.error === 'string' ? r.body.error : undefined));
  };
  return <Space size={6} wrap data-testid="work-item-due-line">
    <span data-testid="work-item-due">{due ? dueLabel(due, dayjs().format('YYYY-MM-DD')) : '不限'}</span>
    {overdue && <Tag color="error" data-testid="work-item-overdue">已过期</Tag>}
    {editable && <Popover trigger="click" open={open} onOpenChange={(o) => { setOpen(o); if (o) setPick(due); }} title="改期限"
      content={<Space direction="vertical" data-testid="work-item-due-editor">
        <DatePicker value={pick ? dayjs(pick) : null} onChange={(d) => setPick(d ? d.format('YYYY-MM-DD') : null)} placeholder="选一个日期" />
        <Space>
          <Button type="primary" size="small" loading={busy} disabled={!pick || pick === due} onClick={() => void save(pick)} data-testid="work-item-due-save">保存</Button>
          {due && <Button size="small" disabled={busy} onClick={() => void save(null)} data-testid="work-item-due-clear">清掉期限</Button>}
        </Space>
      </Space>}>
      <Typography.Link data-testid="work-item-due-edit">{due ? '改' : '加一个'}</Typography.Link>
    </Popover>}
  </Space>;
}

export default function WorkItem() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
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
      // 标成功就把本页的未读也改成看过（不用等下次刷新）
      if ((d.unread ?? 0) > 0) void postSeatMessagesRead(id).then(({ status }) => {
        if (status === 200) setData((cur) => cur && cur.item.id === d.item.id ? { ...cur, unread: 0, messages: (cur.messages ?? []).map((m) => (m.status === 'unread' ? { ...m, status: 'read' } : m)) } : cur);
      }).catch(() => undefined);
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

  // 名字只当显示用：席位句柄查名册，线和阶段的代号查生命周期；读不到就按「查不到名字」处理
  const [roster, setRoster] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Names>(NO_NAMES);
  useEffect(() => { void getRosterTeams().then((t) => setRoster(rosterNames(t))); void getLifecycleNameSources().then((x) => setNames(lifecycleNames(x.types, x.objects))); }, []);
  const named = (seat: unknown) => withRoster(who(seat), roster);
  const item = data?.item ? { ...data.item, seat: named(data.item.seat) } : undefined;
  const asks = data?.asks;
  // 详情带了 asks（阶段七）就以它为准：在这里答，「关注」里的同一条提问不再重复列
  const shownPending = asks ? pending.filter((p) => p.source !== 'seat-asks') : pending;
  const openAsks = asks ? asks.filter((a) => a.status === 'open').length : 0;
  // 「你」只给轮到的人：can / turn / creator 都取自详情应答（#587），不比对登录名、不看是不是管理员
  const viewer = viewerOf(data, who(item?.creator_principal || item?.created_by).replace(/^(user|human):/, ''));
  // 登录的人是谁（主体）：只用来决定期限那一行给不给「改」（服务端没给 can.due 时）
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { void getAuthMe().then((m) => { const p = (m as { principal?: unknown } | null)?.principal; setMe(typeof p === 'string' && p ? p : null); }); }, []);
  const can = viewer.can;
  // 建立人能不能在这一页答：详情带了提问列表（建立人答复的入口开了），或者「关注」给了他答法
  const hint = item ? stateHint(item.state, item.seat, asks ? openAsks === 0 && asks.length > 0 : lastAskAnswered(data?.log ?? []), viewer, asks !== undefined || can.answer) : null;
  const progress = data?.progress ?? null;
  const tickets = subitemsOf(data?.subitems, progress).map((t) => ({ ...t, seat: named(t.seat) }));
  // 结果：事项的 outputs 列（现在还没人写）加上日志里回执带来的产物，去重
  const timeline = (data?.log ?? []).filter((r) => !hiddenInTimeline(r));
  // 提问号在 asks 里是数字、在日志的 fact_id / detail.ask_id 里是字符串：统一成字符串再比
  const askIds = new Set((asks ?? []).map((a) => String(a.id)));
  const outputs = mergeArtifacts(parseArtifacts(item?.outputs), artifactsFromLog(data?.log ?? []));
  const evidence = parseArtifacts(item?.evidence);
  return <WmPage title={item?.title ?? '事项'} detail={item?.title} onBack={() => navigate('/work-items')}
    extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>}>
    {error && <Alert type="error" showIcon message={error} data-testid="work-item-error" />}
    {item && <Row gutter={16}>
      <Col span={16}>
        <Flex vertical gap="middle">
          <SectionBoundary name="摘要">
          <Card title={stateTag(item.state, viewer)} data-testid="work-item-summary">
            <Flex vertical gap="small">
              {hint && <Alert type={hint.type} showIcon message={hint.text} data-testid="work-item-hint" />}
              <Descriptions column={2} size="small" items={[
                { key: 'seat', label: '承接', children: seatLine(item, tickets, teamLabel) || '—' },
                { key: 'team', label: '派给', children: teamLabel(item.target_team) || '—' },
                { key: 'by', label: '建立人', children: creatorLabel(item.created_by, item.creator_principal) },
                { key: 'obj', label: '哪条线 / 哪一步', children: [lineName(item.object, names), stageName(item.phase, names)].filter(Boolean).join(' / ') || '—' },
                { key: 'eval', label: '接单判断', children: item.eval ? `${VERDICT[item.eval] ?? item.eval}${item.eval_reason ? `（${item.eval_reason}）` : ''}` : '—' },
                { key: 'at', label: '最近变化', children: <RelTime value={item.updated_at} /> },
                // 期限：服务端给了这个字段才显示（旧服务端没有这个键，不写「不限」，可能其实有期限）；建立人、事项没结束时能改
                ...(hasDueField(data?.item) || dueOf(item) ? [{ key: 'due', label: '期限', children: <DueLine itemId={item.id} due={dueOf(item)} overdue={overdueOf(data?.item)}
                  editable={dueEditable(data, me, TERMINAL)} onSaved={() => void load()} /> }] : []),
              ]} />
            </Flex>
          </Card>
          </SectionBoundary>
          <SectionBoundary name="席位提问">
          {asks && asks.length > 0 && <Card size="small" title={<Space>席位提问{openAsks > 0 && <Badge count={openAsks} title="在等你答复" />}</Space>} data-testid="seat-asks">
            <List size="small" dataSource={asks} rowKey={(a) => String(a.id)} renderItem={(a) => <AskRow itemId={id} ask={a} seat={who(item.seat)} proxy={!viewer.turn.answer} onDone={() => void load()} />} />
          </Card>}
          </SectionBoundary>
          <SectionBoundary name="等你处理">
          {shownPending.length > 0 && <Card size="small" title={<Space>等你处理<Badge count={shownPending.length} /></Space>} data-testid="work-item-pending">
            <Flex vertical gap="middle">{shownPending.map((p) => <PendingAction key={`${p.source}:${p.source_id}`} item={p} can={can} proxy={(p as { mine?: unknown }).mine === false && (p.source === 'seat-asks' || p.category === 'accept')} onDone={() => void load()} />)}</Flex>
          </Card>}
          </SectionBoundary>
          <SectionBoundary name="正在处理">
          {progress && showProgress(item.state) && <Card size="small" title="正在处理" data-testid="work-item-progress">
            <Flex vertical gap="small">
              <Space wrap size={6}><Typography.Text strong>{progressLine(progress)}</Typography.Text>{who(progress.by) && <Typography.Text type="secondary">{seatLabel(named(progress.by))}</Typography.Text>}<RelTime value={progress.at || progress.received_at} /></Space>
              {textOf(progress.summary) && <Typography.Paragraph className="wm-m-0">{textOf(progress.summary)}</Typography.Paragraph>}
            </Flex>
          </Card>}
          {tickets.length > 0 && <Card size="small" title={`拆出的子项 ${tickets.length} 件`} data-testid="work-item-subitems">
            <List size="small" dataSource={tickets} rowKey={(t) => textOf(t.id) || JSON.stringify(t)}
              renderItem={(t) => <List.Item data-testid="work-item-ticket" extra={<Tag>{ticketStateLabel(textOf(t.state), textOf(t.outcome))}</Tag>}>
                <Space size={6}><span>{textOf(t.title) || textOf(t.id)}</span>{who(t.seat) && <Typography.Text type="secondary">{seatLabel(who(t.seat))}</Typography.Text>}</Space>
              </List.Item>} />
          </Card>}
          </SectionBoundary>
          <SectionBoundary name="对话">
          <Card size="small" data-testid="seat-messages"
            title={<Space>对话{(data?.unread ?? 0) > 0 && <Badge count={data?.unread} title="未读的席位消息" />}</Space>}>
            <SeatMessages itemId={id} messages={data?.messages ?? []} closed={viewer.reply === null ? TERMINAL.includes(item.state) : !viewer.reply} onChanged={() => void load()} />
          </Card>
          </SectionBoundary>
          <SectionBoundary name="时间线">
          <Card title="时间线" size="small">
            <WorkItemTimeline log={timeline} askIds={askIds} nameOf={(x) => seatLabel(named(x))} />
          </Card>
          </SectionBoundary>
        </Flex>
      </Col>
      <Col span={8}>
        <Flex vertical gap="middle">
          <SectionBoundary name="结果">
          <Card size="small" title={`结果${outputs.length ? ` ${outputs.length}` : ''}`} data-testid="work-item-outputs">
            <Flex vertical gap="small">
              {item.receipt_outcome && <Space size={6}><Typography.Text type="secondary">回执</Typography.Text><Tag>{OUTCOME[item.receipt_outcome] ?? item.receipt_outcome}</Tag></Space>}
              <Artifacts list={outputs} empty={item.receipt_outcome ? '没有附产出；回执的内容在对话和时间线里' : '还没有产出'} />
            </Flex>
          </Card>
          </SectionBoundary>
          <SectionBoundary name="附件">
          {attachmentsOf(item).length > 0 && <Card size="small" title={`附件 ${attachmentsOf(item).length}`} data-testid="work-item-attachments">
            <List size="small" dataSource={attachmentsOf(item)} rowKey={(a) => a.url} renderItem={(a) => (
              <List.Item extra={<Typography.Text type="secondary" className="wm-num">{sizeLabel(a.size)}</Typography.Text>}>
                <Typography.Link href={a.url} download={a.name} ellipsis>{a.name}</Typography.Link>
              </List.Item>
            )} />
          </Card>}
          </SectionBoundary>
          <SectionBoundary name="依据">
          {evidence.length > 0 && <Card size="small" title={`依据 ${evidence.length}`}><Artifacts list={evidence} empty="" /></Card>}
          </SectionBoundary>
          <SectionBoundary name="细节">
          <Card size="small" title="细节">
            <Descriptions column={1} size="small" items={[
              { key: 'id', label: '事项号', children: <Typography.Text copyable className="wm-num">{item.id}</Typography.Text> },
              { key: 'src', label: '来源', children: `${item.source_kind}${item.source_ref ? ` · ${item.source_ref}` : ''}` },
              { key: 'created', label: '建立', children: <RelTime value={item.created_at} /> },
            ]} />
          </Card>
          </SectionBoundary>
        </Flex>
      </Col>
    </Row>}
  </WmPage>;
}
