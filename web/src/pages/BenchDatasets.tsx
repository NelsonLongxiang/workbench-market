/** 数据集退役与恢复页（/bench-datasets/<台标识>，#1015 首版）：在用的数据集可以退役，已退役的可以恢复。
 *  每次都先预检：有阻断就列出在哪、怎么解，不给确认；没有阻断时服务端发 5 分钟、只能用一次的确认凭据，
 *  确认时要一字不差复述数据集名、写理由。谁能做由服务端判（GET retired-datasets 的门；预检、退役、恢复各自再判），页面只照应答显示。
 *  确认没收到应答时不自动重发（凭据可能已用掉），先刷新清单让人核对。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, App, Button, Descriptions, Empty, Input, Modal, Skeleton, Table, Tag, Typography } from 'antd';
import WmPage from '../components/WmPage';
import { datasetLifecyclePost, getBenchDatasets, getRetiredDatasets } from '../api';
import {
  ACTION_TEXT, UNKNOWN_RESULT_TEXT, asActive, asPrecheck, asRetired, blockerText, bytesText, confirmProblem, lifecycleError, newOperationId, ticketLeft,
  type ActiveDataset, type LifecycleAction, type Precheck, type RetiredDataset,
} from '../dataset-lifecycle-view';

type Lists = { active: ActiveDataset[]; retired: RetiredDataset[] };
type Load = { phase: 'loading' } | { phase: 'ok'; data: Lists } | { phase: 'error'; text: string };
type Target = { action: LifecycleAction; name: string; title: string };
const TITLE = '数据集退役与恢复';

function LifecycleDialog({ bench, target, onClose, onChanged }: { bench: string; target: Target; onClose: () => void; onChanged: () => Promise<void> }) {
  const { message } = App.useApp();
  const { action, name } = target, text = ACTION_TEXT[action];
  const [pre, setPre] = useState<Precheck | null>(null);
  const [preErr, setPreErr] = useState('');
  const [checking, setChecking] = useState(true);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const opId = useRef('');
  const precheck = useCallback(async () => {
    setChecking(true); setPre(null); setPreErr(''); setErr('');
    const r = await datasetLifecyclePost(bench, name, action, 'precheck');
    const p = r.status === 200 ? asPrecheck(r.body) : null;
    setChecking(false);
    if (p) { setPre(p); opId.current = newOperationId(crypto.getRandomValues(new Uint8Array(16))); setNow(Date.now()); }
    else setPreErr(r.status === 200 ? '预检应答不完整，稍后再试' : lifecycleError(r.status, r.body));
  }, [bench, name, action]);
  useEffect(() => { void precheck(); }, [precheck]);
  useEffect(() => {
    if (!pre?.ticket) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [pre]);

  const left = pre?.ticket && pre.expires_at ? ticketLeft(pre.expires_at, now) : null;
  const problem = pre?.ticket ? confirmProblem(name, typed, reason) : '';
  const confirm = async () => {
    if (!pre?.ticket || !left || problem || busy) return;
    setBusy(true); setErr('');
    const r = await datasetLifecyclePost(bench, name, action, 'confirm', { ticket: pre.ticket, confirm_name: typed, reason: reason.trim(), operation_id: opId.current });
    setBusy(false);
    if (r.status === 200) {
      onClose();
      void message.success(`「${name}」${text.done}`);
      await onChanged();
      return;
    }
    if (r.status === 0) { onClose(); await onChanged(); void message.warning(UNKNOWN_RESULT_TEXT, 8); return; }
    // 凭据只能用一次：确认被拒后旧凭据不再可用，要重新预检
    setPre((p) => (p ? { ...p, ticket: null, expires_at: null } : p));
    setErr(lifecycleError(r.status, r.body));
  };

  const footer = [
    <Button key="cancel" onClick={onClose} disabled={busy}>取消</Button>,
    ...(!checking && (!pre?.ticket || !left) ? [<Button key="again" onClick={() => void precheck()} data-testid="lifecycle-recheck">重新预检</Button>] : []),
    ...(pre?.ticket && left ? [<Button key="ok" type="primary" danger={action === 'retire'} loading={busy} disabled={!!problem} onClick={() => void confirm()} data-testid="lifecycle-confirm">确认{text.verb}</Button>] : []),
  ];
  return (
    <Modal open title={`${text.verb}数据集「${name}」`} onCancel={busy ? undefined : onClose} maskClosable={false} footer={footer} width={640} destroyOnHidden data-testid="lifecycle-dialog">
      {checking ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
      {preErr ? <Alert type="error" showIcon message={preErr} data-testid="lifecycle-precheck-error" /> : null}
      {pre ? (
        <>
          <Descriptions size="small" column={2} bordered className="wm-ds-summary" items={[
            { key: 'name', label: '数据集', children: <Typography.Text code>{pre.dataset}</Typography.Text> },
            { key: 'title', label: '名称', children: pre.title || '—' },
            { key: 'rows', label: '行数', children: <span data-testid="lifecycle-rows">{pre.rows}</span> },
            { key: 'bytes', label: '占用', children: bytesText(pre.bytes) },
          ]} />
          {action === 'retire' ? <Typography.Paragraph type="secondary" className="wm-ds-note">退役后原数据、列定义和名称都保留，配额照算；普通列表和读写入口不再可用，同名也不能重新定义。之后可以在这里恢复。</Typography.Paragraph> : <Typography.Paragraph type="secondary" className="wm-ds-note">恢复后数据集回到普通列表，原数据和列定义不变；视图和报告绑定不会自动改回来。</Typography.Paragraph>}
          {pre.blockers.length ? (
            <Alert type="warning" showIcon message={`有 ${pre.blockers.length} 项阻断，现在不能${text.verb}`} data-testid="lifecycle-blockers"
              description={<ul className="wm-ds-blockers">{pre.blockers.map((b, i) => <li key={i} data-testid="lifecycle-blocker" data-kind={b.kind}>{blockerText(b)}</li>)}</ul>} />
          ) : null}
          {pre.ticket && left ? (
            <div className="wm-ds-confirm">
              <Typography.Text type="secondary" data-testid="lifecycle-ticket-left">确认凭据 {left} 后失效，只能用一次</Typography.Text>
              <label className="wm-ds-field"><span>请输入数据集名 <Typography.Text code>{name}</Typography.Text> 确认</span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-testid="lifecycle-confirm-name" /></label>
              <label className="wm-ds-field"><span>理由（会留在审计记录里）</span>
                <Input.TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} showCount autoSize={{ minRows: 2, maxRows: 5 }} data-testid="lifecycle-reason" /></label>
              {problem && (typed || reason) ? <Typography.Text type="secondary" data-testid="lifecycle-problem">{problem}</Typography.Text> : null}
            </div>
          ) : null}
          {pre.expires_at !== null && !left && !pre.blockers.length ? <Alert type="info" showIcon message="确认凭据已过期，请重新预检" data-testid="lifecycle-expired" /> : null}
        </>
      ) : null}
      {err ? <Alert type="error" showIcon message={err} className="wm-ds-err" data-testid="lifecycle-error" /> : null}
    </Modal>
  );
}

export default function BenchDatasets() {
  const { bench = '' } = useParams();
  const [s, setS] = useState<Load>({ phase: 'loading' });
  const [target, setTarget] = useState<Target | null>(null);
  const load = useCallback(async () => {
    // 先问已退役清单：它的门就是「能不能做退役、恢复」，没权限的人只看到一句说法，不看清单
    const retired = await getRetiredDatasets(bench);
    if (retired.status !== 200) return setS({ phase: 'error', text: lifecycleError(retired.status, retired.body) });
    const active = await getBenchDatasets(bench);
    const a = active.status === 200 ? asActive(active.body) : null, r = asRetired(retired.body);
    if (!r) return setS({ phase: 'error', text: '读到的内容不完整，稍后再试' });
    if (!a) return setS({ phase: 'error', text: active.status === 200 ? '读到的内容不完整，稍后再试' : lifecycleError(active.status, active.body) });
    setS({ phase: 'ok', data: { active: a, retired: r } });
  }, [bench]);
  useEffect(() => { setS({ phase: 'loading' }); void load(); }, [load]);
  useEffect(() => { document.title = `${TITLE} · ${bench}`; }, [bench]);

  const header = { title: TITLE, detail: bench, wide: true as const };
  if (s.phase === 'loading') return <WmPage {...header}><Skeleton active /></WmPage>;
  if (s.phase === 'error') return <WmPage {...header}><Alert type="error" showIcon message={s.text} data-testid="datasets-error" /></WmPage>;
  const { active, retired } = s.data;
  const open = (action: LifecycleAction, d: { name: string; title: string }) => setTarget({ action, name: d.name, title: d.title });
  return (
    <WmPage {...header} content={<Typography.Paragraph type="secondary" className="wm-ds-intro">每次退役或恢复都先预检：被现行视图、报告绑定用着的不能退役，先在原处改掉。确认要复述数据集名并写理由。</Typography.Paragraph>}
      extra={<Button onClick={() => { setS({ phase: 'loading' }); void load(); }} data-testid="datasets-refresh">刷新</Button>}>
      <section className="wm-ds-section" data-testid="datasets-active">
        <Typography.Title level={5}>在用的数据集 <span className="wm-ds-n">{active.length}</span></Typography.Title>
        <Table rowKey="name" size="middle" pagination={false} dataSource={active} locale={{ emptyText: <Empty description="这个台没有在用的数据集" /> }} columns={[
          { title: '数据集', dataIndex: 'name', width: 260, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '名称', dataIndex: 'title', render: (v: string) => v || '—' },
          { title: '列数', dataIndex: 'columns', width: 100, align: 'right' as const },
          { title: '', key: 'op', width: 140, align: 'right' as const, render: (_: unknown, d: ActiveDataset) => <Button size="small" danger onClick={() => open('retire', d)} data-testid="dataset-retire" data-name={d.name}>退役…</Button> },
        ]} />
      </section>
      <section className="wm-ds-section" data-testid="datasets-retired">
        <Typography.Title level={5}>已退役的数据集 <span className="wm-ds-n">{retired.length}</span></Typography.Title>
        <Table rowKey="name" size="middle" pagination={false} dataSource={retired} locale={{ emptyText: <Empty description="没有已退役的数据集" /> }} columns={[
          { title: '数据集', dataIndex: 'name', width: 260, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '名称', dataIndex: 'title', render: (v: string) => v || '—' },
          { title: '状态', key: 'state', width: 100, render: () => <Tag color="default">已退役</Tag> },
          { title: '行数', dataIndex: 'row_count', width: 100, align: 'right' as const },
          { title: '占用', dataIndex: 'data_bytes', width: 120, align: 'right' as const, render: (v: number) => bytesText(v) },
          { title: '', key: 'op', width: 140, align: 'right' as const, render: (_: unknown, d: RetiredDataset) => <Button size="small" onClick={() => open('restore', d)} data-testid="dataset-restore" data-name={d.name}>恢复…</Button> },
        ]} />
      </section>
      {target ? <LifecycleDialog key={`${target.action}:${target.name}`} bench={bench} target={target} onClose={() => setTarget(null)} onChanged={load} /> : null}
    </WmPage>
  );
}
