import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Space, Typography } from 'antd';
import { getReportGovernanceInbox, decideReportGovernance } from '../api';

type ProposalSummary = {
  id: string;
  status: 'pending' | 'confirming';
  expires_at: number;
  snapshot_sha256: string;
};
type Proposal = ProposalSummary & ({
  op: 'bench-bind';
  frozen: {
    scope: { bench: string; dimension: string; area: string };
    args: { base: number; template_version: number; view_version: number; slots: Record<string, { view: string; block: number }> };
  };
} | {
  op: 'dimension-create';
  frozen: { scope: { area: string; dimension: string }; args: { title: string } };
});

export default function ReportGovernanceInbox() {
  const [rows, setRows] = useState<Proposal[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const load = useCallback(async (after = 0, signal?: AbortSignal) => {
    try {
      const r = await getReportGovernanceInbox(after, signal);
      if (r.status === 401 || r.status === 403) { setRows([]); setNext(null); return; }
      if (!r.ok) throw Error('未能读取待确认的报告治理请求');
      const page = await r.json() as { proposals: Proposal[]; next: number | null };
      setRows(current => after ? [...current, ...page.proposals] : page.proposals);
      setNext(page.next);
    } catch (error) {
      if (!signal?.aborted) setMessage({ error: true, text: (error as Error).message });
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(0, controller.signal);
    return () => controller.abort();
  }, [load]);
  const act = async (row: Proposal, action: 'confirm' | 'reject') => {
    setBusy(row.id);
    setMessage(null);
    try {
      const r = await decideReportGovernance(row.id, action, row.snapshot_sha256);
      const result = await r.json();
      if (!r.ok) throw Error(result.message || result.error || '操作未完成');
      const labels: Record<string, string> = { pending: '正在对账，请稍后再查。', confirmed: row.op === 'dimension-create' ? '报告维度已登记。' : '报告绑定已更新。', rejected: '请求已驳回。', expired: '请求已过期。', conflict: '授权或冻结目标已变化，需要重新提案。' };
      setMessage({ error: result.status === 'conflict' || result.status === 'expired', text: labels[result.status] ?? '请求状态已更新。' });
    } catch (error) { setMessage({ error: true, text: (error as Error).message }); }
    finally { await load(); setBusy(null); }
  };
  if (!rows.length && next === null && !message) return null;
  return <section aria-label="报告治理待确认">
    <Typography.Title level={4}>报告治理</Typography.Title>
    {message && <Alert type={message.error ? 'error' : 'info'} showIcon message={message.text} />}
    {rows.map(row => <Card key={row.id} title={(row.op === 'dimension-create' ? row.frozen.scope.area : row.frozen.scope.bench) + ' · ' + row.frozen.scope.dimension}>
      <Typography.Paragraph>{row.op === 'dimension-create' ? <>登记「{row.frozen.args.title}」维度，尚无生效模板</> :
        <>绑定基版 {row.frozen.args.base} · 模板第 {row.frozen.args.template_version} 版 · 视图第 {row.frozen.args.view_version} 版</>}</Typography.Paragraph>
      <Typography.Text type="secondary">{row.id} · {row.status === 'confirming' ? '确认中' : '待确认'} · 截止 {new Date(row.expires_at).toLocaleString()}</Typography.Text>
      {row.op === 'bench-bind' && <ul>{Object.entries(row.frozen.args.slots).map(([name, slot]) => <li key={name}>{name} → {slot.view} 第 {slot.block + 1} 个块</li>)}</ul>}
      <details><summary>查看冻结详情与摘要</summary><pre>{JSON.stringify(row.frozen, null, 2)}</pre><Typography.Text copyable>{row.snapshot_sha256}</Typography.Text></details>
      <Space>
        {row.status === 'pending' ? <Popconfirm title={row.op === 'dimension-create' ? '确认登记该报告维度？' : '确认更新该台的报告绑定？'} onConfirm={() => act(row, 'confirm')}>
          <Button type="primary" loading={busy === row.id} disabled={busy !== null}>{row.op === 'dimension-create' ? '确认登记' : '确认绑定'}</Button>
        </Popconfirm> : <Button loading={busy === row.id} disabled={busy !== null} onClick={() => void act(row, 'confirm')}>查询提交结果</Button>}
        {row.status === 'pending' && <Popconfirm title="驳回此请求？" onConfirm={() => act(row, 'reject')}><Button disabled={busy !== null}>驳回</Button></Popconfirm>}
      </Space>
    </Card>)}
    {next !== null && <Button onClick={() => void load(next)}>查看更多</Button>}
  </section>;
}
