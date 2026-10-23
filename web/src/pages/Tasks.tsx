import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Segmented, Space, Tag, Typography } from 'antd';
import { PageContainer } from '@ant-design/pro-components';
import { ReloadOutlined } from '@ant-design/icons';

/** 任务信封（与 server/src/tasks.ts 契约一致，字段冻结 snake_case） */
export interface TaskEnvelope {
  id: string;
  source: 'ygl-trees' | 'market';
  title: string;
  status: 'todo' | 'doing' | 'done';
  due: string | null;
  link: string | null;
  project: string | null;
}
interface SourceMeta { ok: boolean; count: number; latency_ms: number }
interface TasksPayload {
  tasks: TaskEnvelope[];
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta };
  generated_at: string;
}

const STATUS_COLOR: Record<TaskEnvelope['status'], string> = { todo: 'default', doing: 'processing', done: 'success' };
const STATUS_TEXT: Record<TaskEnvelope['status'], string> = { todo: '待办', doing: '进行中', done: '已完成' };

export function useTasksPoll(intervalMs = 60_000) {
  const [payload, setPayload] = useState<TasksPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    fetch('/api/tasks')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setPayload(j))
      .catch(() => setPayload(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);
  return { payload, loading, reload: load };
}

/** 总览聚合卡与驾驶舱卡片共用的数据视图 */
export function TasksView({ compact = false }: { compact?: boolean }) {
  const { payload, loading, reload } = useTasksPoll();
  const [statusFilter, setStatusFilter] = useState<'all' | TaskEnvelope['status']>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'ygl-trees' | 'market'>('all');
  const tasks = payload?.tasks ?? [];
  const shown = useMemo(
    () => tasks.filter((t) => (statusFilter === 'all' || t.status === statusFilter) && (sourceFilter === 'all' || t.source === sourceFilter)),
    [tasks, statusFilter, sourceFilter],
  );
  if (loading && !payload) return <Card loading style={{ minHeight: 160 }} />;
  const ygl = payload?.sources?.['ygl-trees'];
  return (
    <div>
      {!compact && (
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented value={statusFilter} onChange={(v) => setStatusFilter(v as never)} options={[{ label: '全部', value: 'all' }, { label: '待办', value: 'todo' }, { label: '进行中', value: 'doing' }, { label: '已完成', value: 'done' }]} />
          <Segmented value={sourceFilter} onChange={(v) => setSourceFilter(v as never)} options={[{ label: '全部来源', value: 'all' }, { label: 'ygl-trees', value: 'ygl-trees' }, { label: 'market', value: 'market' }]} />
          <Button size="small" icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          {ygl && !ygl.ok && <Tag color="warning">ygl-trees 源降级（CLI 不可用）</Tag>}
        </Space>
      )}
      {shown.length === 0 ? (
        <Empty description={compact ? '暂无待办' : '没有符合条件的任务'} style={{ padding: compact ? 8 : 24 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 8 }}>
          {shown.slice(0, compact ? 8 : 200).map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: compact ? '4px 8px' : '8px 12px', border: '1px solid var(--ant-color-border-secondary, #eee)', borderRadius: 8, flexWrap: 'wrap' }}>
              <Tag color={t.source === 'market' ? 'geekblue' : 'cyan'}>{t.source}</Tag>
              <Typography.Text ellipsis style={{ maxWidth: 420, fontSize: compact ? 12 : 14 }}>{t.title}</Typography.Text>
              <Tag color={STATUS_COLOR[t.status]}>{STATUS_TEXT[t.status]}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 120 }}>{[t.project, t.due].filter(Boolean).join(' · ')}</Typography.Text>
              {t.link && <Button type="link" size="small" href={t.link} target="_blank">去处理</Button>}
            </div>
          ))}
        </div>
      )}
      {payload && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          生成于 {new Date(payload.generated_at).toLocaleString()} · ygl-trees {ygl?.ok ? `${ygl.count} 条/${ygl.latency_ms}ms` : '降级'} · market {payload.sources.market.count} 条
        </Typography.Text>
      )}
    </div>
  );
}

export default function Tasks() {
  return (
    <PageContainer title="统一待办" subTitle="三源任务聚合（只读）—— 勾销请回原系统" className="wm-page">
      <Card>
        <TasksView />
      </Card>
    </PageContainer>
  );
}
