import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, InputNumber, Modal, Popconfirm, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { ModalForm, ProFormDigit, ProFormSelect, ProFormText, ProFormTextArea } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { api } from '../api';
import type { WorkbenchType } from '../types';
import WmPage from '../components/WmPage';

export default function Types() {
  const { message } = App.useApp();
  const actionRef = useRef<ActionType>();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WorkbenchType | null>(null);
  const [usedCounts, setUsedCounts] = useState<Record<string, number>>({});

  const loadCounts = () => {
    api
      .listWorkbenches()
      .then((list) => {
        const counts: Record<string, number> = {};
        for (const w of list) counts[w.type] = (counts[w.type] ?? 0) + 1;
        setUsedCounts(counts);
      })
      .catch(() => undefined);
  };
  useEffect(loadCounts, []);

  const columns: ProColumns<WorkbenchType>[] = [
    {
      title: '类型标识',
      dataIndex: 'key',
      width: 130,
      render: (_, t) => (
        <Space size={4}>
          <Tag color="geekblue" style={{ fontFamily: 'monospace' }}>
            {t.key}
          </Tag>
          {t.key === 'web' ? <Tag color="default">内置</Tag> : null}
        </Space>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      render: (_, t) => (
        <Space size={6}>
          <span>{t.icon}</span>
          <span className="wm-strong">{t.name}</span>
        </Space>
      ),
    },
    {
      title: '探测语义',
      key: 'health',
      render: (_, t) => (
        <Space size={6} wrap>
          <Tag>{t.health_method}</Tag>
          <Typography.Text code className="wm-num">
            {t.health_path}
          </Typography.Text>
          <Tag color={t.expect_status == null ? 'default' : 'green'}>
            {t.expect_status == null ? '任意响应即在线' : `期望 ${t.expect_status}`}
          </Tag>
        </Space>
      ),
    },
    {
      title: '默认端口',
      dataIndex: 'default_port',
      width: 100,
      align: 'right',
      render: (_, t) => (t.default_port ? <span className="wm-num wm-mono">{t.default_port}</span> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '使用中',
      key: 'used',
      width: 80,
      align: 'right',
      render: (_, t) => {
        const n = usedCounts[t.key] ?? 0;
        return n ? <Tag color="blue">{n} 个</Tag> : <Typography.Text type="secondary">0</Typography.Text>;
      },
    },
    { title: '说明', dataIndex: 'description', ellipsis: { showTitle: true } },
    {
      title: '操作',
      valueType: 'option',
      width: 120,
      render: (_, t) => (
        <Space size={0}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setEditing(t);
              setFormOpen(true);
            }}
          >
            编辑
          </Button>
          {t.key === 'web' ? (
            <Tooltip title="内置类型不可删除">
              <Button size="small" type="link" disabled>
                删除
              </Button>
            </Tooltip>
          ) : (usedCounts[t.key] ?? 0) > 0 ? (
            <Tooltip title={`仍有 ${usedCounts[t.key]} 个工作台使用此类型`}>
              <Button size="small" type="link" disabled>
                删除
              </Button>
            </Tooltip>
          ) : (
            <Popconfirm
              title={`删除类型「${t.name}」？`}
              onConfirm={async () => {
                try {
                  await api.deleteType(t.id);
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
          )}
        </Space>
      ),
    },
  ];

  return (
    <WmPage
      subTitle="工作台类型决定健康探测方式（方法 · 路径 · 期望状态码）与默认端口"
      extra={(
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          新增类型
        </Button>
      )}
    >
      <ProTable<WorkbenchType>
        actionRef={actionRef}
        rowKey="id"
        search={false}
        columns={columns}
        request={async () => {
          const data = await api.listTypes();
          return { data, success: true };
        }}
        pagination={false}
        options={{ reload: true }}
      />

      <ModalForm
        key={editing ? `edit-${editing.id}` : 'create'}
        title={editing ? `编辑类型：${editing.name}` : '新增类型'}
        width={520}
        open={formOpen}
        onOpenChange={(v) => !v && setFormOpen(false)}
        modalProps={{ destroyOnClose: true, maskClosable: false }}
        initialValues={
          editing ?? {
            key: '',
            name: '',
            icon: '',
            default_port: null,
            health_method: 'GET',
            health_path: '/',
            expect_status: null,
            description: '',
          }
        }
        onFinish={async (values) => {
          try {
            if (editing) await api.updateType(editing.id, values);
            else await api.createType(values);
            message.success('已保存');
            actionRef.current?.reload();
            loadCounts();
            return true;
          } catch (e) {
            message.error(`保存失败：${(e as Error).message}`);
            return false;
          }
        }}
      >
        <ProFormText
          name="key"
          label="类型标识"
          disabled={!!editing}
          rules={[
            { required: true, message: '请输入类型标识' },
            { pattern: /^[a-z0-9][a-z0-9-]*$/, message: '仅小写字母/数字/连字符' },
          ]}
          placeholder="例如：comfyui"
          extra="创建后不可修改"
        />
        <ProFormText name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]} placeholder="例如：ComfyUI 工作流" />
        <ProFormText name="icon" label="图标" width="xs" placeholder="🎨（可空）" />
        <ProFormDigit name="default_port" label="默认端口" width="xs" min={1} max={65535} placeholder="可空" extra="新增该类型工作台时自动填入 URL" />
        <ProFormSelect
          name="health_method"
          label="探测方法"
          options={[
            { value: 'GET', label: 'GET' },
            { value: 'HEAD', label: 'HEAD' },
          ]}
        />
        <ProFormText name="health_path" label="探测路径" rules={[{ required: true, message: '请输入探测路径' }]} placeholder="/healthz" />
        <ProFormDigit
          name="expect_status"
          label="期望状态码"
          width="xs"
          min={100}
          max={599}
          fieldProps={{ precision: 0 }}
          placeholder="留空 = 任意响应即在线"
          extra="留空表示收到任何 HTTP 响应（含 401/405）都视为在线；填数字则要求精确匹配"
        />
        <ProFormTextArea name="description" label="说明" placeholder="这个类型适用于什么服务（可空）" />
      </ModalForm>
    </WmPage>
  );
}
