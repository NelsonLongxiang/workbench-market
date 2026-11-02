import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, App, Button, Card, Descriptions, Empty, Form, Input, Modal, Space, Tag, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { adminActive, apiFetch, getAdminToken, subscribeAdminToken } from '../admin-token';
import WmPage from '../components/WmPage';

type Review = { id: number; kind: string; slug: string; op: string; target_version: number | null; status: string; reason: string; requested_by: string; reviewed_by: string; created_at: string };
const labels: Record<string, string> = { pending: '待人审', approved: '已批准', rejected: '已拒绝' };
export default function Reviews() {
  const [params] = useSearchParams();
  const request = params.get('request');
  const [token, setToken] = useState(getAdminToken);
  const [rows, setRows] = useState<Review[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const canQuery = admin;
  useEffect(() => subscribeAdminToken(() => setToken(getAdminToken())), []);
  const load = useCallback(async () => {
    if (!canQuery) { setRows([]); return; }
    setLoading(true); setError('');
    try {
      const response = await apiFetch('/api/change-requests');
      const result = await response.json();
      if (!response.ok || !Array.isArray(result)) throw Error(result?.error || '读取申请失败');
      setRows(result);
    } catch (e) { setRows([]); setError(e instanceof Error ? e.message : '读取申请失败'); }
    finally { setLoading(false); }
  }, [canQuery, token]);
  useEffect(() => { void load(); }, [load]);
  const decide = (row: Review, op: 'approve' | 'reject') => {
    if (!reviewer.trim()) { void message.warning('请填写审核人'); return; }
    Modal.confirm({ title: op === 'approve' ? '确认执行该变更' : '确认拒绝该变更',
      content: row.slug + ' · ' + row.op + (row.target_version ? ' · v' + row.target_version : '') + ' · 申请 #' + row.id,
      okText: op === 'approve' ? '确认执行' : '确认拒绝', cancelText: '取消',
      async onOk() {
        setBusy(true);
        try {
          const response = await apiFetch('/api/change-requests/' + row.id + '/' + op, { method: 'POST', body: JSON.stringify({ reviewed_by: reviewer.trim() }) });
          const result = await response.json();
          if (!response.ok || result.ok !== true) throw Error(result?.error || '处理失败');
          void message.success(op === 'approve' ? '已批准并执行' : '已拒绝');
        } catch (e) { void message.error(e instanceof Error ? e.message : '处理失败'); throw e; }
        finally { setBusy(false); await load(); }
      },
    });
  };
  const selected = request ? rows.filter(row => String(row.id) === request) : rows;
  return <WmPage title="变更人审">
    {!admin ? <Alert type="info" showIcon message="请先确认管理员身份" description="在顶栏输入管理员口令，或用 Odoo 管理员账号登录，之后自动读取申请。" />
      : <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="批准会实际执行回滚或删除" description="核对申请对象、目标版本和理由；已处理申请不可重复执行。" />
        <Space><Form.Item label="审核人" style={{ marginBottom: 0 }}><Input id="reviewer-name" aria-label="审核人" value={reviewer} onChange={e => setReviewer(e.target.value)} autoComplete="off" /></Form.Item><Button loading={loading} onClick={() => void load()}>刷新申请</Button></Space>
        {error && <Alert type="error" showIcon message={error} />}
        {!loading && !error && selected.length === 0 && <Empty description={request ? '未找到该申请，请核对编号或刷新；不会自动创建或批准。' : '暂无变更申请'} />}
        {selected.map(row => <Card key={row.id} title={'申请 #' + row.id + ' · ' + row.slug} extra={<Tag color={row.status === 'approved' ? 'success' : 'default'}>{labels[row.status] || row.status}</Tag>} loading={loading}>
          <Descriptions column={1} items={[{key:'op',label:'操作',children:row.kind + ' / ' + row.op},{key:'version',label:'目标版本',children:row.target_version ? 'v' + row.target_version : '—'},{key:'reason',label:'理由',children:row.reason},{key:'requester',label:'申请者',children:row.requested_by},{key:'reviewer',label:'审核人',children:row.reviewed_by || '待填写'}]} />
          {row.status === 'pending' && <Space><Button type="primary" loading={busy} onClick={() => decide(row, 'approve')}>批准并执行</Button><Button disabled={busy} onClick={() => decide(row, 'reject')}>拒绝申请</Button></Space>}
          {row.status !== 'pending' && <Typography.Text type="secondary">该申请已处理，不会再次执行。</Typography.Text>}
        </Card>)}
      </Space>}
  </WmPage>;
}
