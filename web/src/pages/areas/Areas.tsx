/** 领域（/areas，侧栏一级入口，照原型 #/domains；领域第 1 步只做列表）。
 *  原型：系统里只有两条边界，人和 AI 之间是任务，AI 和 AI 之间是领域；建、撤领域由属主定。
 *  这一页：领域列表（名字、标识、状态、负责人，含待放行的）；属主能「建一个领域」「指定负责人」「把部门迁成领域」。
 *  按钮照服务端给的 can 出（只有属主为真），页面不自己判角色。详情页（AI、在办、接入步骤、规范、授予）是第 4 步的事，这次不做。
 *  说法和整形在 web/src/areas-view.ts。 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, App, Button, Card, Empty, Input, Popconfirm, Result, Select, Skeleton, Space, Tag, Typography } from 'antd';
import { ApartmentOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons';
import WmPage from '../../components/WmPage';
import { approveAccessGrant, attentionChanged, createArea, draftAreaLead, getAccessPrincipals, getArea, getAreas, getAuthMe, migrateDepartmentsToAreas, submitAccessGrant } from '../../api';
import {
  PENDING_LEAD_HINT, STATUS_TEXT, STATUS_TONE, actionError, areaFormProblem, areasOf, emptyText, leadCandidates, leadLine, leadStepText, leadsOf, migrateResult, pageKind,
  type Area, type AreasCan, type Lead, type LeadStep,
} from '../../areas-view';

const LOGIN = `/login?next=${encodeURIComponent('/areas')}`;
const grantIdOf = (body: unknown): number | null => {
  const g = body && typeof body === 'object' ? (body as { grant?: { id?: unknown } }).grant : null;
  return g && typeof g.id === 'number' ? g.id : null;
};

/** 一个领域：名字、标识、状态、负责人；属主能指定负责人 */
function AreaCard({ a, leads, principals, me, can, onChanged }: { a: Area; leads: Lead[] | null; principals: unknown; me: string | null; can: AreasCan; onChanged: () => void }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = leadCandidates(principals, leads ?? [], me, can.assignLead);
  const assign = async () => {
    if (!who) return;
    const name = options.find((o) => o.id === who)?.name ?? '这位同事';
    setBusy(true); setErr(null);
    // 起草 → 提交 → 放行：属主一路放行到底；停在哪一步就照实说，剩下的到「谁能做什么」里接着办
    let stopped: LeadStep | null = 'draft', why = '';
    const d = await draftAreaLead(who, a.id);
    const id = d.status === 201 ? grantIdOf(d.body) : null;
    if (id === null) why = actionError(d.status, d.body);
    else {
      const s = await submitAccessGrant(id);
      if (s.status !== 200) { stopped = 'submit'; why = actionError(s.status, s.body); }
      else {
        const r = await approveAccessGrant(id);
        if (r.status !== 200) { stopped = 'approve'; why = actionError(r.status, r.body); } else stopped = null;
      }
    }
    setBusy(false);
    const text = leadStepText(stopped, name, why);
    if (stopped === null) { void message.success(text); setOpen(false); setWho(undefined); } else setErr(text);
    if (stopped !== 'draft') { attentionChanged(); onChanged(); }
  };
  return <Card size="small" className="wm-area-card" data-testid="area-card" data-area={a.id}>
    <div className="wm-area-head">
      <Typography.Text strong className="wm-text-subtitle">{a.name}</Typography.Text>
      <Typography.Text type="secondary" className="wm-caption wm-mono">{a.id}</Typography.Text>
      <Tag color={STATUS_TONE[a.status]} data-testid="area-status">{STATUS_TEXT[a.status]}</Tag>
      {a.fromDepartment && <Tag data-testid="area-from-dept">由部门迁来</Tag>}
    </div>
    <div className="wm-area-line" data-testid="area-leads">
      <Typography.Text type="secondary">负责人</Typography.Text>
      {leads === null ? <Skeleton.Input active size="small" /> : <span>{leadLine(leads)}</span>}
    </div>
    {a.status === 'pending-lead' && <Typography.Text type="warning" className="wm-caption" data-testid="area-pending-hint">{PENDING_LEAD_HINT}</Typography.Text>}
    {can.assignLead && a.status !== 'retired' && (open
      ? <Space wrap className="wm-area-assign">
          <Select size="small" showSearch optionFilterProp="label" placeholder="选一个人" value={who} onChange={setWho} options={options.map((o) => ({ value: o.id, label: o.name }))}
            notFoundContent="没有可选的人" className="wm-area-select" data-testid="area-lead-pick" />
          <Button size="small" type="primary" disabled={!who} loading={busy} onClick={() => void assign()} data-testid="area-lead-save">指定并放行</Button>
          <Button size="small" type="text" disabled={busy} onClick={() => { setOpen(false); setWho(undefined); setErr(null); }}>算了</Button>
        </Space>
      : <Button size="small" icon={<PlusOutlined />} onClick={() => setOpen(true)} data-testid="area-lead-open">指定负责人</Button>)}
    {err && <Alert type="warning" showIcon message={err} action={<Link to="/access">去谁能做什么</Link>} data-testid="area-lead-err" />}
  </Card>;
}

/** 建一个领域（属主）：名字、标识；建好是「等负责人」 */
function NewArea({ areas, onDone, onCancel }: { areas: Area[]; onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = areaFormProblem(id, name, areas);
  const submit = async () => {
    if (problem) return;
    setBusy(true); setErr(null);
    const r = await createArea(id.trim(), name.trim());
    setBusy(false);
    if (r.status === 201) onDone(name.trim()); else setErr(actionError(r.status, r.body));
  };
  return <Card size="small" title="建一个领域" data-testid="area-new">
    <Space direction="vertical" className="wm-w-full">
      <Space wrap>
        <Input placeholder="领域名字，比如 利润核算" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} data-testid="area-new-name" />
        <Input placeholder="标识，比如 fin（以后不能改）" value={id} onChange={(e) => setId(e.target.value)} maxLength={48} data-testid="area-new-id" />
      </Space>
      <Typography.Text type="secondary" className="wm-caption" data-testid="area-new-hint">{(name || id) && problem ? problem : '建好以后是「等负责人」：指定一位负责人并放行后才能在这个领域安排事、验收。'}</Typography.Text>
      <Space>
        <Button type="primary" disabled={!!problem} loading={busy} onClick={() => void submit()} data-testid="area-new-save">建领域</Button>
        <Button type="text" disabled={busy} onClick={onCancel}>算了</Button>
      </Space>
      {err && <Alert type="warning" showIcon message={err} data-testid="area-new-err" />}
    </Space>
  </Card>;
}

export default function Areas() {
  const { message } = App.useApp();
  const [kind, setKind] = useState<ReturnType<typeof pageKind> | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [can, setCan] = useState<AreasCan>({ create: false, migrate: false, assignLead: false });
  const [leads, setLeads] = useState<Record<string, Lead[]>>({});
  const [principals, setPrincipals] = useState<unknown>(null);
  const [me, setMe] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrated, setMigrated] = useState<ReturnType<typeof migrateResult> | null>(null);
  const [migrateErr, setMigrateErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getAreas();
    const k = pageKind(r.status);
    setKind(k);
    if (k.kind !== 'ok') return;
    const v = areasOf(r.body);
    setAreas(v.areas); setCan(v.can);
    // 负责人看单条：一个领域一次读（第 1 步领域不多）
    const each = await Promise.all(v.areas.map(async (a) => [a.id, leadsOf((await getArea(a.id)).body)] as const));
    setLeads(Object.fromEntries(each));
    if (v.can.assignLead) {
      const [p, m] = await Promise.all([getAccessPrincipals(), getAuthMe()]);
      setPrincipals(p.body); setMe(typeof m?.principal === 'string' ? m.principal : null);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const migrate = async () => {
    setMigrating(true); setMigrateErr(null);
    const r = await migrateDepartmentsToAreas();
    setMigrating(false);
    if (r.status !== 200) { setMigrateErr(actionError(r.status, r.body)); return; }
    setMigrated(migrateResult(r.body));
    attentionChanged();
    void load();
  };

  const intro = <Typography.Paragraph type="secondary" data-testid="areas-intro">
    系统里只有两条边界：人和 AI 之间是任务，AI 和 AI 之间是领域。一个领域是一类业务；每个领域至少有一位负责人，人按领域被授予。建、撤领域由属主定。
  </Typography.Paragraph>;

  if (!kind) return <WmPage>{intro}<Card><Skeleton active paragraph={{ rows: 4 }} /></Card></WmPage>;
  if (kind.kind === 'login') return <WmPage>{intro}<div data-testid="areas-login"><Result status="info" title="请先登录" subTitle="登录后看领域。" extra={<Button type="primary" href={LOGIN}>去登录</Button>} /></div></WmPage>;
  if (kind.kind === 'forbidden') return <WmPage>{intro}<div data-testid="areas-forbidden"><Result status="403" title={kind.text} /></div></WmPage>;
  if (kind.kind === 'error') return <WmPage>{intro}<Alert type="error" showIcon message={kind.text} action={<Button size="small" onClick={() => void load()}>再试一次</Button>} data-testid="areas-error" /></WmPage>;

  const tools = (can.create || can.migrate) && <Space wrap data-testid="areas-tools">
    {can.create && !creating && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)} data-testid="area-new-open">建一个领域</Button>}
    {can.migrate && <Popconfirm title="把部门迁成领域？" description="每个部门建一个同标识、同名字的领域；部门有负责人的，替他起草一条领域负责人授予，等你放行。跑几次结果都一样，旧部门原样留着。"
      okText="迁移" cancelText="再想想" onConfirm={() => void migrate()}>
      <Button icon={<SwapOutlined />} loading={migrating} data-testid="areas-migrate">把部门迁成领域</Button>
    </Popconfirm>}
  </Space>;

  return <WmPage>
    {intro}
    <Space direction="vertical" size="middle" className="wm-w-full">
      {tools}
      {migrated && <Alert type="success" showIcon closable onClose={() => setMigrated(null)} data-testid="areas-migrated"
        message={migrated.summary}
        description={<Space direction="vertical" size={2}>
          {migrated.drafted > 0 && <Link to="/access" data-testid="areas-migrated-approve">去「谁能做什么」放行这 {migrated.drafted} 条 →</Link>}
          {migrated.skipped.map((s, i) => <Typography.Text key={i} type="secondary" className="wm-caption">{s}</Typography.Text>)}
        </Space>} />}
      {migrateErr && <Alert type="warning" showIcon closable onClose={() => setMigrateErr(null)} message={`没迁成：${migrateErr}`} data-testid="areas-migrate-err" />}
      {creating && <NewArea areas={areas} onCancel={() => setCreating(false)} onDone={(name) => { setCreating(false); void message.success(`领域「${name}」建好了，接着给它指定一位负责人`); void load(); }} />}
      {areas.length === 0
        ? <Empty image={<ApartmentOutlined className="wm-areas-empty-icon" />} data-testid="areas-empty"
            description={emptyText(can)} />
        : <div className="wm-areas-grid" data-testid="areas-list">
            {areas.map((a) => <AreaCard key={a.id} a={a} leads={leads[a.id] ?? null} principals={principals} me={me} can={can} onChanged={() => void load()} />)}
          </div>}
    </Space>
  </WmPage>;
}
