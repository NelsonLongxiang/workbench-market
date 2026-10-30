import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Empty, Result, Row, Segmented, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Link, useLocation } from 'react-router-dom';
import { fmt, ledgerBadge, odooLoginHref, type BoardLedger } from './lifecycle-view';

/** lc board 的 data（lifecycle-os plugins/ygl-lc cmdBoard）：事实由内核算好，本页只显示，不重算状态、归属、超时或过期 */
interface Since { state: string; since: string | null; days: number | null }
type Observed = Record<string, { value: unknown; source: string; at: string | null }>;
interface BoardObject { object: string; machine: string; lane: string | null; state: string; since: string | null; days: number | null; observed?: Observed }
interface BoardProduct { pd: string; states: Record<string, Since>; observed?: Observed; objects: BoardObject[]; pending: string[] }
interface BoardPending {
  proposal_id: string; object: string; machine: string; lane: string | null; pds: string[]; from: string; to: string;
  effective_at: string | null; proposed_by: string; proposed_at: string | null; waiting_days: number | null;
  release_by: '人工' | '规则' | string; approvals: number; levels: number; domain: string | null; missing: string[];
}
interface BoardLink { link: string; type: string; from: string; to: string; method: string; confidence: string; pds: string[]; since: string | null; days: number | null }
interface BoardPeriod { period: string; state: string; since: string | null; days: number | null; obligations: { source: string; due: string | null; recoverable: boolean; met: boolean; ok_at: string | null }[] }
interface BoardAlert { alert: string; level: string; route: string; state: string; raised_at: string | null; deadline: string | null; overdue: boolean }
interface BoardJob { job: string; runs: number; last_at: string | null; last_status: string | null; last_ok_at: string | null }
interface BoardSource { source: string; level: string; owner: string; max_age: string; last_ok_at: string | null; stale: boolean | null }
interface BoardData {
  as_of: string;
  ledger: BoardLedger;
  lanes: Record<string, string>;
  summary: { products: number; by_stage: Record<string, number>; on_hold: number; pending_human: number; gate_blocked: number; links_unconfirmed: number; unattached: number; alerts_open: number; alerts_overdue: number; sources_stale: number };
  products: BoardProduct[];
  unattached: BoardObject[];
  pending: BoardPending[];
  links_unconfirmed: BoardLink[];
  periods: BoardPeriod[];
  alerts: BoardAlert[];
  incidents: Record<string, unknown>[];
  jobs: BoardJob[];
  sources: BoardSource[];
}
interface BoardPayload { ok: boolean; busy?: boolean; login_url?: string | null; anchor_ledger?: string | null; error?: string; data?: BoardData; next?: string[]; warnings?: string[]; viewer?: string; cached?: boolean; generated_at?: string }

const LANES = ['产品', '采购', '物流', '运营'] as const;
const LANE_COLOR: Record<string, string> = { 产品: 'purple', 采购: 'blue', 物流: 'cyan', 运营: 'gold' };
const daysText = (d: number | null | undefined) => (d === null || d === undefined ? '' : `${d} 天`);
const PdTags = ({ pds }: { pds: string[] }) => <>{pds.length ? pds.map((p) => <Tag key={p}>{p}</Tag>) : <Tag color="warning">归属不明</Tag>}</>;

/** ?as_of= 原样转给服务端（看某一时点的全景；格式由服务端按严格 ISO 校验） */
function useBoard(asOf: string | null) {
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState(0);
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    fetch(`/api/lifecycle/board${asOf ? `?as_of=${encodeURIComponent(asOf)}` : ''}`, { credentials: 'same-origin' })
      .then(async (r) => { setStatus(r.status); setPayload(await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))); })
      .catch((e) => { setStatus(0); setPayload({ ok: false, error: String(e?.message ?? e) }); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [asOf]); // eslint-disable-line react-hooks/exhaustive-deps
  return { payload, status, loading, reload: load };
}

function LedgerBadge({ l, ledger }: { l: BoardLedger; ledger: string | null }) {
  const b = ledgerBadge(l, ledger);
  return <Tooltip title={b.tip}><Tag color={b.color}>{b.text}</Tag></Tooltip>;
}

function PendingRow({ p }: { p: BoardPending }) {
  return (
    <div className="wm-lc-row">
      <Space wrap size={4}>
        {p.lane ? <Tag color={LANE_COLOR[p.lane]}>{p.lane}</Tag> : <Tag>无泳道</Tag>}
        <Typography.Text strong>{p.machine}</Typography.Text>
        <Typography.Text code>{p.object}</Typography.Text>
        <span>{p.from} → {p.to}</span>
        <PdTags pds={p.pds} />
      </Space>
      <Space wrap size={4} style={{ marginTop: 4 }}>
        {p.release_by === '人工'
          ? <><Tag color="processing">已批 {p.approvals}/{p.levels} 级</Tag>{p.domain && <Tag>授权域 {p.domain}</Tag>}</>
          : <Tag color="orange">规则放行</Tag>}
        {p.waiting_days !== null && <Tag>等了 {p.waiting_days} 天</Tag>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>提议 {p.proposed_by} · 生效 {fmt(p.effective_at)}</Typography.Text>
        {p.release_by === '人工' && <Link to="/tasks">去统一待办查看</Link>}
      </Space>
      {p.missing.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>未满足：</Typography.Text>
          {p.missing.map((m) => <Tag key={m} color="red" style={{ fontSize: 12 }}>{m}</Tag>)}
        </div>
      )}
    </div>
  );
}

function LinkRow({ l }: { l: BoardLink }) {
  return (
    <div className="wm-lc-row">
      <Space wrap size={4}>
        <Typography.Text strong>{l.type}</Typography.Text>
        <Typography.Text code>{l.from}</Typography.Text>→<Typography.Text code>{l.to}</Typography.Text>
        <Tag>{l.method}</Tag><Tag color={l.confidence === '低' ? 'red' : l.confidence === '中' ? 'orange' : 'green'}>置信 {l.confidence}</Tag>
        {l.days !== null && <Tag>{l.days} 天</Tag>}
        <PdTags pds={l.pds} />
      </Space>
    </div>
  );
}

function ObservedText({ o }: { o?: Observed }) {
  const e = Object.entries(o ?? {});
  if (!e.length) return null;
  return <Typography.Text type="secondary" style={{ fontSize: 12 }}>观测：{e.map(([k, v]) => `${k}=${String(v.value)}（${v.source} @ ${fmt(v.at)}）`).join('；')}</Typography.Text>;
}

function ProductCard({ p, d }: { p: BoardProduct; d: BoardData }) {
  const stage = p.states.product_stage;
  const pend = d.pending.filter((x) => p.pending.includes(x.proposal_id));
  // 关系确认提议本身也在 pending 里（object = link id），这里只补没有提议的未确认关系，避免同一卡点算两次
  const links = d.links_unconfirmed.filter((l) => l.pds.includes(p.pd) && !pend.some((x) => x.object === l.link));
  const others = Object.entries(p.states).filter(([k]) => k !== 'product_stage');
  return (
    <Card size="small" className="wm-lc-product" title={<Space size={6}><span>{p.pd}</span>{stage && <Tag color="purple">{stage.state}{stage.days !== null ? ` · ${stage.days} 天` : ''}</Tag>}</Space>}
      extra={pend.length + links.length > 0 ? <Badge count={pend.length + links.length} title="卡点" /> : null}>
      <Space wrap size={4} style={{ marginBottom: 8 }}>
        {others.map(([k, s]) => <Tag key={k}>{k}：{s.state}{s.days !== null ? ` · ${s.days} 天` : ''}</Tag>)}
      </Space>
      <ObservedText o={p.observed} />
      <div className="wm-lc-lanes">
        {LANES.map((lane) => {
          const objs = p.objects.filter((o) => o.lane === lane);
          return (
            <div key={lane} className="wm-lc-lane">
              <Tag color={LANE_COLOR[lane]} style={{ marginBottom: 4 }}>{lane}</Tag>
              {objs.length === 0 ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text> : objs.map((o) => (
                <div key={o.object} style={{ fontSize: 12 }}>{o.machine} <b>{o.state}</b> <Typography.Text type="secondary">{daysText(o.days)}</Typography.Text></div>
              ))}
            </div>
          );
        })}
      </div>
      <Collapse size="small" ghost items={[{ key: 'd', label: `明细（${p.objects.length} 个对象 · ${pend.length + links.length} 条卡点）`, children: (
        <>
          <Table size="small" pagination={false} rowKey="object" dataSource={p.objects} scroll={{ x: 'max-content' }} style={{ marginBottom: 8 }} locale={{ emptyText: '没有挂在本产品下的对象' }} columns={[
            { title: '对象', dataIndex: 'object' }, { title: '状态机', dataIndex: 'machine' }, { title: '泳道', dataIndex: 'lane' },
            { title: '状态', dataIndex: 'state' }, { title: '起始', dataIndex: 'since', render: fmt }, { title: '停留', dataIndex: 'days', render: daysText },
            ...(p.objects.some((o) => Object.keys(o.observed ?? {}).length) ? [{ title: '观测', dataIndex: 'observed', render: (o: Observed) => <ObservedText o={o} /> }] : []),
          ]} />
          {pend.map((x) => <PendingRow key={x.proposal_id} p={x} />)}
          {links.map((l) => <LinkRow key={l.link} l={l} />)}
        </>
      ) }]} />
    </Card>
  );
}

function BoardView({ payload, reload }: { payload: BoardPayload; reload: () => void }) {
  const d = payload.data!;
  const [lane, setLane] = useState<string>('all');
  const laneOk = (l: string | null) => lane === 'all' || (lane === 'none' ? !l : l === lane);
  const human = useMemo(() => d.pending.filter((p) => p.release_by === '人工' && laneOk(p.lane)), [d, lane]); // eslint-disable-line react-hooks/exhaustive-deps
  const gate = useMemo(() => d.pending.filter((p) => p.release_by !== '人工' && laneOk(p.lane)), [d, lane]); // eslint-disable-line react-hooks/exhaustive-deps
  const overdue = d.alerts.filter((a) => a.overdue);
  const stale = d.sources.filter((s) => s.stale === true);
  const s = d.summary;
  const kpis: [string, number][] = [['产品', s.products], ['暂停', s.on_hold], ['人工待审', s.pending_human], ['规则门禁未过', s.gate_blocked], ['未确认关系', s.links_unconfirmed], ['归属不明', s.unattached], ['未结告警', s.alerts_open], ['超时告警', s.alerts_overdue], ['过期数据源', s.sources_stale]];
  return (
    <>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <span>数据截至 <b>{fmt(d.as_of)}</b></span>
          <LedgerBadge l={d.ledger} ledger={payload.anchor_ledger ?? null} />
          <Tag color={s.sources_stale ? 'warning' : 'success'}>过期数据源 {s.sources_stale}</Tag>
          {d.periods.map((p) => <Tag key={p.period} color="geekblue">账期 {p.period}：{p.state}{p.days !== null ? ` · ${p.days} 天` : ''}</Tag>)}
          <Button size="small" icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>以 {payload.viewer} 查看（只读）{payload.cached ? ' · 缓存' : ''}</Typography.Text>
        </Space>
      </Card>
      {(payload.next ?? []).map((n) => <Alert key={n} type="info" showIcon message={n} style={{ marginBottom: 8 }} />)}
      {(payload.warnings ?? []).map((w) => <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 8 }} />)}

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {kpis.map(([t, v]) => <Col key={t} xs={12} sm={8} md={6} lg={4} xl={3}><Card size="small"><Statistic title={t} value={v} /></Card></Col>)}
        <Col xs={24} lg={8} xl={6}><Card size="small" title="按阶段">{Object.entries(s.by_stage).map(([k, v]) => <Tag key={k} color="purple">{k} {v}</Tag>)}</Card></Col>
      </Row>

      <Card size="small" title="卡点" style={{ marginBottom: 12 }} extra={
        <Segmented size="small" value={lane} onChange={(v) => setLane(String(v))} options={[{ label: '全部泳道', value: 'all' }, ...LANES.map((l) => ({ label: l, value: l })), { label: '无泳道', value: 'none' }]} />
      }>
        <Alert type="info" showIcon style={{ marginBottom: 8 }} message="本页只读。人工审批在统一待办查看；工作台审批目前停用（同源门户/SOP 隔离未完成）。" />
        <Tabs size="small" items={[
          { key: 'h', label: `人工待审 ${human.length}`, children: human.length ? human.map((p) => <PendingRow key={p.proposal_id} p={p} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> },
          { key: 'g', label: `规则门禁未过 ${gate.length}`, children: gate.length ? gate.map((p) => <PendingRow key={p.proposal_id} p={p} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> },
          { key: 'l', label: `未确认关系 ${d.links_unconfirmed.length}`, children: d.links_unconfirmed.length ? d.links_unconfirmed.map((l) => <LinkRow key={l.link} l={l} />) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> },
          { key: 'a', label: `超时告警 ${overdue.length}`, children: overdue.length ? <AlertTable rows={overdue} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有超时告警" /> },
          { key: 's', label: `过期数据源 ${stale.length}`, children: stale.length ? <SourceTable rows={stale} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> },
        ]} />
      </Card>

      <Typography.Title level={5}>产品</Typography.Title>
      {d.products.length === 0 ? <Empty description="没有产品" style={{ marginBottom: 12 }} /> : (
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          {d.products.map((p) => <Col key={p.pd} xs={24} lg={12} xxl={8}><ProductCard p={p} d={d} /></Col>)}
        </Row>
      )}
      {d.unattached.length > 0 && (
        <Card size="small" title={`归属不明的对象 ${d.unattached.length}`} style={{ marginBottom: 12 }}>
          <Table size="small" pagination={false} rowKey="object" dataSource={d.unattached} columns={[
            { title: '对象', dataIndex: 'object' }, { title: '状态机', dataIndex: 'machine' }, { title: '泳道', dataIndex: 'lane' },
            { title: '状态', dataIndex: 'state' }, { title: '停留', dataIndex: 'days', render: daysText },
          ]} />
        </Card>
      )}

      <Card size="small" title="账期 · 告警 · 事件单 · 作业 · 数据源">
        <Tabs size="small" items={[
          { key: 'p', label: `账期 ${d.periods.length}`, children: d.periods.map((p) => (
            <div key={p.period} className="wm-lc-row">
              <Space wrap><b>账期 {p.period}</b><Tag color="geekblue">{p.state}</Tag><span>自 {fmt(p.since)}</span></Space>
              <Table size="small" pagination={false} rowKey="source" dataSource={p.obligations} style={{ marginTop: 4 }} columns={[
                { title: '义务来源', dataIndex: 'source' }, { title: '截止', dataIndex: 'due', render: fmt },
                { title: '可补', dataIndex: 'recoverable', render: (v: boolean) => (v ? '是' : '否') },
                { title: '状态', dataIndex: 'met', render: (v: boolean) => (v ? <Tag color="success">已满足</Tag> : <Tag color="error">未满足</Tag>) },
                { title: '满足于', dataIndex: 'ok_at', render: fmt },
              ]} />
            </div>
          )) },
          { key: 'a', label: `告警 ${d.alerts.length}`, children: <AlertTable rows={d.alerts} /> },
          { key: 'i', label: `事件单 ${d.incidents.length}`, children: <Table size="small" pagination={false} rowKey={(r) => String(r.incident ?? JSON.stringify(r))} dataSource={d.incidents}
            columns={Array.from(new Set(d.incidents.flatMap((r) => Object.keys(r)))).map((k) => ({ title: k, dataIndex: k, render: (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—')) }))} /> },
          { key: 'j', label: `作业 ${d.jobs.length}`, children: <Table size="small" pagination={false} rowKey="job" dataSource={d.jobs} columns={[
            { title: '作业', dataIndex: 'job' }, { title: '次数', dataIndex: 'runs' }, { title: '最近', dataIndex: 'last_at', render: fmt },
            { title: '最近结果', dataIndex: 'last_status' }, { title: '最近成功', dataIndex: 'last_ok_at', render: fmt },
          ]} /> },
          { key: 's', label: `数据源 ${d.sources.length}`, children: <SourceTable rows={d.sources} /> },
        ]} />
      </Card>
    </>
  );
}

function AlertTable({ rows }: { rows: BoardAlert[] }) {
  return <Table size="small" pagination={false} rowKey="alert" dataSource={rows} columns={[
    { title: '告警', dataIndex: 'alert' }, { title: '级别', dataIndex: 'level', render: (v: string) => <Tag color={v === 'P0' ? 'red' : v === 'P1' ? 'orange' : 'default'}>{v}</Tag> },
    { title: '路由', dataIndex: 'route' }, { title: '状态', dataIndex: 'state' }, { title: '触发', dataIndex: 'raised_at', render: fmt },
    { title: '期限', dataIndex: 'deadline', render: fmt }, { title: '超时', dataIndex: 'overdue', render: (v: boolean) => (v ? <Tag color="error">超时</Tag> : '否') },
  ]} />;
}

function SourceTable({ rows }: { rows: BoardSource[] }) {
  return <Table size="small" pagination={false} rowKey="source" dataSource={rows} columns={[
    { title: '数据源', dataIndex: 'source' }, { title: '级别', dataIndex: 'level' }, { title: '责任方', dataIndex: 'owner' }, { title: '时效', dataIndex: 'max_age' },
    { title: '最近成功', dataIndex: 'last_ok_at', render: fmt },
    { title: '过期', dataIndex: 'stale', render: (v: boolean | null) => (v === null ? <Tooltip title="内核按这种时效写法算不出"><Tag>算不出</Tag></Tooltip> : v ? <Tag color="warning">过期</Tag> : <Tag color="success">新鲜</Tag>) },
  ]} />;
}

/** 渲染出错只坏本页这一块，不让整个工作台白屏；内核字段形状变了时把原因露出来 */
class BoardBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[lifecycle] 全景渲染失败', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <Alert type="error" showIcon message="生命周期全景渲染失败" description={String(this.state.error.message ?? this.state.error)} action={<Button size="small" onClick={() => this.setState({ error: null })}>重试</Button>} />;
  }
}

/** #275 登录入口：401 带 login_url（/go/<Odoo 台>/?return=…）时把 return 换成当前页面并自动跳一次；
 *  两分钟内已经自动跳过（登录后仍 401，比如 Odoo 账号在生命周期侧不可用）就不再跳，只给按钮，避免循环 */
const LOGIN_TRY_KEY = 'wm_lc_login_try';
function LoginRequired({ payload, reload }: { payload: BoardPayload | null; reload: () => void }) {
  const href = payload?.login_url ? odooLoginHref(payload.login_url) : null;
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    if (!href) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem(LOGIN_TRY_KEY) ?? 0); } catch { last = Date.now(); }
    if (Date.now() - last < 120_000) return;
    try { sessionStorage.setItem(LOGIN_TRY_KEY, String(Date.now())); } catch { return; }
    setAuto(true);
    window.location.assign(href);
  }, [href]);
  return (
    <Result status="403" title={auto ? '正在跳转 Odoo 登录…' : '需要登录 Odoo'}
      subTitle={href ? (payload?.error ?? '请先登录 Odoo') : `${payload?.error ?? '未登录 Odoo'}；管理员尚未登记可信的 Odoo 工作台，无法自动跳转登录`}
      extra={<Space>{href && <Button type="primary" href={href}>登录 Odoo</Button>}<Button onClick={reload}>重试</Button></Space>} />
  );
}

export default function Lifecycle() {
  const asOf = new URLSearchParams(useLocation().search).get('as_of');
  const { payload, status, loading, reload } = useBoard(asOf);
  let body: ReactNode;
  if (loading && !payload) body = <Card loading style={{ minHeight: 200 }} />;
  else if (status === 401) body = <LoginRequired payload={payload} reload={reload} />;
  else if (!payload?.ok || !payload.data) body = <Alert type="warning" showIcon message="生命周期全景暂不可用" description={<>{payload?.error ?? '未知原因'}{(payload?.next ?? []).map((n) => <div key={n}>{n}</div>)}</>} action={<Button size="small" onClick={reload}>重试</Button>} />;
  else body = <BoardBoundary><BoardView payload={payload} reload={reload} /></BoardBoundary>;
  return <PageContainer title="生命周期全景" subTitle="产品 × 采购 × 物流 × 运营 · 只读">{body}</PageContainer>;
}
