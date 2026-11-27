import type { LcObject, LcType } from './home-view';

export type LifecycleReply = {
  status: number;
  body: unknown;
  identityDown?: boolean;
  retryAt?: number;
  requestId?: string;
};
type FailureKind = 'not-installed' | 'unavailable' | 'unknown' | 'login' | 'forbidden' | 'identity-down';
export type LifecycleFailure = { kind: FailureKind; retryAt?: number; requestId?: string };
export type LifecycleTime = { asOf?: string; lastOk?: string; stale: boolean };
type LifecycleSnapshot<T> = { value: T; time: LifecycleTime };
export type LifecycleResult<T> = LifecycleFailure | (LifecycleSnapshot<T> & { kind: 'ok' | 'stale' });

/** A complete stale reply is a historical snapshot even on the first request. */
export function historicalLifecycleSnapshot<T>(result: LifecycleResult<T> | null, lastGood: LifecycleSnapshot<T> | null): LifecycleSnapshot<T> | null {
  if (result?.kind !== 'stale') return null;
  if (!lastGood) return result;
  // Compare the effective data times when both are known. On a tie, keep the
  // last complete live read, which may cover more than the degraded source.
  const asOf = result.time.asOf ?? result.time.lastOk;
  const lastAsOf = lastGood.time.asOf ?? lastGood.time.lastOk;
  return asOf && (!lastAsOf || Date.parse(asOf) > Date.parse(lastAsOf)) ? result : lastGood;
}
export type LifecycleRead = (path: string) => Promise<LifecycleReply>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function lifecycleRetryAt(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(deadline) && deadline > now ? deadline : undefined;
}

function knownTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function freshness(payload: Record<string, unknown>, data = payload): LifecycleTime {
  const staleCount = record(data.summary)?.sources_stale;
  return {
    asOf: knownTime(data.as_of) ?? knownTime(payload.as_of),
    lastOk: knownTime(data.last_ok ?? data.last_ok_at) ?? knownTime(payload.last_ok ?? payload.last_ok_at),
    stale: payload.stale === true || data.stale === true || (count(staleCount) && staleCount > 0)
      || (Array.isArray(data.sources) && data.sources.some((source) => record(source)?.stale === true)),
  };
}

function response(reply: LifecycleReply, legacyStages = false): LifecycleFailure | { kind: 'json'; value: Record<string, unknown> } {
  const { status, identityDown, retryAt, requestId } = reply;
  const body = record(reply.body);
  const code = body?.code ?? record(body?.error)?.code ?? body?.error;
  const fail = (kind: FailureKind): LifecycleFailure => ({ kind, retryAt, requestId });
  if (status === 401) return fail('login');
  if (status === 403) return fail('forbidden');
  if (identityDown) return fail('identity-down');
  if (status === 404 && body) return fail('not-installed');
  if (status === 503 || code === 'lc_unavailable' || code === 'NOT_REGISTERED') return fail('unavailable');
  if (status !== 200 || !body || (body.ok !== true && !(legacyStages && body.ok === undefined))) return fail('unknown');
  return { kind: 'json', value: body };
}

const unknown = (reply?: LifecycleReply): LifecycleFailure => ({ kind: 'unknown', requestId: reply?.requestId });

function homepageType(value: unknown): value is LcType {
  const type = record(value);
  return !!type && text(type.type) && text(type.name) && type.panorama_row === true
    && Array.isArray(type.flags) && type.flags.every((value) => { const flag = record(value); return text(flag?.code) && text(flag?.name); })
    && Array.isArray(type.stages) && type.stages.length > 0 && type.stages.every((value) => {
      const stage = record(value);
      return !!stage && text(stage.code) && text(stage.name) && Number.isFinite(stage.order) && typeof stage.terminal === 'boolean';
    });
}

function lineObject(value: unknown, type: LcType): value is LcObject {
  const row = record(value);
  return !!row && row.type === type.type && text(row.id) && text(row.stage)
    && (row.name === null || typeof row.name === 'string') && (row.days === null || Number.isFinite(row.days))
    && Array.isArray(row.flags) && row.flags.every(text);
}

export type HomepageLines = { type: LcType; objects: LcObject[] };
export async function readHomepageLines(get: LifecycleRead): Promise<LifecycleResult<HomepageLines>> {
  const stages = await get('stages');
  // Earlier successful stage manifests are metadata and did not include ok. Object pages still require ok:true.
  const parsed = response(stages, true);
  if (parsed.kind !== 'json') return parsed;
  const body = parsed.value;
  const type = Array.isArray(body.types) ? body.types.find((candidate: unknown) => record(candidate)?.panorama_row === true) : undefined;
  if (!homepageType(type)) return unknown(stages);
  let time = freshness(body);
  const objects: LcObject[] = [];
  const cursors = new Set<string>();
  const objectIds = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ type: type.type, limit: '200', ...(cursor ? { cursor } : {}) });
    const reply = await get('objects?' + query.toString());
    const parsed = response(reply);
    if (parsed.kind !== 'json') return parsed;
    const { items, next_cursor } = parsed.value;
    if (!Array.isArray(items) || (next_cursor !== null && !text(next_cursor))) return unknown(reply);
    for (const item of items) {
      if (!lineObject(item, type) || objectIds.has(item.id)) return unknown(reply);
      objects.push(item);
      objectIds.add(item.id);
    }
    const nextTime = freshness(parsed.value);
    time = { asOf: nextTime.asOf ?? time.asOf, lastOk: nextTime.lastOk ?? time.lastOk, stale: time.stale || nextTime.stale };
    if (next_cursor === null) return { kind: time.stale ? 'stale' : 'ok', value: { type, objects }, time };
    if (cursors.has(next_cursor)) return unknown(reply);
    cursors.add(next_cursor);
    cursor = next_cursor;
  }
  return unknown();
}

export type LifecycleBoard = { products: number; stages: Record<string, number> };
export async function readLifecycleBoard(get: LifecycleRead, path: string): Promise<LifecycleResult<LifecycleBoard>> {
  const reply = await get(path);
  const parsed = response(reply);
  if (parsed.kind !== 'json') return parsed;
  const data = record(parsed.value.data);
  const summary = record(data?.summary);
  const stages = record(summary?.by_stage);
  if (!data || !summary || !stages || !count(summary.products) || !count(summary.sources_stale)
    || !Object.values(stages).every(count) || !Array.isArray(data.products)
    || data.products.some((value) => !text(record(value)?.pd))
    || (summary.products === 0 && (data.products.length > 0 || Object.values(stages).some((value) => value !== 0)))) return unknown(reply);
  const time = freshness(parsed.value, data);
  return { kind: time.stale ? 'stale' : 'ok', value: { products: summary.products, stages: stages as Record<string, number> }, time };
}
