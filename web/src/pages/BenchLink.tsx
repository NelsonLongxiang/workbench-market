/** #1086 台页面顶栏的「对应卡片」：管理层看得到这个台对应哪张主页卡片，能选一张对应上或去掉对应。
 *  走现有的 PUT /api/bench-views/<台>/workbench，判权不变（和改台名同一个判法，所以照 can.rename 显示）。 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Modal, Select, Space, Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { api, linkBenchCard, type BenchEntry } from '../api';
import { cardOptions, linkOutcome } from '../bench-link-view';

export default function BenchLink({ cardId, entry, refreshEntry }: { cardId: string; entry: BenchEntry; refreshEntry: () => Promise<BenchEntry | null> }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<{ value: number; label: string }[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!entry.can.rename) return null;
  const cur = entry.bench.workbench_id;
  const show = async () => {
    setPick(cur); setMsg(null); setCards(null); setOpen(true);
    try { setCards(cardOptions(await api.listWorkbenches())); } catch { setCards([]); setMsg('读不到卡片清单，稍后再试。'); }
  };
  const send = async (wb: number | null) => {
    setBusy(true);
    const r = await linkBenchCard(entry.bench.slug, wb);
    const out = linkOutcome(r.status, r.body);
    setBusy(false);
    if (out.kind === 'error') { setMsg(out.text); return; }
    setOpen(false);
    // 页面是按卡片 id 打开的：对应换了或去掉了，这个卡片 id 不一定还指向这个台——换成按台标识打开，留在这个台上
    if (cardId !== entry.bench.slug) nav(`/use/${encodeURIComponent(entry.bench.slug)}`, { replace: true });
    else void refreshEntry();
  };
  return (
    <>
      <Button type="text" size="small" icon={<LinkOutlined />} onClick={() => void show()} data-testid="bench-page-link">对应卡片</Button>
      <Modal open={open} title="对应卡片" onCancel={() => setOpen(false)} destroyOnClose maskClosable={!busy} data-testid="bench-link-dialog"
        footer={[
          cur !== null ? <Button key="unlink" danger disabled={busy} onClick={() => void send(null)} data-testid="bench-link-remove">去掉对应</Button> : null,
          <Button key="cancel" disabled={busy} onClick={() => setOpen(false)}>取消</Button>,
          <Button key="ok" type="primary" loading={busy} disabled={pick === null || pick === cur} onClick={() => void send(pick)} data-testid="bench-link-save">保存</Button>,
        ]}>
        <Space direction="vertical" className="wm-w-full">
          <Typography.Text data-testid="bench-link-current">{cur !== null ? `现在对应的卡片：${entry.bench.card_title || '（卡片没有名字）'}` : '还没对应卡片：主页上的卡片点进来打不开这个台。'}</Typography.Text>
          <Select className="wm-w-full" showSearch optionFilterProp="label" loading={cards === null} value={pick ?? undefined} placeholder="选一张卡片"
            options={cards ?? []} onChange={(v) => setPick(typeof v === 'number' ? v : null)} data-testid="bench-link-select" />
          <Typography.Text type="secondary">对应以后，从主页点这张卡片直接进到这个台；一张卡片只能对应一个台。只改对应关系，不改谁进得来。</Typography.Text>
          {msg ? <Alert type="warning" showIcon message={msg} data-testid="bench-link-msg" /> : null}
        </Space>
      </Modal>
    </>
  );
}
