/** #318 单次记录（/sops/:slug/runs/:id，PATTERNS.md §4）：纵向步骤时间线 + 每步填写值 + 附件。
 *  读授权完全由服务端判（#309/#312）：GET /api/sop/runs/:id 未授权只回元数据并带 private_read，
 *  此时页面只显示元数据和提示，不请求附件、不渲染任何字段值。填写值一律按文本渲染，不当 HTML。 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, App, Button, Descriptions, Empty, Result, Steps, Table, Tag, Typography } from 'antd';
import { DownloadOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { api, downloadAuthed } from '../api';
import type { SopApp, SopDefinition, SopRun, SopRunDetail as RunDetail, SopRunFile } from '../types';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { fmtSize, RUN_STATUS } from './SopSpace';

export default function SopRunDetail() {
  const { slug = '', id: idRaw = '' } = useParams();
  const id = Number(idRaw);
  const nav = useNavigate();
  const [sop, setSop] = useState<SopApp | null>(null);
  const [run, setRun] = useState<RunDetail | null | undefined>(undefined);
  const [meta, setMeta] = useState<SopRun | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setRun(undefined); setErr('');
    if (!/^\d+$/.test(idRaw)) { setRun(null); setErr('记录编号不合法'); return; }
    api.listSops().then((l) => setSop(l.find((s) => s.slug === slug) ?? null)).catch(() => setSop(null));
    api.listSopRuns({ slug }).then((l) => setMeta(l.find((r) => r.id === id) ?? null)).catch(() => setMeta(null));
    api.getSopRun(id)
      .then((r) => { if (r.sop_slug !== slug) { setRun(null); setErr(`记录 #${id} 不属于 SOP ${slug}`); } else setRun(r); })
      .catch((e) => { setRun(null); setErr((e as Error).message); });
  }, [slug, id, idRaw]);

  const trail = [{ title: sop?.title ?? slug, to: `/sops/${slug}` }, { title: `记录 #${idRaw}` }];
  if (run === undefined) return <WmPage title={`执行记录 #${idRaw}`} trail={trail} loading />;
  if (run === null) {
    return (
      <WmPage title={`执行记录 #${idRaw}`} trail={trail}>
        <Result status="404" title="找不到这条执行记录" subTitle={err} extra={<Button type="primary" onClick={() => nav(`/sops/${slug}`)}>回到交付空间</Button>} />
      </WmPage>
    );
  }

  const isPrivate = 'private_read' in run;
  const times = isPrivate ? run : meta;
  const stepCount = isPrivate ? run.steps : Object.keys(run.data ?? {}).length;
  const canResume = run.status === 'running' && sop?.status === 'published';
  return (
    <WmPage
      title={`执行记录 #${run.id}`}
      trail={trail}
      tags={<Tag color={RUN_STATUS[run.status].color}>{RUN_STATUS[run.status].label}</Tag>}
      extra={canResume ? <Button type="primary" icon={<PlayCircleOutlined />} href={`/sop/${slug}/?run=${run.id}`} target="_blank">继续执行</Button> : undefined}
      content={(
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label="SOP">{sop?.title ?? slug}</Descriptions.Item>
          <Descriptions.Item label="版本"><Typography.Text className="wm-mono">v{run.sop_version}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="执行人">{run.started_by || '-'}</Descriptions.Item>
          <Descriptions.Item label="已填步骤"><Typography.Text className="wm-num">{stepCount}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="开始"><RelTime value={times?.started_at} /></Descriptions.Item>
          <Descriptions.Item label="完成"><RelTime value={times?.finished_at || null} /></Descriptions.Item>
          <Descriptions.Item label="最近活动"><RelTime value={times?.updated_at} /></Descriptions.Item>
        </Descriptions>
      )}
    >
      {isPrivate ? (
        <Alert
          className="wm-run-private"
          type="info"
          showIcon
          message="这条记录的步骤填写值和附件需要读授权"
          description="你现在只能看到执行元数据。需要查看时，请管理员在控制面为你签发这条记录的读授权（read-grant），或使用发起执行时拿到的读凭证。"
        />
      ) : <RunBody slug={slug} run={run} />}
    </WmPage>
  );
}

function RunBody({ slug, run }: { slug: string; run: Extract<RunDetail, { data: Record<string, unknown> }> }) {
  const { message } = App.useApp();
  const [def, setDef] = useState<SopDefinition | null>(null);
  const [files, setFiles] = useState<SopRunFile[] | null>(null);
  const [filesErr, setFilesErr] = useState('');
  useEffect(() => {
    api.getSopDefinition(slug, run.sop_version).then((d) => setDef(Array.isArray(d?.steps) ? d : null)).catch(() => setDef(null));
    api.listSopRunFiles(run.id).then((r) => setFiles(r.items)).catch((e) => { setFiles([]); setFilesErr((e as Error).message); });
  }, [slug, run.id, run.sop_version]);

  const data = run.data ?? {};
  const defined = def?.steps ?? [];
  const extra = Object.keys(data).filter((k) => !defined.some((s) => s.key === k));
  const items = [
    ...defined.map((s) => ({ key: s.key, title: s.title, done: s.key in data })),
    ...extra.map((k) => ({ key: k, title: def ? `${k}（定义外字段）` : k, done: true })),
  ];
  return (
    <div className="wm-run-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wm-space-4)' }}>
      {!def && <Alert type="info" showIcon message={`v${run.sop_version} 的步骤定义暂不可读，下面按已填写的字段列出`} />}
      {items.length === 0 ? <Empty description="还没有填写任何步骤" /> : (
        <Steps
          direction="vertical"
          size="small"
          items={items.map((s) => ({
            title: s.title,
            status: s.done ? 'finish' : 'wait',
            description: s.done ? <StepValue value={data[s.key]} /> : <Typography.Text type="secondary">未填写</Typography.Text>,
          }))}
        />
      )}
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>附件</Typography.Title>
        {filesErr ? <Alert type="warning" showIcon message={`附件加载失败：${filesErr}`} /> : (
          <Table<SopRunFile>
            rowKey="id"
            size="small"
            loading={files === null}
            dataSource={files ?? []}
            pagination={false}
            locale={{ emptyText: '这次执行没有附件' }}
            columns={[
              { title: '文件', render: (_, f) => f.original_name || f.name || `文件 ${f.id}` },
              { title: '大小', width: 100, align: 'right', render: (_, f) => <Typography.Text className="wm-num">{fmtSize(f.size)}</Typography.Text> },
              { title: '上传', width: 120, render: (_, f) => <RelTime value={f.created_at} /> },
              { title: '操作', width: 90, render: (_, f) => <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadAuthed(f.url, f.original_name || `file-${f.id}`).catch((e) => message.error(`下载失败：${(e as Error).message}`))}>下载</Button> },
            ]}
          />
        )}
      </div>
    </div>
  );
}

/** 步骤值：对象按字段列出，其余转文本；一律走 React 文本节点，不解释 HTML。 */
function StepValue({ value }: { value: unknown }) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <Typography.Text type="secondary">（空）</Typography.Text>;
    return (
      <Descriptions size="small" column={1} className="wm-mt-1">
        {entries.map(([k, v]) => <Descriptions.Item key={k} label={k}>{scalar(v)}</Descriptions.Item>)}
      </Descriptions>
    );
  }
  return <div className="wm-mt-1">{scalar(value)}</div>;
}

function scalar(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <Typography.Text type="secondary">（空）</Typography.Text>;
  if (typeof v === 'string') return <span className="wm-prewrap">{v}</span>;
  if (typeof v === 'number' || typeof v === 'boolean') return <Typography.Text className="wm-num">{String(v)}</Typography.Text>;
  return <Typography.Text className="wm-mono wm-caption">{JSON.stringify(v)}</Typography.Text>;
}
