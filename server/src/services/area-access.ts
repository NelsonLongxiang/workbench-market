/** 第 16 篇第 2 步。领域接入的申请和决定不改 mcp_sessions.grants。 */
import { Service } from '@deepseek-ai/cordis';
import { svc } from '../context.ts';
import { db } from '../db.ts';
import { HttpError } from '../errors.ts';
import { areaVerdict, rolesCovering } from '../judgment.ts';
import { capabilityIndex } from '../capabilities.ts';
import type { HttpService } from '../http.ts';
import { AREA_ID_RE, type AreaService } from './area.ts';
import type { GrantService } from './grant.ts';
import type { McpService } from './mcp.ts';
import type { PrincipalService } from './principal.ts';

export const AREA_ACCESS_APPROVE = 'area.access-approve';
export const AREA_ACCESS_LIST = 'area.access-requests';
export const AREA_ACCESS_LIMIT = 'area.access-limit-set';
export const REPORT_BIND_ACCESS = 'report.governance-bench-bind';
export type ReportBindGrantScope = { bench: string; dimension: string };
const benchName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const actionName = /^[a-z][a-z0-9-]{0,47}\.[a-z][a-z0-9-]{0,47}$/;
const HOUR = 60 * 60 * 1000;

type Decision = 'approved' | 'rejected';
type RequestRow = {
  id: number; session_id: number; area_id: string; applicant: string; actions: string; reason: string;
  status: 'pending' | Decision; created_at: number; decided_by: string | null; decided_at: number | null;
  note: string; limit_id: number | null; governance_scope: string | null;
};
type LimitRow = { id: number; grant_id: number; actions: string; set_by: string; created_at: number };

const mcp = () => svc<McpService>('mcp');
const areas = () => svc<AreaService>('areas');
const grants = () => svc<GrantService>('grants');
function reject(status: number, code: string, message: string): never {
  throw new HttpError(status, message, { code });
}

function actionList(raw: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(raw) || (!allowEmpty && !raw.length) || raw.length > 100 ||
      raw.some(action => typeof action !== 'string' || !actionName.test(action))) {
    reject(400, 'area_access_actions_invalid', 'actions 要是明确的「域.动词」名称数组，不能使用通配符');
  }
  return [...new Set(raw as string[])].sort();
}

function text(raw: unknown, required: boolean): string {
  if (raw === undefined && !required) return '';
  if (typeof raw !== 'string') reject(400, 'area_access_reason_invalid', '说明须是文字');
  const value = raw.trim();
  if ((required && !value) || [...value].length > 500) reject(400, 'area_access_reason_invalid', '说明不得超过 500 字，申请理由不能为空');
  return value;
}

function activePerson(id: string) {
  const p = svc<PrincipalService>('principals').get(id);
  return p?.kind === 'person' && p.status === 'active';
}

function transaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reportBindScope(raw: unknown): ReportBindGrantScope {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'bench') || !Object.hasOwn(raw, 'dimension')) {
    return reject(400, 'area_access_report_scope_invalid', '报告绑定接入须指定单台和单维度');
  }
  const { bench, dimension } = raw as Record<string, unknown>;
  if (typeof bench !== 'string' || !benchName.test(bench) || typeof dimension !== 'string' || !AREA_ID_RE.test(dimension)) {
    return reject(400, 'area_access_report_scope_invalid', '报告绑定接入须指定单台和单维度');
  }
  return { bench, dimension };
}
/** 作用域绑定真实台登记的身份。台删除、重建或改绑领域不能使旧接入在别的台生效。 */
function reportBindScopeKey(area: string, scope: ReportBindGrantScope): string | null {
  const row = db.prepare("SELECT i.identity, COALESCE((SELECT MAX(a.id) FROM bench_bind_audit a WHERE a.slug = b.slug AND a.action IN ('bind', 'unbind')), 0) AS revision FROM bench_storage_identities i JOIN bench_views b ON b.slug = i.slug WHERE b.slug = ? AND b.department_id = ?")
    .get(scope.bench, area) as { identity: string; revision: number } | undefined;
  return row ? JSON.stringify({ ...scope, identity: row.identity, revision: row.revision }) : null;
}
function reportBindScopeView(encoded: string): ReportBindGrantScope {
  const { bench, dimension } = JSON.parse(encoded) as ReportBindGrantScope;
  return { bench, dimension };
}
function requestView(row: RequestRow) {
  return {
    ref: 'area-' + row.id, area: row.area_id, actions: JSON.parse(row.actions) as string[],
    reason: row.reason, status: row.status, note: row.note, created_at: row.created_at, decided_at: row.decided_at,
    ...(row.governance_scope ? { report_scope: reportBindScopeView(row.governance_scope) } : {}),
  };
}

export class AreaAccessService extends Service {
  constructor(ctx: any) { super(ctx, 'areaAccess'); }

  private applicant(sessionId: number): string {
    const session = mcp().sessionFull(sessionId) as { revoked_at: string } | undefined;
    const principal = mcp().areaAccessPrincipal(sessionId);
    if (!session || session.revoked_at || !principal || !activePerson(principal)) {
      reject(403, 'area_access_unbound_session', '领域能力只接受有可信且启用的责任人的会话');
    }
    return principal;
  }

  private getRequest(id: number): RequestRow | undefined {
    return db.prepare('SELECT * FROM area_access_requests WHERE id = ?').get(id) as RequestRow | undefined;
  }

  private latestLimit(grantId: number): LimitRow | undefined {
    return db.prepare('SELECT * FROM area_access_limits WHERE grant_id = ? ORDER BY id DESC LIMIT 1').get(grantId) as LimitRow | undefined;
  }

  private requireApprover(actor: string, area: string) {
    const decision = areas().decide({ principal: actor, owner: grants().isOwner(actor), seesAll: false }, AREA_ACCESS_APPROVE, area);
    if (decision.verdict !== 'allow') reject(403, 'area_access_approver_required', '只有属主或本领域有接入审批授予的负责人可处理');
  }

  submit(sessionId: number, input: { area?: unknown; actions?: unknown; reason?: unknown; tools?: unknown; report_scope?: unknown }, now = Date.now()) {
    return transaction(() => {
      const applicant = this.applicant(sessionId);
      const area = input.area;
      if (typeof area !== 'string' || !AREA_ID_RE.test(area) || input.tools !== undefined) {
        reject(400, 'area_access_scope_invalid', '领域申请须指定一个 area，不与 tools 申请混写');
      }
      if (areas().get(area)?.status !== 'active') reject(403, 'area_access_unavailable', '这个领域当前不接受接入申请');
      const selected = actionList(input.actions);
      let scope: string | null = null;
      if (selected.includes(REPORT_BIND_ACCESS)) {
        if (selected.length !== 1) reject(400, 'area_access_report_scope_invalid', '报告绑定操作须单独申请');
        scope = reportBindScopeKey(area, reportBindScope(input.report_scope));
        if (!scope) reject(403, 'area_access_unavailable', '这个领域当前不接受此台的接入申请');
      } else if (input.report_scope !== undefined) {
        reject(400, 'area_access_report_scope_invalid', '只有报告绑定接入可指定报告作用域');
      }
      const actions = JSON.stringify(selected);
      const reason = text(input.reason, true);
      const same = db.prepare("SELECT * FROM area_access_requests WHERE session_id = ? AND applicant = ? AND area_id = ? AND actions = ? AND governance_scope IS ? AND status = 'pending' ORDER BY id LIMIT 1")
        .get(sessionId, applicant, area, actions, scope) as RequestRow | undefined;
      if (same) return { ok: true, duplicate: true, request: requestView(same) };
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM area_access_requests WHERE session_id = ? AND created_at > ?').get(sessionId, now - HOUR) as { n: number };
      if (n >= 10) reject(429, 'area_access_rate_limited', '每个会话每小时最多提交 10 条领域接入申请');
      const created = db.prepare('INSERT INTO area_access_requests (session_id, area_id, applicant, actions, reason, created_at, governance_scope) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .get(sessionId, area, applicant, actions, reason, now, scope) as RequestRow;
      return { ok: true, duplicate: false, request: requestView(created) };
    });
  }

  /** 第 4 步调用时复用这一交集。只问当前授权，避免缓存过期权限。 */
  effectiveActions(sessionId: number, area: unknown, now = Date.now()) {
    const principal = this.applicant(sessionId);
    if (typeof area !== 'string' || !AREA_ID_RE.test(area)) reject(400, 'area_access_scope_invalid', '请指定一个合法的领域标识');
    if (areas().get(area)?.status !== 'active') return { area, effective_actions: [] };
    const approvals = db.prepare("SELECT actions FROM area_access_requests WHERE session_id = ? AND applicant = ? AND area_id = ? AND status = 'approved' AND governance_scope IS NULL")
      .all(sessionId, principal, area) as { actions: string }[];
    const catalog = new Map(svc<HttpService>('http').actions().map(({ action, kind }) => [action, kind]));
    for (const cap of capabilityIndex()) if (cap.area === area) catalog.set(cap.name, cap.kind);
    const actions = new Set(approvals.flatMap(row => JSON.parse(row.actions) as string[]));
    const effective_actions = [...actions].filter(action => {
      const kind = catalog.get(action);
      return kind !== undefined && areaVerdict({ principal, area, action, kind, now }).verdict === 'allow';
    }).sort();
    return { area, effective_actions };
  }

  reportBindApprovals(sessionId: number, principal: string): (ReportBindGrantScope & { area: string })[] {
    const rows = db.prepare("SELECT area_id, governance_scope FROM area_access_requests WHERE session_id = ? AND applicant = ? AND status = 'approved' AND governance_scope IS NOT NULL AND actions = ?")
      .all(sessionId, principal, JSON.stringify([REPORT_BIND_ACCESS])) as { area_id: string; governance_scope: string }[];
    const active = new Map<string, ReportBindGrantScope & { area: string }>();
    for (const row of rows) {
      const scope = reportBindScopeView(row.governance_scope);
      if (areas().get(row.area_id)?.status === 'active' && reportBindScopeKey(row.area_id, scope) === row.governance_scope) {
        active.set(row.governance_scope, { ...scope, area: row.area_id });
      }
    }
    return [...active.values()];
  }

  hasReportBindApproval(sessionId: number, principal: string, area: string, scope: ReportBindGrantScope): boolean {
    if (areas().get(area)?.status !== 'active') return false;
    const key = reportBindScopeKey(area, scope);
    return key !== null && Boolean(db.prepare("SELECT id FROM area_access_requests WHERE session_id = ? AND applicant = ? AND area_id = ? AND status = 'approved' AND governance_scope = ? AND actions = ?")
      .get(sessionId, principal, area, key, JSON.stringify([REPORT_BIND_ACCESS])));
  }

  requestForSession(sessionId: number, id: number) {
    const applicant = this.applicant(sessionId);
    const row = this.getRequest(id);
    if (!row || row.session_id !== sessionId || row.applicant !== applicant) reject(404, 'area_access_request_missing', '本会话没有这条领域申请');
    return requestView(row);
  }

  pending(actor: string, area: string) {
    this.requireApprover(actor, area);
    const rows = db.prepare("SELECT * FROM area_access_requests WHERE area_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 100").all(area) as RequestRow[];
    return rows.map(row => ({ ...requestView(row), id: row.id, applicant: row.applicant }));
  }

  setLimit(actor: string, area: string, grantId: number, raw: unknown, now = Date.now()) {
    return transaction(() => {
      if (areas().decide({ principal: actor, owner: grants().isOwner(actor), seesAll: false }, AREA_ACCESS_LIMIT, area).verdict !== 'allow') {
        reject(403, 'area_access_owner_required', '只有登录的属主可以设置接入动作上限');
      }
      const grant = grants().get(grantId);
      if (!grant || grant.scope !== 'area:' + area || !rolesCovering(AREA_ACCESS_APPROVE, 'decide').includes(grant.role)) {
        reject(404, 'area_access_grant_missing', '该领域没有这条负责人授予');
      }
      if (grant.status !== 'active' || (grant.expires_at !== null && grant.expires_at <= now)) {
        reject(409, 'area_access_grant_inactive', '只可设置生效中负责人授予的动作上限');
      }
      const actions = actionList(raw, true);
      const encoded = JSON.stringify(actions);
      const latest = this.latestLimit(grant.id);
      if (latest?.actions === encoded) return { id: latest.id, grant_id: grant.id, actions };
      const created = db.prepare('INSERT INTO area_access_limits (grant_id, actions, set_by, created_at) VALUES (?, ?, ?, ?) RETURNING id')
        .get(grant.id, encoded, actor, now) as { id: number };
      return { id: created.id, grant_id: grant.id, actions };
    });
  }

  decide(actor: string, area: string, id: number, status: Decision, explanation: unknown, now = Date.now()) {
    return transaction(() => {
      // 检查领域范围后才按此领域查请求；写事务内复核当前身份、权限与上限。
      this.requireApprover(actor, area);
      const row = this.getRequest(id);
      if (!row || row.area_id !== area) reject(404, 'area_access_request_missing', '此领域没有这条申请');
      if (row.status !== 'pending') reject(409, 'area_access_already_decided', '这条申请已处理');
      let limitId: number | null = null;
      if (status === 'approved') {
        const current = this.applicant(row.session_id);
        if (current !== row.applicant) reject(409, 'area_access_applicant_changed', '会话责任人已变，请重新申请');
        if (actor === current) reject(403, 'area_access_self_approval', '不能批准自己账户名下会话的申请');
        if (row.governance_scope && reportBindScopeKey(area, reportBindScopeView(row.governance_scope)) !== row.governance_scope) {
          reject(409, 'area_access_report_scope_changed', '报告绑定申请的台登记或所属领域已变');
        }
        if (!grants().isOwner(actor)) {
          const needed = JSON.parse(row.actions) as string[];
          const roles = rolesCovering(AREA_ACCESS_APPROVE, 'decide');
          const active = grants().activeFor(actor, now).filter(g => g.scope === 'area:' + area && roles.includes(g.role));
          const limit = active.map(g => this.latestLimit(g.id)).find(l => {
            if (!l) return false;
            const allowed = new Set(JSON.parse(l.actions) as string[]);
            return needed.every(action => allowed.has(action));
          });
          if (!limit) reject(403, 'area_access_above_limit', '只能批准属主为本领域该授予明确列出的动作');
          limitId = limit.id;
        }
      }
      const note = text(explanation, false);
      const updated = db.prepare("UPDATE area_access_requests SET status = ?, decided_by = ?, decided_at = ?, note = ?, limit_id = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .get(status, actor, now, note, limitId, row.id) as RequestRow | undefined;
      if (!updated) reject(409, 'area_access_already_decided', '这条申请已处理');
      return requestView(updated);
    });
  }
}
