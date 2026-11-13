/**
 * 团队与分配（规范 14 第 1 步）：团队的登记、负责人、成员分配。团队和席位本身是节点名册里的事实（services/a2a-roster.ts，市场只读），
 * 这里只存公司的安排。Cordis 服务 `teams`。
 *
 * 键（全系统一种写法，以名册为准）：团队 (host, team)；席位以 (host, seat_id) 为主，seat_id 为空的旧节点退回 (host, team, seat)。
 * host 是节点公钥指纹的前 8 位十六进制（小写）；名册存的时候已经规范化（host、席位句柄、team 的区和 canvas 段小写，画布名原样），这里原样比。
 *
 * 状态在读的时候推，不另存一份（只有一个来源，不会和名册、部门表对不上）：
 *   · 待认领（unclaimed）：没认领过，或者退回了；
 *   · 不在名册（off-roster）：认领过，但名册里已经没有这个团队；
 *   · 负责人缺位（lead-vacant）：认领了、在名册里，但没有在职的负责人（另外指定的人都结束或停用了，部门也没有在职的负责人）；
 *   · 正常（active）。
 * 负责人 = 另外指定的（team_leads 里没结束的）+ 团队所挂部门的负责人（读的时候从部门表推）。只算启用的人。
 *
 * 规则：
 *   · 认领要挂一个已有的部门；退回待认领时，另外指定的负责人一起结束，生效的分配也一起收回。
 *   · 最后一个负责人不能直接移除（409）：先另加一个，或者把团队退回待认领。部门负责人不算可移除的（它跟着部门表走）。
 *   · 分配：只分给启用的人；总工（名册里 role 是 router 的席位）不能分配；同一席位同时只有一条生效（已有的先收回，409）；
 *     席位要在名册里、在这个团队下。
 * 时间由调用方给（毫秒），不在 SQL 里取。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { rosters, activeItemsBySeat, type RosterSeat } from './a2a-roster.ts';
import { leadGrantActive } from './dept-lead-grant.ts';

export const HOST_RE = /^[0-9a-f]{8}$/;
export const TEAM_RE = /^([a-z0-9-]+\/canvas\/[^/]+)?$/; // 空串也是合法的团队（不在任何画布上的席位）
export const SEAT_RE = /^[a-z0-9-]+\/[0-9a-f]{8}$/;
export const SEAT_ID_RE = /^([A-Za-z0-9._:-]{1,64})?$/;

export type TeamKey = { host: string; team: string };
export type SeatKey = { host: string; team: string; seat: string; seat_id: string };
export type TeamStatus = 'unclaimed' | 'off-roster' | 'lead-vacant' | 'active';
export type Actor = { by: string; principal: string | null };
export type TeamRefusal = { ok: false; http: 400 | 403 | 404 | 409 | 422; code: string; message: string };
export type Lead = { principal: string; display_name: string; source: 'explicit' | 'department' };
export type Member = {
  seat: string; seat_id: string; name: string; role: string; online: boolean; router: boolean;
  assigned_to: { principal: string; display_name: string } | null; active_items: number;
};
/** 名册多久没更新算停推（分钟）：WM_ROSTER_STALE_MINUTES，缺省 60，1～10080 的整数；别的值返回 null（启动时拒绝） */
export function rosterStaleMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.WM_ROSTER_STALE_MINUTES ?? '');
  if (raw === '') return 60;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 10080 ? n : null;
}

/** 库里的时刻（名册收到的时间是 SQLite 的「YYYY-MM-DD HH:MM:SS」，UTC）统一成 ISO 时刻给出去；认不出的原样 */
export function isoTime(t: string): string {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? `${t.replace(' ', 'T')}Z` : t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : t;
}

export type TeamView = {
  host: string; team: string; status: TeamStatus; in_roster: boolean;
  department: { id: string; name: string } | null;
  leads: Lead[]; router: Member | null; members: Member[];
  /** 所挂部门上写着的负责人，但他没有这个部门的拍板授予（待属主放行）：不算负责人、不带任何权力，只给页面显示；没有为 null */
  lead_pending_grant: { principal: string; display_name: string } | null;
  /** 这个节点的名册停推了没有（和「等你拍板」的名册停推同一个判断 staleBy）；roster_stale_for_minutes 是离最近一次收到多少分钟，没停推为 null */
  roster_stale: boolean; roster_stale_for_minutes: number | null;
};

const refuse = (http: TeamRefusal['http'], code: string, message: string): TeamRefusal => ({ ok: false, http, code, message });
const tkey = (host: string, team: string) => `${host}\u0000${team}`;

type Reg = { host: string; team: string; department_id: string; claimed: number; claimed_by: string; claimed_at: number | null };
type AssignRow = { id: number; host: string; team: string; seat: string; seat_id: string; principal_id: string; assigned_at: number; ended_at: number | null };

/** 同一个席位：有 seat_id 的按 (host, seat_id)，没有的按 (host, team, seat) */
export const sameSeat = (a: { host: string; team: string; seat: string; seat_id: string }, b: { host: string; team: string; seat: string; seat_id: string }): boolean =>
  a.host === b.host && (a.seat_id && b.seat_id ? a.seat_id === b.seat_id : a.team === b.team && a.seat === b.seat);

export class TeamService extends Service {
  constructor(ctx: any) {
    super(ctx, 'teams');
  }

  // ---------- 名册（只读） ----------

  /** 名册里的团队：(host, team) → 席位 */
  rosterTeams(): Map<string, { host: string; team: string; seats: RosterSeat[] }> {
    const out = new Map<string, { host: string; team: string; seats: RosterSeat[] }>();
    for (const h of rosters()) {
      for (const s of h.seats) {
        const k = tkey(h.host, s.team);
        const t = out.get(k) ?? { host: h.host, team: s.team, seats: [] };
        t.seats.push(s);
        out.set(k, t);
      }
    }
    return out;
  }

  /** 名册里的这个席位（按 seat_id 优先），找不到为 null */
  rosterSeat(k: SeatKey): RosterSeat | null {
    const t = this.rosterTeams().get(tkey(k.host, k.team));
    if (!t) return null;
    return t.seats.find((s) => sameSeat({ host: k.host, team: k.team, seat: s.seat, seat_id: s.seat_id }, k)) ?? null;
  }

  // ---------- 登记 ----------

  registration(k: TeamKey): Reg | null {
    return (db.prepare('SELECT host, team, department_id, claimed, claimed_by, claimed_at FROM teams WHERE host = ? AND team = ?').get(k.host, k.team) as Reg | undefined) ?? null;
  }

  private personActive(id: string): { display_name: string } | null {
    const p = db.prepare("SELECT display_name FROM principals WHERE id = ? AND kind = 'person' AND status = 'active'").get(id) as { display_name: string } | undefined;
    return p ?? null;
  }
  private displayName(id: string): string {
    return (db.prepare('SELECT display_name FROM principals WHERE id = ?').get(id) as { display_name: string } | undefined)?.display_name ?? '';
  }

  /**
   * 在职的负责人：另外指定的（没结束、人还启用）+ 所挂部门的负责人（启用的人，并且持有这个部门的拍板授予）。
   * 部门上的负责人字段单独不算：字段可能来自存量、导入或将来的同步，不经属主；只有字段的是「待属主放行」（deptLeadPending）。
   */
  leads(k: TeamKey): Lead[] {
    const out: Lead[] = [];
    for (const r of db.prepare('SELECT principal_id FROM team_leads WHERE host = ? AND team = ? AND ended_at IS NULL ORDER BY id').all(k.host, k.team) as { principal_id: string }[]) {
      const p = this.personActive(r.principal_id);
      if (p) out.push({ principal: r.principal_id, display_name: p.display_name, source: 'explicit' });
    }
    const reg = this.registration(k);
    if (reg?.claimed && reg.department_id) {
      const d = db.prepare('SELECT lead_principal FROM departments WHERE id = ?').get(reg.department_id) as { lead_principal: string } | undefined;
      const p = d?.lead_principal ? this.personActive(d.lead_principal) : null;
      if (d?.lead_principal && p && !out.some((l) => l.principal === d.lead_principal) && leadGrantActive(d.lead_principal, reg.department_id)) out.push({ principal: d.lead_principal, display_name: p.display_name, source: 'department' });
    }
    return out;
  }

  /** 所挂部门上写着负责人、但他没有这个部门拍板授予的（启用的人）：待属主放行，不算负责人 */
  deptLeadPending(k: TeamKey): { principal: string; display_name: string } | null {
    const reg = this.registration(k);
    if (!reg?.claimed || !reg.department_id) return null;
    const d = db.prepare('SELECT lead_principal FROM departments WHERE id = ?').get(reg.department_id) as { lead_principal: string } | undefined;
    const p = d?.lead_principal ? this.personActive(d.lead_principal) : null;
    if (!d?.lead_principal || !p || leadGrantActive(d.lead_principal, reg.department_id)) return null;
    if (this.leads(k).some((l) => l.principal === d.lead_principal)) return null; // 另外被指定为这个团队的负责人
    return { principal: d.lead_principal, display_name: p.display_name };
  }

  status(k: TeamKey, inRoster = this.rosterTeams().has(tkey(k.host, k.team))): TeamStatus {
    const reg = this.registration(k);
    if (!reg?.claimed) return 'unclaimed';
    if (!inRoster) return 'off-roster';
    return this.leads(k).length ? 'active' : 'lead-vacant';
  }

  private event(k: TeamKey, kind: string, actor: Actor, now: number, extra: { seat?: string; seat_id?: string; principal?: string; detail?: unknown } = {}): void {
    db.prepare('INSERT INTO team_events (host, team, kind, seat, seat_id, principal_id, detail, actor, actor_principal, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(k.host, k.team, kind, extra.seat ?? '', extra.seat_id ?? '', extra.principal ?? '', extra.detail === undefined ? '' : JSON.stringify(extra.detail), actor.by.slice(0, 256), actor.principal, now);
  }

  events(k: TeamKey): { seq: number; kind: string; seat: string; seat_id: string; principal_id: string; detail: string; actor: string; actor_principal: string | null; at: number }[] {
    return db.prepare('SELECT seq, kind, seat, seat_id, principal_id, detail, actor, actor_principal, at FROM team_events WHERE host = ? AND team = ? ORDER BY seq').all(k.host, k.team) as never;
  }

  /** 一个事务；外面已经开着事务（比如确认关系提议时把核对、改状态、落关系包在一起）就用保存点嵌进去 */
  private tx<T>(fn: () => T): T {
    if (db.isTransaction) {
      db.exec('SAVEPOINT team_tx');
      try { const r = fn(); db.exec('RELEASE team_tx'); return r; } catch (e) { try { db.exec('ROLLBACK TO team_tx'); db.exec('RELEASE team_tx'); } catch { /* 保存点已经不在了 */ } throw e; }
    }
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
  }

  /** 认领并挂部门；已经认领的换部门（记 department）。团队要在名册里 */
  /** 认领（或换部门）之前的核对：提议和直接认领用同一处。null 表示能认领；unchanged 表示已经挂在这个部门 */
  claimCheck(k: TeamKey, departmentId: string): TeamRefusal | 'unchanged' | null {
    if (!this.rosterTeams().has(tkey(k.host, k.team))) return refuse(404, 'team_not_in_roster', '名册里没有这个团队');
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) return refuse(422, 'department_unknown', `部门 ${departmentId} 不存在`);
    const reg = this.registration(k);
    return reg?.claimed && reg.department_id === departmentId ? 'unchanged' : null;
  }

  /** 指定负责人之前的核对：提议和直接指定用同一处。null 表示能指定；already 表示已经是 */
  leadCheck(k: TeamKey, principal: string): TeamRefusal | 'already' | null {
    if (!this.registration(k)?.claimed) return refuse(409, 'team_not_claimed', '先认领团队、挂到部门上，再指定负责人');
    if (!this.personActive(principal)) return refuse(422, 'lead_not_person', `负责人要是启用的人，${principal} 不是`);
    return db.prepare('SELECT 1 FROM team_leads WHERE host = ? AND team = ? AND principal_id = ? AND ended_at IS NULL').get(k.host, k.team, principal) ? 'already' : null;
  }

  claim(k: TeamKey, departmentId: string, actor: Actor, now: number): { ok: true; changed: boolean } | TeamRefusal {
    const check = this.claimCheck(k, departmentId);
    if (check === 'unchanged') return { ok: true, changed: false };
    if (check) return check;
    const reg = this.registration(k);
    return this.tx(() => {
      db.prepare(`INSERT INTO teams (host, team, department_id, claimed, claimed_by, claimed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT (host, team) DO UPDATE SET department_id = excluded.department_id, claimed = 1,
          claimed_by = CASE WHEN teams.claimed = 1 THEN teams.claimed_by ELSE excluded.claimed_by END,
          claimed_at = CASE WHEN teams.claimed = 1 THEN teams.claimed_at ELSE excluded.claimed_at END, updated_at = excluded.updated_at`)
        .run(k.host, k.team, departmentId, actor.by.slice(0, 256), now, now);
      this.event(k, reg?.claimed ? 'department' : 'claim', actor, now, { detail: { department: departmentId, before: reg?.claimed ? reg.department_id : null } });
      return { ok: true as const, changed: true };
    });
  }

  /** 退回待认领：另外指定的负责人结束，生效的分配收回 */
  release(k: TeamKey, actor: Actor, now: number): { ok: true; leads_ended: number; assignments_ended: number } | TeamRefusal {
    const reg = this.registration(k);
    if (!reg?.claimed) return refuse(409, 'team_not_claimed', '这个团队没有认领');
    return this.tx(() => {
      const leads = db.prepare('UPDATE team_leads SET ended_at = ?, ended_by = ? WHERE host = ? AND team = ? AND ended_at IS NULL').run(now, actor.by.slice(0, 256), k.host, k.team).changes;
      const asg = db.prepare('UPDATE seat_assignments SET ended_at = ?, ended_by = ? WHERE host = ? AND team = ? AND ended_at IS NULL').run(now, actor.by.slice(0, 256), k.host, k.team).changes;
      db.prepare("UPDATE teams SET claimed = 0, department_id = '', updated_at = ? WHERE host = ? AND team = ?").run(now, k.host, k.team);
      this.event(k, 'release', actor, now, { detail: { department: reg.department_id, leads_ended: Number(leads), assignments_ended: Number(asg) } });
      return { ok: true as const, leads_ended: Number(leads), assignments_ended: Number(asg) };
    });
  }

  addLead(k: TeamKey, principal: string, actor: Actor, now: number): { ok: true; added: boolean } | TeamRefusal {
    const check = this.leadCheck(k, principal);
    if (check === 'already') return { ok: true, added: false };
    if (check) return check;
    return this.tx(() => {
      db.prepare('INSERT INTO team_leads (host, team, principal_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(k.host, k.team, principal, actor.by.slice(0, 256), now);
      this.event(k, 'lead-add', actor, now, { principal });
      return { ok: true as const, added: true };
    });
  }

  removeLead(k: TeamKey, principal: string, actor: Actor, now: number): { ok: true; removed: boolean } | TeamRefusal {
    const row = db.prepare('SELECT id FROM team_leads WHERE host = ? AND team = ? AND principal_id = ? AND ended_at IS NULL').get(k.host, k.team, principal) as { id: number } | undefined;
    if (!row) {
      if (this.leads(k).some((l) => l.principal === principal && l.source === 'department')) return refuse(409, 'lead_from_department', '这位是所挂部门的负责人，跟着部门走：换部门负责人，或者把团队挂到别的部门');
      return { ok: true, removed: false };
    }
    if (this.leads(k).filter((l) => l.principal !== principal).length === 0) return refuse(409, 'last_lead', '这是团队最后一个负责人，不能直接移除：先另加一个，或者把团队退回待认领');
    return this.tx(() => {
      db.prepare('UPDATE team_leads SET ended_at = ?, ended_by = ? WHERE id = ?').run(now, actor.by.slice(0, 256), row.id);
      this.event(k, 'lead-remove', actor, now, { principal });
      return { ok: true as const, removed: true };
    });
  }

  // ---------- 分配 ----------

  private activeAssignment(k: SeatKey): AssignRow | null {
    const r = k.seat_id
      ? db.prepare("SELECT * FROM seat_assignments WHERE host = ? AND seat_id = ? AND ended_at IS NULL").get(k.host, k.seat_id)
      : db.prepare("SELECT * FROM seat_assignments WHERE host = ? AND team = ? AND seat = ? AND seat_id = '' AND ended_at IS NULL").get(k.host, k.team, k.seat);
    return (r as AssignRow | undefined) ?? null;
  }

  assign(k: SeatKey, principal: string, actor: Actor, now: number): { ok: true; id: number } | TeamRefusal {
    if (!this.registration(k)?.claimed) return refuse(409, 'team_not_claimed', '团队还没认领，不能分配成员');
    const seat = this.rosterSeat(k);
    if (!seat) return refuse(404, 'seat_not_in_roster', '名册里这个团队下没有这个席位');
    if (seat.role === 'router') return refuse(422, 'router_not_assignable', '总工不分配给员工，只对负责人');
    if (!this.personActive(principal)) return refuse(422, 'assignee_not_person', `只分给启用的人，${principal} 不是`);
    const key: SeatKey = { host: k.host, team: k.team, seat: seat.seat, seat_id: seat.seat_id };
    const cur = this.activeAssignment(key);
    if (cur) return refuse(409, 'seat_assigned', `这个成员已经分给 ${cur.principal_id}，先收回再分`);
    return this.tx(() => {
      const id = Number(db.prepare('INSERT INTO seat_assignments (host, team, seat, seat_id, principal_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(key.host, key.team, key.seat, key.seat_id, principal, actor.by.slice(0, 256), now).lastInsertRowid);
      this.event(key, 'assign', actor, now, { seat: key.seat, seat_id: key.seat_id, principal });
      return { ok: true as const, id };
    });
  }

  unassign(k: SeatKey, actor: Actor, now: number): { ok: true; removed: boolean } | TeamRefusal {
    const seat = this.rosterSeat(k);
    const key: SeatKey = seat ? { host: k.host, team: k.team, seat: seat.seat, seat_id: seat.seat_id } : k;
    const cur = this.activeAssignment(key);
    // 生效的分配要属于这个团队：seat_id 按节点认，团队另外核
    if (cur && (cur.host !== k.host || cur.team !== k.team)) return refuse(404, 'seat_not_in_team', '这个团队下没有这个席位的分配');
    // 名册里这个团队下没有这个席位、也没有它的分配：不当成「已经收回了」
    if (!cur && !seat) return refuse(404, 'seat_not_in_team', '这个团队下没有这个席位');
    if (!cur) return { ok: true, removed: false };
    return this.tx(() => {
      db.prepare('UPDATE seat_assignments SET ended_at = ?, ended_by = ? WHERE id = ?').run(now, actor.by.slice(0, 256), cur.id);
      this.event(key, 'unassign', actor, now, { seat: key.seat, seat_id: key.seat_id, principal: cur.principal_id });
      return { ok: true as const, removed: true };
    });
  }

  /**
   * 改派：一个事务里结束这个成员现在的分配、分给 principal（团队页「改派」一步办完，不会停在团队公用）。
   * 检查和 assign 一样；现在没人分着就等同于分配；改给现在的人回 changed=false、什么都不写。
   * 留痕照旧是一条 unassign 加一条 assign（team_events.kind 不加新值），两条的 detail 都带 { reassign: true, from, to }。
   */
  reassign(k: SeatKey, principal: string, actor: Actor, now: number): { ok: true; changed: boolean; id: number | null; from: string | null } | TeamRefusal {
    if (!this.registration(k)?.claimed) return refuse(409, 'team_not_claimed', '团队还没认领，不能分配成员');
    const seat = this.rosterSeat(k);
    if (!seat) return refuse(404, 'seat_not_in_roster', '名册里这个团队下没有这个席位');
    if (seat.role === 'router') return refuse(422, 'router_not_assignable', '总工不分配给员工，只对负责人');
    if (!this.personActive(principal)) return refuse(422, 'assignee_not_person', `只分给启用的人，${principal} 不是`);
    const key: SeatKey = { host: k.host, team: k.team, seat: seat.seat, seat_id: seat.seat_id };
    const cur = this.activeAssignment(key);
    // 生效的分配要属于这个团队：seat_id 按节点认，团队另外核（和 unassign 一样）
    if (cur && (cur.host !== k.host || cur.team !== k.team)) return refuse(404, 'seat_not_in_team', '这个团队下没有这个席位的分配');
    if (cur && cur.principal_id === principal) return { ok: true, changed: false, id: cur.id, from: principal };
    const from = cur ? cur.principal_id : null;
    const detail = { reassign: true, from, to: principal };
    return this.tx(() => {
      if (cur) {
        db.prepare('UPDATE seat_assignments SET ended_at = ?, ended_by = ? WHERE id = ?').run(now, actor.by.slice(0, 256), cur.id);
        this.event(key, 'unassign', actor, now, { seat: key.seat, seat_id: key.seat_id, principal: cur.principal_id, detail });
      }
      const id = Number(db.prepare('INSERT INTO seat_assignments (host, team, seat, seat_id, principal_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(key.host, key.team, key.seat, key.seat_id, principal, actor.by.slice(0, 256), now).lastInsertRowid);
      this.event(key, 'assign', actor, now, { seat: key.seat, seat_id: key.seat_id, principal, detail });
      return { ok: true as const, changed: true, id, from };
    });
  }

  /**
   * 节点的两样：名字（名册报上来的节点根地址，对到对端登记表里登记的名字；没登记、没名字为 null，页面不显示节点标识），
   * 和最近一次成功收下这个节点名册的时间（a2a_rosters.received_at，和 GET /api/a2a/teams 同一个来源，统一成 ISO 时刻；没收过为 null）
   */
  nodeInfo(host: string): { node_name: string | null; roster_received_at: string | null } {
    const r = db.prepare("SELECT r.received_at AS received_at, COALESCE(p.name, '') AS name FROM a2a_rosters_live r LEFT JOIN a2a_peers p ON p.root_url = r.peer_root WHERE r.host = ?").get(host) as { received_at: string; name: string } | undefined;
    return { node_name: r?.name ? r.name : null, roster_received_at: r?.received_at ? isoTime(r.received_at) : null };
  }

  /** 那时这个成员归谁（at 毫秒，含起点、不含终点）；没分配为 null */
  ownerAt(k: SeatKey, at: number): string | null {
    const r = (k.seat_id
      ? db.prepare('SELECT principal_id FROM seat_assignments WHERE host = ? AND seat_id = ? AND assigned_at <= ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY assigned_at DESC, id DESC LIMIT 1').get(k.host, k.seat_id, at, at)
      : db.prepare("SELECT principal_id FROM seat_assignments WHERE host = ? AND team = ? AND seat = ? AND seat_id = '' AND assigned_at <= ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY assigned_at DESC, id DESC LIMIT 1").get(k.host, k.team, k.seat, at, at)) as { principal_id: string } | undefined;
    return r?.principal_id ?? null;
  }

  /**
   * 一批「席位、时间点」各自那时归谁（阶段八「我的 AI 员工手上的」视角用，逐条调 ownerAt 太慢）。
   * 一次把涉及的节点上的分配全取出来，在内存里逐点匹配；口径和 ownerAt 一样：含起点、不含终点，seat_id 优先。
   * 返回和输入一一对应，没分配为 null。
   */
  ownersAt(points: readonly { key: SeatKey; at: number }[]): (string | null)[] {
    if (!points.length) return [];
    const hosts = [...new Set(points.map((p) => p.key.host))];
    const rows: AssignRow[] = [];
    const q = db.prepare('SELECT * FROM seat_assignments WHERE host = ? ORDER BY assigned_at DESC, id DESC');
    for (const h of hosts) rows.push(...(q.all(h) as AssignRow[]));
    return points.map(({ key, at }) => {
      const hit = rows.find((r) => sameSeat(r, key) && r.assigned_at <= at && (r.ended_at === null || r.ended_at > at));
      return hit?.principal_id ?? null;
    });
  }

  /**
   * 这个人各段分配：(席位, 起, 止)；止为 null 表示还在。带 range 时只给和 [from, to) 有交集的段。按起点排序。
   */
  assignmentHistory(principal: string, range: { from?: number; to?: number } = {}): { host: string; team: string; seat: string; seat_id: string; from: number; to: number | null }[] {
    const rows = db.prepare('SELECT host, team, seat, seat_id, assigned_at, ended_at FROM seat_assignments WHERE principal_id = ? ORDER BY assigned_at, id').all(principal) as AssignRow[];
    return rows
      .filter((r) => (range.to === undefined || r.assigned_at < range.to) && (range.from === undefined || r.ended_at === null || r.ended_at > range.from))
      .map((r) => ({ host: r.host, team: r.team, seat: r.seat, seat_id: r.seat_id, from: r.assigned_at, to: r.ended_at }));
  }

  /** 这个人现在被分到的成员 */
  assignedTo(principal: string): AssignRow[] {
    return db.prepare('SELECT * FROM seat_assignments WHERE principal_id = ? AND ended_at IS NULL ORDER BY assigned_at, id').all(principal) as AssignRow[];
  }

  /** 这个人另外被指定为负责人的团队（不含经部门推出来的） */
  explicitLeadOf(principal: string): TeamKey[] {
    return db.prepare('SELECT DISTINCT host, team FROM team_leads WHERE principal_id = ? AND ended_at IS NULL').all(principal) as TeamKey[];
  }

  // ---------- 关系函数（team-relation.ts）用的几个查询 ----------

  /** 部门的标识和名称；没有为 null */
  department(id: string): { id: string; name: string } | null {
    return (db.prepare('SELECT id, name FROM departments WHERE id = ?').get(id) as { id: string; name: string } | undefined) ?? null;
  }
  /** 这个人对这个部门：是不是成员、是不是负责人（字段写着他、并且持有这个部门的拍板授予）、是不是只有字段（待属主放行）。部门不存在都是 false */
  departmentRole(principal: string, departmentId: string): { member: boolean; lead: boolean; leadPending: boolean } {
    const d = db.prepare('SELECT lead_principal FROM departments WHERE id = ?').get(departmentId) as { lead_principal: string } | undefined;
    if (!d) return { member: false, lead: false, leadPending: false };
    const field = d.lead_principal === principal;
    const granted = field && leadGrantActive(principal, departmentId);
    return { member: !!db.prepare('SELECT 1 FROM department_members WHERE department_id = ? AND principal_id = ?').get(departmentId, principal), lead: granted, leadPending: field && !granted };
  }
  /** 主体的显示名（没有为空串） */
  nameOf(principal: string): string {
    return this.displayName(principal);
  }

  // ---------- 读：合好的团队视图 ----------

  /** 全部团队（名册里的，加上认领过但已不在名册的），带状态、部门、负责人、总工、成员 */
  allViews(): TeamView[] {
    const roster = this.rosterTeams();
    const regs = db.prepare('SELECT host, team, department_id, claimed, claimed_by, claimed_at FROM teams').all() as Reg[];
    const keys = new Map<string, TeamKey>();
    for (const t of roster.values()) keys.set(tkey(t.host, t.team), { host: t.host, team: t.team });
    for (const r of regs) if (r.claimed) keys.set(tkey(r.host, r.team), { host: r.host, team: r.team });
    const items = activeItemsBySeat();
    const deptName = new Map((db.prepare('SELECT id, name FROM departments').all() as { id: string; name: string }[]).map((d) => [d.id, d.name]));
    const out: TeamView[] = [];
    for (const [k, key] of keys) {
      const reg = regs.find((r) => r.host === key.host && r.team === key.team);
      const rt = roster.get(k);
      const members: Member[] = (rt?.seats ?? []).map((s) => {
        const a = this.activeAssignment({ host: key.host, team: key.team, seat: s.seat, seat_id: s.seat_id });
        return {
          seat: s.seat, seat_id: s.seat_id, name: s.name, role: s.role, online: s.online, router: s.role === 'router',
          assigned_to: a ? { principal: a.principal_id, display_name: this.displayName(a.principal_id) } : null,
          active_items: items.get(s.seat) ?? 0,
        };
      });
      out.push({
        host: key.host, team: key.team, status: this.status(key, !!rt), in_roster: !!rt,
        department: reg?.claimed && reg.department_id ? { id: reg.department_id, name: deptName.get(reg.department_id) ?? '' } : null,
        leads: this.leads(key), router: members.find((m) => m.router) ?? null, members: members.filter((m) => !m.router),
        lead_pending_grant: this.deptLeadPending(key), ...this.rosterStaleness(key.host),
      });
    }
    return out.sort((a, b) => (a.host + a.team).localeCompare(b.host + b.team));
  }

  /**
   * 要人拍板的团队（「等你拍板」的聚合在读时调这个，不另写判断）：待认领、负责人缺位、不在名册。
   * 和团队页同一个推导（allViews → status），正常的不出现。按 host、team 排序。
   */
  /** 名册多久没更新算停推（毫秒）：启动时由 index.ts 按 WM_ROSTER_STALE_MINUTES 设一次 */
  private rosterStaleMs = 60 * 60_000;
  setRosterStaleMs(ms: number): void { this.rosterStaleMs = ms; }
  rosterStaleMinutes(): number { return Math.round(this.rosterStaleMs / 60_000); }

  /** 名册停推的判断（只这一处）：最近一次收到的时间超过阈值。团队页的 roster_stale 和「等你拍板」的名册停推都用它 */
  private staleBy(receivedAt: string, now: number): number | null {
    const t = Date.parse(isoTime(receivedAt));
    return Number.isFinite(t) && now - t > this.rosterStaleMs ? Math.floor((now - t) / 60_000) : null;
  }

  /** 一个节点的名册停推了没有、停了多少分钟（从最近一次收到算起）；没收过名册的节点不算停推 */
  rosterStaleness(host: string, now = Date.now()): { roster_stale: boolean; roster_stale_for_minutes: number | null } {
    const r = db.prepare('SELECT received_at FROM a2a_rosters_live WHERE host = ?').get(host) as { received_at: string } | undefined;
    const m = r ? this.staleBy(r.received_at, now) : null;
    return { roster_stale: m !== null, roster_stale_for_minutes: m };
  }

  /** 超过阈值没更新名册的节点：节点标识、名字、最近收到的时间（页面不显示节点标识，用名字） */
  staleRosters(now = Date.now()): { host: string; node_name: string | null; roster_received_at: string }[] {
    return (db.prepare('SELECT host, received_at FROM a2a_rosters_live ORDER BY host').all() as { host: string; received_at: string }[])
      .filter((r) => this.staleBy(r.received_at, now) !== null)
      .map((r) => ({ host: r.host, node_name: this.nodeInfo(r.host).node_name, roster_received_at: isoTime(r.received_at) }));
  }

  needingAttention(): { host: string; team: string; status: Exclude<TeamStatus, 'active'>; department: { id: string; name: string } | null; leads: Lead[] }[] {
    return this.allViews().filter((t) => t.status !== 'active')
      .map((t) => ({ host: t.host, team: t.team, status: t.status as Exclude<TeamStatus, 'active'>, department: t.department, leads: t.leads }));
  }
}
