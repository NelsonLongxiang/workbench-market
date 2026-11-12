/** 「安排一件事」（原型首页「在这里安排一件事」）：交给哪个团队、挂在哪条线哪一步、要做什么、交什么、期限、附件、先过目再派出去。
 *  附件：选了就先传（PUT /api/work-items/attachments/<名字>），传上的 id 安排时一起带上；最多 5 个、单个 ≤100 MB，传之前先挡。
 *  团队只列 GET /api/work-items/teams 给的；建好直接跳到这件事的详情。常用模板没有接口，先不放。
 *  状态：读团队中 / 没有可派的团队 / 不能安排（未登录、无权限）/ 服务没上线或出错，都在抽屉里说清楚。 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './attachments.css';
import { Alert, App, Button, DatePicker, Drawer, Empty, Form, Input, Select, Skeleton, Switch, Typography, Upload } from 'antd';
import { CheckCircleFilled, CloseOutlined, LoadingOutlined, PaperClipOutlined } from '@ant-design/icons';
import { getAssignableTeams, postWorkItem, uploadArrangeAttachment } from '../api';
import { ATTACH_MAX_FILES, attachProblem, sizeLabel, uploadErrorText } from '../work-item-extras';
import { EMPTY_FORM, LIMITS, buildBody, errorText, keyFor, resultText, teamOption, teamsBlockedText, validate, type ArrangeForm, type Created, type Team } from '../arrange-view';

export type LineOption = { id: string; label: string };
export type StageOption = { code: string; name: string };

export default function ArrangeDrawer({ open, onClose, lines = [], stages = [], preset }: {
  open: boolean; onClose: () => void; lines?: LineOption[]; stages?: StageOption[]; preset?: { object?: string; phase?: string };
}) {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [teamsStatus, setTeamsStatus] = useState(0);
  const [form, setForm] = useState<ArrangeForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof ArrangeForm, string>>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  /** 选了的附件：正在传 / 传上了（有 id）/ 没传上（写原因）。去掉一个只是不带它，服务端 24 小时后自己清掉没挂出去的 */
  type Up = { uid: string; name: string; size: number; state: 'uploading' | 'done' | 'error'; id?: string; error?: string };
  const [ups, setUps] = useState<Up[]>([]);
  const kept = ups.filter((u) => u.state !== 'error');
  const pickFile = async (file: File) => {
    const uid = `${Date.now()}-${Math.random()}`;
    const problem = attachProblem(file.size, kept.length);
    if (problem) { setUps((x) => [...x, { uid, name: file.name, size: file.size, state: 'error', error: problem }]); return; }
    setUps((x) => [...x, { uid, name: file.name, size: file.size, state: 'uploading' }]);
    let sha = '';
    try {
      const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      sha = [...new Uint8Array(d)].map((n) => n.toString(16).padStart(2, '0')).join('');
    } catch { sha = ''; }
    const r = await uploadArrangeAttachment(file, sha);
    const id = r.body && typeof r.body.id === 'string' ? r.body.id : '';
    setUps((x) => x.map((u) => (u.uid !== uid ? u : (r.status === 201 || r.status === 200) && id
      ? { ...u, state: 'done', id }
      : { ...u, state: 'error', error: uploadErrorText(r.status, typeof r.body?.error === 'string' ? r.body.error : undefined) })));
  };

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY_FORM, object: preset?.object ?? '', phase: preset?.phase ?? '' });
    setErrors({}); setFailure(''); attempt.current = null; setUps([]);
    setTeams(null);
    void getAssignableTeams().then((r) => { setTeamsStatus(r.status); setTeams(r.teams); });
  }, [open, preset?.object, preset?.phase]);

  const set = <K extends keyof ArrangeForm>(k: K, v: ArrangeForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };

  const submit = async () => {
    const list = teams ?? [];
    if (ups.some((u) => u.state === 'uploading')) { setFailure('附件还在传，传完再安排'); return; }
    const withFiles = { ...form, attachments: ups.flatMap((u) => (u.state === 'done' && u.id ? [u.id] : [])) };
    const e = validate(withFiles, list);
    setErrors(e); setFailure('');
    if (Object.keys(e).length) return;
    attempt.current = keyFor(attempt.current, withFiles);
    setBusy(true);
    const r = await postWorkItem(buildBody(withFiles, attempt.current.key));
    setBusy(false);
    if (r.status === 200 || r.status === 201) {
      const c = (r.body ?? {}) as Created;
      void message.success(resultText(c));
      onClose();
      if (c.item_id) nav(`/work-items/${encodeURIComponent(c.item_id)}`);
      return;
    }
    // 内容不一样的冲突：换一个新键，人再点一次就是新的一次
    if (r.status === 409) attempt.current = null;
    setFailure(errorText(r.status, r.body as { error?: string; window?: string; limit?: number } | null));
  };

  const blocked = teams !== null && teamsStatus !== 200;
  return <Drawer title="安排一件事" open={open} onClose={onClose} width={560} destroyOnClose
    footer={!blocked && teams && teams.length > 0 ? <div className="wm-drawer-foot">
      <Button onClick={onClose}>取消</Button>
      <Button type="primary" loading={busy} onClick={() => void submit()} data-testid="arrange-submit">安排</Button>
    </div> : null}>
    {teams === null ? <Skeleton active />
      : blocked ? <Alert type={teamsBlockedText(teamsStatus).type} showIcon message={teamsBlockedText(teamsStatus).text} data-testid="arrange-blocked" />
      : teams.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可以派的团队。团队要先接到任务中心上，才能在这里派。" />
      : <Form layout="vertical" requiredMark={false} data-testid="arrange-form">
        <Form.Item label="交给哪个团队" validateStatus={errors.team ? 'error' : ''} help={errors.team}>
          <Select value={form.team || undefined} placeholder="选一个团队" onChange={(v: string) => set('team', v)}
            options={teams.map((t) => ({ value: t.team, label: teamOption(t) }))} />
        </Form.Item>
        <Form.Item label="标题" validateStatus={errors.title ? 'error' : ''} help={errors.title}>
          <Input value={form.title} maxLength={LIMITS.title} showCount placeholder="一句话说清是什么事" onChange={(e) => set('title', e.target.value)} />
        </Form.Item>
        <Form.Item label="要做什么" validateStatus={errors.intent ? 'error' : ''} help={errors.intent}>
          <Input.TextArea value={form.intent} maxLength={LIMITS.intent} autoSize={{ minRows: 3, maxRows: 8 }} placeholder="背景、要做到什么程度、有什么要注意的" onChange={(e) => set('intent', e.target.value)} />
        </Form.Item>
        <Form.Item label="交什么" validateStatus={errors.deliverable ? 'error' : ''} help={errors.deliverable}>
          <Input.TextArea value={form.deliverable} maxLength={LIMITS.deliverable} autoSize={{ minRows: 2, maxRows: 6 }} placeholder="做完要交回什么，怎样算做完" onChange={(e) => set('deliverable', e.target.value)} />
        </Form.Item>
        <div className="wm-form-row">
          <Form.Item label="挂在哪条线（可不选）" validateStatus={errors.object ? 'error' : ''} help={errors.object}>
            {lines.length
              ? <Select allowClear showSearch optionFilterProp="label" value={form.object || undefined} placeholder="不挂" onChange={(v?: string) => set('object', v ?? '')} options={lines.map((l) => ({ value: l.id, label: l.label }))} />
              : <Input value={form.object} maxLength={LIMITS.object} placeholder="不挂" onChange={(e) => set('object', e.target.value)} />}
          </Form.Item>
          <Form.Item label="哪一步（可不选）" validateStatus={errors.phase ? 'error' : ''} help={errors.phase}>
            {stages.length
              ? <Select allowClear value={form.phase || undefined} placeholder="不挂" onChange={(v?: string) => set('phase', v ?? '')} options={stages.map((s) => ({ value: s.code, label: s.name }))} />
              : <Input value={form.phase} maxLength={LIMITS.phase} placeholder="不挂" onChange={(e) => set('phase', e.target.value)} />}
          </Form.Item>
        </div>
        <Form.Item label="期限（可不填）" validateStatus={errors.due ? 'error' : ''} help={errors.due}>
          <DatePicker className="wm-full" placeholder="不限" onChange={(d) => set('due', d ? d.format('YYYY-MM-DD') : '')} />
        </Form.Item>
        <Form.Item label="附件（可不加）" extra={`最多 ${ATTACH_MAX_FILES} 个，单个不超过 100 MB；选了就先传上去，安排时一起带上。`} data-testid="arrange-attachments">
          <Upload multiple showUploadList={false} beforeUpload={(f) => { void pickFile(f); return false; }}>
            <Button icon={<PaperClipOutlined />} disabled={kept.length >= ATTACH_MAX_FILES} data-testid="arrange-attach-pick">加附件</Button>
          </Upload>
          {ups.length > 0 && <ul className="wm-attach-list" data-testid="arrange-attach-list">{ups.map((u) => (
            <li key={u.uid} data-testid="arrange-attach" data-state={u.state}>
              {u.state === 'uploading' ? <LoadingOutlined /> : u.state === 'done' ? <CheckCircleFilled className="wm-attach-ok" /> : <CloseOutlined className="wm-attach-bad" />}
              <Typography.Text ellipsis className="wm-attach-name">{u.name}</Typography.Text>
              <Typography.Text type={u.state === 'error' ? 'danger' : 'secondary'} className="wm-caption">{u.state === 'error' ? u.error : u.state === 'uploading' ? '正在传…' : sizeLabel(u.size)}</Typography.Text>
              <Button type="text" size="small" icon={<CloseOutlined />} aria-label={`去掉 ${u.name}`} disabled={u.state === 'uploading'} onClick={() => setUps((x) => x.filter((y) => y.uid !== u.uid))} />
            </li>
          ))}</ul>}
        </Form.Item>
        {/* 规范 14 第十节第 3 条：开关叫「先过目再派出去」，下面一行写谁来过目。现在放行的是管理员；
            过目归团队负责人、「交给谁」分组之后（交给团队锁定为开，交给自己的 AI 员工缺省关），这一行按接口给的换 */}
        <Form.Item label="先过目再派出去" extra={form.review ? '派出去之前先停一下，等管理员放行。' : '直接派出去。管理员没开直派的话，照样会先停下等放行。'}>
          <Switch checked={form.review} onChange={(v) => set('review', v)} />
        </Form.Item>
        {failure && <Alert type="error" showIcon message={failure} data-testid="arrange-failure" />}
      </Form>}
  </Drawer>;
}
