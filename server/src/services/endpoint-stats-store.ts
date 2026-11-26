/** 端点命中计数的存取（表 endpoint_stats 在 db.ts 建）。计数口径、内存累计与批量冲刷在 server/src/endpoint-stats.ts */
import { db } from '../db.ts';

const UPSERT = db.prepare('INSERT INTO endpoint_stats (endpoint, day, hits) VALUES (?, ?, ?) ON CONFLICT(endpoint, day) DO UPDATE SET hits = hits + excluded.hits');

/** 把一批 [端点, 日期, 次数] 累加进去 */
export function addEndpointHits(rows: [string, string, number][]): void {
  for (const [endpoint, day, hits] of rows) UPSERT.run(endpoint, day, hits);
}

/** 全部计数行，按端点、日期排 */
export function endpointHitRows(): { endpoint: string; day: string; hits: number }[] {
  return db.prepare('SELECT endpoint, day, hits FROM endpoint_stats ORDER BY endpoint, day').all() as { endpoint: string; day: string; hits: number }[];
}
