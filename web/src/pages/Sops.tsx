import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Empty, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ExportOutlined, PlayCircleOutlined, RiseOutlined, StopOutlined } from '@ant-design/icons';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { api } from '../api';
import type { SopApp, SopRun } from '../types';
import { fmtCheckedAt } from '../components/StatusBadge';

/** SOP 状态语义：draft 未上架（不入册）/ published 在架可执行 / deprecated 已废弃（市场停用）
 *  色值经对比度审计：published 文字 #15803d on #F6FFED ≈4.8:1、deprecated #CF1322 on #FFF1F0 ≈5.0:1
 *  （antd 预设 green Tag 的 #389E0D 实测仅 3.37:1，不够 4.5 下限——E2E 渲染层探针抓过） */
const SOP_STATUS: Record<SopApp['status'], { style: CSSProperties; label: string; hint: string }> = {
  draft: { style: {}, label: 'draft', hint: '草稿——未入册，仅 /sop/:slug/ 直访返回 403' },
  published: { style: { color: '#15803D', background: '#F6FFED', borderColor: '#B7EB8F' }, label: 'published', hint: '已上架——市场在册，Runner 可执行' },
  deprecated: { style: { color: '#CF1322', background: '#FFF1F0', borderColor: '#FFA39E' }, label: 'deprecated', hint: '已废弃——市场行停用，历史 run 仍可回放' },
};

function parseRunData(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** SOP 台管理面：状态机（draft→published→deprecated）+ 版本链 + run 历史 */
export default function Sops() {
  const { message, modal } = App.useApp();
  const actionRef = useRef<ActionType>();
  const [items, setItems] = useState<SopApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [runsOf, setRunsOf] = useState<SopApp | null>(null);
  const [runs, setRuns] = useState<SopRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api.listSops()
      .then(setItems)
      .catch((e) => message.error(`加载 SOP 列表失败：${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, [message]);

  useEffect(() => reload(), [reload]);

  const openRuns = (s: SopApp) => {
    setRunsOf(s);
    setRunsLoading(true);
    api.listSopRuns({ slug: s.slug })
      .then(setRuns)
      .catch((e) => message.error(`加载执行记录失败：${(e as Error).message}`))
      .finally(() => setRunsLoading(false));
  };

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
          <Typography.Text strong>{s.title}</Typography.Text>
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
        <Tooltip key="runs" title="查看执行记录（run 历史 + 步骤数据）">
          <Button size="small" icon={<RiseOutlined />} onClick={() => openRuns(s)}>
            记录
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

  const runColumns = [
    { title: 'run', dataIndex: 'id', width: 70, render: (v: number) => <Typography.Text className="wm-mono">#{v}</Typography.Text> },
    { title: '版本', dataIndex: 'sop_version', width: 70, render: (v: number) => <Typography.Text className="wm-mono">v{v}</Typography.Text> },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: SopRun['status']) => (v === 'running' ? <Tag color="processing">执行中</Tag> : <Tag color="green">已完成</Tag>),
    },
    { title: '执行人', dataIndex: 'started_by', width: 110, render: (v: string) => v || <Typography.Text type="secondary">-</Typography.Text> },
    { title: '步骤数', width: 80, render: (_: unknown, r: SopRun) => <Typography.Text className="wm-mono">{Object.keys(parseRunData(r.data)).length}</Typography.Text> },
    { title: '开始', dataIndex: 'started_at', width: 150, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtCheckedAt(v)}</Typography.Text> },
    { title: '最近活动', dataIndex: 'updated_at', width: 150, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtCheckedAt(v)}</Typography.Text> },
  ];

  return (
    <PageContainer title="SOP 台" subTitle="结构化流程即台：状态机 · 版本链 · 执行记录" className="wm-page">
      <ProTable<SopApp>
        rowKey="slug"
        actionRef={actionRef}
        columns={columns}
        dataSource={items}
        loading={loading}
        search={false}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无 SOP 台——经 MCP app_publish（kind=sop）或 POST /api/apps 发布" /> }}
        options={{ reload: reload, density: false, setting: false }}
        headerTitle="全部 SOP"
      />

      <Drawer
        title={
          <Space>
            <span>执行记录</span>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>{runsOf?.title}</Typography.Text>
          </Space>
        }
        size="large"
        open={!!runsOf}
        onClose={() => setRunsOf(null)}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          执行数据分层持久化：热态在 Redis（运行中 ~ms 级读写），真源在 SQLite（sop_runs）——每行展开可见该 run 各步骤的填报数据。
        </Typography.Paragraph>
        <Table<SopRun>
          rowKey="id"
          size="small"
          columns={runColumns}
          dataSource={runs}
          loading={runsLoading}
          pagination={false}
          expandable={{
            expandedRowRender: (r) => {
              const data = parseRunData(r.data);
              const keys = Object.keys(data);
              if (keys.length === 0) return <Typography.Text type="secondary">（暂无步骤数据）</Typography.Text>;
              return (
                <div className="wm-mono" style={{ background: '#F6F8FB', padding: 12, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
                  {keys.map((k) => `${k} = ${JSON.stringify(data[k], null, 2)}`).join('\n')}
                </div>
              );
            },
          }}
        />
      </Drawer>
    </PageContainer>
  );
}
