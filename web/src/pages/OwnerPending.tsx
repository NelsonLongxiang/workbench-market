import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, App, Button, Form, Input, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { adminActive, apiFetch, loginRequired, odooAdmin, redirectToLogin, subscribeAdminToken } from '../admin-token';
import { api } from '../api';
import WmPage from '../components/WmPage';
import { answerBody, buildBoard, configRevisionBody, findBoardWorkbench, parseConfig, type Anomaly, type BoardConfig, type BoardRow, type BoardVar } from '../owner-pending';

const STATUS: Record<BoardRow['status'], { text: string; color: string }> = {
  open: { text: '待办', color: 'gold' },
  history: { text: '历史答复', color: 'blue' },
  answered: { text: '已答复', color: 'green' },
  withdrawn: { text: '撤回', color: 'default' },
};
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

/** 属主写入只带浏览器的 Odoo 会话、不带管理员口令：口令是共享身份，写出来的常量没有作者，看板不认 */
async function ownerPut(id: number, key: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`/api/workbenches/${id}/vars/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
  });
  if (loginRequired(r)) { redirectToLogin(); throw new Error('需要登录：正在前往登录页'); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(`${j.message || j.error || '写入失败'}（HTTP ${r.status}）`);
  }
}

export default function OwnerPending() {
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const viewer = useSyncExternalStore(subscribeAdminToken, odooAdmin);
  const { message } = App.useApp();
  const [boardId, setBoardId] = useState<number | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [answering, setAnswering] = useState<BoardRow | null>(null);
  const [draft, setDraft] = useState('');
  const [writers, setWriters] = useState('mcp:owner-board');
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(false);
  const [writersDraft, setWritersDraft] = useState('');

  const load = useCallback(async () => {
    if (!admin) return;
    setLoading(true); setError('');
    try {
      const found = findBoardWorkbench(await api.listWorkbenches(), window.location.origin);
      if ('error' in found) { setBoardId(null); setConfig(null); setRows([]); setAnomalies([]); setError(found.error); return; }
      setBoardId(found.id);
      const r = await apiFetch(`/api/workbenches/${found.id}/vars`);
      const j = await r.json() as { items?: BoardVar[]; error?: string };
      if (!r.ok || !Array.isArray(j.items)) throw new Error(j.error || `读取看板失败（HTTP ${r.status}）`);
      const cfg = parseConfig(j.items.find((v) => v.key === 'config.owner'));
      if (cfg && 'error' in cfg) { setConfig(null); setRows([]); setAnomalies([]); setError(cfg.error); return; }
      setConfig(cfg);
      if (!cfg) { setRows([]); setAnomalies([]); return; }
      const board = buildBoard(j.items, cfg);
      setRows(board.rows); setAnomalies(board.anomalies);
    } catch (e) {
      setRows([]); setAnomalies([]); setError(e instanceof Error ? e.message : '读取看板失败');
    } finally { setLoading(false); }
  }, [admin]);
  useEffect(() => { void load(); }, [load]);

  const isOwner = !!config && viewer === config.ownerLogin;

  const register = async () => {
    if (!boardId || !viewer) return;
    const list = writers.split(/[\s,，]+/).map((w) => w.trim()).filter(Boolean);
    if (!list.length || !list.every((w) => /^mcp:[^\s]{1,128}$/.test(w))) { void message.warning('登记身份写成 mcp:<会话名>，多个用逗号隔开'); return; }
    setBusy(true);
    try {
      await ownerPut(boardId, 'config.owner', { value: { owner_login: viewer, writers: list }, kind: 'const', reason: '属主登记看板' });
      void message.success('已登记');
      await load();
    } catch (e) { void message.error(e instanceof Error ? e.message : '登记失败'); }
    finally { setBusy(false); }
  };

  // 轮换登记身份：属主本人修订 config.owner（override + 当前 revision），写完回读核对
  const reviseWriters = async () => {
    if (!boardId || !config) return;
    const body = configRevisionBody(config, writersDraft.split(/[\s,，]+/));
    if ('error' in body) { void message.warning(String(body.error)); return; }
    setBusy(true);
    try {
      await ownerPut(boardId, 'config.owner', body);
      const r = await apiFetch(`/api/workbenches/${boardId}/vars/config.owner`);
      const back = parseConfig(await r.json() as BoardVar);
      const want = JSON.stringify((body.value as { writers: string[] }).writers);
      if (!back || 'error' in back || JSON.stringify(back.writers) !== want) throw new Error('回读核对不一致，请刷新后检查');
      void message.success('登记身份已修订');
      setRevising(false);
      await load();
    } catch (e) { void message.error(e instanceof Error ? e.message : '修订失败'); }
    finally { setBusy(false); }
  };

  const submitAnswer = async () => {
    if (!boardId || !answering) return;
    if (!draft.trim()) { void message.warning('写一句答复'); return; }
    setBusy(true);
    try {
      const existing = answering.answer && !answering.answer.historical ? answering.answer.revision : null;
      await ownerPut(boardId, `answer.${answering.no}`, answerBody(draft, today(), existing));
      void message.success(`第 ${answering.no} 项已答复`);
      setAnswering(null);
      await load();
    } catch (e) { void message.error(e instanceof Error ? e.message : '答复失败'); }
    finally { setBusy(false); }
  };

  const columns = [
    { title: '#', dataIndex: 'no', width: 56 },
    { title: '状态', dataIndex: 'status', width: 84, render: (s: BoardRow['status']) => <Tag color={STATUS[s].color}>{STATUS[s].text}</Tag> },
    { title: '问题', dataIndex: 'question', render: (q: string, r: BoardRow) => <Space direction="vertical" size={2}>
      <span>{q}</span>
      {r.answer && <Typography.Text type="secondary" className="wm-caption">{r.answer.historical ? '历史答复（登记身份记入，未经本页确认）' : '属主答复'}（{r.answer.date || '日期未记'}）：{r.answer.summary}</Typography.Text>}
      {r.withdrawn && <Typography.Text type="secondary" className="wm-caption">由 {r.withdrawn.by} 撤回{r.withdrawn.reason ? `：${r.withdrawn.reason}` : '（未写原因）'}</Typography.Text>}
    </Space> },
    { title: '已查过哪里', dataIndex: 'checked', width: 220 },
    { title: '等谁', dataIndex: 'waitingFor', width: 90 },
    { title: '首次提出', dataIndex: 'firstRaised', width: 110 },
    { title: '最近变化', dataIndex: 'lastChange', width: 110 },
    { title: '来源', dataIndex: 'source', width: 140 },
    ...(isOwner ? [{ title: '', key: 'op', width: 100, render: (_: unknown, r: BoardRow) => r.status === 'withdrawn' ? null
      : r.answerTakenBy ? <Tooltip title={`答复编号已被「${r.answerTakenBy}」占用，要在部署机本机用命令行清理后才能答复`}><Button size="small" disabled>答复</Button></Tooltip>
      : <Button size="small" type={r.status === 'open' ? 'primary' : 'default'} onClick={() => { setAnswering(r); setDraft(r.answer && !r.answer.historical ? r.answer.summary : ''); }}>{r.answer && !r.answer.historical ? '改答复' : '答复'}</Button> }] : []),
  ];

  return <WmPage>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary" className="wm-caption">
        本页答复由属主本人的 Odoo 登录写入，可作为属主对该事项的答复；涉及生产或不可逆动作的授权，仍须在授权登记表里引用本条答复登记后才生效。
      </Typography.Text>
      {!admin && <Alert type="info" showIcon message="请先确认管理员身份" description="用 Odoo 管理员账号登录后查看；答复只认属主本人的 Odoo 登录，不认管理员口令。" />}
      {config && <Alert type="warning" showIcon message={<span>本看板属主：<b>odoo:{config.ownerLogin}</b> · 登记身份：{config.writers.join('、')}</span>}
        description="只采信属主本人的答复和登记身份写的事项。上面的属主如果不是属主本人，本看板作废：请在部署机本机用命令行清理 config.owner 后由属主重新登记。"
        action={isOwner ? <Button size="small" onClick={() => { setWritersDraft(config.writers.join(', ')); setRevising(true); }}>修订登记身份</Button> : undefined} />}
      {admin && !viewer && <Alert type="info" showIcon message="当前是管理员口令身份：可以查看，不能答复" description="答复要用属主本人的 Odoo 管理员账号登录。" />}
      {error && <Alert type="error" showIcon message={error} />}
      {admin && boardId && !config && !error && (viewer
        ? <Alert type="warning" showIcon message="看板还没登记属主" description={<Space direction="vertical">
            <span>只有属主本人能登记，登记后本页只认你（odoo:{viewer}）的答复，以及下面这些登记身份写的事项。</span>
            <Form.Item label="登记身份" style={{ marginBottom: 0 }}><Input aria-label="登记身份" value={writers} onChange={(e) => setWriters(e.target.value)} autoComplete="off" style={{ width: 360 }} /></Form.Item>
            <Button type="primary" loading={busy} onClick={() => void register()}>我是属主，登记</Button>
          </Space>} />
        : <Alert type="warning" showIcon message="看板还没登记属主" description="需要属主本人用 Odoo 管理员账号打开本页完成登记。" />)}
      {anomalies.length > 0 && <Alert type="warning" showIcon message={`${anomalies.length} 条记录来源不符，未采信`} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{anomalies.map((a) => <li key={a.key}><code>{a.key}</code>：{a.reason}</li>)}</ul>} />}
      {config && <Table<BoardRow> rowKey="no" size="middle" loading={loading} columns={columns} dataSource={rows} pagination={false}
        locale={{ emptyText: '没有待属主的事项' }} scroll={{ x: 1100 }} />}
    </Space>
    <Modal open={!!answering} title={answering ? `答复第 ${answering.no} 项` : ''} okText="提交答复" cancelText="取消" confirmLoading={busy}
      onOk={() => void submitAnswer()} onCancel={() => setAnswering(null)} destroyOnClose>
      <Typography.Paragraph>{answering?.question}</Typography.Paragraph>
      <Input.TextArea aria-label="答复" rows={4} maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="一句话答复，不写凭证或访问细节" />
    </Modal>
    <Modal open={revising} title="修订登记身份" okText="保存" cancelText="取消" confirmLoading={busy} onOk={() => void reviseWriters()} onCancel={() => setRevising(false)} destroyOnClose>
      <Typography.Paragraph>轮换会话：先在「MCP 网关」页建好新会话，把它加进来并保存；确认新会话写入正常后，再到「MCP 网关」页吊销旧会话。旧会话吊销后可以留在列表里——它写过的事项照常采信，吊销后它也写不进新内容；只有怀疑旧令牌泄露、要作废它写过的内容时才从这里去掉。</Typography.Paragraph>
      <Input aria-label="登记身份列表" value={writersDraft} onChange={(e) => setWritersDraft(e.target.value)} placeholder="mcp:owner-board, mcp:owner-board-2" autoComplete="off" />
    </Modal>
  </WmPage>;
}
