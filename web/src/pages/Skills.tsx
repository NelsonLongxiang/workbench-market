import { useEffect, useMemo, useState } from 'react';
import { Card, Input, Progress, Segmented, Space, Table, Tag, Timeline, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PageContainer } from '@ant-design/pro-components';


/** 技能市场管理页（P1-a · 方案 PR#57：只读浏览 + 版本链 + digest 展示；发布走 CLI/口令，薄分发） */
interface SkillRow {
  slug: string; name: string; layer: number; layer_name: string;
  family_parent: string; description?: string; legacy: boolean; versions: number;
}
interface VersionRow { id: number; version: number; changelog: string; breaking: number; tree_digest: string; file_count: number; total_bytes: number; reviewed_by: string; created_at: string; }

const LAYERS = [
  { label: '全部', value: 0 },
  { label: '1 业务角色', value: 1 },
  { label: '2 开发运维', value: 2 },
  { label: '3 工作流', value: 3 },
  { label: '4 架构设计', value: 4 },
  { label: '5 AI 原生运营', value: 5 },
];

export default function SkillsPage() {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [layer, setLayer] = useState(0);
  const [q, setQ] = useState('');
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);

  const load = () => {
    setLoading(true);
    fetch('/api/skills')
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => setRows(Array.isArray(j) ? j : j.items ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  const openVersions = (slug: string) => {
    setVersionsOf(slug);
    fetch(`/api/skills/${encodeURIComponent(slug)}/versions`)
      .then((r) => (r.ok ? r.json() : { versions: [] }))
      .then((j) => setVersions(j.versions ?? []))
      .catch(() => setVersions([]));
  };
  const shown = useMemo(
    () => rows.filter((r) => (layer === 0 || r.layer === layer) && (!q || `${r.name} ${r.description ?? ''}`.toLowerCase().includes(q.toLowerCase()))),
    [rows, layer, q],
  );

  const cols: ColumnsType<SkillRow> = [
    { title: 'slug', dataIndex: 'slug', key: 'slug', render: (_, r) => <Typography.Text code style={{ fontSize: 12 }}>{r.slug}</Typography.Text> },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '层', dataIndex: 'layer', key: 'layer', width: 90, render: (_, r) => <Tag color={['', 'geekblue', 'cyan', 'gold', 'purple', 'green'][r.layer]}>{r.layer} {r.layer_name.slice(0, 4)}</Tag> },
    { title: '族', dataIndex: 'family_parent', key: 'family', width: 110, render: (_, r) => r.family_parent || '-' },
    { title: '版本', dataIndex: 'versions', key: 'versions', width: 70, render: (_, r) => (
      <a onClick={() => openVersions(r.slug)}>{r.versions}</a>
    ) },
    { title: '形态', key: 'legacy', width: 80, render: (_, r) => r.legacy ? <Tag>legacy 登记</Tag> : <Tag color="processing">快照</Tag> },
  ];
  const vcols: ColumnsType<VersionRow> = [
    { title: 'v', dataIndex: 'version', key: 'v', width: 50 },
    { title: 'changelog', dataIndex: 'changelog', key: 'cl', ellipsis: true },
    { title: 'digest', dataIndex: 'tree_digest', key: 'dg', render: (_, r) => <Typography.Text code style={{ fontSize: 11 }}>{r.tree_digest.slice(0, 16)}…</Typography.Text> },
    { title: '文件/字节', key: 'sz', width: 110, render: (_, r) => `${r.file_count} / ${(r.total_bytes / 1024).toFixed(1)}K` },
    { title: '人审', dataIndex: 'reviewed_by', key: 'rv', width: 90 },
    { title: '时间', dataIndex: 'created_at', key: 'at', width: 140, render: (_, r) => r.created_at?.slice(0, 16) },
  ];

  return (
    <PageContainer title="技能市场" subTitle="五层治理 · 版本不可变 · digest 身份锚（只读浏览，发布走 CLI/口令）" className="wm-page">
      <Card>
        {/* 分层统计卡（五层治理：每层数量 + legacy 占比条，点击过滤） */}
        <Space wrap size={8} style={{ marginBottom: 10 }}>
          {LAYERS.filter((l) => l.value > 0).map((l) => {
            const items = rows.filter((r) => r.layer === l.value);
            const legacy = items.filter((r) => r.legacy).length;
            const pct = items.length ? Math.round((legacy / items.length) * 100) : 0;
            return (
              <Card key={l.value} size="small" style={{ width: 150, cursor: 'pointer' }} onClick={() => setLayer(l.value)}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{l.label}</Typography.Text>
                <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>{items.length}</div>
                {legacy > 0 && <Progress percent={pct} size="small" format={() => `legacy ${legacy}`} />}
              </Card>
            );
          })}
        </Space>
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented options={LAYERS} value={layer} onChange={(v) => setLayer(v as number)} />
          <Input.Search placeholder="搜索名称/描述" allowClear style={{ width: 240 }} onSearch={setQ} />
          <Typography.Text type="secondary">共 {shown.length} 项（快照 {shown.filter((r) => !r.legacy).length} / legacy {shown.filter((r) => r.legacy).length}）</Typography.Text>
        </Space>
        <Table rowKey="slug" size="small" columns={cols} dataSource={shown} loading={loading} pagination={{ pageSize: 20 }} />
      </Card>
      {versionsOf && (
        <Card size="small" title={`版本链：${versionsOf}`} style={{ marginTop: 12 }} extra={<a onClick={() => setVersionsOf(null)}>关闭</a>}>
          <Timeline
            items={versions.map((v) => ({
              color: v.breaking ? 'red' : 'green',
              children: (
                <div>
                  <Space size={8} wrap>
                    <Tag color={v.breaking ? 'red' : 'green'}>v{v.version}{v.breaking ? ' ⚠breaking' : ''}</Tag>
                    <Typography.Text style={{ fontSize: 13 }}>{v.changelog || '(no changelog)'}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>{v.created_at?.slice(0, 16)}</Typography.Text>
                  </Space>
                  <div style={{ marginTop: 4 }}>
                    <Typography.Text code style={{ fontSize: 11 }}>{v.tree_digest?.slice(0, 20)}…</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                      {v.file_count} 文件 · {(v.total_bytes / 1024).toFixed(1)}KB{v.reviewed_by ? ` · 人审 ${v.reviewed_by}` : ''}
                    </Typography.Text>
                  </div>
                </div>
              ),
            }))}
          />
        </Card>
      )}
    </PageContainer>
  );
}
