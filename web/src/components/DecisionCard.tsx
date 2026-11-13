/** 「等你拍板」的一张卡（全景首页用；原型首页的卡片）：类型标签、标题、在等谁，答法直接排成按钮，一步到位。
 *  挂在事项上的（席位提问、验收、过目）再读一次事项详情 GET /api/work-items/:id，拿承接席位和派给的团队，按详情页同一套规则显示名字；
 *  带选项的提问把选项做成按钮（同详情页：不预选，席位给的缺省标「席位建议」，点过一个才能答复）。
 *  变更申请（回滚 / 删除工作台或技能，#580）当场办：卡片上写清要动什么、影响多大、申请理由；不通过要写理由，通过删除要再确认一次。
 *  统一待办的条目不是审核：标签按它是哪一类写，只给「去处理」。
 *  答法和要填的东西同「关注」页（各来源自己定）：要填理由的点了才展开输入框；撤回这类不可逆的再确认一次。
 *  条目自带答复入口的（answer_via：方法、地址、每个答法的请求体和要填的一项）照它发，不按来源写死地址；AI 会话申请用工作台的工具就是这样办的。
 *  走哪个入口同「关注」：不是管理员时，自己的「等验收」走建立人入口，其余走答复入口。 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App, Button, Checkbox, Input, Popconfirm, Radio, Space, Tag, Typography } from 'antd';
import { apiFetch } from '../admin-token';
import { attentionChanged, postCreatorDecision } from '../api';
import { answerChoices, answerRoute, answerViaOf, workItemIdOf, viaBody, viaError, viaInput, viaPath, waited, type AttentionItem } from '../attention-view';
import { cardWording, splitAskTitle } from '../home-view';
import { seatLabel, teamLabel, waitingLabel } from '../people';
import { fallbackPlace, pageLink } from '../page-paths';
import { REVIEW_NEEDS, changeCard, changeDetailOf, confirmText, grantCard, grantDetailOf, reviewAnswerLabel, runCard, runDetailOf, taskKindLabel } from '../review-view';


const COLOR: Record<string, string> = { ask: 'gold', accept: 'green', glance: 'default', review: 'blue', grant: 'purple' };
/** 替建立人办的答法 */
const PROXY: Record<string, string> = { answer: '代答', verify: '代为验收', return: '代为打回' };
const ANSWER: Record<string, string> = { approve: '批准', reject: '不给', answer: '答复', bind: '对接', verify: '验收通过', return: '打回重做', release: '派出去', withdraw: '撤回', reply: '回复', ack: '知道了' };
/** 要先填一句的答法：键是来源 → 答法 → 要填的字段 */
const NEEDS: Record<string, Record<string, { key: string; label: string; max?: number; optional?: boolean }>> = {
  'seat-asks': { answer: { key: 'text', label: '你的答复' } },
  'work-items': { return: { key: 'reason', label: '打回的理由' } },
  'owner-pending': { answer: { key: 'summary', label: '你的答复' } },
  // 待对接的外部账号：对到哪个主体（必填）；下面另有「这个主体还没有，就新建」的勾选（BIND_CREATE）
  'principal-pending': { bind: { key: 'principal', label: '对到哪个主体（user:<名>）', max: 160 } },
  // MCP 权限申请：不给时可以写一句理由（可不填），申请的 AI 会话会看到；批的时候不写
  'mcp-access': { reject: { key: 'note', label: '不给的理由（可不填，申请的 AI 会话会看到）', max: 500, optional: true } },
  ...REVIEW_NEEDS,
};
/** 要额外勾一项的答法：对接外部账号时，主体还没有就新建（服务端要的是 create: true） */
const BIND_CREATE = (source: string, answer: string | null) => source === 'principal-pending' && answer === 'bind';

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
  /** 只有站内真有的页面才做成链接（接口地址、已经没有的页面不显示）；没有可用链接时按来源给缺省去处，实在没有就写一句去哪办 */
  const page = pageLink(item.link);
  const place = page ? { link: page, text: '' } : fallbackPlace(item.source);
  useEffect(() => { if (wid) void loadDetail(wid).then(setDetail); }, [wid]);
  const change = changeDetailOf(item);
  const cc = change ? changeCard(change) : null;
  const taskKind = taskKindLabel(item);
  const run = runDetailOf(item);
  const rc = run ? runCard(run, teamLabel) : null;
  const grant = grantDetailOf(item);
  const gc = grant ? grantCard(grant) : null;
  const via = answerViaOf(item);
  /** 这个答法要先填的一项：条目自带答复入口的照它说的（可以是选填），其余按来源的表 */
  const needOf = (a: string): { key: string; label: string; max?: number; optional?: boolean; options?: string[] } | null => {
    if (via) { const i = viaInput(via, a); return i ? { key: i.to, label: i.required ? '写一句理由（必填）' : '留一句（可不填）', max: i.max, optional: !i.required, options: i.options } : null; }
    return NEEDS[item.source]?.[a] ?? null;
  };
  const isAsk = item.source === 'seat-asks';
  const parsed = isAsk ? splitAskTitle(item.title) : { question: item.title, options: [] };
  // 选项以事项详情里的为准；详情还没带提问列表时用标题里服务端写的「（可选：…）」
  const options = detail?.options.length ? detail.options : parsed.options;
  const seat = detail?.seat ?? '';
  const whoLine = change
    ? `${waitingLabel(change.requested_by, { people: [item.creator ?? {}], name: item.waiting_for_name }) || '有人'} 申请`
    : run
    ? ''
    : grant
    ? ''
    : isAsk
    ? `${waitingLabel(item.waiting_for, { seat, people: [item.creator ?? {}], name: item.waiting_for_name })} 问`
    : item.source === 'work-items' && detail
      ? [seat && `承接 ${seatLabel(seat)}`, detail.team && `派给 ${teamLabel(detail.team)}`].filter(Boolean).join(' · ')
      : waitingLabel(item.waiting_for, { seat, people: [item.creator ?? {}], name: item.waiting_for_name });
  // 建立人的名字：服务端给的 creator_name（#657）优先，没有再看 creator 自带的显示名；都没有就不写名字（不露标识）
  const creatorName = (item.creator_name || '').trim() || (item.creator?.display_name || '').trim();
  const wording = cardWording(item.category, admin, item.mine, creatorName);
  const label = (a: string) => (wording.proxy && PROXY[a]) || reviewAnswerLabel(item.source, a, item) || ANSWER[a] || a;
  const [create, setCreate] = useState(false);
  const send = async (answer: string, input: Record<string, unknown>) => {
    setBusy(true);
    try {
      const route = answerRoute(admin, item);
      if (route === 'via' && via) {
        const r = await apiFetch(viaPath(via, answer), { method: via.method, body: JSON.stringify(viaBody(via, answer, String(Object.values(input)[0] ?? ''))) });
        if (!r.ok) throw Error(viaError(r.status, await r.json().catch(() => null)));
      } else if (route === 'ask') {
        // 建立人答自己事项上的席位提问：选了选项发 answer，否则发自由文本
        if (!wid || !detail?.askId) throw Error('这条提问已经合上了，刷新看看');
        const r = await apiFetch(`/api/work-items/${encodeURIComponent(wid)}/asks/${encodeURIComponent(detail.askId)}/answer`, { method: 'POST', body: JSON.stringify(choice && input.text === choice ? { answer: choice } : { text: input.text ?? '' }) });
        const body = await r.json().catch(() => ({}));
        if (r.status === 401) throw Error('请先登录');
        if (!r.ok) throw Error(body?.result?.error || body?.error || '没办成');
      } else if (route === 'creator') {
        const { status, body } = await postCreatorDecision(item.source_id, answer, String(input.reason ?? ''));
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
    if (needOf(a)) { setOpen(open === a ? null : a); setText(''); return; }
    void send(a, {});
  };
  return <div className="wm-decision" data-testid="decision-card">
    <div className="wm-decision-head">
      <Tag color={taskKind ? 'default' : COLOR[item.category] ?? 'default'}>{taskKind ?? wording.label}</Tag>
      <Typography.Text type="secondary" className="wm-caption">{[whoLine, item.since && `等了 ${waited(item.since)}`].filter(Boolean).join(' · ')}</Typography.Text>
    </div>
    <Typography.Text strong className="wm-decision-title">{cc ? cc.title : rc ? rc.title : gc ? gc.title : parsed.question}</Typography.Text>
    {rc && <div className="wm-decision-lines" data-testid="decision-run">
      {rc.lines.map((l, i) => <Typography.Text key={i} type="secondary">{l}</Typography.Text>)}
      {rc.problems.map((l, i) => <Typography.Text key={`p${i}`} type="warning">{l}</Typography.Text>)}
    </div>}
    {gc && <div className="wm-decision-lines" data-testid="decision-grant">
      {gc.lines.map((l, i) => <Typography.Text key={i} type="secondary">{l}</Typography.Text>)}
      {gc.warn && <Typography.Text type="warning">{gc.warn}</Typography.Text>}
    </div>}
    {cc && <div className="wm-decision-lines" data-testid="decision-change">
      {cc.lines.map((l, i) => <Typography.Text key={i} type="secondary">{l}</Typography.Text>)}
      {cc.warn && <Typography.Text type="warning">{cc.warn}</Typography.Text>}
    </div>}
    {isAsk && options.length > 0 && choices.includes('answer') && <>
      <Radio.Group value={choice} onChange={(e) => setChoice(String(e.target.value))} optionType="button" data-testid="decision-options"
        options={options.map((o) => ({ label: o === detail?.suggested ? `${o}（席位建议）` : o, value: o }))} />
      <Space wrap size={8} className="wm-decision-actions">
        <Button type="primary" loading={busy} disabled={!choice} onClick={() => void send('answer', { text: choice })}>{label('answer')}</Button>
        {page && <Link to={page} className="wm-decision-more">自己写一句 →</Link>}
      </Space>
    </>}
    {open && !!needOf(open)?.options?.length && <Radio.Group value={text} onChange={(e) => setText(String(e.target.value))} optionType="button" data-testid="decision-via-options"
      options={(needOf(open)?.options ?? []).map((o) => ({ label: o, value: o }))} />}
    {open && !needOf(open)?.options?.length && <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={needOf(open)?.max ?? 4000} showCount={!!needOf(open)?.max} placeholder={needOf(open)?.label} value={text} onChange={(e) => setText(e.target.value)} />}
    {open && BIND_CREATE(item.source, open) && <Checkbox checked={create} onChange={(e) => setCreate(e.target.checked)} data-testid="decision-bind-create">这个主体还没有，就新建</Checkbox>}
    {!(isAsk && options.length > 0 && choices.includes('answer')) && <Space wrap size={8} className="wm-decision-actions">
      {choices.map((a, i) => {
        const need = needOf(a);
        if (open === a && need) {
          const go = () => void send(a, { [need.key]: text.trim(), ...(BIND_CREATE(item.source, a) && create ? { create: true } : {}) });
          const ok = <Button key={a} type="primary" loading={busy} disabled={!need.optional && !text.trim()} onClick={BIND_CREATE(item.source, a) && create ? undefined : go} data-testid="decision-confirm">确定{label(a)}</Button>;
          // 勾了「新建主体」：建了就多一个人，再确认一次
          return BIND_CREATE(item.source, a) && create
            ? <Popconfirm key={a} title="会新建一个主体" description={`建了就多一个人「${text.trim() || '（没写名字）'}」，确定新建并对接？`} okText="新建并对接" cancelText="再想想" onConfirm={go}>{ok}</Popconfirm>
            : ok;
        }
        // 展开了某个答法要填的一格时，只留它的「确定」和「取消」，别的答法先收起来（免得误点、也看得出理由框是给谁的）
        if (open && open !== a && needOf(open)) return null;
        // 要先填一句的答法不再另外确认一次：填的那一步就是确认
        const confirm = need ? null : confirmText(item, a);
        const btn = <Button key={a} type={i === 0 ? 'primary' : 'default'} danger={!!confirm && !!change} loading={busy && !open} disabled={!!run && !run.ready} onClick={confirm ? undefined : () => click(a)}>{label(a)}</Button>;
        return confirm ? <Popconfirm key={a} title={`确定${label(a)}？`} description={confirm} okText={label(a)} cancelText="再想想" onConfirm={() => click(a)}>{btn}</Popconfirm> : btn;
      })}
      {open && needOf(open) && <Button onClick={() => { setOpen(null); setText(''); setCreate(false); }} data-testid="decision-cancel">取消</Button>}
      {!open && place.link && !((cc || rc || gc) && choices.length) && <Link to={place.link} className="wm-decision-more">{choices.length ? '看详情' : '去处理'} →</Link>}
      {!open && !place.link && place.text && !choices.length && <Typography.Text type="secondary" className="wm-caption" data-testid="decision-where">{place.text}</Typography.Text>}
    </Space>}
  </div>;
}
