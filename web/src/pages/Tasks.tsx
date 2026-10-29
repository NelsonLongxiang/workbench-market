import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Drawer, Empty, Form, Input, Radio, Segmented, Select, Space, Tag, Typography, Upload, App as AntApp } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { PageContainer } from '@ant-design/pro-components';
import { ReloadOutlined } from '@ant-design/icons';

/** 任务信封（与 server/src/tasks.ts 契约一致，字段冻结 snake_case） */
export interface TaskEnvelope {
  id: string;
  source: 'ygl-trees' | 'market' | 'a2a' | 'lifecycle';
  title: string;
  status: 'todo' | 'doing' | 'done';
  due: string | null;
  link: string | null;
  project: string | null;
  /** 仅 lifecycle 源：批准所需的提议与授权 */
  lc?: { proposal_id: string; grant: string; object: string; machine: string; from: string; to: string; effective_at: string | null; proposed_by: string; approvals: number; levels: number };
}
interface SourceMeta { ok: boolean; count: number; latency_ms: number }
interface TasksPayload {
  tasks: TaskEnvelope[];
  /** lifecycle 仅在服务端配置了生命周期源时出现，按当前 Odoo 登录人计 */
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta; a2a?: SourceMeta; lifecycle?: SourceMeta & { viewer: string | null; error?: string } };
  generated_at: string;
}
const SOURCE_COLOR: Record<TaskEnvelope['source'], string> = { market: 'geekblue', 'ygl-trees': 'cyan', a2a: 'gold', lifecycle: 'purple' };

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
  const [sourceFilter, setSourceFilter] = useState<'all' | TaskEnvelope['source']>('all');
  const tasks = payload?.tasks ?? [];
  const shown = useMemo(
    () => tasks.filter((t) => (statusFilter === 'all' || t.status === statusFilter) && (sourceFilter === 'all' || t.source === sourceFilter)),
    [tasks, statusFilter, sourceFilter],
  );
  if (loading && !payload) return <Card loading style={{ minHeight: 160 }} />;
  const ygl = payload?.sources?.['ygl-trees'];
  const life = payload?.sources?.lifecycle;
  return (
    <div>
      {!compact && (
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented value={statusFilter} onChange={(v) => setStatusFilter(v as never)} options={[{ label: '全部', value: 'all' }, { label: '待办', value: 'todo' }, { label: '进行中', value: 'doing' }, { label: '已完成', value: 'done' }]} />
          <Segmented value={sourceFilter} onChange={(v) => setSourceFilter(v as never)} options={[{ label: '全部来源', value: 'all' }, { label: 'ygl-trees', value: 'ygl-trees' }, { label: 'market', value: 'market' }, ...(life ? [{ label: '生命周期', value: 'lifecycle' }] : [])]} />
          <Button size="small" icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          {ygl && !ygl.ok && <Tag color="warning">ygl-trees 源降级（CLI 不可用）</Tag>}
          {life && !life.ok && <Tag color="warning">生命周期源：{life.error ?? '不可用'}</Tag>}
          {life?.ok && life.viewer && <Tag color="purple">以 {life.viewer} 查看（只读）</Tag>}
        </Space>
      )}
      {shown.length === 0 ? (
        <Empty description={compact ? '暂无待办' : '没有符合条件的任务'} style={{ padding: compact ? 8 : 24 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 4 : 8 }}>
          {shown.slice(0, compact ? 8 : 200).map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: compact ? '4px 8px' : '8px 12px', border: '1px solid var(--ant-color-border-secondary, #eee)', borderRadius: 8, flexWrap: 'wrap' }}>
              <Tag color={SOURCE_COLOR[t.source] ?? 'default'}>{t.source}</Tag>
              <Typography.Text ellipsis style={{ maxWidth: 420, fontSize: compact ? 12 : 14 }}>{t.title}</Typography.Text>
              <Tag color={STATUS_COLOR[t.status]}>{STATUS_TEXT[t.status]}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 120 }}>{[t.project, t.due].filter(Boolean).join(' · ')}</Typography.Text>
              {t.source === 'market' && t.id.startsWith('market:task-') && <Tag color="blue">任务中心</Tag>}
              {t.link && <Button type="link" size="small" href={t.link} target="_blank">去处理</Button>}
              {t.lc && <span role="note">仅查看：同源门户/SOP隔离未完成，工作台审批已停用。</span>}
            </div>
          ))}
        </div>
      )}
      {payload && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          生成于 {new Date(payload.generated_at).toLocaleString()} · ygl-trees {ygl?.ok ? `${ygl.count} 条/${ygl.latency_ms}ms` : '降级'} · market {payload.sources.market.count} 条{life ? ` · 生命周期 ${life.ok ? `${life.count} 条` : '降级'}` : ''}
        </Typography.Text>
      )}
    </div>
  );
}

/** 19a 任务发布面（direct-58d60ed6）：业务专家发布任务——零新后端概念，纯既有通道组合：
 *  POST /api/sop/runs（开 run）→ PUT stepSave(_brief/_desc) → [指派] POST assign → 附件 POST files */
function DispatchDrawer({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [sops, setSops] = useState<{ slug: string; title: string }[]>([]);
  const [assignee, setAssignee] = useState<'agent' | 'self' | 'none'>('agent');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!open) return;
    fetch('/api/sops').then((r) => (r.ok ? r.json() : [])).then((rows) => setSops((rows ?? []).map((x: never) => x))).catch(() => setSops([]));
  }, [open]);
  const submit = async () => {
    const v = await form.validateFields();
    setSubmitting(true);
    try {
      const r1 = await fetch('/api/sop/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: v.slug, started_by: assignee === 'agent' ? v.node : `expert:${v.expert || 'me'}` }) });
      const run = await r1.json();
      if (!r1.ok) throw new Error(run?.error ?? '创建失败');
      await fetch(`/api/sop/runs/${run.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepKey: '_brief', value: v.title }) });
      if (v.desc) await fetch(`/api/sop/runs/${run.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepKey: '_desc', value: v.desc }) });
      if (assignee === 'agent') {
        const ra = await fetch(`/api/sop/runs/${run.id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node: v.node }) });
        if (!ra.ok) { const j = await ra.json().catch(() => ({})); throw new Error(j?.error ?? '指派失败'); }
      }
      for (const f of files) {
        if (!f.originFileObj) continue;
        const fd = new FormData();
        fd.append('file', f.originFileObj);
        fd.append('created_by', v.expert || 'expert');
        const rf = await fetch(`/api/sop/runs/${run.id}/files`, { method: 'POST', body: fd });
        if (!rf.ok) { const j = await rf.json().catch(() => ({})); throw new Error(j?.error ?? `附件 ${f.name} 上传失败`); }
      }
      message.success(`任务已发布（run #${run.id}）${assignee === 'agent' ? '，已指派并进入待验收' : ''}`);
      form.resetFields(); setFiles([]);
      onDone(); onClose();
    } catch (e) {
      message.error(`发布失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Drawer title="发布任务" open={open} onClose={onClose} size="large" destroyOnHidden styles={{ wrapper: { width: 520 } }}>
      <Form form={form} layout="vertical">
        <Form.Item name="slug" label="挂靠 SOP 台（执行面）" rules={[{ required: true, message: '选择一个已上架 SOP' }]}>
          <Select placeholder="选择已上架 SOP" options={sops.map((x) => ({ value: x.slug, label: `${x.title} (${x.slug})` }))} showSearch />
        </Form.Item>
        <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '填写标题' }]}>
          <Input placeholder="如：核对十月物流对账差异" maxLength={80} />
        </Form.Item>
        <Form.Item name="desc" label="业务描述（一段话）">
          <Input.TextArea rows={3} placeholder="要做什么、验收标准、注意事项" maxLength={2000} />
        </Form.Item>
        <Form.Item label="指派">
          <Radio.Group value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <Radio value="agent">指派绑定 agent</Radio>
            <Radio value="self">我自己做</Radio>
            <Radio value="none">暂不指派</Radio>
          </Radio.Group>
        </Form.Item>
        {assignee === 'agent' && (
          <Form.Item name="node" label="agent 节点（dsh/<id8>，须已绑定该 SOP）" rules={[{ required: true, message: '填写节点' }]}>
            <Input placeholder="dsh/6de4035c" />
          </Form.Item>
        )}
        <Form.Item name="expert" label="发布人（可选）">
          <Input placeholder="业务专家姓名/工号" maxLength={40} />
        </Form.Item>
        <Form.Item label="附件（≤50MB/个，走交付物通道）">
          <Upload.Dragger multiple beforeUpload={() => false} fileList={files} onChange={({ fileList }) => setFiles(fileList)}>
            <Typography.Text type="secondary">点击或拖入附件</Typography.Text>
          </Upload.Dragger>
        </Form.Item>
        <Space>
          <Button type="primary" loading={submitting} onClick={submit}>发布</Button>
          <Button onClick={onClose}>取消</Button>
        </Space>
      </Form>
    </Drawer>
  );
}

export default function Tasks() {
  const [open, setOpen] = useState(false);
  const [bump, setBump] = useState(0);
  return (
    <PageContainer
      title="统一待办"
      subTitle="多源任务聚合 —— 生命周期当前仅供查看，工作台审批已停用；其余勾销请回原系统"
      className="wm-page"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>发布任务</Button>}
    >
      <Card>
        <TasksView key={bump} />
      </Card>
      <DispatchDrawer open={open} onClose={() => setOpen(false)} onDone={() => setBump((n) => n + 1)} />
    </PageContainer>
  );
}
