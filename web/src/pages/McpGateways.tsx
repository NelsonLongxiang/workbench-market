import { useCallback, useState } from 'react';
import { App, Button, Empty, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';

interface McpSession {
  id: number; name: string; grants: string[]; revoked_at: string; last_used_at: string; created_at: string;
}
interface McpCall { id: number; at: string; session_name: string; method: string; tool: string; ok: number; error: string; duration_ms: number; args_sha256: string; }

const TOOLS = [
  'workbench_list', 'workbench_summary', 'workbench_check', 'use_url',
  'app_publish', 'app_activate', 'sop_publish',
  'sop_run_start', 'sop_run_step_save', 'sop_run_get', 'sop_run_list', 'sop_run_finish',
  'workbench_register', 'workbench_update', 'workbench_unregister',
  'app_data_list', 'app_files_list',
];

/** MCP 网关管理页（GH #20 P1）：会话/令牌/授权/审计——全部走既有五端点（无新后端）。
 *  口令只存会话态（同 /sops 网络暴露区模式）；ADMIN_TOKEN 未设时控制面一律 403。 */
export default function McpGateways() {
  const { message, modal } = App.useApp();
  const [token, setToken] = useState('');
  const [sessions, setSessions] = useState<McpSession[]>([]);
  const [calls, setCalls] = useState<McpCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [callsLoading, setCallsLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [grantsOf, setGrantsOf] = useState<McpSession | null>(null);
  const [grantSel, setGrantSel] = useState<string[]>([]);
  const [regTools, setRegTools] = useState<string[]>([]); // #grant-ux：活注册表（修硬编码 15 时代旧清单→未知名 400 根因）
  // 上游聚合（#20 P2）配置面
  const [upstreams, setUpstreams] = useState<{ prefix: string; url: string; enabled: boolean }[]>([]);
  const [upPrefix, setUpPrefix] = useState('');
  const [upUrl, setUpUrl] = useState('');
  const [upHeaders, setUpHeaders] = useState('{"X-Market-Client":"mcp/market-gateway"}');

  const H = { 'X-Admin-Token': token };

  const reload = useCallback(() => {
    if (!token) return;
    fetch('/api/mcp/tools', { headers: H })
      .then((r) => (r.ok ? r.json() : { tools: [] }))
      .then((j) => setRegTools((j.tools || []).map((x: { name?: string } | string) => (typeof x === 'string' ? x : String(x?.name ?? ''))).filter(Boolean)))
      .catch(() => setRegTools([]));
    setLoading(true);
    fetch('/api/mcp/sessions', { headers: H })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setSessions)
      .catch(() => message.error('会话列表加载失败（口令无效或 ADMIN_TOKEN 未设）'))
      .finally(() => setLoading(false));
    fetch('/api/mcp/upstreams', { headers: H })
      .then((r) => (r.ok ? r.json() : []))
      .then(setUpstreams)
      .catch(() => setUpstreams([]));
    setCallsLoading(true);
    fetch('/api/mcp/calls?limit=100', { headers: H })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCalls)
      .catch(() => undefined)
      .finally(() => setCallsLoading(false));
  }, [token, message]);

  const createSession = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/mcp/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...H },
        body: JSON.stringify({ name: newName }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((b as { error?: string }).error || `HTTP ${r.status}`);
      modal.success({
        title: `会话 ${b.name} 已创建`,
        content: (
          <div>
            <Typography.Paragraph type="warning" style={{ fontWeight: 600 }}>
              令牌仅此一次显示——请立即复制分发（库存只有 sha256，无法取回）：
            </Typography.Paragraph>
            <Typography.Paragraph copyable className="wm-mono" style={{ wordBreak: 'break-all', fontSize: 12 }}>
              {b.token}
            </Typography.Paragraph>
            <Typography.Text type="secondary">新会话授权为空（默认拒绝）——请到 grants 编辑器分配工具。</Typography.Text>
          </div>
        ),
        width: 640,
      });
      setNewName('');
      reload();
    } catch (e) {
      message.error(`创建失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (id: number) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/mcp/sessions/${id}`, { method: 'DELETE', headers: H });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      message.success('已软吊销（令牌即时失效，留审计行）');
      reload();
    } catch (e) {
      message.error(`吊销失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const saveGrants = async () => {
    if (!grantsOf) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/mcp/sessions/${grantsOf.id}/grants`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...H },
        body: JSON.stringify({ grants: grantSel }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      message.success(`授权已整体替换（${grantSel.length} 个工具）`);
      setGrantsOf(null);
      reload();
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const saveUpstreams = async (next: { prefix: string; url: string; enabled: boolean }[]) => {
    setLoading(true);
    try {
      const r = await fetch('/api/mcp/upstreams', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...H },
        body: JSON.stringify({ upstreams: next.map((u) => ({ ...u, headers: JSON.parse(upHeaders || '{}') })) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      message.success('上游已保存（工具面 30s 内刷新）');
      reload();
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const addUpstream = () => {
    if (!/^[a-z][a-z0-9]{0,15}$/.test(upPrefix)) { message.error('prefix 规范：小写字母开头，小写字母/数字，≤16 字符'); return; }
    if (!/^https?:\/\//.test(upUrl)) { message.error('url 必须 http(s)://'); return; }
    void saveUpstreams([...upstreams.filter((u) => u.prefix !== upPrefix), { prefix: upPrefix, url: upUrl, enabled: true }]);
    setUpPrefix(''); setUpUrl('');
  };

  // 列序按 PATTERNS.md §5：状态（最左）→ 名称 → 关键属性 → 时间 → 操作
  const sessCols: ProColumns<McpSession>[] = [
    { title: '状态', dataIndex: 'revoked_at', width: 90, fixed: 'left', render: (_, s) => (s.revoked_at ? <Tag color="red">已吊销</Tag> : <Tag color="green">有效</Tag>) },
    { title: '会话', dataIndex: 'name', render: (_, s) => <Typography.Text className="wm-mono" strong>{s.name}</Typography.Text> },
    { title: '授权工具', dataIndex: 'grants', width: 110, render: (_, s) => (s.grants.length ? <Tag color="green">{s.grants.length} 个</Tag> : <Tag color="red">默认拒绝</Tag>) },
    { title: '最近使用', dataIndex: 'last_used_at', width: 120, render: (_, s) => <RelTime value={s.last_used_at || null} /> },
    {
      title: '操作', valueType: 'option', width: 160, fixed: 'right',
      render: (_, s) => s.revoked_at ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>留审计</Typography.Text> : (
        <Space>
          <Button size="small" onClick={() => { setGrantsOf(s); setGrantSel(s.grants); }}>grants</Button>
          <Popconfirm title={`吊销 ${s.name}？令牌即时失效。`} onConfirm={() => revoke(s.id)}>
            <Button size="small" danger>吊销</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const callCols: ProColumns<McpCall>[] = [
    { title: '结果', dataIndex: 'ok', width: 70, fixed: 'left', render: (_, c) => (c.ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>) },
    { title: '工具', dataIndex: 'tool', width: 160, render: (_, c) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{c.tool || '—'}</Typography.Text> },
    { title: '会话', dataIndex: 'session_name', width: 120, render: (_, c) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{c.session_name}</Typography.Text> },
    { title: '方法', dataIndex: 'method', width: 100, render: (_, c) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{c.method}</Typography.Text> },
    { title: '耗时', dataIndex: 'duration_ms', width: 80, align: 'right', render: (_, c) => <Typography.Text className="wm-num">{c.duration_ms}ms</Typography.Text> },
    { title: '错误', dataIndex: 'error', ellipsis: true, render: (_, c) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.error || '—'}</Typography.Text> },
    { title: '时间', dataIndex: 'at', width: 120, render: (_, c) => <RelTime value={c.at} /> },
  ];

  return (
    <WmPage subTitle="会话 · 令牌 · 授权 · 审计（默认拒绝）">
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        令牌只经创建响应出现一次（库存 sha256）；新会话授权为空=默认拒绝；吊销即时生效。
        401 拒绝不进审计只计数。激活需服务端 ADMIN_TOKEN+MCP_GATEWAY=on。
      </Typography.Paragraph>
      <Space.Compact style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}>
        <Input.Password
          prefix={<KeyOutlined />}
          placeholder="管理员口令（X-Admin-Token，服务端环境变量 ADMIN_TOKEN）"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ fontSize: 13 }}
        />
        <Button onClick={reload} loading={loading} disabled={!token}>载入</Button>
      </Space.Compact>
      <Space.Compact style={{ width: '100%', maxWidth: 640, marginBottom: 16 }}>
        <Input
          prefix={<PlusOutlined />}
          placeholder="新会话名（小写字母/数字/连字符，如 agent-alpha）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="wm-mono"
          style={{ fontSize: 13 }}
        />
        <Button type="primary" onClick={createSession} loading={loading} disabled={!token || !newName}>创建会话</Button>
      </Space.Compact>

      <Tabs
        items={[
          {
            key: 'sessions', label: '会话与审计',
            children: (
              <>
                <ProTable<McpSession> rowKey="id" size="middle" columns={sessCols} dataSource={sessions} loading={loading} search={false} options={false} toolBarRender={false}
                  pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  locale={{ emptyText: <Empty description="无会话——输入口令载入，或创建首个会话" /> }} />
                <Typography.Title level={5} style={{ marginTop: 24 }}>审计（最近 100 条）</Typography.Title>
                <ProTable<McpCall> rowKey="id" size="middle" columns={callCols} dataSource={calls} loading={callsLoading} search={false} options={false} toolBarRender={false} pagination={{ pageSize: 20, hideOnSinglePage: true }} />
              </>
            ),
          },
          {
            key: 'upstreams', label: `上游聚合（${upstreams.length}）`,
            children: (
              <>
                <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
                  外部 MCP 服务的工具以 <Typography.Text code>&lt;prefix&gt;__&lt;tool&gt;</Typography.Text> 并入 /mcp（如 taste-mcp → <Typography.Text code>taste__rules</Typography.Text>）。
                  上游不可达时自动降级、不影响本地 17 工具。配置整体替换。
                </Typography.Paragraph>
                <Space.Compact style={{ width: '100%', maxWidth: 720, marginBottom: 12 }}>
                  <Input placeholder="prefix（如 taste）" value={upPrefix} onChange={(e) => setUpPrefix(e.target.value)} style={{ width: 180, fontSize: 13 }} className="wm-mono" />
                  <Input placeholder="MCP 端点 URL（如 http://127.0.0.1:9810/mcp）" value={upUrl} onChange={(e) => setUpUrl(e.target.value)} style={{ fontSize: 13 }} />
                  <Button type="primary" onClick={addUpstream} disabled={!token}>添加/更新</Button>
                </Space.Compact>
                <Input.TextArea rows={2} value={upHeaders} onChange={(e) => setUpHeaders(e.target.value)}
                  style={{ maxWidth: 720, fontSize: 12, marginBottom: 12 }} className="wm-mono"
                  placeholder='上游请求头 JSON（如 {"X-Market-Client":"mcp/market-gateway"}）' />
                <Table rowKey="prefix" size="small" dataSource={upstreams} loading={loading} pagination={false}
                  columns={[
                    { title: 'prefix', dataIndex: 'prefix', render: (v: string) => <Typography.Text className="wm-mono" strong>{v}</Typography.Text> },
                    { title: '端点', dataIndex: 'url', render: (v: string) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{v}</Typography.Text> },
                    { title: '状态', dataIndex: 'enabled', width: 80, render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>) },
                    {
                      title: '操作', width: 90,
                      render: (_: unknown, u: { prefix: string; url: string; enabled: boolean }) => (
                        <Popconfirm title={`移除上游 ${u.prefix}？`} onConfirm={() => void saveUpstreams(upstreams.filter((x) => x.prefix !== u.prefix))}>
                          <Button size="small" danger>移除</Button>
                        </Popconfirm>
                      ),
                    },
                  ]}
                  locale={{ emptyText: <Empty description="还没有配置上游 —— 输入 prefix 与端点后点「添加/更新」" /> }} />
              </>
            ),
          },
        ]}
      />

      <Modal
        title={`授权编辑：${grantsOf?.name ?? ''}`}
        open={!!grantsOf}
        onOk={saveGrants}
        onCancel={() => setGrantsOf(null)}
        okText="整体替换"
        width={520}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          勾选该会话可用的工具（整体替换语义；新会话为空=默认拒绝）。工具面共 15 个。
        </Typography.Paragraph>
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          placeholder="选择授权工具"
          value={grantSel}
          onChange={setGrantSel}
          options={regTools.map((t) => ({ value: t, label: t }))}
        />
      </Modal>
    </WmPage>
  );
}
