/**
 * 台上的报告（docs/report-step1.md 第二节第 2 小节、第三节；报告第 1 步 PR B、C）：生成、读、回应。路由（routes/bench-views.ts）和
 * MCP 工具（services/bench-mcp.ts 的 report_*）都走这一处，规矩只写一遍。谁能做由调用方先判（路由按动作、MCP 按会话 × 台 × 工具的授予），这里不再判。
 *
 *   · 维度属于某个领域时，只有绑在这个领域的台能用它；撤了的、没有生效模板的用不了；模板换了生效版本，旧绑定要重新绑；
 *   · 产出方、回应者由调用方的身份定，不收请求里的：席位（seat:）、MCP 会话（mcp:）记 ai，别的记 human；
 *     回应者的位置（position）按他回应时生效的授予记（角色@范围），MCP 会话记 mcp；
 *   · 「未处理的反驳」（第二节第 3 小节）：一条论断上取每个**人**的回应链的链头，有 dispute，并且这份报告还是链头（没被更正），
 *     这条论断就有未处理的反驳。AI 的回应不算。状态由此算出，不存。
 */
import { svc } from '../context.ts';
import { BenchError } from '../bench-query.ts';
import type { BenchEntry } from './bench-registry.ts';
import type { BenchStore } from './bench-store.ts';
import type { ReportResponseRow } from './bench-store-core.ts';
import type { ReportDimensionService } from './report-dimension.ts';
import type { GrantService } from './grant.ts';
import { ReportError, checkBinding, materialize, prepareInputs, sha256, slotSpecs, type TemplateV2 } from './report-compile.ts';

const dims = () => svc<ReportDimensionService>('reportDimensions');
export const SUBJECT_RE = /^[a-z][a-z0-9-]{0,15}:[^\s]{1,200}$/;
const DIM_RE = /^[a-z][a-z0-9-]{0,47}$/;
const CLAIM_KEY_RE = /^[a-z][a-z0-9-]{0,31}-[1-9][0-9]{0,2}$/;
type Row = Record<string, unknown>;

/** 调用方的身份算 AI 还是人：席位、MCP 会话是 AI */
export const kindOf = (actor: string): 'human' | 'ai' => (actor.startsWith('seat:') || actor.startsWith('mcp:') ? 'ai' : 'human');
/** 回应者回应时的位置：按他生效的授予记（角色@范围，排好序），MCP 会话记 mcp，内置身份记它自己 */
function positionOf(actor: string, now: number): string {
  if (actor.startsWith('mcp:')) return 'mcp';
  if (actor.startsWith('builtin:')) return actor;
  const gs = svc<GrantService>('grants').activeFor(actor, now).map((g) => `${g.role}@${g.scope}`).sort();
  return gs.join(',').slice(0, 500);
}

/** 这个台能用的维度和它生效的模板：维度不存在 404；撤了的、还没有生效模板的、属于别的领域的 409 */
export function usableDimension(bench: BenchEntry, dimension: unknown): { id: string; version: number; sha256: string; template: TemplateV2 } {
  if (typeof dimension !== 'string' || !DIM_RE.test(dimension)) throw new BenchError('invalid', 'dimension 要是报告维度的标识');
  const d = dims().get(dimension);
  if (!d) throw new BenchError('not_found', `没有报告维度 ${dimension}`);
  if (d.status === 'retired') throw new BenchError('conflict', `报告维度 ${dimension} 已经撤了`);
  if (d.area_id !== null && d.area_id !== bench.department_id) throw new BenchError('conflict', `报告维度 ${dimension} 属于别的领域，这个台用不了`);
  if (d.active_version === null) throw new BenchError('conflict', `报告维度 ${dimension} 还没有生效的模板`);
  const t = dims().template(dimension, d.active_version);
  if (!t) throw new BenchError('conflict', `报告维度 ${dimension} 的生效模板读不到`);
  return { id: dimension, version: d.active_version, sha256: t.sha256, template: t.body as TemplateV2 };
}
/** 编排的拒收转成 400（details 里是 report_<代号>，说是哪一处），别的照原样抛 */
export function compiled<T>(fn: () => T): T {
  try { return fn(); } catch (e) { if (e instanceof ReportError) throw new BenchError('invalid', `报告没过校验：${e.code}（${e.path}）`, [`report_${e.code}`]); throw e; }
}
const onlyKeys = (body: unknown, allowed: string[], what: string): Row => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BenchError('invalid', `要给一个对象：${what}`);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new BenchError('invalid', `有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  return body as Row;
};
const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined);

/** 绑定（照生效的视图描述核块在不在、是不是取数的块）。base 是看到的最新绑定版本，没绑过写 0 */
export async function bindReport(bench: BenchEntry, s: BenchStore, dimension: unknown, body: unknown, actor: string, now: number) {
  const b = onlyKeys(body, ['base', 'slots'], '{ base, slots }');
  const base = typeof b.base === 'number' && Number.isSafeInteger(b.base) && b.base >= 0 ? b.base : undefined;
  if (base === undefined) throw new BenchError('invalid', 'base 要写成整数：看到的最新绑定版本，没绑过写 0');
  const dim = usableDimension(bench, dimension);
  const slots = compiled(() => checkBinding(dim.template, b.slots));
  const view = await s.getView();
  const doc = view?.content as { views?: { key: string; blocks: { type: string; query?: unknown }[] }[] } | undefined;
  for (const [name, sb] of Object.entries(slots)) {
    const blk = doc?.views?.find((v) => v.key === sb.view)?.blocks[sb.block];
    if (!blk) throw new BenchError('invalid', `数据槽 ${name} 绑的视图 ${sb.view} 第 ${sb.block} 个块不存在`);
    if (blk.type === 'form' || blk.type === 'filter-bar' || blk.query === undefined) throw new BenchError('invalid', `数据槽 ${name} 绑的块不是取数的块（${blk.type}）`);
  }
  return { binding: await s.reportBindingPut(dim.id, { base, template_version: dim.version, slots, actor, at: now }) };
}

/** 生成并冻结一份报告。来源（视图版本、哈希、行数）、产出方由服务端填：请求里写了就拒 */
export async function generateReport(bench: BenchEntry, s: BenchStore, body: unknown, actor: string, now: number) {
  const b = onlyKeys(body, ['dimension', 'subject', 'inputs', 'claims', 'supersedes'], '{ dimension, subject, inputs, claims, supersedes? }');
  if (typeof b.subject !== 'string' || !SUBJECT_RE.test(b.subject)) throw new BenchError('invalid', 'subject 要写成「种类:标识」，比如 item:123');
  const supersedes = b.supersedes === undefined ? null : posInt(b.supersedes);
  if (supersedes === undefined) throw new BenchError('invalid', 'supersedes 要写成被更正的那份报告的编号');
  const dim = usableDimension(bench, b.dimension);
  const binding = await s.reportBindingGet(dim.id);
  if (!binding) throw new BenchError('conflict', '这个台还没有绑这个维度，先绑再生成');
  if (binding.template_version !== dim.version) throw new BenchError('conflict', `模板已经换到第 ${dim.version} 版，绑定还是照第 ${binding.template_version} 版绑的，先重新绑`);
  const slots = compiled(() => checkBinding(dim.template, binding.slots));
  const inputs = compiled(() => prepareInputs(dim.template, b.inputs));
  const data = await s.reportSlots(compiled(() => slotSpecs(dim.template, slots, inputs)));
  const frozen = compiled(() => materialize(dim.template, slots, data, inputs, b.claims));
  const text = JSON.stringify(frozen.body);
  const row = {
    dimension_id: dim.id, template_version: dim.version, template_sha256: dim.sha256, binding_version: binding.version, subject: b.subject,
    inputs: JSON.stringify(inputs), body: text, sources: JSON.stringify(frozen.sources), content_sha256: sha256(text),
    producer: actor, producer_kind: kindOf(actor), supersedes, created_at: now,
  };
  const id = await s.reportInsert(row, frozen.claims.map((c) => ({ claim_key: c.claim_key, kind: c.kind, text: c.text, basis: JSON.stringify(c.basis) })));
  return { report: { id, ...row, inputs, body: frozen.body, sources: frozen.sources }, claims: frozen.claims };
}

/** 清单（不带成品正文），可按维度、事物筛 */
export async function listReports(s: BenchStore, q: { dimension?: unknown; subject?: unknown; limit?: number }) {
  const dimension = typeof q.dimension === 'string' && q.dimension ? q.dimension : undefined;
  const subject = typeof q.subject === 'string' && q.subject ? q.subject : undefined;
  if (dimension !== undefined && !DIM_RE.test(dimension)) throw new BenchError('invalid', 'dimension 要是报告维度的标识');
  if (subject !== undefined && !SUBJECT_RE.test(subject)) throw new BenchError('invalid', 'subject 要写成「种类:标识」');
  return { reports: await s.reportList({ dimension, subject, limit: q.limit }) };
}

/** 一条论断（或整份报告，claim_key 为空）上人的回应链的链头里有没有反驳 */
function openDispute(responses: ReportResponseRow[], claimKey: string): boolean {
  const mine = responses.filter((r) => r.claim_key === claimKey && r.responder_kind === 'human');
  const replaced = new Set(mine.map((r) => r.supersedes).filter((x): x is number => x !== null));
  return mine.some((r) => !replaced.has(r.id) && r.stance === 'dispute');
}

/** 一份报告：成品、来源、论断（各带回应和有没有未处理的反驳）、对整份报告的回应、验收声明、被谁更正了。没有是 404 */
export async function readReport(s: BenchStore, idIn: unknown) {
  const id = posInt(idIn);
  const r = id === undefined ? null : await s.reportGet(id);
  if (!r) throw new BenchError('not_found', '没有这份报告');
  const responses = await s.responsesOf(r.report.id);
  const same = await s.reportList({ dimension: r.report.dimension_id, subject: r.report.subject, limit: 200 });
  const supersededBy = same.find((x) => x.id === r.report.id)?.superseded_by ?? null;
  const t = dims().template(r.report.dimension_id, r.report.template_version);
  const gate = (t?.body as { gate?: unknown } | undefined)?.gate ?? null;
  const head = supersededBy === null;
  const { inputs, body, sources, ...meta } = r.report;
  const claims = r.claims.map((c) => ({
    ...c, basis: JSON.parse(c.basis), responses: responses.filter((x) => x.claim_key === c.claim_key),
    open_dispute: head && openDispute(responses, c.claim_key),
  }));
  const whole = responses.filter((x) => x.claim_key === '');
  const openWhole = head && openDispute(responses, '');
  return {
    report: { ...meta, inputs: JSON.parse(inputs), body: JSON.parse(body), sources: JSON.parse(sources), superseded_by: supersededBy },
    claims, responses: whole, gate,
    open_disputes: claims.filter((c) => c.open_dispute).length + (openWhole ? 1 : 0),
  };
}

/**
 * 回应一条论断（claim_key 不写是对整份报告）：立场要是这份报告的模板允许的；理由必填（1～4000 字）；
 * 改主意就带 supersedes 接自己的链头。回应者、AI 还是人、位置都由服务端定
 */
export async function respondReport(s: BenchStore, idIn: unknown, body: unknown, actor: string, now: number) {
  const b = onlyKeys(body, ['claim_key', 'stance', 'reason', 'supersedes'], '{ claim_key?, stance, reason, supersedes? }');
  const id = posInt(idIn);
  const r = id === undefined ? null : await s.reportGet(id);
  if (!r) throw new BenchError('not_found', '没有这份报告');
  const claimKey = b.claim_key === undefined ? '' : b.claim_key;
  if (typeof claimKey !== 'string' || (claimKey !== '' && !CLAIM_KEY_RE.test(claimKey))) throw new BenchError('invalid', 'claim_key 要写成论断的编号（比如 conclusion-1）；对整份报告就不写');
  const t = dims().template(r.report.dimension_id, r.report.template_version);
  const stances = ((t?.body as { responses?: { stances?: unknown } } | undefined)?.responses?.stances ?? []) as unknown[];
  if (typeof b.stance !== 'string' || !stances.includes(b.stance)) throw new BenchError('invalid', `stance 要是这个维度允许的：${stances.map(String).join('、')}`);
  if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 4000) throw new BenchError('invalid', '理由必填：1～4000 个字');
  const supersedes = b.supersedes === undefined ? null : posInt(b.supersedes);
  if (supersedes === undefined) throw new BenchError('invalid', 'supersedes 要写成你上一条回应的编号');
  const row = {
    report_id: r.report.id, claim_key: claimKey, stance: b.stance as ReportResponseRow['stance'], reason: b.reason,
    responder: actor, responder_kind: kindOf(actor), position: positionOf(actor, now), supersedes, created_at: now,
  };
  return { response: { id: await s.responseInsert(row), ...row } };
}
