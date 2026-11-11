/** 「关注」页（阶段八 8d）：等你处理的条目从各来源汇到一处，一次处理一条。
 *  数据来自 GET /api/attention（每个来源用它旧接口自己的守卫：你在旧页面看不到的，这里也没有）。
 *  答复走 POST /api/attention/answer，分发回来源自己的处理；答复入口还没上线时（404），提示去原页面处理。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Descriptions, Empty, Input, Segmented, Space, Tag, Typography } from 'antd';
import { LeftOutlined, RightOutlined, ReloadOutlined } from '@ant-design/icons';
import { apiFetch } from '../admin-token';
import WmPage from '../components/WmPage';
import { byWaited, waited, type AttentionItem, type Category } from '../attention-view';

type Item = AttentionItem;
type SourceMeta = { label: string; visible: boolean; count: number; error?: string };
type View = { items: Item[]; counts: { total: number; by_category: Record<Category, number> }; sources: Record<string, SourceMeta> };

const CATEGORY: Record<Category, string> = { ask: '提问', review: '审核', accept: '验收', glance: '过目', grant: '授权' };
const CATEGORY_COLOR: Record<Category, string> = { ask: 'gold', review: 'blue', accept: 'green', glance: 'default', grant: 'purple' };
const ANSWER: Record<string, string> = { approve: '批准', reject: '拒绝', answer: '答复', bind: '对接', verify: '验收通过', return: '退回', release: '放行', withdraw: '撤回' };
/** 每种答法要填的东西（和来源旧页面要的一样；入口把它们原样交给来源） */
type Field = { key: string; label: string; kind?: 'text' | 'textarea' | 'check'; required?: boolean };
const FIELDS: Record<string, Record<string, Field[]>> = {
  'change-requests': { approve: [{ key: 'reviewed_by', label: '审核人', required: true }], reject: [{ key: 'reviewed_by', label: '审核人', required: true }] },
  'mcp-access': { approve: [{ key: 'note', label: '备注' }], reject: [{ key: 'note', label: '拒绝理由' }] },
  'seat-asks': { answer: [{ key: 'text', label: '答复', kind: 'textarea', required: true }] },
  'owner-pending': { answer: [{ key: 'summary', label: '答复', kind: 'textarea', required: true }] },
  'principal-pending': { bind: [{ key: 'principal', label: '对到哪个主体（user:<名>）', required: true }, { key: 'create', label: '这个主体还没有，就新建', kind: 'check' }, { key: 'reason', label: '理由', required: true }] },
  'work-items': { return: [{ key: 'reason', label: '退回理由', kind: 'textarea', required: true }] },
};

export default function Attention() {
  const { message } = App.useApp();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [input, setInput] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [notLive, setNotLive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiFetch('/api/attention');
      const body = await r.json();
      if (!r.ok) throw Error(body?.error || '读取失败');
      setView(body);
    } catch (e) { setView(null); setError(e instanceof Error ? e.message : '读取失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const list = useMemo(() => byWaited((view?.items ?? []).filter((x) => filter === 'all' || x.category === filter)), [view, filter]);
  const at = Math.min(index, Math.max(0, list.length - 1));
  const cur = list[at];
  useEffect(() => { setAnswer(''); setInput({}); }, [cur?.source, cur?.source_id]);

  const fields = cur && answer ? FIELDS[cur.source]?.[answer] ?? [] : [];
  const missing = fields.some((f) => f.required && !String(input[f.key] ?? '').trim());
  const submit = async () => {
    if (!cur || !answer) return;
    setBusy(true);
    try {
      const r = await apiFetch('/api/attention/answer', { method: 'POST', body: JSON.stringify({ source: cur.source, source_id: cur.source_id, answer, input }) });
      if (r.status === 404) { setNotLive(true); return; }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(body?.error || '处理失败');
      void message.success(body?.duplicate ? '这一条已经处理过了' : '已处理');
      await load();
    } catch (e) { void message.error(e instanceof Error ? e.message : '处理失败'); }
    finally { setBusy(false); }
  };

  const visible = view ? Object.values(view.sources).filter((s) => s.visible).map((s) => s.label) : [];
  const segments = [{ label: `全部 ${view?.counts.total ?? 0}`, value: 'all' }, ...(Object.keys(CATEGORY) as Category[]).map((c) => ({ label: `${CATEGORY[c]} ${view?.counts.by_category[c] ?? 0}`, value: c }))];
  return <WmPage title="关注" extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>}>
    <Space direction="vertical" size="middle" className="wm-reading">
      <Typography.Paragraph type="secondary" className="wm-m-0">
        各处等你处理的事都在这里，一次处理一条。原来的页面照常能用。{visible.length > 0 && <>你能看到的来源：{visible.join('、')}。</>}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} />}
      {notLive && <Alert type="info" showIcon closable onClose={() => setNotLive(false)} message="这里还不能直接答复" description="答复入口还没上线：请点「在原页面处理」。" />}
      <Segmented value={filter} options={segments} onChange={(v) => { setFilter(v as Category | 'all'); setIndex(0); }} />
      {!loading && view && list.length === 0 && <Empty description="没有等你处理的事" />}
      {cur && <Card
        title={<Space wrap><Tag color={CATEGORY_COLOR[cur.category]}>{CATEGORY[cur.category]}</Tag><span>{cur.title}</span></Space>}
        extra={<Space><Typography.Text type="secondary">{at + 1} / {list.length}</Typography.Text>
          <Button aria-label="上一条" icon={<LeftOutlined />} disabled={at === 0} onClick={() => setIndex(at - 1)} />
          <Button aria-label="下一条" icon={<RightOutlined />} disabled={at >= list.length - 1} onClick={() => setIndex(at + 1)} /></Space>}
      >
        <Descriptions column={2} size="small" items={[
          { key: 'source', label: '来源', children: view?.sources[cur.source]?.label ?? cur.source },
          { key: 'waiting', label: '谁在等', children: cur.waiting_for || '—' },
          { key: 'since', label: '等了多久', children: waited(cur.since) },
          { key: 'obj', label: '对象 / 阶段', children: [cur.object, cur.phase].filter(Boolean).join(' / ') || '—' },
        ]} />
        <Space direction="vertical" className="wm-w-full wm-mt-3">
          {cur.answers.length > 0 && <Segmented value={answer} options={cur.answers.map((a) => ({ label: ANSWER[a] ?? a, value: a }))} onChange={(v) => setAnswer(String(v))} />}
          {fields.map((f) => f.kind === 'check'
            ? <Checkbox key={f.key} checked={input[f.key] === true} onChange={(e) => setInput({ ...input, [f.key]: e.target.checked })}>{f.label}</Checkbox>
            : f.kind === 'textarea'
              ? <Input.TextArea key={f.key} aria-label={f.label} placeholder={f.label} autoSize={{ minRows: 2, maxRows: 6 }} value={String(input[f.key] ?? '')} onChange={(e) => setInput({ ...input, [f.key]: e.target.value })} />
              : <Input key={f.key} aria-label={f.label} placeholder={f.label} value={String(input[f.key] ?? '')} onChange={(e) => setInput({ ...input, [f.key]: e.target.value })} />)}
          <Space>
            {cur.answers.length > 0 && <Button type="primary" disabled={!answer || missing} loading={busy} onClick={() => void submit()}>{answer ? ANSWER[answer] ?? answer : '选一种答法'}</Button>}
            {cur.link && !cur.link.startsWith('/api/') && <Typography.Link href={cur.link}>在原页面处理</Typography.Link>}
          </Space>
        </Space>
      </Card>}
    </Space>
  </WmPage>;
}
