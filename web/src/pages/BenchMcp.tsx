/** 台的 MCP 管理页（/bench-mcp/<台标识>，#904）：AI 会话在这个台上的工具授予、申请、写法对不上的申请、留痕；能批的人在这里批准或驳回。
 *  入口：视图台页面顶栏的「MCP 授权」（入口说 can.mcp 才出）、MCP 网关页「台上的申请」。
 *  页面只消费接口：谁能看（GET mcp-grants 的门）、谁能批（应答里的 can.decide）、批得了批不了，都由服务端说；没成照服务端的说法提示，读不到不显示成「没有申请」。 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Empty, Input, Modal, Skeleton, Table, Tag, Typography } from 'antd';
import WmPage from '../components/WmPage';
import { decideBenchMcp, getBenchMcp, type BenchMcpPage, type BenchMcpRequest, type BenchMcpTool } from '../api';
import { asMcpPage, categoryText, decideProblem, grantSource, logActionText, mcpError, splitRequests, statusOf, timeText } from '../bench-mcp-view';

type Load = { phase: 'loading' } | { phase: 'ok'; data: BenchMcpPage } | { phase: 'error'; text: string };

const Tools = ({ list }: { list: BenchMcpTool[] }) => (
  <span className="wm-bm-tools">{list.map((t) => <Tag key={t.tool} color={t.category === 'read' ? 'processing' : 'warning'} data-testid="bench-mcp-tool" data-category={t.category}>{t.tool} · {categoryText(t.category)}</Tag>)}</span>
);

export default function BenchMcp() {
  const { bench = '' } = useParams();
  const [s, setS] = useState<Load>({ phase: 'loading' });
  const [deciding, setDeciding] = useState<{ req: BenchMcpRequest; approve: boolean } | null>(null);
  const load = useCallback(async () => {
    const r = await getBenchMcp(bench);
    const page = r.status === 200 ? asMcpPage(r.body) : null;
    setS(page ? { phase: 'ok', data: page } : { phase: 'error', text: r.status === 200 ? '读到的内容不完整，稍后再试' : mcpError(r.status, r.body) });
  }, [bench]);
  useEffect(() => { setS({ phase: 'loading' }); void load(); }, [load]);
  useEffect(() => { if (s.phase === 'ok') document.title = `MCP 授权 · ${s.data.bench.title}`; }, [s]);

  if (s.phase === 'loading') return <WmPage title="台的 MCP 授权"><Skeleton active /></WmPage>;
  if (s.phase === 'error') return <WmPage title="台的 MCP 授权"><Alert type="error" showIcon message={s.text} data-testid="bench-mcp-error" /></WmPage>;
  const d = s.data;
  const { pending, done } = splitRequests(d.requests);
  const reqCols = (withActions: boolean) => [
    { title: '编号', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
    { title: '会话', dataIndex: 'session', width: 140, render: (v: string) => v || '（已删）' },
    { title: '工具', dataIndex: 'tool_kinds', render: (v: BenchMcpTool[]) => <Tools list={v ?? []} /> },
    { title: '理由', dataIndex: 'reason', render: (v: string) => <span className="wm-bm-wrap">{v}</span> },
    { title: '提出', dataIndex: 'created_at', width: 140, render: (v: number) => timeText(v) },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={statusOf(v).color} data-testid="bench-mcp-status">{statusOf(v).text}</Tag> },
    ...(withActions ? (d.can.decide ? [{
      title: '办理', key: 'act', width: 150,
      render: (_: unknown, r: BenchMcpRequest) => (
        <span className="wm-bm-acts">
          <Button size="small" type="primary" onClick={() => setDeciding({ req: r, approve: true })} data-testid="bench-mcp-approve">批准</Button>
          <Button size="small" danger onClick={() => setDeciding({ req: r, approve: false })} data-testid="bench-mcp-reject">驳回</Button>
        </span>
      ),
    }] : []) : [
      { title: '谁定的', dataIndex: 'decided_by', width: 130, render: (v: string, r: BenchMcpRequest) => (r.status === 'expired' ? '到期' : v || '—') },
      { title: '定的时候写的', dataIndex: 'note', render: (v: string) => <span className="wm-bm-wrap" data-testid="bench-mcp-note">{v || '—'}</span> },
    ]),
  ];
  return (
    <WmPage title="台的 MCP 授权" detail={d.bench.title} wide>
      <Typography.Paragraph type="secondary" className="wm-caption" data-testid="bench-mcp-bench">
        台：{d.bench.title}（标识 <Typography.Text code>{d.bench.slug}</Typography.Text>{d.bench.workbench_id !== null ? `，卡片 ${d.bench.workbench_id}` : ''}）。
        AI 会话经 MCP 申请在这个台上用工具；批准后立即生效，会话看得到结果和理由。{d.can.decide ? '' : '你能看、不能批（要有这个台的拍板授予）。'}
      </Typography.Paragraph>

      <Typography.Title level={5}>待批的申请（{pending.length}）</Typography.Title>
      <div data-testid="bench-mcp-pending">
        <Table<BenchMcpRequest> rowKey="id" size="small" columns={reqCols(true)} dataSource={pending} pagination={false} scroll={{ x: true }}
          locale={{ emptyText: <Empty description="没有待批的申请" /> }} />
      </div>

      {d.unmatched.length ? (
        <div data-testid="bench-mcp-unmatched" className="wm-bm-block">
          <Typography.Title level={5}>写法对不上、这个台批不了的申请（{d.unmatched.length}）</Typography.Title>
          {d.unmatched.map((u) => (
            <Alert key={u.id} type="warning" showIcon className="wm-bm-gap"
              message={<>#{u.id} · 会话 {u.session || '（已删）'} · {statusOf(u.status).text} · {timeText(u.created_at)}</>}
              description={<><div>{u.why}</div><Tools list={u.tool_kinds ?? []} /></>} />
          ))}
        </div>
      ) : null}

      <Typography.Title level={5} className="wm-bm-block">现有授予</Typography.Title>
      <div data-testid="bench-mcp-grants">
        {d.grants.length ? d.grants.map((g) => (
          <div key={g.session_id} className="wm-bm-grant" data-testid="bench-mcp-grant" data-session={g.session}>
            <div className="wm-bm-grant-head">会话 {g.session || '（已删）'}{g.revoked ? <Tag className="wm-bm-gap-l">已吊销</Tag> : null}</div>
            <ul className="wm-bm-grant-tools">
              {g.tools.map((t) => (
                <li key={t.tool} data-testid="bench-mcp-grant-tool" data-tool={t.tool} data-source={t.request_id === null ? 'direct' : 'request'}>
                  <Tag color={t.category === 'read' ? 'processing' : 'warning'}>{t.tool} · {categoryText(t.category)}</Tag>
                  <span className="wm-caption">{grantSource(t.request_id)} · {t.granted_by} · {timeText(t.granted_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )) : <Empty description="这个台上还没有会话的工具授予" />}
      </div>

      <Typography.Title level={5} className="wm-bm-block">办过的申请（{done.length}）</Typography.Title>
      <div data-testid="bench-mcp-done">
        <Table<BenchMcpRequest> rowKey="id" size="small" columns={reqCols(false)} dataSource={done} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: true }}
          locale={{ emptyText: <Empty description="还没有办过的申请" /> }} />
      </div>

      <Typography.Title level={5} className="wm-bm-block">留痕（最近 100 条）</Typography.Title>
      <Table rowKey="id" size="small" dataSource={d.log} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: true }} data-testid="bench-mcp-log"
        columns={[
          { title: '时间', dataIndex: 'at', width: 140, render: (v: number) => timeText(v) },
          { title: '动作', dataIndex: 'action', width: 100, render: (v: string) => logActionText(v) },
          { title: '工具', dataIndex: 'tools', render: (v: string[]) => v.join('、') },
          { title: '谁', dataIndex: 'actor', width: 130 },
          { title: '申请', dataIndex: 'request_id', width: 80, render: (v: number | null) => (v === null ? '—' : `#${v}`) },
          { title: '说明', dataIndex: 'note', render: (v: string) => <span className="wm-bm-wrap">{v || '—'}</span> },
        ]} />

      {deciding ? <DecideDialog bench={d.bench.slug} req={deciding.req} approve={deciding.approve} onClose={() => setDeciding(null)} onDone={async () => { setDeciding(null); await load(); }} /> : null}
    </WmPage>
  );
}

/** 批准（可以留一句）或驳回（必须写理由）：没成照服务端说，对话框不关 */
function DecideDialog({ bench, req, approve, onClose, onDone }: { bench: string; req: BenchMcpRequest; approve: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const problem = decideProblem(approve, note);
  const send = async () => {
    setBusy(true);
    const r = await decideBenchMcp(bench, req.id, approve, note);
    setBusy(false);
    if (r.status === 200) { await onDone(); return; }
    setMsg(mcpError(r.status, r.body));
  };
  return (
    <Modal open title={`${approve ? '批准' : '驳回'}申请 #${req.id}`} onCancel={onClose} maskClosable={!busy}
      footer={[
        <Button key="c" onClick={onClose} disabled={busy}>取消</Button>,
        <Button key="ok" type="primary" danger={!approve} loading={busy} disabled={!!problem} title={problem || undefined} onClick={() => void send()} data-testid="bench-mcp-confirm">{approve ? '批准' : '驳回'}</Button>,
      ]}>
      <div className="wm-bm-dialog" data-testid="bench-mcp-dialog">
        <div>会话 {req.session || '（已删）'} 申请：<Tools list={req.tool_kinds ?? []} /></div>
        <div className="wm-caption">理由：{req.reason}</div>
        <Input.TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} showCount autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder={approve ? '可以留一句（会话看得到）' : '驳回理由（必填，会话看得到）'} aria-label="说明" data-testid="bench-mcp-note-input" />
        {msg ? <Alert type="error" showIcon message={msg} data-testid="bench-mcp-dialog-msg" /> : null}
      </div>
    </Modal>
  );
}
