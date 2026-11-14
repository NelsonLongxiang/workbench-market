/** 「我处理过的（48 小时内）」：/attention 最下面一组，只给能把拍板记成经验的人（can.remember_knowledge）。数据是 GET /api/knowledge/remember/recent（#745）。
 *  一行一条：标题（没有标题写来源名）、答的是什么、什么时候答的、记没记过；没记过的「记成经验」在这一行里展开同样的三项，交了就变成「已记成经验」。
 *  条目的来源代号、编号不写在页面的字上。说法在 web/src/remember-view.ts。 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, List, Space, Tag, Typography } from 'antd';
import RelTime from './RelTime';
import RememberFields from './RememberFields';
import { ATTENTION_CHANGED, getRecentAnswers, postRememberLater } from '../api';
import { recentOf, recentTitle, rememberLaterResult, rememberPayload, rememberProblem, rememberedLabel, type RecentAnswer, type Visibility } from '../remember-view';

/** 状态标签用 antd 的预设色（success / error 这类在本站是深色块） */
const TONE: Record<string, string> = { success: 'green', warning: 'orange', error: 'red' };
const keyOf = (r: Pick<RecentAnswer, 'source' | 'source_id'>) => `${r.source}\u0000${r.source_id}`;

export default function RecentAnswers() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<RecentAnswer[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [lesson, setLesson] = useState('');
  const [cue, setCue] = useState('');
  const [vis, setVis] = useState<Visibility | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await getRecentAnswers();
    if (r.status === 200) { setRows(recentOf(r.body)); setFailed(false); } else { setRows([]); setFailed(r.status !== 403); }
  }, []);
  // 卡片上刚办完一件（会广播）：这里跟着重读，刚答的那条出现在最上面
  useEffect(() => {
    void load();
    const on = () => { void load(); };
    window.addEventListener(ATTENTION_CHANGED, on);
    return () => window.removeEventListener(ATTENTION_CHANGED, on);
  }, [load]);

  const start = (r: RecentAnswer) => { setOpen(keyOf(r)); setLesson(''); setCue(''); setVis(null); };
  const submit = async (r: RecentAnswer) => {
    setBusy(true);
    const p = rememberPayload(lesson, cue, vis ?? r.defaults.default_visibility);
    const res = await postRememberLater({ source: r.source, source_id: r.source_id, ...p });
    setBusy(false);
    const out = rememberLaterResult(res.status, res.body);
    if (out.ok) {
      setRows((cur) => (cur ?? []).map((x) => (keyOf(x) === keyOf(r) ? { ...x, remembered: out.status } : x)));
      setOpen(null);
      void (out.status === 'written' ? message.success(out.text) : message.warning(out.text));
    } else void message.error(out.text);
  };

  return <>
    <div className="wm-sub-h">我处理过的（48 小时内）{rows && rows.length > 0 && <span className="wm-sec-n">{rows.length}</span>}</div>
    <div className="wm-home-box" data-testid="recent-answers">
      {rows === null ? <Typography.Text type="secondary">正在读……</Typography.Text>
        : failed ? <Space><Typography.Text type="secondary">读不到你处理过的，稍后再试。</Typography.Text><Button size="small" onClick={() => void load()}>再试一次</Button></Space>
          : rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="48 小时内你没拍过板。拍板时勾上「把这次的取舍记成经验」，或者答完以后在这里补记。" />
            : <List dataSource={rows} rowKey={keyOf} renderItem={(r) => {
              const done = rememberedLabel(r.remembered);
              const here = open === keyOf(r);
              const block = here ? rememberProblem(lesson, cue, 'later') : null;
              return <List.Item data-testid="recent-row">
                <Space direction="vertical" size={8} className="wm-w-full">
                  <Space size={8} wrap>
                    <Typography.Text strong data-testid="recent-title">{recentTitle(r)}</Typography.Text>
                    {r.answer_text && <Tag>{r.answer_text}</Tag>}
                    {r.answered_at && <RelTime value={r.answered_at} />}
                    {done ? <Tag color={TONE[done.tone]} data-testid="recent-remembered">{done.text}</Tag>
                      : !here && <Button size="small" onClick={() => start(r)} data-testid="recent-remember">记成经验</Button>}
                  </Space>
                  {here && <>
                    <RememberFields defaults={r.defaults} lesson={lesson} cue={cue} visibility={vis} onLesson={setLesson} onCue={setCue} onVisibility={setVis} cuePlaceholder={recentTitle(r)} />
                    <Space size={8} wrap>
                      <Button type="primary" loading={busy} disabled={!!block} onClick={() => void submit(r)} data-testid="recent-submit">记下来</Button>
                      <Button onClick={() => setOpen(null)}>取消</Button>
                      {block && <Typography.Text type="secondary" className="wm-caption">{block}</Typography.Text>}
                    </Space>
                  </>}
                </Space>
              </List.Item>;
            }} />}
    </div>
  </>;
}
