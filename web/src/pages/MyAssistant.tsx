/** 「我的助理」页（/settings/assistant，入口在左下角用户卡里）。一人一助理第 1 期，接口见 docs/assistant-phase1.md 第六节（#829）。
 *  每个账户一个助理，开通账户时就建好了；它代表本人，只做本人权限以内的事；动手前在市场页面上由本人打字确认。
 *  这一页：助理的状态、接入地址、取 / 重置令牌（原文只显示一次）、停用 / 启用、怎么接入、它替你办过的事。
 *  状态：没登录、不是本人的会话（管理员口令、令牌）、服务端还没上线（404）、部署方没开（enabled_by_deployment）、出错，各有一句。
 *  说法和整形在 web/src/assistant-view.ts；不露代号（助理的主体标识、确认编号、工具代号）。 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, App, Button, Card, Descriptions, Empty, List, Popconfirm, Result, Skeleton, Space, Tag, Typography } from 'antd';
import { KeyOutlined, PoweroffOutlined, RobotOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { getAssistant, getAssistantActions, postAssistantDisable, postAssistantEnable, postAssistantToken } from '../api';
import { ANSWER_TEXT, STATUS_TEXT, STATUS_TONE, actionError, actionsOf, assistantOf, pageKind, tokenLine, type ActionRow, type AssistantInfo, type PageKind } from '../assistant-view';

const LOGIN = `/login?next=${encodeURIComponent('/settings/assistant')}`;

export default function MyAssistant() {
  const { message } = App.useApp();
  const [kind, setKind] = useState<{ kind: PageKind; text: string } | null>(null);
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [rows, setRows] = useState<ActionRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<'token' | 'power' | 'more' | null>(null);

  const loadActions = useCallback(async (cursor: string | null) => {
    const r = await getAssistantActions(cursor);
    if (r.status !== 200) { setRowsFailed(true); if (!cursor) setRows([]); return; }
    const a = actionsOf(r.body);
    setRowsFailed(false);
    setRows((cur) => (cursor ? [...(cur ?? []), ...a.items] : a.items));
    setNext(a.next);
  }, []);
  const load = useCallback(async () => {
    const r = await getAssistant();
    const k = pageKind(r.status, r.body);
    setKind(k);
    setInfo(k.kind === 'ok' ? assistantOf(r.body) : null);
    if (k.kind === 'ok') void loadActions(null);
  }, [loadActions]);
  useEffect(() => { void load(); }, [load]);

  const takeToken = async () => {
    setBusy('token');
    const r = await postAssistantToken();
    setBusy(null);
    const t = r.status === 200 && r.body && typeof r.body === 'object' ? (r.body as { token?: unknown }).token : null;
    if (typeof t === 'string' && t) { setToken(t); void load(); }
    else void message.error(actionError(r.status, r.body));
  };
  const power = async (on: boolean) => {
    setBusy('power');
    const r = await (on ? postAssistantEnable() : postAssistantDisable());
    setBusy(null);
    if (r.status !== 200) { void message.error(actionError(r.status, r.body)); return; }
    if (!on) setToken(null);
    const cancelled = !on && r.body && typeof r.body === 'object' ? Number((r.body as { cancelled?: unknown }).cancelled) || 0 : 0;
    void message.success(on ? '助理已启用' : `助理已停用，所有连接都断开了${cancelled ? `；还在等你确认的 ${cancelled} 件一并作废` : ''}`);
    void load();
  };

  const intro = <Typography.Paragraph type="secondary" className="wm-caption" data-testid="assistant-intro">
    每个账户有一个助理，开通账户时就建好了。它代表你，只能做你权限以内的事：只看的直接回答；要动手的，先给你一个链接，你在已登录的市场页面上打「确认」它才办，一事一确认。它办的每件事都记成「你（经助理）」。
  </Typography.Paragraph>;

  if (!kind) return <WmPage>{intro}<Card><Skeleton active paragraph={{ rows: 4 }} /></Card></WmPage>;
  if (kind.kind === 'login') return <WmPage>{intro}<div data-testid="assistant-login"><Result status="info" title="请先登录" subTitle="登录后才能看你的助理。" extra={<Button type="primary" href={LOGIN}>去登录</Button>} /></div></WmPage>;
  if (kind.kind === 'session-only') return <WmPage>{intro}<div data-testid="assistant-session-only"><Result status="warning" title={kind.text} subTitle="管理员口令是大家共用的，令牌是给助理用的，都不代表你本人。请用你自己的站内账号登录后再打开这一页。" /></div></WmPage>;
  if (kind.kind === 'missing') return <WmPage>{intro}<Empty description={<>本站还没有上线助理。<br />服务端这一期上线以后，这里会显示你的助理。</>} data-testid="assistant-missing" /></WmPage>;
  if (kind.kind === 'error' || !info) return <WmPage>{intro}<Alert type="error" showIcon message={kind.text} action={<Button size="small" onClick={() => void load()}>再试一次</Button>} data-testid="assistant-error" /></WmPage>;

  const on = info.status === 'active';
  const canToken = info.enabled && on;
  return <WmPage>
    {intro}
    <Space direction="vertical" size="middle" className="wm-w-full">
      {!info.enabled && <Alert type="info" showIcon data-testid="assistant-not-open" message="本站还没开放助理"
        description="部署方打开以后，你才能取令牌、让助理替你动手。以前的记录照常能看。" />}
      {token && <Alert type="warning" showIcon data-testid="assistant-token" message="新令牌只显示这一次，现在复制"
        description={<Space direction="vertical" className="wm-w-full">
          <Typography.Text code copyable={{ text: token }} data-testid="assistant-token-text">{token}</Typography.Text>
          <Typography.Text type="secondary" className="wm-caption">离开这一页、或点下面的按钮以后就再也看不到了；丢了就重置一枚，旧的随即作废。</Typography.Text>
        </Space>}
        action={<Button size="small" onClick={() => setToken(null)}>我已复制</Button>} />}
      <Card data-testid="assistant-card" title={<Space><RobotOutlined /><span>我的助理</span>
        <Tag color={on ? 'success' : 'default'} data-testid="assistant-status">{on ? '启用中' : '已停用'}</Tag></Space>}
        extra={<Space>
          {info.hasToken
            ? <Popconfirm title="重置令牌？" description="旧令牌立刻作废，还在等你确认的也一并作废；用新令牌重新接入。" okText="重置" cancelText="再想想" onConfirm={() => void takeToken()} disabled={!canToken}>
                <Button icon={<KeyOutlined />} loading={busy === 'token'} disabled={!canToken} data-testid="assistant-token-reset">重置令牌</Button>
              </Popconfirm>
            : <Button type="primary" icon={<KeyOutlined />} loading={busy === 'token'} disabled={!canToken} onClick={() => void takeToken()} data-testid="assistant-token-new">取令牌</Button>}
          {on
            ? <Popconfirm title="停用助理？" description={`所有连接立刻断开${info.pendingConfirms ? `，还在等你确认的 ${info.pendingConfirms} 件一并作废` : ''}。之后可以再启用。`} okText="停用" cancelText="再想想" onConfirm={() => void power(false)}>
                <Button danger icon={<PoweroffOutlined />} loading={busy === 'power'} data-testid="assistant-disable">停用</Button>
              </Popconfirm>
            : <Button icon={<PoweroffOutlined />} loading={busy === 'power'} onClick={() => void power(true)} data-testid="assistant-enable">启用</Button>}
        </Space>}>
        <Descriptions size="small" column={1} items={[
          { key: 'url', label: '接入地址', children: info.mcpUrl ? <Typography.Text code copyable data-testid="assistant-mcp-url">{info.mcpUrl}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text> },
          { key: 'token', label: '令牌', children: <Space size={4} wrap data-testid="assistant-token-line"><span>{tokenLine(info)}</span>
            {info.hasToken && info.tokenCreatedAt && <><Typography.Text type="secondary">· 取于</Typography.Text><RelTime value={info.tokenCreatedAt} /></>}
            {info.hasToken && <><Typography.Text type="secondary">· 最后一次使用</Typography.Text>{info.tokenLastUsedAt ? <RelTime value={info.tokenLastUsedAt} /> : <Typography.Text type="secondary">还没用过</Typography.Text>}</>}</Space> },
          { key: 'pending', label: '等你确认', children: <span data-testid="assistant-pending">{info.pendingConfirms} 件</span> },
          { key: 'done', label: '近 30 天', children: <span data-testid="assistant-30d">替你办过 {info.actions30d} 件</span> },
        ]} />
        {!on && <Typography.Text type="secondary" className="wm-caption">停用中：所有连接都断开了，不能取令牌。启用以后原来的令牌恢复可用；要作废它就重置。</Typography.Text>}
      </Card>
      <Card size="small" title="怎么接入" data-testid="assistant-howto">
        <ol className="wm-assistant-steps">
          <li>在 Claude 或 DSH 会话里添加一个 MCP 服务器：地址填上面的接入地址，令牌填你取到的那一串。</li>
          <li>直接说要办什么，例如「等我拍板的有哪些」「把这件事的期限改到 11 月 20 日」。只看的它直接回答。</li>
          <li>要动手的事，它会在回复里给你一个市场链接。在你已登录的浏览器里打开，看清市场写的那句描述，打「确认」它才办；5 分钟内不确认就作废。</li>
        </ol>
      </Card>
      <Card size="small" title={<Space><span>它替你办过的事</span><Typography.Text type="secondary" className="wm-caption">近 30 天</Typography.Text></Space>} data-testid="assistant-actions">
        {rows === null ? <Skeleton active title={false} paragraph={{ rows: 3 }} />
          : rowsFailed && rows.length === 0 ? <Space><Typography.Text type="secondary">读不到它办过的事，稍后再试。</Typography.Text><Button size="small" onClick={() => void loadActions(null)}>再试一次</Button></Space>
            : rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 30 天它还没替你办过事" />
              : <List dataSource={rows} rowKey="id" renderItem={(r) => <List.Item data-testid="assistant-action"
                  extra={<Tag color={STATUS_TONE[r.status]} data-testid="assistant-action-status">{STATUS_TEXT[r.status]}</Tag>}>
                  <List.Item.Meta title={<Space size={8} wrap><Tag>{r.toolLabel}</Tag><span>{r.description}</span></Space>}
                    description={<Space size={8} wrap className="wm-caption">{r.at && <RelTime value={r.at} />}<span>{ANSWER_TEXT[r.answer]}</span>{r.link && <Link to={r.link}>去看结果 →</Link>}</Space>} />
                </List.Item>} />}
        {next && <Button className="wm-assistant-more" loading={busy === 'more'} onClick={async () => { setBusy('more'); await loadActions(next); setBusy(null); }} data-testid="assistant-more">再往前看</Button>}
      </Card>
    </Space>
  </WmPage>;
}
