import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Drawer, Empty, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { ExportOutlined, PlayCircleOutlined, RiseOutlined, StopOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { api } from '../api';
import type { SopApp } from '../types';
import { fmtCheckedAt } from '../components/StatusBadge';
import WmPage from '../components/WmPage';

/** SOP 状态语义：draft 未上架（不入册）/ published 在架可执行 / deprecated 已废弃（市场停用）
 *  色值经对比度审计：published 文字 #15803d on #F6FFED ≈4.8:1、deprecated #CF1322 on #FFF1F0 ≈5.0:1
 *  （antd 预设 green Tag 的 #389E0D 实测仅 3.37:1，不够 4.5 下限——E2E 渲染层探针抓过） */
export const SOP_STATUS: Record<SopApp['status'], { style: CSSProperties; label: string; hint: string }> = {
  draft: { style: {}, label: 'draft', hint: '草稿——未入册，仅 /sop/:slug/ 直访返回 403' },
  published: { style: { color: '#15803D', background: '#F6FFED', borderColor: '#B7EB8F' }, label: 'published', hint: '已上架——市场在册，Runner 可执行' },
  deprecated: { style: { color: '#CF1322', background: '#FFF1F0', borderColor: '#FFA39E' }, label: 'deprecated', hint: '已废弃——市场行停用，历史 run 仍可回放' },
};



/** SOP 台管理面：状态机（draft→published→deprecated）+ 版本链 + run 历史 + 网络暴露（人工绑定） */
export default function Sops() {
  const { message, modal } = App.useApp();
  const actionRef = useRef<ActionType>();
  const [items, setItems] = useState<SopApp[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();
  const [busySlug, setBusySlug] = useState<string | null>(null);
  // P4（F7）：待验收任务 = running 且有派单来源
  const loadPending = useCallback(() => {
    return fetch('/api/sop/runs?dispatched=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPendingRuns(Array.isArray(rows) ? rows : []))
      .catch(() => setPendingRuns([]));
  }, []);
  const [pendingRuns, setPendingRuns] = useState<Array<{ id: number; sop_slug: string; started_by: string; updated_at: string }>>([]);
  // 网络暴露（人工绑定，GH #17 P1）：口令只存会话态，绝不持久化
  const [netOf, setNetOf] = useState<SopApp | null>(null);
  const [netToken, setNetToken] = useState('');
  const [bindings, setBindings] = useState<Array<{ id: number; agent_node: string; direction: string; mode: string; notify_url?: string; remote_api_key: string; revoked_at: string; created_at: string }>>([]);
  const [netLoading, setNetLoading] = useState(false);
  const [netNode, setNetNode] = useState('');
  const [netMode, setNetMode] = useState<'read' | 'run'>('read');
  const [netDirection, setNetDirection] = useState<'admits' | 'notify' | 'both'>('admits');
  const [netKey, setNetKey] = useState('');

  const reloadNet = useCallback(() => {
    if (!netOf || !netToken) return;
    setNetLoading(true);
    fetch(`/api/bindings?type=sop&slug=${netOf.slug}`, { headers: { 'X-Admin-Token': netToken } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setBindings)
      .catch(() => message.error('绑定列表加载失败（口令无效或未设置）'))
      .finally(() => setNetLoading(false));
  }, [netOf, netToken, message]);

  const addBinding = async () => {
    if (!netOf || !netToken) return;
    setNetLoading(true);
    try {
      const r = await fetch('/api/bindings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': netToken },
        body: JSON.stringify({
          target_type: 'sop', target_slug: netOf.slug, agent_node: netNode, mode: netMode, direction: netDirection,
          ...(netKey ? { remote_api_key: netKey } : {}),
        }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((b as { error?: string }).error || `HTTP ${r.status}`);
      message.success(`已绑定 ${netNode}（${netDirection}）——admits 方向使台可被发现/直投；notify 方向使提交回执可达`);
      setNetNode(''); setNetKey('');
      reloadNet();
    } catch (e) {
      message.error(`绑定失败：${(e as Error).message}`);
    } finally {
      setNetLoading(false);
    }
  };

  const revokeBinding = async (id: number) => {
    if (!netOf || !netToken) return;
    setNetLoading(true);
    try {
      const r = await fetch(`/api/bindings/${id}`, { method: 'DELETE', headers: { 'X-Admin-Token': netToken } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      message.success('已软撤销（无其他有效绑定时 SOP 下卡）');
      reloadNet();
    } catch (e) {
      message.error(`撤销失败：${(e as Error).message}`);
    } finally {
      setNetLoading(false);
    }
  };

  const reload = useCallback(() => {
    setLoading(true);
    api.listSops()
      .then(setItems)
      .catch((e) => message.error(`加载 SOP 列表失败：${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, [message]);

  useEffect(() => reload(), [reload]);
  useEffect(() => { void loadPending(); }, [loadPending]);

  const transition = async (s: SopApp, act: 'publish' | 'deprecate') => {
    setBusySlug(s.slug);
    try {
      if (act === 'publish') {
        let note = '';
        const r = await new Promise<{ confirm: boolean; note: string }>((resolve) => {
          let value = '';
          modal.confirm({
            title: `上架 ${s.title}`,
            content: (
              <div style={{ marginTop: 8 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
                  上架后市场在册（{s.slug} 入册、Runner 可执行）；发布说明可选，会记入当前版本 changelog。
                </Typography.Paragraph>
                <Typography.Title level={5} style={{ marginBottom: 4 }}>发布说明（可选）</Typography.Title>
                <input
                  className="wm-mono"
                  style={{ width: '100%', padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }}
                  placeholder="如：v2 增加通电自检步骤"
                  onChange={(e) => { value = e.target.value; }}
                />
              </div>
            ),
            okText: '上架',
            cancelText: '取消',
            onOk: () => resolve({ confirm: true, note: value }),
            onCancel: () => resolve({ confirm: false, note: '' }),
          });
        });
        if (!r.confirm) return;
        await api.publishSop(s.slug, r.note || undefined);
        message.success(`${s.slug} 已上架`);
      } else {
        await api.deprecateSop(s.slug);
        message.success(`${s.slug} 已废弃（历史 run 仍可回放）`);
      }
      reload();
    } catch (e) {
      message.error(`操作失败：${(e as Error).message}`);
    } finally {
      setBusySlug(null);
    }
  };

  const columns: ProColumns<SopApp>[] = [
    {
      title: '编号',
      dataIndex: 'code',
      width: 120,
      render: (_, s) =>
        s.code ? <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{s.code}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '标题',
      dataIndex: 'title',
      width: 200,
      render: (_, s) => (
        <Space size={6}>
          <span style={{ fontSize: 15 }}>📋</span>
          <Link to={`/sops/${s.slug}`}><Typography.Text strong>{s.title}</Typography.Text></Link>
        </Space>
      ),
    },
    {
      title: 'slug',
      dataIndex: 'slug',
      width: 150,
      render: (_, s) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }} copyable>{s.slug}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (_, s) => {
        const meta = SOP_STATUS[s.status];
        return (
          <Tooltip title={meta.hint}>
            <Tag style={meta.style}>{meta.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '版本',
      dataIndex: 'active_version',
      width: 90,
      render: (_, s) => (
        <Typography.Text className="wm-mono">v{s.active_version} <Typography.Text type="secondary" style={{ fontSize: 11 }}>/ {s.versions.length}</Typography.Text></Typography.Text>
      ),
    },
    {
      title: '最近变更',
      dataIndex: 'changelog',
      width: 220,
      ellipsis: true,
      render: (_, s) => {
        const cur = s.versions.find((v) => v.version === s.active_version);
        return cur?.changelog ? (
          <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{cur.changelog}</span>}>
            <Typography.Text style={{ fontSize: 12 }} ellipsis>{cur.changelog.split('\n')[0]}</Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        );
      },
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      width: 150,
      render: (_, s) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtCheckedAt(s.updated_at)}</Typography.Text>,
    },
    {
      title: '操作',
      valueType: 'option',
      width: 260,
      render: (_, s) => [
        <Tooltip key="run" title={s.status === 'published' ? '新窗口打开执行页' : SOP_STATUS[s.status].hint}>
          <Button
            size="small"
            type={s.status === 'published' ? 'primary' : 'default'}
            icon={<PlayCircleOutlined />}
            href={`/sop/${s.slug}/`}
            target="_blank"
            disabled={s.status !== 'published'}
          >
            执行
          </Button>
        </Tooltip>,
        <Tooltip key="runs" title="进入交付空间看执行记录、交付物与定义">
          <Button size="small" icon={<RiseOutlined />} onClick={() => nav(`/sops/${s.slug}`)}>
            记录
          </Button>
        </Tooltip>,
        <Tooltip key="net" title="网络暴露：把此 SOP 绑定给具体 agent（market/<id8> 上卡，人工操作）">
          <Button size="small" onClick={() => { setNetOf(s); setBindings([]); }}>
            网络
          </Button>
        </Tooltip>,
        s.status !== 'published' ? (
          <Popconfirm
            key="publish"
            title={`上架 ${s.slug}？`}
            description="上架后市场在册，Runner 可执行"
            onConfirm={() => transition(s, 'publish')}
          >
            <Button size="small" loading={busySlug === s.slug}>上架</Button>
          </Popconfirm>
        ) : (
          <Popconfirm
            key="deprecate"
            title={`废弃 ${s.slug}？`}
            description="市场行将停用；历史 run 保留可回放"
            okButtonProps={{ danger: true }}
            onConfirm={() => transition(s, 'deprecate')}
          >
            <Button size="small" danger icon={<StopOutlined />} loading={busySlug === s.slug}>废弃</Button>
          </Popconfirm>
        ),
      ],
    },
  ];


  return (
    <WmPage subTitle="结构化流程即台：状态机 · 版本链 · 执行记录">
      <Card size="small" title={`待验收任务（${pendingRuns.length}）`} style={{ marginBottom: 12 }}
        extra={<Button size="small" onClick={() => { void loadPending(); }}>刷新</Button>}>
        {pendingRuns.length === 0 ? <Typography.Text type="secondary">没有待验收的派单任务</Typography.Text> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
            {pendingRuns.map((r) => (
              <Space key={r.id} wrap>
                <Tag color="blue">run #{r.id}</Tag>
                <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{r.sop_slug}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.started_by || 'agent'}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.updated_at}</Typography.Text>
                <Button size="small" type="link" href={`/sop/${r.sop_slug}/`} target="_blank">去验收</Button>
              </Space>
            ))}
          </div>
        )}
      </Card>
      <ProTable<SopApp>
        rowKey="slug"
        actionRef={actionRef}
        columns={columns}
        dataSource={items}
        loading={loading}
        search={false}
        pagination={false}
        locale={{ emptyText: <Empty description="还没有 SOP——经 MCP app_publish（kind=sop）或 POST /api/apps 发布第一个" /> }}
        options={{ reload: reload, density: false, setting: false }}
        headerTitle="全部 SOP"
      />


      <Drawer
        title={
          <Space>
            <span>网络暴露</span>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>{netOf?.title}</Typography.Text>
          </Space>
        }
        size="large"
        open={!!netOf}
        onClose={() => setNetOf(null)}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          暴露给哪个 agent 只由人绑定：绑定后该 SOP 以 <span className="wm-mono">market/&lt;id8&gt;</span> 上卡
          （<span className="wm-mono">/.well-known/agent-card.json</span>），DSH 侧还需主人把该节点加进 canvas 队（两半绑定）。
          卡片不发布绑定图；对端 API Key 仅用于回执投递（P3），存储掩码。
        </Typography.Paragraph>
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <input
            className="wm-mono"
            type="password"
            placeholder="管理员口令（X-Admin-Token，服务端环境变量）"
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }}
            value={netToken}
            onChange={(e) => setNetToken(e.target.value)}
          />
          <Button onClick={reloadNet} loading={netLoading} disabled={!netToken}>载入绑定</Button>
        </Space.Compact>
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <input
            className="wm-mono"
            placeholder="agent 节点，如 dsh/1a2b3c4d"
            style={{ flex: 2, padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }}
            value={netNode}
            onChange={(e) => setNetNode(e.target.value)}
          />
          <select
            className="wm-mono"
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }}
            value={netMode}
            onChange={(e) => setNetMode(e.target.value as 'read' | 'run')}
          >
            <option value="read">read（只读）</option>
            <option value="run">run（可执行）</option>
          </select>
          <select
            className="wm-mono"
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }}
            value={netDirection}
            onChange={(e) => setNetDirection(e.target.value as 'admits' | 'notify' | 'both')}
          >
            <option value="admits">admits（入站准入·可直投/上卡）</option>
            <option value="notify">notify（出站推送·提交回执）</option>
            <option value="both">both（显式双授）</option>
          </select>
          <Button type="primary" onClick={addBinding} loading={netLoading} disabled={!netToken || !netNode}>绑定</Button>
        </Space.Compact>
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <input
            className="wm-mono"
            type="password"
            placeholder="对端 API Key（可选，回执投递用，存储脱敏）"
            style={{ flex: 1, padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }}
            value={netKey}
            onChange={(e) => setNetKey(e.target.value)}
          />
        </Space.Compact>
        <Table
          rowKey="id"
          size="small"
          loading={netLoading}
          dataSource={bindings}
          pagination={false}
          columns={[
            { title: '节点', dataIndex: 'agent_node', render: (v: string) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{v}</Typography.Text> },
            { title: '方向', dataIndex: 'direction', width: 80, render: (v: string) => v === 'admits' ? '入站准入' : v === 'notify' ? '出站推送' : '双向' },
          { title: '模式', dataIndex: 'mode', width: 70 },
            { title: 'Key', dataIndex: 'remote_api_key', width: 70, render: (v: string) => (v ? <Tag>已存（掩码）</Tag> : <Typography.Text type="secondary">-</Typography.Text>) },
            { title: '状态', dataIndex: 'revoked_at', width: 80, render: (v: string) => (v ? <Tag color="red">已撤销</Tag> : <Tag color="green">有效</Tag>) },
            {
              title: '操作', width: 80,
              render: (_: unknown, r: { id: number; revoked_at: string }) =>
                r.revoked_at ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>留审计</Typography.Text> : (
                  <Popconfirm title={`撤销绑定 ${r.id}？`} onConfirm={() => revokeBinding(r.id)}>
                    <Button size="small" danger>撤销</Button>
                  </Popconfirm>
                ),
            },
          ]}
        />
      </Drawer>
    </WmPage>
  );
}
