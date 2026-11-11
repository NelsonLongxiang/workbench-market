/** 对端登记表（只读）：一个节点一行——根地址、域、钉住的公钥指纹、名片能力和版本、登记人、状态，和按对端的健康。
 *  只给管理员（GET /api/a2a/peers 走管理门）。升级回填建出来的（registered_by = system:migration）可以单独筛出来过目。
 *  公钥变了的对端会进「关注」；确认新公钥、停用、重新启用走管理接口。 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { apiFetch } from '../admin-token';
import WmPage from '../components/WmPage';

type Health = { last_sent_at: string; last_failure_at: string; last_failure_reason: string; last_receipt_at: string; in_flight: number; card_fetched_at: string };
type Peer = {
  id: string; root_url: string; zone: string; name: string; key_fingerprint: string; pending_fingerprint: string;
  card_version: string; card_capabilities: unknown; status: 'active' | 'pending_registration' | 'key_changed' | 'disabled';
  registered_by: string; registered_at: string; disabled_reason: string; card_error: string; health: Health;
};

const STATUS: Record<Peer['status'], { text: string; color: string }> = {
  active: { text: '正常', color: 'green' },
  pending_registration: { text: '待登记（取不到名片，不挡投递）', color: 'gold' },
  key_changed: { text: '公钥变了，等确认（投递挂起）', color: 'red' },
  disabled: { text: '已停用（投递挂起）', color: 'default' },
};
const short = (fp: string) => (fp ? fp.slice(0, 19) + '…' : '—');
const when = (t: string) => t || '—';

export default function A2aPeers() {
  const [rows, setRows] = useState<Peer[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'all' | 'migration'>('all');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const q = scope === 'migration' ? '?registered_by=system%3Amigration' : '';
      const r = await apiFetch('/api/a2a/peers' + q);
      if (!r.ok) throw new Error(`读不到对端列表（HTTP ${r.status}）`);
      setRows(await r.json());
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [scope]);
  useEffect(() => { void load(); }, [load]);

  return (
    <WmPage
      subTitle="接入市场的节点：钉住的名片公钥和按对端的健康。公钥变了不自动接受，会出现在「关注」里"
      extra={[<Button key="r" icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>]}
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Space style={{ marginBottom: 16 }}>
        <Segmented value={scope} onChange={(v) => setScope(v as 'all' | 'migration')} options={[{ label: '全部', value: 'all' }, { label: '升级回填建出来的（待过目）', value: 'migration' }]} />
      </Space>
      <Table<Peer>
        rowKey="id" loading={loading} dataSource={rows} pagination={false} size="middle"
        columns={[
          { title: '根地址', dataIndex: 'root_url', render: (v: string, p) => <Space direction="vertical" size={0}><Typography.Text copyable>{v}</Typography.Text><Typography.Text type="secondary">{p.zone || '—'}{p.name ? ` · ${p.name}` : ''}</Typography.Text></Space> },
          { title: '状态', dataIndex: 'status', render: (s: Peer['status'], p) => <Space direction="vertical" size={0}><Tag color={STATUS[s].color}>{STATUS[s].text}</Tag>{s === 'disabled' && p.disabled_reason ? <Typography.Text type="secondary">{p.disabled_reason}</Typography.Text> : null}{p.card_error ? <Typography.Text type="secondary">{p.card_error}</Typography.Text> : null}</Space> },
          { title: '公钥指纹', dataIndex: 'key_fingerprint', render: (fp: string, p) => <Space direction="vertical" size={0}><Tooltip title={fp}><Typography.Text code>{short(fp)}</Typography.Text></Tooltip>{p.pending_fingerprint ? <Tooltip title={p.pending_fingerprint}><Typography.Text type="danger">新：{short(p.pending_fingerprint)}</Typography.Text></Tooltip> : null}</Space> },
          { title: '名片版本', dataIndex: 'card_version', render: (v: string) => v || '—' },
          { title: '登记', dataIndex: 'registered_by', render: (by: string, p) => <Space direction="vertical" size={0}><span>{by}</span><Typography.Text type="secondary">{p.registered_at}</Typography.Text></Space> },
          { title: '最近投递成功', render: (_: unknown, p) => when(p.health.last_sent_at) },
          { title: '最近投递失败', render: (_: unknown, p) => p.health.last_failure_at ? <Tooltip title={p.health.last_failure_reason}>{p.health.last_failure_at}</Tooltip> : '—' },
          { title: '最近收到回执', render: (_: unknown, p) => when(p.health.last_receipt_at) },
          { title: '在途', render: (_: unknown, p) => p.health.in_flight },
          { title: '名片最近取到', render: (_: unknown, p) => when(p.health.card_fetched_at) },
        ]}
      />
    </WmPage>
  );
}
