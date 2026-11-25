/**
 * 报告的维度和模板（docs/report-step1.md 第二节第 1 小节、第三节、第四节；第 19 篇）。SQL 只在这里。
 *
 * 规则：
 *   · 维度属于一个领域（area_id），或者是跨领域的（area_id 为空）。标识和领域标识同一套写法，建好不改；名字 1～64 个字符，不带控制字符；
 *   · 模板正文是一个 JSON 对象，上限 200 KB（按 UTF-8 字节）；这里只核顶层的形状和论断、回应、验收声明这三块（第三节），
 *     数据槽和文档结构的逐项校验在生成报告时做（PR B 把 P0 的编排搬进服务端）；
 *   · 发一版 = 版本号取这个维度现有最大的加一；**不自动生效**。判据部分（论断要求、回应要求、验收声明、数据槽、参数）的摘要
 *     criteria_sha256 由这里算出来存下。kind 也由这里定：判据和这个维度某个**复核过的**版本一字不差（规范写法相同）是 layout，
 *     否则是 criteria；第一版没有复核过的版本可比，算 criteria。不和「上一版」比：上一版可能没复核过（#926 独立验收，绕过见 R5f）；
 *   · 复核人不能是作者本人：这个维度里判据和被复核那一版一样的任何一版的作者都算（复核按判据内容生效，本人也按判据内容认）；
 *   · 能不能生效按判据部分判，不按 kind 判：目标版本的判据摘要要等于这个维度某个复核过的版本的判据摘要（属主 2026-11-21：
 *     判据要作者以外的人复核过）。复核人不能是作者本人（同一个主体、同一个留痕写法都算本人）；只改版式和文字的版本不要另外复核；
 *   · 撤维度：改成 retired，只读；模板、复核、留痕都留着；
 *   · 每次建、撤、发版、复核、移指针一行留痕（report_dimension_events），和改动同一个写事务。
 * 时间由调用方给（毫秒），不在 SQL 里取。写事务用 BEGIN IMMEDIATE：两次并发发版不会拿到同一个版本号。
 */
import { createHash } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { svc } from '../context.ts';
import { areaVerdict } from '../judgment.ts';
import { REPORT_DIMENSION_SET } from '../roles.ts';
import { AREA_ID_RE, type AreaService } from './area.ts';
import type { PrincipalService } from './principal.ts';

export type DimensionStatus = 'active' | 'retired';
export type TemplateKind = 'layout' | 'criteria';
export type DimensionView = {
  id: string; area_id: string | null; title: string; status: DimensionStatus; active_version: number | null;
  created_at: number; created_by: string; updated_at: number; updated_by: string;
};
export type TemplateMeta = {
  version: number; sha256: string; criteria_sha256: string; bytes: number; kind: TemplateKind; note: string; created_at: number; created_by: string; created_by_principal: string | null;
  review: { reviewed_by: string; reviewed_at: number; note: string } | null; active: boolean;
};
export type TemplateFull = TemplateMeta & { body: unknown };
export type DimensionRefusal = { ok: false; http: 400 | 403 | 404 | 409; code: string; message: string };
/** 做这一步的人：by 是留痕写法（cli、admin-token、user:<名> …），principal 是对到的主体（对不到为 null） */
export type DimensionActor = { by: string; principal: string | null };
/** 判定的主体：路由认出人以后交进来。owner：属主（本机命令行在这里也算属主） */
export type DimensionSubject = { owner: boolean; principal: string | null };
export type DimensionDecision = { verdict: 'allow' | 'deny'; rule: string; grant: number | null };

export const DIMENSION_ID_RE = AREA_ID_RE;
export const TEMPLATE_MAX_BYTES = 204800;
export const NOTE_MAX = 200;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CLAIM_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const STANCES = ['agree', 'dispute', 'supplement'] as const;
/** 模板的顶层键（docs/report-step1.md 第三节）：P0 的四块加论断、回应、验收声明 */
const TEMPLATE_KEYS = ['schema_version', 'title', 'parameters', 'fields', 'slots', 'body', 'claims', 'responses', 'gate'];
/** 这几块有任何不同就是判据类（criteria） */
const CRITERIA_KEYS = ['claims', 'responses', 'gate', 'slots', 'parameters'];

const refuse = (http: DimensionRefusal['http'], code: string, message: string): DimensionRefusal => ({ ok: false, http, code, message });
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const plainText = (s: string, max: number) => s.length >= 1 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
/** 判据比较用的规范写法：对象的键排序，数组保持顺序 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * 核模板的形状（第三节）。回 null 是合格；否则回说法（第一处不合格的地方）。
 * 只核顶层、论断、回应、验收声明；数据槽和文档结构在生成时逐项核
 */
export function templateProblem(t: unknown): string | null {
  if (!isObj(t)) return '模板要是一个 JSON 对象';
  const extra = Object.keys(t).filter((k) => !TEMPLATE_KEYS.includes(k));
  if (extra.length) return `模板有不认识的键：${extra.map((k) => k.slice(0, 40)).join('、')}`;
  if (t.schema_version !== 2) return 'schema_version 要是 2';
  if (typeof t.title !== 'string' || !plainText(t.title, 200)) return 'title 要是 1～200 个字符，不带控制字符';
  for (const k of ['parameters', 'fields', 'slots']) if (!isObj(t[k])) return `${k} 要是对象`;
  if (!Array.isArray(t.body) || t.body.length < 1 || t.body.length > 300) return 'body 要是 1～300 个节点的数组';
  if (!Array.isArray(t.claims) || t.claims.length < 1 || t.claims.length > 12) return 'claims 要是 1～12 类论断的数组';
  const kinds = new Set<string>();
  for (const [i, c] of t.claims.entries()) {
    if (!isObj(c)) return `claims[${i}] 要是对象`;
    const ce = Object.keys(c).filter((k) => !['kind', 'label', 'min', 'max'].includes(k));
    if (ce.length) return `claims[${i}] 有不认识的键：${ce.map((k) => k.slice(0, 40)).join('、')}`;
    if (typeof c.kind !== 'string' || !CLAIM_KIND_RE.test(c.kind)) return `claims[${i}].kind 要是小写字母开头的字母、数字、连字符，最多 32 个字符`;
    if (kinds.has(c.kind)) return `claims 里的 kind 重复：${c.kind}`;
    kinds.add(c.kind);
    if (typeof c.label !== 'string' || !plainText(c.label, 64)) return `claims[${i}].label 要是 1～64 个字符`;
    if (!Number.isInteger(c.min) || !Number.isInteger(c.max) || (c.min as number) < 0 || (c.max as number) < 1 || (c.max as number) > 50 || (c.min as number) > (c.max as number)) return `claims[${i}] 的 min、max 要是整数，0 ≤ min ≤ max，1 ≤ max ≤ 50`;
  }
  const r = t.responses;
  if (!isObj(r)) return 'responses 要是对象';
  const re = Object.keys(r).filter((k) => !['stances', 'reason_required'].includes(k));
  if (re.length) return `responses 有不认识的键：${re.map((k) => k.slice(0, 40)).join('、')}`;
  if (!Array.isArray(r.stances) || r.stances.length < 1 || r.stances.some((s) => !(STANCES as readonly unknown[]).includes(s)) || new Set(r.stances).size !== r.stances.length) return 'responses.stances 要是 agree、dispute、supplement 里不重复的一到三个';
  // 属主：认可、反驳都要写理由。写成别的拒，不悄悄改成 true
  if (r.reason_required !== true) return 'responses.reason_required 只能是 true（回应必须写理由）';
  const g = t.gate;
  if (!isObj(g)) return 'gate 要是对象';
  const ge = Object.keys(g).filter((k) => k !== 'open_dispute_blocks_acceptance');
  if (ge.length) return `gate 有不认识的键：${ge.map((k) => k.slice(0, 40)).join('、')}`;
  if (typeof g.open_dispute_blocks_acceptance !== 'boolean') return 'gate.open_dispute_blocks_acceptance 要是 true 或 false';
  return null;
}

/** 判据部分（CRITERIA_KEYS 这几块）的摘要：规范写法（键排序）再取 sha256。两版判据一样，摘要就一样，和版式、文字、键的先后无关 */
export function criteriaDigest(t: Record<string, unknown>): string {
  return sha256(canonical(Object.fromEntries(CRITERIA_KEYS.map((k) => [k, t[k] ?? null]))));
}

type DimRow = Omit<DimensionView, 'active_version'> & { active_version: number | null };
const dimView = (r: DimRow): DimensionView => ({
  id: r.id, area_id: r.area_id ?? null, title: r.title, status: r.status, active_version: r.active_version === null ? null : Number(r.active_version),
  created_at: Number(r.created_at), created_by: r.created_by, updated_at: Number(r.updated_at), updated_by: r.updated_by,
});
const DIM_COLS = 'id, area_id, title, status, active_version, created_at, created_by, updated_at, updated_by';
const TPL_META = 't.version, t.sha256, t.criteria_sha256, length(CAST(t.body AS BLOB)) AS bytes, t.kind, t.note, t.created_at, t.created_by, t.created_by_principal, r.reviewed_by, r.reviewed_at, r.note AS review_note';
type TplRow = {
  version: number; sha256: string; criteria_sha256: string; bytes: number; kind: TemplateKind; note: string; created_at: number; created_by: string; created_by_principal: string | null;
  reviewed_by: string | null; reviewed_at: number | null; review_note: string | null; body?: string;
};
const tplMeta = (r: TplRow, active: number | null): TemplateMeta => ({
  version: Number(r.version), sha256: r.sha256, criteria_sha256: r.criteria_sha256, bytes: Number(r.bytes), kind: r.kind, note: r.note, created_at: Number(r.created_at), created_by: r.created_by,
  created_by_principal: r.created_by_principal ?? null,
  review: r.reviewed_by ? { reviewed_by: r.reviewed_by, reviewed_at: Number(r.reviewed_at), note: r.review_note ?? '' } : null,
  active: active !== null && Number(r.version) === active,
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

/** 认得出的人：主体不为空、是人、启用着。复核判据类模板版本只认这种人（本机命令行、只带管理口令的主体为空，认不出是谁） */
function identifiedPerson(principal: string | null): boolean {
  if (!principal) return false;
  const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string } | null;
  return !!p && p.kind === 'person' && p.status === 'active';
}

export function normalizeDimensionTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const normalized = title.trim();
  return plainText(normalized, 64) ? normalized : null;
}

export class ReportDimensionService extends Service {
  constructor(ctx: any) {
    super(ctx, 'reportDimensions');
  }

  /**
   * 定报告维度（建、发版、复核、移指针、撤）谁能做（docs/report-step1.md 第四节）。area 是维度所属的领域（建维度时是要建在哪个领域），跨领域为 null。
   *   · 属主（本机命令行在这里算属主）：都能做；
   *   · 跨领域的维度：只有属主；
   *   · 领域的维度：持本领域 area-report 授予（范围正好是 area:<领域>）的人——硬规则，别的角色覆盖了也不算（judgment.ts 的 areaVerdict）。
   * 读不在这里：登录的人都能读（模板是协议，不是业务数据；第六节评审定的推荐）
   */
  decideSet(subject: DimensionSubject, area: string | null): DimensionDecision {
    if (subject.owner) return { verdict: 'allow', rule: 'report-owner', grant: null };
    if (area === null) return { verdict: 'deny', rule: 'report-cross-area-owner-only', grant: null };
    if (!subject.principal) return { verdict: 'deny', rule: 'area-report-required', grant: null };
    return areaVerdict({ principal: subject.principal, action: REPORT_DIMENSION_SET, kind: 'decide', area });
  }

  list(): DimensionView[] {
    return (db.prepare(`SELECT ${DIM_COLS} FROM report_dimensions ORDER BY id`).all() as DimRow[]).map(dimView);
  }

  get(id: string): DimensionView | null {
    const r = db.prepare(`SELECT ${DIM_COLS} FROM report_dimensions WHERE id = ?`).get(id) as DimRow | undefined;
    return r ? dimView(r) : null;
  }

  /** 版本清单（不带正文），新的在前 */
  templates(id: string): TemplateMeta[] {
    const d = this.get(id);
    if (!d) return [];
    return (db.prepare(`SELECT ${TPL_META} FROM report_templates t LEFT JOIN report_template_reviews r ON r.dimension_id = t.dimension_id AND r.version = t.version WHERE t.dimension_id = ? ORDER BY t.version DESC`)
      .all(id) as TplRow[]).map((r) => tplMeta(r, d.active_version));
  }

  template(id: string, version: number): TemplateFull | null {
    const d = this.get(id);
    if (!d) return null;
    const r = db.prepare(`SELECT ${TPL_META}, t.body FROM report_templates t LEFT JOIN report_template_reviews r ON r.dimension_id = t.dimension_id AND r.version = t.version WHERE t.dimension_id = ? AND t.version = ?`)
      .get(id, version) as TplRow | undefined;
    return r ? { ...tplMeta(r, d.active_version), body: JSON.parse(String(r.body)) } : null;
  }

  private event(dimensionId: string, kind: 'create' | 'retire' | 'template-add' | 'template-review' | 'activate', version: number | null, actor: DimensionActor, now: number, detail = ''): void {
    db.prepare('INSERT INTO report_dimension_events (dimension_id, kind, version, actor, actor_principal, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(dimensionId, kind, version, actor.by.slice(0, 256), actor.principal, now, detail.slice(0, 500));
  }

  /** 建维度。area 为 null 是跨领域的维度；领域的要在、没撤 */
  create(input: { id: string; title: string; area: string | null }, actor: DimensionActor, now: number): { ok: true; dimension: DimensionView } | DimensionRefusal {
    if (!DIMENSION_ID_RE.test(input.id)) return refuse(400, 'report_dimension_id_invalid', '维度标识要是小写字母开头的字母、数字、连字符，最多 48 个字符');
    const title = normalizeDimensionTitle(input.title);
    if (title === null) return refuse(400, 'report_dimension_title_invalid', '维度名字要是 1～64 个字符，不带控制字符');
    if (input.area !== null) {
      const a = svc<AreaService>('areas').get(input.area);
      if (!a) return refuse(404, 'area_missing', `领域 ${input.area} 不存在`);
      if (a.status === 'retired') return refuse(409, 'area_retired', `领域 ${input.area} 已经撤了，只读`);
    }
    return tx(() => {
      if (db.prepare('SELECT 1 FROM report_dimensions WHERE id = ?').get(input.id)) return refuse(409, 'report_dimension_exists', `维度 ${input.id} 已经有了（撤了的也占着标识）`);
      const by = actor.by.slice(0, 256);
      db.prepare("INSERT INTO report_dimensions (id, area_id, title, status, active_version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 'active', NULL, ?, ?, ?, ?)")
        .run(input.id, input.area, title, now, by, now, by);
      this.event(input.id, 'create', null, actor, now, input.area ?? '');
      return { ok: true as const, dimension: this.get(input.id)! };
    });
  }

  /** 发一版模板（不自动生效）。sha256 是调用方带来核对的（可空），核的是这里存下的正文（JSON.stringify 的结果） */
  addTemplate(id: string, input: { body: unknown; note: string; sha256: string | null }, actor: DimensionActor, now: number): { ok: true; template: TemplateMeta } | DimensionRefusal {
    const problem = templateProblem(input.body);
    if (problem) return refuse(400, 'report_template_invalid', problem);
    const text = JSON.stringify(input.body);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > TEMPLATE_MAX_BYTES) return refuse(400, 'report_template_too_large', `模板最多 200 KB（现在 ${bytes} 字节）`);
    if (input.note.length > NOTE_MAX || /[\x00-\x1f\x7f]/.test(input.note)) return refuse(400, 'report_template_note_invalid', `说明最多 ${NOTE_MAX} 个字符，不带控制字符`);
    const digest = sha256(text);
    if (input.sha256 !== null && (!SHA256_RE.test(input.sha256) || input.sha256 !== digest)) return refuse(400, 'report_template_sha256_mismatch', 'sha256 和模板正文对不上');
    return tx(() => {
      const d = this.get(id);
      if (!d) return refuse(404, 'report_dimension_missing', `维度 ${id} 不存在`);
      if (d.status === 'retired') return refuse(409, 'report_dimension_retired', `维度 ${id} 已经撤了，只读`);
      const last = db.prepare('SELECT version FROM report_templates WHERE dimension_id = ? ORDER BY version DESC LIMIT 1').get(id) as { version: number } | undefined;
      const version = Number(last?.version ?? 0) + 1;
      const criteria = criteriaDigest(input.body as Record<string, unknown>);
      const kind: TemplateKind = this.criteriaReviewed(id, criteria) ? 'layout' : 'criteria';
      // 判据类版本要作者以外的人复核；作者认不出是谁（本机命令行、只带管理口令）就判不了「是不是本人」，所以认不出的人不能发判据类版本（统筹 11-21 裁定）
      if (kind === 'criteria' && !actor.principal) return refuse(403, 'report_template_author_unidentified', '这一版改了判据（第一版也算），要作者以外的人复核；本机命令行、管理口令认不出是谁，发判据类版本请用站内账号');
      db.prepare('INSERT INTO report_templates (dimension_id, version, body, sha256, criteria_sha256, kind, note, created_at, created_by, created_by_principal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, version, text, digest, criteria, kind, input.note, now, actor.by.slice(0, 256), actor.principal);
      db.prepare('UPDATE report_dimensions SET updated_at = ?, updated_by = ? WHERE id = ?').run(now, actor.by.slice(0, 256), id);
      this.event(id, 'template-add', version, actor, now, `${kind} ${input.note}`.trim());
      return { ok: true as const, template: this.templates(id).find((t) => t.version === version)! };
    });
  }

  /**
   * 复核一版：复核人必须是认得出的人（主体不为空、是人、启用着），并且不是作者——本机命令行、只带管理口令的不能复核（403）；
   * 作者主体相同、或者留痕写法相同，都算本人（403，规格第五节 5a）；一版只复核一次（409）
   */
  review(id: string, version: number, note: string, actor: DimensionActor, now: number): { ok: true; template: TemplateMeta } | DimensionRefusal {
    if (note.length > NOTE_MAX || /[\x00-\x1f\x7f]/.test(note)) return refuse(400, 'report_template_note_invalid', `说明最多 ${NOTE_MAX} 个字符，不带控制字符`);
    return tx(() => {
      const d = this.get(id);
      if (!d) return refuse(404, 'report_dimension_missing', `维度 ${id} 不存在`);
      if (d.status === 'retired') return refuse(409, 'report_dimension_retired', `维度 ${id} 已经撤了，只读`);
      const t = db.prepare('SELECT criteria_sha256 FROM report_templates WHERE dimension_id = ? AND version = ?').get(id, version) as { criteria_sha256: string } | undefined;
      if (!t) return refuse(404, 'report_template_missing', `维度 ${id} 没有第 ${version} 版模板`);
      if (!identifiedPerson(actor.principal)) return refuse(403, 'report_template_reviewer_unidentified', '复核要认得出是谁：请用站内账号复核（本机命令行、管理口令不能复核）');
      // 复核按判据内容生效（判据一样的版本都算复核过），所以本人也按判据内容认：这个维度里判据和这一版一样的任何一版，作者是复核人，就算本人
      // （#926 独立验收 E1：不然自己发的判据可以借别人只改标题的那一版，自己复核后生效）
      const self = db.prepare('SELECT version FROM report_templates WHERE dimension_id = ? AND criteria_sha256 = ? AND (created_by = ? OR (created_by_principal IS NOT NULL AND created_by_principal = ?)) ORDER BY CASE WHEN version = ? THEN 0 ELSE 1 END, version LIMIT 1')
        .get(id, t.criteria_sha256, actor.by.slice(0, 256), actor.principal, version);
      // 说清是哪一版让他算作者：判据一样的版本里有他发的，不一定是被复核的这一版（#926 验收建议）
      if (self) {
        const mine = Number((self as { version: number }).version);
        return refuse(403, 'report_template_self_review', mine === version
          ? '模板版本不能由作者本人复核，要作者以外的人'
          : `第 ${mine} 版是你发的，判据和第 ${version} 版一样，你也算作者：要作者以外的人复核`);
      }
      if (db.prepare('SELECT 1 FROM report_template_reviews WHERE dimension_id = ? AND version = ?').get(id, version)) return refuse(409, 'report_template_reviewed', `第 ${version} 版已经复核过了`);
      db.prepare('INSERT INTO report_template_reviews (dimension_id, version, reviewed_by, reviewed_by_principal, reviewed_at, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, version, actor.by.slice(0, 256), actor.principal, now, note);
      this.event(id, 'template-review', version, actor, now, note);
      return { ok: true as const, template: this.templates(id).find((x) => x.version === version)! };
    });
  }

  /** 这个维度有没有复核过的版本，判据摘要等于 criteria */
  private criteriaReviewed(id: string, criteria: string): boolean {
    return !!db.prepare('SELECT 1 FROM report_templates t JOIN report_template_reviews r ON r.dimension_id = t.dimension_id AND r.version = t.version WHERE t.dimension_id = ? AND t.criteria_sha256 = ?')
      .get(id, criteria);
  }

  /**
   * 把生效指针移到已有的一版（回退也是它，不新增版本）。按判据部分判：这一版的判据要和某个复核过的版本一样，不然 409。
   * 判据摘要按正文重算一遍再比存下的：库里被人直接写进一行摘要和正文对不上的，这里不认（409）
   */
  activate(id: string, version: number, actor: DimensionActor, now: number): { ok: true; dimension: DimensionView } | DimensionRefusal {
    return tx(() => {
      const d = this.get(id);
      if (!d) return refuse(404, 'report_dimension_missing', `维度 ${id} 不存在`);
      if (d.status === 'retired') return refuse(409, 'report_dimension_retired', `维度 ${id} 已经撤了，只读`);
      const t = this.template(id, version);
      if (!t) return refuse(400, 'report_template_missing', `维度 ${id} 没有第 ${version} 版模板`);
      if (criteriaDigest(t.body as Record<string, unknown>) !== t.criteria_sha256) return refuse(409, 'report_template_criteria_mismatch', `第 ${version} 版存下的判据摘要和正文对不上，不能生效`);
      if (!this.criteriaReviewed(id, t.criteria_sha256)) return refuse(409, 'report_template_unreviewed', `第 ${version} 版的判据没有被作者以外的人复核过，复核过才能生效`);
      db.prepare('UPDATE report_dimensions SET active_version = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(version, now, actor.by.slice(0, 256), id);
      this.event(id, 'activate', version, actor, now);
      return { ok: true as const, dimension: this.get(id)! };
    });
  }

  retire(id: string, reason: string, actor: DimensionActor, now: number): { ok: true; dimension: DimensionView } | DimensionRefusal {
    return tx(() => {
      const d = this.get(id);
      if (!d) return refuse(404, 'report_dimension_missing', `维度 ${id} 不存在`);
      if (d.status === 'retired') return refuse(409, 'report_dimension_retired', `维度 ${id} 已经撤了，只读`);
      db.prepare("UPDATE report_dimensions SET status = 'retired', updated_at = ?, updated_by = ? WHERE id = ?").run(now, actor.by.slice(0, 256), id);
      this.event(id, 'retire', null, actor, now, reason);
      return { ok: true as const, dimension: this.get(id)! };
    });
  }
}
