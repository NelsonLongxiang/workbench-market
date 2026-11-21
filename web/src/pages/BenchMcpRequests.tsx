/** MCP 网关页「台上的申请」（#904）：AI 会话申请在某个台上用工具，待批的都列在这里，链到各台的 MCP 授权页去办。
 *  清单和「等你拍板」用同一份数据（/api/attention 的 bench-mcp 来源）：谁看得到由服务端定（有台的拍板授予的人），页面不另判。
 *  读不到照实说，不显示成「没有申请」。 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Empty, Skeleton, Table, Tag, Typography } from 'antd';
import { getAttention } from '../api';
import { grantDetailOf } from '../review-view';
import { benchRequestRows, type BenchRequestRow } from '../bench-mcp-view';

type Load = { phase: 'loading' } | { phase: 'ok'; rows: BenchRequestRow[] } | { phase: 'error'; text: string };

export default function BenchMcpRequests() {
  const [s, setS] = useState<Load>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    void getAttention().then((a) => {
      if (!live) return;
      if (a.status !== 200) { setS({ phase: 'error', text: a.status === 401 ? '请先登录' : a.identityDown ? '暂时取不到（身份服务连不上），稍后再试' : '暂时取不到台上的申请，稍后再试' }); return; }
      setS({ phase: 'ok', rows: benchRequestRows(a.items, grantDetailOf) });
    });
    return () => { live = false; };
  }, []);
  return (
    <div data-testid="mcp-bench-requests">
      <Typography.Paragraph type="secondary" className="wm-caption">
        AI 会话申请在某个台上用工具（台里是业务数据）。这里列出你能批的待批申请；到各台的「MCP 授权」页去批准或驳回，那里也看得到办过的申请、现有授予和留痕。
        要用有台的拍板授予（现在是管理层）的账号登录才看得到，只有系统管理员授予或管理口令的看不到。
      </Typography.Paragraph>
      {s.phase === 'loading' ? <Skeleton active /> : null}
      {s.phase === 'error' ? <Alert type="error" showIcon message={s.text} data-testid="mcp-bench-requests-error" /> : null}
      {s.phase === 'ok' ? (
        <Table<BenchRequestRow> rowKey="key" size="small" dataSource={s.rows} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: true }}
          locale={{ emptyText: <div data-testid="mcp-bench-requests-empty"><Empty description="没有你能批的台上的申请" /></div> }}
          columns={[
            { title: '编号', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
            { title: '台', dataIndex: 'benchTitle', render: (v: string, r) => <>{v} <Typography.Text code>{r.bench}</Typography.Text>{r.registered ? null : <Tag>卡片还没开台库</Tag>}</> },
            { title: '会话', dataIndex: 'session', width: 130, render: (v: string) => v || '（已删）' },
            { title: '工具', key: 'tools', render: (_: unknown, r) => <>{r.read.map((t) => <Tag key={t} color="processing">{t} · 只读</Tag>)}{r.write.map((t) => <Tag key={t} color="warning">{t} · 写</Tag>)}</> },
            { title: '理由', dataIndex: 'reason' },
            { title: '办理', key: 'go', width: 120, render: (_: unknown, r) => <Link to={r.to} data-testid="mcp-bench-requests-go">{r.registered ? '去台的授权页' : '去「等你拍板」'}</Link> },
          ]} />
      ) : null}
    </div>
  );
}
