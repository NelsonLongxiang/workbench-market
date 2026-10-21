import { useEffect, useState } from 'react';
import { App, Button, Card, Descriptions, Flex, Form, InputNumber, Modal, Radio, Space, Typography, Upload } from 'antd';
import { DownloadOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { api } from '../api';
import type { ExportPayload } from '../types';

export default function Settings() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [saving, setSaving] = useState(false);

  const settingsReq = useRequest(api.getSettings, {
    onSuccess: (s) => {
      form.setFieldsValue({
        health_interval_seconds: Number(s.health_interval_seconds) || 0,
        health_timeout_ms: Number(s.health_timeout_ms) || 5000,
        health_concurrency: Number(s.health_concurrency) || 8,
      });
    },
  });
  const healthReq = useRequest(api.getHealth);

  useEffect(() => {
    healthReq.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (values: { health_interval_seconds: number; health_timeout_ms: number; health_concurrency: number }) => {
    setSaving(true);
    try {
      await api.putSettings({
        health_interval_seconds: String(values.health_interval_seconds ?? 0),
        health_timeout_ms: String(values.health_timeout_ms ?? 5000),
        health_concurrency: String(values.health_concurrency ?? 8),
      });
      message.success('巡检设置已保存');
      settingsReq.refresh();
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const downloadExport = async () => {
    try {
      const payload = await api.exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      a.href = url;
      a.download = `workbench-market-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      message.error(`导出失败：${(e as Error).message}`);
    }
  };

  const doImport = async (payload: ExportPayload) => {
    try {
      const r = await api.importAll(payload, importMode);
      message.success(`导入完成：新增 ${r.imported} 个，跳过 ${r.skipped} 个（${importMode === 'merge' ? '合并' : '替换'}模式）`);
      settingsReq.refresh();
    } catch (e) {
      message.error(`导入失败：${(e as Error).message}`);
    }
  };

  return (
    <Flex vertical gap={16} style={{ width: '100%', alignItems: 'flex-start' }}>
      <Card title="健康巡检" style={{ width: '100%', maxWidth: 640 }} styles={{ body: { paddingTop: 8 } }}>
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          style={{ maxWidth: 480 }}
        >
          <Form.Item
            name="health_interval_seconds"
            label="巡检间隔（秒）"
            rules={[{ required: true }]}
            extra="0 = 关闭定期巡检；最小生效值 10 秒。巡检由服务端后台执行，所有「启用」状态的工作台都会被探测"
          >
            <InputNumber min={0} max={86400} step={10} style={{ width: 160 }} className="wm-num" />
          </Form.Item>
          <Form.Item name="health_timeout_ms" label="单次探测超时（毫秒）" rules={[{ required: true }]}>
            <InputNumber min={500} max={60000} step={500} style={{ width: 160 }} className="wm-num" />
          </Form.Item>
          <Form.Item name="health_concurrency" label="探测并发数" rules={[{ required: true }]} extra="全部检测时同时探测的工作台数量">
            <InputNumber min={1} max={32} style={{ width: 160 }} className="wm-num" />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
            保存
          </Button>
        </Form>
      </Card>

      <Card title="数据备份 / 迁移" style={{ width: '100%', maxWidth: 640 }} styles={{ body: { paddingTop: 12 } }}>
        <Flex vertical gap={12} style={{ width: '100%' }}>
          <Space>
            <Button icon={<DownloadOutlined />} onClick={downloadExport}>
              导出 JSON
            </Button>
            <Typography.Text type="secondary">包含全部工作台、类型、设置</Typography.Text>
          </Space>
          <Flex vertical gap={4}>
            <Radio.Group
              value={importMode}
              onChange={(e) => setImportMode(e.target.value)}
              options={[
                { value: 'merge', label: '合并（追加到现有数据）' },
                { value: 'replace', label: '替换（清空后导入，危险）' },
              ]}
            />
            <Upload
              accept=".json,application/json"
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  try {
                    const payload = JSON.parse(String(reader.result));
                    if (!Array.isArray(payload.workbenches)) throw new Error('缺少 workbenches 数组，不是 workbench-market 导出文件');
                    const proceed = () => doImport(payload);
                    if (importMode === 'replace') {
                      modal.confirm({
                        title: '替换模式将清空现有工作台与自定义类型',
                        content: `将导入 ${payload.workbenches.length} 个工作台，此操作不可撤销。确认继续？`,
                        okButtonProps: { danger: true },
                        onOk: proceed,
                      });
                    } else {
                      proceed();
                    }
                  } catch (e) {
                    message.error(`文件解析失败：${(e as Error).message}`);
                  }
                };
                reader.readAsText(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>导入 JSON</Button>
            </Upload>
          </Flex>
        </Flex>
      </Card>

      <Card title="关于" style={{ width: '100%', maxWidth: 640 }} styles={{ body: { paddingTop: 8 } }}>
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'name', label: '产品', children: 'workbench-market · 工作台市场' },
            { key: 'ver', label: '版本', children: <span className="wm-num">{String((healthReq.data as { version?: string })?.version ?? '0.1.0')}</span> },
            { key: 'arch', label: '架构', children: 'Express + node:sqlite（单文件 SQLite，零原生依赖）· React + antd + pro-components' },
            { key: 'db', label: '数据位置', children: <span className="wm-mono" style={{ fontSize: 12 }}>server/data/workbench-market.db（可用 DATA_DIR 环境变量重定向）</span> },
            { key: 'up', label: '服务运行时长', children: <span className="wm-num">{healthReq.data ? `${(healthReq.data as { uptime_s?: number }).uptime_s}s` : '-'}</span> },
          ]}
        />
      </Card>
    </Flex>
  );
}
