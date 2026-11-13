// #336 工作台变量与常量：每个登记台（自产台 / SOP 台 / 外部 Web 台 / Odoo 台）按 workbench id 各有一份键值空间，供看板读写。
//   · 持久化只用 SQLite（workbench_vars），写入返回即已落库；不经 Redis，也就没有「缓存写成功 ≠ 持久化成功」的歧义。
//   · 并发：乐观锁。每次写 revision +1；改/删已存在的键必须带期望 revision（If-Match 或 revision 参数），不符 409 并回当前 revision。
//     新建时可带 revision=0 表示「只在不存在时创建」；不带也行（撞上并发创建同样 409）。
//   · 常量 kind=const：写入后不能直接改、删。谁写的谁维护：新建时记作者（只认个人身份 mcp:<会话名> / odoo:<登录名>），
//     作者本人带 override 与 reason 可修订、删除（REST 与 MCP 都行）；作者缺失或要移交时由部署机本机命令行兜底（可改作者）。
//     管理员口令与 Odoo 管理员不因「是管理员」就能动别人的常量；按台令牌注入在台页面里、人人可得，不能新建常量。修订都留审计（只记值的 sha256）。
//   · 读写口径：本机命令行 / 管理员（口令或 Odoo 管理员）可读写任意台；自产台、SOP 台页面凭本台 X-App-Token 只能读写本台；
//     外部台没有按台令牌，只有管理员能读写。匿名一律 403。
import { createHash, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { db } from './db.ts';
import { defineConfig, str } from './config.ts';
import { svc } from './context.ts';
import { HttpError } from './errors.ts';
import { browserMarked, rawLoopback } from './surfaces.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { SettingService } from './services/setting.ts';
import type { WorkbenchVarsService, WorkbenchVarRow } from './services/workbench-vars.ts';
import { BenchError } from './bench-query.ts';
import { benchOfCard, createBench } from './services/bench-registry.ts';
import { benchStore, varsDigestOf, type BenchStore, type BenchVarRow } from './services/bench-store.ts';
import { benchKey, type StateLayerService } from './services/state-layer.ts';
import { root } from './root-context.ts';

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KEYS_PER_WORKBENCH = 512;
/** 键名以 hot. 开头的是高频变量（docs/data-views.md 第十三节第 5 条）：bench 档、配了 Redis 时先写 Redis、30 秒落一次台库，起名 hot. 就表示接受最多丢 30 秒 */
export const isHot = (key: string): boolean => key.startsWith('hot.');
// 台号只认十进制正整数、不带前导零（和 workbenchIdOf 同一口径）：写请求总门的令牌豁免和路由认的是同一个台
const PATH_RE = /^\/api\/workbenches\/([1-9]\d{0,11})\/vars(?:\/|$)/i;

export type WorkbenchClass = 'app' | 'sop' | 'external';
export type Scope = { id: number; cls: WorkbenchClass; slug: string | null };
/** 调用方：actor 记入 updated_by / 审计；admin=管理读写面（本机命令行、口令、Odoo 管理员）；cli=部署机本机命令行（常量兜底维护） */
export type Caller = { actor: string; admin: boolean; cli: boolean };
/** 能当常量作者的个人身份：MCP 会话或 Odoo 登录人；口令、本机、台令牌都是共享身份 */
const PERSONAL_RE = /^(mcp|odoo):[^\s]{1,128}$/;
const personal = (actor: string) => PERSONAL_RE.test(actor) ? actor : '';

export type WorkbenchVarsDeps = {
  /** 按台令牌（index.ts 的 wmAppToken） */
  appToken: (slug: string) => string;
  /** 按需认定 Odoo 管理员（写门/读面判管理员前调用） */
  markOdooAdmin: (req: express.Request) => Promise<void>;
  /** 管理读门（与凭据库同口径：同源页面 GET 也要管理员） */
  adminRead: (req: express.Request, res: express.Response) => boolean;
  /** 管理写门（口令或 Odoo 管理员 + 同源） */
  adminWrite: (req: express.Request, res: express.Response) => boolean;
  /** 管理员身份落到人：Odoo 管理员 odoo:<登录名>，口令 admin-token */
  adminActor: (req: express.Request) => string;
};

const vars = () => svc<WorkbenchVarsService>('workbenchVars');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function tokenEq(a: string, b: string): boolean {
  return a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * 台号：十进制正整数。数字照收（MCP 的参数）；字符串只收不带符号、不带前导零的十进制写法（路径里的 :id）。
 * 0x2、02、2.0、1e1、空都回 400——以前路由用 Number()，0x2 会落到 2 号台，而写请求总门只认十进制，两处口径不一
 */
export function workbenchIdOf(v: unknown): number {
  const ok = typeof v === 'number' ? Number.isSafeInteger(v) && v > 0 : typeof v === 'string' && /^[1-9]\d{0,11}$/.test(v);
  if (!ok) throw new HttpError(400, 'workbench id 必须是十进制正整数');
  return Number(v);
}
/** 台分类：market-app 的 /apps/<slug>/ 是自产台、/sop/<slug>/ 是 SOP 台；其余（Web、Odoo 等）都是外部台。台不存在返回 null */
function scopeLookup(id: number): Scope | null {
  const row = svc<WorkbenchService>('workbench').byId(id) as { id: number; url: string; type: string } | undefined;
  if (!row) return null;
  const m = row.type === 'market-app' ? /^\/(apps|sop)\/([a-z0-9][a-z0-9-]{0,63})\/$/.exec(row.url) : null;
  return m ? { id, cls: m[1] === 'apps' ? 'app' : 'sop', slug: m[2] } : { id, cls: 'external', slug: null };
}
/** 台分类；台不存在 404。给已经判过权的调用方用（MCP 网关、「关注」） */
export function workbenchScope(id: number): Scope {
  const scope = scopeLookup(workbenchIdOf(id));
  if (!scope) throw new HttpError(404, `workbench not found: ${id}`);
  return scope;
}

export function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new HttpError(400, 'key 规范：字母/数字/下划线开头，字母/数字/_ . : -，≤128 字符');
  return key;
}

function view(r: WorkbenchVarRow) {
  return { key: r.key, kind: r.kind, value: JSON.parse(r.value), revision: r.revision, updated_by: r.updated_by, owner: r.owner ?? '', created_at: r.created_at, updated_at: r.updated_at };
}

/** 期望 revision：If-Match（"3" / W/"3" / 3）与 revision 参数二选一；都给且不同 400 */
export function expectedRevision(ifMatch: unknown, param: unknown): number | undefined {
  const parse = (v: unknown, what: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
    if (!/^\d{1,12}$/.test(s)) throw new HttpError(400, `${what} 必须是非负整数 revision`);
    return Number(s);
  };
  const a = parse(ifMatch, 'If-Match');
  const b = parse(param, 'revision');
  if (a !== undefined && b !== undefined && a !== b) throw new HttpError(400, 'If-Match 与 revision 不一致');
  return a ?? b;
}

export const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

function conflict(scope: Scope, key: string, message: string, code: string, status = 409): never {
  const cur = vars().get(scope.id, key) as WorkbenchVarRow | undefined;
  throw new HttpError(status, message, { code, workbench_id: scope.id, key, current_revision: cur?.revision ?? 0, current: cur ? view(cur) : null });
}

function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ } throw e; }
}

/** 主库这一种存法（缺省）：整段同步，事务里不让出事件循环。对外的 listVars 等是异步的，存法换成台库时也是这几个入口 */
function listVarsMain(scope: Scope, prefix = '') {
  if (prefix && (prefix.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(prefix))) throw new HttpError(400, 'prefix 只能含字母/数字/_ . : -');
  const items = (vars().list(scope.id, prefix) as WorkbenchVarRow[]).map(view);
  return { workbench_id: scope.id, class: scope.cls, items, count: items.length };
}

function getVarMain(scope: Scope, key: string) {
  const r = vars().get(scope.id, checkKey(key)) as WorkbenchVarRow | undefined;
  if (!r) throw new HttpError(404, `var not found: ${key}`, { code: 'not_found', workbench_id: scope.id, key, current_revision: 0 });
  return { workbench_id: scope.id, ...view(r) };
}

/** 公共常量：owner 为 * 时，任何个人身份（mcp:/odoo:）都能带 override 与 reason 修订；台令牌、管理员口令这类共享身份不行 */
const PUBLIC_OWNER = '*';
/** 常量的规矩没过：主库那一种存法换成 conflict()（带当前行），台库那一种换成 conflictBench() */
class ConstRefusal extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) { super(message); this.code = code; this.status = status; }
}
/** 常量维护权：作者本人、公共常量的任一个人身份，或部署机本机命令行 */
function maintainConstCheck(cur: { owner: string }, caller: Caller, reason: string, what: string): void {
  const may = caller.cli || (cur.owner === PUBLIC_OWNER ? PERSONAL_RE.test(caller.actor) : !!cur.owner && caller.actor === cur.owner);
  if (!may) {
    const who = cur.owner === PUBLIC_OWNER ? '个人身份（MCP 会话或 Odoo 登录）' : `作者（${cur.owner || '未登记作者'}）`;
    throw new ConstRefusal(`常量只能由${who}或部署机本机命令行${what}`, 'const_override_forbidden', 403);
  }
  if (!reason) throw new ConstRefusal(`${what}常量要写 reason（记入审计）`, 'reason_required', 400);
}
function maintainConst(scope: Scope, key: string, cur: WorkbenchVarRow, caller: Caller, reason: string, what: string): void {
  try { maintainConstCheck(cur, caller, reason, what); } catch (e) { if (e instanceof ConstRefusal) conflict(scope, key, e.message, e.code, e.status); throw e; }
}
/**
 * 指定作者：本机命令行可新建时指定或移交给个人身份或 *；
 * 作者本人修订时只能把自己的常量设成公共（*），之后收回或另指作者只能走本机命令行。
 */
function ownerInputCheck(owner: unknown, caller: Caller, cur?: { kind: string; owner: string }): string | undefined {
  if (owner === undefined) return undefined;
  const o = typeof owner === 'string' ? owner.trim() : '';
  const toPublic = o === PUBLIC_OWNER && cur?.kind === 'const' && !!cur.owner && cur.owner !== PUBLIC_OWNER && caller.actor === cur.owner;
  if (!caller.cli && !toPublic) throw new ConstRefusal('指定或移交常量作者只限部署机本机命令行（作者本人可把自己的常量设成公共：owner="*"）', 'owner_change_forbidden', 403);
  if (o !== '' && o !== PUBLIC_OWNER && !PERSONAL_RE.test(o)) throw new HttpError(400, 'owner 只能是 mcp:<会话名>、odoo:<登录名> 或 *（公共）；空串=无作者');
  return o;
}
function ownerInput(scope: Scope, key: string, owner: unknown, caller: Caller, cur?: WorkbenchVarRow): string | undefined {
  try { return ownerInputCheck(owner, caller, cur); } catch (e) { if (e instanceof ConstRefusal) conflict(scope, key, e.message, e.code, e.status); throw e; }
}

type SetInput = { value?: unknown; hasValue: boolean; kind?: unknown; expected?: number; override?: boolean; reason?: unknown; owner?: unknown };
function setVarMain(scope: Scope, key: string, input: SetInput, caller: Caller) {
  checkKey(key);
  if (!input.hasValue) throw new HttpError(400, '缺 value（任意 JSON 值，null 也算）');
  if (input.kind !== undefined && input.kind !== 'var' && input.kind !== 'const') throw new HttpError(400, "kind 只能是 'var' 或 'const'");
  if (input.kind === 'const' && isHot(key)) throw new HttpError(400, 'hot. 开头的键是高频变量（可能丢最近 30 秒的写入），不能是常量');
  const json = JSON.stringify(input.value);
  if (json === undefined) throw new HttpError(400, 'value 不是合法 JSON 值');
  if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new HttpError(400, `value 超 ${MAX_VALUE_BYTES / 1024}KB 上限`);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const S = vars();
  return tx(() => {
    const cur = S.get(scope.id, key) as WorkbenchVarRow | undefined;
    if (!cur) {
      if (input.expected !== undefined && input.expected !== 0) conflict(scope, key, `键不存在，期望 revision ${input.expected} 不成立`, 'revision_conflict');
      if (S.count(scope.id) >= MAX_KEYS_PER_WORKBENCH) throw new HttpError(400, `每台最多 ${MAX_KEYS_PER_WORKBENCH} 个键`);
      const kind = (input.kind as string | undefined) ?? 'var';
      // 台令牌注入在台页面里，打开页面的人都拿得到：它建的常量没有可追的作者，只能写普通变量
      if (kind === 'const' && caller.actor.startsWith('app:')) conflict(scope, key, '按台令牌不能新建常量：常量要有作者，请用 MCP 会话或 Odoo 登录写', 'const_create_forbidden', 403);
      const asked = ownerInput(scope, key, input.owner, caller);
      if (asked !== undefined && kind !== 'const') throw new HttpError(400, 'owner 只用于常量');
      const owner = kind === 'const' ? (asked ?? personal(caller.actor)) : '';
      if (!S.insert(scope.id, key, kind, json, caller.actor, owner).changes) conflict(scope, key, '并发创建：键已被写入', 'revision_conflict');
      S.audit({ workbench_id: scope.id, key, action: 'create', actor: caller.actor, kind, old_revision: null, new_revision: 1, old_sha256: '', new_sha256: sha(json), reason });
      return { ok: true, created: true, workbench_id: scope.id, ...view(S.get(scope.id, key) as WorkbenchVarRow) };
    }
    if (cur.kind === 'const') {
      if (!input.override) conflict(scope, key, '常量写入后不能直接修改（作者本人可带 override 与 reason 修订）', 'const_locked', 403);
      maintainConst(scope, key, cur, caller, reason, '修订');
    }
    const asked = ownerInput(scope, key, input.owner, caller, cur);
    if (input.expected === undefined) conflict(scope, key, '改已存在的键必须带期望 revision（If-Match 或 revision）', 'revision_required', 428);
    if (input.expected !== cur.revision) conflict(scope, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
    const kind = (input.kind as string | undefined) ?? cur.kind;
    // 已存在的键改 kind（冻结 var→const）只限管理员：按台令牌在公开页面里，不能让持令牌者冻结别人的变量
    if (kind !== cur.kind && !caller.admin) conflict(scope, key, '改已存在键的 kind 只限管理员或本机命令行', 'kind_change_forbidden', 403);
    if (asked !== undefined && kind !== 'const') throw new HttpError(400, 'owner 只用于常量');
    // 作者：常量照旧（移交另算）；冻结时冻结者是作者；转回变量就没有作者
    const owner = kind !== 'const' ? '' : asked ?? (cur.kind === 'const' ? cur.owner : personal(caller.actor));
    if (!S.update(scope.id, key, cur.revision, kind, json, caller.actor, owner).changes) conflict(scope, key, 'revision 冲突：已被并发修改', 'revision_conflict');
    const action = cur.kind === 'const' ? (owner === PUBLIC_OWNER && cur.owner !== PUBLIC_OWNER ? 'make_public' : 'const_override') : kind === 'const' ? 'freeze' : 'update';
    S.audit({ workbench_id: scope.id, key, action, actor: caller.actor, kind, old_revision: cur.revision, new_revision: cur.revision + 1, old_sha256: sha(cur.value), new_sha256: sha(json), reason });
    return { ok: true, created: false, workbench_id: scope.id, ...view(S.get(scope.id, key) as WorkbenchVarRow) };
  });
}

type DeleteInput = { expected?: number; override?: boolean; reason?: unknown };
function deleteVarMain(scope: Scope, key: string, input: DeleteInput, caller: Caller) {
  checkKey(key);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const S = vars();
  return tx(() => {
    const cur = S.get(scope.id, key) as WorkbenchVarRow | undefined;
    if (!cur) throw new HttpError(404, `var not found: ${key}`, { code: 'not_found', workbench_id: scope.id, key, current_revision: 0 });
    if (cur.kind === 'const') {
      if (!input.override) conflict(scope, key, '常量不能直接删除（作者本人可带 override 与 reason 删除）', 'const_locked', 403);
      maintainConst(scope, key, cur, caller, reason, '删除');
    }
    if (input.expected === undefined) conflict(scope, key, '删除必须带期望 revision（If-Match 或 revision）', 'revision_required', 428);
    if (input.expected !== cur.revision || !S.delete(scope.id, key, cur.revision).changes) conflict(scope, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
    S.audit({ workbench_id: scope.id, key, action: cur.kind === 'const' ? 'const_delete' : 'delete', actor: caller.actor, kind: cur.kind, old_revision: cur.revision, new_revision: null, old_sha256: sha(cur.value), new_sha256: '', reason });
    return { ok: true, deleted: true, workbench_id: scope.id, key, revision: cur.revision };
  });
}

// —— 存法：WM_VARS_STORE（docs/data-views.md 第十三节第 5 条第 5 步）——
//   main（缺省）：只用主库，和原来一样。
//   shadow：主库是真源；主库写成之后，把这一行原样落一份进卡片的台库（失败只计数，不报错）。读照旧读主库。
//   bench：卡片的台库是真源（值在台库，审计照旧在主库）；写成之后尽力原样写回主库一份，留作回退。
// 对外的应答在三档下逐字节一样（字段、时间的文本格式都不变），由录制回放和 scripts/vars-store-diff-test.mjs 守。
export type VarsStoreMode = 'main' | 'shadow' | 'bench';
/**
 * 这个模块的配置（config.ts 的约定）：WM_VARS_STORE（main / shadow / bench，缺省 main）。值不合法在 read 里抛错，
 * 启动时由 index.ts 取一次（loadConfig）、拒绝启动；测试可以给自己的一份 env
 */
export const Config = defineConfig((env) => {
  const raw = str(env.WM_VARS_STORE);
  if (raw !== '' && raw !== 'main' && raw !== 'shadow' && raw !== 'bench') throw new Error(`WM_VARS_STORE 只接受 main、shadow、bench，现在是 ${JSON.stringify(raw)}`);
  return { store: (raw || 'main') as VarsStoreMode };
});
let storeMode: VarsStoreMode = 'main';
export function setVarsStoreMode(m: VarsStoreMode): void { storeMode = m; migrated.clear(); divergedReported.clear(); hotPending.clear(); }
export const varsStoreMode = (): VarsStoreMode => storeMode;
/** shadow 档跟写失败、bench 档写回主库失败的次数（只计数，不给值） */
const mirrorStats = { shadowFailures: 0, fallbackFailures: 0 };
export const varsMirrorStats = () => ({ ...mirrorStats });

/** 和主库里这两列原来的写法一样：UTC，'YYYY-MM-DD HH:MM:SS'（时间由代码生成后当参数传，两种库都认） */
const nowText = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');
const benchHttp = (e: unknown): never => {
  if (e instanceof BenchError) throw new HttpError(e.http, e.message);
  throw e;
};
/** 卡片的台库：没有登记时，写的时候由系统代建（不绑部门，只有管理层进得来）；读的时候不建，给 null */
async function cardStore(id: number, create: boolean): Promise<BenchStore | null> {
  try {
    let b = benchOfCard(id);
    if (!b) {
      if (!create) return null;
      b = createBench({ workbench_id: id }, 'system:vars', Date.now());
    }
    return await benchStore(b.slug);
  } catch (e) { return benchHttp(e); }
}
const asRow = (id: number, r: BenchVarRow): WorkbenchVarRow => ({ workbench_id: id, ...r });
const plainRows = (rows: WorkbenchVarRow[]): BenchVarRow[] => rows.map(({ workbench_id: _w, ...r }) => r as BenchVarRow);
/** bench 档里这个进程已经对过同步点的卡片（换档要重启，进程内对一次就够） */
const migrated = new Set<number>();
/** 主库那份分叉、拒绝以 bench 档服务的卡片（每张只报一次） */
const divergedReported = new Set<number>();

export type CardSyncAction = 'in-sync' | 'from-main' | 'to-main' | 'diverged';
/**
 * 对一张卡片的同步点（台库里记着：上次两边一致时主库那份的摘要 mark，和「bench 档写过、还没确认写回」的 dirty）：
 *   · 两边摘要一样：一致，补记同步点；
 *   · 没有 dirty（包括从没同步过）：台库从没在 bench 档写过、或写过的都已经写回——之后的不同只能来自主库那边
 *     （main、shadow 档期间的修改，或者 shadow 跟写失败），以主库为准，台库整份换成主库那份；
 *   · 有 dirty、主库从同步点以来没变（摘要等于 mark）：bench 档最后的写入没来得及写回，以台库为准，整份补写回主库；
 *   · 有 dirty、主库也变了：两边都改过，谁都不能静默为准——diverged，交给人处置（vars-migrate.mjs --resolve）。
 * dryRun 只判断不写。返回做了什么、写了几行
 */
export async function syncCard(id: number, store: BenchStore, opts: { dryRun?: boolean } = {}): Promise<{ action: CardSyncAction; written: number }> {
  const mainRows = vars().list(id, '') as WorkbenchVarRow[];
  const mainDigest = varsDigestOf(mainRows);
  const { mark, dirty, digest } = await store.varsSyncGet();
  if (digest === mainDigest) {
    if (!opts.dryRun && (mark !== mainDigest || dirty)) await store.varsSynced(mainDigest);
    return { action: 'in-sync', written: 0 };
  }
  if (!dirty) return { action: 'from-main', written: opts.dryRun ? mainRows.length : await store.varsReplace(plainRows(mainRows), mainDigest) };
  if (mark === mainDigest) {
    const rows = await store.varsList('');
    if (!opts.dryRun) { vars().replaceCard(id, rows); await store.varsSynced(varsDigestOf(rows)); }
    return { action: 'to-main', written: rows.length };
  }
  return { action: 'diverged', written: 0 };
}

/**
 * bench 档里拿一张卡片的台库之前先对同步点（syncCard）：主库那边变过就以主库为准重搬，bench 档最后的写入没写回就补写回；
 * 两边都改过就拒绝服务（503，报一次警），不静默以哪边为准。主库里有行而台库还没登记的卡片，在这里由系统代建台库；两边都没有、又只是读，给 null（不建）
 */
async function migratedStore(id: number, create: boolean): Promise<BenchStore | null> {
  if (migrated.has(id)) return cardStore(id, create);
  const store = await cardStore(id, create || (vars().list(id, '') as WorkbenchVarRow[]).length > 0);
  if (!store) return null;
  // 上一个进程留下的高频变量（Redis 里还没落盘的）：先原样落进台库（记 dirty），再对同步点——
  // 主库没变就补写回，主库也变了就报分叉；Redis 此刻不通就整张卡片先回 503（可重试），不拿台库里可能旧的值对同步点
  if ((await store.varsSyncGet()).hotPending) {
    hotPending.add(id); markPendingInMain(id, true);
    if ((await flushHot(id, store, false)) === 'unavailable') throw hotUnavailable(id);
  }
  let r: { action: CardSyncAction; written: number };
  try { r = await syncCard(id, store); } catch (e) { return benchHttp(e); }
  if (r.action === 'diverged') {
    if (!divergedReported.has(id)) { divergedReported.add(id); console.error(`[workbench-vars] 卡片 ${id} 的常量、变量在主库和台库两边都改过（bench 档的写入没写回之后，主库又变了），不以哪边为准；处置：node scripts/vars-migrate.mjs --resolve ${id} --keep main|bench`); }
    throw new HttpError(503, '这张卡片的常量、变量在两处存的不一致，已经报给管理员处置，请稍后再试', { code: 'vars_diverged', workbench_id: id });
  }
  if (r.action !== 'in-sync') console.log(`[workbench-vars] 卡片 ${id}：${r.action === 'from-main' ? `主库那边改过，台库按主库重搬 ${r.written} 行` : `bench 档的写入补写回主库 ${r.written} 行`}`);
  migrated.add(id);
  return store;
}

// —— 高频变量（hot. 开头的键）：bench 档、配了 Redis 时先写 Redis，30 秒落一次台库 ——
// Redis 里一张卡片一个 hash（wm:bench:<卡片>:vars:hot），字段是键，值是整行（删了的记 deleted）。写进 Redis 之前先在台库里记「有待落盘」。
// 落盘：Redis 那份原样落进台库、写回主库、记同步点，再删掉 Redis 那份、清「有待落盘」。同一张卡片的读写排队（withCard），落盘也排在里面。
// Redis 不通时：这张卡片有待落盘，高频变量的读写回 503（可重试），不回台库里可能旧的值；没有待落盘，高频变量照普通变量直接读写台库。
// 没配 Redis：高频变量就是普通变量。Redis 整个丢了，最多丢最近 30 秒（一个落盘周期）的写。
const state = () => svc<StateLayerService>('state');
const hotKey = (id: number): string => benchKey(id, 'vars', 'hot');
const hotOn = (): boolean => storeMode === 'bench' && state().mode() !== 'off';
/** 这个进程知道的、有待落盘的卡片 */
const hotPending = new Set<number>();
/**
 * 有待落盘的卡片，在主库里也记一份（设置项）：main、shadow 档不看 Redis、也不开台库，靠它知道哪些卡片的高频变量还在 Redis 里——
 * 这些卡片的高频变量在 main、shadow 档读写回 503，不悄悄读主库里的旧值；启动时报一次。只在进出「有待落盘」时写（很少）
 */
const PENDING_SETTING = 'vars_hot_pending_cards';
let pendingCache: number[] | null = null; // 只有本进程写这一项，读一次记住，写的时候一起更新
function pendingInMain(): number[] {
  if (pendingCache) return pendingCache;
  try { const v = JSON.parse((svc<SettingService>('setting').get(PENDING_SETTING) as { value?: string } | undefined)?.value ?? '[]'); pendingCache = Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x)) : []; } catch { pendingCache = []; }
  return pendingCache;
}
function markPendingInMain(id: number, on: boolean): void {
  const cur = new Set(pendingInMain());
  if (cur.has(id) === on) return;
  if (on) cur.add(id); else cur.delete(id);
  pendingCache = [...cur].sort((a, b) => a - b);
  if (cur.size) svc<SettingService>('setting').put(PENDING_SETTING, JSON.stringify([...cur].sort((a, b) => a - b)));
  else svc<SettingService>('setting').delete(PENDING_SETTING);
}
/** main、shadow 档：这张卡片的高频变量还在 Redis 里没落盘，读写一律 503 */
function guardStaleHot(id: number, keys: string[]): void {
  if (!keys.some(isHot) || !pendingInMain().includes(id)) return;
  throw new HttpError(503, '这张卡片还有高频变量没落盘（在缓存里）：先以 bench 档起服务、等它落完盘再切档', { code: 'vars_hot_unavailable', retryable: true, workbench_id: id });
}
/** 启动时（任何一档）报一次还有待落盘的卡片；不是 bench 档时写明怎么处置 */
export function reportHotPending(): number[] {
  const ids = pendingInMain();
  if (ids.length && storeMode !== 'bench') console.error(`[workbench-vars] 注意：卡片 ${ids.join('、')} 还有高频变量（hot. 开头）留在 Redis 里没落盘，现在是 ${storeMode} 档、不看 Redis——这些卡片的高频变量读写会回 503。处置：先以 WM_VARS_STORE=bench 起服务、等它落完盘（或各用一次这些卡片），再切档`);
  else if (ids.length) console.log(`[workbench-vars] 卡片 ${ids.join('、')} 有上一个进程没落盘的高频变量，第一次用到时先落盘`);
  return ids;
}
type HotEntry = BenchVarRow & { deleted?: boolean };
const hotUnavailable = (id: number) => new HttpError(503, '这张卡片的高频变量暂时读写不了（缓存不通，还有没落盘的写入），请稍后重试', { code: 'vars_hot_unavailable', retryable: true, workbench_id: id });
const plainEntry = ({ deleted: _d, ...r }: HotEntry): BenchVarRow => r as BenchVarRow;

/** 高频变量在 Redis 里的那份：{ row } 是以它为准（row 为 null 是删了）；null 是 Redis 里没有、照台库读 */
async function hotRead(id: number, key: string): Promise<{ row: BenchVarRow | null } | null> {
  if (!isHot(key) || !hotOn()) return null;
  const r = await state().hGet(hotKey(id), key);
  if (r.kind === 'hit') { const e = JSON.parse(r.value) as HotEntry; return { row: e.deleted ? null : plainEntry(e) }; }
  if (r.kind === 'down' || r.kind === 'error') { if (hotPending.has(id)) throw hotUnavailable(id); }
  return null;
}
/** 一行：高频变量先看 Redis，其余（和 Redis 里没有的）看台库 */
async function getRow(id: number, store: BenchStore, key: string): Promise<BenchVarRow | null> {
  const h = await hotRead(id, key);
  return h ? h.row : await store.varGet(key);
}
/** 列表：台库那份叠上 Redis 里的高频变量 */
async function listRows(id: number, store: BenchStore, prefix: string): Promise<BenchVarRow[]> {
  const rows = await store.varsList(prefix);
  if (!hotOn()) return rows;
  const r = await state().hGetAll(hotKey(id));
  if (r.kind !== 'hit') { if (r.kind !== 'off' && hotPending.has(id)) throw hotUnavailable(id); return rows; }
  const entries = Object.values(r.value).map((v) => JSON.parse(v) as HotEntry).filter((e) => e.key.startsWith(prefix));
  if (!entries.length) return rows;
  const m = new Map(rows.map((x) => [x.key, x]));
  for (const e of entries) { if (e.deleted) m.delete(e.key); else m.set(e.key, plainEntry(e)); }
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/**
 * 高频变量写进 Redis。true：写进去了；false：Redis 不通、这张卡片也没有待落盘——调用方照普通变量写台库。
 * Redis 不通而这张卡片有待落盘：503（可重试）
 */
async function hotWrite(id: number, store: BenchStore, entry: HotEntry): Promise<boolean> {
  if (!isHot(entry.key) || !hotOn()) return false;
  if (state().mode() !== 'up') { if (hotPending.has(id)) throw hotUnavailable(id); return false; }
  if (!hotPending.has(id)) { await store.varsHotPending(true); markPendingInMain(id, true); hotPending.add(id); }
  if (!(await state().hSet(hotKey(id), entry.key, JSON.stringify(entry)))) throw hotUnavailable(id);
  return true;
}
/**
 * 落盘一张卡片（调用方已经排进这张卡片的队）。writeBack：写回主库、记同步点（进程第一次用到卡片时不写回，交给 syncCard 判断）。
 * 'clean'：没有待落盘了；'unavailable'：Redis 不通，留着下次再落
 */
async function flushHot(id: number, store: BenchStore, writeBack: boolean): Promise<'clean' | 'unavailable'> {
  const r = await state().hGetAll(hotKey(id));
  if (r.kind === 'off') { // 没配 Redis 了（换了配置）：Redis 里那份拿不到，就是丢了的那最多 30 秒
    console.warn(`[workbench-vars] 卡片 ${id} 有高频变量没落盘，但现在没配 Redis，那部分写入拿不回来了`);
  } else if (r.kind !== 'hit') {
    return 'unavailable';
  } else {
    const entries = Object.values(r.value).map((v) => JSON.parse(v) as HotEntry);
    if (entries.length) {
      try { await store.varsApplyHot(entries.map((e) => (e.deleted ? { deleted: true as const, key: e.key } : plainEntry(e)))); } catch (e) { return benchHttp(e); }
      // 写回主库用整张卡片换掉（replaceCard），不走 fallbackToMain 那条「同版本、不同值算失败」：
      // writeBack 只在这个进程已经对过同步点之后（bench 档运行中），这时主库只有本进程在写（写回），台库就是真源，整份照台库写回是对的。
      // 进程第一次用到卡片时不写回（writeBack=false），交给 syncCard 判断主库有没有被别处改过。
      if (writeBack && svc<WorkbenchService>('workbench').byId(id)) { // 卡片刚被删了就不写回（查和写之间没有 await）
        const rows = await store.varsList('');
        try { vars().replaceCard(id, rows); await store.varsSynced(varsDigestOf(rows)); } catch { mirrorStats.fallbackFailures++; }
      }
    }
    if (!(await state().del(hotKey(id)))) return 'unavailable';
  }
  try { await store.varsHotPending(false); } catch (e) { return benchHttp(e); }
  markPendingInMain(id, false);
  hotPending.delete(id);
  return 'clean';
}
/** 落盘一遍：这个进程知道的有待落盘的卡片，加上 Redis 里还有高频变量的卡片（上一个进程留下的）。每 30 秒一次、进程退出前一次 */
export async function flushHotVars(): Promise<{ cards: number; unavailable: number }> {
  const out = { cards: 0, unavailable: 0 };
  if (!hotOn()) return out;
  const ids = new Set(hotPending);
  for (const id of (await state().benchIdsWith('vars', 'hot')) ?? []) ids.add(id);
  for (const id of ids) {
    out.cards++;
    try {
      await withCard(id, async () => {
        const gone = () => { hotPending.delete(id); markPendingInMain(id, false); }; // 卡片已经删了：台库、Redis 的键随删台清掉
        if (!migrated.has(id)) { if (!(await migratedStore(id, false))) gone(); return; } // 第一次用到时会先落盘、再对同步点
        const store = await cardStore(id, false);
        if (!store) { gone(); return; }
        if ((await flushHot(id, store, true)) === 'unavailable') out.unavailable++;
      });
    } catch { out.unavailable++; }
  }
  return out;
}
/** 每 30 秒落一次（挂在根上下文上，卸载时一起停）。进程退出前由 index.ts 的关闭流程再落一次 */
export function startHotVarsFlush(): void {
  root.effect(() => {
    const timer = setInterval(() => { void flushHotVars().catch(() => {}); }, 30_000);
    timer.unref?.();
    return () => { clearInterval(timer); };
  }, 'workbench-vars.hotFlush(30s)');
}

async function conflictBench(scope: Scope, store: BenchStore | null, key: string, message: string, code: string, status = 409): Promise<never> {
  const cur = store ? await getRow(scope.id, store, key) : null;
  throw new HttpError(status, message, { code, workbench_id: scope.id, key, current_revision: cur?.revision ?? 0, current: cur ? view(asRow(scope.id, cur)) : null });
}

async function listVarsBench(scope: Scope, prefix = '') {
  if (prefix && (prefix.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(prefix))) throw new HttpError(400, 'prefix 只能含字母/数字/_ . : -');
  const store = await migratedStore(scope.id, false);
  const items = (store ? await listRows(scope.id, store, prefix) : []).map((r) => view(asRow(scope.id, r)));
  return { workbench_id: scope.id, class: scope.cls, items, count: items.length };
}
async function getVarBench(scope: Scope, key: string) {
  checkKey(key);
  const store = await migratedStore(scope.id, false);
  const r = store ? await getRow(scope.id, store, key) : null;
  if (!r) throw new HttpError(404, `var not found: ${key}`, { code: 'not_found', workbench_id: scope.id, key, current_revision: 0 });
  return { workbench_id: scope.id, ...view(asRow(scope.id, r)) };
}
/** 规矩和 setVarMain 一字一句对应（常量的作者、乐观锁、kind 的变更、上限），只是读写在台库、审计在主库 */
async function setVarBench(scope: Scope, key: string, input: SetInput, caller: Caller) {
  checkKey(key);
  if (!input.hasValue) throw new HttpError(400, '缺 value（任意 JSON 值，null 也算）');
  if (input.kind !== undefined && input.kind !== 'var' && input.kind !== 'const') throw new HttpError(400, "kind 只能是 'var' 或 'const'");
  if (input.kind === 'const' && isHot(key)) throw new HttpError(400, 'hot. 开头的键是高频变量（可能丢最近 30 秒的写入），不能是常量');
  const json = JSON.stringify(input.value);
  if (json === undefined) throw new HttpError(400, 'value 不是合法 JSON 值');
  if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new HttpError(400, `value 超 ${MAX_VALUE_BYTES / 1024}KB 上限`);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const store = (await migratedStore(scope.id, true)) as BenchStore;
  const S = vars();
  const cur = await getRow(scope.id, store, key);
  const at = nowText();
  if (!cur) {
    if (input.expected !== undefined && input.expected !== 0) return conflictBench(scope, store, key, `键不存在，期望 revision ${input.expected} 不成立`, 'revision_conflict');
    if ((hotOn() ? (await listRows(scope.id, store, '')).length : await store.varCount()) >= MAX_KEYS_PER_WORKBENCH) throw new HttpError(400, `每台最多 ${MAX_KEYS_PER_WORKBENCH} 个键`);
    const kind = (input.kind as string | undefined) ?? 'var';
    if (kind === 'const' && caller.actor.startsWith('app:')) return conflictBench(scope, store, key, '按台令牌不能新建常量：常量要有作者，请用 MCP 会话或 Odoo 登录写', 'const_create_forbidden', 403);
    const asked = await ownerInputBench(scope, store, key, input.owner, caller);
    if (asked !== undefined && kind !== 'const') throw new HttpError(400, 'owner 只用于常量');
    const owner = kind === 'const' ? (asked ?? personal(caller.actor)) : '';
    const hotRow: BenchVarRow = { key, kind: kind as BenchVarRow['kind'], value: json, revision: 1, updated_by: caller.actor, owner, created_at: at, updated_at: at };
    const hot = await hotWrite(scope.id, store, hotRow);
    if (!hot && !(await store.varInsert({ key, kind, value: json, by: caller.actor, owner, at }))) return conflictBench(scope, store, key, '并发创建：键已被写入', 'revision_conflict');
    S.audit({ workbench_id: scope.id, key, action: 'create', actor: caller.actor, kind, old_revision: null, new_revision: 1, old_sha256: '', new_sha256: sha(json), reason });
    const now = hot ? hotRow : (await store.varGet(key)) as BenchVarRow;
    if (!hot) await fallbackToMain(scope.id, store, key, now);
    return { ok: true, created: true, workbench_id: scope.id, ...view(asRow(scope.id, now)) };
  }
  if (cur.kind === 'const') {
    if (!input.override) return conflictBench(scope, store, key, '常量写入后不能直接修改（作者本人可带 override 与 reason 修订）', 'const_locked', 403);
    await maintainConstBench(scope, store, key, cur, caller, reason, '修订');
  }
  const asked = await ownerInputBench(scope, store, key, input.owner, caller, cur);
  if (input.expected === undefined) return conflictBench(scope, store, key, '改已存在的键必须带期望 revision（If-Match 或 revision）', 'revision_required', 428);
  if (input.expected !== cur.revision) return conflictBench(scope, store, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
  const kind = (input.kind as string | undefined) ?? cur.kind;
  if (kind !== cur.kind && !caller.admin) return conflictBench(scope, store, key, '改已存在键的 kind 只限管理员或本机命令行', 'kind_change_forbidden', 403);
  if (asked !== undefined && kind !== 'const') throw new HttpError(400, 'owner 只用于常量');
  const owner = kind !== 'const' ? '' : asked ?? (cur.kind === 'const' ? cur.owner : personal(caller.actor));
  const hotRow: BenchVarRow = { key, kind: kind as BenchVarRow['kind'], value: json, revision: cur.revision + 1, updated_by: caller.actor, owner, created_at: cur.created_at, updated_at: at };
  const hot = await hotWrite(scope.id, store, hotRow);
  if (!hot && !(await store.varUpdate({ key, expected: cur.revision, kind, value: json, by: caller.actor, owner, at }))) return conflictBench(scope, store, key, 'revision 冲突：已被并发修改', 'revision_conflict');
  const action = cur.kind === 'const' ? (owner === PUBLIC_OWNER && cur.owner !== PUBLIC_OWNER ? 'make_public' : 'const_override') : kind === 'const' ? 'freeze' : 'update';
  S.audit({ workbench_id: scope.id, key, action, actor: caller.actor, kind, old_revision: cur.revision, new_revision: cur.revision + 1, old_sha256: sha(cur.value), new_sha256: sha(json), reason });
  const now = hot ? hotRow : (await store.varGet(key)) as BenchVarRow;
  if (!hot) await fallbackToMain(scope.id, store, key, now);
  return { ok: true, created: false, workbench_id: scope.id, ...view(asRow(scope.id, now)) };
}
async function deleteVarBench(scope: Scope, key: string, input: DeleteInput, caller: Caller) {
  checkKey(key);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const store = await migratedStore(scope.id, false);
  const cur = store ? await getRow(scope.id, store, key) : null;
  if (!store || !cur) throw new HttpError(404, `var not found: ${key}`, { code: 'not_found', workbench_id: scope.id, key, current_revision: 0 });
  if (cur.kind === 'const') {
    if (!input.override) return conflictBench(scope, store, key, '常量不能直接删除（作者本人可带 override 与 reason 删除）', 'const_locked', 403);
    await maintainConstBench(scope, store, key, cur, caller, reason, '删除');
  }
  if (input.expected === undefined) return conflictBench(scope, store, key, '删除必须带期望 revision（If-Match 或 revision）', 'revision_required', 428);
  if (input.expected !== cur.revision) return conflictBench(scope, store, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
  const hot = await hotWrite(scope.id, store, { ...cur, deleted: true });
  if (!hot && !(await store.varDelete(key, cur.revision))) return conflictBench(scope, store, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
  vars().audit({ workbench_id: scope.id, key, action: cur.kind === 'const' ? 'const_delete' : 'delete', actor: caller.actor, kind: cur.kind, old_revision: cur.revision, new_revision: null, old_sha256: sha(cur.value), new_sha256: '', reason });
  if (!hot) await fallbackToMain(scope.id, store, key, null);
  return { ok: true, deleted: true, workbench_id: scope.id, key, revision: cur.revision };
}
async function maintainConstBench(scope: Scope, store: BenchStore, key: string, cur: BenchVarRow, caller: Caller, reason: string, what: string): Promise<void> {
  try { maintainConstCheck(cur, caller, reason, what); } catch (e) { if (e instanceof ConstRefusal) await conflictBench(scope, store, key, e.message, e.code, e.status); throw e; }
}
async function ownerInputBench(scope: Scope, store: BenchStore, key: string, owner: unknown, caller: Caller, cur?: BenchVarRow): Promise<string | undefined> {
  try { return ownerInputCheck(owner, caller, cur); } catch (e) { if (e instanceof ConstRefusal) await conflictBench(scope, store, key, e.message, e.code, e.status); throw e; }
}
/**
 * bench 档：原样写回主库一份（留作回退），写成了就记同步点、清 dirty。
 * 失败只计数：dirty 留着，下次对同步点时（syncCard）主库没变就补写回，主库也变了就报分叉
 */
async function fallbackToMain(id: number, store: BenchStore, key: string, row: BenchVarRow | null): Promise<void> {
  try {
    if (!svc<WorkbenchService>('workbench').byId(id)) return; // 卡片刚被删了：不往主库补孤儿行（查和写之间没有 await，删卡片插不进来）
    const cur = vars().get(id, key) as WorkbenchVarRow | undefined;
    if (!row) vars().force(id, key, null);
    else if (!cur || cur.revision < row.revision) vars().force(id, key, row);
    else if (cur.revision !== row.revision || cur.value !== row.value || cur.kind !== row.kind || cur.owner !== row.owner) throw new Error('主库那行比台库新或不同');
    await store.varsSynced(varsDigestOf(vars().list(id, '') as WorkbenchVarRow[]));
  } catch { mirrorStats.fallbackFailures++; }
}
/** shadow 档：主库写成之后，把主库里这一行（或「已删」）原样落一份进卡片的台库；失败只计数 */
async function shadowMirror(id: number, key: string): Promise<void> {
  try {
    const r = vars().get(id, key) as WorkbenchVarRow | undefined;
    const store = await cardStore(id, true);
    const { workbench_id: _w, ...row } = r ?? ({} as WorkbenchVarRow);
    await store!.varForce(key, r ? (row as BenchVarRow) : null);
  } catch { mirrorStats.shadowFailures++; }
}

/**
 * 把主库里的常量、变量搬进各卡片的台库（迁移脚本 scripts/vars-migrate.mjs 用）。每张卡片照 syncCard 的规矩对一次同步点，能重复跑：
 *   · 两边一致的卡片跳过——第二次跑是零写入；
 *   · 台库没在 bench 档写过的（包括从没搬过的），以主库为准整份搬（written 是搬了几行）；
 *   · bench 档最后的写入没写回、主库没变的，补写回主库（to_main）；两边都改过的不动，只报卡片号（diverged），由 --resolve 处置。
 * dryRun：只数，不写、不建台库。主库里卡片已经不在的行（孤儿）不搬，只报个数。审计照旧在主库
 */
export async function migrateVars(opts: { dryRun?: boolean } = {}): Promise<{ cards: number; rows: number; written: number; skipped: number; to_main: number; diverged: number[]; orphans: number; hot: number }> {
  const out = { cards: 0, rows: 0, written: 0, skipped: 0, to_main: 0, diverged: [] as number[], orphans: 0, hot: hotVarKeys().length };
  for (const id of vars().workbenchIds()) {
    const rows = vars().list(id, '') as WorkbenchVarRow[];
    if (!svc<WorkbenchService>('workbench').byId(id)) { out.orphans += rows.length; continue; }
    out.cards++; out.rows += rows.length;
    const store = await cardStore(id, !opts.dryRun);
    if (!store) { out.written += rows.length; continue; } // dry-run、还没有台库：要整份搬
    const r = await syncCard(id, store, { dryRun: opts.dryRun });
    if (r.action === 'in-sync') out.skipped++;
    else if (r.action === 'from-main') out.written += r.written;
    else if (r.action === 'to-main') out.to_main++;
    else out.diverged.push(id);
  }
  return out;
}

/**
 * 处置分叉的卡片（vars-migrate.mjs --resolve <卡片> --keep main|bench）：keep 那一边为准，另一边整份换掉、记同步点。
 * 换掉的那一边按键写审计（action 'resolve'），只记摘要
 */
export async function resolveCardVars(id: number, keep: 'main' | 'bench', actor: string): Promise<{ id: number; keep: string; changed: number }> {
  if (!svc<WorkbenchService>('workbench').byId(id)) throw new HttpError(404, `workbench not found: ${id}`);
  const store = await cardStore(id, true) as BenchStore;
  if ((await store.varsSyncGet()).hotPending) throw new HttpError(409, `卡片 ${id} 还有高频变量没落盘（在 Redis 里）：先以 bench 档起服务、等它落完盘（或用到这张卡片一次），再处置`, { code: 'vars_hot_pending' });
  const mainRows = plainRows(vars().list(id, '') as WorkbenchVarRow[]);
  const benchRows = await store.varsList('');
  const [from, to] = keep === 'main' ? [mainRows, benchRows] : [benchRows, mainRows];
  const before = new Map(to.map((r) => [r.key, r]));
  const after = new Map(from.map((r) => [r.key, r]));
  let changed = 0;
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const o = before.get(k), n = after.get(k);
    if (o && n && o.revision === n.revision && o.value === n.value && o.kind === n.kind && o.owner === n.owner) continue;
    changed++;
    vars().audit({ workbench_id: id, key: k, action: 'resolve', actor, kind: (n ?? o)!.kind, old_revision: o?.revision ?? null, new_revision: n?.revision ?? null, old_sha256: o ? sha(o.value) : '', new_sha256: n ? sha(n.value) : '', reason: `分叉处置：以${keep === 'main' ? '主库' : '台库'}为准` });
  }
  if (keep === 'main') await store.varsReplace(mainRows, varsDigestOf(mainRows));
  else { vars().replaceCard(id, benchRows); await store.varsSynced(varsDigestOf(benchRows)); }
  migrated.delete(id); divergedReported.delete(id);
  return { id, keep, changed };
}

/**
 * bench 档里同一张卡片的写入在进程内一笔一笔来（写台库 → 写回主库 → 记同步点 整个做完才轮到下一笔）：
 * 不让两笔交错，记同步点时拿到的主库摘要就不会倒退。varsSynced 自己也只在两边真一致时清 dirty，两道都在
 */
const cardQueues = new Map<number, Promise<unknown>>();
function withCard<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const prev = cardQueues.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  cardQueues.set(id, tail);
  void tail.then(() => { if (cardQueues.get(id) === tail) cardQueues.delete(id); });
  return run;
}

// —— 对外的入口（异步）：按 WM_VARS_STORE 走主库或台库 ——
// bench 档的读也排进这张卡片的队：进程第一次用到卡片时要对同步点（可能整份重搬），不能和正在写回的写入交错
export async function listVars(scope: Scope, prefix = '') {
  if (storeMode === 'bench') return withCard(scope.id, () => listVarsBench(scope, prefix));
  const out = listVarsMain(scope, prefix);
  if ('hot.'.startsWith(prefix) || isHot(prefix)) guardStaleHot(scope.id, ['hot.']); // 列表可能含高频变量（只在 Redis 里的，主库里根本没有）
  return out;
}
export async function getVar(scope: Scope, key: string) { if (storeMode === 'bench') return withCard(scope.id, () => getVarBench(scope, key)); guardStaleHot(scope.id, [key]); return getVarMain(scope, key); }
export async function setVar(scope: Scope, key: string, input: SetInput, caller: Caller) {
  if (storeMode === 'bench') return withCard(scope.id, () => setVarBench(scope, key, input, caller));
  guardStaleHot(scope.id, [key]);
  const out = setVarMain(scope, key, input, caller);
  if (storeMode === 'shadow') await shadowMirror(scope.id, key);
  return out;
}
export async function deleteVar(scope: Scope, key: string, input: DeleteInput, caller: Caller) {
  if (storeMode === 'bench') return withCard(scope.id, () => deleteVarBench(scope, key, input, caller));
  guardStaleHot(scope.id, [key]);
  const out = deleteVarMain(scope, key, input, caller);
  if (storeMode === 'shadow') await shadowMirror(scope.id, key);
  return out;
}

/**
 * 报一次已有的 hot. 开头的键（启动时、迁移的 dry-run 时）：第 5 步以后键名以 hot. 开头的变量是高频变量，可能丢最近 30 秒的写入；
 * 这些键原来不丢写入，切过去以后会变成可能丢，要先让写的人知道。只报卡片和键名，不报值
 */
export function hotVarKeys(): { workbench_id: number; key: string }[] {
  return vars().keysWithPrefix('hot.');
}
export function reportHotVarKeys(): void {
  try {
    const hot = hotVarKeys();
    if (hot.length) console.warn(`[vars] 有 ${hot.length} 个键以 hot. 开头（${hot.slice(0, 20).map((h) => `卡片 ${h.workbench_id} 的 ${h.key}`).join('、')}${hot.length > 20 ? ' 等' : ''}）：高频变量上线以后，这些键会变成「可能丢最近 30 秒的写入」。不想这样的，改个不以 hot. 开头的名字`);
  } catch { /* 主库还没有这张表：不报 */ }
}

/**
 * 比对一张卡片：主库那份和台库那份，每个键的 kind、revision、owner、值的摘要都比（不比条数了事）。「零差异」以摘要为准
 */
export async function compareCardVars(id: number): Promise<{ id: number; main: { count: number; sha256: string }; bench: { count: number; sha256: string } | null; same: boolean }> {
  const rows = vars().list(id, '') as WorkbenchVarRow[];
  const main = { count: rows.length, sha256: varsDigestOf(rows) };
  const store = await cardStore(id, false);
  const bench = store ? await store.varsDigest() : null;
  return { id, main, bench, same: bench ? bench.sha256 === main.sha256 : rows.length === 0 };
}

/** 删台级联：变量随台删除，审计行保留 */
export function dropWorkbenchVars(workbenchId: number): void {
  vars().deleteAll(workbenchId);
}

// ---------- MCP（workbench_vars_get / workbench_vars_set）：会话授权由 /mcp 网关管；常量 override 只对作者本人的会话生效 ----------
export async function mcpVarsGet(args: any) {
  const scope = workbenchScope(workbenchIdOf(args?.id));
  return args?.key === undefined ? listVars(scope, typeof args?.prefix === 'string' ? args.prefix : '') : getVar(scope, String(args.key));
}

export async function mcpVarsSet(args: any, subject: string) {
  const scope = workbenchScope(workbenchIdOf(args?.id));
  return setVar(scope, String(args?.key ?? ''), {
    value: args?.value, hasValue: args != null && Object.prototype.hasOwnProperty.call(args, 'value'),
    kind: args?.kind, expected: expectedRevision(undefined, args?.revision), reason: args?.reason, override: truthy(args?.override), owner: args?.owner,
  }, { actor: subject, admin: false, cli: false });
}

// ---------- REST ----------
export function createWorkbenchVars(deps: WorkbenchVarsDeps) {
  /** 本台令牌是否有效（只有自产台 / SOP 台有令牌；台不存在的不算） */
  function appTokenOk(req: express.Request, scope: Scope | null): boolean {
    const presented = String(req.headers['x-app-token'] ?? '').trim();
    return !!scope?.slug && tokenEq(presented, deps.appToken(scope.slug));
  }

  /**
   * 判权在查台之前（规则一：拒绝的应答不看资源在不在）：台不存在时 scope 为 null。
   * 令牌对不上不存在的台，和对不上别的台同一句 403；管理门照常判。过了的人（本机命令行、管理员）才由外壳回 404
   */
  async function authorize(req: express.Request, res: express.Response, scope: Scope | null, write: boolean): Promise<Caller | null> {
    if (!browserMarked(req) && rawLoopback(req)) return { actor: 'cli', admin: true, cli: true }; // 本机命令行
    if (req.headers['x-app-token'] !== undefined) {
      if (scope && appTokenOk(req, scope)) return { actor: `app:${scope.slug}`, admin: false, cli: false };
      res.status(403).json({ error: '按台令牌不属于该工作台（只能读写本台变量；外部台只限管理员）', code: 'app_token_mismatch' });
      return null;
    }
    await deps.markOdooAdmin(req);
    if (!(write ? deps.adminWrite(req, res) : deps.adminRead(req, res))) return null;
    return { actor: deps.adminActor(req), admin: true, cli: false };
  }

  const handle = (write: boolean, fn: (req: express.Request, res: express.Response, scope: Scope, caller: Caller) => void | Promise<void>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      (async () => {
        const id = workbenchIdOf(req.params.id); // 写法不对的台号 400：只看请求本身，不透露台在不在
        const scope = scopeLookup(id);
        const caller = await authorize(req, res, scope, write);
        if (!caller) return;
        if (!scope) throw new HttpError(404, `workbench not found: ${id}`); // 只有过了判权的人看得到台在不在
        res.set('Cache-Control', 'no-store');
        await fn(req, res, scope, caller);
      })().catch(next);
    };

  return {
    /** 路由的外壳：认台号、判权（本机命令行、本台令牌、管理员）、再看台在不在、no-store，再交给处理函数（路由在 routes/workbench-vars.ts） */
    handle,
    /** 读门（和 GET /api/workbenches/:id/vars 同一个）：「关注」的待属主看板复用它判可见性 */
    authorizeRead: (req: express.Request, res: express.Response, scope: Scope) => authorize(req, res, scope, false),
    /** 沙箱页面（Origin: null）凭本台令牌跨源读写：预检只回允许头；实际请求令牌对了才发 ACAO */
    cors(req: express.Request, res: express.Response, next: express.NextFunction) {
      const m = PATH_RE.exec(String(req.url ?? '').split('?')[0]);
      if (!m || String(req.headers.origin ?? '') !== 'null') return next();
      const setAcao = () => {
        res.setHeader('access-control-allow-origin', 'null');
        res.setHeader('access-control-allow-methods', 'GET,PUT,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type,x-app-token,if-match');
        res.setHeader('access-control-expose-headers', 'etag');
        res.setHeader('access-control-max-age', '600');
      };
      if (req.method === 'OPTIONS') { setAcao(); return res.status(204).end(); }
      if (appTokenOk(req, scopeLookup(Number(m[1])))) setAcao(); // 台不存在、令牌不对：不发 ACAO
      return next();
    },

    /** 写门豁免：/api/workbenches/:id/vars 写请求带本台有效令牌（路由内再判一次） */
    appTokenWrite(req: express.Request): boolean {
      const m = PATH_RE.exec(req.path);
      if (!m || req.headers['x-app-token'] === undefined) return false;
      return appTokenOk(req, scopeLookup(Number(m[1])));
    },

  };
}
