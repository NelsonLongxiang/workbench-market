import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { App, Button, Card, Col, Empty, Row, Space, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, AppstoreOutlined, ExportOutlined, ReloadOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Responsive, WidthProvider } from 'react-grid-layout';
import type { Layout, Layouts } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { api } from '../api';
import type { Workbench } from '../types';
import StatusBadge from '../components/StatusBadge';

const ResponsiveGridLayout = WidthProvider(Responsive);
const LAYOUT_KEY = 'wm.dashboard.layouts.v2';
const COLS = { lg: 6, md: 4, sm: 2, xs: 1, xxs: 1 };

function defaultLayout(items: Workbench[]): Layouts {
  const mk = (perRow: number) =>
    items.map((w, idx) => ({
      i: String(w.id),
      x: idx % perRow,
      y: Math.floor(idx / perRow),
      w: 1,
      h: 3,
      minW: 1,
      minH: 3,
    }));
  return { lg: mk(6), md: mk(4), sm: mk(2), xs: mk(1), xxs: mk(1) };
}

function loadSaved(): Layouts | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as Layouts) : null;
  } catch {
    return null;
  }
}

/** 已保存布局与当前工作台集合对账：移除消失项、补上新增项 */
function reconcile(items: Workbench[], saved: Layouts | null): Layouts {
  const defaults = defaultLayout(items);
  if (!saved) return defaults;
  const ids = new Set(items.map((w) => String(w.id)));
  const out: Layouts = {};
  for (const bp of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const known = (saved[bp] ?? []).filter((l) => ids.has(l.i));
    const knownIds = new Set(known.map((l) => l.i));
    const missing = defaults[bp].filter((l) => !knownIds.has(l.i));
    out[bp] = [...known, ...missing] as Layout[];
  }
  return out;
}

export default function Dashboard() {
  const { message } = App.useApp();
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [savedLayouts, setSavedLayouts] = useState<Layouts | null>(() => loadSaved());

  const summary = useRequest(api.summary, { pollingInterval: 15000 });
  const list = useRequest(() => api.listWorkbenches(), {
    pollingInterval: 15000,
    onSuccess: () => undefined,
  });
  const items = list.data ?? [];

  const layouts = useMemo(() => reconcile(items, savedLayouts), [items, savedLayouts]);

  const checkAll = async () => {
    setChecking(true);
    try {
      const r = await api.checkAll();
      message.success(`检测完成：${r.up} 在线 / ${r.down} 离线（共 ${r.checked}）`);
    } catch (e) {
      message.error(`检测失败：${(e as Error).message}`);
    } finally {
      setChecking(false);
      summary.refresh();
      list.refresh();
    }
  };

  const checkOne = async (id: number) => {
    setBusyId(id);
    try {
      const w = await api.checkOne(id);
      w.last_status === 'up'
        ? message.success(`${w.name} 在线（${w.last_latency_ms}ms）`)
        : message.error(`${w.name} 离线：${w.last_error || '未知原因'}`);
    } catch (e) {
      message.error(`检测失败：${(e as Error).message}`);
    } finally {
      setBusyId(null);
      summary.refresh();
      list.refresh();
    }
  };

  const s = summary.data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Row gutter={12}>
        {[
          { title: '工作台总数', value: s?.total ?? 0, suffix: '个', color: '#1F1F1F' },
          { title: '在线', value: s?.up ?? 0, suffix: '个', color: '#059669' },
          { title: '离线', value: s?.down ?? 0, suffix: '个', color: '#DC2626' },
          { title: '未探测', value: s?.unknown ?? 0, suffix: '个', color: '#8C8C8C' },
          {
            title: '平均延迟',
            value: s?.avg_latency_ms ?? '-',
            suffix: s?.avg_latency_ms != null ? 'ms' : '',
            color: '#1E3A5F',
          },
        ].map((it) => (
          <Col key={it.title} xs={12} md={8} lg={4} xl={4} xxl={4}>
            <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
              <div style={{ padding: '2px 0' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {it.title}
                </Typography.Text>
                <div className="wm-num" style={{ color: it.color, fontSize: 24, fontWeight: 600, lineHeight: 1.4 }}>
                  {it.value}
                  {it.suffix ? <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 4 }}>{it.suffix}</span> : null}
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={checking} onClick={checkAll}>
            全部检测
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { summary.refresh(); list.refresh(); }}>
            刷新
          </Button>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          卡片可拖拽（按住标题行）与缩放，布局自动保存 · 每 15 秒自动刷新
        </Typography.Text>
      </Space>

      {items.length === 0 ? (
        <Card styles={{ body: { padding: 48 } }}>
          <Empty description="还没有注册任何工作台">
            <Link to="/market">
              <Button type="primary" icon={<AppstoreOutlined />}>
                去工作台市场新增
              </Button>
            </Link>
          </Empty>
        </Card>
      ) : (
        <ResponsiveGridLayout
          className="layout"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={COLS}
          rowHeight={72}
          margin={[12, 12]}
          draggableHandle=".wm-card-head"
          onLayoutChange={(_layout: Layout[], allLayouts: Layouts) => {
            setSavedLayouts(allLayouts);
            try {
              localStorage.setItem(LAYOUT_KEY, JSON.stringify(allLayouts));
            } catch {
              /* 布局保存失败不阻塞使用 */
            }
          }}
        >
          {items.map((w) => (
            <div key={String(w.id)}>
              <div className="wm-card" style={{ opacity: w.enabled ? 1 : 0.55 }}>
                <div className="wm-card-head">
                  <span className="wm-card-icon">{w.icon || <AppstoreOutlined style={{ color: '#94A3B8' }} />}</span>
                  <span className="wm-card-title" title={w.name}>
                    {w.name}
                  </span>
                  {!w.enabled ? <Tag style={{ marginRight: 0 }}>停用</Tag> : null}
                </div>
                <div className="wm-card-url" title={w.url}>
                  {w.url}
                </div>
                <StatusBadge
                  status={w.last_status}
                  latency={w.last_latency_ms}
                  error={w.last_error}
                  checkedAt={w.last_checked_at}
                />
                <div className="wm-card-foot">
                  <Link to={`/use/${w.id}`}>
                    <Button size="small" type="primary" icon={<RightOutlined />}>
                      使用
                    </Button>
                  </Link>
                  <Tooltip title="新窗口打开">
                    <a href={w.url} target="_blank" rel="noreferrer">
                      <Button size="small" icon={<ExportOutlined />} aria-label="新窗口打开" />
                    </a>
                  </Tooltip>
                  <Tooltip title="健康检测">
                    <Button
                      size="small"
                      icon={<ApiOutlined aria-label="健康检测" />}
                      loading={busyId === w.id}
                      onClick={() => checkOne(w.id)}
                    />
                  </Tooltip>
                </div>
              </div>
            </div>
          ))}
        </ResponsiveGridLayout>
      )}
    </div>
  );
}
