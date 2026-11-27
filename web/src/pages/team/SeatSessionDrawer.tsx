import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Input, Popconfirm, Skeleton, Space } from 'antd';
import { readSeatSession, sendSeatAction, type SeatAction, type SeatTarget, type SessionPage } from '../../seat-session';

export default function SeatSessionDrawer({ target, name, onClose }: { target: SeatTarget; name: string; onClose: () => void }) {
  const { host, team, seat, seat_id } = target;
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<SessionPage | null>(null);
  const [reading, setReading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [input, setInput] = useState('');
  const command = useRef<AbortController | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => () => command.current?.abort(), []);
  useEffect(() => {
    // 拒绝后禁用发起操作的按钮，焦点仍留在抽屉内。
    if (notice && !notice.ok && !page) feedback.current?.focus();
  }, [notice, page]);
  useEffect(() => {
    const read = new AbortController();
    setReading(true); setPage(null); setReadError('');
    void readSeatSession({ host, team, seat, seat_id }, before, read.signal).then(result => {
      if (read.signal.aborted) return;
      setReading(false);
      if (result.ok) setPage(result.data);
      else setReadError(result.text);
    });
    return () => read.abort();
  }, [host, team, seat, seat_id, before, refresh]);
  const disabled = reading || writing || !page;
  const tooLong = [...input].length > 8000;
  const canSend = !disabled && input.trim() !== '' && !tooLong;

  async function submit(action: SeatAction) {
    if (disabled || command.current) return;
    const pending = new AbortController();
    command.current = pending;
    setWriting(true); setNotice(null);
    const result = await sendSeatAction(target, action, pending.signal);
    if (pending.signal.aborted) return;
    command.current = null;
    setWriting(false);
    setNotice({ ok: result.ok, text: result.ok ? result.data : result.text });
    if (result.ok && action.action !== 'stop') setInput('');
    if (!result.ok && result.unavailable) setPage(null);
  }

  function move(next: number[]) {
    setReading(true); setPage(null); setNotice(null); setCursors(next);
  }

  return (
    <Drawer open title={name + ' · 席位会话'} onClose={onClose} width="min(100vw, 600px)">
      <Space direction="vertical" size="middle" className="wm-seat-session" data-testid="seat-session-panel">
        <Space wrap>
          <Button size="small" disabled={reading || writing || !page?.from} onClick={() => page && move([...cursors, page.from])}>更早</Button>
          <Button size="small" disabled={reading || writing || !cursors.length} onClick={() => move(cursors.slice(0, -1))}>较新一页</Button>
          <Button size="small" disabled={reading || writing} onClick={() => { move([]); setRefresh(n => n + 1); }}>刷新最新</Button>
          {page && <span data-testid="seat-session-range">{page.entries.length ? '第 ' + (page.from + 1) + '–' + page.to + ' 条，共 ' + page.total + ' 条' : '暂无会话内容'}</span>}
        </Space>
        {readError && <Alert showIcon type="warning" message={readError} data-testid="seat-session-read-error" />}
        {reading && <Skeleton active paragraph={{ rows: 2 }} />}
        {page?.stale && <Alert showIcon type="info" message="节点返回的是旧内容，可刷新查看。" />}
        {page && page.entries.length > 0 && <ol className="wm-seat-session-entries" aria-label="会话内容">
          {page.entries.map(entry => <li key={entry.i} className="wm-seat-session-entry" data-testid="seat-session-entry">
            <strong>{entry.role === 'user' ? '用户' : '席位'}</strong>
            <div>{entry.text}</div>
          </li>)}
        </ol>}
        <Input.TextArea aria-label="发给席位的内容" placeholder="输入要发给席位的内容" value={input} disabled={disabled}
          onChange={event => setInput(event.target.value)} autoSize={{ minRows: 2, maxRows: 6 }} status={tooLong ? 'error' : undefined} />
        {tooLong && <Alert type="warning" message="一次最多发送 8000 字。" />}
        <Space wrap>
          <Button type="primary" disabled={!canSend} onClick={() => void submit({ action: 'steer', text: input })}>发给当前轮</Button>
          <Button disabled={!canSend} onClick={() => void submit({ action: 'queue', text: input })}>加入队列</Button>
          <Popconfirm title="停止当前轮？" description="已排队的内容会保留。" okText="停止" cancelText="取消" onConfirm={() => submit({ action: 'stop' })}>
            <Button danger disabled={disabled}>停止当前轮</Button>
          </Popconfirm>
        </Space>
        {writing && <span role="status">正在提交操作…</span>}
        {notice && <div ref={feedback} tabIndex={-1}><Alert showIcon type={notice.ok ? 'success' : 'warning'} message={notice.text} data-testid="seat-session-action-result" /></div>}
      </Space>
    </Drawer>
  );
}
