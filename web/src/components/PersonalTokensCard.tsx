/** 设置页「个人令牌」（#1063）：签发（名字、能做的事、台、有效期）、原文只显示一次、清单看最近使用、撤销。
 *  原文只放在这个组件的状态里：不进地址、不进本地存储、不打日志；点「我已保存」或离开页面就没了。 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { listBenchViews } from '../api';
import { issuePersonalToken, listPersonalTokens, revokePersonalToken, type SourceResult } from '../personal-tokens-api';
import {
  MAX_DAYS, NAME_HINT, NAME_MAX, ONE_TIME_NOTE, SCOPES, SCOPE_NOTE, actionProblem, benchesLabel, draftProblem, expiryLabel, issueBody, issuedOf, lastUsedLabel, listProblem,
  needsBench, newDraft, scopesLabel, stateTag, tokenState, tokensOf, type TokenDraft, type TokenRow,
} from '../personal-tokens-view';

const TONE: Record<string, string> = { success: 'success', warning: 'warning', default: 'default' };

export default function PersonalTokensCard() {
  const [list, setList] = useState<SourceResult | null>(null);
  const [benches, setBenches] = useState<{ slug: string; title: string }[] | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TokenDraft>(newDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const now = Date.now();

  const reload = () => { void listPersonalTokens().then(setList); };
  useEffect(reload, []);
  useEffect(() => {
    if (!open || benches) return;
    void listBenchViews().then((r) => {
      const raw = r.body && typeof r.body === 'object' ? (r.body as { benches?: unknown }).benches : null;
      setBenches((Array.isArray(raw) ? raw : []).filter((b): b is { slug: string; title: string } => !!b && typeof b.slug === 'string').map((b) => ({ slug: b.slug, title: typeof b.title === 'string' && b.title ? b.title : b.slug })));
    });
  }, [open, benches]);

  const ok = !!list && list.status >= 200 && list.status < 300;
  const tokens = useMemo(() => (ok ? tokensOf(list?.body, now) : []), [ok, list]); // eslint-disable-line react-hooks/exhaustive-deps
  const titles = useMemo(() => new Map((benches ?? []).map((b) => [b.slug, b.title])), [benches]);
  const problem = listProblem(list);
  const draftErr = draftProblem(draft);

  const issue = async () => {
    if (draftErr) return;
    setBusy('issue'); setErr(null);
    const r = await issuePersonalToken(issueBody(draft));
    setBusy(null);
    const bad = actionProblem(r);
    const got = bad ? null : issuedOf(r.body);
    if (!got) { setErr(bad ?? '签发的应答里没有令牌，没签成；请重试。'); return; }
    setFresh({ name: draft.name.trim(), token: got.token });
    setOpen(false); setDraft(newDraft()); reload();
  };
  const revoke = async (t: TokenRow) => {
    setBusy('revoke:' + t.id); setErr(null);
    const r = await revokePersonalToken(t.id);
    setBusy(null);
    const bad = actionProblem(r);
    if (bad) setErr(bad);
    reload();
  };

  const columns = [
    { title: '名字', key: 'name', render: (_: unknown, t: TokenRow) => <span data-testid="pt-name">{t.name}</span> },
    { title: '能做的事', key: 'scopes', render: (_: unknown, t: TokenRow) => scopesLabel(t) },
    { title: '台', key: 'benches', render: (_: unknown, t: TokenRow) => benchesLabel(t, titles) },
    { title: '期限', key: 'expiry', render: (_: unknown, t: TokenRow) => expiryLabel(t, now) },
    { title: '最近使用', key: 'used', render: (_: unknown, t: TokenRow) => <span data-testid="pt-last-used">{lastUsedLabel(t)}</span> },
    { title: '状态', key: 'state', render: (_: unknown, t: TokenRow) => { const s = stateTag(t, now); return <Tag color={TONE[s.tone]} data-testid="pt-state">{s.text}</Tag>; } },
    { title: '', key: 'op', render: (_: unknown, t: TokenRow) => tokenState(t, now) === 'revoked' ? null : (
      <Popconfirm title={'撤销「' + t.name + '」？'} description="撤销后用它的请求立刻失败，不能恢复。" okText="撤销" cancelText="算了" okButtonProps={{ danger: true }} onConfirm={() => revoke(t)}>
        <Button size="small" danger loading={busy === 'revoke:' + t.id} data-testid="pt-revoke">撤销</Button>
      </Popconfirm>) },
  ];

  return (
    <Card title={<span><KeyOutlined /> 个人令牌</span>} className="wm-w-full wm-pt-card" data-testid="pt-card"
      extra={ok ? <Button type="primary" size="small" data-testid="pt-new" onClick={() => { setErr(null); setOpen(true); }}>签发令牌</Button> : null}>
      <Typography.Paragraph type="secondary">在终端里用属主身份办事（wm user …），不借已登录的浏览器。{SCOPE_NOTE}</Typography.Paragraph>
      {fresh && (
        <Alert className="wm-acc-alert" type="success" showIcon data-testid="pt-fresh"
          message={<span>「{fresh.name}」的令牌：<Typography.Text code copyable data-testid="pt-fresh-token">{fresh.token}</Typography.Text></span>}
          description={<span>{ONE_TIME_NOTE}</span>}
          action={<Button size="small" data-testid="pt-fresh-done" onClick={() => setFresh(null)}>我已保存</Button>} />
      )}
      {err && <Alert className="wm-acc-alert" type="warning" showIcon closable message={err} onClose={() => setErr(null)} data-testid="pt-err" />}
      {problem ? <Alert type={problem.type} showIcon message={problem.text} data-testid="pt-problem" />
        : <Table rowKey="id" size="small" loading={!list} dataSource={tokens} columns={columns} pagination={false} locale={{ emptyText: '还没有签过个人令牌' }} data-testid="pt-list" />}
      <Modal open={open} title="签发个人令牌" okText="签发" cancelText="算了" onCancel={() => setOpen(false)} onOk={issue} destroyOnClose
        okButtonProps={{ disabled: !!draftErr, loading: busy === 'issue', 'data-testid': 'pt-issue' }}>
        <Space direction="vertical" className="wm-w-full">
          <span>名字</span>
          <Input data-testid="pt-draft-name" value={draft.name} maxLength={NAME_MAX} placeholder={NAME_HINT} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <span>能做的事</span>
          <Checkbox.Group data-testid="pt-draft-scopes" value={draft.scopes} onChange={(v) => setDraft({ ...draft, scopes: v as string[] })}
            options={SCOPES.map((s) => ({ value: s.key, label: s.label + '（' + s.description + '）' }))} />
          <span>台</span>
          <Select mode="multiple" className="wm-w-full" data-testid="pt-draft-benches" loading={!benches} value={draft.benches}
            placeholder={needsBench(draft.scopes) ? '选台（按台的作用域必选）' : '只有报告维度时可以不选台'} onChange={(v) => setDraft({ ...draft, benches: v })} options={(benches ?? []).map((b) => ({ value: b.slug, label: b.title }))} />
          <span>有效期（天，最长 {MAX_DAYS}）</span>
          <InputNumber data-testid="pt-draft-days" min={1} max={MAX_DAYS} precision={0} value={draft.days} onChange={(v) => setDraft({ ...draft, days: typeof v === 'number' ? v : 0 })} />
          {draftErr && <Typography.Text type="secondary" data-testid="pt-draft-problem">{draftErr}</Typography.Text>}
        </Space>
      </Modal>
    </Card>
  );
}
