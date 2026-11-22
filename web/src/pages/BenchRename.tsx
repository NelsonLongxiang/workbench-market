/** 视图台页面顶栏的「改名」（#905）：只有入口说 can.rename 的人看得到（和 PUT /title 同一个判法，只有管理层）。
 *  点开时记下当时看到的台名，提交带 base_title：别人在这之间改过，服务端回 409，照它的说法提示，给「重新读一次」。
 *  对话框开着的时候，页面在后台重新取了入口（切回标签页等），输入框不跟着变；只有点了「重新读一次」、而且这一次真取到了，才换成新名字。 */
import { useState } from 'react';
import { Alert, Button, Input, Modal, Space } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { renameBenchTitle, type BenchEntry } from '../api';
import { reloadOutcome, renameOutcome, showFromCard } from '../bench-page-view';

export default function BenchRename({ cardId, entry, refreshEntry }: { cardId: string; entry: BenchEntry; refreshEntry: () => Promise<BenchEntry | null> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'info' | 'warning' | 'error'; text: string; reload?: boolean } | null>(null);
  if (!entry.can.rename) return null;
  const show = () => { setValue(entry.bench.title); setBase(entry.bench.title); setMsg(null); setOpen(true); };
  const send = async (body: { title?: string; from_card?: true }) => {
    setBusy(true);
    const r = await renameBenchTitle(cardId, { ...body, base_title: base });
    const out = renameOutcome(r.status, r.body);
    setBusy(false);
    if (out.kind === 'ok') {
      if (!out.changed) { setMsg({ type: 'info', text: '名字没变' }); return; }
      setOpen(false); void refreshEntry();
      return;
    }
    setMsg({ type: out.kind === 'conflict' ? 'warning' : 'error', text: out.text, reload: out.kind === 'conflict' });
  };
  // 「重新读一次」：等这一次取完，取到了才把输入框和 base 换成新名字（这是用户要的覆盖）；没取到只说一句，输入框不动
  const reload = async () => {
    const out = reloadOutcome(await refreshEntry());
    if (out.title !== null) { setValue(out.title); setBase(out.title); }
    setMsg({ type: out.type, text: out.text, reload: out.title === null });
  };
  const trimmed = value.trim();
  return (
    <>
      <Button type="text" size="small" icon={<EditOutlined />} onClick={show} data-testid="bench-page-rename">改名</Button>
      <Modal open={open} title="改台名" onCancel={() => setOpen(false)} destroyOnClose maskClosable={!busy} data-testid="bench-rename-dialog"
        footer={[
          showFromCard(entry)
            ? <Button key="card" disabled={busy} onClick={() => void send({ from_card: true })} data-testid="bench-rename-from-card">用卡片现在的名字（{entry.bench.card_title}）</Button>
            : null,
          <Button key="cancel" disabled={busy} onClick={() => setOpen(false)}>取消</Button>,
          <Button key="ok" type="primary" loading={busy} disabled={!trimmed || trimmed.length > 64} onClick={() => void send({ title: trimmed })} data-testid="bench-rename-save">保存</Button>,
        ]}>
        <Space direction="vertical" className="wm-w-full">
          <Input value={value} maxLength={64} showCount onChange={(e) => setValue(e.target.value)} onPressEnter={() => { if (trimmed && !busy) void send({ title: trimmed }); }} data-testid="bench-rename-input" aria-label="台的名字" />
          {msg ? (
            <Alert type={msg.type} showIcon message={msg.text} data-testid="bench-rename-msg"
              action={msg.reload ? <Button size="small" onClick={() => void reload()} data-testid="bench-rename-reload">重新读一次</Button> : undefined} />
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
