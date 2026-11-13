import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { App, Button, Result, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, getBenchEntry } from '../api';
import StatusBadge from '../components/StatusBadge';
import GoFrame from '../components/GoFrame';
import BenchPage from './BenchPage';
import { ENTRY_TEXT, entryOutcome, type EntryOutcome } from '../bench-page-view';

/** 打开一张卡片：先问视图台的入口。是视图台、读得到 → 数据视图页；404（读不到的、不存在的、不是视图台的，一样的应答）→ 照原来嵌页面；
 *  没登录 → 去登录；只带管理口令或跨站 → 说要用自己的账号；读不到 → 再试一次 */
export default function UseWorkbench() {
  const { id = '' } = useParams();
  const [tries, setTries] = useState(0);
  const [out, setOut] = useState<EntryOutcome | null>(null);
  useEffect(() => {
    let live = true;
    setOut(null);
    void getBenchEntry(id).then((r) => { if (live) setOut(entryOutcome(r.status, r.body)); });
    return () => { live = false; };
  }, [id, tries]);
  if (!out) return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }} data-testid="use-entry-loading"><Spin size="large" /></div>;
  if (out.kind === 'bench') return <BenchPage key={id} cardId={id} entry={out.entry} />;
  if (out.kind === 'card') return <EmbedWorkbench />;
  if (out.kind === 'login') return <div data-testid="use-entry-login"><Result status="info" title={ENTRY_TEXT.login} subTitle={ENTRY_TEXT.loginSub} extra={<Button type="primary" onClick={() => window.location.assign('/login')}>去登录</Button>} /></div>;
  if (out.kind === 'forbidden') return <div data-testid="use-entry-forbidden"><Result status="info" title={ENTRY_TEXT.forbidden} subTitle={ENTRY_TEXT.forbiddenSub} extra={<Link to="/market"><Button>回工作台市场</Button></Link>} /></div>;
  return <div data-testid="use-entry-error"><Result status="warning" title={ENTRY_TEXT.error} subTitle={ENTRY_TEXT.errorSub} extra={<Button type="primary" onClick={() => setTries((n) => n + 1)}>再试一次</Button>} /></div>;
}

function EmbedWorkbench() {
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
