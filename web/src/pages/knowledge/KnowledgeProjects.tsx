/** 经验库的「项目对应的部门」（/knowledge/projects，统筹认的偏离：原型里没有这一页）。
 *  数据是 GET /api/knowledge/project-depts（#729，只有管理层和属主看得到、改得了；改了服务端记一行）。
 *  一行一个项目：项目名（ygl-trees 原样）、对到的部门（下拉改，或清掉）、这个项目下有几条、上次改的时间；下面是改动记录。
 *  部门的标识只当下拉的值、在 PUT 里回传，不写在页面的字上。看不了的人（403）只说一句为什么，不出表。 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, App, Button, Card, Empty, List, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import WmPage from '../../components/WmPage';
import RelTime from '../../components/RelTime';
import { getProjectDepts, putProjectDept } from '../../api';
import { NO_DEPT, asProjectDepts, projectDeptLogLine, projectDeptSaveError, projectDeptText, projectDeptsProblem, type ProjectDept, type ProjectDepts } from '../../knowledge-view';

type State = { phase: 'loading' } | { phase: 'ok'; data: ProjectDepts } | { phase: 'error'; status: number };
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const CLEAR = '';

export default function KnowledgeProjects() {
  const { message } = App.useApp();
  const [s, setS] = useState<State>({ phase: 'loading' });
  const [saving, setSaving] = useState<string | null>(null);
  const load = useCallback(async () => {
    setS({ phase: 'loading' });
    const r = await getProjectDepts();
    setS(r.status === 200 ? { phase: 'ok', data: asProjectDepts(r.body) } : { phase: 'error', status: r.status });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const change = async (p: ProjectDept, value: string) => {
    const department = value === CLEAR ? null : value;
    if ((p.department?.id ?? null) === department && !p.department_missing) return;
    setSaving(p.project);
    const r = await putProjectDept(p.project, department);
    setSaving(null);
    if (r.status === 200) {
      setS({ phase: 'ok', data: asProjectDepts(r.body) });
      void message.success(department === null ? `「${p.project}」不再对应部门，这个项目的经验只给管理层看` : '改好了');
    } else void message.error(projectDeptSaveError(r.status, r.body));
  };

  let body;
  if (s.phase === 'loading') body = <Card data-testid="kp-loading"><Skeleton active paragraph={{ rows: 5 }} /></Card>;
  else if (s.phase === 'error') {
    const p = projectDeptsProblem(s.status)!;
    body = <div data-testid="kp-problem">{s.status === 403
      ? <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={p.text}><Link to="/knowledge"><Button>回经验库</Button></Link></Empty></Card>
      : <Alert type={p.retry ? 'warning' : 'info'} showIcon message={p.text} action={p.retry ? <Button size="small" onClick={() => void load()}>再试一次</Button> : undefined} />}</div>;
  } else {
    const { projects, log, departments } = s.data;
    const options = [{ value: CLEAR, label: NO_DEPT }, ...departments.map((d) => ({ value: d.id, label: d.name }))];
    body = <Space direction="vertical" size={16} className="wm-w-full">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }} data-testid="kp-intro">
        经验库里有项目、没写谁能看的条目，按这张表归到对应部门：那个部门的人能看。不对应部门的，只给管理层看。改了会记下来。
      </Typography.Paragraph>
      {projects.length === 0
        ? <Card data-testid="kp-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="经验库里还没有带项目的条目。" /></Card>
        : <Card size="small" data-testid="kp-table"><Table<ProjectDept> rowKey="project" pagination={false} dataSource={projects} size="middle"
          columns={[
            { title: '项目', dataIndex: 'project', render: (v: string) => <Typography.Text strong data-testid="kp-project">{v}</Typography.Text> },
            { title: '对应的部门', key: 'dept', width: 320, render: (_: unknown, p) => {
              const t = projectDeptText(p);
              return <Space direction="vertical" size={4} className="wm-w-full">
                <Select<string> className="wm-w-full" data-testid="kp-select" aria-label={`「${p.project}」对应的部门`}
                  value={p.department_missing ? undefined : p.department?.id ?? CLEAR} placeholder="选一个部门"
                  options={options} loading={saving === p.project} disabled={saving !== null} onChange={(v) => void change(p, v)} />
                {t.warn && <Tag color="orange" data-testid="kp-missing">{t.text}</Tag>}
              </Space>;
            } },
            { title: '条目', dataIndex: 'items', width: 80, align: 'right', render: (n: number) => <span className="wm-num">{n}</span> },
            { title: '上次改', dataIndex: 'updated_at', width: 120, render: (v: number | null) => (v === null ? <Typography.Text type="secondary">没改过</Typography.Text> : <RelTime value={iso(v)} />) },
          ]} /></Card>}
      <Card size="small" title="改动记录" data-testid="kp-log">
        {log.length === 0
          ? <Typography.Text type="secondary">还没有人改过。</Typography.Text>
          : <List size="small" dataSource={log} renderItem={(l, i) => <List.Item key={i} data-testid="kp-log-row">
            <Space size={8} wrap><RelTime value={iso(l.at)} /><span>{projectDeptLogLine(l)}</span></Space>
          </List.Item>} />}
      </Card>
    </Space>;
  }

  return <WmPage trail={[{ title: '项目对应的部门' }]}>
    <div className="wm-reading">{body}</div>
  </WmPage>;
}
