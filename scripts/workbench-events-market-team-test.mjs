#!/usr/bin/env node
/**
 * 工作台事件出站的 caller_session 用 MARKET_TEAM（不写死 market/）。
 * 两个隔离进程：MARKET_TEAM 不设（缺省 market）与设成非缺省的 mkt-lab；各建一条 app-data 事件和一条任务中心事件，
 * 投递行的 caller_session 必须是「<MARKET_TEAM>/<该台的 node8>」。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const CHILD = `
const { db } = await import('./src/db.ts');
const ev = await import('./src/workbench-events.ts');
ev.initWorkbenchEvents();
db.prepare("INSERT INTO apps (slug, title, kind, status) VALUES ('evt-app', 'evt-app', 'app', 'published')").run();
db.prepare("INSERT OR IGNORE INTO apps (slug, title, kind, status) VALUES ('task-center', 'task-center', 'sop', 'published')").run();
for (const [type, slug] of [['app', 'evt-app'], ['sop', 'task-center']]) db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url) VALUES (?, ?, 'dsh/aaaa1111', 'notify', 'read', 'http://peer.invalid')").run(type, slug);
ev.recordAppDataEvent({ slug: 'evt-app', id: 1, data: { a: 1 }, json: '{"a":1}', createdBy: 'someone', createdAt: '2026-11-12T00:00:00Z' });
let tc = '';
try { tc = ev.recordTaskCenterEvent({ id: 7, data: {}, stepValue: () => '', publishedBy: 'human:alice', templateVersion: 1, materialSha256: 'x'.repeat(64), agentDispatch: false, centerOn: false }); } catch (e) { tc = 'ERR ' + e.message; }
const node8 = (slug) => db.prepare('SELECT a2a_node8 FROM apps WHERE slug = ?').get(slug).a2a_node8;
const rows = db.prepare('SELECT e.source, d.caller_session FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id ORDER BY d.id').all();
console.log(JSON.stringify({ rows, app8: node8('evt-app'), tc8: node8('task-center'), tc }));
`;
function run(team) {
  const dir = resolve(`tmp/wbe-market-team-${team ?? 'default'}`);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const env = { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' };
  if (team === undefined) delete env.MARKET_TEAM; else env.MARKET_TEAM = team;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', CHILD], { cwd: 'server', env, encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { err: r.stdout + r.stderr }; }
}
for (const [label, team, want] of [['缺省', undefined, 'market'], ['非缺省', 'mkt-lab', 'mkt-lab']]) {
  const o = run(team);
  const app = o.rows?.find((x) => x.source === 'app-data');
  const tc = o.rows?.find((x) => x.source === 'task-center');
  ok(`${label}（MARKET_TEAM=${team ?? '不设'}）：app-data 投递的 caller_session = ${want}/<台的 node8>`, app?.caller_session === `${want}/${o.app8}`, JSON.stringify(o).slice(0, 300));
  ok(`${label}：任务中心投递的 caller_session = ${want}/<任务中心的 node8>`, tc?.caller_session === `${want}/${o.tc8}`, JSON.stringify(o).slice(0, 300));
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
