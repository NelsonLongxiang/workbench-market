#!/usr/bin/env node
/**
 * 渐进开放第 0 步（docs/productization/16-progressive-capability-access.md）：从审计表 mcp_calls 数各工具最近 N 天的调用，定常驻集用。
 *
 * 只读：库文件以只读方式打开，不写、不建表、不迁移；可以对着正在运行的实例的库跑（SQLite 只读连接不挡写）。
 * 只输出聚合数字：工具名、方法名、渠道和计数。不输出会话名、席位、参数、参数摘要、错误原文、令牌摘要——
 * 会话只按「命名会话 / 席位换来的会话」两类计数。输出可以原样贴进公开仓库的报告。
 *
 *   node scripts/mcp-usage-report.mjs --db <库文件> [--days 30] [--json <输出文件>]
 *   node scripts/mcp-usage-report.mjs --self-test     用合成库自测（接进 CI）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argOf = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };

/** 席位换来的会话名以 seat- 开头（services/seat-tokens.ts），其余是管理员建的命名会话 */
const kindOf = (name) => (String(name).startsWith('seat-') ? 'seat' : 'named');
/** SQLite 的 datetime('now') 写法「YYYY-MM-DD HH:MM:SS」（UTC）；比较时按同样的写法给下限 */
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function report(dbPath, { days = 30, now = Date.now() } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('mcp_calls')").all().map((r) => r.name));
    if (!cols.has('tool')) throw new Error('这个库里没有 mcp_calls 表（或者列不对）');
    const hasChannel = cols.has('channel');
    const since = sqlTime(now - days * 86_400_000);
    const rows = db.prepare(`SELECT session_name AS s, method AS m, tool AS t, ok, duration_ms AS d, ${hasChannel ? 'channel' : "'mcp'"} AS c, substr(at, 1, 10) AS day FROM mcp_calls WHERE at >= ?`).all(since);
    const first = db.prepare('SELECT min(at) AS a FROM mcp_calls').get()?.a ?? null;

    const methods = {};
    const tools = new Map();
    const sessions = new Map();
    const daysSeen = new Set();
    for (const r of rows) {
      daysSeen.add(r.day);
      methods[r.m] = (methods[r.m] ?? 0) + 1;
      const sk = sessions.get(r.s) ?? { kind: kindOf(r.s), calls: 0, tools: new Set() };
      sk.calls++;
      if (r.m === 'tools/call' && r.t) sk.tools.add(r.t);
      sessions.set(r.s, sk);
      if (r.m !== 'tools/call' || !r.t) continue;
      const t = tools.get(r.t) ?? { calls: 0, failed: 0, sessions: new Set(), days: new Set(), by_channel: {}, by_kind: { named: 0, seat: 0 }, ms: [] };
      t.calls++;
      if (!r.ok) t.failed++;
      t.sessions.add(r.s);
      t.days.add(r.day);
      t.by_channel[r.c] = (t.by_channel[r.c] ?? 0) + 1;
      t.by_kind[kindOf(r.s)]++;
      t.ms.push(Number(r.d) || 0);
      tools.set(r.t, t);
    }
    const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const totalCalls = [...tools.values()].reduce((n, t) => n + t.calls, 0);
    const toolRows = [...tools.entries()].map(([name, t]) => ({
      tool: name, calls: t.calls, share: totalCalls ? Number((t.calls / totalCalls).toFixed(4)) : 0, failed: t.failed,
      sessions: t.sessions.size, active_days: t.days.size, by_channel: t.by_channel, by_kind: t.by_kind, median_ms: median(t.ms),
    })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
    let cum = 0;
    for (const r of toolRows) { cum += r.calls; r.cumulative_share = totalCalls ? Number((cum / totalCalls).toFixed(4)) : 0; }

    const perSession = [...sessions.values()];
    const hist = {};
    for (const s of perSession) { const k = String(s.tools.size); hist[k] = (hist[k] ?? 0) + 1; }

    // 授予面：每个工具被多少个未吊销的命名会话授予（只数，不列会话）
    let granted = null;
    try {
      const g = new Map();
      for (const r of db.prepare("SELECT grants FROM mcp_sessions WHERE revoked_at = ''").all()) {
        let list = []; try { list = JSON.parse(r.grants || '[]'); } catch { list = []; }
        for (const x of new Set(list.filter((v) => typeof v === 'string').map((v) => v.replace(/@.*$/, '')))) g.set(x, (g.get(x) ?? 0) + 1);
      }
      granted = Object.fromEntries([...g.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    } catch { granted = null; }

    return {
      window_days: days, since_utc: since, earliest_record_utc: first, days_with_calls: daysSeen.size,
      totals: { requests: rows.length, tool_calls: totalCalls, sessions: perSession.length, named_sessions: perSession.filter((s) => s.kind === 'named').length, seat_sessions: perSession.filter((s) => s.kind === 'seat').length },
      methods,
      tools: toolRows,
      distinct_tools_per_session: hist,
      granted_sessions_per_tool: granted,
    };
  } finally { db.close(); }
}

function table(r) {
  const out = [`窗口 ${r.window_days} 天（自 ${r.since_utc} UTC；库里最早一条 ${r.earliest_record_utc ?? '无'}），有调用的天数 ${r.days_with_calls}`,
    `请求 ${r.totals.requests}，其中工具调用 ${r.totals.tool_calls}；会话 ${r.totals.sessions}（命名 ${r.totals.named_sessions}、席位 ${r.totals.seat_sessions}）`,
    `方法：${Object.entries(r.methods).map(([k, v]) => `${k} ${v}`).join('，')}`, '',
    '| 工具 | 调用 | 占比 | 累计 | 失败 | 会话数 | 活跃天 | 渠道 |', '|---|---|---|---|---|---|---|---|'];
  for (const t of r.tools) out.push(`| ${t.tool} | ${t.calls} | ${(t.share * 100).toFixed(1)}% | ${(t.cumulative_share * 100).toFixed(1)}% | ${t.failed} | ${t.sessions} | ${t.active_days} | ${Object.entries(t.by_channel).map(([k, v]) => `${k} ${v}`).join(' / ')} |`);
  return out.join('\n');
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-usage-'));
  const file = join(dir, 'wm.db');
  try {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE mcp_calls (id INTEGER PRIMARY KEY, at TEXT, session_name TEXT, method TEXT, tool TEXT DEFAULT '', ok INTEGER DEFAULT 1, error TEXT DEFAULT '', duration_ms INTEGER DEFAULT 0, args_sha256 TEXT DEFAULT '', channel TEXT DEFAULT 'mcp');
      CREATE TABLE mcp_sessions (id INTEGER PRIMARY KEY, name TEXT, token_sha256 TEXT, grants TEXT, revoked_at TEXT DEFAULT '');`);
    const now = Date.parse('2026-11-20T00:00:00Z');
    const ins = db.prepare('INSERT INTO mcp_calls (at, session_name, method, tool, ok, channel, args_sha256, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const at = (d) => sqlTime(now - d * 86_400_000);
    ins.run(at(1), 'secret-session-a', 'tools/call', 'workbench_list', 1, 'mcp', 'deadbeef', '');
    ins.run(at(2), 'secret-session-a', 'tools/call', 'workbench_list', 0, 'rest', 'deadbeef', 'private error text');
    ins.run(at(3), 'seat-zzz', 'tools/call', 'skill_read', 1, 'mcp', '', '');
    ins.run(at(3), 'seat-zzz', 'tools/list', '', 1, 'mcp', '', '');
    ins.run(at(40), 'secret-session-a', 'tools/call', 'old_tool', 1, 'mcp', '', '');
    db.prepare("INSERT INTO mcp_sessions (name, token_sha256, grants) VALUES ('secret-session-a', 'x', ?)").run(JSON.stringify(['workbench_list', 'workbench_vars_get@3']));
    db.close();
    const r = report(file, { days: 30, now });
    const text = JSON.stringify(r);
    const checks = [
      ['只数窗口内的：old_tool 不在', !r.tools.some((t) => t.tool === 'old_tool')],
      ['workbench_list 两次、失败一次、两个渠道各一次', r.tools[0].tool === 'workbench_list' && r.tools[0].calls === 2 && r.tools[0].failed === 1 && r.tools[0].by_channel.rest === 1],
      ['会话按两类计数', r.totals.named_sessions === 1 && r.totals.seat_sessions === 1],
      ['输出里没有会话名、参数摘要、错误原文', !/secret-session|seat-zzz|deadbeef|private error/.test(text)],
      ['授予面按工具数，去掉 @台', r.granted_sessions_per_tool.workbench_list === 1 && r.granted_sessions_per_tool.workbench_vars_get === 1],
      ['只读：报告之后库没变', new DatabaseSync(file, { readOnly: true }).prepare('SELECT count(*) AS n FROM mcp_calls').get().n === 5],
    ];
    let fail = 0;
    for (const [label, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) fail++; }
    console.log(`mcp-usage-report: ${checks.length - fail} 过 / ${fail} 败`);
    return fail ? 1 : 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv.includes('--self-test')) process.exit(selfTest());
const dbPath = argOf('--db');
if (!dbPath) { console.error('用法：node scripts/mcp-usage-report.mjs --db <库文件> [--days 30] [--json <输出文件>]'); process.exit(2); }
const days = Number(argOf('--days') ?? 30);
if (!Number.isInteger(days) || days < 1 || days > 365) { console.error('--days 要是 1～365 的整数'); process.exit(2); }
const r = report(dbPath, { days });
console.log(table(r));
const jsonOut = argOf('--json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(r, null, 2));
