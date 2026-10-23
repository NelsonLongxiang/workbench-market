/**
 * 端点命中计数（总工程师 B 类单 direct-10eba7cb · ops-patterns 第一式：采纳监测）。
 *
 * 设计（零业务侵入 K2）：
 * - 一个 app.use 中间件在 res.finish 时按「规范化端点」计数（路径参数折叠为 :id）
 * - SQLite 表 endpoint_stats(endpoint, day, hits)，主键 (endpoint, day)——跨重启持久（K1）
 * - 本模块自持存储（同 a2a.ts 模块自有边界先例）；index.ts 不出现 db.prepare
 * - GET /api/stats 只读暴露 per-endpoint 总量 + 按日分桶（K3）
 */
import type express from 'express';
import { db } from './db.ts';

db.exec(`CREATE TABLE IF NOT EXISTS endpoint_stats (
  endpoint TEXT NOT NULL,
  day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (endpoint, day)
)`);

const INSERT = db.prepare('INSERT INTO endpoint_stats (endpoint, day, hits) VALUES (?, ?, 1) ON CONFLICT(endpoint, day) DO UPDATE SET hits = hits + 1');

/** 路径规范化：数字段折叠为 :id（/api/sop/runs/42 → /api/sop/runs/:id） */
export function normalizeEndpoint(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}

/** 计数中间件：只记 GET/POST 等业务请求，跳过静态资源与 stats 自身（防自增噪声） */
export function endpointStatsMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    next();
    res.on('finish', () => {
      try {
        const url = String(req.url ?? '').split('?')[0];
        if (!url.startsWith('/api/') && url !== '/tasks') return;
        if (url === '/api/stats') return; // 自身不计
        INSERT.run(normalizeEndpoint(url), new Date().toISOString().slice(0, 10));
      } catch { /* 计数失败不影响业务 */ }
    });
  };
}

export function statsPayload(): { endpoints: { endpoint: string; total: number; by_day: Record<string, number> }[]; generated_at: string } {
  const rows = db.prepare('SELECT endpoint, day, hits FROM endpoint_stats ORDER BY endpoint, day').all() as { endpoint: string; day: string; hits: number }[];
  const map = new Map<string, { endpoint: string; total: number; by_day: Record<string, number> }>();
  for (const r of rows) {
    let e = map.get(r.endpoint);
    if (!e) { e = { endpoint: r.endpoint, total: 0, by_day: {} }; map.set(r.endpoint, e); }
    e.total += r.hits;
    e.by_day[r.day] = (e.by_day[r.day] ?? 0) + r.hits;
  }
  return { endpoints: [...map.values()], generated_at: new Date().toISOString() };
}
