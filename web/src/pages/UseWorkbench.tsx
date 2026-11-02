import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { App, Button, Result, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge';
import GoFrame from '../components/GoFrame';

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
          icon={<ArrowLeftOutlined />}
          onClick={() => nav('/')}
          aria-label="返回"
        />
        <span style={{ fontSize: 18 }}>{w.icon || '▢'}</span>
        <Typography.Title level={5} className="wm-use-title" style={{ marginBottom: 0 }}>
          {w.name}
        </Typography.Title>
        <StatusBadge status={w.last_status} latency={w.last_latency_ms} error={w.last_error} checkedAt={w.last_checked_at} />
        <Tag color="geekblue">{w.type}</Tag>
        <Typography.Text className="wm-num wm-mono wm-caption">
          {w.url}
        </Typography.Text>
        <Space style={{ marginLeft: 'auto' }}>
          <Button
            type="text"
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
          >
            检测
          </Button>
          <Tooltip title="重新载入内嵌页面；若页面空白，说明该工作台禁止被嵌入，请用新窗口打开">
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => setFrameKey((k) => k + 1)}
              aria-label="重新载入"
            />
          </Tooltip>
          <a href={w.url} target="_blank" rel="noreferrer">
            <Button type="text" size="small" icon={<ExportOutlined />}>
              新窗口
            </Button>
          </a>
        </Space>
      </div>
      <GoFrame wid={w.id} name={w.name} frameKey={frameKey} className="wm-use-frame" />
      <Typography.Paragraph
        type="secondary"
        className="wm-caption" style={{ textAlign: 'center', margin: 'var(--wm-space-2) 0', flex: 'none' }}
      >
        经统一门户 /go/{w.id}/ 同源代理嵌入（自动剥除上游禁嵌响应头）；个别页面主动跳出到外域时请点右上角「新窗口」 ·{' '}
        <Link to="/market">返回市场管理</Link>
      </Typography.Paragraph>
    </div>
  );
}
