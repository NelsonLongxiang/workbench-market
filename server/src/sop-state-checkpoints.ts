/** #337: one per-run queue and an actual deadline for acknowledged hot writes. */
type Data = Record<string, unknown>;
export function createRunCheckpoints({ write, intervalMs = 30_000, onError = () => console.error('[sop-checkpoint] sqlite_write_failed') }: {
  write: (id: number, data: string) => void;
  intervalMs?: number;
  onError?: () => void;
}) {
  const states = new Map<number, { data: Data; dirty: boolean; at: number; timer?: ReturnType<typeof setTimeout> }>();
  const queues = new Map<number, Promise<unknown>>();
  let closing = false;
  function serial<T>(id: number, work: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('sop_state_closing'));
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(id, next);
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  }
  function flush(id: number): void {
    const item = states.get(id);
    if (!item?.dirty) return;
    write(id, JSON.stringify(item.data)); // failure retains the acknowledged snapshot
    if (item.timer) clearTimeout(item.timer);
    item.timer = undefined; item.dirty = false; item.at = Date.now();
  }
  function arm(id: number, delay: number): void {
    const item = states.get(id);
    if (!item || item.timer || !item.dirty) return;
    item.timer = setTimeout(() => {
      item.timer = undefined;
      void serial(id, async () => {
        try { flush(id); } catch { onError(); arm(id, intervalMs); }
      }).catch(() => onError());
    }, delay);
    item.timer.unref?.();
  }
  function remember(id: number, data: Data, force = false): void {
    let item = states.get(id);
    if (item) { item.data = structuredClone(data); item.dirty = true; }
    else { item = { data: structuredClone(data), dirty: true, at: 0 }; states.set(id, item); }
    const left = intervalMs - (Date.now() - item.at);
    if (force || left <= 0) {
      try { flush(id); } catch (error) { arm(id, intervalMs); throw error; }
    } else arm(id, left); // not a debounce: later edits never postpone the deadline
  }
  function peek(id: number): Data | undefined {
    const data = states.get(id)?.data;
    return data ? structuredClone(data) : undefined;
  }
  function forget(id: number): void {
    const timer = states.get(id)?.timer;
    if (timer) clearTimeout(timer);
    states.delete(id);
  }
  function flushAll(): void { for (const id of states.keys()) flush(id); }
  async function close(): Promise<void> {
    closing = true;
    await Promise.allSettled([...queues.values()]);
    flushAll();
    for (const id of states.keys()) forget(id);
  }
  return { serial, remember, peek, forget, flushAll, close };
}
