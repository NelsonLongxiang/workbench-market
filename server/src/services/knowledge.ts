/**
 * 经验库（/knowledge）的来源：ygl-trees 的 library 只读出口（契约 ygl-library/1，同机 CLI，YGL_HOME 由部署给）。
 *
 * 四类：claim 依据、note 经验、skill 方法、check 检查。
 *   · 目录（标题、摘要、状态、范围、时间）按类增量同步进 knowledge_items（--since 拉到的最大 updated），每天全量对账一次
 *     （library 的增量里不出现删除，全量时没再见到的去掉）。正文不存，详情按需 `library show`。
 *   · 同步是后台任务：等启动自检通过才开始，随插件卸载停下；一轮失败只记原因（给管理员看），下一轮再试，不判死。
 *   · 谁能看哪条不在这里存、不在同步时判：路由按看的人的授予逐条判（visibleTo），见文件末尾。
 *
 * 不露内部标识：页面拿到的是 key（对 kind:id 做带本库密钥的 HMAC 截断），不是 ygl-trees 的 id；不给工作区路径、内部计数。
 */
import { Service } from '@deepseek-ai/cordis';
import { createHmac, randomBytes } from 'node:crypto';
import { db } from '../db.ts';
import { svc } from '../context.ts';
import { defineConfig, loadConfig, str } from '../config.ts';
import { execYgl } from '../ygl-cli.ts';
import { afterStartup } from '../startup-gate.ts';
import { judge, scopedVerdict, type JudgedActor } from '../judgment.ts';
import type { DepartmentService } from './department.ts';

export const Config = defineConfig((env) => {
  // 同步间隔（分钟）：缺省 10；0 = 不同步（经验库只显示已经同步过的）；别的值拒绝启动
  const raw = str(env.WM_KNOWLEDGE_SYNC_MINUTES);
  const minutes = raw === '' ? 10 : Number(raw);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error('WM_KNOWLEDGE_SYNC_MINUTES 要是 0～1440 的整数（分钟，0 = 不同步）');
  return { syncMinutes: minutes };
});

export const KINDS = ['claim', 'note', 'skill', 'check'] as const;
export type YglKind = (typeof KINDS)[number];
/** 页面上的四类（web/src/knowledge-view.ts 的 key）：claim 依据、kb 经验、skill 方法、verify 检查 */
export const PAGE_KIND: Record<YglKind, 'claim' | 'kb' | 'skill' | 'verify'> = { claim: 'claim', note: 'kb', skill: 'skill', check: 'verify' };
export const CONTRACT = 'ygl-library/1';

const CALL_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 200;
const FULL_EVERY_MS = 24 * 3600_000;

type Row = { kind: YglKind; ygl_id: string; key: string; title: string; summary: string; status: string; project: string; scope: string; tags: string; created: string; updated: string };
export type KnowledgeView = { key: string; kind: 'claim' | 'kb' | 'skill' | 'verify'; title: string; summary: string; status: string | null; tags: string[]; created: string | null; updated: string | null; scope_label: string };

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');
/** ygl-trees 给的 scope：只认这几种写法，别的一律当空（空就是「只给管理层」） */
const SCOPE_RE = /^(\*|restricted|dept:[A-Za-z0-9._-]{1,64}|bench:[A-Za-z0-9._-]{1,64})$/;
/** 市场的部门标识（和授予范围 dept: 同一个写法）：ygl-trees 那边允许的字符更宽，对不上市场部门写法的不认 */
const MARKET_DEPT = /^dept:[a-z][a-z0-9-]{0,47}$/;
/** 项目名（ygl-trees 给的，同步时截到 128）：对照表只收 1～128 个字、不含控制字符的 */
const PROJECT_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const ISO_RE =/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** 接不上的原因（还没同步成过时，页面看到的是「未接入」）：本机没有 ygl-trees 命令行或工作区、版本太旧不认 library、契约版本对不上、回的不是 JSON */
const NOT_CONNECTED = new Set(['no_cli', 'no_home', 'exit', 'not_json', 'contract_unsupported', 'bad_shape']);
const REASON_TEXT: Record<string, string> = {
  no_cli: '本机找不到 ygl-trees 命令行（看 WM_YGL_CLI 或安装位置）', no_home: '没有设 ygl-trees 工作区（YGL_HOME）或目录不在',
  exit: 'ygl-trees 命令行出错退出（版本可能太旧，还没有 library 出口）', not_json: 'ygl-trees 命令行回的不是 JSON',
  contract_unsupported: `ygl-trees 的 library 契约版本对不上（要 ${CONTRACT}）`, bad_shape: 'ygl-trees 的 library 应答形状不对',
  timeout: '调 ygl-trees 命令行超时', too_many_pages: 'library 一次翻页太多，没取完',
};

export type SourceState = 'ok' | 'not_connected' | 'not_ready' | 'degraded';

export class KnowledgeService extends Service {
  private running = false;
  private secret: string | null = null;
  /** 已经告警过的原因：同一个原因在这个进程里只告警一次，不刷屏 */
  private warned = new Set<string>();
  /** 插件卸载了：排着的、跑到一半的同步都不再碰库 */
  private stopped = false;

  constructor(ctx: any) {
    super(ctx, 'knowledge');
    const minutes = loadConfig(Config).syncMinutes;
    if (minutes === 0) return;
    // 后台同步：等启动自检通过再开始；只读本机的 ygl-trees，不往外发；随插件卸载停下，不拦进程退出。
    // 每一轮都兜住错误（比如库已经关了）：记一行、下一轮再试，不把进程带崩
    ctx.effect(() => {
      this.stopped = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      const cancel = afterStartup(() => {
        if (this.stopped) return;
        this.backgroundRound();
        timer = setInterval(() => this.backgroundRound(), minutes * 60_000);
        timer.unref?.();
      });
      return () => { this.stopped = true; cancel(); if (timer) clearInterval(timer); };
    }, 'knowledge.sync');
  }

  /** 后台的一轮：停了就不跑；出错只记一行（同一个说法只记一次、去掉路径），下一轮再试 */
  private backgroundRound(): void {
    if (this.stopped) return;
    this.syncAll().catch((e) => {
      if (this.stopped) return;
      const msg = String((e as Error)?.message ?? e).replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/g, '<路径>').slice(0, 200);
      if (this.warned.has(`crash:${msg}`)) return;
      this.warned.add(`crash:${msg}`);
      console.error(`[knowledge] 经验库后台同步出错（下一轮再试；同一个说法只提示这一次）：${msg}`);
    });
  }

  /** 给页面的不透明键：本库自己的密钥（第一次用时随机生成并存下）对 kind:id 做 HMAC，截 22 位 */
  keyOf(kind: YglKind, id: string): string {
    if (!this.secret) {
      const got = db.prepare("SELECT v FROM knowledge_meta WHERE k = 'key-secret'").get() as { v: string } | undefined;
      if (got) this.secret = got.v;
      else {
        const fresh = randomBytes(32).toString('base64url');
        db.prepare("INSERT INTO knowledge_meta (k, v) VALUES ('key-secret', ?) ON CONFLICT (k) DO NOTHING").run(fresh);
        this.secret = (db.prepare("SELECT v FROM knowledge_meta WHERE k = 'key-secret'").get() as { v: string }).v;
      }
    }
    return createHmac('sha256', this.secret).update(`${kind}:${id}`).digest('base64url').slice(0, 22);
  }

  /** 同步四类；上一轮还没完就跳过这一轮 */
  async syncAll(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const kind of KINDS) {
        if (this.stopped) return;
        const st = db.prepare('SELECT last_full_at FROM knowledge_sync WHERE kind = ?').get(kind) as { last_full_at: number | null } | undefined;
        const full = !st?.last_full_at || now - st.last_full_at >= FULL_EVERY_MS;
        await this.syncKind(kind, full, now);
      }
    } finally { this.running = false; }
  }

  /** 同步一类。full：不带 --since 从头拉，拉完没再见到的去掉（library 的增量里不出现删除） */
  async syncKind(kind: YglKind, full: boolean, now = Date.now()): Promise<{ ok: boolean; error?: string; seen: number }> {
    const st = db.prepare('SELECT since FROM knowledge_sync WHERE kind = ?').get(kind) as { since: string } | undefined;
    const since = full ? '' : (st?.since ?? '');
    let cursor: string | null = null, maxUpdated = since, seen = 0;
    const fail = (error: string) => {
      db.prepare('INSERT INTO knowledge_sync (kind, last_error) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET last_error = excluded.last_error').run(kind, error);
      const reason = error.startsWith('store_failed') ? 'store_failed' : error;
      if (!this.warned.has(reason)) {
        this.warned.add(reason);
        console.warn(`[knowledge] 经验库这一轮没同步上：${REASON_TEXT[reason] ?? reason}（同一个原因只提示这一次；同步状态看 GET /api/knowledge/status）`);
      }
      return { ok: false, error, seen };
    };
    const upsert = db.prepare(`INSERT INTO knowledge_items (kind, ygl_id, key, title, summary, status, project, scope, tags, created, updated, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, ygl_id) DO UPDATE SET title = excluded.title, summary = excluded.summary, status = excluded.status, project = excluded.project,
        scope = excluded.scope, tags = excluded.tags, created = excluded.created, updated = excluded.updated, seen_at = excluded.seen_at`);
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = ['library', 'list', '--kind', kind, '--limit', String(PAGE_LIMIT), ...(since ? ['--since', since] : []), ...(cursor ? ['--cursor', cursor] : []), '--json'];
      const r = await execYgl(args, { timeoutMs: CALL_TIMEOUT_MS });
      if (this.stopped) return { ok: false, error: 'stopped', seen };
      if (!r.ok) return fail(r.error);
      const j = r.json as { contract?: unknown; items?: unknown; next_cursor?: unknown };
      if (!j || typeof j !== 'object' || j.contract !== CONTRACT) return fail('contract_unsupported');
      if (!Array.isArray(j.items)) return fail('bad_shape');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const it of j.items as Record<string, unknown>[]) {
          const id = clip(it?.id, 128);
          if (!id || it?.kind !== kind) continue;
          const updated = typeof it.updated === 'string' && ISO_RE.test(it.updated) ? it.updated : '';
          const scope = typeof it.scope === 'string' && SCOPE_RE.test(it.scope) ? it.scope : '';
          const tags = Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string').slice(0, 20).map((t) => t.slice(0, 64)) : [];
          upsert.run(kind, id, this.keyOf(kind, id), clip(it.title, 500), clip(it.summary, 600), clip(it.status, 32), clip(it.project, 128), scope, JSON.stringify(tags),
            typeof it.created === 'string' && ISO_RE.test(it.created) ? it.created : '', updated, now);
          if (updated > maxUpdated) maxUpdated = updated;
          seen++;
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } return fail(`store_failed:${String((e as Error)?.message ?? e).slice(0, 80)}`); }
      cursor = typeof j.next_cursor === 'string' && j.next_cursor ? j.next_cursor : null;
      if (!cursor) break;
    }
    if (cursor) return fail('too_many_pages');
    if (full) db.prepare('DELETE FROM knowledge_items WHERE kind = ? AND seen_at < ?').run(kind, now);
    db.prepare(`INSERT INTO knowledge_sync (kind, since, last_ok_at, last_full_at, last_error) VALUES (?, ?, ?, ?, '')
      ON CONFLICT (kind) DO UPDATE SET since = excluded.since, last_ok_at = excluded.last_ok_at, last_full_at = COALESCE(excluded.last_full_at, knowledge_sync.last_full_at), last_error = ''`)
      .run(kind, maxUpdated, now, full ? now : null);
    return { ok: true, seen };
  }

  /** 同步状态（给管理员看：上次成功、上次全量、上次失败的原因、每类条数；不带条目内容） */
  status(): { kind: YglKind; items: number; last_ok_at: number | null; last_full_at: number | null; last_error: string }[] {
    return KINDS.map((kind) => {
      const st = db.prepare('SELECT last_ok_at, last_full_at, last_error FROM knowledge_sync WHERE kind = ?').get(kind) as { last_ok_at: number | null; last_full_at: number | null; last_error: string } | undefined;
      const n = (db.prepare('SELECT COUNT(*) AS n FROM knowledge_items WHERE kind = ?').get(kind) as { n: number }).n;
      return { kind, items: Number(n), last_ok_at: st?.last_ok_at ?? null, last_full_at: st?.last_full_at ?? null, last_error: st?.last_error ?? '' };
    });
  }

  /**
   * 来源的大致状态（给页面，不带原因）：
   *   ok：每类都同步成过、最近一轮也成了；
   *   not_connected：一类都没成过，原因是接不上（没有命令行或工作区、版本太旧、契约对不上、回的不是 JSON）——「未接入」；
   *   not_ready：一类都没成过，还没跑过或只是超时这类；
   *   degraded：成过，但最近一轮有类没同步上（列表照常给已有的）。
   */
  sourceState(): SourceState {
    const st = this.status();
    if (st.every((s) => s.last_ok_at === null)) return st.some((s) => NOT_CONNECTED.has(s.last_error)) ? 'not_connected' : 'not_ready';
    return st.some((s) => s.last_error) ? 'degraded' : 'ok';
  }

  /** 「项目 → 部门」对照（只含部门还在的）：判范围时用 */
  private projectMap(): Map<string, string> {
    const rows = db.prepare(`SELECT p.project, p.department_id FROM knowledge_project_depts p JOIN departments d ON d.id = p.department_id`).all() as { project: string; department_id: string }[];
    return new Map(rows.map((r) => [r.project, r.department_id]));
  }

  /**
   * 对照表给管理层看：已经设了的（部门不在了的标 department_missing），加上条目里出现过、还没设的项目，再加最近 50 条改动。
   * 项目名只在这里给（看的人是能改对照的人），条目的列表、详情里不给。
   */
  projectDepts(): { projects: { project: string; department: { id: string; name: string } | null; department_missing: boolean; items: number; updated_at: number | null }[]; log: { project: string; old_department: string | null; new_department: string | null; at: number }[] } {
    const set = db.prepare(`SELECT p.project, p.department_id, p.updated_at, d.name AS dept_name FROM knowledge_project_depts p LEFT JOIN departments d ON d.id = p.department_id`).all() as { project: string; department_id: string; updated_at: number; dept_name: string | null }[];
    const counts = new Map((db.prepare(`SELECT project, COUNT(*) AS n FROM knowledge_items WHERE project != '' GROUP BY project`).all() as { project: string; n: number }[]).map((r) => [r.project, Number(r.n)]));
    const out = new Map<string, { project: string; department: { id: string; name: string } | null; department_missing: boolean; items: number; updated_at: number | null }>();
    for (const r of set) out.set(r.project, { project: r.project, department: r.dept_name === null ? null : { id: r.department_id, name: r.dept_name }, department_missing: r.dept_name === null, items: counts.get(r.project) ?? 0, updated_at: Number(r.updated_at) });
    for (const [project, n] of counts) if (!out.has(project)) out.set(project, { project, department: null, department_missing: false, items: n, updated_at: null });
    const log = (db.prepare('SELECT project, old_department, new_department, at FROM knowledge_project_dept_log ORDER BY id DESC LIMIT 50').all() as { project: string; old_department: string | null; new_department: string | null; at: number }[])
      .map((r) => ({ ...r, at: Number(r.at) }));
    return { projects: [...out.values()].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0)), log };
  }

  /** 设或清一个项目对到的部门（department 为 null 是清掉）。部门要在；每次改都记一行（谁、从哪个到哪个） */
  setProjectDept(project: string, department: string | null, by: string, now: number): { ok: true; changed: boolean } | { ok: false; error: 'project_invalid' | 'department_invalid' | 'department_missing' } {
    if (!PROJECT_RE.test(project)) return { ok: false, error: 'project_invalid' };
    if (department !== null) {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(department)) return { ok: false, error: 'department_invalid' };
      if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(department)) return { ok: false, error: 'department_missing' };
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = (db.prepare('SELECT department_id FROM knowledge_project_depts WHERE project = ?').get(project) as { department_id: string } | undefined)?.department_id ?? null;
      if (old === department) { db.exec('COMMIT'); return { ok: true, changed: false }; }
      if (department === null) db.prepare('DELETE FROM knowledge_project_depts WHERE project = ?').run(project);
      else db.prepare(`INSERT INTO knowledge_project_depts (project, department_id, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (project) DO UPDATE SET department_id = excluded.department_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(project, department, by, now);
      db.prepare('INSERT INTO knowledge_project_dept_log (project, old_department, new_department, actor, at) VALUES (?, ?, ?, ?, ?)').run(project, old, department, by, now);
      db.exec('COMMIT');
      return { ok: true, changed: true };
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
  }

  /** 这个人看得到的条目，新的在前，最多 limit 条；kind 是页面上的四类之一或不给 */
  list(actor: JudgedActor, opts: { kind?: YglKind; limit?: number } = {}): KnowledgeView[] {
    const can = visibility(actor);
    const projects = this.projectMap();
    const rows = (opts.kind
      ? db.prepare('SELECT * FROM knowledge_items WHERE kind = ? ORDER BY updated DESC, ygl_id').all(opts.kind)
      : db.prepare('SELECT * FROM knowledge_items ORDER BY updated DESC, kind, ygl_id').all()) as Row[];
    const out: KnowledgeView[] = [];
    for (const r of rows) {
      const scope = effectiveScope(r, projects);
      if (!can(scope)) continue;
      out.push(view(r, scope));
      if (out.length >= (opts.limit ?? 500)) break;
    }
    return out;
  }

  /**
   * 一条的详情：看不到的和不存在的都回 null（路由回同一个 404）。正文现取（library show）；
   * ygl-trees 说没有这一条（rc 1）也当不存在，顺手从目录去掉；别的失败回 'unavailable'。
   */
  async show(actor: JudgedActor, key: string): Promise<null | 'unavailable' | { item: KnowledgeView; body: string; evidence?: unknown[] }> {
    const r = db.prepare('SELECT * FROM knowledge_items WHERE key = ?').get(key) as Row | undefined;
    const scope = r ? effectiveScope(r, this.projectMap()) : '';
    if (!r || !visibility(actor)(scope)) return null;
    const res = await execYgl(['library', 'show', `${r.kind}:${r.ygl_id}`, '--json'], { timeoutMs: CALL_TIMEOUT_MS });
    if (!res.ok) {
      const gone = res.error === 'exit' && res.code === 1 && !!res.json && typeof res.json === 'object' && 'error' in (res.json as object);
      if (gone) { db.prepare('DELETE FROM knowledge_items WHERE kind = ? AND ygl_id = ?').run(r.kind, r.ygl_id); return null; }
      return 'unavailable';
    }
    const j = res.json as Record<string, unknown>;
    if (!j || j.contract !== CONTRACT) return 'unavailable';
    const body = typeof j.body === 'string' ? j.body.slice(0, 200_000) : '';
    // 依据带它的证据：只拣这几样给页面（原文摘录、解读、立场、来源的标题和地址），别的字段一律不转
    const evidence = r.kind === 'claim' && Array.isArray(j.evidence)
      ? (j.evidence as Record<string, unknown>[]).slice(0, 200).map((e) => ({
        quote: clip(e?.quote, 4000), note: clip(e?.note, 4000), stance: clip(e?.stance, 32), created: clip(e?.created, 40),
        source: e?.source && typeof e.source === 'object' ? { title: clip((e.source as Record<string, unknown>).title, 300), url: safeUrl((e.source as Record<string, unknown>).url) } : null,
      }))
      : undefined;
    return { item: view(r, scope), body, ...(evidence ? { evidence } : {}) };
  }
}

/** 来源的地址：只给 http/https 的绝对地址，别的（javascript:、本机路径）不给 */
function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

/**
 * 这一条实际按什么范围判：
 *   · ygl-trees 给了 scope 的，就用它（合规的 *、restricted、市场写法的 dept:）；给了别的（bench:、对不上写法的）只给管理层；
 *   · 没给 scope、有项目的：按「项目 → 部门」对照（projects，只含部门还在的）当那个部门的部门级；
 *   · 都没有、对不上的：只给管理层（restricted）。
 */
export function effectiveScope(r: Pick<Row, 'scope' | 'project'>, projects: ReadonlyMap<string, string> = new Map()): string {
  const s = r.scope;
  if (s === '') {
    const d = r.project ? projects.get(r.project) : undefined;
    return d !== undefined && MARKET_DEPT.test(`dept:${d}`) ? `dept:${d}` : 'restricted';
  }
  if (s === '*' || s === 'restricted') return s;
  if (MARKET_DEPT.test(s)) return s;
  // bench:<台>：统一判定还不认台范围（scopedVerdict 只认 dept:），先按只给管理层判——宁严勿宽
  return 'restricted';
}

function view(r: Row, scope: string): KnowledgeView {
  let tags: string[] = [];
  try { const t = JSON.parse(r.tags); if (Array.isArray(t)) tags = t.filter((x) => typeof x === 'string'); } catch { /* 坏了就当没有 */ }
  return {
    key: r.key, kind: PAGE_KIND[r.kind], title: r.title, summary: r.summary, status: r.status || null, tags,
    created: r.created || null, updated: r.updated || null, scope_label: scopeLabel(scope),
  };
}

/** 范围给人看的说法：全公司、部门名（读不到写「一个部门」）、只给管理层。不露部门标识 */
function scopeLabel(scope: string): string {
  if (scope === '*') return '全公司';
  if (scope.startsWith('dept:')) return svc<DepartmentService>('departments').scopeName(scope) ?? '一个部门';
  return '只给管理层';
}

/**
 * 看的人能不能看某个范围（规范 14：权限由授予给；关系只收窄，这里不用关系放宽）：
 *   · 全公司（*）：knowledge.read（看）。普通员工预设有业务的看，全员看得到。
 *   · 部门（dept:D）：管理层、属主（knowledge.read-restricted，拍板类，范围全部）；或者这个人持有范围正好是 dept:D 的授予盖住 knowledge.read。
 *     普通员工迁移来的那条范围「全部」的 member 不算——否则人人都看得到每个部门的。所以问 scopedVerdict 时带 exact，只认范围正好是 dept:D 的授予。
 *   · 只给管理层（restricted，以及 bench:、对不上的、空的）：knowledge.read-restricted（拍板类），只有管理层、属主有；系统管理员、普通员工预设都没有。
 * 管理口令、匿名在路由那一层就拒了，到不了这里。
 */
export function visibility(actor: JudgedActor): (scope: string) => boolean {
  const memo = new Map<string, boolean>();
  const restricted = () => {
    if (!memo.has('restricted')) memo.set('restricted', judge({ actor, action: 'knowledge.read-restricted', kind: 'decide', declared: true }).verdict === 'allow');
    return memo.get('restricted')!;
  };
  return (scope: string) => {
    if (scope === '*') {
      if (!memo.has('*')) memo.set('*', judge({ actor, action: 'knowledge.read', kind: 'read', declared: true }).verdict === 'allow');
      return memo.get('*')!;
    }
    if (restricted()) return true;
    if (scope.startsWith('dept:') && actor.type === 'principal') {
      if (!memo.has(scope)) memo.set(scope, scopedVerdict({ principal: actor.id, action: 'knowledge.read', kind: 'read', scope, exact: true }).verdict === 'allow');
      return memo.get(scope)!;
    }
    return false;
  };
}
