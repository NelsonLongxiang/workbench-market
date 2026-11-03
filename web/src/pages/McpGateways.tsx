import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Empty, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { adminActive, apiFetch, odooAdmin, setAdminToken, subscribeAdminToken } from '../admin-token';

interface McpSession {
  id: number; name: string; grants: string[]; revoked_at: string; last_used_at: string; created_at: string;
}
interface AccessRequest {
  id: number; session_id: number; session_name: string | null; session_revoked: boolean; tools: string[]; reason: string;
  status: 'pending' | 'approved' | 'rejected'; decided_by: string; decided_at: string; note: string; created_at: string;
}
type ReqStatus = AccessRequest['status'] | 'all';
const REQ_STATUS: Record<AccessRequest['status'], { color: string; label: string }> = {
  pending: { color: 'gold', label: '待批' }, approved: { color: 'green', label: '已批准' }, rejected: { color: 'default', label: '已驳回' },
};
const CATEGORY: Record<string, { color: string; label: string }> = {
  read: { color: 'blue', label: '只读' }, write: { color: 'orange', label: '写' }, admin: { color: 'red', label: '管理' },
};
interface McpCall { id: number; at: string; session_name: string; method: string; tool: string; ok: number; error: string; duration_ms: number; args_sha256: string; }

const TOOLS = [
  'workbench_list', 'workbench_summary', 'workbench_check', 'use_url',
  'app_sync', 'app_activate', 'sop_publish',
  'sop_run_start', 'sop_run_step_save', 'sop_run_get', 'sop_run_list', 'sop_run_finish',
  'workbench_register', 'workbench_update', 'workbench_unregister',
  'app_data_list', 'app_files_list',
];

/** MCP 网关管理页（GH #20 P1）：会话/令牌/授权/审计——全部走既有五端点（无新后端）。
 *  #375：接入全局管理身份——持顶栏口令或已登录 Odoo 管理员即可载入；口令框只在两者都没有时出现，写入全局口令。 */
export default function McpGateways() {
  const { message, modal } = App.useApp();
  const [active, setActive] = useState(adminActive()); // 持口令或 Odoo 管理员
  const [tokenDraft, setTokenDraft] = useState('');
  const [sessions, setSessions] = useState<McpSession[]>([]);
  const [calls, setCalls] = useState<McpCall[]>([]);
  const [loading, setLoading] = useState(false);
  const [callsLoading, setCallsLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [grantsOf, setGrantsOf] = useState<McpSession | null>(null);
  const [grantSel, setGrantSel] = useState<string[]>([]);
  const [regTools, setRegTools] = useState<string[]>([]); // #grant-ux：活注册表（修硬编码 15 时代旧清单→未知名 400 根因）
  const [toolCat, setToolCat] = useState<Record<string, string>>({}); // 工具名 → read / write / admin
  // 权限申请（会话经 MCP access_request 提交；这里批准/驳回）
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [reqStatus, setReqStatus] = useState<ReqStatus>('pending');
  const reqStatusRef = useRef<ReqStatus>('pending'); // 刷新时沿用当前筛选，不让 reload 随筛选重建
  const [reqLoading, setReqLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [deciding, setDeciding] = useState<{ req: AccessRequest; action: 'approve' | 'reject' } | null>(null);
  const [decideNote, setDecideNote] = useState('');
  // 上游聚合（#20 P2）配置面
  const [upstreams, setUpstreams] = useState<{ prefix: string; url: string; enabled: boolean }[]>([]);
  const [upPrefix, setUpPrefix] = useState('');
  const [upUrl, setUpUrl] = useState('');
  const [upHeaders, setUpHeaders] = useState('{"X-Market-Client":"mcp/market-gateway"}');

  const loadRequests = useCallback((st: ReqStatus) => {
    if (!adminActive()) return;
    setReqLoading(true);
    apiFetch(`/api/mcp/access-requests${st === 'all' ? '' : `?status=${st}`}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((rows: AccessRequest[]) => { setRequests(rows); if (st === 'pending') setPendingCount(rows.length); })
      .catch((e) => message.error(`权限申请加载失败：${(e as Error).message}`))
      .finally(() => setReqLoading(false));
    if (st !== 'pending') {
      apiFetch('/api/mcp/access-requests?status=pending')
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: AccessRequest[]) => setPendingCount(rows.length))
        .catch(() => undefined);
    }
  }, [message]);

  const reload = useCallback(() => {
    if (!adminActive()) return;
    // #371：/api/mcp/tools 返回裸数组 [{name,description}]（也兼容 {tools:[…]} 信封）；失败要可见，不能静默成空列表
    apiFetch('/api/mcp/tools')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        const list: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.tools) ? j.tools : [];
        const items = list.map((x) => (typeof x === 'string' ? { name: x } : (x as { name?: string; category?: string; always_allowed?: boolean })));
        // 免授权工具（access_info / access_request）任何会话都能调，不进授权编辑器
        setRegTools(items.filter((x) => !x.always_allowed).map((x) => String(x.name ?? '')).filter(Boolean));
        setToolCat(Object.fromEntries(items.filter((x) => x.name && x.category).map((x) => [String(x.name), String(x.category)])));
      })
      .catch(() => { setRegTools([]); message.error('工具清单加载失败：授权编辑器暂时无法选择工具'); });
    setLoading(true);
    apiFetch('/api/mcp/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setSessions)
      .catch((e) => message.error(`会话列表加载失败：${(e as Error).message}`))
      .finally(() => setLoading(false));
    apiFetch('/api/mcp/upstreams')
      .then((r) => (r.ok ? r.json() : []))
      .then(setUpstreams)
      .catch(() => setUpstreams([]));
    loadRequests(reqStatusRef.current);
    setCallsLoading(true);
    apiFetch('/api/mcp/calls?limit=100')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCalls)
      .catch(() => undefined)
      .finally(() => setCallsLoading(false));
  }, [message, loadRequests]);

  // 身份变化（顶栏输入或清除口令、Odoo 管理员认定完成）后重新判定并载入
  useEffect(() => {
    const sync = () => { const a = adminActive(); setActive(a); if (a) reload(); };
    sync();
    return subscribeAdminToken(sync);
  }, [reload]);

  const createSession = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/mcp/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: newName }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((b as { error?: string }).error || `HTTP ${r.status}`);
      modal.success({
        title: `会话 ${b.name} 已创建`,
        content: (
          <div>
            <Typography.Paragraph type="warning" className="wm-strong">
              令牌仅此一次显示——请立即复制分发（库存只有 sha256，无法取回）：
            </Typography.Paragraph>
            <Typography.Paragraph copyable className="wm-mono wm-break wm-caption">
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
      const r = await apiFetch(`/api/mcp/sessions/${id}`, { method: 'DELETE' });
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
      const r = await apiFetch(`/api/mcp/sessions/${grantsOf.id}/grants`, {
        method: 'PUT',
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

  const decide = async () => {
    if (!deciding) return;
    const { req, action } = deciding;
    setReqLoading(true);
    try {
      const r = await apiFetch(`/api/mcp/access-requests/${req.id}/${action}`, { method: 'POST', body: JSON.stringify({ note: decideNote }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((b as { error?: string }).error || `HTTP ${r.status}`);
      message.success(action === 'approve'
        ? `已批准：${req.session_name} 新增 ${((b as { added?: string[] }).added ?? []).length} 个工具，立即生效`
        : '已驳回（授权不变）');
      setDeciding(null);
      reload();
    } catch (e) {
      message.error(`${action === 'approve' ? '批准' : '驳回'}失败：${(e as Error).message}`);
    } finally {
      setReqLoading(false);
    }
  };

  const saveUpstreams = async (next: { prefix: string; url: string; enabled: boolean }[]) => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/mcp/upstreams', {
        method: 'PUT',
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
      render: (_, s) => s.revoked_at ? <Typography.Text type="secondary" className="wm-caption">留审计</Typography.Text> : (
        <Space>
          <Button size="small" onClick={() => { setGrantsOf(s); setGrantSel(s.grants); }}>grants</Button>
          <Popconfirm title={`吊销 ${s.name}？令牌即时失效。`} onConfirm={() => revoke(s.id)}>
            <Button size="small" danger>吊销</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const toolTag = (t: string) => {
    const c = CATEGORY[toolCat[t] ?? ''];
    return <Tag key={t} color={c?.color} className="wm-mono">{t}{c ? ` · ${c.label}` : ''}</Tag>;
  };
  const reqCols: ProColumns<AccessRequest>[] = [
    { title: '状态', dataIndex: 'status', width: 90, fixed: 'left', render: (_, q) => <Tag color={REQ_STATUS[q.status].color}>{REQ_STATUS[q.status].label}</Tag> },
    {
      title: '会话', dataIndex: 'session_name', width: 140,
      render: (_, q) => (
        <Space size={4}>
          <Typography.Text className="wm-mono" strong>{q.session_name ?? `#${q.session_id}`}</Typography.Text>
          {q.session_revoked ? <Tag color="red">已吊销</Tag> : null}
        </Space>
      ),
    },
    { title: '申请工具', dataIndex: 'tools', width: 280, render: (_, q) => <Space size={[4, 4]} wrap>{q.tools.map(toolTag)}</Space> },
    { title: '用途', dataIndex: 'reason', ellipsis: true, render: (_, q) => <Typography.Text title={q.reason}>{q.reason}</Typography.Text> },
    {
      title: '处理', dataIndex: 'decided_at', width: 150,
      render: (_, q) => q.status === 'pending' ? <Typography.Text type="secondary" className="wm-caption">—</Typography.Text> : (
        <Space direction="vertical" size={0}>
          <Typography.Text className="wm-caption">{q.decided_by} · <RelTime value={q.decided_at || null} /></Typography.Text>
          {q.note ? <Typography.Text type="secondary" className="wm-caption">{q.note}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: '提交', dataIndex: 'created_at', width: 100, render: (_, q) => <RelTime value={q.created_at} /> },
    {
      title: '操作', valueType: 'option', width: 140, fixed: 'right',
      render: (_, q) => q.status !== 'pending' ? <Typography.Text type="secondary" className="wm-caption">已处理</Typography.Text> : (
        <Space>
          <Button size="small" type="primary" disabled={!active || q.session_revoked} title={q.session_revoked ? '会话已吊销，只能驳回' : undefined}
            onClick={() => { setDeciding({ req: q, action: 'approve' }); setDecideNote(''); }}>批准</Button>
          <Button size="small" disabled={!active} onClick={() => { setDeciding({ req: q, action: 'reject' }); setDecideNote(''); }}>驳回</Button>
        </Space>
      ),
    },
  ];
  const callCols: ProColumns<McpCall>[] = [
    { title: '结果', dataIndex: 'ok', width: 70, fixed: 'left', render: (_, c) => (c.ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>) },
    { title: '工具', dataIndex: 'tool', width: 160, render: (_, c) => <Typography.Text className="wm-mono wm-caption">{c.tool || '—'}</Typography.Text> },
    { title: '会话', dataIndex: 'session_name', width: 120, render: (_, c) => <Typography.Text className="wm-mono wm-caption">{c.session_name}</Typography.Text> },
    { title: '方法', dataIndex: 'method', width: 100, render: (_, c) => <Typography.Text className="wm-mono wm-caption">{c.method}</Typography.Text> },
    { title: '耗时', dataIndex: 'duration_ms', width: 80, align: 'right', render: (_, c) => <Typography.Text className="wm-num">{c.duration_ms}ms</Typography.Text> },
    { title: '错误', dataIndex: 'error', ellipsis: true, render: (_, c) => <Typography.Text type="secondary" className="wm-caption">{c.error || '—'}</Typography.Text> },
    { title: '时间', dataIndex: 'at', width: 120, render: (_, c) => <RelTime value={c.at} /> },
  ];

  return (
    <WmPage subTitle="会话 · 令牌 · 授权 · 权限申请 · 审计（默认拒绝）">
      <Typography.Paragraph type="secondary" className="wm-caption">
        令牌只经创建响应出现一次（库存 sha256）；新会话授权为空=默认拒绝；吊销即时生效。
        401 拒绝不进审计只计数。激活需服务端 ADMIN_TOKEN+MCP_GATEWAY=on。
      </Typography.Paragraph>
      {active ? (
        <Space className="wm-mb-3">
          <Typography.Text type="secondary" className="wm-caption">
            {odooAdmin() ? `已按 Odoo 管理员（${odooAdmin()}）载入` : '已按管理员口令载入'}
          </Typography.Text>
          <Button onClick={reload} loading={loading}>刷新</Button>
        </Space>
      ) : (
        <Space.Compact className="wm-w-full wm-mb-3" style={{ maxWidth: 640 }}>
          <Input.Password
            prefix={<KeyOutlined />}
            placeholder="管理员口令（或用 Odoo 管理员账号登录后免输）"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            onPressEnter={() => tokenDraft && setAdminToken(tokenDraft)}
            className="wm-text-body"
          />
          <Button onClick={() => setAdminToken(tokenDraft)} disabled={!tokenDraft}>载入</Button>
        </Space.Compact>
      )}
      <Space.Compact className="wm-w-full wm-mb-4" style={{ maxWidth: 640 }}>
        <Input
          prefix={<PlusOutlined />}
          placeholder="新会话名（小写字母/数字/连字符，如 agent-alpha）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="wm-mono wm-text-body"
        />
        <Button type="primary" onClick={createSession} loading={loading} disabled={!active || !newName}>创建会话</Button>
      </Space.Compact>

      <Tabs
        items={[
          {
            key: 'sessions', label: '会话与审计',
            children: (
              <>
                <ProTable<McpSession> rowKey="id" size="middle" columns={sessCols} dataSource={sessions} loading={loading} search={false} options={false} toolBarRender={false}
                  pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  locale={{ emptyText: <Empty description={active ? "无会话——创建首个会话" : "需要管理员：输入口令，或用 Odoo 管理员账号登录"} /> }} />
                <Typography.Title level={5} style={{ marginTop: 24 }}>审计（最近 100 条）</Typography.Title>
                <ProTable<McpCall> rowKey="id" size="middle" columns={callCols} dataSource={calls} loading={callsLoading} search={false} options={false} toolBarRender={false} pagination={{ pageSize: 20, hideOnSinglePage: true }} />
              </>
            ),
          },
          {
            key: 'requests', label: pendingCount ? `权限申请（${pendingCount} 待批）` : '权限申请',
            children: (
              <>
                <Typography.Paragraph type="secondary" className="wm-caption">
                  会话经 MCP <Typography.Text code>access_request</Typography.Text> 提交；批准把申请的工具并入该会话现有授权（不收走已有工具），立即生效并记审计。已吊销会话只能驳回。
                </Typography.Paragraph>
                <Space className="wm-mb-3">
                  <Select<ReqStatus> value={reqStatus} onChange={(v) => { setReqStatus(v); reqStatusRef.current = v; loadRequests(v); }} style={{ width: 140 }}
                    options={[{ value: 'pending', label: '待批' }, { value: 'approved', label: '已批准' }, { value: 'rejected', label: '已驳回' }, { value: 'all', label: '全部' }]} />
                </Space>
                <ProTable<AccessRequest> rowKey="id" size="middle" columns={reqCols} dataSource={requests} loading={reqLoading} search={false} options={false} toolBarRender={false}
                  pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  locale={{ emptyText: <Empty description={reqStatus === 'pending' ? '没有待批的申请' : '没有记录'} /> }} />
              </>
            ),
          },
          {
            key: 'upstreams', label: `上游聚合（${upstreams.length}）`,
            children: (
              <>
                <Typography.Paragraph type="secondary" className="wm-caption">
                  外部 MCP 服务的工具以 <Typography.Text code>&lt;prefix&gt;__&lt;tool&gt;</Typography.Text> 并入 /mcp（如 taste-mcp → <Typography.Text code>taste__rules</Typography.Text>）。
                  上游不可达时自动降级、不影响本地工具。配置整体替换。
                </Typography.Paragraph>
                <Space.Compact className="wm-w-full wm-mb-3" style={{ maxWidth: 720 }}>
                  <Input placeholder="prefix（如 taste）" value={upPrefix} onChange={(e) => setUpPrefix(e.target.value)} style={{ width: 180 }} className="wm-mono wm-text-body" />
                  <Input placeholder="MCP 端点 URL（如 http://127.0.0.1:9810/mcp）" value={upUrl} onChange={(e) => setUpUrl(e.target.value)} className="wm-text-body" />
                  <Button type="primary" onClick={addUpstream} disabled={!active}>添加/更新</Button>
                </Space.Compact>
                <Input.TextArea rows={2} value={upHeaders} onChange={(e) => setUpHeaders(e.target.value)}
                  style={{ maxWidth: 720 }} className="wm-mono wm-caption wm-mb-3"
                  placeholder='上游请求头 JSON（如 {"X-Market-Client":"mcp/market-gateway"}）' />
                <Table rowKey="prefix" size="small" dataSource={upstreams} loading={loading} pagination={false}
                  columns={[
                    { title: 'prefix', dataIndex: 'prefix', render: (v: string) => <Typography.Text className="wm-mono" strong>{v}</Typography.Text> },
                    { title: '端点', dataIndex: 'url', render: (v: string) => <Typography.Text className="wm-mono wm-caption">{v}</Typography.Text> },
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
        <Typography.Paragraph type="secondary" className="wm-caption">
          勾选该会话可用的工具（整体替换语义；新会话为空=默认拒绝）。工具面共 {regTools.length} 个。
        </Typography.Paragraph>
        <Select
          mode="multiple"
          className="wm-w-full"
          placeholder="选择授权工具"
          value={grantSel}
          onChange={setGrantSel}
          options={regTools.map((t) => ({ value: t, label: CATEGORY[toolCat[t] ?? ''] ? `${t} · ${CATEGORY[toolCat[t]].label}` : t }))}
        />
      </Modal>

      <Modal
        title={deciding ? `${deciding.action === 'approve' ? '批准' : '驳回'}申请 #${deciding.req.id}：${deciding.req.session_name ?? ''}` : ''}
        open={!!deciding}
        onOk={decide}
        onCancel={() => setDeciding(null)}
        okText={deciding?.action === 'approve' ? '批准并授权' : '驳回'}
        okButtonProps={{ danger: deciding?.action === 'reject', loading: reqLoading }}
        width={560}
      >
        {deciding ? (
          <>
            <Typography.Paragraph className="wm-caption">
              {deciding.action === 'approve' ? '以下工具将并入该会话的现有授权：' : '驳回后授权不变：'}
            </Typography.Paragraph>
            <Space size={[4, 4]} wrap className="wm-mb-3">{deciding.req.tools.map(toolTag)}</Space>
            <Typography.Paragraph type="secondary" className="wm-caption">用途：{deciding.req.reason}</Typography.Paragraph>
            <Input.TextArea rows={2} maxLength={500} value={decideNote} onChange={(e) => setDecideNote(e.target.value)}
              placeholder="备注（可选，会话在 access_info 里能看到）" className="wm-text-body" />
          </>
        ) : null}
      </Modal>
    </WmPage>
  );
}
