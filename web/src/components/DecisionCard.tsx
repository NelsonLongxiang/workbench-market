/** 「等你拍板」的一张卡（全景首页用；原型首页的卡片）：类型标签、标题、在等谁，答法直接排成按钮，一步到位。
 *  挂在事项上的（席位提问、验收、过目）再读一次事项详情 GET /api/work-items/:id，拿承接席位和派给的团队，按详情页同一套规则显示名字；
 *  带选项的提问把选项做成按钮（同详情页：不预选，席位给的缺省标「席位建议」，点过一个才能答复）。
 *  答法和要填的东西同「关注」页（各来源自己定）：要填理由的点了才展开输入框；撤回这类不可逆的再确认一次。
 *  走哪个入口同「关注」：不是管理员时，自己的「等验收」走建立人入口，其余走答复入口。 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App, Button, Input, Popconfirm, Radio, Space, Tag, Typography } from 'antd';
import { apiFetch } from '../admin-token';
import { attentionChanged, postCreatorDecision } from '../api';
import { answerChoices, answerRoute, waited, type AttentionItem } from '../attention-view';
import { cardWording, splitAskTitle } from '../home-view';
import { cleanWho, seatLabel, teamLabel } from '../people';


const COLOR: Record<string, string> = { ask: 'gold', accept: 'green', glance: 'default', review: 'blue', grant: 'purple' };
/** 替建立人办的答法 */
const PROXY: Record<string, string> = { answer: '代答', verify: '代为验收', return: '代为打回' };
const ANSWER: Record<string, string> = { approve: '批准', reject: '不给', answer: '答复', bind: '对接', verify: '验收通过', return: '打回重做', release: '派出去', withdraw: '撤回', reply: '回复', ack: '知道了' };
/** 要先填一句的答法：键是来源 → 答法 → 要填的字段 */
const NEEDS: Record<string, Record<string, { key: string; label: string }>> = {
  'seat-asks': { answer: { key: 'text', label: '你的答复' } },
  'work-items': { return: { key: 'reason', label: '打回的理由' } },
  'owner-pending': { answer: { key: 'summary', label: '你的答复' } },
};
const IRREVERSIBLE = new Set(['withdraw', 'reject']);

/** 卡片挂的事项：席位提问的 link 是 /work-items/<id>，事项来源的 source_id 就是事项 id */
function workItemIdOf(item: AttentionItem): string | null {
  if (item.source === 'work-items') return item.source_id;
  const m = /^\/work-items\/([^/?#]+)/.exec(item.link || '');
  return m ? decodeURIComponent(m[1]) : null;
}
type Ask = { status?: string; options?: unknown; default?: unknown; id?: unknown };
type Detail = { seat: string; team: string; options: string[]; suggested: string; askId: string };
async function loadDetail(id: string): Promise<Detail | null> {
  try {
    const r = await apiFetch(`/api/work-items/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const j = await r.json() as { item?: { seat?: unknown; target_team?: unknown }; asks?: Ask[] };
    const open = (j.asks ?? []).filter((a) => a.status === 'open').pop() as (Ask & { id?: unknown }) | undefined;
    const options = Array.isArray(open?.options) ? open.options.filter((o): o is string => typeof o === 'string') : [];
    return { seat: typeof j.item?.seat === 'string' ? j.item.seat : '', team: typeof j.item?.target_team === 'string' ? j.item.target_team : '', options, suggested: typeof open?.default === 'string' ? open.default : '', askId: open?.id !== undefined && open?.id !== null ? String(open.id) : '' };
  } catch { return null; }
}

export default function DecisionCard({ item, admin, onDone }: { item: AttentionItem; admin: boolean; onDone: () => void }) {
  const { message } = App.useApp();
  const choices = answerChoices(admin, item);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [choice, setChoice] = useState('');
  const wid = workItemIdOf(item);
  useEffect(() => { if (wid) void loadDetail(wid).then(setDetail); }, [wid]);
  const isAsk = item.source === 'seat-asks';
  const parsed = isAsk ? splitAskTitle(item.title) : { question: item.title, options: [] };
  // 选项以事项详情里的为准；详情还没带提问列表时用标题里服务端写的「（可选：…）」
  const options = detail?.options.length ? detail.options : parsed.options;
  const seat = detail?.seat ?? '';
  const whoLine = isAsk
    ? `${cleanWho(item.waiting_for, seat)} 问`
    : item.source === 'work-items' && detail
      ? [seat && `承接 ${seatLabel(seat)}`, detail.team && `派给 ${teamLabel(detail.team)}`].filter(Boolean).join(' · ')
      : cleanWho(item.waiting_for, seat);
  const wording = cardWording(item.category, admin);
  const label = (a: string) => (wording.proxy && PROXY[a]) || ANSWER[a] || a;
  const send = async (answer: string, input: Record<string, string>) => {
    setBusy(true);
    try {
      const route = answerRoute(admin, item);
      if (route === 'ask') {
        // 建立人答自己事项上的席位提问：选了选项发 answer，否则发自由文本
        if (!wid || !detail?.askId) throw Error('这条提问已经合上了，刷新看看');
        const r = await apiFetch(`/api/work-items/${encodeURIComponent(wid)}/asks/${encodeURIComponent(detail.askId)}/answer`, { method: 'POST', body: JSON.stringify(choice && input.text === choice ? { answer: choice } : { text: input.text ?? '' }) });
        const body = await r.json().catch(() => ({}));
        if (r.status === 401) throw Error('请先登录');
        if (!r.ok) throw Error(body?.result?.error || body?.error || '没办成');
      } else if (route === 'creator') {
        const { status, body } = await postCreatorDecision(item.source_id, answer, input.reason ?? '');
        if (status === 401) throw Error('请先登录');
        if (status < 200 || status >= 300) throw Error(body?.result?.error || body?.error || '没办成');
      } else {
        const r = await apiFetch('/api/attention/answer', { method: 'POST', body: JSON.stringify({ source: item.source, source_id: item.source_id, answer, input }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw Error(body?.result?.error || body?.error || '没办成');
      }
      void message.success('办好了');
      setOpen(null); setText(''); setChoice('');
      attentionChanged(); onDone();
    } catch (e) { void message.error(e instanceof Error ? e.message : '没办成'); }
    finally { setBusy(false); }
  };
  const click = (a: string) => {
    const need = NEEDS[item.source]?.[a];
    if (need) { setOpen(open === a ? null : a); return; }
    void send(a, {});
  };
  return <div className="wm-decision" data-testid="decision-card">
    <div className="wm-decision-head">
      <Tag color={COLOR[item.category] ?? 'default'}>{wording.label}</Tag>
      <Typography.Text type="secondary" className="wm-caption">{[whoLine, item.since && `等了 ${waited(item.since)}`].filter(Boolean).join(' · ')}</Typography.Text>
    </div>
    <Typography.Text strong className="wm-decision-title">{parsed.question}</Typography.Text>
    {isAsk && options.length > 0 && choices.includes('answer') && <>
      <Radio.Group value={choice} onChange={(e) => setChoice(String(e.target.value))} optionType="button" data-testid="decision-options"
        options={options.map((o) => ({ label: o === detail?.suggested ? `${o}（席位建议）` : o, value: o }))} />
      <Space wrap size={8} className="wm-decision-actions">
        <Button type="primary" loading={busy} disabled={!choice} onClick={() => void send('answer', { text: choice })}>{label('answer')}</Button>
        {item.link && !item.link.startsWith('/api/') && <Link to={item.link} className="wm-decision-more">自己写一句 →</Link>}
      </Space>
    </>}
    {open && <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={4000} placeholder={NEEDS[item.source]?.[open]?.label} value={text} onChange={(e) => setText(e.target.value)} />}
    {!(isAsk && options.length > 0 && choices.includes('answer')) && <Space wrap size={8} className="wm-decision-actions">
      {choices.map((a, i) => {
        const need = NEEDS[item.source]?.[a];
        if (open === a && need) return <Button key={a} type="primary" loading={busy} disabled={!text.trim()} onClick={() => void send(a, { [need.key]: text.trim() })}>确定{label(a)}</Button>;
        const btn = <Button key={a} type={i === 0 ? 'primary' : 'default'} loading={busy && !open} onClick={IRREVERSIBLE.has(a) ? undefined : () => click(a)}>{label(a)}</Button>;
        return IRREVERSIBLE.has(a) ? <Popconfirm key={a} title={`确定${label(a)}？`} description="这一步做了就收不回来。" okText={label(a)} cancelText="再想想" onConfirm={() => click(a)}>{btn}</Popconfirm> : btn;
      })}
      {item.link && !item.link.startsWith('/api/') && <Link to={item.link} className="wm-decision-more">{choices.length ? '看详情' : '去处理'} →</Link>}
    </Space>}
  </div>;
}
