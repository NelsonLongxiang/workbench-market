/**
 * 台数据域（app_data + app_files）：台的提交记录和附件的元数据。
 *
 * 接口一律是异步的（数据层第 6 步，docs/data-views.md 第十三节）：下一步要按 WM_APP_DATA_STORE 把存法换成卡片的台库（台库在工作线程里，只能异步），
 * 调用方现在就按异步写，换存法时只换这里的里面。现在的里面仍是主库上的同步语句，所以应答、次序和原来一样。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { defineConfig, str } from '../config.ts';
import { svc } from '../context.ts';
import { HttpError } from '../errors.ts';
import { BenchError } from '../bench-query.ts';
import type { WorkbenchService } from './workbench.ts';
import { benchOfCard, createBench } from './bench-registry.ts';
import { appDataRowOf, appDigestOf, appFileRowOf, benchStore, type BenchAppDataRow, type BenchAppFileRow, type BenchStore } from './bench-store.ts';

/**
 * 台的提交记录和附件存在哪（数据层第 6 步，docs/data-views.md 第十三节第 6 条）：WM_APP_DATA_STORE = main（缺省）/ shadow / bench。
 *   main：只用主库，和原来一样。
 *   shadow：照旧读主库；写主库之后，把主库那一行原样抄一份进卡片的台库。
 *   bench：读卡片的台库；写照旧先写主库（id 由主库发，过渡期留作回退），再原样抄进台库。
 * 两档都是「主库先写、台库照抄」，所以两边不会分叉：每个进程第一次用到一个台时比一次两边的摘要，对不上就按主库整份重抄；
 * 抄失败只记下「这个台要重抄」，下次用到之前补上，不让请求失败（主库那一笔已经写成了）。
 * 台没有卡片（还没发布、卡片删了）时三档一样只用主库。附件字节不进台库，storage_path 原样记。
 */
export type AppDataStoreMode = 'main' | 'shadow' | 'bench';
export const Config = defineConfig((env) => {
  const raw = str(env.WM_APP_DATA_STORE);
  if (raw !== '' && raw !== 'main' && raw !== 'shadow' && raw !== 'bench') throw new Error(`WM_APP_DATA_STORE 只接受 main、shadow、bench，现在是 ${JSON.stringify(raw)}`);
  return { store: (raw || 'main') as AppDataStoreMode };
});

export type AppDataRow = { id: number; data: string; created_by: string; created_at: string };
export type AppFileRow = Record<string, unknown> & { id: number; storage_path: string };

const benchHttp = (e: unknown): never => {
  if (e instanceof BenchError) throw new HttpError(e.http, e.message);
  throw e;
};

export class AppDataService extends Service {
  private mode: AppDataStoreMode = 'main';
  /** 这个进程里已经对过两边摘要、确认一致的台 */
  private synced = new Set<string>();
  /** 抄进台库失败的次数（只计数） */
  private mirrorFailures = 0;
  /** 同一个台在台库这一侧的操作一笔一笔来（对摘要、整份重抄、照抄一行），不让「重抄用的主库快照」和「照抄新的一行」交错 */
  private queues = new Map<string, Promise<unknown>>();

  constructor(ctx: any) {
    super(ctx, 'appData');
  }

  setMode(m: AppDataStoreMode): void { this.mode = m; this.synced.clear(); }
  storeMode(): AppDataStoreMode { return this.mode; }
  stats() { return { mirror_failures: this.mirrorFailures }; }

  private inQueue<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(slug) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.queues.set(slug, tail);
    void tail.then(() => { if (this.queues.get(slug) === tail) this.queues.delete(slug); });
    return run;
  }
  /** 这个台的卡片（发布时自动登记；台没有卡片给 null） */
  cardOf(slug: string): number | null {
    const ids = svc<WorkbenchService>('workbench').idsByAppUrls(`/apps/${slug}/`, `/sop/${slug}/`);
    return ids.length ? ids[0] : null;
  }
  /** 主库里这个台的全部行（含软删的），迁移、对摘要用 */
  mainAll(slug: string): { data: BenchAppDataRow[]; files: BenchAppFileRow[] } {
    return {
      data: (db.prepare('SELECT * FROM app_data WHERE app_slug = ? ORDER BY id').all(slug) as Record<string, unknown>[]).map(appDataRowOf),
      files: (db.prepare('SELECT * FROM app_files WHERE app_slug = ? ORDER BY id').all(slug) as Record<string, unknown>[]).map(appFileRowOf),
    };
  }
  /** 有提交或附件的台（迁移用） */
  slugsWithRows(): string[] {
    return (db.prepare('SELECT app_slug FROM app_data UNION SELECT app_slug FROM app_files ORDER BY 1').all() as { app_slug: string }[]).map((r) => r.app_slug);
  }
  /**
   * 卡片的台库。create：没登记就由系统代建（不绑部门，只有管理层进得来），否则给 null。台没有卡片给 null
   */
  async benchOf(slug: string, create: boolean): Promise<BenchStore | null> {
    const id = this.cardOf(slug);
    if (id === null) return null;
    try {
      let b = benchOfCard(id);
      if (!b) {
        if (!create) return null;
        b = createBench({ workbench_id: id }, 'system:app-data', Date.now());
      }
      return await benchStore(b.slug);
    } catch (e) { return benchHttp(e); }
  }
  /**
   * 对一个台：两边摘要不同就按主库整份重抄。dryRun 只判断。返回写了几行（一致是 0）。调用方要在这个台的队里
   */
  async syncSlug(slug: string, store: BenchStore, opts: { dryRun?: boolean } = {}): Promise<number> {
    const main = this.mainAll(slug);
    const want = appDigestOf(main.data, main.files);
    const have = await store.appDigest();
    if (have.sha256 === want) return 0;
    const n = main.data.length + main.files.length;
    if (!opts.dryRun) await store.appReplace(main.data, main.files);
    return n;
  }
  /**
   * 把主库里的提交和附件抄进各台卡片的台库（scripts/app-data-migrate.mjs 用）。按台逐个对摘要，能重复跑：一致的跳过，第二次跑是零写入。
   * dryRun 只数，不写、不建台库。只给数字：几个台、几行、要写几行；没有卡片的台、台已经删了的孤儿、一个台对应几张卡片的、
   * storage_path 在磁盘上找不到的附件。fileExists 由调用方给（这里不碰文件系统）
   */
  async migrate(opts: { dryRun?: boolean; fileExists: (storagePath: string) => boolean }): Promise<{ slugs: number; rows: number; written: number; skipped: number; no_card: number; no_card_rows: number; orphans: number; orphan_rows: number; multi_card: number; missing_files: number }> {
    const out = { slugs: 0, rows: 0, written: 0, skipped: 0, no_card: 0, no_card_rows: 0, orphans: 0, orphan_rows: 0, multi_card: 0, missing_files: 0 };
    const known = new Set((db.prepare('SELECT slug FROM apps').all() as { slug: string }[]).map((r) => r.slug));
    for (const slug of this.slugsWithRows()) {
      const main = this.mainAll(slug);
      const n = main.data.length + main.files.length;
      out.missing_files += main.files.filter((f) => !opts.fileExists(f.storage_path)).length;
      if (!known.has(slug)) { out.orphans++; out.orphan_rows += n; continue; }
      const cards = svc<WorkbenchService>('workbench').idsByAppUrls(`/apps/${slug}/`, `/sop/${slug}/`);
      if (cards.length > 1) out.multi_card++;
      if (!cards.length) { out.no_card++; out.no_card_rows += n; continue; }
      out.slugs++; out.rows += n;
      await this.inQueue(slug, async () => {
        const store = await this.benchOf(slug, !opts.dryRun);
        const w = store ? await this.syncSlug(slug, store, { dryRun: opts.dryRun }) : n;
        if (w) out.written += w; else out.skipped++;
        if (store && !opts.dryRun) this.synced.add(slug);
      });
    }
    return out;
  }
  /** 一个台主库那份和台库那份的摘要是不是一样（--compare、shadow 档每天的比对用）。台没有卡片或者还没有台库，按「台库那份是空的」比 */
  async compare(slug: string): Promise<{ same: boolean; main: { data: number; files: number }; bench: { data: number; files: number } | null }> {
    const main = this.mainAll(slug);
    const store = await this.benchOf(slug, false);
    const want = appDigestOf(main.data, main.files);
    const have = store ? await store.appDigest() : null;
    return { same: have ? have.sha256 === want : main.data.length + main.files.length === 0, main: { data: main.data.length, files: main.files.length }, bench: have ? { data: have.data, files: have.files } : null };
  }

  /** bench 档读之前：这个进程第一次用到这个台时对一次摘要（要重抄的也在这里补上）。台没有卡片、或者两边都没有东西时给 null（照主库读） */
  private async readStore(slug: string): Promise<BenchStore | null> {
    if (this.mode !== 'bench') return null;
    return this.inQueue(slug, async () => {
      const store = await this.benchOf(slug, (db.prepare('SELECT 1 AS x FROM app_data WHERE app_slug = ? UNION SELECT 1 FROM app_files WHERE app_slug = ? LIMIT 1').get(slug, slug)) !== undefined);
      if (!store) return null;
      if (!this.synced.has(slug)) {
        try { await this.syncSlug(slug, store); } catch (e) { return benchHttp(e); }
        this.synced.add(slug);
      }
      return store;
    });
  }
  /**
   * 删卡片之前（WM_APP_DATA_STORE 不是 main 时）：这张卡片对应的台的提交、附件在台库里，删卡片就是删它们。
   * 先把主库那份对齐进台库（让删卡片那道门看得到规模，有就要管理层并确认），返回台的 slug；main 档、或者不是台的卡片给 null
   */
  async beforeCardDelete(url: string): Promise<string | null> {
    if (this.mode === 'main') return null;
    const m = /^\/(?:apps|sop)\/([a-z0-9][a-z0-9-]{0,63})\/$/.exec(url);
    if (!m) return null;
    const slug = m[1];
    if (this.cardOf(slug) === null) return null;
    await this.inQueue(slug, async () => {
      const store = await this.benchOf(slug, (db.prepare('SELECT 1 AS x FROM app_data WHERE app_slug = ? UNION SELECT 1 FROM app_files WHERE app_slug = ? LIMIT 1').get(slug, slug)) !== undefined);
      if (store) { try { await this.syncSlug(slug, store); } catch (e) { return benchHttp(e); } this.synced.add(slug); }
    });
    return slug;
  }

  /** shadow、bench 档写成主库之后：把主库那一行原样抄进台库。失败只计数、记下这个台要重抄（主库那一笔已经写成了，不让请求失败） */
  private async mirror(slug: string, kind: 'data' | 'file', id: number): Promise<void> {
    if (this.mode === 'main') return;
    await this.inQueue(slug, async () => {
      try {
        const store = await this.benchOf(slug, true);
        if (!store) return;
        if (!this.synced.has(slug)) { await this.syncSlug(slug, store); this.synced.add(slug); return; } // 整份对齐，这一行也在里面
        const row = kind === 'data' ? db.prepare('SELECT * FROM app_data WHERE id = ? AND app_slug = ?').get(id, slug) : db.prepare('SELECT * FROM app_files WHERE id = ? AND app_slug = ?').get(id, slug);
        if (!row) { if (kind === 'data') await store.appDataDrop(id); else await store.appFileDrop(id); return; }
        if (kind === 'data') await store.appDataPut(appDataRowOf(row as Record<string, unknown>));
        else await store.appFilePut(appFileRowOf(row as Record<string, unknown>));
      } catch { this.mirrorFailures++; this.synced.delete(slug); }
    });
  }

  /** 写一条提交，返回 id。8f-2：submitter 是验过票据的提交人主体，没有就 null；idempotencyKey 是带了提交方范围的键（没有是空串） */
  async dataInsert(slug: string, data: string, createdBy: string, idempotencyKey: string, submitter: string | null): Promise<number> {
    const r = db.prepare('INSERT INTO app_data (app_slug, data, created_by, idempotency_key, submitter_principal) VALUES (?, ?, ?, ?, ?)').run(slug, data, createdBy, idempotencyKey, submitter);
    const id = Number(r.lastInsertRowid);
    await this.mirror(slug, 'data', id);
    return id;
  }
  async dataByIdempotencyKey(slug: string, key: string): Promise<{ id: number; data: string; created_at: string } | undefined> {
    const store = await this.readStore(slug);
    if (store) { const r = await store.appDataByIdem(key); return r ? { id: r.id, data: r.data, created_at: r.created_at } : undefined; }
    return db.prepare('SELECT id, data, created_at FROM app_data WHERE app_slug = ? AND idempotency_key = ?').get(slug, key) as { id: number; data: string; created_at: string } | undefined;
  }
  async dataPage(slug: string, beforeId: number, limit: number): Promise<AppDataRow[]> {
    const store = await this.readStore(slug);
    if (store) return (await store.appDataPage(beforeId, limit)).map((r) => ({ id: r.id, data: r.data, created_by: r.created_by, created_at: r.created_at }));
    // #132 P0③：软删行过滤
    return (beforeId > 0
      ? db.prepare("SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND deleted_at = '' AND id < ? ORDER BY id DESC LIMIT ?").all(slug, beforeId, limit)
      : db.prepare("SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND deleted_at = '' ORDER BY id DESC LIMIT ?").all(slug, limit)) as AppDataRow[];
  }
  /** 删台用：只删主库那份（台库那份随卡片走删卡片那条路一起处理） */
  async dataDelete(slug: string): Promise<void> {
    db.prepare('DELETE FROM app_data WHERE app_slug = ?').run(slug);
    this.synced.delete(slug);
  }
  /** #193 F5：没删到（不存在、已经删了）返回 false，路由回 404 */
  async dataSoftDelete(id: number, slug: string): Promise<boolean> {
    const done = Number(db.prepare("UPDATE app_data SET deleted_at = datetime('now') WHERE id = ? AND app_slug = ? AND deleted_at = ''").run(id, slug).changes) > 0;
    if (done) await this.mirror(slug, 'data', id);
    return done;
  }
  /** 写一个附件的元数据，返回 id。#132 P0①：note 落库；sha256 入库时已知就存（REST 下载 ETag 用） */
  async fileInsert(slug: string, name: string, mime: string, size: number, storagePath: string, createdBy: string, note = '', sha256 = ''): Promise<number> {
    const r = db.prepare('INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by, note, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slug, name, mime, size, storagePath, createdBy, note, sha256);
    const id = Number(r.lastInsertRowid);
    await this.mirror(slug, 'file', id);
    return id;
  }
  async fileSetSha256(id: number, slug: string, sha256: string): Promise<void> {
    if (Number(db.prepare("UPDATE app_files SET sha256 = ? WHERE id = ? AND app_slug = ? AND sha256 = ''").run(sha256, id, slug).changes) > 0) await this.mirror(slug, 'file', id);
  }
  async filePage(slug: string, beforeId: number, limit: number): Promise<Record<string, unknown>[]> {
    const store = await this.readStore(slug);
    // 键的次序和主库那条 SELECT 一样（应答逐字节不变）
    if (store) return (await store.appFilePage(beforeId, limit)).map((r) => ({ id: r.id, original_name: r.original_name, mime: r.mime, size: r.size, note: r.note, created_by: r.created_by, created_at: r.created_at }));
    // #132 P0①③：列表返 note/created_by/created_at·软删行过滤
    return (beforeId > 0
      ? db.prepare("SELECT id, original_name, mime, size, note, created_by, created_at FROM app_files WHERE app_slug = ? AND deleted_at = '' AND id < ? ORDER BY id DESC LIMIT ?").all(slug, beforeId, limit)
      : db.prepare("SELECT id, original_name, mime, size, note, created_by, created_at FROM app_files WHERE app_slug = ? AND deleted_at = '' ORDER BY id DESC LIMIT ?").all(slug, limit)) as Record<string, unknown>[];
  }
  /** #193 F4：软删行不可见（下载、改 note、软删都 404） */
  async fileById(id: number, slug: string): Promise<AppFileRow | undefined> {
    const store = await this.readStore(slug);
    if (store) { const r = await store.appFileById(id); return r ? { id: r.id, app_slug: slug, original_name: r.original_name, mime: r.mime, size: r.size, storage_path: r.storage_path, created_by: r.created_by, created_at: r.created_at, sha256: r.sha256, note: r.note, deleted_at: r.deleted_at } : undefined; }
    return db.prepare("SELECT * FROM app_files WHERE id = ? AND app_slug = ? AND deleted_at = ''").get(id, slug) as AppFileRow | undefined;
  }
  /** 契约核 file_ids 用：给的这些 id 里，属于本台、没软删的有哪些（一次查完，契约校验本身是同步的） */
  async fileIdsExisting(slug: string, ids: number[]): Promise<Set<number>> {
    const store = await this.readStore(slug);
    if (store) return new Set(await store.appFileIdsExisting(ids));
    const out = new Set<number>();
    const stmt = db.prepare("SELECT 1 AS x FROM app_files WHERE id = ? AND app_slug = ? AND deleted_at = ''");
    for (const id of new Set(ids)) if (stmt.get(id, slug)) out.add(id);
    return out;
  }
  /** #132 P0①：note 更新 */
  async fileUpdateNote(id: number, slug: string, note: string): Promise<void> {
    if (Number(db.prepare('UPDATE app_files SET note = ? WHERE id = ? AND app_slug = ?').run(note, id, slug).changes) > 0) await this.mirror(slug, 'file', id);
  }
  /** #132 P0③：软删（deleted_at 置位·原行留审计）。#193 F5：没删到返回 false，路由回 404 */
  async fileSoftDelete(id: number, slug: string): Promise<boolean> {
    const done = Number(db.prepare("UPDATE app_files SET deleted_at = datetime('now') WHERE id = ? AND app_slug = ? AND deleted_at = ''").run(id, slug).changes) > 0;
    if (done) await this.mirror(slug, 'file', id);
    return done;
  }
  async fileCount(slug: string): Promise<number> {
    const store = await this.readStore(slug);
    if (store) return store.appFileCount();
    return Number((db.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = ? AND deleted_at = ''").get(slug) as { n: number }).n); // #193 F8 全量计数
  }
  /** 删台级联用：含软删行（行随台硬删，磁盘字节也必须一并删，否则成无主孤儿） */
  async filePaths(slug: string): Promise<string[]> {
    return (db.prepare('SELECT storage_path FROM app_files WHERE app_slug = ?').all(slug) as { storage_path: string }[]).map((r) => r.storage_path);
  }
  async filesDelete(slug: string): Promise<void> {
    db.prepare('DELETE FROM app_files WHERE app_slug = ?').run(slug);
    this.synced.delete(slug);
  }
}
