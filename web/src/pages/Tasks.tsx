import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Drawer, Empty, Form, Input, Radio, Segmented, Select, Space, Tag, Tooltip, Typography, Upload, App as AntApp } from 'antd';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { PlusOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { apiFetch } from '../admin-token';
import { ReloadOutlined } from '@ant-design/icons';
import { odooLoginHref } from './lifecycle-view';
import { useOdooPopupLogin } from './odoo-login';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';

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
interface SourceMeta { ok: boolean; count: number; latency_ms: number; degraded_projects?: string[] }
interface TasksPayload {
  tasks: TaskEnvelope[];
  /** lifecycle 仅在服务端配置了生命周期源时出现，按当前 Odoo 登录人计 */
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta; a2a?: SourceMeta; lifecycle?: SourceMeta & { viewer: string | null; error?: string; auth_required?: boolean; login_url?: string | null } };
  generated_at: string;
}
const SOURCE_COLOR: Record<TaskEnvelope['source'], string> = { market: 'geekblue', 'ygl-trees': 'cyan', a2a: 'gold', lifecycle: 'purple' };
const SOURCE_TEXT: Record<TaskEnvelope['source'], string> = { market: 'market', 'ygl-trees': 'ygl-trees', a2a: 'a2a', lifecycle: '生命周期' };

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

/** 列序按 PATTERNS.md §5：状态 → 标题 → 来源/项目 → 截止 → 操作；来源用 tag 标出，不靠颜色区分 */
const taskColumns: ProColumns<TaskEnvelope>[] = [
  { title: '状态', dataIndex: 'status', width: 90, fixed: 'left', render: (_, t) => <Tag color={STATUS_COLOR[t.status]}>{STATUS_TEXT[t.status]}</Tag> },
  {
    title: '标题', dataIndex: 'title', ellipsis: true,
    render: (_, t) => (
      <Space size={6} wrap={false}>
        {t.link ? <Typography.Link href={t.link} target="_blank">{t.title}</Typography.Link> : <Typography.Text>{t.title}</Typography.Text>}
        {t.source === 'market' && t.id.startsWith('market:task-') && <Tag color="blue">任务中心</Tag>}
      </Space>
    ),
  },
  { title: '来源', dataIndex: 'source', width: 110, render: (_, t) => <Tag color={SOURCE_COLOR[t.source] ?? 'default'}>{SOURCE_TEXT[t.source] ?? t.source}</Tag> },
  { title: '项目', dataIndex: 'project', width: 160, ellipsis: true, render: (_, t) => t.project || <Typography.Text type="secondary">-</Typography.Text> },
  { title: '截止', dataIndex: 'due', width: 120, render: (_, t) => (t.due ? <RelTime value={t.due} /> : <Typography.Text type="secondary">-</Typography.Text>) },
  {
    title: '操作', valueType: 'option', width: 110, fixed: 'right',
    render: (_, t) => [
      t.link ? <Button key="go" type="link" size="small" href={t.link} target="_blank">去处理</Button> : null,
      t.lc ? <Tooltip key="lc" title="同源门户/SOP 隔离未完成，工作台审批已停用"><span role="note">仅查看</span></Tooltip> : null,
    ],
  },
];

/** 总览聚合卡与驾驶舱卡片共用的数据视图 */
export function TasksView({ compact = false }: { compact?: boolean }) {
  const { payload, loading, reload } = useTasksPoll();
  const [statusFilter, setStatusFilter] = useState<'all' | TaskEnvelope['status']>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | TaskEnvelope['source']>('all');
  const [q, setQ] = useState('');
  const tasks = payload?.tasks ?? [];
  const shown = useMemo(
    () => tasks.filter((t) => (statusFilter === 'all' || t.status === statusFilter) && (sourceFilter === 'all' || t.source === sourceFilter)
      && (!q || `${t.title} ${t.project ?? ''} ${t.id}`.toLowerCase().includes(q.toLowerCase()))),
    [tasks, statusFilter, sourceFilter, q],
  );
  const ygl = payload?.sources?.['ygl-trees'];
  const life = payload?.sources?.lifecycle;
  // 生命周期源未登录：弹窗登录 Odoo，登录完成刷新待办（整页跳去 Odoo 会回不来，#275）；紧凑卡片不显示按钮，也不挂登录逻辑
  const loginHref = !compact && life && !life.ok && life.auth_required && life.login_url ? odooLoginHref(life.login_url) : null;
  const login = useOdooPopupLogin(loginHref, reload);
  if (loading && !payload) return <Card loading style={{ minHeight: 160 }} />;
  return (
    <div>
      {!compact && (
        <Space wrap className="wm-mb-3">
          <Input.Search allowClear placeholder="搜索标题 / 项目" style={{ width: 220 }} onSearch={setQ} />
          <Segmented value={statusFilter} onChange={(v) => setStatusFilter(v as never)} options={[{ label: '全部', value: 'all' }, { label: '待办', value: 'todo' }, { label: '进行中', value: 'doing' }, { label: '已完成', value: 'done' }]} />
          <Segmented value={sourceFilter} onChange={(v) => setSourceFilter(v as never)} options={[{ label: '全部来源', value: 'all' }, { label: 'ygl-trees', value: 'ygl-trees' }, { label: 'market', value: 'market' }, ...(life ? [{ label: '生命周期', value: 'lifecycle' }] : [])]} />
          <Button size="small" icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          {ygl && !ygl.ok && <Tag color="warning">ygl-trees 源降级（CLI 不可用）</Tag>}
          {life && !life.ok && <Tag color="warning">生命周期源：{life.error ?? '不可用'}</Tag>}
          {loginHref && !login.tokenHere && <Button size="small" type="link" onClick={login.open} disabled={login.polling}>{login.polling ? '等待 Odoo 登录完成…' : '在弹窗登录 Odoo 查看生命周期待办'}</Button>}
          {loginHref && login.tokenHere && <Button size="small" type="link" onClick={login.clearAndOpen} title="本标签页存着管理员口令，登录弹窗会复制它">清除管理员口令并登录 Odoo</Button>}
          {loginHref && login.blocked && <Tag color="warning">浏览器拦截了登录弹窗，请允许弹窗后再点</Tag>}
          {life?.ok && life.viewer && <Tag color="purple">以 {life.viewer} 查看（只读）</Tag>}
        </Space>
      )}
      {compact ? (
        shown.length === 0 ? <Empty description="暂无待办" style={{ padding: 8 }} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {shown.slice(0, 8).map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', border: '1px solid var(--wm-color-border)', borderRadius: 8, flexWrap: 'wrap' }}>
                <Tag color={STATUS_COLOR[t.status]}>{STATUS_TEXT[t.status]}</Tag>
                <Typography.Text ellipsis className="wm-caption" style={{ maxWidth: 420 }}>{t.title}</Typography.Text>
                <Tag color={SOURCE_COLOR[t.source] ?? 'default'}>{SOURCE_TEXT[t.source] ?? t.source}</Tag>
                {t.link && <Button type="link" size="small" href={t.link} target="_blank">去处理</Button>}
              </div>
            ))}
          </div>
        )
      ) : (
        <ProTable<TaskEnvelope>
          className="wm-tasks-table"
          rowKey="id"
          size="middle"
          columns={taskColumns}
          dataSource={shown}
          search={false}
          options={false}
          toolBarRender={false}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => `共 ${n} 条` }}
          locale={{ emptyText: <Empty description="没有符合条件的任务——换个筛选，或点右上角「发布任务」" /> }}
        />
      )}
      {payload && (
        <Typography.Text type="secondary" className="wm-caption" style={{ display: 'block', marginTop: 8 }}>
          生成于 {new Date(payload.generated_at).toLocaleString()} · ygl-trees {ygl?.ok ? `${ygl.count} 条/${ygl.latency_ms}ms` : '部分降级'} · market {payload.sources.market.count} 条{life ? ` · 生命周期 ${life.ok ? `${life.count} 条` : '降级'}` : ''}
        {ygl && !ygl.ok && ygl.degraded_projects?.length ? (
          <Typography.Text type="warning" className="wm-caption wm-mt-1" style={{ display: 'block' }}>
            ygl-trees 未完整读取（{ygl.count} 条已入列）：{ygl.degraded_projects.map((d, i) => (
              <Tag key={i} color="warning" className="wm-caption">{d}</Tag>
            ))}
          </Typography.Text>
        ) : null}
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
  const [entry, setEntry] = useState<'intake' | 'legacy'>('intake');
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
      // #263 页面整链：统一入口走 task-center 人工录入→发布链（模板六步），不再直开业务 SOP run
      if (entry === 'intake') {
        const r0 = await fetch('/api/sop/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'task-center', started_by: `expert:${v.expert || 'me'}` }) });
        const run = await r0.json();
        if (!r0.ok) throw new Error(run?.error ?? '创建录入失败');
        const steps: Array<[string, unknown]> = [['title', { value: v.title }], ['intent', { value: v.desc || v.title }], ['references', { value: v.refs || '' }], ['deliverable', { value: v.deliverable || '按描述交付' }], ['target', { value: v.slug }], ['due', { value: v.due || '' }]];
        for (const [k, val] of steps) {
          const rs = await fetch(`/api/sop/runs/${run.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepKey: k, value: val }) });
          if (!rs.ok) { const j = await rs.json().catch(() => ({})); throw new Error(j?.error ?? `步骤 ${k} 保存失败`); }
        }
        for (const f of files) {
          if (!f.originFileObj) continue;
          const fd = new FormData();
          fd.append('file', f.originFileObj);
          fd.append('created_by', v.expert || 'expert');
          const rf = await fetch(`/api/sop/runs/${run.id}/files`, { method: 'POST', body: fd });
          if (!rf.ok) { const j = await rf.json().catch(() => ({})); throw new Error(j?.error ?? `附件 ${f.name} 上传失败`); }
        }
        const rf2 = await fetch(`/api/sop/runs/${run.id}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (!rf2.ok) { const j = await rf2.json().catch(() => ({})); throw new Error(j?.error ?? '完成录入失败'); }
        const rp = await apiFetch('/api/task-center/tasks', { method: 'POST', headers: { Origin: window.location.origin }, body: JSON.stringify({ intake_run_id: run.id, published_by: v.expert || 'me' }) });
        const pj = await rp.json().catch(() => ({}));
        if (!rp.ok) throw new Error(pj?.error ?? '发布失败（管理员口令缺失或无效；录入已完成，可稍后在任务中心发布）');
        message.success(`任务已发布（task #${pj.id}，录入 run #${run.id}）`);
        form.resetFields(); setFiles([]);
        onDone(); onClose();
        return;
      }
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
        <Form.Item label="发布方式">
          <Radio.Group value={entry} onChange={(e) => setEntry(e.target.value)}>
            <Radio value="intake">统一任务（任务中心录入→发布，入统一待办）</Radio>
            <Radio value="legacy">直接开 SOP run（旧链·需手动指派才入待验收）</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="slug" label={entry === 'intake' ? '目标 SOP 台（记录在任务里，不直接开 run）' : '挂靠 SOP 台（执行面）'} rules={[{ required: true, message: '选择一个已上架 SOP' }]}>
          <Select placeholder="选择已上架 SOP" options={sops.map((x) => ({ value: x.slug, label: `${x.title} (${x.slug})` }))} showSearch />
        </Form.Item>
        <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '填写标题' }]}>
          <Input placeholder="如：核对十月物流对账差异" maxLength={80} />
        </Form.Item>
        {entry === 'intake' && (
          <>
            <Form.Item name="deliverable" label="提交物要求"><Input placeholder="如：对账差异报告" maxLength={200} /></Form.Item>
            <Form.Item name="refs" label="基准材料（可选）"><Input placeholder="材料名或链接" maxLength={200} /></Form.Item>
            <Form.Item name="due" label="截止日期（可选）"><Input placeholder="如 2026-11-05" maxLength={40} /></Form.Item>
          </>
        )}
        <Form.Item name="desc" label="业务描述（一段话）">
          <Input.TextArea rows={3} placeholder="要做什么、验收标准、注意事项" maxLength={2000} />
        </Form.Item>
        {entry === 'legacy' && (
        <Form.Item label="指派">
          <Radio.Group value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <Radio value="agent">指派绑定 agent</Radio>
            <Radio value="self">我自己做</Radio>
            <Radio value="none">暂不指派</Radio>
          </Radio.Group>
        </Form.Item>
        )}
        {entry === 'legacy' && assignee === 'agent' && (
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
    <WmPage
      subTitle="多源任务聚合 —— 生命周期当前仅供查看，工作台审批已停用；其余勾销请回原系统"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>发布任务</Button>}
    >
      <Card>
        <TasksView key={bump} />
      </Card>
      <DispatchDrawer open={open} onClose={() => setOpen(false)} onDone={() => setBump((n) => n + 1)} />
    </WmPage>
  );
}
