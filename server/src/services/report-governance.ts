/** 首个报告治理操作：提案只冻结作用域和目标，业务写入只经真人的确认。 */
import { svc } from '../context.ts';
import { HttpError } from '../errors.ts';
import { BenchError } from '../bench-query.ts';
import { canBenchAction } from './bench-access.ts';
import { captureBenchStorageFence, getBench, type BenchEntry } from './bench-registry.ts';
import { benchStore, benchStoreExists } from './bench-store.ts';
import { compiled, usableDimension } from './bench-report.ts';
import { checkBinding, type Binding } from './report-compile.ts';
import { REPORT_BIND_ACCESS, type AreaAccessService } from './area-access.ts';
import type { McpService } from './mcp.ts';
import type { PrincipalService } from './principal.ts';
import { canonicalGovernanceJson, projectProposal, type Json, type Proposal, type ProposalInput, type ReportGovernanceProposalService } from './report-governance-proposal.ts';

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

type Session = { id: number } | null;
type Channel = 'rest' | 'mcp-invoke';
type BindArgs = { bench: string; dimension: string; template_version: number; template_sha256: string;
  base: number; view_version: number; view_sha256: string; slots: unknown };
type FrozenBinding = Awaited<ReturnType<typeof capture>>;

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
export function governanceCatalog(session: Session, details: boolean) {
  const principal = session ? mcp().areaAccessPrincipal(session.id) : null;
  const scopes = session && principal ? approvals().reportBindApprovals(session.id, principal)
    .filter(scope => sourceAllowed(session.id, principal, scope.bench, scope.dimension, scope.area)) : [];
  const propose = { name: GOVERNANCE_PROPOSE, description: '提出报告治理请求，由站内有权的人确认', area: '按目标台和维度', kind: 'decide', granted: scopes.length > 0 };
  const result = { name: GOVERNANCE_RESULT, description: '查询本会话提出的报告治理请求', area: '按原目标台和维度', kind: 'read', granted: scopes.length > 0 };
  if (!details) return [propose, result];
  return [{ ...propose, skill: 'wm-report-governance', scopes,
    activation: { action: REPORT_BIND_ACCESS, report_scope: ['bench', 'dimension'] },
    ops: { 'bench-bind': { args: { bench: 'string', dimension: 'string', template_version: 'integer', template_sha256: 'sha256',
      base: 'integer', view_version: 'integer', view_sha256: 'sha256', slots: 'object' } } },
    openapi: { method: 'POST', path: '/api/report-governance/proposals', required: ['op', 'args', 'idempotency_key'] },
    errors: { report_governance_forbidden: '需要有可信责任人的会话，并已获该台和维度范围的批准及本人授予',
      report_governance_target_changed: '重新读取绑定、模板和视图后重提' } },
  { ...result, skill: 'wm-report-governance', scopes, openapi: { method: 'GET', path: '/api/report-governance/proposals/{id}', required: ['id'] } }];
}
function scopeOf(p: Proposal): FrozenBinding['scope'] {
  return (JSON.parse(p.frozen) as FrozenBinding).scope;
}
function allowsProposalSource(p: Proposal): boolean {
  const { bench, dimension, area } = scopeOf(p);
  return sourceAllowed(p.session_id, p.principal_id, bench, dimension, area);
}
function mayConfirm(principal: string, p: Proposal): boolean {
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

export async function proposeReportGovernance(session: Session, input: unknown, channel: Channel) {
  const principal = activePrincipal(session);
  const body = exact(input, ['op', 'args', 'idempotency_key']);
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
  return ledger().result(proposalId(args.id), session!.id, principal, channel, Date.now(), allowsProposalSource);
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
