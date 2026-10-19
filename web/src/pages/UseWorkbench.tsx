import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { App, Button, Result, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge';

export default function UseWorkbench() {
  const { id } = useParams();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [frameKey, setFrameKey] = useState(0);
  const [checking, setChecking] = useState(false);

  const req = useRequest(() => api.getWorkbench(Number(id)), { manual: false });

  if (req.loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (req.error || !req.data) {
    return (
      <Result
        status="404"
        title="工作台不存在"
        subTitle={req.error?.message}
        extra={
          <Button type="primary" onClick={() => nav('/')}>
            返回总览
          </Button>
        }
      />
    );
  }

  const w = req.data;

  return (
    <div className="wm-use-wrap">
      <div className="wm-use-bar">
        <Button
          type="text"
          icon={<ArrowLeftOutlined style={{ color: '#E2E8F0' }} />}
          onClick={() => nav('/')}
          aria-label="返回"
        />
        <span style={{ fontSize: 18 }}>{w.icon || '▢'}</span>
        <Typography.Title level={5} className="wm-use-title" style={{ marginBottom: 0 }}>
          {w.name}
        </Typography.Title>
        <StatusBadge status={w.last_status} latency={w.last_latency_ms} error={w.last_error} checkedAt={w.last_checked_at} />
        <Tag color="geekblue">{w.type}</Tag>
        <Typography.Text className="wm-num wm-mono" style={{ color: '#94A3B8', fontSize: 12 }}>
          {w.url}
        </Typography.Text>
        <Space style={{ marginLeft: 'auto' }}>
          <Button
            size="small"
            loading={checking}
            onClick={async () => {
              setChecking(true);
              try {
                const r = await api.checkOne(w.id);
                if (r.last_status === 'up') message.success(`在线（${r.last_latency_ms}ms）`);
                else message.error(`离线：${r.last_error || '未知原因'}`);
                req.refresh();
              } finally {
                setChecking(false);
              }
            }}
            style={{ color: '#CBD5E1' }}
          >
            检测
          </Button>
          <Tooltip title="重新载入内嵌页面；若页面空白，说明该工作台禁止被嵌入，请用新窗口打开">
            <Button
              size="small"
              icon={<ReloadOutlined style={{ color: '#CBD5E1' }} />}
              onClick={() => setFrameKey((k) => k + 1)}
              aria-label="重新载入"
            />
          </Tooltip>
          <a href={w.url} target="_blank" rel="noreferrer">
            <Button size="small" icon={<ExportOutlined style={{ color: '#CBD5E1' }} />}>
              新窗口
            </Button>
          </a>
        </Space>
      </div>
      <iframe
        key={frameKey}
        className="wm-use-frame"
        src={w.url}
        title={w.name}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      <Typography.Paragraph
        type="secondary"
        style={{ textAlign: 'center', fontSize: 12, margin: '6px 0', flex: 'none' }}
      >
        部分工作台通过 X-Frame-Options / CSP 禁止内嵌，页面空白时请点右上角「新窗口」打开 ·{' '}
        <Link to="/market">返回市场管理</Link>
      </Typography.Paragraph>
    </div>
  );
}
