/** 总览（PATTERNS.md §2.1 / §6）：日常入口——关键指标 + 我的待办摘要 + 常用工作台。
 *  12 列栅格四类卡片：指标卡 ×6（各 4 列）→ 待办列表卡 + 分类在线率趋势卡（各 6 列）→ 工作台状态卡（12 列）。 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { App, Button, Tag, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, ReloadOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTasksPoll } from './Tasks';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { BarChart, DashCard, DashGrid, ListCard, MetricCard, StatusGrid } from '../components/Dash';

const POLL_MS = 15000;
/** 超过两个刷新周期没拿到新数据就算过期，卡片头显示「数据截至」 */
const STALE_MS = POLL_MS * 2;
const MAX_CATS = 5;
const MAX_STATUS = 12;

export default function Dashboard() {
  const { message } = App.useApp();
  const [checking, setChecking] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const summary = useRequest(api.summary, { pollingInterval: POLL_MS, onSuccess: () => setAsOf(Date.now()) });
  const list = useRequest(() => api.listWorkbenches(), { pollingInterval: POLL_MS });
  const { payload: tasksPayload, loading: tasksLoading, error: tasksError } = useTasksPoll();
  const items = list.data ?? [];
  const s = summary.data;
  const total = s?.total ?? 0;
  const rate = total ? Math.round(((s?.up ?? 0) / total) * 100) : 0;
  const tasks = tasksPayload?.tasks ?? [];
  const open = tasks.filter((t) => t.status !== 'done');
  const tTodo = tasksPayload ? tasks.filter((t) => t.status === 'todo').length : '—';
  const tDoing = tasksPayload ? tasks.filter((t) => t.status === 'doing').length : '—';
  const yglOk = tasksPayload?.sources?.['ygl-trees']?.ok !== false;
  const lastChecked = items.reduce<string>((max, w) => (w.last_checked_at && w.last_checked_at > max ? w.last_checked_at : max), '');

  // 分类在线率：最多 5 类，其余并入「其他」（图表最多 5 行，超过就分组）
  const cats = Object.entries(s?.categories ?? {}).sort((a, b) => b[1].total - a[1].total);
  const head = cats.slice(0, cats.length > MAX_CATS ? MAX_CATS - 1 : MAX_CATS);
  const tail = cats.slice(head.length);
  const catRows = [
    ...head.map(([name, c]) => ({ label: name || '未分类', values: { up: c.up, down: c.total - c.up } })),
    ...(tail.length ? [{ label: `其他 ${tail.length} 类`, values: tail.reduce((acc, [, c]) => ({ up: acc.up + c.up, down: acc.down + c.total - c.up }), { up: 0, down: 0 }) }] : []),
  ];

  const refresh = () => { summary.refresh(); list.refresh(); };
  const checkAll = async () => {
    setChecking(true);
    try {
      const r = await api.checkAll();
      message.success(`检测完成：${r.up} 在线 / ${r.down} 离线（共 ${r.checked}）`);
    } catch (e) {
      message.error(`检测失败：${(e as Error).message}`);
    } finally {
      setChecking(false);
      refresh();
    }
  };

  const loadingSummary = summary.loading && !s;
  return (
    <WmPage
      subTitle="我的待办摘要 · 常用工作台 · 关键指标（每 15 秒自动刷新）"
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>,
        <Button key="check" type="primary" icon={<ThunderboltOutlined />} loading={checking} onClick={checkAll}>全部检测</Button>,
      ]}
    >
      <DashGrid>
        <MetricCard span={4} label="工作台总数" value={total} suffix="个" to="/market" loading={loadingSummary}
          sub={<>平均延迟 <span className="wm-num">{s?.avg_latency_ms != null ? `${s.avg_latency_ms} ms` : '—'}</span></>} />
        <MetricCard span={4} label="在线" value={s?.up ?? 0} suffix="个" tone="success" to="/market?status=up" loading={loadingSummary}
          sub={<>在线率 <span className="wm-num">{rate}%</span></>} />
        <MetricCard span={4} label="离线" value={s?.down ?? 0} suffix="个" tone={(s?.down ?? 0) > 0 ? 'danger' : 'default'} to="/market?status=down" loading={loadingSummary}
          sub={<>未探测 <span className="wm-num">{s?.unknown ?? 0}</span> 个</>} />
        <MetricCard span={4} label={tasksError ? (tasksError.code === 'tasks_auth_required' ? '待办(需登录)' : '待办(读取失败)') : yglOk ? '待办' : '待办(源降级)'} value={tTodo} suffix="项" tone={typeof tTodo === 'number' && tTodo > 0 ? 'warning' : 'default'} to="/tasks" loading={tasksLoading && !tasksPayload} />
        <MetricCard span={4} label="进行中" value={tDoing} suffix="项" to="/tasks" loading={tasksLoading && !tasksPayload} />
        <MetricCard span={4} label="上次巡检" value={lastChecked ? <RelTime value={lastChecked} /> : '尚未巡检'} to="/settings" loading={list.loading && !list.data}
          sub="巡检间隔可在「设置」页配置" />

        <ListCard
          title="我的待办"
          span={6}
          rows={open}
          rowKey={(t) => t.id}
          moreTo="/tasks"
          loading={tasksLoading && !tasksPayload}
          empty={<Typography.Text type="secondary">{tasksError ? <Link to="/tasks">待办未读取，请登录或确认权限</Link> : <>没有未完成的待办——<Link to="/tasks">去统一待办发布任务</Link></>}</Typography.Text>}
          render={(t) => (
            <>
              <Tag color={t.status === 'doing' ? 'processing' : 'default'} style={{ marginRight: 0 }}>{t.status === 'doing' ? '进行中' : '待办'}</Tag>
              {t.link ? <Typography.Link href={t.link} target="_blank" ellipsis style={{ flex: 1, minWidth: 0 }}>{t.title}</Typography.Link>
                : <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>{t.title}</Typography.Text>}
              <Tag style={{ marginRight: 0 }}>{t.source === 'lifecycle' ? '生命周期' : t.source}</Tag>
            </>
          )}
        />
        <DashCard
          title="分类在线率"
          span={6}
          loading={loadingSummary}
          isEmpty={catRows.length === 0}
          empty={<Typography.Text type="secondary">还没有分类数据——在工作台市场给工作台填写分类</Typography.Text>}
          asOf={asOf}
          staleAfterMs={STALE_MS}
        >
          <BarChart
            series={[{ key: 'up', label: '在线', tone: 'success' }, { key: 'down', label: '离线/未探测', tone: 'muted' }]}
            data={catRows}
          />
        </DashCard>

        <DashCard
          title="工作台状态"
          span={12}
          loading={list.loading && !list.data}
          isEmpty={items.length === 0}
          empty={(
            <div style={{ textAlign: 'center', padding: 'var(--wm-space-4) 0' }}>
              <Typography.Paragraph type="secondary">还没有注册任何工作台</Typography.Paragraph>
              <Link to="/market"><Button type="primary" icon={<AppstoreOutlined />}>去工作台市场新增</Button></Link>
            </div>
          )}
          asOf={asOf}
          staleAfterMs={STALE_MS}
          extra={<Link to="/market" className="wm-dash-more">查看全部 {items.length} 个 <RightOutlined /></Link>}
        >
          <StatusGrid>
            {[...items].sort((a, b) => Number(b.enabled) - Number(a.enabled)).slice(0, MAX_STATUS).map((w) => (
              <div key={w.id} className="wm-dash-status-item" style={{ opacity: w.enabled ? 1 : 0.6 }}>
                <span aria-hidden>{w.icon || '▢'}</span>
                <span className="wm-dash-status-name" title={w.name}>{w.name}</span>
                <StatusBadge status={w.last_status} latency={w.last_latency_ms} error={w.last_error} checkedAt={w.last_checked_at} />
                <Tooltip title="使用"><Link to={`/use/${w.id}`} aria-label={`使用 ${w.name}`}><RightOutlined /></Link></Tooltip>
              </div>
            ))}
          </StatusGrid>
        </DashCard>
      </DashGrid>
    </WmPage>
  );
}
