import { useCallback, useEffect, useState } from 'react';
import { App, Button, Descriptions, Drawer, Empty, Space, Table, Tabs, Tag, Typography } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';

interface AppDataRow { id: number; data: Record<string, unknown>; created_by: string; created_at: string }
interface AppFileRow { id: number; original_name: string; mime: string; size: number; created_by: string; created_at: string; url: string }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 自产台提交数据查看器（派单 direct-22838fab 的 UI 补齐）：
 *  数据行（POST /api/apps/<slug>/data）+ 文件行（/files）——同源直读，游标分页「加载更多」。 */
export default function AppDataDrawer({ slug, title, open, onClose }: { slug: string; title?: string; open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<AppDataRow[]>([]);
  const [files, setFiles] = useState<AppFileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState<{ data: number | null; files: number | null }>({ data: null, files: null });

  const load = useCallback(async (append = false) => {
    if (!slug) return;
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: '20' });
      if (append && more.data) q.set('before_id', String(more.data));
      const [dr, fr] = await Promise.all([
        fetch(`/api/apps/${slug}/data?${q.toString()}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`数据 HTTP ${r.status}`)))),
        fetch(`/api/apps/${slug}/files?limit=20${append && more.files ? `&before_id=${more.files}` : ''}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`文件 HTTP ${r.status}`)))),
      ]);
      setRows((prev) => (append ? [...prev, ...dr.items] : dr.items));
      setFiles((prev) => (append ? [...prev, ...fr.items] : fr.items));
      setMore({ data: dr.has_more ? dr.next_before_id : null, files: fr.has_more ? fr.next_before_id : null });
    } catch (e) {
      message.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [slug, more.data, more.files, message]);

  useEffect(() => {
    if (open) { setRows([]); setFiles([]); setMore({ data: null, files: null }); void load(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug]);

  const dataCols = [
    { title: '#', dataIndex: 'id', width: 64, render: (v: number) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{v}</Typography.Text> },
    {
      title: '内容', dataIndex: 'data',
      render: (d: Record<string, unknown>) => (
        <div style={{ maxHeight: 160, overflow: 'auto' }}>
          <pre className="wm-mono" style={{ fontSize: 11.5, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(d, null, 1)}</pre>
        </div>
      ),
    },
    { title: '提交者', dataIndex: 'created_by', width: 110, render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text> },
    { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> },
  ];

  const fileCols = [
    { title: '文件', dataIndex: 'original_name', render: (v: string) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{v}</Typography.Text> },
    { title: '类型', dataIndex: 'mime', width: 140, render: (v: string) => <Tag>{v || 'octet-stream'}</Tag> },
    { title: '大小', dataIndex: 'size', width: 90, render: (v: number) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{fmtSize(v)}</Typography.Text> },
    { title: '提交者', dataIndex: 'created_by', width: 100, render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text> },
    { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> },
    {
      title: '', width: 70, render: (_: unknown, r: AppFileRow) => (
        <Button size="small" type="link" icon={<DownloadOutlined />} href={r.url} target="_blank">下载</Button>
      ),
    },
  ];

  return (
    <Drawer
      title={<Space>提交数据 · <Typography.Text className="wm-mono" style={{ fontSize: 13 }}>{slug}</Typography.Text>{title ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{title}</Typography.Text> : null}</Space>}
      size="large"
      open={open}
      onClose={onClose}
      extra={<Button icon={<ReloadOutlined />} onClick={() => void load(false)} loading={loading}>刷新</Button>}
    >
      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}
        items={[
          { key: 'd', label: '数据行', children: <b>{rows.length}</b> },
          { key: 'f', label: '文件', children: <b>{files.length}</b> },
        ]}
      />
      <Tabs
        items={[
          {
            key: 'data', label: '表单数据',
            children: rows.length ? (
              <>
                <Table rowKey="id" size="small" columns={dataCols} dataSource={rows} pagination={false} loading={loading} />
                {more.data ? <Button block style={{ marginTop: 12 }} onClick={() => void load(true)} loading={loading}>加载更多</Button> : null}
              </>
            ) : <Empty description="还没有提交数据 —— 台页面的表单点「提交到服务器」后会出现在这里（或经 POST /api/apps/:slug/data 写入）" />,
          },
          {
            key: 'files', label: '文件',
            children: files.length ? (
              <>
                <Table rowKey="id" size="small" columns={fileCols} dataSource={files} pagination={false} loading={loading} />
                {more.files ? <Button block style={{ marginTop: 12 }} onClick={() => void load(true)} loading={loading}>加载更多</Button> : null}
              </>
            ) : <Empty description="还没有提交文件 —— POST /api/apps/:slug/files（multipart，任意类型 ≤50MB）" />,
          },
        ]}
      />
    </Drawer>
  );
}
