import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { App, Button, Result, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, getBenchEntry } from '../api';
import StatusBadge from '../components/StatusBadge';
import GoFrame from '../components/GoFrame';
import UseTopBar from '../components/UseTopBar';
import { benchUseRef, benchUseText } from '../bench-link-view';
import { USE_SELF_TEXT, pointsAtMarket } from '../embed-guard';

export default function UseWorkbench() {
  const { id } = useParams();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [frameKey, setFrameKey] = useState(0);
  const [checking, setChecking] = useState(false);

  const req = useRequest(() => api.getWorkbench(Number(id)), { manual: false });

  if (req.loading) {
    return (
      <div className="wm-use-loading">
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
            返回全景
          </Button>
        }
      />
    );
  }

  const w = req.data;
  // #1086：卡片地址是本站的 /use/<台>：这是一个数据视图台，还没对应到这张卡片。写明下一步；管理层带一个去台上的按钮（不在这里直接跳——入口按卡片 id 判权）
  const benchRef = benchUseRef(w.url, window.location.origin);
  if (benchRef !== null) {
    return <UseBenchHint bench={benchRef} />;
  }
  // 登记的地址指向市场自己：不嵌（嵌出来就是市场套市场），说一句、给个回去的按钮
  if (pointsAtMarket(w.url, window.location.origin)) {
    return <div data-testid="use-self"><Result status="info" title={USE_SELF_TEXT} extra={<Button onClick={() => nav('/')}>返回全景</Button>} /></div>;
  }

  return (
    <div className="wm-use-wrap">
      <UseTopBar cardId={String(id ?? '')} page="card" title={<span className="wm-use-title"><span className="wm-use-icon">{w.icon || '▢'}</span> {w.name}</span>}>
        <StatusBadge status={w.last_status} latency={w.last_latency_ms} error={w.last_error} checkedAt={w.last_checked_at} url={w.url} />
        <Tag color="geekblue">{w.type}</Tag>
        <Typography.Text className="wm-num wm-mono wm-caption">
          {w.url}
        </Typography.Text>
        <Space className="wm-use-bar-right">
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
      </UseTopBar>
      <GoFrame wid={w.id} name={w.name} frameKey={frameKey} className="wm-use-frame" />
      <Typography.Paragraph
        type="secondary"
        className="wm-caption wm-use-foot"
      >
        经统一门户 /go/{w.id}/ 同源代理嵌入（自动剥除上游禁嵌响应头）；个别页面主动跳出到外域时请点右上角「新窗口」 ·{' '}
        <Link to="/market">返回工作台市场</Link>
      </Typography.Paragraph>
    </div>
  );
}

/** #1086 卡片地址指向本站台页面时：说清楚是哪个台、下一步做什么；台读得到名字就写名字（读不到不露台标识）；管理层看得到「去台上对应」 */
function UseBenchHint({ bench }: { bench: string }) {
  const nav = useNavigate();
  const [info, setInfo] = useState<{ title: string | null; canLink: boolean }>({ title: null, canLink: false });
  useEffect(() => {
    let live = true;
    void getBenchEntry(bench).then((r) => {
      if (!live || r.status !== 200 || !r.body || typeof r.body !== 'object') return;
      const e = r.body as { bench?: { title?: unknown }; can?: { rename?: unknown } };
      setInfo({ title: typeof e.bench?.title === 'string' && e.bench.title.trim() ? e.bench.title.trim() : null, canLink: e.can?.rename === true });
    });
    return () => { live = false; };
  }, [bench]);
  return (
    <div data-testid="use-bench-hint">
      <Result status="info" title="这张卡片还没对应到数据视图台" subTitle={benchUseText(info.title)}
        extra={[
          info.canLink ? <Button key="go" type="primary" onClick={() => nav(`/use/${encodeURIComponent(bench)}`)} data-testid="use-bench-go">去台上对应</Button> : null,
          <Button key="home" onClick={() => nav('/')}>返回全景</Button>,
        ]} />
    </div>
  );
}
