/**
 * 台上的报告（docs/report-step1.md 第二节第 2 小节、第三节；报告第 1 步 PR B、C）：生成、读、回应。路由（routes/bench-views.ts）和
 * MCP 工具（services/bench-mcp.ts 的 report_*）都走这一处，规矩只写一遍。谁能做由调用方先判（路由按动作、MCP 按会话 × 台 × 工具的授予），这里不再判。
 *
 *   · 维度属于某个领域时，只有绑在这个领域的台能用它；撤了的、没有生效模板的用不了；模板换了生效版本，旧绑定要重新绑；
 *   · 产出方、回应者由调用方的身份定，不收请求里的：只有主体表里 kind 为 person 的记 human，席位、MCP 会话、应用、节点、系统、
 *     内置身份、查不到的都记 ai（report-compile.ts 的 actorKindOf，#930 统筹验收）；
 *     回应者的位置（position）按他回应时生效的授予记（角色@范围），只记管得到这个台的（范围 *、或正好是台绑的部门、领域；属主 11-21 定收窄），MCP 会话记 mcp；
 *   · 「未处理的反驳」（第二节第 3 小节）：一条论断上取每个**人**的回应链的链头，有 dispute，并且这份报告还是链头（没被更正），
 *     这条论断就有未处理的反驳。AI 的回应不算。状态由此算出，不存。
 */
import { svc } from '../context.ts';
import { BenchError } from '../bench-query.ts';
import { getBench, type BenchEntry } from './bench-registry.ts';
import type { BenchStore } from './bench-store.ts';
import type { MainStoreFence, ReportResponseRow } from './bench-store-core.ts';
import type { ReportDimensionService } from './report-dimension.ts';
import type { GrantService } from './grant.ts';
import { createHash } from 'node:crypto';
import { ReportError, actorKindOf, checkBinding, imageNodesOf, materialize, prepareInputs, sha256, slotSpecs, type FrozenBody, type ReportTemplate } from './report-compile.ts';
import { fetchImage, ImageError } from '../bench-image.ts';
import type { PrincipalService } from './principal.ts';
import { scopeView } from '../grant-scope-view.ts';

const dims = () => svc<ReportDimensionService>('reportDimensions');
export const SUBJECT_RE = /^[a-z][a-z0-9-]{0,15}:[^\s]{1,200}$/;
const DIM_RE = /^[a-z][a-z0-9-]{0,47}$/;
const CLAIM_KEY_RE = /^[a-z][a-z0-9-]{0,31}-[1-9][0-9]{0,2}$/;
type Row = Record<string, unknown>;

/** 调用方的身份算 AI 还是人：只有主体表里 kind 为 person 的是人；席位、MCP 会话、应用、节点、系统、内置、查不到的都是 AI（report-compile.ts 的 actorKindOf，#930 统筹验收） */
export const kindOf = (actor: string): 'human' | 'ai' => actorKindOf((svc<PrincipalService>('principals').get(actor) as { kind?: string } | null)?.kind);
/**
 * 回应者回应时的位置：只记管得到这个台的那几条生效授予（角色@范围，排好序）——范围是全公司（*），或者正好是这个台绑的部门、领域。
 * 别的地方的授予和这次表态无关，读报告的人（含 AI 会话）不该借此看到回应者在别处的全部授予（属主 2026-11-21 定：收窄）。
 * MCP 会话记 mcp，内置身份记它自己；一条都不沾的记空串
 */
export function positionOf(actor: string, now: number, bench: BenchEntry | null): string {
  if (actor.startsWith('mcp:')) return 'mcp';
  if (actor.startsWith('builtin:')) return actor;
  const dep = bench?.department_id ?? '';
  const covers = (scope: string) => scope === '*' || (dep !== '' && (scope === `dept:${dep}` || scope === `area:${dep}`));
  const gs = svc<GrantService>('grants').activeFor(actor, now).filter((g) => covers(g.scope)).map((g) => `${g.role}@${g.scope}`).sort();
  return gs.join(',').slice(0, 500);
}

/**
 * 报告页给人看的名字（#937 统筹：页面不露维度键、主体串、授予串、论断键、数据路径）。取不到的给 null，页面写「未命名」，不退回去显示内部串。
 *   · 维度：维度的标题；
 *   · 主体（产出方、回应者）：主体表里的显示名；
 *   · 位置：每条「角色@范围」写成「角色名（范围名）」，范围 * 是全公司，领域、部门给名字（grant-scope-view 同一口径）；mcp 是 MCP 会话，内置身份是内置身份；
 *     角色、范围的名字取不到的那一半写 null，页面照样写「未命名」。
 * 读报告的人本来就能看到这些标识（报告和回应里都有），名字不多露什么；位置已经收窄到管得到这个台的授予。
 */
export type PositionPart = { role: string | null; scope: string | null };
export function dimensionName(id: string): string | null { return dims().get(id)?.title ?? null; }
export function actorName(id: string): string | null { return ((svc<PrincipalService>('principals').get(id) as { display_name?: string } | null)?.display_name ?? '').trim() || null; }
export function positionParts(pos: string): PositionPart[] | 'mcp' | 'builtin' {
  if (pos === 'mcp') return 'mcp';
  if (pos.startsWith('builtin:')) return 'builtin';
  if (!pos) return [];
  const roles = new Map(svc<GrantService>('grants').roles().map((r) => [r.id, r.name]));
  return pos.split(',').map((g) => {
    const at = g.lastIndexOf('@');
    const role = at > 0 ? g.slice(0, at) : g, scope = at > 0 ? g.slice(at + 1) : '';
    return { role: roles.get(role) || null, scope: scope === '*' ? '全公司' : (scopeView(scope).scope_name || null) };
  });
}

/** 这个台能用的维度和它生效的模板：维度不存在 404；撤了的、还没有生效模板的、属于别的领域的 409 */
export function usableDimension(bench: BenchEntry, dimension: unknown): { id: string; version: number; sha256: string; template: ReportTemplate } {
  if (typeof dimension !== 'string' || !DIM_RE.test(dimension)) throw new BenchError('invalid', 'dimension 要是报告维度的标识');
  const d = dims().get(dimension);
  if (!d) throw new BenchError('not_found', `没有报告维度 ${dimension}`);
  if (d.status === 'retired') throw new BenchError('conflict', `报告维度 ${dimension} 已经撤了`);
  if (d.area_id !== null && d.area_id !== bench.department_id) throw new BenchError('conflict', `报告维度 ${dimension} 属于别的领域，这个台用不了`);
  if (d.active_version === null) throw new BenchError('conflict', `报告维度 ${dimension} 还没有生效的模板`);
  const t = dims().template(dimension, d.active_version);
  if (!t) throw new BenchError('conflict', `报告维度 ${dimension} 的生效模板读不到`);
  return { id: dimension, version: d.active_version, sha256: t.sha256, template: t.body as ReportTemplate };
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
export async function bindReport(bench: BenchEntry, s: BenchStore, dimension: unknown, body: unknown, actor: string, now: number, fence: MainStoreFence) {
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
  const context = await s.reportBindingContext(slots);
  if (context.view !== (view?.version ?? 0)) throw new BenchError('conflict', '校验绑定期间视图已改变');
  return { binding: await s.reportBindingPut(dim.id, { base, template_version: dim.version, slots, actor, at: now, context }, fence) };
}

/** 图片的配置：图库前缀（WM_IMAGE_GALLERY_BASE，没配是 null），冻结时按它把相对路径还原成地址 */
export type ReportImageConfig = { galleryBase: string | null };

/**
 * 冻结图片（docs/image-step1.md 用例 8，属主 D5「冻结时只记链接加哈希」）：每个图片节点按链接取一次图（经代取同一处 fetchImage：
 * 只认公网与图库前缀、限大小限时、对外断开时不取），把图的 sha256 写进节点。正文里只有链接和哈希，不存图。
 * 取不到就不出报告（没有哈希可冻）：对外断开、忙 503，超时 504，其余 400；details 里是 report_image_unavailable 和代取的错误代号
 */
export async function freezeImages(body: FrozenBody, images: ReportImageConfig): Promise<void> {
  const hashes = new Map<string, string>();
  for (const n of imageNodesOf(body.body)) {
    let h = hashes.get(n.src);
    if (h === undefined) {
      try {
        h = createHash('sha256').update((await fetchImage(n.src, images.galleryBase)).body).digest('hex');
      } catch (e) {
        if (!(e instanceof ImageError)) throw e;
        throw new BenchError(e.http === 503 ? 'busy' : e.http === 504 ? 'timeout' : 'invalid', `报告里的图片取不到，冻结不了：${e.message}`, ['report_image_unavailable', e.code]);
      }
      hashes.set(n.src, h);
    }
    n.sha256 = h;
  }
}

/** 生成并冻结一份报告。来源（视图版本、哈希、行数）、产出方由服务端填：请求里写了就拒 */
export async function generateReport(bench: BenchEntry, s: BenchStore, body: unknown, actor: string, now: number, fence: MainStoreFence, images: ReportImageConfig) {
  const b = onlyKeys(body, ['dimension', 'subject', 'inputs', 'claims', 'supersedes'], '{ dimension, subject, inputs, claims, supersedes? }');
  if (typeof b.subject !== 'string' || !SUBJECT_RE.test(b.subject)) throw new BenchError('invalid', 'subject 要写成「种类:标识」，比如 item:123');
  const supersedes = b.supersedes === undefined ? null : posInt(b.supersedes);
  if (supersedes === undefined) throw new BenchError('invalid', 'supersedes 要写成被更正的那份报告的编号');
  const dim = usableDimension(bench, b.dimension);
  const binding = await s.reportBindingGet(dim.id);
  if (!binding) throw new BenchError('conflict', '这个台还没有绑这个维度，先绑再生成');
  if (binding.disabled) throw new BenchError('conflict', '这个维度的报告生成已停用，先重新绑定');
  if (binding.template_version !== dim.version) throw new BenchError('conflict', `模板已经换到第 ${dim.version} 版，绑定还是照第 ${binding.template_version} 版绑的，先重新绑`);
  const slots = compiled(() => checkBinding(dim.template, binding.slots));
  const inputs = compiled(() => prepareInputs(dim.template, b.inputs));
  const { data, context } = await s.reportSlots(compiled(() => slotSpecs(dim.template, slots, inputs)));
  const frozen = compiled(() => materialize(dim.template, slots, data, inputs, b.claims));
  await freezeImages(frozen.body, images);
  const text = JSON.stringify(frozen.body);
  const row = {
    dimension_id: dim.id, template_version: dim.version, template_sha256: dim.sha256, binding_version: binding.version, subject: b.subject,
    inputs: JSON.stringify(inputs), body: text, sources: JSON.stringify(frozen.sources), content_sha256: sha256(text),
    producer: actor, producer_kind: kindOf(actor), supersedes, created_at: now,
  };
  const id = await s.reportInsert(row, frozen.claims.map((c) => ({ claim_key: c.claim_key, kind: c.kind, text: c.text, basis: JSON.stringify(c.basis) })),
    { ...context, main: fence });
  return { report: { id, ...row, inputs, body: frozen.body, sources: frozen.sources }, claims: frozen.claims };
}

/** 清单（不带成品正文），可按维度、事物筛 */
export async function listReports(s: BenchStore, q: { dimension?: unknown; subject?: unknown; limit?: number }) {
  const dimension = typeof q.dimension === 'string' && q.dimension ? q.dimension : undefined;
  const subject = typeof q.subject === 'string' && q.subject ? q.subject : undefined;
  if (dimension !== undefined && !DIM_RE.test(dimension)) throw new BenchError('invalid', 'dimension 要是报告维度的标识');
  if (subject !== undefined && !SUBJECT_RE.test(subject)) throw new BenchError('invalid', 'subject 要写成「种类:标识」');
  const reports = await s.reportList({ dimension, subject, limit: q.limit });
  // 给人看的名字（#937）：维度标题、产出方的显示名；取不到是 null
  const names = { dimensions: Object.fromEntries([...new Set(reports.map((r) => r.dimension_id))].map((d) => [d, dimensionName(d)])),
    actors: Object.fromEntries([...new Set(reports.map((r) => r.producer))].map((a) => [a, actorName(a)])) };
  return { reports, names };
}

/** 一条论断（或整份报告，claim_key 为空）上人的回应链的链头里有没有反驳 */
function openDispute(responses: ReportResponseRow[], claimKey: string): boolean {
  const mine = responses.filter((r) => r.claim_key === claimKey && r.responder_kind === 'human');
  const replaced = new Set(mine.map((r) => r.supersedes).filter((x): x is number => x !== null));
  return mine.some((r) => !replaced.has(r.id) && r.stance === 'dispute');
}

/**
 * 一份报告：成品、来源、论断（各带回应和有没有未处理的反驳）、对整份报告的回应、验收声明、被谁更正了。没有是 404。
 * 另带这一版模板里回应可选的立场、论断各类的名字（报告页据此出回应框、给论断标类别，PR D）；
 * 给了 actor（读的人）时，每条回应标出是不是他自己的（mine），页面据此把「改主意」接在他自己的链头上
 */
export async function readReport(s: BenchStore, idIn: unknown, actor?: string) {
  const id = posInt(idIn);
  const r = id === undefined ? null : await s.reportGet(id);
  if (!r) throw new BenchError('not_found', '没有这份报告');
  const responses = await s.responsesOf(r.report.id);
  const same = await s.reportList({ dimension: r.report.dimension_id, subject: r.report.subject, limit: 200 });
  const supersededBy = same.find((x) => x.id === r.report.id)?.superseded_by ?? null;
  const t = dims().template(r.report.dimension_id, r.report.template_version);
  const tb = (t?.body ?? {}) as { gate?: unknown; responses?: { stances?: unknown }; claims?: unknown };
  const gate = tb.gate ?? null;
  const stances = Array.isArray(tb.responses?.stances) ? tb.responses.stances.filter((x): x is string => typeof x === 'string') : [];
  const kinds = Array.isArray(tb.claims) ? (tb.claims as { kind?: unknown; label?: unknown }[]).filter((c) => typeof c?.kind === 'string').map((c) => ({ kind: String(c.kind), label: typeof c.label === 'string' ? c.label : String(c.kind) })) : [];
  const mark = (x: ReportResponseRow) => (actor === undefined ? x : { ...x, mine: x.responder === actor });
  const head = supersededBy === null;
  const { inputs, body, sources, ...meta } = r.report;
  const claims = r.claims.map((c) => ({
    ...c, basis: JSON.parse(c.basis), responses: responses.filter((x) => x.claim_key === c.claim_key).map(mark),
    open_dispute: head && openDispute(responses, c.claim_key),
  }));
  const whole = responses.filter((x) => x.claim_key === '').map(mark);
  const openWhole = head && openDispute(responses, '');
  const srcs = JSON.parse(sources) as { slot: string; view: string; block: number; view_version: number }[];
  // 给人看的名字（#937）：维度、产出方和回应者、回应者的位置、每个来源的视图和块的标题（按冻结时的视图版本取）；取不到是 null
  const viewDocs = new Map<number, { views?: { key?: string; title?: string; blocks?: { title?: string }[] }[] } | null>();
  for (const v of new Set(srcs.map((x) => x.view_version))) viewDocs.set(v, ((await s.getView(v).catch(() => null))?.content ?? null) as never);
  const allResponses = [...claims.flatMap((c) => c.responses), ...whole];
  const names = {
    dimension: dimensionName(meta.dimension_id),
    actors: Object.fromEntries([...new Set([meta.producer, ...allResponses.map((x) => x.responder)])].map((a) => [a, actorName(a)])),
    positions: Object.fromEntries([...new Set(allResponses.map((x) => x.position))].map((p) => [p, positionParts(p)])),
    sources: srcs.map((x) => {
      const v = viewDocs.get(x.view_version)?.views?.find((w) => w?.key === x.view);
      const t = (u: unknown) => (typeof u === 'string' && u.trim() ? u : null);
      return { slot: x.slot, view: t(v?.title), block: t(v?.blocks?.[x.block]?.title) };
    }),
  };
  return {
    names,
    report: { ...meta, inputs: JSON.parse(inputs), body: JSON.parse(body), sources: srcs, superseded_by: supersededBy },
    claims, responses: whole, gate, template: { stances, claims: kinds },
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
    responder: actor, responder_kind: kindOf(actor), position: positionOf(actor, now, getBench(s.slug)), supersedes, created_at: now,
  };
  return { response: { id: await s.responseInsert(row), ...row } };
}
