/**
 * 领域域（docs/domains-step1.md 第二节；规范 15 两层组织）：领域、领域规范的版本、留痕。SQL 只在这里。
 *
 * 规则：
 *   · 领域标识和部门标识同一套写法（小写字母开头，字母、数字、连字符，最多 48 个字符），建好不改；名字 1～64 个字符，不带控制字符；
 *   · 新建的领域是 pending-lead（还没有生效的领域负责人；第 1 步 PR2 起属主放行第一条 area-lead 后变 active）；
 *   · 规范正文 1 字节～64 KB（按 UTF-8 字节），摘要（sha256）由这里算；调用方带了摘要的要和正文对得上；
 *   · 新加一版 = 版本号取这个领域现有最大的加一，并把生效指针移到新版；回退 = 只移指针，不新增版本；
 *   · 撤领域：范围是 area:<标识> 的没结束的授予（草稿、待核、生效，含最后一位负责人）在同一个写事务里一并撤销，每条记一行痕
 *     （统筹裁定 2，2026-11-20；单独收回最后一位负责人仍然不行，那是 PR2 的事）；撤了的只读，不删；
 *   · 每次建、撤、新加版本、移指针一行留痕（area_events），和改动同一个写事务。
 * 时间由调用方给（毫秒），不在 SQL 里取。写事务用 BEGIN IMMEDIATE：两次并发新加规范不会拿到同一个版本号。
 */
import { createHash } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { svc } from '../context.ts';
import type { GrantService } from './grant.ts';
import type { PrincipalStatusChanged } from './principal.ts';
import type { DepartmentService } from './department.ts';
import { areaVerdict } from '../judgment.ts';
import { AREA_LEAD_ACTIONS, AREA_SPEC_ACTION } from '../roles.ts';

export type AreaStatus = 'pending-lead' | 'active' | 'retired';
export type AreaSource = 'manual' | 'department';
export type AreaView = {
  id: string; name: string; status: AreaStatus; spec_version: number | null; team_host: string; team: string; source: AreaSource;
  created_at: number; created_by: string; updated_at: number; updated_by: string;
};
export type AreaSpecMeta = { version: number; sha256: string; bytes: number; note: string; created_at: number; created_by: string; created_by_principal: string | null; active: boolean };
export type AreaSpec = AreaSpecMeta & { body: string };
export type AreaRefusal = { ok: false; http: 400 | 404 | 409; code: string; message: string };
/** 做这一步的人：by 是留痕写法（cli、admin-token、user:<名> …），principal 是对到的主体（对不到为 null） */
export type AreaActor = { by: string; principal: string | null };

export const AREA_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const AREA_SPEC_MAX_BYTES = 65536;
export const AREA_NOTE_MAX = 200;
/** 迁移起草的负责人授予的理由（也是去重的一部分） */
export const MIGRATE_REASON = '由部门负责人迁移';
const SHA256_RE = /^[0-9a-f]{64}$/;

const refuse = (http: AreaRefusal['http'], code: string, message: string): AreaRefusal => ({ ok: false, http, code, message });
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

type AreaRow = Omit<AreaView, 'spec_version'> & { spec_version: number | null };
const areaView = (r: AreaRow): AreaView => ({
  id: r.id, name: r.name, status: r.status, spec_version: r.spec_version === null ? null : Number(r.spec_version), team_host: r.team_host, team: r.team, source: r.source,
  created_at: Number(r.created_at), created_by: r.created_by, updated_at: Number(r.updated_at), updated_by: r.updated_by,
});
const AREA_COLS = 'id, name, status, spec_version, team_host, team, source, created_at, created_by, updated_at, updated_by';
const SPEC_META = 'version, sha256, length(CAST(body AS BLOB)) AS bytes, note, created_at, created_by, created_by_principal';
type SpecRow = { version: number; sha256: string; bytes: number; note: string; created_at: number; created_by: string; created_by_principal: string | null; body?: string };
const specMeta = (r: SpecRow, active: number | null): AreaSpecMeta => ({
  version: Number(r.version), sha256: r.sha256, bytes: Number(r.bytes), note: r.note, created_at: Number(r.created_at), created_by: r.created_by,
  created_by_principal: r.created_by_principal ?? null, active: active !== null && Number(r.version) === active,
});

/** 写事务：外面已经开着就跟着它，不另开 */
function tx<T>(fn: () => T): T {
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    if (own) db.exec('COMMIT');
    return out;
  } catch (e) {
    if (own) { try { db.exec('ROLLBACK'); } catch { /* 事务没开成 */ } }
    throw e;
  }
}

/**
 * 领域判定的主体：路由和 access 接口各自认出人以后交进来。
 *   owner：属主（本机命令行在领域的路由上也算属主）；seesAll：看全部领域（属主、管理层；路由上另有管理口令、本机命令行）；
 *   principal：对到的主体（管理口令、本机命令行没有，为 null）
 */
export type AreaSubject = { owner: boolean; seesAll: boolean; principal: string | null };
export type AreaDecision = { verdict: 'allow' | 'deny'; rule: string; grant: number | null };

export class AreaService extends Service {
  constructor(ctx: any) {
    super(ctx, 'areas');
    // 负责人本人停用、恢复：重算他负责的领域（services/principal.ts 的 setStatus 发）
    ctx.on('principal/status', (c: PrincipalStatusChanged) => {
      const now = Date.now();
      for (const area of svc<GrantService>('grants').leadAreasHeldBy(c.id, now)) {
        this.reconcileLead(area, `负责人 ${c.id} ${c.status === 'disabled' ? '停用' : '恢复'}${c.reason.trim() ? `：${c.reason.trim()}` : ''}`, { by: c.by, principal: null }, now);
      }
    });
  }

  /**
   * 领域的动作谁能做（docs/domains-step1.md 第三节）：领域路由（routes/areas.ts）和「以某人的身份看」（routes/access.ts）都问这一处，
   * 两边不会各说各的；scripts/access-decision-matrix-test.mjs 逐格对照两边。area 是对象（领域标识），不针对某个领域时为 null。
   *   · 建、撤、迁移：只有属主；
   *   · 触发、验收、负责人专有动作：第 1 步只登记、恒为假，还没接到路由上，一律拒；
   *   · 定规范：属主，或持本领域 area-spec 授予的人（硬规则，judgment.ts 的 areaVerdict）；
   *   · 列表：不针对某个领域时谁都能读（内容按下一条过滤）；
   *   · 读领域、规范：看全部的人；或者持有范围正好是 area:<领域>、覆盖这个读动作的授予。
   * 业务状态（撤了只读、还没负责人）回的 409 不在这里，由各写法自己判
   */
  decide(subject: AreaSubject, action: string, area: string | null): AreaDecision {
    const no = (rule: string): AreaDecision => ({ verdict: 'deny', rule, grant: null });
    const ok = (rule: string): AreaDecision => ({ verdict: 'allow', rule, grant: null });
    if (action === 'area.create' || action === 'area.retire' || action === 'area.migrate') return subject.owner ? ok('area-owner') : no('area-owner-only');
    // 触发（建事项带了领域，第 2 步 4a）：属主、管理层（业务侧），或持范围正好是 area:<领域>、覆盖 area.trigger 的授予（领域成员、负责人）。
    // 只认 area:，不认 dept:（过渡期的等同只给台和经验库，judgment-builtins.ts 的 DEPT_AREA_TRANSITIONAL）
    if (action === 'area.trigger') {
      if (subject.owner || subject.seesAll) return ok(subject.owner ? 'area-owner' : 'area-business-side');
      if (area === null) return no('area-scope-required');
      if (!subject.principal) return no('no-grant');
      return areaVerdict({ principal: subject.principal, action, kind: 'write', area });
    }
    if (action === 'area.accept' || AREA_LEAD_ACTIONS.includes(action)) return no('area-step1-not-routed');
    if (action === AREA_SPEC_ACTION) {
      if (subject.owner) return ok('area-owner');
      if (area === null) return no('area-scope-required');
      if (!subject.principal) return no('area-spec-required');
      return areaVerdict({ principal: subject.principal, action: AREA_SPEC_ACTION, kind: 'decide', area });
    }
    if (action === 'area.list' && area === null) return ok('area-list-filtered');
    if (subject.seesAll) return ok(subject.owner ? 'area-owner' : 'area-business-side');
    if (area === null) return no('area-scope-required');
    if (!subject.principal) return no('no-grant');
    return areaVerdict({ principal: subject.principal, action, kind: 'read', area });
  }

  list(): AreaView[] {
    return (db.prepare(`SELECT ${AREA_COLS} FROM areas ORDER BY id`).all() as AreaRow[]).map(areaView);
  }

  get(id: string): AreaView | null {
    const r = db.prepare(`SELECT ${AREA_COLS} FROM areas WHERE id = ?`).get(id) as AreaRow | undefined;
    return r ? areaView(r) : null;
  }

  /** 版本清单（不带正文），新的在前 */
  specs(id: string): AreaSpecMeta[] {
    const a = this.get(id);
    if (!a) return [];
    return (db.prepare(`SELECT ${SPEC_META} FROM area_specs WHERE area_id = ? ORDER BY version DESC`).all(id) as SpecRow[]).map((r) => specMeta(r, a.spec_version));
  }

  spec(id: string, version: number): AreaSpec | null {
    const a = this.get(id);
    if (!a) return null;
    const r = db.prepare(`SELECT ${SPEC_META}, body FROM area_specs WHERE area_id = ? AND version = ?`).get(id, version) as SpecRow | undefined;
    return r ? { ...specMeta(r, a.spec_version), body: String(r.body) } : null;
  }

  private event(areaId: string, kind: 'create' | 'retire' | 'spec-add' | 'spec-activate' | 'migrate' | 'lead-active' | 'lead-missing', version: number | null, actor: AreaActor, now: number, detail = ''): void {
    db.prepare('INSERT INTO area_events (area_id, kind, version, actor, actor_principal, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(areaId, kind, version, actor.by.slice(0, 256), actor.principal, now, detail.slice(0, 500));
  }

  create(input: { id: string; name: string }, actor: AreaActor, now: number): { ok: true; area: AreaView } | AreaRefusal {
    if (!AREA_ID_RE.test(input.id)) return refuse(400, 'area_id_invalid', '领域标识要是小写字母开头的字母、数字、连字符，最多 48 个字符');
    const name = input.name.trim();
    if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) return refuse(400, 'area_name_invalid', '领域名字要是 1～64 个字符，不带控制字符');
    return tx(() => {
      if (db.prepare('SELECT 1 FROM areas WHERE id = ?').get(input.id)) return refuse(409, 'area_exists', `领域 ${input.id} 已经有了（撤了的也占着标识）`);
      const by = actor.by.slice(0, 256);
      db.prepare("INSERT INTO areas (id, name, status, spec_version, source, created_at, created_by, updated_at, updated_by) VALUES (?, ?, 'pending-lead', NULL, 'manual', ?, ?, ?, ?)")
        .run(input.id, name, now, by, now, by);
      this.event(input.id, 'create', null, actor, now);
      return { ok: true as const, area: this.get(input.id)! };
    });
  }

  /** 撤领域：领域改成 retired，范围是 area:<标识> 的没结束的授予一并撤销，同一个写事务；回撤了的授予编号 */
  /**
   * 部门迁成领域（docs/domains-step1.md 第二节第 3 小节），只有属主调。每个部门一个写事务（BEGIN IMMEDIATE），幂等、并发调两次也只成一份：
   *   · 没有同标识领域的，建一个同标识、同名的领域（source = department，pending-lead），留痕一行 migrate（detail 是部门标识）；已有的（含撤了的）不建；
   *   · 部门有生效的负责人授予（dept_lead_grants 里那条还生效）、负责人是启用的人：给他起草一条 area-lead（范围 area:<同标识>、理由「由部门负责人迁移」）
   *     并提交，停在待核等属主放行。去重按「人 + 角色 + 范围」，不看理由：已有一条没结束的（手工的也算，skipped 记 already_open）、
   *     或者迁移起草后被收回、否决过的（refused_before：属主的否决不因再跑一次迁移被推翻），不再起草。负责人停用的、只有字段没有授予的、没有负责人的，不起草；
   *   · 不起草 area-member、area-spec（定规范单独授予，迁移不替属主做决定）；部门成员不迁；旧表一律不删。
   */
  migrateDepartments(actor: AreaActor & { owner: boolean }, now: number): {
    created: { id: string; name: string }[]; drafted: { department: string; grant: number; principal: string }[]; skipped: { department: string; reason: string }[];
  } {
    const out = { created: [] as { id: string; name: string }[], drafted: [] as { department: string; grant: number; principal: string }[], skipped: [] as { department: string; reason: string }[] };
    const grants = svc<GrantService>('grants');
    for (const d of svc<DepartmentService>('departments').list()) {
      if (!AREA_ID_RE.test(d.id)) { out.skipped.push({ department: d.id, reason: 'id_invalid' }); continue; }
      tx(() => {
        const exists = db.prepare('/* area-migrate */ SELECT status FROM areas WHERE id = ?').get(d.id) as { status: AreaStatus } | undefined;
        if (!exists) {
          const by = actor.by.slice(0, 256);
          db.prepare("INSERT INTO areas (id, name, status, spec_version, source, created_at, created_by, updated_at, updated_by) VALUES (?, ?, 'pending-lead', NULL, 'department', ?, ?, ?, ?)")
            .run(d.id, d.name.slice(0, 64), now, by, now, by);
          this.event(d.id, 'migrate', null, actor, now, d.id);
          out.created.push({ id: d.id, name: d.name });
        }
        if (!d.lead) return;
        if (d.lead.grant !== 'active') { out.skipped.push({ department: d.id, reason: 'lead_without_grant' }); return; }
        const p = db.prepare('SELECT kind, status FROM principals WHERE id = ?').get(d.lead.principal) as { kind: string; status: string } | undefined;
        if (!p || p.kind !== 'person' || p.status !== 'active') { out.skipped.push({ department: d.id, reason: 'lead_not_active' }); return; }
        const scope = `area:${d.id}`;
        // 去重按人、角色、范围，不看理由：已有没结束的（手工的也算）、或者迁移起草后被收回（否决）过的，都不再起草
        const handled = grants.migrationHandled(d.lead.principal, 'area-lead', scope, MIGRATE_REASON);
        if (handled) { out.skipped.push({ department: d.id, reason: handled }); return; }
        const r = grants.draftInTx({ principal: d.lead.principal, role: 'area-lead', scope, reason: MIGRATE_REASON }, { by: actor.by, principal: actor.principal, owner: actor.owner }, now, true);
        if (r.ok) out.drafted.push({ department: d.id, grant: r.id, principal: d.lead.principal });
        else out.skipped.push({ department: d.id, reason: r.code });
      });
    }
    return out;
  }

  retire(id: string, reason: string, actor: AreaActor & { owner: boolean }, now: number): { ok: true; area: AreaView; grants_revoked: number[] } | AreaRefusal {
    return tx(() => {
      const a = this.get(id);
      if (!a) return refuse(404, 'area_missing', `领域 ${id} 不存在`);
      if (a.status === 'retired') return refuse(409, 'area_retired', `领域 ${id} 已经撤了，只读`);
      db.prepare("UPDATE areas SET status = 'retired', updated_at = ?, updated_by = ? WHERE id = ?").run(now, actor.by.slice(0, 256), id);
      const revoked = svc<GrantService>('grants').revokeScopeInTx(`area:${id}`, actor, `撤领域 ${id}${reason.trim() ? `：${reason.trim()}` : ''}`, now);
      this.event(id, 'retire', null, actor, now, JSON.stringify({ reason, grants_revoked: revoked }));
      return { ok: true as const, area: this.get(id)!, grants_revoked: revoked };
    });
  }

  /** 新加一版并把生效指针移过去。sha256 是调用方带来核对的（可空） */
  addSpec(id: string, input: { body: string; note: string; sha256: string | null }, actor: AreaActor, now: number): { ok: true; spec: AreaSpecMeta; area: AreaView } | AreaRefusal {
    const bytes = Buffer.byteLength(input.body, 'utf8');
    if (bytes < 1 || bytes > AREA_SPEC_MAX_BYTES) return refuse(400, 'area_spec_body_invalid', `规范正文要是 1 字节～64 KB（现在 ${bytes} 字节）`);
    if (input.note.length > AREA_NOTE_MAX || /[\x00-\x1f\x7f]/.test(input.note)) return refuse(400, 'area_spec_note_invalid', `说明最多 ${AREA_NOTE_MAX} 个字符，不带控制字符`);
    const digest = sha256(input.body);
    if (input.sha256 !== null && (!SHA256_RE.test(input.sha256) || input.sha256 !== digest)) return refuse(400, 'area_spec_sha256_mismatch', 'sha256 和正文对不上');
    return tx(() => {
      const a = this.get(id);
      if (!a) return refuse(404, 'area_missing', `领域 ${id} 不存在`);
      if (a.status === 'retired') return refuse(409, 'area_retired', `领域 ${id} 已经撤了，只读`);
      const max = db.prepare('SELECT MAX(version) AS v FROM area_specs WHERE area_id = ?').get(id) as { v: number | null };
      const version = Number(max.v ?? 0) + 1;
      db.prepare('INSERT INTO area_specs (area_id, version, body, sha256, note, created_at, created_by, created_by_principal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, version, input.body, digest, input.note, now, actor.by.slice(0, 256), actor.principal);
      db.prepare('UPDATE areas SET spec_version = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(version, now, actor.by.slice(0, 256), id);
      this.event(id, 'spec-add', version, actor, now, input.note);
      return { ok: true as const, spec: this.specs(id).find((s) => s.version === version)!, area: this.get(id)! };
    });
  }

  /**
   * 照「有没有生效的负责人」重算领域状态（docs/domains-step1.md 第二节第 1 小节）。授予放行、收回、到期，负责人本人停用、恢复之后调，
   * 在调用方的写事务里跟着走（tx 外面开着就不另开）：有生效的负责人而还是 pending-lead → active，留痕 lead-active；
   * 一个都没有了而还是 active → pending-lead，留痕 lead-missing（写原因），属主在「等你拍板」里看到这个领域（attention-providers.ts 的 areas-no-lead）。
   * 撤了的不动。回改成了什么，没改回 null。
   * 「生效的负责人」：授予生效、没过期、范围正好是 area:<领域>、角色覆盖负责人专有动作，而且被授予的是启用的人（services/grant.ts 的 activeLeadCount）
   */
  reconcileLead(id: string, reason: string, actor: AreaActor, now: number): AreaStatus | null {
    return tx(() => {
      const a = this.get(id);
      if (!a || a.status === 'retired') return null;
      const has = svc<GrantService>('grants').activeLeadCount(id, now) > 0;
      const next: AreaStatus | null = has && a.status === 'pending-lead' ? 'active' : !has && a.status === 'active' ? 'pending-lead' : null;
      if (!next) return null;
      db.prepare('UPDATE areas SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(next, now, actor.by.slice(0, 256), id);
      this.event(id, next === 'active' ? 'lead-active' : 'lead-missing', null, actor, now, reason);
      return next;
    });
  }

  /**
   * 触发、验收的门（用例 28；第 2 步接到「建事项」「验收事项」上）：领域还没有负责人（pending-lead）时回 409，撤了的 409，不存在的 404；能做回 null。
   */
  workGate(id: string): AreaRefusal | null {
    const a = this.get(id);
    if (!a) return refuse(404, 'area_missing', `领域 ${id} 不存在`);
    if (a.status === 'retired') return refuse(409, 'area_retired', `领域 ${id} 已经撤了，只读`);
    if (a.status === 'pending-lead') return refuse(409, 'area_no_lead', `领域 ${id} 还没有负责人：等属主指定负责人之后才能触发、验收`);
    return null;
  }

  /** 没有负责人的领域（没撤的 pending-lead），给属主的待办用 */
  withoutLead(): AreaView[] {
    return (db.prepare(`SELECT ${AREA_COLS} FROM areas WHERE status = 'pending-lead' ORDER BY id`).all() as AreaRow[]).map(areaView);
  }

  /** 这个领域最近一次「没有负责人了」的原因（lead-missing 那一行的 detail）；新建、迁移出来本来就没有的为 null */
  leadMissingReason(id: string): string | null {
    const r = db.prepare("SELECT kind, detail FROM area_events WHERE area_id = ? AND kind IN ('lead-active', 'lead-missing') ORDER BY seq DESC LIMIT 1").get(id) as { kind: string; detail: string } | undefined;
    return r?.kind === 'lead-missing' ? r.detail : null;
  }

  /** 把生效指针移到已有的一版（回退也是它）。不新增版本 */
  activate(id: string, version: number, actor: AreaActor, now: number): { ok: true; area: AreaView } | AreaRefusal {
    return tx(() => {
      const a = this.get(id);
      if (!a) return refuse(404, 'area_missing', `领域 ${id} 不存在`);
      if (a.status === 'retired') return refuse(409, 'area_retired', `领域 ${id} 已经撤了，只读`);
      if (!db.prepare('SELECT 1 FROM area_specs WHERE area_id = ? AND version = ?').get(id, version)) return refuse(400, 'area_spec_version_missing', `领域 ${id} 没有第 ${version} 版规范`);
      db.prepare('UPDATE areas SET spec_version = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(version, now, actor.by.slice(0, 256), id);
      this.event(id, 'spec-activate', version, actor, now);
      return { ok: true as const, area: this.get(id)! };
    });
  }
}
