import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dayjs from 'dayjs';
import { Alert, App, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Progress, Result, Select, Space, Spin, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PageContainer } from '@ant-design/pro-components';
import { CopyOutlined, DeleteOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, LockOutlined, PlusOutlined, StarFilled, ThunderboltOutlined, UnlockOutlined } from '@ant-design/icons';
import { VAULT_KINDS, VaultError, vaultApi, type Strength, type VaultEntry, type VaultEvent, type VaultHealth, type VaultKind, type VaultStats, type VaultStatus, type VaultSummary } from '../vault-api';
import { adminTokenPresent, subscribeAdminToken } from '../admin-token';
import { controlUrl, onSurface, surface } from '../surface';

/** 凭据库（融合 dsh-vault）：只在控制面打开；读写都要口令；与 DSH 插件共用同一个加密库文件 */
const KIND_LABEL: Record<VaultKind, string> = { login: '登录', ssh: 'SSH', 'api-key': 'API Key', secret: 'Secret', oauth: 'OAuth', cookie: 'Cookie 会话', card: '银行卡', custom: '自定义' };
const KIND_COLOR: Record<VaultKind, string> = { login: 'blue', ssh: 'geekblue', 'api-key': 'purple', secret: 'magenta', oauth: 'cyan', cookie: 'gold', card: 'volcano', custom: 'default' };
/** 每类条目在表单里展示哪些字段（其余字段保留但不显示） */
const KIND_FIELDS: Record<VaultKind, (keyof VaultEntry)[]> = {
  login: ['username', 'email', 'phone', 'password', 'url', 'otpSecret'],
  ssh: ['host', 'port', 'username', 'password', 'privateKey'],
  'api-key': ['apiKey', 'secret', 'url'],
  secret: ['secret', 'url'],
  oauth: ['accessToken', 'refreshToken', 'expiresAt', 'url'],
  cookie: ['url'],
  card: ['cardHolder', 'cardNumber', 'cardExpiry', 'cardCvv'],
  custom: ['username', 'password', 'secret', 'url'],
};
const FIELD_LABEL: Partial<Record<keyof VaultEntry, string>> = {
  username: '用户名', email: '邮箱', phone: '手机', password: '密码', url: '网址', otpSecret: 'TOTP 密钥', host: '主机', port: '端口',
  privateKey: 'SSH 私钥', apiKey: 'API Key', secret: 'Secret', accessToken: 'Access Token', refreshToken: 'Refresh Token', expiresAt: '过期时间',
  cardHolder: '持卡人', cardNumber: '卡号', cardExpiry: '有效期（MM/YY）', cardCvv: 'CVV', notes: '备注',
};
const SECRET_FIELDS = new Set<keyof VaultEntry>(['password', 'privateKey', 'apiKey', 'secret', 'accessToken', 'refreshToken', 'otpSecret', 'cardNumber', 'cardCvv']);
const MULTILINE = new Set<keyof VaultEntry>(['privateKey', 'accessToken', 'refreshToken']);
const STRENGTH_COLOR: Record<Strength['verdict'], string> = { weak: '#DC2626', fair: '#D97706', strong: '#059669', 'very strong': '#047857' };
const STRENGTH_LABEL: Record<Strength['verdict'], string> = { weak: '弱', fair: '一般', strong: '强', 'very strong': '很强' };
const ACTION_LABEL: Record<string, string> = { add: '新增', update: '修改', delete: '移入回收站', restore: '恢复', purge: '永久删除', read: '查看密钥', totp: '取验证码', search: '检索', switch: '切换库', merge: '合并', rollback: '回滚密码' };
const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');

export default function VaultPage() {
  const tokenSet = useSyncExternalStore(subscribeAdminToken, adminTokenPresent);
  if (surface === 'market') {
    const href = onSurface(controlUrl);
    return (
      <PageContainer title="凭据库" className="wm-page">
        <Result status="info" title="凭据库只在管理控制面打开" subTitle="业务面同源跑着门户代理的外站与 SOP 页面，凭据不在这里展示。" extra={href ? <Button type="primary" icon={<LockOutlined />} href={href}>去控制面</Button> : <Typography.Text type="secondary">控制面已关闭（WM_CONTROL_PORT=0），只能用本机命令行</Typography.Text>} />
      </PageContainer>
    );
  }
  if (!tokenSet) {
    return (
      <PageContainer title="凭据库" className="wm-page">
        <Result status="warning" title="先输入管理员口令" subTitle="凭据库的读写都要管理员口令：在左下角「口令」处输入后再回到本页。" />
      </PageContainer>
    );
  }
  return <VaultBody />;
}

function VaultBody() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [err, setErr] = useState<string>('');
  const refreshStatus = useCallback(() => {
    vaultApi.status().then((s) => { setStatus(s); setErr(''); }).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);
  /** 任何请求回 423 → 回到解锁界面（闲置自动上锁） */
  const onError = useCallback((e: unknown) => {
    if (e instanceof VaultError && e.status === 423) { message.info('凭据库已自动锁定，请重新解锁'); refreshStatus(); return; }
    message.error((e as Error).message);
  }, [message, refreshStatus]);

  if (err) return <PageContainer title="凭据库" className="wm-page"><Result status="error" title="无法读取凭据库状态" subTitle={err} extra={<Button onClick={refreshStatus}>重试</Button>} /></PageContainer>;
  if (!status) return <PageContainer title="凭据库" className="wm-page"><Spin /></PageContainer>;
  if (!status.unlocked && !status.env_password) return <UnlockView status={status} onUnlocked={refreshStatus} />;
  return <UnlockedView status={status} onLocked={refreshStatus} onError={onError} />;
}

function UnlockView({ status, onUnlocked }: { status: VaultStatus; onUnlocked: () => void }) {
  const { message } = App.useApp();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = !status.exists;
  const mismatch = creating && pw2 !== '' && pw !== pw2;
  const ready = !!pw && (!creating || pw === pw2);
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    vaultApi.unlock(pw).then(() => { setPw(''); onUnlocked(); }).catch((e: Error) => message.error(e.message)).finally(() => setBusy(false));
  };
  return (
    <PageContainer title="凭据库" subTitle="加密保存账号、密码、TOTP、SSH、API Key 与 OAuth 令牌（dsh-vault 同款加密格式）" className="wm-page">
      <Card style={{ maxWidth: 480, margin: '40px auto' }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space><LockOutlined style={{ fontSize: 22 }} /><Typography.Title level={4} style={{ margin: 0 }}>{status.exists ? '凭据库已锁定' : '创建凭据库'}</Typography.Title></Space>
          <Typography.Text type="secondary">
            {creating
              ? '库文件还不存在：这次输入的主密码会用来创建新库。主密码无法找回，请妥善保管。'
              : `输入主密码解锁。主密码只保存在服务进程内存里${status.idle_lock_minutes > 0 ? `，闲置 ${status.idle_lock_minutes} 分钟后自动锁定` : ''}。`}
          </Typography.Text>
          <Input.Password autoFocus placeholder="主密码" value={pw} onChange={(e) => setPw(e.target.value)} onPressEnter={submit} autoComplete={creating ? 'new-password' : 'current-password'} />
          {creating ? <Input.Password placeholder="再输一次主密码" value={pw2} status={mismatch ? 'error' : undefined} onChange={(e) => setPw2(e.target.value)} onPressEnter={submit} autoComplete="new-password" /> : null}
          {mismatch ? <Typography.Text type="danger">两次输入不一致</Typography.Text> : null}
          <Button type="primary" block icon={<UnlockOutlined />} loading={busy} disabled={!ready} onClick={submit}>{creating ? '创建并解锁' : '解锁'}</Button>
          {status.shared_with_dsh ? <SharedWarning /> : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>库文件：<Typography.Text code>{status.path}</Typography.Text> · {status.upstream}</Typography.Text>
        </Space>
      </Card>
    </PageContainer>
  );
}

/** 与 DSH 插件共用库文件时的提醒：上游插件常驻一份内存库、写盘前不重读文件，两边同时写会互相覆盖 */
function SharedWarning() {
  return <Alert type="warning" showIcon message="与 DSH 插件共用同一个库文件" description="DSH 会话进程开着时，插件写入会用它内存里的旧数据覆盖整个文件，这里新增或修改的条目会丢失。请只在一边写；在这里改完后重启 DSH 会话再用 vault_* 工具。" />;
}

function UnlockedView({ status, onLocked, onError }: { status: VaultStatus; onLocked: () => void; onError: (e: unknown) => void }) {
  const [tab, setTab] = useState('entries');
  const [rows, setRows] = useState<VaultSummary[]>([]);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string>('');
  const [viewId, setViewId] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultEntry | 'new' | null>(null);
  const { message } = App.useApp();
  const closeView = useCallback(() => setViewId(null), []);

  const load = useCallback(() => {
    setLoading(true);
    vaultApi.list({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) }).then((r) => { setRows(r.entries); setStats(r.stats); }).catch(onError).finally(() => setLoading(false));
  }, [q, kind, onError]);
  useEffect(load, [load]);

  const lock = () => vaultApi.lock().then(onLocked).catch(onError);
  const openEdit = (id: string) => vaultApi.get(id).then(setEditing).catch(onError);
  const remove = (id: string) => vaultApi.remove(id).then(() => { message.success('已移入回收站'); load(); }).catch(onError);

  const columns: ColumnsType<VaultSummary> = [
    {
      title: '标题', dataIndex: 'title', width: 220,
      render: (_, r) => (
        <Space size={6}>
          {r.favorite ? <StarFilled style={{ color: '#D97706' }} /> : null}
          {r.icon ? <span>{r.icon}</span> : null}
          <Typography.Link onClick={() => setViewId(r.id)} style={{ fontWeight: 600 }}>{r.title}</Typography.Link>
        </Space>
      ),
    },
    { title: '类型', dataIndex: 'kind', width: 110, render: (k?: VaultKind) => <Tag color={KIND_COLOR[k ?? 'login']}>{KIND_LABEL[k ?? 'login']}</Tag> },
    { title: '账号', key: 'who', width: 160, render: (_, r) => r.username || r.email || r.phone || r.cardHolder || <Typography.Text type="secondary">—</Typography.Text> },
    { title: '地址', key: 'where', width: 220, ellipsis: true, render: (_, r) => (r.host ? <Typography.Text className="wm-mono">{r.host}{r.port ? `:${r.port}` : ''}</Typography.Text> : r.url ? <Typography.Text className="wm-mono" ellipsis={{ tooltip: r.url }}>{r.url}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>) },
    { title: '标签', dataIndex: 'tags', render: (t?: string[]) => (t?.length ? <Space size={2} wrap>{t.map((x) => <Tag key={x}>{x}</Tag>)}</Space> : null) },
    { title: '2FA', dataIndex: 'hasOtp', width: 64, render: (v?: boolean) => (v ? <Tag color="green">TOTP</Tag> : null) },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (v?: number) => <span className="wm-num">{fmtTime(v)}</span> },
    {
      title: '操作', key: 'op', width: 120,
      render: (_, r) => (
        <Space size={0}>
          <Tooltip title="编辑"><Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(r.id)} /></Tooltip>
          <Popconfirm title="移入回收站？" description="可在回收站恢复" onConfirm={() => remove(r.id)}>
            <Tooltip title="删除"><Button type="text" size="small" danger icon={<DeleteOutlined />} /></Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="凭据库"
      subTitle={<Tooltip title={`库文件：${status.path} · ${status.upstream}`}><span>{status.shared_with_dsh ? '与 DSH 插件共用库文件' : 'dsh-vault 同款加密格式'}</span></Tooltip>}
      className="wm-page"
      extra={[
        status.env_password ? <Tag key="env" color="default">主密码来自 DSH_VAULT_PASSWORD</Tag> : <Button key="lock" icon={<LockOutlined />} onClick={lock}>锁定</Button>,
        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>新增条目</Button>,
      ]}
    >
      {status.shared_with_dsh ? <div style={{ marginBottom: 12 }}><SharedWarning /></div> : null}
      <Card>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          destroyInactiveTabPane
          items={[
            {
              key: 'entries', label: `条目${stats ? ` ${stats.total}` : ''}`,
              children: (
                <>
                  <Space wrap style={{ marginBottom: 12 }}>
                    <Input.Search allowClear placeholder="检索标题/账号/主机/网址/标签（不搜密钥）" style={{ width: 340 }} onSearch={setQ} />
                    <Select allowClear placeholder="全部类型" style={{ width: 140 }} value={kind || undefined} onChange={(v) => setKind(v ?? '')} options={VAULT_KINDS.map((k) => ({ value: k, label: `${KIND_LABEL[k]}${stats?.byKind[k] ? ` · ${stats.byKind[k]}` : ''}` }))} />
                    {stats ? <Typography.Text type="secondary">含 TOTP {stats.withTotp} · 已过期 {stats.expired} · 回收站 {stats.trashCount}</Typography.Text> : null}
                  </Space>
                  <Table
                    rowKey="id" size="middle" loading={loading} dataSource={rows} columns={columns} scroll={{ x: 960 }} pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    locale={{ emptyText: <Empty description={q || kind ? '没有匹配的条目' : '还没有凭据'}>{!q && !kind ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>新增第一条凭据</Button> : null}</Empty> }}
                  />
                </>
              ),
            },
            { key: 'health', label: '安全体检', children: <HealthTab onError={onError} onOpen={setViewId} /> },
            { key: 'trash', label: `回收站${stats?.trashCount ? ` ${stats.trashCount}` : ''}`, children: <TrashTab onError={onError} onChanged={load} /> },
            { key: 'history', label: '活动记录', children: <HistoryTab onError={onError} /> },
          ]}
        />
      </Card>
      <EntryDrawer id={viewId} onClose={closeView} onEdit={(e) => { setViewId(null); setEditing(e); }} onError={onError} />
      {editing ? <EntryForm entry={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onError={onError} /> : null}
    </PageContainer>
  );
}

/** 密钥字段：默认打码，显示/复制要点一下 */
function SecretValue({ value, multiline }: { value: string; multiline?: boolean }) {
  const [shown, setShown] = useState(false);
  const { message } = App.useApp();
  const copy = () => navigator.clipboard.writeText(value).then(() => message.success('已复制')).catch(() => message.error('复制失败（浏览器未授权剪贴板）'));
  return (
    <Space align="start" size={4} style={{ width: '100%' }}>
      {shown
        ? <Typography.Text className="wm-mono" style={{ whiteSpace: multiline ? 'pre-wrap' : undefined, wordBreak: 'break-all', fontSize: 12 }}>{value}</Typography.Text>
        : <Typography.Text type="secondary">••••••••••</Typography.Text>}
      <Tooltip title={shown ? '隐藏' : '显示'}><Button type="text" size="small" icon={shown ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => setShown(!shown)} /></Tooltip>
      <Tooltip title="复制"><Button type="text" size="small" icon={<CopyOutlined />} onClick={copy} /></Tooltip>
    </Space>
  );
}

function TotpCode({ id, onError }: { id: string; onError: (e: unknown) => void }) {
  const [code, setCode] = useState<{ code: string; period: number; remaining: number } | null>(null);
  const timer = useRef<number>();
  useEffect(() => {
    let alive = true;
    const tick = () => vaultApi.totp(id).then((c) => {
      if (!alive) return;
      setCode(c);
      timer.current = window.setTimeout(tick, c.remaining * 1000 + 200);
    }).catch(onError);
    tick();
    return () => { alive = false; window.clearTimeout(timer.current); };
  }, [id, onError]);
  const [, force] = useState(0);
  useEffect(() => { const t = window.setInterval(() => force((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  if (!code) return <Spin size="small" />;
  const left = Math.max(0, code.period - (Math.floor(Date.now() / 1000) % code.period));
  return (
    <Space>
      <Typography.Text className="wm-mono" style={{ fontSize: 20, letterSpacing: 4 }} copyable={{ text: code.code }}>{code.code.slice(0, 3)} {code.code.slice(3)}</Typography.Text>
      <Progress type="circle" size={28} percent={(left / code.period) * 100} format={() => left} />
    </Space>
  );
}

function EntryDrawer({ id, onClose, onEdit, onError }: { id: string | null; onClose: () => void; onEdit: (e: VaultEntry) => void; onError: (e: unknown) => void }) {
  const [entry, setEntry] = useState<VaultEntry | null>(null);
  useEffect(() => {
    setEntry(null);
    if (id) vaultApi.get(id).then(setEntry).catch((e) => { onError(e); onClose(); });
  }, [id, onError, onClose]);
  const fields = entry ? (Object.keys(FIELD_LABEL) as (keyof VaultEntry)[]).filter((k) => entry[k] !== undefined && entry[k] !== '' && k !== 'otpSecret') : [];
  return (
    <Drawer open={!!id} onClose={onClose} width={560} title={entry?.title ?? '凭据'} destroyOnClose extra={entry ? <Button icon={<EditOutlined />} onClick={() => onEdit(entry)}>编辑</Button> : null}>
      {!entry ? <Spin /> : (
        <Descriptions column={1} size="small" bordered labelStyle={{ width: 130 }}>
          <Descriptions.Item label="类型"><Tag color={KIND_COLOR[entry.kind ?? 'login']}>{KIND_LABEL[entry.kind ?? 'login']}</Tag>{entry.sensitivity === 'high' ? <Tag color="red">高敏感</Tag> : null}</Descriptions.Item>
          {entry.otpSecret ? <Descriptions.Item label="动态验证码"><TotpCode id={entry.id} onError={onError} /></Descriptions.Item> : null}
          {fields.map((k) => (
            <Descriptions.Item key={k} label={FIELD_LABEL[k]}>
              {SECRET_FIELDS.has(k) ? <SecretValue value={String(entry[k])} multiline={MULTILINE.has(k)} />
                : k === 'expiresAt' ? fmtTime(entry.expiresAt)
                : k === 'url' ? <Typography.Text className="wm-mono" copyable>{entry.url}</Typography.Text>
                : k === 'notes' ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{entry.notes}</Typography.Paragraph>
                : <Typography.Text copyable>{String(entry[k])}</Typography.Text>}
            </Descriptions.Item>
          ))}
          {entry.otpSecret ? <Descriptions.Item label="TOTP 密钥"><SecretValue value={entry.otpSecret} /></Descriptions.Item> : null}
          {entry.tags?.length ? <Descriptions.Item label="标签">{entry.tags.map((t) => <Tag key={t}>{t}</Tag>)}</Descriptions.Item> : null}
          {entry.fields && Object.keys(entry.fields).length ? <Descriptions.Item label="自定义字段"><Typography.Text className="wm-mono" style={{ fontSize: 12 }}>{JSON.stringify(entry.fields)}</Typography.Text></Descriptions.Item> : null}
          {entry.attachments?.length ? <Descriptions.Item label="附件">{entry.attachments.map((a) => a.name).join('、')}（经 DSH 工具 vault_attachment 读取）</Descriptions.Item> : null}
          {entry.cookieCount ? <Descriptions.Item label="Cookie">{entry.cookieCount} 个（经 DSH 工具 vault_session_export 导出）</Descriptions.Item> : null}
          {entry.passwordHistoryCount ? <Descriptions.Item label="历史密码">{entry.passwordHistoryCount} 条</Descriptions.Item> : null}
          <Descriptions.Item label="创建 / 更新"><span className="wm-num">{fmtTime(entry.createdAt)} / {fmtTime(entry.updatedAt)}</span></Descriptions.Item>
        </Descriptions>
      )}
    </Drawer>
  );
}

function StrengthMeter({ password }: { password?: string }) {
  const [s, setS] = useState<Strength | null>(null);
  useEffect(() => {
    if (!password) { setS(null); return; }
    const t = window.setTimeout(() => { vaultApi.strength(password).then(setS).catch(() => setS(null)); }, 300);
    return () => window.clearTimeout(t);
  }, [password]);
  if (!s) return null;
  return (
    <Space size={8} style={{ marginTop: 4 }}>
      <Progress percent={s.score} steps={10} size="small" strokeColor={STRENGTH_COLOR[s.verdict]} showInfo={false} />
      <Typography.Text style={{ color: STRENGTH_COLOR[s.verdict], fontSize: 12 }}>{STRENGTH_LABEL[s.verdict]}（{s.score}）</Typography.Text>
      {s.feedback[0] && s.score < 70 ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.feedback[0]}</Typography.Text> : null}
    </Space>
  );
}

function GenerateButton({ onPick, onError }: { onPick: (pw: string) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [length, setLength] = useState(24);
  const [symbols, setSymbols] = useState(true);
  const [passphrase, setPassphrase] = useState(false);
  const run = () => vaultApi.generate(passphrase ? { passphrase: true, words: 5 } : { length, symbols }).then((r) => { onPick(r.password); setOpen(false); }).catch(onError);
  return (
    <>
      <Button icon={<ThunderboltOutlined />} onClick={() => setOpen(true)}>生成</Button>
      <Modal open={open} title="生成强密码" onCancel={() => setOpen(false)} onOk={run} okText="生成并填入" width={380}>
        <Space direction="vertical">
          <Space>口令短语（易记单词）<Switch checked={passphrase} onChange={setPassphrase} /></Space>
          {!passphrase ? <>
            <Space>长度 <InputNumber min={8} max={128} value={length} onChange={(v) => setLength(v ?? 24)} /></Space>
            <Space>包含符号 <Switch checked={symbols} onChange={setSymbols} /></Space>
          </> : <Typography.Text type="secondary">5 个单词，用 - 连接，末尾带两位数字</Typography.Text>}
        </Space>
      </Modal>
    </>
  );
}

function EntryForm({ entry, onClose, onSaved, onError }: { entry: VaultEntry | null; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const kind: VaultKind = Form.useWatch('kind', form) ?? entry?.kind ?? 'login';
  const password: string | undefined = Form.useWatch('password', form);
  const shown = useMemo(() => {
    const base = KIND_FIELDS[kind] ?? KIND_FIELDS.custom;
    // 编辑时：类型模板外但已有值的字段也显示，避免改不到
    const extra = entry ? (Object.keys(FIELD_LABEL) as (keyof VaultEntry)[]).filter((k) => k !== 'notes' && !base.includes(k) && entry[k] !== undefined && entry[k] !== '') : [];
    return [...base, ...extra];
  }, [kind, entry]);
  const initial = useMemo(() => (entry ? { ...entry, expiresAt: entry.expiresAt ? dayjs(entry.expiresAt).format('YYYY-MM-DDTHH:mm') : undefined } : { kind: 'login' }), [entry]);

  const submit = async () => {
    const v = await form.validateFields();
    const data: Record<string, unknown> = { title: v.title, kind: v.kind, tags: v.tags ?? [], notes: v.notes ?? '', favorite: Boolean(v.favorite) };
    for (const k of shown) {
      const val = v[k];
      if (k === 'expiresAt') data.expiresAt = val ? new Date(val).getTime() : 0;
      else if (entry) data[k] = val ?? ''; // 编辑：空串 = 清除该字段
      else if (val !== undefined && val !== '') data[k] = val;
    }
    if (!entry && (data.tags as string[]).length === 0) delete data.tags;
    setSaving(true);
    try {
      if (entry) await vaultApi.update(entry.id, data); else await vaultApi.create(data);
      message.success(entry ? '已保存' : '已新增');
      onSaved();
    } catch (e) { onError(e); } finally { setSaving(false); }
  };

  return (
    <Modal open title={entry ? `编辑：${entry.title}` : '新增凭据'} onCancel={onClose} onOk={submit} confirmLoading={saving} okText="保存" width={600} destroyOnClose>
      <Form form={form} layout="vertical" initialValues={initial} autoComplete="off">
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '标题必填' }]} style={{ flex: 1 }}><Input placeholder="例如 GitHub 个人账号" /></Form.Item>
          <Form.Item name="kind" label="类型" style={{ width: 150 }}><Select options={VAULT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} /></Form.Item>
        </Space.Compact>
        {shown.map((k) => {
          const label = FIELD_LABEL[k] ?? k;
          if (k === 'password') {
            return (
              <Form.Item key={k} label={label}>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="password" noStyle><Input.Password autoComplete="new-password" /></Form.Item>
                  <GenerateButton onPick={(pw) => form.setFieldValue('password', pw)} onError={onError} />
                </Space.Compact>
                <StrengthMeter password={password} />
              </Form.Item>
            );
          }
          if (k === 'expiresAt') return <Form.Item key={k} name={k} label={label}><Input type="datetime-local" /></Form.Item>;
          if (MULTILINE.has(k)) return <Form.Item key={k} name={k} label={label}><Input.TextArea rows={4} className="wm-mono" spellCheck={false} /></Form.Item>;
          if (SECRET_FIELDS.has(k)) return <Form.Item key={k} name={k} label={label} extra={k === 'otpSecret' ? 'Base32 密钥或 otpauth:// 链接（扫码页面里的「手动输入密钥」）' : undefined}><Input.Password autoComplete="off" /></Form.Item>;
          return <Form.Item key={k} name={k} label={label}><Input /></Form.Item>;
        })}
        <Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[',', ' ']} placeholder="回车添加" /></Form.Item>
        <Form.Item name="notes" label="备注"><Input.TextArea rows={2} /></Form.Item>
        <Form.Item name="favorite" label="收藏（置顶）" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}

function HealthTab({ onError, onOpen }: { onError: (e: unknown) => void; onOpen: (id: string) => void }) {
  const [h, setH] = useState<VaultHealth | null>(null);
  useEffect(() => { vaultApi.health().then(setH).catch(onError); }, [onError]);
  if (!h) return <Spin />;
  const color = h.verdict === 'good' ? '#059669' : h.verdict === 'fair' ? '#D97706' : '#DC2626';
  const list = (title: string, items: VaultSummary[], hint: string) => (
    <Card size="small" title={`${title}（${items.length}）`} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}>
      {items.length === 0 ? <Typography.Text type="secondary">无</Typography.Text> : <Space wrap>{items.map((e) => <Tag key={e.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(e.id)}>{e.title}</Tag>)}</Space>}
    </Card>
  );
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space size={24} align="center">
        <Progress type="dashboard" percent={h.score} strokeColor={color} format={(p) => <span style={{ color }}>{p}</span>} />
        <Space direction="vertical" size={2}>
          <Typography.Title level={4} style={{ margin: 0, color }}>{h.verdict === 'good' ? '良好' : h.verdict === 'fair' ? '一般' : '较差'}</Typography.Title>
          <Typography.Text type="secondary">密码强度：弱 {h.strength.weak} · 一般 {h.strength.fair} · 强 {h.strength.strong}</Typography.Text>
        </Space>
      </Space>
      {list('弱密码', h.weak, '短于 12 位')}
      <Card size="small" title={`复用的密码/密钥（${h.reused.length} 组）`} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>同一值出现在多个条目</Typography.Text>}>
        {h.reused.length === 0 ? <Typography.Text type="secondary">无</Typography.Text> : h.reused.map((g, i) => <div key={i} style={{ marginBottom: 4 }}><Typography.Text type="secondary">第 {i + 1} 组 · {g.count} 处：</Typography.Text>{g.entries.map((e) => <Tag key={e.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(e.id)}>{e.title}</Tag>)}</div>)}
      </Card>
      {list('未启用两步验证', h.no2fa, '有密码但没存 TOTP')}
      {list('不安全网址', h.httpSites, 'http:// 明文站点')}
      <Card size="small" title={`到期 / 待轮换（${h.rotation.length}）`}>
        {h.rotation.length === 0 ? <Typography.Text type="secondary">无</Typography.Text> : <Space wrap>{h.rotation.map((e) => <Tag key={e.id} color={e.due === 'expired' ? 'red' : e.due === 'due' ? 'orange' : 'gold'} style={{ cursor: 'pointer' }} onClick={() => onOpen(e.id)}>{e.title} · {e.due === 'expired' ? '已过期' : e.due === 'due' ? '该轮换' : `${e.daysLeft} 天内`}</Tag>)}</Space>}
      </Card>
    </Space>
  );
}

function TrashTab({ onError, onChanged }: { onError: (e: unknown) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<VaultSummary[] | null>(null);
  const { message } = App.useApp();
  const load = useCallback(() => { vaultApi.trash().then(setRows).catch(onError); }, [onError]);
  useEffect(load, [load]);
  const after = (msg: string) => () => { message.success(msg); load(); onChanged(); };
  return (
    <Table
      rowKey="id" size="middle" loading={rows === null} dataSource={rows ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }}
      locale={{ emptyText: <Empty description="回收站是空的" /> }}
      columns={[
        { title: '标题', dataIndex: 'title' },
        { title: '类型', dataIndex: 'kind', width: 110, render: (k?: VaultKind) => <Tag color={KIND_COLOR[k ?? 'login']}>{KIND_LABEL[k ?? 'login']}</Tag> },
        { title: '删除时间', dataIndex: 'deletedAt', width: 180, render: (v?: number) => <span className="wm-num">{fmtTime(v)}</span> },
        {
          title: '操作', key: 'op', width: 200,
          render: (_, r) => (
            <Space>
              <Button size="small" onClick={() => vaultApi.restore(r.id).then(after('已恢复')).catch(onError)}>恢复</Button>
              <Popconfirm title="永久删除？" description="从库文件中彻底移除，无法恢复" okButtonProps={{ danger: true }} onConfirm={() => vaultApi.purge(r.id).then(after('已永久删除')).catch(onError)}>
                <Button size="small" danger>永久删除</Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]}
    />
  );
}

function HistoryTab({ onError }: { onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<VaultEvent[] | null>(null);
  useEffect(() => { vaultApi.history().then(setRows).catch(onError); }, [onError]);
  return (
    <Table
      rowKey={(r) => `${r.at}-${r.action}-${r.id ?? ''}`} size="small" loading={rows === null} dataSource={rows ?? []} pagination={{ pageSize: 30, hideOnSinglePage: true }}
      locale={{ emptyText: <Empty description="暂无活动" /> }}
      columns={[
        { title: '时间', dataIndex: 'at', width: 180, render: (v: number) => <span className="wm-num">{fmtTime(v)}</span> },
        { title: '动作', dataIndex: 'action', width: 120, render: (a: string) => <Tag>{ACTION_LABEL[a] ?? a}</Tag> },
        { title: '条目 / 检索词', dataIndex: 'title', render: (t?: string) => t ?? '—' },
      ]}
    />
  );
}
