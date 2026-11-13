/**
 * 台库的清扫：Cordis 服务 `benchSweep`（docs/data-views.md 第十三节第 5 条第 3 步）。起来 1 分钟后扫一次，之后每天一次；随根上下文停。
 *
 *   1. 台库目录里没有登记的库文件（删卡片时删文件失败留下的）：先备份进 .deleted/（和删卡片时同一个样子），再删掉。
 *   2. .deleted/ 里过了 30 天的备份：删掉。
 *   3. Redis 里卡片已经不在的台的键：清掉。
 * 没有登记的库文件读不到（入口都先核登记），台 id 不复用，所以这些都只是占地方；挪走之前留备份，误删能救回来。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../db.ts';
import { registeredSlugs, liveCardIds } from './bench-registry.ts';
import { BENCH_BACKUP_KEEP_MS, BENCH_BACKUP_NAME_RE, BENCH_DELETED_DIR, benchBackupName, benchStore, removeBenchStore } from './bench-store.ts';
import type { StateLayerService } from './state-layer.ts';

const STORES = join(dataDir, 'bench-stores');
const FIRST_MS = 60_000;
const EVERY_MS = 86_400_000;

export type SweepResult = { orphan_stores: number; expired_backups: number; redis_keys: number | null };

export class BenchSweepService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'benchSweep');
    ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const tick = (ms: number) => {
        timer = setTimeout(() => { void this.run().catch((e) => console.error(`[bench-sweep] 清扫出错：${(e as Error)?.message ?? e}`)).finally(() => tick(EVERY_MS)); }, ms);
        timer.unref?.();
      };
      tick(FIRST_MS);
      return () => { if (timer) clearTimeout(timer); timer = null; };
    }, 'benchSweep.timer');
  }

  /** 扫一遍。at 是「现在」（测试可以往后拨） */
  async run(at = Date.now()): Promise<SweepResult> {
    const out: SweepResult = { orphan_stores: 0, expired_backups: 0, redis_keys: 0 };
    // 1. 没有登记的库文件
    if (existsSync(STORES)) {
      const known = registeredSlugs();
      for (const f of readdirSync(STORES)) {
        const m = /^([a-z0-9][a-z0-9-]{0,63})\.sqlite$/.exec(f);
        if (!m || known.has(m[1] as string)) continue;
        const slug = m[1] as string;
        try {
          mkdirSync(BENCH_DELETED_DIR, { recursive: true });
          await (await benchStore(slug)).backupTo(join(BENCH_DELETED_DIR, benchBackupName(slug, at)));
          if (registeredSlugs().has(slug)) continue; // 扫的这会儿刚登记上（新台第一次用时才建文件）：不是孤儿，留着
          await removeBenchStore(slug);
          out.orphan_stores++;
        } catch (e) { console.error(`[bench-sweep] 没登记的库 ${slug} 没清掉：${(e as Error)?.message ?? e}`); }
      }
    }
    // 2. 过期的备份
    if (existsSync(BENCH_DELETED_DIR)) {
      for (const f of readdirSync(BENCH_DELETED_DIR)) {
        const m = BENCH_BACKUP_NAME_RE.exec(f);
        if (!m || at - Number(m[2]) < BENCH_BACKUP_KEEP_MS) continue;
        try { rmSync(join(BENCH_DELETED_DIR, f), { force: true }); out.expired_backups++; } catch { /* 下次再清 */ }
      }
    }
    // 3. Redis 里卡片已经不在的台的键
    out.redis_keys = await (this.ctx.get('state') as unknown as StateLayerService).sweepBenches(liveCardIds());
    return out;
  }
}
