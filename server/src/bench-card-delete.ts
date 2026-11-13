/**
 * 删一张卡片时连带它的台库（docs/data-views.md 第十三节第 5 条第 3 步；统筹 2026-11-13 定的规矩）。
 *
 * 删业务数据是业务决定，不是系统操作（规范 14：系统管理员看不到台里的数据，也不能一个人把它删掉）：
 *   · 卡片的台库里有东西（数据集或视图版本）时，删卡片的人必须持有管理层授予（holdsManagementGrant），并且带 confirm_bench_data: true。
 *     本机命令行是属主，同样要带确认。只有管理口令、系统管理员身份、MCP 会话的，一律 409，提示去找管理层。
 *   · 409 的说明只给规模（几个数据集、多少行、多大、几版视图），不给数据集名、列名、数值——那些本身就是业务数据。
 *   · 删之前先备份一份进 bench-stores/.deleted/，留 30 天，到期由清扫（services/bench-sweep.ts）删掉。留痕写明谁删的、备份是哪个文件、什么时候到期。
 *     恢复这次没有入口：需要时由运维从备份手工恢复。
 * 卡片没有台、或者台库是空的：和原来一样直接删（不要确认、不留备份）。
 *
 * 顺序：主库一个事务（台的登记、授予、没定的申请、卡片本身、它的常量变量、驾驶舱面板）→ 提交之后删台库文件、清 Redis 键。
 * 提交之后那两步失败不回滚：登记已经没了，没有任何路径读得到留下的文件和键（台 id 不复用），由清扫补上。
 */
import type express from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.ts';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import { browserMarked, rawLoopback } from './surfaces.ts';
import type { PrincipalService } from './services/principal.ts';
import type { StateLayerService } from './services/state-layer.ts';
import { benchOfCard, removeCardBench } from './services/bench-registry.ts';
import { BENCH_BACKUP_KEEP_MS, BENCH_DELETED_DIR, benchBackupName, benchStore, benchStoreExists, removeBenchStore } from './services/bench-store.ts';
import { holdsManagementGrant } from './work-item-access.ts';


/** 谁在删 */
export type CardDeleter =
  | { kind: 'owner' }
  | { kind: 'principal'; id: string }
  | { kind: 'admin-token' }
  | { kind: 'session'; name: string }
  | { kind: 'anonymous' };

let resolver: ReturnType<ReturnType<typeof identity>['cachedResolver']> | null = null;
/** REST 删卡片的人：本机命令行是属主；带登录 cookie 认得出的是那个人；只带管理口令的是管理口令 */
export async function cardDeleterOf(req: express.Request, adminTokenOk: (req: express.Request) => boolean): Promise<CardDeleter> {
  if (rawLoopback(req) && !browserMarked(req)) return { kind: 'owner' };
  const cookie = String(req.headers.cookie ?? '');
  if (cookie) {
    resolver ??= identity().cachedResolver({ ttlMs: 60_000, max: 1000 });
    let who: { ok: boolean; viewer?: { sub?: unknown } };
    try { who = await resolver(cookie) as typeof who; } catch { who = { ok: false }; }
    const id = who.ok && typeof who.viewer?.sub === 'string' ? who.viewer.sub : '';
    if (id && svc<PrincipalService>('principals').get(id)) return { kind: 'principal', id };
  }
  return adminTokenOk(req) ? { kind: 'admin-token' } : { kind: 'anonymous' };
}

const actorText = (d: CardDeleter): string => (d.kind === 'principal' ? d.id : d.kind === 'session' ? `mcp:${d.name}` : `builtin:${d.kind === 'owner' ? 'local-cli' : d.kind}`);

export type BenchScale = { datasets: number; rows: number; bytes: number; view_versions: number };
/** 这个台的库里有多少东西（只给规模）。没有库文件、或者库是空的，返回 null */
async function scaleOf(slug: string): Promise<BenchScale | null> {
  if (!benchStoreExists(slug)) return null;
  const s = await benchStore(slug);
  const ds = await s.datasets(), vv = await s.viewVersions();
  if (!ds.length && !vv.length) return null;
  return { datasets: ds.length, rows: ds.reduce((n, d) => n + d.row_count, 0), bytes: ds.reduce((n, d) => n + d.data_bytes, 0), view_versions: vv.length };
}

/**
 * 删卡片。deleteCard 在主库的事务里做卡片本身那一份（删卡片、常量变量、驾驶舱面板），拿到的是这张卡片的台标识（没有台是 null）。
 * 卡片不存在由 deleteCard 自己抛 404（事务回滚，台不动）。
 */
export async function deleteCardWithBench(input: { id: number; deleter: CardDeleter; confirmBenchData: boolean; exists: () => boolean; deleteCard: (slug: string | null) => void }): Promise<{ ok: true; deleted: number; bench?: { slug: string; backup: string; backup_expires_at: string } }> {
  const { id, deleter } = input;
  if (!input.exists()) throw new HttpError(404, `workbench not found: ${id}`);
  const bench = benchOfCard(id);
  const scale = bench ? await scaleOf(bench.slug) : null;
  const at = Date.now();
  let backup: string | null = null;
  if (bench && scale) {
    const may = deleter.kind === 'owner' || (deleter.kind === 'principal' && holdsManagementGrant(deleter.id));
    if (!may) throw new HttpError(409, '这张卡片的台库里有业务数据，删它要由持有管理层授予的人来做（并且确认）；请联系管理层', { code: 'bench_data_needs_management', bench_data: scale });
    if (!input.confirmBenchData) throw new HttpError(409, '这张卡片的台库里有业务数据，删卡片会一起删掉；确认要删，请求里带 confirm_bench_data: true（删之前会留一份备份，30 天后清掉）', { code: 'bench_data_confirm_required', bench_data: scale });
    mkdirSync(BENCH_DELETED_DIR, { recursive: true });
    backup = benchBackupName(bench.slug, at);
    await (await benchStore(bench.slug)).backupTo(join(BENCH_DELETED_DIR, backup));
  }
  const expires = new Date(at + BENCH_BACKUP_KEEP_MS).toISOString();
  const note = backup ? `备份 .deleted/${backup}，${expires} 到期` : '';
  const slug = removeCardBench(id, actorText(deleter), at, note, input.deleteCard);
  if (slug) {
    // 提交之后：删库文件、清 Redis 键。失败不回滚，由清扫补上
    try { await removeBenchStore(slug); } catch (e) { console.error(`[bench-card-delete] 台 ${slug} 的库文件没删掉，留给清扫：${(e as Error)?.message ?? e}`); }
    try { await svc<StateLayerService>('state').clearBench(id); } catch { /* 清扫补上 */ }
  }
  return { ok: true, deleted: id, ...(slug && backup ? { bench: { slug, backup: `.deleted/${backup}`, backup_expires_at: expires } } : {}) };
}
