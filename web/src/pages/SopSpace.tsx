/** #318 SOP 交付空间（/sops/:slug，PATTERNS.md §4）：头部（状态 + 开始执行）+ 执行记录 / 交付物 / 定义三个标签。
 *  标签记在 ?tab=，刷新和分享链接不丢。执行记录只用元数据列表接口；交付物逐个 run 取附件，读授权由服务端判，
 *  未授权的 run 只显示「需要读授权」——前端不藏、也不绕。 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, App, Button, Descriptions, Empty, Result, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { api, downloadAuthed } from '../api';
import type { SopApp, SopDefinition, SopRun, SopRunFile } from '../types';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { SOP_STATUS } from './Sops';

export const RUN_STATUS: Record<SopRun['status'], { color: string; label: string }> = {
  running: { color: 'processing', label: '执行中' },
  finished: { color: 'green', label: '已完成' },
};

export function SopStatusTag({ status }: { status: SopApp['status'] }) {
  const meta = SOP_STATUS[status];
  return <Tooltip title={meta.hint}><Tag style={meta.style}>{meta.label}</Tag></Tooltip>;
}

const TABS = ['runs', 'deliverables', 'definition'] as const;
type TabKey = (typeof TABS)[number];
const RECENT = 20;

export default function SopSpace() {
  const { slug = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'runs';
  const { message } = App.useApp();
  const [sop, setSop] = useState<SopApp | null | undefined>(undefined);
  const [runs, setRuns] = useState<SopRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [def, setDef] = useState<SopDefinition | null>(null);
  const [defErr, setDefErr] = useState('');

  useEffect(() => {
    setSop(undefined);
    api.listSops().then((list) => setSop(list.find((s) => s.slug === slug) ?? null)).catch((e) => { message.error(`加载 SOP 失败：${(e as Error).message}`); setSop(null); });
    setRunsLoading(true);
    api.listSopRuns({ slug }).then(setRuns).catch((e) => message.error(`加载执行记录失败：${(e as Error).message}`)).finally(() => setRunsLoading(false));
    api.getSopDefinition(slug).then((d) => { if (Array.isArray(d?.steps)) { setDef(d); setDefErr(''); } else { setDef(null); setDefErr('定义数据不完整'); } }).catch((e) => { setDef(null); setDefErr((e as Error).message); });
  }, [slug, message]);

  if (sop === undefined) return <WmPage trail={[{ title: slug }]} loading />;
  if (sop === null) {
    return (
      <WmPage trail={[{ title: slug }]}>
        <Result status="404" title="没有这个 SOP" subTitle={`找不到 slug 为 ${slug} 的 SOP，可能已删除或链接有误`} extra={<Button type="primary" onClick={() => nav('/sops')}>回到 SOP 列表</Button>} />
      </WmPage>
    );
  }

  const lastRun = runs[0];
  const runningCount = runs.filter((r) => r.status === 'running').length;
  return (
    <WmPage
      title={sop.title}
      trail={[{ title: sop.title }]}
      tags={<SopStatusTag status={sop.status} />}
      subTitle={sop.description || undefined}
      extra={(
        <Tooltip title={sop.status === 'published' ? '新窗口打开执行页' : SOP_STATUS[sop.status].hint}>
          <Button type="primary" icon={<PlayCircleOutlined />} href={`/sop/${sop.slug}/`} target="_blank" disabled={sop.status !== 'published'}>开始执行</Button>
        </Tooltip>
      )}
      content={(
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label="编号"><Typography.Text className="wm-mono">{sop.code || def?.code || '-'}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="版本"><Typography.Text className="wm-mono">v{sop.active_version} / {sop.versions.length}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="负责人">{sop.created_by || '-'}</Descriptions.Item>
          <Descriptions.Item label="最近执行">{lastRun ? <RelTime value={lastRun.updated_at} /> : '还没有执行'}{runningCount ? <Tag color="processing" style={{ marginLeft: 8 }}>进行中 {runningCount}</Tag> : null}</Descriptions.Item>
        </Descriptions>
      )}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setParams(k === 'runs' ? {} : { tab: k }, { replace: true })}
        destroyInactiveTabPane
        items={[
          { key: 'runs', label: `执行记录 ${runs.length}`, children: <RunsTable slug={slug} runs={runs} loading={runsLoading} published={sop.status === 'published'} /> },
          { key: 'deliverables', label: '交付物', children: <Deliverables runs={runs} /> },
          { key: 'definition', label: '定义', children: <Definition sop={sop} def={def} defErr={defErr} /> },
        ]}
      />
    </WmPage>
  );
}

/** 执行记录：只有元数据与步骤数量（#309），不请求单 run 接口；点行进单次记录页，由那里按读授权取值。 */
function RunsTable({ slug, runs, loading, published }: { slug: string; runs: SopRun[]; loading: boolean; published: boolean }) {
  const nav = useNavigate();
  const columns: ProColumns<SopRun>[] = [
    { title: '状态', dataIndex: 'status', width: 90, render: (_, r) => <Tag color={RUN_STATUS[r.status].color}>{RUN_STATUS[r.status].label}</Tag> },
    { title: '记录', dataIndex: 'id', width: 90, render: (_, r) => <Link to={`/sops/${slug}/runs/${r.id}`} className="wm-mono" onClick={(e) => e.stopPropagation()}>#{r.id}</Link> },
    { title: '版本', dataIndex: 'sop_version', width: 70, render: (_, r) => <Typography.Text className="wm-mono">v{r.sop_version}</Typography.Text> },
    { title: '执行人', dataIndex: 'started_by', width: 140, render: (_, r) => r.started_by || <Typography.Text type="secondary">-</Typography.Text> },
    { title: '步骤数', dataIndex: 'steps', width: 80, align: 'right', render: (_, r) => <Typography.Text className="wm-num">{r.steps ?? 0}</Typography.Text> },
    { title: '开始', dataIndex: 'started_at', width: 120, render: (_, r) => <RelTime value={r.started_at} /> },
    { title: '完成', dataIndex: 'finished_at', width: 120, render: (_, r) => (r.finished_at ? <RelTime value={r.finished_at} /> : <Typography.Text type="secondary">-</Typography.Text>) },
  ];
  return (
    <div className="wm-sop-runs">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        此列表仅展示执行元数据与步骤数量；点一行进入单次记录，步骤填写值和附件只对有读授权的人显示。
      </Typography.Paragraph>
      <ProTable<SopRun>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={runs}
        loading={loading}
        search={false}
        options={false}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        onRow={(r) => ({ onClick: () => nav(`/sops/${slug}/runs/${r.id}`), style: { cursor: 'pointer' } })}
        locale={{ emptyText: <Empty description={published ? '还没有执行记录——点右上角「开始执行」跑第一次' : '还没有执行记录——上架后才能执行'} /> }}
      />
    </div>
  );
}

type DeliverableRow =
  | { key: string; run: SopRun; kind: 'file'; file: SopRunFile }
  | { key: string; run: SopRun; kind: 'none' | 'denied' | 'error'; note: string };

/** 交付物：已完成 run 的附件汇总。只在切到本标签时才逐个 run 请求附件（服务端判读授权）。 */
function Deliverables({ runs }: { runs: SopRun[] }) {
  const { message } = App.useApp();
  const finished = useMemo(() => runs.filter((r) => r.status === 'finished'), [runs]);
  const [runFilter, setRunFilter] = useState<number | 'recent'>('recent');
  const [rows, setRows] = useState<DeliverableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const target = useMemo(() => (runFilter === 'recent' ? finished.slice(0, RECENT) : finished.filter((r) => r.id === runFilter)), [finished, runFilter]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all(target.map(async (run): Promise<DeliverableRow[]> => {
      try {
        const { items } = await api.listSopRunFiles(run.id);
        return items.length ? items.map((file) => ({ key: `${run.id}-${file.id}`, run, kind: 'file' as const, file })) : [{ key: `${run.id}-none`, run, kind: 'none', note: '这次执行没有附件' }];
      } catch (e) {
        const denied = /403|读授权|口令/.test((e as Error).message) || (e as { needAdminToken?: boolean }).needAdminToken;
        return [{ key: `${run.id}-x`, run, kind: denied ? 'denied' : 'error', note: denied ? '需要读授权才能查看这次执行的附件' : `加载失败：${(e as Error).message}` }];
      }
    })).then((parts) => { if (alive) setRows(parts.flat()); }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [target]);

  const columns = [
    { title: '记录', width: 90, render: (_: unknown, r: DeliverableRow) => <Typography.Text className="wm-mono">#{r.run.id}</Typography.Text> },
    {
      title: '附件', render: (_: unknown, r: DeliverableRow) => (r.kind === 'file'
        ? <Typography.Text>{r.file.original_name || r.file.name || `文件 ${r.file.id}`}</Typography.Text>
        : <Typography.Text type={r.kind === 'none' ? 'secondary' : 'warning'}>{r.note}</Typography.Text>),
    },
    { title: '大小', width: 100, align: 'right' as const, render: (_: unknown, r: DeliverableRow) => (r.kind === 'file' ? <Typography.Text className="wm-num">{fmtSize(r.file.size)}</Typography.Text> : null) },
    { title: '完成', width: 120, render: (_: unknown, r: DeliverableRow) => <RelTime value={r.run.finished_at} /> },
    {
      title: '操作', width: 90, render: (_: unknown, r: DeliverableRow) => (r.kind === 'file'
        ? <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadAuthed(r.file.url, r.file.original_name || `file-${r.file.id}`).catch((e) => message.error(`下载失败：${(e as Error).message}`))}>下载</Button>
        : null),
    },
  ];
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ minWidth: 220 }}
          value={runFilter}
          onChange={setRunFilter}
          options={[{ value: 'recent' as const, label: `最近 ${RECENT} 次完成的执行` }, ...finished.map((r) => ({ value: r.id, label: `#${r.id} · ${r.started_by || '-'}` }))]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>只汇总已完成的执行；每次执行的附件按它自己的读授权显示</Typography.Text>
      </Space>
      <Table<DeliverableRow>
        rowKey="key"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description={finished.length ? '没有附件' : '还没有完成的执行，交付物会在执行完成后出现在这里'} /> }}
      />
    </Space>
  );
}

function Definition({ sop, def, defErr }: { sop: SopApp; def: SopDefinition | null; defErr: string }) {
  const versions = [...sop.versions].sort((a, b) => b.version - a.version);
  return (
    <Tabs
      size="small"
      items={[
        {
          key: 'steps', label: '步骤',
          children: def ? (
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={def.steps.map((s, i) => ({ ...s, n: i + 1 }))}
              columns={[
                { title: '#', dataIndex: 'n', width: 50, align: 'right' as const, render: (v: number) => <Typography.Text className="wm-num">{v}</Typography.Text> },
                { title: '步骤', dataIndex: 'title' },
                { title: 'key', dataIndex: 'key', width: 200, render: (v: string) => <Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{v}</Typography.Text> },
              ]}
              title={() => <Typography.Text type="secondary" style={{ fontSize: 12 }}>v{def.version}（当前生效版本）共 {def.steps.length} 步</Typography.Text>}
            />
          ) : <Alert type="info" showIcon message="步骤定义暂不可见" description={defErr || '加载中…'} />,
        },
        {
          key: 'versions', label: `版本历史 ${versions.length}`,
          children: (
            <Table
              rowKey="version"
              size="small"
              pagination={false}
              dataSource={versions}
              columns={[
                { title: '版本', dataIndex: 'version', width: 90, render: (v: number) => <Space size={4}><Typography.Text className="wm-mono">v{v}</Typography.Text>{v === sop.active_version && <Tag color="blue">生效中</Tag>}</Space> },
                { title: '变更说明', dataIndex: 'changelog', render: (v: string) => (v ? <span style={{ whiteSpace: 'pre-wrap' }}>{v}</span> : <Typography.Text type="secondary">-</Typography.Text>) },
                { title: '发布人', dataIndex: 'created_by', width: 140 },
                { title: '时间', dataIndex: 'created_at', width: 120, render: (v: string) => <RelTime value={v} /> },
              ]}
            />
          ),
        },
      ]}
    />
  );
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
