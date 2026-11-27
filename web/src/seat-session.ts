import type { Member, Team } from './team-view';

export type SeatTarget = { host: string; team: string; seat: string; seat_id: string };
export type SeatAction = { action: 'steer' | 'queue'; text: string } | { action: 'stop' };
type SessionEntry = { i: number; role: 'user' | 'assistant'; text: string };
export type SessionPage = { entries: SessionEntry[]; from: number; to: number; total: number; stale: boolean };
type SessionProblem = { ok: false; text: string; unavailable: boolean };
type Result<T> = { ok: true; data: T } | SessionProblem;
const ROUTE = '/api/teams/seat-session';
const PAGE_SIZE = 20;
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const matchesTeam = (v: unknown, t: Team) => {
  const r = record(v);
  return r?.host === t.host && r.team === t.team;
};

/** 入口只看登录人的关系清单和当前团队卡。每次实际操作由服务端重新核权。 */
export function canOpenSeatSession(mine: unknown, team: Team, member: Member): boolean {
  const r = record(mine);
  if (!r || typeof r.principal !== 'string' || !r.principal || !team.in_roster || !team.host || !team.team || !member.seat) return false;
  if (Array.isArray(r.teams) && r.teams.some(t => matchesTeam(t, team)) && team.leads.some(lead => lead.principal === r.principal)) return true;
  return member.assigned_to?.principal === r.principal && Array.isArray(r.members) && r.members.some(value => {
    const seat = record(value);
    return seat && matchesTeam(seat, team) && seat.seat === member.seat && (seat.seat_id ?? '') === member.seat_id;
  });
}

async function call(url: string, signal: AbortSignal, body?: object) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    return { status: response.status, body: record(await response.json().catch(() => null)) };
  } catch {
    return { status: 0, body: null };
  }
}

export async function getSeatSessionRelations(signal: AbortSignal): Promise<unknown> {
  const r = await call('/api/teams/mine', signal);
  return r.status === 200 ? r.body : null;
}

function problem(status: number, body: Record<string, unknown> | null, writing = false): SessionProblem {
  const code = body?.code ?? body?.error;
  if (code === 'outbound_off') return { ok: false, text: '对外已断开，暂时无法读取或操作席位会话。', unavailable: true };
  if (status === 401) return { ok: false, text: '请用个人账号重新登录后打开席位会话。', unavailable: true };
  if (status === 404 || code === 'seat_session_node_changed') {
    return { ok: false, text: '当前看不到这个席位的会话，请刷新团队页后重新打开。', unavailable: true };
  }
  if (status === 0) return { ok: false, text: writing ? '未收到操作结果，请先刷新会话确认。' : '暂时连不上市场，请重试。', unavailable: writing };
  const detail = typeof body?.message === 'string' ? body.message
    : typeof body?.code === 'string' && typeof body.error === 'string' ? body.error : '';
  return {
    ok: false, unavailable: status === 403 || status >= 500,
    text: detail.trim() ? '节点或市场拒绝了请求：' + detail.trim().slice(0, 512) : '暂时无法访问席位会话，请刷新后重试。',
  };
}

export async function readSeatSession(target: SeatTarget, before: number | undefined, signal: AbortSignal): Promise<Result<SessionPage>> {
  const query = new URLSearchParams({ ...target, limit: String(PAGE_SIZE), chars: '4000' });
  if (before !== undefined) query.set('before', String(before));
  const r = await call(ROUTE + '?' + query, signal);
  if (r.status !== 200 || r.body?.ok !== true) return problem(r.status, r.body);
  const { entries, from, to, total, stale } = r.body;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof total !== 'number' ||
      ![from, to, total].every(Number.isSafeInteger) || from < 0 || to < from || total < to ||
      typeof stale !== 'boolean' || !Array.isArray(entries) || entries.length > PAGE_SIZE || entries.length !== to - from ||
      !entries.every((row, i) => row?.i === from + i && (row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string')) {
    return { ok: false, text: '节点返回的会话页格式不正确，请刷新后重试。', unavailable: true };
  }
  return { ok: true, data: { entries, from, to, total, stale } };
}

export async function sendSeatAction(target: SeatTarget, action: SeatAction, signal: AbortSignal): Promise<Result<string>> {
  const request_id = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const r = await call(ROUTE, signal, { ...target, ...action, request_id });
  if (r.status !== 200 || r.body?.ok !== true) return problem(r.status, r.body, true);
  if (action.action === 'stop' && typeof r.body.stopped === 'boolean') {
    return { ok: true, data: r.body.stopped ? '已停止当前轮，队列保留。' : '当前没有可停止的轮次。' };
  }
  if (action.action === 'steer' && r.body.delivered === 'steered') return { ok: true, data: '已发给当前轮。' };
  if (action.action === 'queue' && r.body.delivered === 'queued') return { ok: true, data: '已加入队列。' };
  return { ok: false, text: '节点未确认操作结果，请先刷新会话确认。', unavailable: true };
}
