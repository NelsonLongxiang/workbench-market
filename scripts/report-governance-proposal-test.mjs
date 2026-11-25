import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'tmp'), { recursive: true });
const data = mkdtempSync(join(root, 'tmp', 'report-governance-'));
process.env.DATA_DIR = data;
process.env.NODE_ENV = 'test';
const { db } = await import('../server/src/db.ts');
const { ctx, svc } = await import('../server/src/context.ts');
const { PROPOSAL_TTL, GOVERNANCE_AUDIT_TTL, projectProposal } = await import('../server/src/services/report-governance-proposal.ts');
const service = svc('reportGovernanceProposals');
const good = () => true;
const deny = () => false;
const at = 1900000000000;
const author = 'user:fixture-proposer';
const confirmer = 'user:fixture-confirmer';
const timedOut = 'report_governance_state';
const error = code => e => e.extra?.code === code;
const forbidden = error('report_governance_forbidden');

try {
  const putPerson = db.prepare("INSERT INTO principals (id, id_key, kind) VALUES (?, ?, 'person')");
  putPerson.run(author, author); putPerson.run(confirmer, confirmer);
  const session = Number(db.prepare("INSERT INTO mcp_sessions (name, token_sha256, responsible_principal) VALUES ('fixture-governance', ?, ?) RETURNING id")
    .get('a'.repeat(64), author).id);
  const input = { sessionId: session, principal: author, scope: { op: 'bench-bind', bench: 'fixture-bench', dimension: 'fixture-dimension' },
    idempotencyKey: 'operation-1', args: { version: 2, base: 1 }, channel: 'rest' };
  let captures = 0;
  const capture = () => { captures++; return { before: { version: 1 }, after: { version: 2 } }; };
  const propose = (extra = {}, now = at, authorized = good) => service.create({ ...input, ...extra }, now, authorized, capture);
  assert.throws(() => propose({}, at, deny), forbidden);
  assert.equal(captures, 0);
  const p = propose();
  assert.equal(p.expires_at, at + PROPOSAL_TTL);
  assert.equal(p.status, 'pending');
  assert.equal(propose({ args: { base: 1, version: 2 }, channel: 'mcp-invoke' }).id, p.id);
  assert.equal(captures, 1);
  assert.throws(() => propose({ args: { base: 2, version: 2 } }), error('report_governance_idempotency_mismatch'));
  assert.throws(() => propose({ principal: confirmer }), forbidden);
  const other = propose({ scope: { ...input.scope, dimension: 'other-dimension' } });
  assert.notEqual(other.id, p.id);
  console.log('PASS 幂等键钉在会话、动作和精确对象；拒绝不捕获对象');

  assert.throws(() => service.result(p.id, session, confirmer, 'rest', at, good), forbidden);
  assert.throws(() => service.result(p.id, session, author, 'rest', at, deny), forbidden);
  assert.throws(() => service.result(p.id + 999, session, author, 'rest', at, good), forbidden);
  assert.deepEqual(service.result(p.id, session, author, 'mcp-invoke', at, good), { id: 'p-' + p.id, kind: 'proposal', op: 'bench-bind', status: 'pending' });
  const resultAudit = db.prepare("SELECT op, channel FROM report_governance_audit WHERE action = 'report.governance-result'").get();
  assert.deepEqual({ ...resultAudit }, { op: null, channel: 'mcp-invoke' });
  assert.throws(() => service.claimConfirmation(p.id, 'builtin:local-cli', p.snapshot_sha256, at, good, good), forbidden);
  assert.throws(() => service.claimConfirmation(p.id, confirmer, 'wrong', at, good, good), error('report_governance_snapshot_changed'));
  const claimed = service.claimConfirmation(p.id, confirmer, p.snapshot_sha256, at + 1, good, good);
  assert.equal(claimed.status, 'confirming');
  assert.ok(claimed.operation_id);
  assert.equal(claimed.confirmed_by, confirmer);
  assert.equal(projectProposal(claimed).status, 'pending');
  assert.throws(() => service.claimConfirmation(p.id, confirmer, p.snapshot_sha256, at + 2, good, good), error(timedOut));
  assert.throws(() => service.cancel(p.id, author, 'withdrawn', at + 2, good), error(timedOut));
  assert.throws(() => service.cancel(p.id, author, 'withdrawn', at + 2, deny), forbidden);
  service.maintain(at + PROPOSAL_TTL);
  assert.equal(service.get(p.id).status, 'confirming');
  assert.equal(service.get(other.id).status, 'expired');
  assert.throws(() => service.settle(p.id, 'wrong-operation', at + PROPOSAL_TTL, { result: { version: 2 } }), forbidden);
  const ok = service.settle(p.id, claimed.operation_id, at + PROPOSAL_TTL, { result: { version: 2 } });
  assert.equal(service.settle(p.id, claimed.operation_id, at + PROPOSAL_TTL + 1, { result: { version: 2 } }).decided_at, ok.decided_at);
  assert.deepEqual(projectProposal(ok).result, { version: 2 });
  console.log('PASS 真人摘要确认、唯一操作号、未知结果保持 confirming，结果查询不泄露冻结值');

  const next = propose({ idempotencyKey: 'operation-2' }, at + PROPOSAL_TTL);
  db.prepare("UPDATE principals SET status = 'disabled' WHERE id = ?").run(author);
  assert.equal(service.claimConfirmation(next.id, confirmer, next.snapshot_sha256, at + PROPOSAL_TTL, good, good).status, 'conflict');
  assert.throws(() => service.result(next.id, session, author, 'rest', at, good), forbidden);
  db.prepare("UPDATE principals SET status = 'active' WHERE id = ?").run(author);
  assert.throws(() => db.prepare("UPDATE report_governance_proposals SET frozen = '{}' WHERE id = ?").run(p.id));
  assert.equal(service.get(p.id).frozen, p.frozen);
  assert.throws(() => db.prepare("UPDATE report_governance_audit SET status = 'changed'").run());
  service.maintain(at + GOVERNANCE_AUDIT_TTL + 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_governance_audit WHERE at = ?').get(at).n, 0);
  assert.equal(service.get(p.id).status, 'confirmed');
  console.log('PASS 责任人停用即时阻断，审计到期和业务回执独立');
} finally {
  await ctx.fiber.dispose();
  db.close();
  rmSync(data, { recursive: true, force: true });
}
