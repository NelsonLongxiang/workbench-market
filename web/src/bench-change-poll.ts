/**
 * 数据视图的实时刷新（docs/task-graph-step1.md 第五节之六）：页面可见时每 5 秒问一次变更游标，变了才重新取数。
 * 游标只覆盖台库与视图；工作台变量变了不触发（第 1 步靠换视图、换筛选或点刷新）。
 * 401、403、404、数据视图未开启：立刻停，交给页面收起旧结果；断网或 5xx：保留旧图，按 5、10、20、40、60 秒退避，成功后恢复 5 秒。
 * 每次轮询带发出时的代号；台、游标或开关变了代号就换，晚到的回答一律丢弃。
 */
import { useEffect, useRef, useState } from 'react';
import { getBenchChanges } from './api';
import { nextDelay, pollAction, POLL_MS } from './bench-page-view';


/**
 * bench：台；cursor：当前画着的这份结果带的游标（没有就不轮询）；active：当前结果对应当前视图和筛选、且没有正在取数。
 * onChanged：游标变了（页面去重新取数）；onStop：没权限、台没了或未开启（页面收起旧结果）。返回 paused：自动刷新暂停中。
 */
export function useChangePoll(opts: { bench: string; cursor: string | null | undefined; active: boolean; onChanged: () => void; onStop: (status: number, error?: string) => void }): { paused: boolean } {
  const { bench, cursor, active } = opts;
  const cb = useRef(opts); cb.current = opts;
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    setPaused(false);
    if (!active || !cursor) return;
    let gone = false, timer: ReturnType<typeof setTimeout> | null = null, failures = 0;
    const schedule = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void poll(); }, ms); };
    const poll = async () => {
      timer = null;
      if (gone || document.visibilityState !== 'visible') return;
      const r = await getBenchChanges(bench);
      if (gone) return; // 台、游标或开关已经变了：这份回答作废
      const act = pollAction(r.status, r.error);
      if (act === 'stop') { gone = true; cb.current.onStop(r.status, r.error); return; }
      if (act === 'retry') { failures++; setPaused(true); schedule(nextDelay(failures)); return; }
      failures = 0; setPaused(false);
      if (r.cursor !== cursor) { gone = true; cb.current.onChanged(); return; }
      schedule(POLL_MS);
    };
    const onVis = () => { if (document.visibilityState === 'visible') { if (!timer) void poll(); } else if (timer) { clearTimeout(timer); timer = null; } };
    document.addEventListener('visibilitychange', onVis);
    schedule(POLL_MS);
    return () => { gone = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [bench, cursor, active]);
  return { paused };
}
