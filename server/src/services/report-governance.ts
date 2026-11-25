/** 首个报告治理操作：提案只冻结作用域和目标，业务写入只经真人的确认。 */
import { createHash } from 'node:crypto';
import { svc } from '../context.ts';
import { db as main } from '../db.ts';
import { HttpError } from '../errors.ts';
import { BenchError } from '../bench-query.ts';
import { canBenchAction } from './bench-access.ts';
import { captureBenchStorageFence, getBench, type BenchEntry } from './bench-registry.ts';
import { benchStore, benchStoreExists } from './bench-store.ts';
import { compiled, usableDimension } from './bench-report.ts';
import { checkBinding, type Binding } from './report-compile.ts';
import { REPORT_BIND_ACCESS, REPORT_CREATE_ACCESS, REPORT_PUBLISH_ACCESS, REPORT_REVIEW_INVITE_ACCESS, REPORT_ACTIVATE_ACCESS, type AreaAccessService, type ReportDimensionAccess } from './area-access.ts';
import type { AreaService } from './area.ts';
import type { GrantService } from './grant.ts';
import { type ReportDimensionService, normalizeDimensionTitle } from './report-dimension.ts';
import type { McpService } from './mcp.ts';
import type { PrincipalService } from './principal.ts';
import { canonicalGovernanceJson, projectProposal, PROPOSAL_TTL, type Json, type Proposal, type ProposalInput, type ReportGovernanceProposalService } from './report-governance-proposal.ts';

export const GOVERNANCE_PROPOSE = 'report.governance-propose';
export const GOVERNANCE_RESULT = 'report.governance-result';
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const BENCH = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const BIND = 'bench-store.report-bind';
const ledger = () => svc<ReportGovernanceProposalService>('reportGovernanceProposals');
const approvals = () => svc<AreaAccessService>('areaAccess');
const mcp = () => svc<McpService>('mcp');
const principals = () => svc<PrincipalService>('principals');
const dimensions = () => svc<ReportDimensionService>('reportDimensions');
const areas = () => svc<AreaService>('areas');

type Session = { id: number } | null;
type Channel = 'rest' | 'mcp-invoke';
type BindArgs = { bench: string; dimension: string; template_version: number; template_sha256: string;
  base: number; view_version: number; view_sha256: string; slots: unknown };
type FrozenBinding = Awaited<ReturnType<typeof capture>>;
type FrozenTemplatePublish = {
  scope: { area: string; dimension: string };
  args: { body_json: string; note: string };
  snapshot: { body_sha256: string; criteria_sha256: string; kind: 'criteria' | 'layout'; latest_version: number };
};
type FrozenDimensionActivation = { scope: { area: string; dimension: string }; snapshot: NonNullable<ReturnType<ReportDimensionService['activationSnapshot']>> };
type FrozenDimensionCreate = { scope: { area: string; dimension: string }; args: { title: string }; snapshot: { area_status: 'active' } };

export function governanceForbidden(): never {
  throw new HttpError(403, '本会话不能访问这项报告治理能力', { code: 'report_governance_forbidden' });
}
function invalid(message: string): never { throw new HttpError(400, message, { code: 'report_governance_args_invalid' }); }
function changed(message: string): never { throw new HttpError(409, message, { code: 'report_governance_target_changed' }); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const r = record(value);
  if (!r || Object.keys(r).length !== fields.length || fields.some(key => !Object.hasOwn(r, key))) return invalid('治理调用参数缺少必填项或包含未声明字段');
  return r;
}
function activePrincipal(session: Session): string {
  const principal = session ? mcp().areaAccessPrincipal(session.id) : null;
  if (!principal || principals().get(principal)?.status !== 'active' || principals().get(principal)?.kind !== 'person') return governanceForbidden();
  return principal;
}
function mayBind(principal: string, bench: BenchEntry): boolean {
  const p = principals().get(principal);
  return !!p && p.kind === 'person' && p.status === 'active' && canBenchAction({ type: 'principal', id: p.id, kind: p.kind, status: p.status, owner: p.owner }, BIND, bench);
}
function sourceAllowed(sessionId: number, principal: string, benchSlug: string, dimension: string, area: string): boolean {
  const bench = getBench(benchSlug);
  return !!bench && bench.department_id === area && mcp().areaAccessPrincipal(sessionId) === principal && mayBind(principal, bench) &&
    approvals().hasReportBindApproval(sessionId, principal, area, { bench: benchSlug, dimension });
}
function maySetDimension(principal: string, area: string): boolean {
  const person = principals().get(principal);
  return !!person && person.status === 'active' && person.kind === 'person' && dimensions().decideSet({
    principal, owner: svc<GrantService>('grants').isOwner(principal),
  }, area).verdict === 'allow';
}
function dimensionCreateAllowed(sessionId: number, principal: string, area: string): boolean {
  return mcp().areaAccessPrincipal(sessionId) === principal && maySetDimension(principal, area) && approvals().hasReportCreateApproval(sessionId, principal, area);
}
function dimensionOperationAllowed(sessionId: number, principal: string, area: string, dimension: string, action: ReportDimensionAccess): boolean {
  return mcp().areaAccessPrincipal(sessionId) === principal && maySetDimension(principal, area) &&
    approvals().hasReportDimensionApproval(sessionId, principal, area, dimension, action);
}
export function governanceCatalog(session: Session, details: boolean) {
  const principal = session ? mcp().areaAccessPrincipal(session.id) : null;
  const scopes = session && principal ? approvals().reportBindApprovals(session.id, principal)
    .filter(scope => sourceAllowed(session.id, principal, scope.bench, scope.dimension, scope.area)) : [];
  const createAreas = session && principal ? approvals().reportCreateAreas(session.id, principal).filter(area => maySetDimension(principal, area)) : [];
  const publishScopes = session && principal ? approvals().reportDimensionApprovals(session.id, principal, REPORT_PUBLISH_ACCESS).filter(scope => maySetDimension(principal, scope.area)) : [];
  const inviteScopes = session && principal ? approvals().reportDimensionApprovals(session.id, principal, REPORT_REVIEW_INVITE_ACCESS).filter(scope => maySetDimension(principal, scope.area)) : [];
  const activateScopes = session && principal ? approvals().reportDimensionApprovals(session.id, principal, REPORT_ACTIVATE_ACCESS).filter(scope => maySetDimension(principal, scope.area)) : [];
  const granted = scopes.length > 0 || createAreas.length > 0 || publishScopes.length > 0 || inviteScopes.length > 0 || activateScopes.length > 0;
  const propose = { name: GOVERNANCE_PROPOSE, description: '提出报告治理请求，由站内有权的人确认', area: '按目标台和维度', kind: 'decide', granted };
  const result = { name: GOVERNANCE_RESULT, description: '查询本会话提出的报告治理请求', area: '按原目标台和维度', kind: 'read', granted };
  if (!details) return [propose, result];
  return [{ ...propose, skill: 'wm-report-governance', scopes,
    activation: { action: REPORT_BIND_ACCESS, report_scope: ['bench', 'dimension'] },
    ops: { 'dimension-create': { args: { area: 'string', id: 'string', title: 'string' }, activation: { action: REPORT_CREATE_ACCESS }, areas: createAreas },
      'template-publish': { args: { dimension: 'string', body: 'object', body_sha256: 'sha256', criteria_sha256: 'sha256',
        expected_kind: ['criteria', 'layout'], expected_latest_version: 'integer', note: 'string' },
        activation: { action: REPORT_PUBLISH_ACCESS, report_scope: ['dimension'] }, scopes: publishScopes },
      'dimension-activate': { args: { dimension: 'string', version: 'integer', body_sha256: 'sha256', criteria_sha256: 'sha256', expected_active_version: 'integer or null', review_version: 'integer' },
        activation: { action: REPORT_ACTIVATE_ACCESS, report_scope: ['dimension'] }, scopes: activateScopes },
      'review-invite': { args: { dimension: 'string', version: 'integer', body_sha256: 'sha256', criteria_sha256: 'sha256', invitees: '1–5 人的主体标识' },
        activation: { action: REPORT_REVIEW_INVITE_ACCESS, report_scope: ['dimension'] }, scopes: inviteScopes },
      'bench-bind': { args: { bench: 'string', dimension: 'string', template_version: 'integer', template_sha256: 'sha256',
      base: 'integer', view_version: 'integer', view_sha256: 'sha256', slots: 'object' } } },
    openapi: { method: 'POST', path: '/api/report-governance/proposals', required: ['op', 'args', 'idempotency_key'] },
    errors: { report_governance_forbidden: '需要有可信责任人的会话，并已获该台和维度范围的批准及本人授予',
      report_governance_target_changed: '重新读取绑定、模板和视图后重提' } },
  { ...result, skill: 'wm-report-governance', scopes, dimension_create_areas: createAreas, template_publish_scopes: publishScopes, review_invite_scopes: inviteScopes, dimension_activate_scopes: activateScopes, openapi: { method: 'GET', path: '/api/report-governance/proposals/{id}', required: ['id'] } }];
}
function scopeOf(p: Proposal): FrozenBinding['scope'] {
  return (JSON.parse(p.frozen) as FrozenBinding).scope;
}
function allowsProposalSource(p: Proposal): boolean {
  if (p.op === 'dimension-create') return dimensionCreateAllowed(p.session_id, p.principal_id, scopeOf(p).area);
  if (p.op === 'template-publish' || p.op === 'dimension-activate') {
    const { area, dimension } = scopeOf(p);
    return dimensionOperationAllowed(p.session_id, p.principal_id, area, dimension, p.op === 'template-publish' ? REPORT_PUBLISH_ACCESS : REPORT_ACTIVATE_ACCESS);
  }
  if (p.op !== 'bench-bind') return false;
  const { bench, dimension, area } = scopeOf(p);
  return sourceAllowed(p.session_id, p.principal_id, bench, dimension, area);
}
function mayConfirm(principal: string, p: Proposal): boolean {
  if (p.op === 'dimension-create' || p.op === 'template-publish' || p.op === 'dimension-activate') return maySetDimension(principal, scopeOf(p).area);
  if (p.op !== 'bench-bind') return false;
  const { bench, area } = scopeOf(p);
  const current = getBench(bench);
  return !!current && current.department_id === area && mayBind(principal, current);
}
const snapshotJson = (value: unknown) => canonicalGovernanceJson(value as Json);

async function capture(bench: BenchEntry, args: BindArgs) {
  const template = usableDimension(bench, args.dimension);
  if (template.version !== args.template_version || template.sha256 !== args.template_sha256) return changed('生效模板版本或摘要已改变');
  const slots = compiled(() => checkBinding(template.template, args.slots));
  const store = await benchStore(bench.slug);
  const snapshot = await store.reportBindingSnapshot(template.id, slots);
  if (args.base !== snapshot.base || args.view_version !== snapshot.context.view || args.view_sha256 !== snapshot.viewSha256) {
    return changed('绑定基版或生效视图已改变');
  }
  for (const [name, slot] of Object.entries(slots)) {
    const contract = snapshot.slotContracts[name];
    if (!contract || Object.keys(slot.params).sort().join() !== contract.parameters.join()) return invalid('槽参数必须与查询声明一致');
    for (const column of template.template.slots[name].columns) {
      const actual = contract.columns.find(c => c.name === slot.columns[column.name]);
      if (!actual || actual.type !== column.type) return invalid('槽列映射与实际输出列类型不符');
    }
  }
  return { scope: { bench: bench.slug, dimension: template.id, area: bench.department_id },
    args: { ...args, slots }, snapshot };
}

function proposeDimension(sessionId: number, principal: string, body: Record<string, unknown>, channel: Channel) {
  const raw = record(body.args);
  const area = raw?.area;
  if (typeof area !== 'string' || !ID.test(area) || !dimensionCreateAllowed(sessionId, principal, area)) return governanceForbidden();
  const { id, title } = exact(raw, ['area', 'id', 'title']);
  if (typeof id !== 'string' || !ID.test(id)) return invalid('报告维度标识格式不对');
  const normalized = normalizeDimensionTitle(title);
  if (normalized === null) return invalid('维度名字要为 1～64 个字符，且不带控制字符');
  if (typeof body.idempotency_key !== 'string') return invalid('治理提案须指定幂等键');
  const row = ledger().create({ sessionId, principal, scope: { op: 'dimension-create', area, dimension: id },
    idempotencyKey: body.idempotency_key, args: { area, id, title: normalized }, channel }, Date.now(),
    () => dimensionCreateAllowed(sessionId, principal, area), () => {
      if (dimensions().get(id)) return changed('维度标识已被占用');
      const frozen: FrozenDimensionCreate = { scope: { area, dimension: id }, args: { title: normalized }, snapshot: { area_status: 'active' } };
      return frozen;
    });
  return { id: 'p-' + row.id, status: 'pending' as const };
}

function proposeTemplate(sessionId: number, principal: string, body: Record<string, unknown>, channel: Channel) {
  const raw = record(body.args);
  const id = raw?.dimension;
  if (typeof id !== 'string' || !ID.test(id)) return governanceForbidden();
  const area = dimensions().get(id)?.area_id;
  if (!area || !dimensionOperationAllowed(sessionId, principal, area, id, REPORT_PUBLISH_ACCESS)) return governanceForbidden();
  const args = exact(raw, ['dimension', 'body', 'body_sha256', 'criteria_sha256', 'expected_kind', 'expected_latest_version', 'note']);
  const { body_sha256, criteria_sha256, expected_kind, expected_latest_version, note } = args;
  if (typeof body_sha256 !== 'string' || !SHA.test(body_sha256) || typeof criteria_sha256 !== 'string' || !SHA.test(criteria_sha256) ||
      (expected_kind !== 'layout' && expected_kind !== 'criteria') || !Number.isSafeInteger(expected_latest_version) || Number(expected_latest_version) < 0 || typeof note !== 'string') {
    return invalid('发版须给出两个摘要、预期分类、最新模板版本及说明');
  }
  if (typeof body.idempotency_key !== 'string') return invalid('治理提案须指定幂等键');
  if (!record(args.body)) return invalid('模板正文须为对象');
  const bodyJson = JSON.stringify(args.body);
  const input = { body: args.body, note, sha256: body_sha256 };
  const row = ledger().create({ sessionId, principal, scope: { op: 'template-publish', area, dimension: id },
    idempotencyKey: body.idempotency_key, args: { ...args, body: bodyJson } as Json, channel }, Date.now(),
    () => dimensionOperationAllowed(sessionId, principal, area, id, REPORT_PUBLISH_ACCESS), () => {
      const current = dimensions().previewTemplate(id, input, principal);
      if (!current.ok) {
        if (current.code === 'report_template_sha256_mismatch' || current.http !== 400) return changed('当前模板正文、分类或版本与提案不符');
        return invalid(current.message);
      }
      const p = current.preview;
      if (p.criteriaSha256 !== criteria_sha256 || p.kind !== expected_kind || p.latestVersion !== expected_latest_version) {
        return changed('当前模板判据摘要、分类或版本与提案不符');
      }
      // 用同发版的序列化保存正文，避免提案的键排序改变正文摘要。
      const frozen: FrozenTemplatePublish = { scope: { area, dimension: id }, args: { body_json: p.text, note },
        snapshot: { body_sha256: p.bodySha256, criteria_sha256: p.criteriaSha256, kind: p.kind, latest_version: p.latestVersion } };
      return frozen;
    });
  return { id: 'p-' + row.id, status: 'pending' as const };
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function proposeActivation(sessionId: number, principal: string, body: Record<string, unknown>, channel: Channel) {
  const raw = record(body.args);
  const id = raw?.dimension;
  if (typeof id !== 'string' || !ID.test(id)) return governanceForbidden();
  const area = dimensions().get(id)?.area_id;
  if (!area || !dimensionOperationAllowed(sessionId, principal, area, id, REPORT_ACTIVATE_ACCESS)) return governanceForbidden();
  const args = exact(raw, ['dimension', 'version', 'body_sha256', 'criteria_sha256', 'expected_active_version', 'review_version']);
  const { version, body_sha256, criteria_sha256, expected_active_version, review_version } = args;
  if (!validVersion(version) || !validVersion(review_version) || (expected_active_version !== null && !validVersion(expected_active_version)) ||
      typeof body_sha256 !== 'string' || !SHA.test(body_sha256) || typeof criteria_sha256 !== 'string' || !SHA.test(criteria_sha256)) {
    return invalid('激活须指定目标版本、两条摘要、当前生效版本（未生效时为 null）及用于核对的复核版本');
  }
  if (typeof body.idempotency_key !== 'string') return invalid('治理提案须指定幂等键');
  const scope = { op: 'dimension-activate' as const, area, dimension: id };
  const stillAllowed = () => dimensionOperationAllowed(sessionId, principal, area, id, REPORT_ACTIVATE_ACCESS);
  const row = ledger().create({ sessionId, principal, scope, args: args as Json, idempotencyKey: body.idempotency_key, channel }, Date.now(), stillAllowed, () => {
    const snapshot = dimensions().activationSnapshot(id, version, review_version);
    if (!snapshot || (snapshot.active?.version ?? null) !== expected_active_version ||
        snapshot.target.body_sha256 !== body_sha256 || snapshot.target.criteria_sha256 !== criteria_sha256) {
      return changed('当前生效版本、目标模板摘要或指定复核与提案不符');
    }
    const frozen: FrozenDimensionActivation = { scope: { area, dimension: id }, snapshot };
    return frozen;
  });
  return { id: 'p-' + row.id, status: 'pending' as const };
}

type InviteReason = 'expired' | 'revoked' | 'superseded' | 'ineligible';
type ReviewInvite = { id: number; dimension_id: string; area_id: string; version: number; body_sha256: string; criteria_sha256: string;
  session_id: number; principal_id: string; request_sha256: string; created_at: number; expires_at: number; void_reason: InviteReason | null };

function txInvite<T>(run: () => T): T {
  main.exec('BEGIN IMMEDIATE');
  try { const result = run(); main.exec('COMMIT'); return result; }
  catch (error) { main.exec('ROLLBACK'); throw error; }
}
function inviteAllowed(sessionId: number, principal: string, area: string, dimension: string): boolean {
  return mcp().areaAccessPrincipal(sessionId) === principal && maySetDimension(principal, area) &&
    approvals().hasReportDimensionApproval(sessionId, principal, area, dimension, REPORT_REVIEW_INVITE_ACCESS);
}
function canReview(principal: string, invite: Pick<ReviewInvite, 'dimension_id' | 'area_id' | 'criteria_sha256'>): boolean {
  return maySetDimension(principal, invite.area_id) && dimensions().mayReviewInvitation(invite.dimension_id, invite.criteria_sha256, principal);
}
function supersededCriteria(dimension: string, version: number, digest: string): boolean {
  return Boolean(main.prepare('SELECT 1 FROM report_templates WHERE dimension_id = ? AND version > ? AND criteria_sha256 <> ? LIMIT 1')
    .get(dimension, version, digest));
}
function inviteStatus(row: ReviewInvite, now: number): InviteReason | null {
  if (row.void_reason) return row.void_reason;
  if (row.expires_at <= now) return 'expired';
  if (!inviteAllowed(row.session_id, row.principal_id, row.area_id, row.dimension_id)) return 'revoked';
  if (supersededCriteria(row.dimension_id, row.version, row.criteria_sha256)) return 'superseded';
  const people = main.prepare('SELECT principal_id FROM report_governance_invitees WHERE invite_id = ?').all(row.id) as { principal_id: string }[];
  return people.length > 0 && people.every(p => canReview(p.principal_id, row)) ? null : 'ineligible';
}
function updateInviteStatus(row: ReviewInvite, now: number): InviteReason | null {
  const reason = inviteStatus(row, now);
  if (reason && !row.void_reason) main.prepare('UPDATE report_governance_invites SET void_reason = ? WHERE id = ? AND void_reason IS NULL').run(reason, row.id);
  return reason;
}
function auditInvite(row: ReviewInvite, action: string, channel: Channel, now: number, reason: InviteReason | null) {
  main.prepare('INSERT INTO report_governance_audit (at, proposal_id, action, channel, session_id, principal_id, op, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now, -row.id, action, channel, row.session_id, row.principal_id, action === GOVERNANCE_PROPOSE ? 'review-invite' : null, reason ? 'void' : 'active');
}
function inviteView(row: ReviewInvite, reason: InviteReason | null) {
  return { id: 'i-' + row.id, kind: 'invite', status: reason ? 'void' : 'active', ...(reason ? { reason } : {}), expires_at: row.expires_at };
}
function proposeReviewInvite(sessionId: number, principal: string, body: Record<string, unknown>, channel: Channel) {
  const raw = record(body.args);
  const dimension = raw?.dimension;
  if (typeof dimension !== 'string' || !ID.test(dimension)) return governanceForbidden();
  const area = dimensions().get(dimension)?.area_id;
  if (!area || !inviteAllowed(sessionId, principal, area, dimension)) return governanceForbidden();
  const { version, body_sha256, criteria_sha256, invitees } = exact(raw, ['dimension', 'version', 'body_sha256', 'criteria_sha256', 'invitees']);
  const key = body.idempotency_key;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key) || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 ||
      typeof body_sha256 !== 'string' || !SHA.test(body_sha256) || typeof criteria_sha256 !== 'string' || !SHA.test(criteria_sha256) ||
      !Array.isArray(invitees) || invitees.length < 1 || invitees.length > 5 || new Set(invitees).size !== invitees.length ||
      invitees.some(id => typeof id !== 'string' || !/^[^\s]{1,256}$/.test(id))) return invalid('邀请须钉定版本、两个摘要和 1～5 位不同的复核人');
  const people = (invitees as string[]).slice().sort();
  const digest = createHash('sha256').update(JSON.stringify([version, body_sha256, criteria_sha256, people])).digest('hex');
  return txInvite(() => {
    if (!inviteAllowed(sessionId, principal, area, dimension)) return governanceForbidden();
    const now = Date.now();
    const prior = main.prepare('SELECT * FROM report_governance_invites WHERE session_id = ? AND dimension_id = ? AND idempotency_key = ?').get(sessionId, dimension, key) as ReviewInvite | undefined;
    if (prior) {
      if (prior.principal_id !== principal) return governanceForbidden();
      if (prior.request_sha256 !== digest) return changed('幂等键已经用于不同的复核邀请');
      const reason = updateInviteStatus(prior, now);
      auditInvite(prior, GOVERNANCE_PROPOSE, channel, now, reason);
      return inviteView(prior, reason);
    }
    const template = dimensions().template(dimension, version);
    if (!template || template.sha256 !== body_sha256 || template.criteria_sha256 !== criteria_sha256 ||
        supersededCriteria(dimension, version, criteria_sha256)) return changed('复核目标的版本或摘要已改变');
    if (!people.every(person => canReview(person, { area_id: area, dimension_id: dimension, criteria_sha256 }))) {
      return invalid('被邀请人里有人不符合复核条件');
    }
    const row = main.prepare('INSERT INTO report_governance_invites (session_id, principal_id, area_id, dimension_id, version, body_sha256, criteria_sha256, idempotency_key, request_sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(sessionId, principal, area, dimension, version, body_sha256, criteria_sha256, key, digest, now, now + PROPOSAL_TTL) as ReviewInvite;
    const to = main.prepare('INSERT INTO report_governance_invitees (invite_id, principal_id) VALUES (?, ?)');
    for (const person of people) to.run(row.id, person);
    auditInvite(row, GOVERNANCE_PROPOSE, channel, now, null);
    return inviteView(row, null);
  });
}

export async function proposeReportGovernance(session: Session, input: unknown, channel: Channel) {
  const principal = activePrincipal(session);
  const body = exact(input, ['op', 'args', 'idempotency_key']);
  if (body.op === 'dimension-create') return proposeDimension(session!.id, principal, body, channel);
  if (body.op === 'template-publish') return proposeTemplate(session!.id, principal, body, channel);
  if (body.op === 'dimension-activate') return proposeActivation(session!.id, principal, body, channel);
  if (body.op === 'review-invite') return proposeReviewInvite(session!.id, principal, body, channel);
  if (body.op !== 'bench-bind') return governanceForbidden();
  const raw = record(body.args);
  const benchId = raw?.bench, dimension = raw?.dimension;
  if (typeof benchId !== 'string' || !BENCH.test(benchId) || typeof dimension !== 'string' || !ID.test(dimension)) return governanceForbidden();
  const bench = getBench(benchId);
  if (!bench || !sourceAllowed(session!.id, principal, benchId, dimension, bench.department_id)) return governanceForbidden();
  const args = exact(raw, ['bench', 'dimension', 'template_version', 'template_sha256', 'base', 'view_version', 'view_sha256', 'slots']);
  for (const key of ['template_version', 'view_version', 'base']) if (!Number.isSafeInteger(args[key]) || Number(args[key]) < (key === 'base' ? 0 : 1)) {
    return invalid('模板、视图版本和绑定基版须为合法整数');
  }
  for (const key of ['template_sha256', 'view_sha256']) if (typeof args[key] !== 'string' || !SHA.test(args[key])) return invalid('模板和视图摘要须为 SHA-256');
  if (typeof body.idempotency_key !== 'string') return invalid('治理提案须指定幂等键');
  const scope = { op: 'bench-bind' as const, bench: benchId, dimension };
  const request: ProposalInput = { sessionId: session!.id, principal, scope, idempotencyKey: body.idempotency_key, args: args as Json, channel };
  const stillAllowed = () => sourceAllowed(session!.id, principal, benchId, dimension, bench.department_id);
  const prior = ledger().replay(request, Date.now(), stillAllowed);
  if (prior) return { id: 'p-' + prior.id, status: 'pending' as const };
  const fence = captureBenchStorageFence();
  let frozen: FrozenBinding;
  try { frozen = await capture(bench, args as BindArgs); }
  catch (error) {
    if (error instanceof BenchError && error.http === 404) return changed('申请范围内的报告或数据来源已改变');
    throw error;
  }
  const row = ledger().create(request, Date.now(), () => stillAllowed() && captureBenchStorageFence().revision === fence.revision,
    () => frozen as unknown as Json);
  return { id: 'p-' + row.id, status: 'pending' as const };
}
export function proposalId(id: unknown): number {
  if (typeof id !== 'string' || !/^p-[1-9][0-9]{0,14}$/.test(id)) return governanceForbidden();
  return Number(id.slice(2));
}
export function resultReportGovernance(session: Session, input: unknown, channel: Channel) {
  const principal = activePrincipal(session);
  const args = exact(input, ['id']);
  if (typeof args.id === 'string' && /^i-[1-9][0-9]{0,14}$/.test(args.id)) {
    const id = Number(args.id.slice(2));
    return txInvite(() => {
      const row = main.prepare('SELECT * FROM report_governance_invites WHERE id = ?').get(id) as ReviewInvite | undefined;
      if (!row || row.session_id !== session!.id || row.principal_id !== principal || !inviteAllowed(session!.id, principal, row.area_id, row.dimension_id)) return governanceForbidden();
      const now = Date.now();
      const reason = updateInviteStatus(row, now);
      auditInvite(row, GOVERNANCE_RESULT, channel, now, reason);
      return inviteView(row, reason);
    });
  }
  return ledger().result(proposalId(args.id), session!.id, principal, channel, Date.now(), allowsProposalSource);
}
export function reviewInvitationsFor(principal: string) {
  return txInvite(() => {
    const rows = main.prepare('SELECT i.* FROM report_governance_invitees p JOIN report_governance_invites i ON i.id = p.invite_id WHERE p.principal_id = ? AND i.void_reason IS NULL ORDER BY i.id DESC LIMIT 200')
      .all(principal) as ReviewInvite[];
    const now = Date.now();
    return rows.filter(row => !updateInviteStatus(row, now) && !dimensions().template(row.dimension_id, row.version)?.review)
      .map(row => ({ id: 'i-' + row.id, dimension: row.dimension_id, version: row.version, created_at: row.created_at }));
  });
}
export function openReviewInvitation(principal: string, id: unknown) {
  if (typeof id !== 'string' || !/^i-[1-9][0-9]{0,14}$/.test(id)) return null;
  return txInvite(() => {
    const row = main.prepare('SELECT i.* FROM report_governance_invitees p JOIN report_governance_invites i ON i.id = p.invite_id WHERE p.principal_id = ? AND i.id = ?')
      .get(principal, Number(id.slice(2))) as ReviewInvite | undefined;
    if (!row || updateInviteStatus(row, Date.now())) return null;
    const template = dimensions().template(row.dimension_id, row.version);
    return template ? { dimension: row.dimension_id, template } : null;
  });
}

/** 提案列表只在人有权确认时带冻结内容。 */
export function governanceInbox(principal: string, after: number) {
  const page = ledger().pendingPage(after, p => mayConfirm(principal, p));
  return { proposals: page.proposals.map(p => ({ ...projectProposal(p), status: p.status,
    expires_at: p.expires_at, snapshot_sha256: p.snapshot_sha256, frozen: JSON.parse(p.frozen) })), next: page.next };
}
export function rejectReportGovernance(principal: string, id: number) {
  return projectProposal(ledger().cancel(id, principal, 'rejected', Date.now(), p => mayConfirm(principal, p)));
}
export async function confirmReportGovernance(principal: string, id: number, digest: string) {
  const db = ledger();
  const previous = db.get(id);
  if (!previous || !mayConfirm(principal, previous)) return governanceForbidden();
  if (previous.snapshot_sha256 !== digest) return changed('提案摘要不匹配，重新打开后确认');
  if (previous.op === 'dimension-activate') {
    const now = Date.now();
    return projectProposal(db.confirmLocal(id, principal, digest, now, p => mayConfirm(principal, p), allowsProposalSource, p => {
      const { scope, snapshot } = JSON.parse(p.frozen) as FrozenDimensionActivation;
      const current = dimensions().activationSnapshot(scope.dimension, snapshot.target.version, snapshot.review.version);
      if (!current || snapshotJson(current) !== snapshotJson(snapshot)) return { reason: 'target_changed' };
      const activated = dimensions().activate(scope.dimension, snapshot.target.version, { by: principal, principal }, now);
      return activated.ok ? { result: { version: snapshot.target.version } } : { reason: 'target_changed' };
    }));
  }
  if (previous.op === 'template-publish') {
    const now = Date.now();
    return projectProposal(db.confirmLocal(id, principal, digest, now, p => mayConfirm(principal, p), allowsProposalSource, p => {
      const { scope, args, snapshot } = JSON.parse(p.frozen) as FrozenTemplatePublish;
      if (areas().get(scope.area)?.status !== 'active' || dimensions().get(scope.dimension)?.area_id !== scope.area) return { reason: 'target_changed' };
      const published = dimensions().addTemplate(scope.dimension, { body: JSON.parse(args.body_json), note: args.note, sha256: snapshot.body_sha256 },
        { by: principal, principal }, now, { latestVersion: snapshot.latest_version, criteriaSha256: snapshot.criteria_sha256, kind: snapshot.kind, draftAuthor: p.principal_id });
      return published.ok ? { result: { version: published.template.version } } : { reason: 'target_changed' };
    }));
  }
  if (previous.op === 'dimension-create') {
    const now = Date.now();
    return projectProposal(db.confirmLocal(id, principal, digest, now, p => mayConfirm(principal, p), allowsProposalSource, p => {
      const { scope, args, snapshot } = JSON.parse(p.frozen) as FrozenDimensionCreate;
      if (areas().get(scope.area)?.status !== snapshot.area_status) return { reason: 'target_changed' };
      const created = dimensions().create({ area: scope.area, id: scope.dimension, title: args.title }, { by: principal, principal }, now);
      return created.ok ? { result: { dimension: created.dimension.id } } : { reason: 'target_changed' };
    }));
  }
  if (previous.status === 'confirmed') return projectProposal(previous);
  if (previous.status === 'confirming') {
    if (previous.confirmed_by !== principal) return governanceForbidden();
    return reconcile(previous);
  }
  const claimed = db.claimConfirmation(id, principal, digest, Date.now(), p => mayConfirm(principal, p), allowsProposalSource);
  if (claimed.status !== 'confirming') return projectProposal(claimed);
  const frozen = JSON.parse(claimed.frozen) as FrozenBinding;
  const operation = { id: claimed.operation_id!, snapshotSha256: claimed.snapshot_sha256 };
  const fence = captureBenchStorageFence();
  if (!allowsProposalSource(claimed) || !mayConfirm(principal, claimed)) {
    return projectProposal(db.settle(id, operation.id, Date.now(), { reason: 'authorization_changed' }));
  }
  let version: number;
  try {
    const bench = getBench(frozen.scope.bench);
    if (!bench) return changed('台已改变');
    const actual = await capture(bench, frozen.args);
    if (snapshotJson(actual) !== snapshotJson(frozen)) return changed('冻结的绑定目标或来源已改变');
    const store = await benchStore(bench.slug);
    const binding = await store.reportBindingPut(frozen.scope.dimension, { base: frozen.args.base, template_version: frozen.args.template_version,
      slots: frozen.args.slots, actor: principal, at: Date.now(), context: frozen.snapshot.context, operation }, fence);
    version = binding.version;
  } catch (error) {
    if ((error instanceof HttpError || error instanceof BenchError) && [400, 404, 409].includes(error instanceof HttpError ? error.status : error.http)) {
      return projectProposal(db.settle(id, operation.id, Date.now(), { reason: 'target_changed' }));
    }
    // 线程中断等不明结果不能推进冲突终态。
    return reconcile(claimed);
  }
  return projectProposal(db.settle(id, operation.id, Date.now(), { result: { version } }));
}
async function reconcile(p: Proposal) {
  const { bench, dimension } = scopeOf(p);
  if (benchStoreExists(bench)) {
    const store = await benchStore(bench);
    const receipt = await store.reportBindingReceipt(dimension, { id: p.operation_id!, snapshotSha256: p.snapshot_sha256 });
    if (receipt) return projectProposal(ledger().settle(p.id, p.operation_id!, Date.now(), { result: { version: receipt.version } }));
  }
  return projectProposal(p);
}
