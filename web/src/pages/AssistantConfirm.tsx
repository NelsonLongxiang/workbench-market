/** 「待你确认」页（/assistant/confirm/<id>）：助理要替你动手时，服务端生成一条「待你确认」，助理把这个链接写在回复里。
 *  本人在自己已登录的浏览器里打开，看市场写的那句描述，打「确认」才执行；5 分钟时限，只能用一次。接口见 docs/assistant-phase1.md 第三节第 3、5 条（#829）。
 *  - 只从链接进来，不进侧栏；只认本人的市场会话（别人打开、口令、令牌都是 403），没登录去登录、登录完回到这一条；
 *  - 打的字原样提交，前端不修剪：恰好是「确认」两个字按钮才能点；
 *  - 到了终态（已办、没办成、不办、过期、数据变了、权限变了、作废）只显示结果，不再给提交框；时钟走到时限也一样。
 *  说法在 web/src/assistant-view.ts；不露确认编号和助理的主体标识。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Empty, Input, Result, Skeleton, Space, Tag, Typography } from 'antd';
import { ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { getAssistantConfirm, postAssistantConfirm } from '../api';
import { CONFIRM_WORD, OUTCOME_TEXT, STATUS_TEXT, STATUS_TONE, answerResult, confirmOf, confirmPageKind, remainingText, shownStatus, type ConfirmInfo } from '../assistant-view';

export default function AssistantConfirm() {
  const { id = '' } = useParams();
  const [kind, setKind] = useState<ReturnType<typeof confirmPageKind> | null>(null);
  const [info, setInfo] = useState<ConfirmInfo | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null);
  const [problem, setProblem] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const r = await getAssistantConfirm(id);
    const k = confirmPageKind(r.status, r.body);
    setKind(k); setInfo(k.kind === 'ok' ? confirmOf(r.body) : null);
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // 倒计时：每秒走一次，走到时限就当过期（不再给提交框）
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const answer = async (a: 'confirm' | 'decline') => {
    if (!info) return;
    setBusy(a); setProblem('');
    const r = await postAssistantConfirm(info.id, a, typed);
    setBusy(null);
    const out = answerResult(r.status, r.body);
    if (out.final) setInfo({ ...info, status: out.final, link: out.link ?? info.link });
    else setProblem(out.text);
  };

  const here = `/login?next=${encodeURIComponent(`/assistant/confirm/${id}`)}`;
  const foot = <Typography.Text type="secondary" className="wm-caption" data-testid="confirm-foot">这一页只认你本人已登录的市场会话；一条只能用一次，过期作废；从别的网站发来的提交一律拒绝。</Typography.Text>;
  const shell = (body: ReactNode) => <WmPage><div className="wm-confirm">{body}{foot}</div></WmPage>;

  if (!kind) return shell(<Card><Skeleton active paragraph={{ rows: 3 }} /></Card>);
  if (kind.kind === 'login') return shell(<div data-testid="confirm-login"><Result status="info" title="请先登录" subTitle="登录后回到这一条。" extra={<Button type="primary" href={here}>去登录</Button>} /></div>);
  if (kind.kind === 'not-yours') return shell(<div data-testid="confirm-not-yours"><Result status="403" title="这一条不是给你的" subTitle="它只能由发起它的人自己登录后确认，链接转给别人也没用；或者这一条已经没有了。" /></div>);
  if (kind.kind === 'session-only') return shell(<div data-testid="confirm-session-only"><Result status="warning" title={kind.text} subTitle="请用你自己的站内账号登录后再打开这个链接。" /></div>);
  if (kind.kind === 'missing') return shell(<Empty description="本站还没开放助理" data-testid="confirm-missing" />);
  if (kind.kind === 'error' || !info) return shell(<Alert type="error" showIcon message={kind.text} action={<Button size="small" onClick={() => void load()}>再试一次</Button>} data-testid="confirm-error" />);

  const st = shownStatus(info, now);
  const head = <>
    <Space size={12} data-testid="confirm-who"><span className="wm-avatar"><RobotOutlined /></span>
      <span><b>{info.assistantLabel}</b> 想替你办一件事{info.createdAt && <Typography.Text type="secondary" className="wm-caption"> · 发起于 <RelTime value={info.createdAt} /></Typography.Text>}</span></Space>
    <Card size="small" data-testid="confirm-desc">
      <Typography.Text type="secondary" className="wm-caption">要办的事（由市场写，不是助理写的）</Typography.Text>
      <div className="wm-confirm-what">{info.description}</div>
    </Card>
  </>;
  if (st !== 'pending') {
    return shell(<>{head}
      <Alert type={st === 'done' ? 'success' : st === 'failed' || st === 'denied' ? 'error' : 'info'} showIcon data-testid="confirm-outcome"
        message={<Space><Tag color={STATUS_TONE[st]}>{STATUS_TEXT[st]}</Tag></Space>} description={<Space direction="vertical">
          <span>{OUTCOME_TEXT[st]}</span>{info.link && <Link to={info.link} data-testid="confirm-result-link">去看结果 →</Link>}</Space>} />
    </>);
  }
  const left = remainingText(info.expiresAt, now);
  const exact = typed === CONFIRM_WORD;
  return shell(<>{head}
    <Card size="small" data-testid="confirm-form" title={<Space><span>要办，就在下面打「{CONFIRM_WORD}」</span>{left && <Tag color="warning" icon={<ClockCircleOutlined />} data-testid="confirm-left">{left}</Tag>}</Space>}>
      <Space direction="vertical" className="wm-w-full">
        <Input size="large" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`打「${CONFIRM_WORD}」两个字`} autoComplete="off" aria-label={`打「${CONFIRM_WORD}」两个字`} data-testid="confirm-input"
          onPressEnter={() => { if (exact && !busy) void answer('confirm'); }} />
        {typed !== '' && !exact && <Typography.Text type="secondary" className="wm-caption" data-testid="confirm-hint">要恰好是「{CONFIRM_WORD}」两个字，不带空格</Typography.Text>}
        <Space wrap>
          <Button type="primary" disabled={!exact} loading={busy === 'confirm'} onClick={() => void answer('confirm')} data-testid="confirm-ok">{CONFIRM_WORD}，去办</Button>
          <Button loading={busy === 'decline'} disabled={busy === 'confirm'} onClick={() => void answer('decline')} data-testid="confirm-decline">不办</Button>
          <Typography.Text type="secondary" className="wm-caption">确认后，市场会按那一刻你的权限和相关数据再判一遍才办</Typography.Text>
        </Space>
        {problem && <Alert type="warning" showIcon message={problem} data-testid="confirm-problem" />}
      </Space>
    </Card>
  </>);
}
