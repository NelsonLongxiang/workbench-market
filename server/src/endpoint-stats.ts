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

const UPSERT = db.prepare('INSERT INTO endpoint_stats (endpoint, day, hits) VALUES (?, ?, ?) ON CONFLICT(endpoint, day) DO UPDATE SET hits = hits + excluded.hits');
function flushRows(rows: [string, string, number][]) {
  for (const [endpoint, day, hits] of rows) UPSERT.run(endpoint, day, hits);
}

/** 内存累计 + 5s 批量落库：避免每命中同步写放大（token-smoke 直连读库曾撞 database is locked） */
const pending = new Map<string, number>();
let flushTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  if (pending.size === 0) return;
  const rows: [string, string, number][] = [];
  for (const [key, hits] of pending) {
    const i = key.lastIndexOf('|');
    rows.push([key.slice(0, i), key.slice(i + 1), hits]);
  }
  pending.clear();
  try { flushRows(rows); } catch { /* 落库失败丢本批，不阻塞业务 */ }
}, 5_000);
flushTimer.unref?.();

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
    // 入口即取路径：门户 /go/:id/* 的 pathRewrite 会把 req.url 改成上游路径（#39）
    const url = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    next();
    res.on('finish', () => {
      try {
        // 只计命中业务路由且非 404 的请求：任意路径的 404 与远程收口 403 不入库，键空间不随外部输入无界增长（#39）
        if (!req.route || res.statusCode === 404) return;
        if (!url.startsWith('/api/') && url !== '/tasks') return;
        if (url === '/api/stats') return; // 自身不计
        const key = `${normalizeEndpoint(url)}|${new Date().toISOString().slice(0, 10)}`;
        pending.set(key, (pending.get(key) ?? 0) + 1);
      } catch { /* 计数失败不影响业务 */ }
    });
  };
}

export function statsPayload(): { endpoints: { endpoint: string; total: number; by_day: Record<string, number> }[]; generated_at: string } {
  if (pending.size > 0) { // 读前冲刷，视图不滞后于在途计数
    const rows2: [string, string, number][] = [];
    for (const [key, hits] of pending) { const i = key.lastIndexOf('|'); rows2.push([key.slice(0, i), key.slice(i + 1), hits]); }
    pending.clear();
    try { flushRows(rows2); } catch { /* 忽略 */ }
  }
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
