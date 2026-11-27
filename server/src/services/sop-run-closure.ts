import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const CLOSE_REASON = '无步骤且 14 天未动，按 #1087 收口';
const AGE_MS = 14 * 24 * 60 * 60_000;
const BATCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
type Run = { id: number; sop_slug: string; sop_version: number; status: string; data: string; cache_revision: number;
  hot_pending: number; started_at: string; updated_at: string; finished_at: string };
type Entry = { id: number; fingerprint: string };
type Group = { sop_slug: string; entries: Entry[] };

function time(value: string): number {
  // SQLite stores UTC without a zone; only accept that shape or an explicit ISO time zone.
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)) return Date.parse(value.replace(' ', 'T') + 'Z');
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return Date.parse(value);
  return NaN;
}

function emptyData(data: string): boolean {
  try {
    const value = JSON.parse(data);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

function fingerprint(run: Run): string {
  return createHash('sha256').update(JSON.stringify([run.sop_slug, run.sop_version, run.data, run.cache_revision,
    run.hot_pending, run.started_at, run.updated_at, run.finished_at])).digest('hex');
}

function candidateGroups(db: DatabaseSync, now: number): Group[] {
  const cutoff = now - AGE_MS;
  const rows = db.prepare("SELECT id, sop_slug, sop_version, status, data, cache_revision, hot_pending, started_at, updated_at, finished_at FROM sop_runs WHERE status = 'running' AND hot_pending = 0 AND finished_at = '' ORDER BY sop_slug, id");
  const groups = new Map<string, Group>();
  for (const row of rows.iterate() as Iterable<Run>) {
    if (!(Math.max(time(row.started_at), time(row.updated_at)) < cutoff && emptyData(row.data))) continue;
    const group = groups.get(row.sop_slug) ?? { sop_slug: row.sop_slug, entries: [] };
    // The existing cache trigger increments the revision once when status changes.
    group.entries.push({ id: row.id, fingerprint: fingerprint({ ...row, cache_revision: row.cache_revision + 1 }) });
    groups.set(row.sop_slug, group);
  }
  return [...groups.values()];
}

function distribution(groups: Group[]) {
  const by_sop = groups.map(({ sop_slug, entries }) => ({ sop_slug, runs: entries.length }));
  return { matched: by_sop.reduce((sum, group) => sum + group.runs, 0), by_sop };
}

export function previewStaleSopRuns(db: DatabaseSync, now = Date.now()) {
  return { mode: 'dry-run', reason: CLOSE_REASON, before: new Date(now - AGE_MS).toISOString(), ...distribution(candidateGroups(db, now)) };
}

function changeBatch(db: DatabaseSync, action: 'close' | 'undo', batch: string, groups: Group[], now: number) {
  const from = action === 'close' ? 'running' : 'expired';
  const to = action === 'close' ? 'expired' : 'running';
  const update = db.prepare('UPDATE sop_runs SET status = ? WHERE id = ? AND status = ?');
  const append = db.prepare('INSERT INTO sop_run_closure_events (batch, action, sop_slug, entries_json, run_count, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const at = new Date(now).toISOString();
  for (const { sop_slug, entries } of groups) {
    for (const { id } of entries) {
      if (update.run(to, id, from).changes !== 1) throw new Error('运行状态已变化，批次未执行');
    }
    append.run(batch, action, sop_slug, JSON.stringify(entries), entries.length, CLOSE_REASON, at);
  }
  const summary = distribution(groups);
  return { mode: action, batch, reason: CLOSE_REASON, changed: summary.matched, ...summary };
}

/** Only the offline operator command calls this. The caller must first quiesce market writers. */
export function updateStaleSopRuns(db: DatabaseSync, action: 'close' | 'undo', batch: string, now = Date.now()) {
  if (!BATCH_RE.test(batch)) throw new Error('批次号须为 1 至 64 位字母、数字、点、下划线或连字符，且以字母或数字开头');
  db.exec('BEGIN IMMEDIATE');
  try {
    const events = db.prepare('SELECT action, sop_slug, entries_json FROM sop_run_closure_events WHERE batch = ? ORDER BY sop_slug').all(batch) as { action: 'close' | 'undo'; sop_slug: string; entries_json: string }[];
    const original: Group[] = events.filter(row => row.action === 'close').map(({ sop_slug, entries_json }) => ({ sop_slug, entries: JSON.parse(entries_json) as Entry[] }));
    const undone = events.some(row => row.action === 'undo');
    if (action === 'close' && undone) throw new Error('该批次已撤销，请使用新的批次号');
    if (action === 'undo' && original.length === 0) throw new Error('找不到已执行的收口批次');

    let result;
    if ((action === 'close' && original.length) || undone) {
      result = { mode: action, batch, reason: CLOSE_REASON, changed: 0, ...distribution(original), repeated: true };
    } else if (action === 'close') {
      result = changeBatch(db, action, batch, candidateGroups(db, now), now);
    } else {
      const lookup = db.prepare('SELECT id, sop_slug, sop_version, status, data, cache_revision, hot_pending, started_at, updated_at, finished_at FROM sop_runs WHERE id = ?');
      for (const group of original) {
        for (const entry of group.entries) {
          const run = lookup.get(entry.id) as Run | undefined;
          if (!run || run.status !== 'expired' || fingerprint(run) !== entry.fingerprint) {
            throw new Error('批次内有运行已变动，撤销未执行');
          }
        }
      }
      result = changeBatch(db, action, batch, original, now);
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function staleSopRunEvents(db: DatabaseSync, slug: string) {
  return db.prepare('SELECT batch, action, run_count, reason, at FROM sop_run_closure_events WHERE sop_slug = ? ORDER BY at DESC, id DESC LIMIT 50').all(slug);
}
