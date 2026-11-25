/** 报告治理主库账本。授权判据由领域服务提供，并在账本状态转换的事务内复核。 */
import { createHash, randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { HttpError } from '../errors.ts';

const DAY = 86400000;
export const PROPOSAL_TTL = 7 * DAY;
export const GOVERNANCE_AUDIT_TTL = 90 * DAY;
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const BENCH = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEM = /^[a-zA-Z0-9_.:-]{1,128}$/;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ProposalScope = { op: 'bench-bind'; bench: string; dimension: string }
  | { op: 'dimension-create' | 'template-publish' | 'dimension-activate'; area: string; dimension: string };
export type GovernanceChannel = 'rest' | 'mcp-invoke' | 'market' | 'internal';
type Status = 'pending' | 'confirming' | 'confirmed' | 'rejected' | 'withdrawn' | 'expired' | 'conflict';
export type Proposal = {
  id: number;
  session_id: number;
  principal_id: string;
  op: ProposalScope['op'];
  target_key: string;
  request_sha256: string;
  snapshot_sha256: string;
  frozen: string;
  created_at: number;
  expires_at: number;
  status: Status;
  operation_id: string | null;
  confirmed_by: string | null;
  confirming_at: number | null;
  decided_at: number | null;
  reason: string | null;
  result: string | null;
};
export type GovernanceResult = { version: number } | { dimension: string };
export type ProposalInput = {
  sessionId: number;
  principal: string;
  scope: ProposalScope;
  idempotencyKey: string;
  args: Json;
  channel: 'rest' | 'mcp-invoke';
};
function fail(status: number, code: string, message: string): never { throw new HttpError(status, message, { code }); }
function unavailable(): never { return fail(403, 'report_governance_forbidden', '本会话不能访问这项报告治理能力'); }
function conflict(code: string, message: string): never { return fail(409, code, message); }
function activePerson(principal: string): boolean {
  return Boolean(db.prepare("SELECT id FROM principals WHERE id = ? AND kind = 'person' AND status = 'active'").get(principal));
}
function eligibleSession(sessionId: number, principal: string): boolean {
  return activePerson(principal) && Boolean(db.prepare("SELECT id FROM mcp_sessions WHERE id = ? AND revoked_at = '' AND is_system = 0").get(sessionId));
}
export function canonicalGovernanceJson(value: Json): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalGovernanceJson).join(',') + ']';
  if (value && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalGovernanceJson(value[key])).join(',') + '}';
  }
  return fail(400, 'report_governance_args_invalid', '治理提案只接受 JSON 数据');
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function scopeKey(scope: ProposalScope): string {
  const scopeId = scope.op === 'bench-bind' ? scope.bench : scope.area;
  if (!(scope.op === 'bench-bind' ? BENCH : ID).test(scopeId) || !ID.test(scope.dimension)) {
    return fail(400, 'report_governance_scope_invalid', '治理提案须指定合法且精确的作用域');
  }
  return JSON.stringify([scopeId, scope.dimension]);
}

/** 会话读回只给公开字段。跨库确认中的中间态不会冒充业务已成功。 */
export function projectProposal(p: Proposal) {
  return { id: 'p-' + p.id, kind: 'proposal' as const, op: p.op, status: p.status === 'confirming' ? 'pending' : p.status,
    ...(p.reason ? { reason: p.reason } : {}), ...(p.status === 'confirmed' && p.result ? { result: JSON.parse(p.result) as GovernanceResult } : {}) };
}

export class ReportGovernanceProposalService extends Service {
  constructor(ctx: any) {
    super(ctx, 'reportGovernanceProposals');
    ctx.effect(() => {
      const timer = setInterval(() => {
        try { this.maintain(Date.now()); }
        catch (error) { console.error('[report-governance] 提案维护未完成', error); }
      }, 3600000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'reportGovernanceProposals.maintain');
  }

  private tx<T>(fn: () => T): T {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private audit(p: Proposal, action: string, channel: GovernanceChannel, actor: string | null, now: number, op: Proposal['op'] | null = p.op): void {
    db.prepare('INSERT INTO report_governance_audit (at, proposal_id, action, channel, session_id, principal_id, actor_id, op, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now, p.id, action, channel, p.session_id, p.principal_id, actor, op, p.status);
  }
  get(id: number): Proposal | null {
    return (db.prepare('SELECT * FROM report_governance_proposals WHERE id = ?').get(id) as Proposal | undefined) ?? null;
  }
  private pending(id: number, allowed: (p: Proposal) => boolean): Proposal {
    const row = this.get(id);
    if (!row || !allowed(row)) return unavailable();
    if (row.status !== 'pending') return conflict('report_governance_state', '提案已处理或正在确认');
    return row;
  }
  private prior(input: ProposalInput): Proposal | null {
    if (typeof input.idempotencyKey !== 'string' || !IDEM.test(input.idempotencyKey)) return fail(400, 'report_governance_idempotency_invalid', '提案需要合法的幂等键');
    const found = db.prepare('SELECT * FROM report_governance_proposals WHERE session_id = ? AND op = ? AND target_key = ? AND idempotency_key = ?')
      .get(input.sessionId, input.scope.op, scopeKey(input.scope), input.idempotencyKey) as Proposal | undefined;
    if (!found) return null;
    if (found.principal_id !== input.principal) return unavailable();
    if (found.request_sha256 !== sha(canonicalGovernanceJson(input.args))) return conflict('report_governance_idempotency_mismatch', '幂等键已用于不同的提案参数');
    return found;
  }
  replay(input: ProposalInput, now: number, authorized: () => boolean): Proposal | null {
    return this.tx(() => {
      if (!eligibleSession(input.sessionId, input.principal) || !authorized()) return unavailable();
      const found = this.prior(input);
      if (!found) return null;
      const row = this.expirePending(found, now);
      this.audit(row, 'report.governance-propose', input.channel, null, now);
      return row;
    });
  }
  pendingPage(after: number, allowed: (p: Proposal) => boolean) {
    const rows = db.prepare("SELECT * FROM report_governance_proposals WHERE id > ? AND status IN ('pending','confirming') ORDER BY id LIMIT 200").all(after) as Proposal[];
    return { proposals: rows.filter(allowed), next: rows.length === 200 ? rows[rows.length - 1].id : null };
  }
  /** 只对已判权的会话冻结对象。幂等重试只复核原身份与当前授权，不重新捕获输入或对象。 */
  create(input: ProposalInput, now: number, authorized: () => boolean, capture: () => Json): Proposal {
    return this.tx(() => {
      if (!eligibleSession(input.sessionId, input.principal) || !authorized()) return unavailable();
      const found = this.prior(input);
      if (found) {
        const proposal = this.expirePending(found, now);
        this.audit(proposal, 'report.governance-propose', input.channel, null, now);
        return proposal;
      }
      const snapshot = canonicalGovernanceJson(capture());
      const snapshotLimit = input.scope.op === 'template-publish' ? 420000 : 300000;
      if (Buffer.byteLength(snapshot) > snapshotLimit) return fail(400, 'report_governance_snapshot_too_large', '治理提案超出大小限制');
      const row = db.prepare('INSERT INTO report_governance_proposals (session_id, principal_id, op, target_key, idempotency_key, request_sha256, snapshot_sha256, frozen, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .get(input.sessionId, input.principal, input.scope.op, scopeKey(input.scope), input.idempotencyKey, sha(canonicalGovernanceJson(input.args)), sha(snapshot), snapshot, now, now + PROPOSAL_TTL) as Proposal;
      this.audit(row, 'report.governance-propose', input.channel, null, now);
      return row;
    });
  }
  result(id: number, sessionId: number, principal: string, channel: 'rest' | 'mcp-invoke', now: number, authorized: (p: Proposal) => boolean) {
    return this.tx(() => {
      const row = this.get(id);
      if (!row || row.session_id !== sessionId || row.principal_id !== principal || !eligibleSession(sessionId, principal) || !authorized(row)) return unavailable();
      const proposal = this.expirePending(row, now);
      this.audit(proposal, 'report.governance-result', channel, null, now, null);
      return projectProposal(proposal);
    });
  }
  private finish(p: Proposal, status: Exclude<Status, 'pending' | 'confirming'>, now: number, reason: string | null, result: GovernanceResult | null, actor: string | null): Proposal {
    const row = db.prepare('UPDATE report_governance_proposals SET status = ?, decided_at = ?, reason = ?, result = ? WHERE id = ? AND status = ? RETURNING *')
      .get(status, now, reason, result ? JSON.stringify(result) : null, p.id, p.status) as Proposal | undefined;
    if (!row) return conflict('report_governance_state', '提案状态已改变');
    this.audit(row, 'report.governance-' + status, actor ? 'market' : 'internal', actor, now);
    return row;
  }
  private expirePending(p: Proposal, now: number): Proposal {
    return p.status === 'pending' && p.expires_at <= now ? this.finish(p, 'expired', now, 'expired', null, null) : p;
  }
  /** 市场确认必须先经真人鉴权，再对提案会话及责任人作提交边界复核。 */
  claimConfirmation(id: number, confirmer: string, expectedDigest: string, now: number, allowed: (p: Proposal) => boolean, sourceAllowed: (p: Proposal) => boolean): Proposal {
    return this.tx(() => {
      if (!activePerson(confirmer)) return unavailable();
      const p = this.pending(id, allowed);
      if (p.snapshot_sha256 !== expectedDigest) return conflict('report_governance_snapshot_changed', '提案摘要不匹配，重新打开后确认');
      if (p.expires_at <= now) return this.expirePending(p, now);
      if (!eligibleSession(p.session_id, p.principal_id) || !sourceAllowed(p)) return this.finish(p, 'conflict', now, 'authorization_changed', null, confirmer);
      const row = db.prepare("UPDATE report_governance_proposals SET status = 'confirming', operation_id = ?, confirmed_by = ?, confirming_at = ? WHERE id = ? AND status = 'pending' RETURNING *")
        .get(randomUUID(), confirmer, now, id) as Proposal | undefined;
      if (!row) return conflict('report_governance_state', '提案已处理或正在确认');
      this.audit(row, 'report.governance-confirming', 'market', confirmer, now);
      return row;
    });
  }
  /** 单主库动作把授权复核、业务效果、回执与审计放在一个事务。 */
  confirmLocal(id: number, confirmer: string, digest: string, now: number, allowed: (p: Proposal) => boolean,
    sourceAllowed: (p: Proposal) => boolean, execute: (p: Proposal) => { result: GovernanceResult } | { reason: 'target_changed' }): Proposal {
    return this.tx(() => {
      const current = this.get(id);
      if (!current || !allowed(current) || !activePerson(confirmer)) return unavailable();
      if (current.snapshot_sha256 !== digest) return conflict('report_governance_snapshot_changed', '提案摘要不匹配，重新打开后确认');
      if (current.status === 'confirmed') return current;
      const claimed = this.claimConfirmation(id, confirmer, digest, now, allowed, sourceAllowed);
      if (claimed.status !== 'confirming') return claimed;
      return this.settle(id, claimed.operation_id!, now, execute(claimed));
    });
  }

  /** 只有已知的业务提交回执或已证实的冲突可以结束确认；未知结果留在 confirming 对账。 */
  settle(id: number, operationId: string, now: number, outcome: { result: GovernanceResult } | { reason: 'authorization_changed' | 'target_changed' | 'write_conflict' }): Proposal {
    return this.tx(() => {
      const p = this.get(id);
      if (!p || !operationId || p.operation_id !== operationId) return unavailable();
      if (p.status === 'confirmed' || p.status === 'conflict') return p;
      if (p.status !== 'confirming') return conflict('report_governance_state', '提案还没有开始确认');
      return 'result' in outcome
        ? this.finish(p, 'confirmed', now, null, outcome.result, p.confirmed_by)
        : this.finish(p, 'conflict', now, outcome.reason, null, p.confirmed_by);
    });
  }
  cancel(id: number, actor: string, action: 'rejected' | 'withdrawn', now: number, allowed: (p: Proposal) => boolean): Proposal {
    return this.tx(() => {
      if (!activePerson(actor)) return unavailable();
      const p = this.pending(id, allowed);
      if (p.expires_at <= now) return this.expirePending(p, now);
      return this.finish(p, action, now, action, null, actor);
    });
  }
  /** 只按审计时刻清理审计行。原提案、业务回执及未对账的操作号不会被这个周期删除。 */
  maintain(now: number): void {
    this.tx(() => {
      const rows = db.prepare("SELECT * FROM report_governance_proposals WHERE status = 'pending' AND expires_at <= ? ORDER BY id LIMIT 200").all(now) as Proposal[];
      for (const p of rows) this.expirePending(p, now);
      db.prepare('DELETE FROM report_governance_audit WHERE at < ?').run(now - GOVERNANCE_AUDIT_TTL);
    });
  }
}
