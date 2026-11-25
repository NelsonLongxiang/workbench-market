import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Popconfirm, Space, Typography } from 'antd';
import { getReportReviewInvitation, submitReportTemplateReview } from '../api';

type ReviewTarget = { dimension: string; template: { version: number; sha256: string; criteria_sha256: string; body: unknown; review?: unknown } };

export default function ReportReviewInvitation({ id }: { id: string }) {
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getReportReviewInvitation(id, controller.signal).then(async r => {
      if (!r.ok) throw Error('此邀请已失效或不可查看。');
      setTarget(await r.json() as ReviewTarget);
    }).catch(() => { if (!controller.signal.aborted) setMessage('此邀请已失效或不可查看。'); });
    return () => controller.abort();
  }, [id]);
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await submitReportTemplateReview(target.dimension, target.template.version, note);
      const result = await r.json();
      if (!r.ok) throw Error(result.message || '无法提交复核。');
      setDone(true);
      setMessage('复核已提交。');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Card title={target ? target.dimension + ' · 第 ' + target.template.version + ' 版' : '报告模板复核'}>
    {message && <Alert type={done ? 'success' : 'error'} showIcon message={message} />}
    {!target && !message && <Typography.Text>正在读取邀请…</Typography.Text>}
    {target && <Space direction="vertical" size="middle">
      <Typography.Text copyable>正文摘要 {target.template.sha256}</Typography.Text>
      <Typography.Text copyable>判据摘要 {target.template.criteria_sha256}</Typography.Text>
      <details open><summary>模板正文</summary><pre>{JSON.stringify(target.template.body, null, 2)}</pre></details>
      {target.template.review ? <Typography.Text>该版本已复核。</Typography.Text> : !done && <>
        <Input.TextArea aria-label="复核说明" value={note} onChange={event => setNote(event.target.value)} maxLength={200} placeholder="复核说明" />
        <Popconfirm title="确认已核对该版本的判据？" onConfirm={submit}><Button type="primary" loading={busy}>提交复核</Button></Popconfirm>
      </>}
    </Space>}
  </Card>;
}
