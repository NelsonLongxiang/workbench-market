/**
 * 判定并行比对的记账（阶段六 6c）。只在开关打开时有人写（judgment-compare.ts）。
 *   · 记账攒批：先放在内存里，应答之后过一小会儿（FLUSH_MS）在一个事务里写进单独的库文件（db.ts 的 judgmentCompareDb），
 *     不和业务库抢锁；写失败只计数（writeFailures），丢掉这一批，不影响请求。读报告之前先把攒着的写掉。
 *   · judgment_tally：每条路由每种结果一行计数。结果：agree 一致、mismatch 不一致、uncertain 不确定（400/409/422 这类、5xx）、
 *     skip-404 404 不判、unregistered 没报动作不比、not-verdict 路由声明了状态码不代表授权、integrity-blocked 被完整性门拦下、
 *     error 判定出错（只计数，不影响请求）、overflow 不一致的种类满了。
 *   · judgment_enforced：切换开关打开的域里，新判定在路由处理之前拒掉的请求（旧守卫没跑，不比），按路由模式、身份类别、结论、规则计数。
 *   · judgment_mismatches：不一致按「路由模式、身份类别、两边结论、命中规则」合并计数，最多 MAX_KINDS 种；
 *     留一个主体标识和一条授予做样例，不记请求体、查询串、凭据和路径里的 id。
 */
import { Service } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { judgmentCompareDb } from '../db.ts';

export const MAX_KINDS = 1000;
const FLUSH_MS = 200;
const QUEUE_MAX = 10_000;
export type Outcome = 'agree' | 'mismatch' | 'uncertain' | 'skip-404' | 'unregistered' | 'not-verdict' | 'integrity-blocked' | 'error' | 'overflow';
export type Mismatch = { route: string; action: string; actorKind: string; old: string; new: string; rule: string; status: number; principal: string; grant: number | null };
export type Enforced = { route: string; action: string; actorKind: string; verdict: 'deny' | 'ask'; rule: string };
type Entry = { kind: 'tally'; route: string; action: string; outcome: Outcome } | { kind: 'mismatch'; m: Mismatch; at: number } | { kind: 'enforced'; e: Enforced };

export class JudgmentCompareService extends Service {
  private queue: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeFailures = 0;
  private dropped = 0;

  constructor(ctx: any) {
    super(ctx, 'judgmentCompare');
    // 模块卸载时把攒着的写掉、停掉计时器
    ctx.effect(() => () => { if (this.timer) clearTimeout(this.timer); this.timer = null; this.flush(); }, 'judgmentCompare.flush');
  }

  private push(e: Entry): void {
    if (this.queue.length >= QUEUE_MAX) { this.dropped++; return; }
    this.queue.push(e);
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS); this.timer.unref?.(); }
  }

  tally(route: string, action: string, outcome: Outcome): void { this.push({ kind: 'tally', route, action, outcome }); }
  mismatch(m: Mismatch, now = Date.now()): void { this.push({ kind: 'mismatch', m, at: now }); }
  /** 切换开关拒掉的一次（旧守卫没跑） */
  enforced(e: Enforced): void { this.push({ kind: 'enforced', e }); }

  /** 把攒着的一批在一个事务里写掉；写失败只计数 */
  flush(): void {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    let db;
    try { db = judgmentCompareDb(); } catch { this.writeFailures += batch.length; return; }
    try {
      db.exec('BEGIN IMMEDIATE');
      const tally = db.prepare('INSERT INTO judgment_tally (route, action, outcome, count) VALUES (?, ?, ?, 1) ON CONFLICT (route, outcome) DO UPDATE SET count = count + 1');
      const bump = db.prepare('UPDATE judgment_mismatches SET count = count + 1, last_at = ? WHERE key = ?');
      const kinds = db.prepare('SELECT COUNT(*) AS n FROM judgment_mismatches');
      const enforced = db.prepare('INSERT INTO judgment_enforced (route, action, actor_kind, verdict, rule, count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (route, actor_kind, verdict, rule) DO UPDATE SET count = count + 1');
      const insert = db.prepare('INSERT INTO judgment_mismatches (key, route, domain, action, actor_kind, old, new, rule, status, principal_sample, grant_sample, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
      for (const e of batch) {
        if (e.kind === 'tally') { tally.run(e.route, e.action, e.outcome); continue; }
        if (e.kind === 'enforced') { enforced.run(e.e.route, e.e.action, e.e.actorKind, e.e.verdict, e.e.rule); continue; }
        const m = e.m;
        const key = createHash('sha256').update([m.route, m.actorKind, m.old, m.new, m.rule].join('\u0000')).digest('hex').slice(0, 32);
        if (bump.run(e.at, key).changes) { tally.run(m.route, m.action, 'mismatch'); continue; }
        if ((kinds.get() as { n: number }).n >= MAX_KINDS) { tally.run('(overflow)', '', 'overflow'); continue; }
        insert.run(key, m.route, m.action.split('.')[0] ?? '', m.action, m.actorKind, m.old, m.new, m.rule, m.status, m.principal.slice(0, 160), m.grant, e.at, e.at);
        tally.run(m.route, m.action, 'mismatch');
      }
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
      this.writeFailures += batch.length;
    }
  }

  report(): { tally: { route: string; action: string; outcome: Outcome; count: number }[]; mismatches: Record<string, unknown>[]; enforced: Record<string, unknown>[]; writeFailures: number; dropped: number } {
    this.flush();
    let db;
    try { db = judgmentCompareDb(); } catch { return { tally: [], mismatches: [], enforced: [], writeFailures: this.writeFailures, dropped: this.dropped }; }
    return {
      tally: db.prepare('SELECT route, action, outcome, count FROM judgment_tally ORDER BY route, outcome').all() as { route: string; action: string; outcome: Outcome; count: number }[],
      mismatches: db.prepare('SELECT route, domain, action, actor_kind, old, new, rule, status, principal_sample, grant_sample, count FROM judgment_mismatches ORDER BY count DESC, route').all() as Record<string, unknown>[],
      enforced: db.prepare('SELECT route, action, actor_kind, verdict, rule, count FROM judgment_enforced ORDER BY count DESC, route').all() as Record<string, unknown>[],
      writeFailures: this.writeFailures,
      dropped: this.dropped,
    };
  }
}
