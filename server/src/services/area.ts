/**
 * 领域域（docs/domains-step1.md 第二节；规范 15 两层组织）：领域、领域规范的版本、留痕。SQL 只在这里。
 *
 * 规则：
 *   · 领域标识和部门标识同一套写法（小写字母开头，字母、数字、连字符，最多 48 个字符），建好不改；名字 1～64 个字符，不带控制字符；
 *   · 新建的领域是 pending-lead（还没有生效的领域负责人；第 1 步 PR2 起属主放行第一条 area-lead 后变 active）；
 *   · 规范正文 1 字节～64 KB（按 UTF-8 字节），摘要（sha256）由这里算；调用方带了摘要的要和正文对得上；
 *   · 新加一版 = 版本号取这个领域现有最大的加一，并把生效指针移到新版；回退 = 只移指针，不新增版本；
 *   · 撤领域：还有没结束的授予（草稿、待核、生效）范围是 area:<标识> 的，不能撤（409）；撤了的只读，不删；
 *   · 每次建、撤、新加版本、移指针一行留痕（area_events），和改动同一个写事务。
 * 时间由调用方给（毫秒），不在 SQL 里取。写事务用 BEGIN IMMEDIATE：两次并发新加规范不会拿到同一个版本号。
 */
import { createHash } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

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

export class AreaService extends Service {
  constructor(ctx: any) {
    super(ctx, 'areas');
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

  private event(areaId: string, kind: 'create' | 'retire' | 'spec-add' | 'spec-activate' | 'migrate', version: number | null, actor: AreaActor, now: number, detail = ''): void {
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

  retire(id: string, reason: string, actor: AreaActor, now: number): { ok: true; area: AreaView } | AreaRefusal {
    return tx(() => {
      const a = this.get(id);
      if (!a) return refuse(404, 'area_missing', `领域 ${id} 不存在`);
      if (a.status === 'retired') return refuse(409, 'area_retired', `领域 ${id} 已经撤了，只读`);
      const open = db.prepare("SELECT COUNT(*) AS n FROM grants WHERE scope = ? AND status IN ('draft', 'pending', 'active')").get(`area:${id}`) as { n: number };
      if (Number(open.n) > 0) return refuse(409, 'area_in_use', `还有 ${open.n} 条没结束的授予范围是这个领域，先撤销再撤领域`);
      db.prepare("UPDATE areas SET status = 'retired', updated_at = ?, updated_by = ? WHERE id = ?").run(now, actor.by.slice(0, 256), id);
      this.event(id, 'retire', null, actor, now, reason);
      return { ok: true as const, area: this.get(id)! };
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
