import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { App, Button, Drawer, Descriptions, Empty, Flex, Input, Popconfirm, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, ExportOutlined, PlusOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import Markdown from 'react-markdown';
import { api } from '../api';
import type { Workbench, WorkbenchType } from '../types';
import StatusBadge, { fmtCheckedAt } from '../components/StatusBadge';
import WorkbenchForm from '../components/WorkbenchForm';
import AppDataDrawer from '../components/AppDataDrawer';
import WmPage from '../components/WmPage';

const TYPE_COLORS = ['geekblue', 'green', 'gold', 'cyan', 'purple', 'volcano', 'magenta', 'orange'];
function typeColor(key: string): string {
  let sum = 0;
  for (const ch of key) sum += ch.charCodeAt(0);
  return TYPE_COLORS[sum % TYPE_COLORS.length];
}

export default function Market() {
  const { message } = App.useApp();
  const actionRef = useRef<ActionType>();
  const [types, setTypes] = useState<WorkbenchType[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workbench | null>(null);
  const [copySource, setCopySource] = useState<Workbench | null>(null);
  const [detail, setDetail] = useState<Workbench | null>(null);
  const [dataSlug, setDataSlug] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => {
    const sp = searchParams.get('status');
    return {
      q: '',
      type: 'all',
      category: 'all',
      status: sp === 'up' || sp === 'down' || sp === 'unknown' ? sp : 'all',
    };
  });

  useEffect(() => {
    api.listTypes().then(setTypes).catch(() => undefined);
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    // 从 actionRef 缓存中收集不可靠，这里从表格请求回调里同步维护
    return set;
  }, []);

  const [allItems, setAllItems] = useState<Workbench[]>([]);
  const categoryOptions = useMemo(
    () => Array.from(new Set(allItems.map((w) => w.category).filter(Boolean))),
    [allItems]
  );

  const typeTag = (key: string) => {
    const t = types.find((x) => x.key === key);
    return (
      <Tooltip title={t ? `${t.health_method} ${t.health_path} · ${t.expect_status == null ? '任意响应即在线' : `期望 ${t.expect_status}`}` : key}>
        <Tag color={typeColor(key)}>{t?.name ?? key}</Tag>
      </Tooltip>
    );
  };

  const checkOne = async (id: number) => {
    setBusyId(id);
    try {
      const w = await api.checkOne(id);
      if (w.last_status === 'up') message.success(`${w.name} 在线（${w.last_latency_ms}ms）`);
      else message.error(`${w.name} 离线：${w.last_error || '未知原因'}`);
    } catch (e) {
      message.error(`检测失败：${(e as Error).message}`);
    } finally {
      setBusyId(null);
      actionRef.current?.reload();
    }
  };

  const columns: ProColumns<Workbench>[] = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 200,
      render: (_, w) => (
        <Space size={6}>
          <span style={{ fontSize: 16 }}>{w.icon || '▢'}</span>
          <a onClick={() => setDetail(w)} style={{ fontWeight: 600 }}>
            {w.name}
          </a>
        </Space>
      ),
    },
    { title: '类型', dataIndex: 'type', width: 130, render: (_, w) => typeTag(w.type) },
    {
      title: '服务地址',
      dataIndex: 'url',
      width: 260,
      ellipsis: true,
      render: (_, w) => (
        <Typography.Text className="wm-mono" copyable={{ text: w.url }} style={{ maxWidth: 300, fontSize: 12 }} ellipsis={{ tooltip: w.url }}>
          {w.url}
        </Typography.Text>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 110,
      render: (_, w) => (w.category ? <Tag>{w.category}</Tag> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 160,
      render: (_, w) => {
        if (!w.tags?.length) return <Typography.Text type="secondary">-</Typography.Text>;
        const shown = w.tags.slice(0, 2).map((t) => <Tag key={t}>{t}</Tag>);
        const rest = w.tags.slice(2);
        return (
          <Space size={4} wrap>
            {shown}
            {rest.length ? (
              <Tooltip title={rest.join('、')}>
                <Tag>+{rest.length}</Tag>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'last_status',
      width: 140,
      render: (_, w) => (
        <Flex vertical gap={0}>
          <StatusBadge
            status={w.last_status}
            latency={w.last_latency_ms}
            error={w.last_error}
            checkedAt={w.last_checked_at}
          />
          {w.last_checked_at ? (
            <Typography.Text type="secondary" className="wm-num" style={{ fontSize: 12 }}>
              {fmtCheckedAt(w.last_checked_at)}
            </Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 70,
      render: (_, w) => (
        <Switch
          size="small"
          checked={w.enabled}
          onChange={async (v) => {
            try {
              await api.updateWorkbench(w.id, { enabled: v });
              actionRef.current?.reload();
            } catch (e) {
              message.error(`切换失败：${(e as Error).message}`);
            }
          }}
        />
      ),
    },
    {
      title: '操作',
      valueType: 'option',
      width: 300,
      render: (_, w) => (
        <Space size={0}>
          <Link to={`/use/${w.id}`}>
            <Button size="small" type="link" icon={<RightOutlined />}>
              使用
            </Button>
          </Link>
          <Tooltip title="新窗口打开">
            <a href={w.url} target="_blank" rel="noreferrer">
              <Button size="small" type="link" icon={<ExportOutlined />} aria-label="新窗口打开" />
            </a>
          </Tooltip>
          <Button size="small" type="link" loading={busyId === w.id} onClick={() => checkOne(w.id)}>
            检测
          </Button>
          <Tooltip title="复制为新的工作台，可改后创建">
            <Button
              size="small"
              type="link"
              icon={<CopyOutlined />}
              aria-label="复制工作台"
              onClick={() => {
                setEditing(null);
                setCopySource(w);
                setFormOpen(true);
              }}
            />
          </Tooltip>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setCopySource(null);
              setEditing(w);
              setFormOpen(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title={`删除工作台「${w.name}」？`}
            description="仅移除注册信息，不影响服务本身"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await api.deleteWorkbench(w.id);
                message.success('已删除');
                actionRef.current?.reload();
              } catch (e) {
                message.error(`删除失败：${(e as Error).message}`);
              }
            }}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <WmPage
      subTitle="登记与发现各端口的 AI 工作台：类型 · 分类 · 在线状态"
      extra={(
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            setCopySource(null);
            setFormOpen(true);
          }}
        >
          新增工作台
        </Button>
      )}
    >
      <ProTable<Workbench>
        actionRef={actionRef}
        rowKey="id"
        search={false}
        columns={columns}
        params={filters}
        request={async (params) => {
          const list = await api.listWorkbenches();
          setAllItems(list);
          const q = String(params.q ?? '').toLowerCase();
          const { type, category, status } = params;
          const data = list.filter((w) => {
            if (q && !(w.name.toLowerCase().includes(q) || w.url.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q))) return false;
            if (type && type !== 'all' && w.type !== type) return false;
            if (category && category !== 'all' && (w.category || '') !== category) return false;
            if (status && status !== 'all' && w.last_status !== status) return false;
            return true;
          });
          return { data, success: true };
        }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        toolBarRender={() => [
          <Input.Search
            key="q"
            allowClear
            placeholder="搜索名称 / 地址 / 描述"
            style={{ width: 240 }}
            onSearch={(v) => setFilters((f) => ({ ...f, q: v }))}
          />,
          <Select
            key="type"
            style={{ width: 150 }}
            value={filters.type}
            onChange={(v) => setFilters((f) => ({ ...f, type: v }))}
            options={[
              { value: 'all', label: '全部类型' },
              ...types.map((t) => ({ value: t.key, label: t.name })),
            ]}
          />,
          <Select
            key="category"
            style={{ width: 130 }}
            value={filters.category}
            onChange={(v) => setFilters((f) => ({ ...f, category: v }))}
            options={[
              { value: 'all', label: '全部分类' },
              ...categoryOptions.map((c) => ({ value: c, label: c })),
            ]}
          />,
          <Select
            key="status"
            style={{ width: 110 }}
            value={filters.status}
            onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'up', label: '在线' },
              { value: 'down', label: '离线' },
              { value: 'unknown', label: '未探测' },
            ]}
          />,
          <Button
            key="check"
            icon={<ThunderboltOutlined />}
            loading={checkingAll}
            onClick={async () => {
              setCheckingAll(true);
              try {
                const r = await api.checkAll();
                message.success(`检测完成：${r.up} 在线 / ${r.down} 离线（共 ${r.checked}）`);
              } catch (e) {
                message.error(`检测失败：${(e as Error).message}`);
              } finally {
                setCheckingAll(false);
                actionRef.current?.reload();
              }
            }}
          >
            全部检测
          </Button>,
        ]}
        locale={{ emptyText: <Empty description="暂无工作台，点右上角「新增工作台」注册第一个" /> }}
        options={{ reload: true, density: true, setting: true }}
      />

      <WorkbenchForm
        open={formOpen}
        types={types}
        initial={editing}
        copySource={copySource}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          message.success('已保存');
          actionRef.current?.reload();
        }}
      />

      <Drawer
        title={
          <Space>
            <span style={{ fontSize: 18 }}>{detail?.icon}</span>
            <span>{detail?.name}</span>
            {detail ? typeTag(detail.type) : null}
          </Space>
        }
        size="large"
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <Flex vertical gap={16} style={{ width: '100%' }}>
            <Descriptions
              column={1}
              size="small"
              bordered
              items={[
                { key: 'url', label: '服务地址', children: <Typography.Text copyable>{detail.url}</Typography.Text> },
                {
                  key: 'auth',
                  label: '凭据',
                  children: detail.auth ? (
                    <Tooltip title={`类型 ${detail.auth.type}；值仅脱敏展示，经 /go/ 门户访问时自动注入 Authorization 头`}>
                      <Tag color="gold">
                        含凭据（{detail.auth.type}：{detail.auth.value.length <= 4 ? '****' : `${detail.auth.value.slice(0, 2)}…${detail.auth.value.slice(-2)}`}）
                      </Tag>
                    </Tooltip>
                  ) : (
                    <Typography.Text type="secondary">无</Typography.Text>
                  ),
                },
                { key: 'status', label: '状态', children: <StatusBadge status={detail.last_status} latency={detail.last_latency_ms} error={detail.last_error} checkedAt={detail.last_checked_at} /> },
                { key: 'category', label: '分类', children: detail.category || '-' },
                { key: 'tags', label: '标签', children: detail.tags.length ? detail.tags.join('、') : '-' },
                { key: 'path', label: '探测路径', children: detail.health_path || '类型默认' },
                { key: 'created', label: '注册时间', children: fmtCheckedAt(detail.created_at) || detail.created_at },
              ]}
            />
            {detail.type === 'market-app' && /^\/(apps|sop)\/([a-z0-9-]+)\//.test(detail.url) ? (
              <Button icon={<ThunderboltOutlined />} onClick={() => setDataSlug((/^\/(apps|sop)\/([a-z0-9-]+)\//.exec(detail.url) as RegExpExecArray)[2])}>
                查看提交数据
              </Button>
            ) : null}
            <Typography.Title level={5}>描述</Typography.Title>
            {detail.description ? (
              <div className="wm-md">
                <Markdown>{detail.description}</Markdown>
              </div>
            ) : (
              <Typography.Text type="secondary">暂无描述</Typography.Text>
            )}
          </Flex>
        ) : null}
      </Drawer>
      <AppDataDrawer slug={dataSlug ?? ''} open={!!dataSlug} onClose={() => setDataSlug(null)} />
    </WmPage>
  );
}
