#!/usr/bin/env node
/**
 * 升级冒烟：拿「基线版本」（缺省是线上的发布分支）的库，直接换成本检出的代码启动，看会发生什么。全部是合成数据。
 *
 *   1. 用基线的代码在临时目录起一个实例，经它自己的接口建凭据库，再用它自己的库模块灌一份有代表性的合成数据，停掉。
 *   2. 用本检出的代码指向同一个数据目录启动两次：
 *      · 能起来、启动自检全过；原有数据读得出来（总览、事件、凭据库）；
 *      · 表结构只加不改（不删表、不删列、不改列）；
 *      · 幂等：第二次启动后表结构逐字节相同、各表行数相同；
 *      · 回填：事项数等于事件数，第二次启动「补建 0 个」。
 *   3. 回滚：再用基线的代码指向升级后的数据目录启动——自检全过，读、写（新建工作台、台数据提交、开录入）、凭据库都正常。
 *   4. 再上线：本检出的代码再启动一次，自检全过。
 *
 * 只在本机回环地址上起实例；HOME、DSH_HOME、YGL_HOME 都指到临时目录；不访问任何外部系统。
 *
 *   node scripts/upgrade-smoke.mjs                         基线取 origin/release/prod-hotfix-1（本地没有就先 fetch）
 *   node scripts/upgrade-smoke.mjs --base <git 引用>        换一个基线（标签、分支、提交都行）
 *   node scripts/upgrade-smoke.mjs --head <目录>            要验的代码换成另一个目录（缺省本检出；那个目录要装好依赖）
 *   node scripts/upgrade-smoke.mjs --keep                  跑完保留临时目录（排查用）
 *
 * 退出码：0 全过；1 有检查不过；2 准备阶段出错（取不到基线、装不上依赖）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const BASE_REF = opt('--base') ?? 'origin/release/prod-hotfix-1';
const KEEP = argv.includes('--keep');
const HEAD = resolve(opt('--head') ?? ROOT);
const OUT = join(ROOT, 'tmp', `upgrade-smoke-${process.pid}-${Date.now().toString(36)}`);
const ADMIN = 'upgrade-smoke-synthetic-admin';
const VAULT_PASSWORD = 'Upgrade-Smoke-Synthetic-Master-Passphrase-2026!';

let pass = 0, fail = 0;
const servers = [];
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
// 出错退出时也别留下孤儿实例
process.on('exit', () => { for (const s of servers) if (s?.child && s.child.exitCode === null) s.child.kill('SIGKILL'); });
const die = (msg) => { console.error(`[upgrade-smoke] ${msg}`); cleanup(); process.exit(2); };
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });

// ---------- 准备：基线代码 ----------
function resolveBase() {
  let r = git('rev-parse', '--verify', `${BASE_REF}^{commit}`);
  if (r.status !== 0 && BASE_REF.startsWith('origin/')) {
    git('fetch', '--no-tags', '--depth=1', 'origin', `${BASE_REF.slice('origin/'.length)}:refs/remotes/${BASE_REF}`);
    r = git('rev-parse', '--verify', `${BASE_REF}^{commit}`);
  }
  if (r.status !== 0) die(`取不到基线 ${BASE_REF}`);
  return r.stdout.trim();
}
function extractBase(sha, dir) {
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync('git', ['archive', '--format=tar', sha], { cwd: ROOT, maxBuffer: 1 << 30 });
  if (tar.status !== 0) die(`git archive ${sha} 失败`);
  const x = spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout });
  if (x.status !== 0) die('解包基线失败');
  const same = (f) => existsSync(join(dir, f)) && existsSync(join(ROOT, f)) && readFileSync(join(dir, f), 'utf8') === readFileSync(join(ROOT, f), 'utf8');
  if (['pnpm-lock.yaml', 'package.json', 'server/package.json', 'web/package.json'].every(same)) {
    for (const d of ['node_modules', 'server/node_modules', 'web/node_modules']) if (existsSync(join(ROOT, d))) symlinkSync(join(ROOT, d), join(dir, d));
    return 'shared';
  }
  const inst = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  if (inst.status !== 0) die(`基线的依赖装不上：${(inst.stderr || inst.stdout).slice(-400)}`);
  return 'installed';
}

// ---------- 实例 ----------
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const sandboxEnv = (extra) => ({
  PATH: process.env.PATH, HOME: join(OUT, 'home'), DSH_HOME: join(OUT, 'home', '.dsh'), YGL_HOME: join(OUT, 'home', '.ygl'), TMPDIR: join(OUT, 'tmp'),
  ADMIN_TOKEN: ADMIN, ...extra,
});
async function startServer(tree, data, label) {
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(tree, 'server'), env: sandboxEnv({ PORT: String(port), DATA_DIR: data }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) return { ok: false, label, log, base, child, ms: Date.now() - t0 };
    // 自检没过时 /api/health 一直是 503（入口关着）；自检跑完了（at 有值）就算起来了，过没过由后面的检查判
    try { const r = await fetch(`${base}/api/health`); if (r.status === 200) break; if (r.status === 503 && (await r.json().catch(() => null))?.self_probe?.at) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 180_000) { child.kill('SIGKILL'); return { ok: false, label, log, base, child, ms: Date.now() - t0 }; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: true, label, log: () => log, base, child, ms: Date.now() - t0 };
}
async function stopServer(s) {
  if (!s?.child || s.child.exitCode !== null) return;
  s.child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(() => { s.child.kill('SIGKILL'); r(); }, 8000); s.child.once('exit', () => { clearTimeout(t); r(); }); });
}
const H = { 'x-admin-token': ADMIN, 'sec-fetch-site': 'same-origin' };
async function call(base, method, path, body, headers = H) {
  const r = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
  return { status: r.status, body: json };
}
const selfProbe = async (base) => (await call(base, 'GET', '/api/health')).body?.self_probe ?? null;

// ---------- 库的读法 ----------
function schemaOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const cols = Object.fromEntries(tables.map((t) => [t, db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => ({ name: c.name, decl: `${c.type}|${c.notnull}|${c.dflt_value}|${c.pk}` }))]));
    const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const counts = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
    return { tables, cols, objects: JSON.stringify(objects), counts };
  } finally { db.close(); }
}

// ---------- 合成数据（用基线自己的库模块写；只写基线库里存在的列，换基线也能跑） ----------
const SEED = (baseTree) => `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const at = (p) => ${JSON.stringify(pathToFileURL(baseTree).href)} + '/' + p;
const { db } = await import(at('server/src/db.ts'));
try { (await import(at('server/src/workbench-events.ts'))).initWorkbenchEvents?.(); } catch { /* 基线没有就算了 */ }
const DATA = process.env.DATA_DIR;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cols = new Map();
const has = (t) => { if (!cols.has(t)) cols.set(t, new Set(db.prepare('PRAGMA table_info("' + t + '")').all().map((c) => c.name))); return cols.get(t).size > 0; };
let written = 0;
const ins = (t, row) => { if (!has(t)) return null; const c = cols.get(t); const ks = Object.keys(row).filter((k) => c.has(k)); const r = db.prepare('INSERT INTO "' + t + '" (' + ks.map((k) => '"' + k + '"').join(', ') + ') VALUES (' + ks.map(() => '?').join(', ') + ')').run(...ks.map((k) => row[k])); written++; return Number(r.lastInsertRowid); };
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const wb = [];
for (let i = 1; i <= 8; i++) wb.push(ins('workbenches', { name: '合成台' + i, url: 'http://127.0.0.1:' + (18000 + i) + '/', type: 'web', category: '合成', tags: '["syn"]', enabled: 1, health_path: '/', sort: i }));
ins('cockpits', { name: '合成驾驶舱', description: 'upgrade-smoke', layout_config: JSON.stringify({ panels: wb.slice(0, 2).map((id, i) => ({ i: String(id), workbenchId: id, x: i * 6, y: 0, w: 6, h: 4 })) }) });
for (const [slug, kind] of [['syn-form', 'app'], ['syn-board', 'app'], ['syn-intake', 'sop']]) {
  const id = ins('apps', { slug, title: '合成 ' + slug, description: 'upgrade-smoke', created_by: 'mcp:synthetic', active_version: 1, status: 'published', kind, source_repo: 'example/synthetic', source_path: slug, a2a_node8: randomBytes(4).toString('hex') });
  ins('app_versions', { app_id: id, version: 1, file_count: 1, total_bytes: 64, created_by: 'mcp:synthetic', changelog: '合成', source_commit: randomBytes(20).toString('hex') });
  const dir = join(DATA, 'apps', slug, 'v1'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>' + slug + '</title></head><body>synthetic</body></html>\\n');
  ins('workbenches', { name: '合成 ' + slug, url: (kind === 'sop' ? '/sop/' : '/apps/') + slug + '/', type: 'market-app', enabled: 1, sort: 50 });
}
for (let i = 0; i < 20; i++) ins('app_data', { app_slug: 'syn-form', data: JSON.stringify({ n: i }), created_by: '填表人' + (i % 4), idempotency_key: i % 5 === 0 ? 'idem-' + i : '' });
ins('bindings', { target_type: 'app', target_slug: 'syn-form', agent_node: 'syn/1a2b3c4d', direction: 'notify', mode: 'read', notify_url: 'http://127.0.0.1:9/notify', created_by: 'mcp:synthetic' });
for (let i = 1; i <= 3; i++) {
  const sid = ins('skills', { slug: 'syn-skill-' + i, name: '合成技能' + i, layer: 1, layer_name: '基础', description: 'upgrade-smoke', author: 'synthetic', source: 'upload', active_version: 1 });
  const snap = join(DATA, 'skills', 'syn-skill-' + i, 'v1'); mkdirSync(snap, { recursive: true }); writeFileSync(join(snap, 'SKILL.md'), '# synthetic\\n');
  ins('skill_versions', { skill_id: sid, version: 1, changelog: '合成', tree_digest: sha('s' + i), file_count: 1, total_bytes: 12, snapshot_path: snap, reviewed_by: 'synthetic' });
}
const runs = [];
for (let i = 0; i < 12; i++) runs.push(ins('sop_runs', { sop_slug: i % 3 ? 'task-center' : 'syn-intake', sop_version: 1, status: i % 4 ? 'finished' : 'running', started_by: '提单人' + (i % 3), data: JSON.stringify({ intake: { title: '合成需求 ' + i } }), upload_token: randomBytes(32).toString('hex') }));
const tasks = [];
for (let i = 0; i < 8; i++) { const t = ins('tasks', { title: '合成任务 ' + i, kind: '录入', payload_json: '{}', status: i % 4 === 3 ? 'withdrawn' : 'published', material_sha256: sha('t' + i), published_at: now(), published_by: '发布人' + (i % 2), enabled: 1, agent_dispatch_enabled: i % 2, created_by: 'human:发布人' + (i % 2), intake_run_id: runs[i], template_version: 1 }); tasks.push(t); ins('task_events', { task_id: t, type: 'published', actor: 'human:发布人' + (i % 2), actor_kind: 'human', payload_json: '{}' }); }
const log = (eid, did, action, detail = {}) => ins('workbench_event_log', { event_id: eid, delivery_id: did, actor: 'market', action, detail: JSON.stringify(detail) });
const states = ['held', 'pending', 'sent', 'accept', 'ask', 'decline', 'dead', 'cancelled'];
let events = 0;
for (let i = 0; i < 24; i++) {
  const eid = 'wbe-' + randomBytes(8).toString('hex'); const app = i % 4 === 3; events++;
  ins('workbench_events', { event_id: eid, source: app ? 'app-data' : 'task-center', workbench: app ? 'syn-form' : 'syn-intake', item: app ? 'item:' + i : 'task:' + tasks[i % tasks.length], context_id: 'ctx-' + i, submitter_kind: app ? 'unverified' : 'human', submitter: app ? '填表人' + (i % 4) : 'human:发布人' + (i % 2), form_version: app ? null : 1, data_sha256: sha('e' + i), dispatch: app ? 0 : 1, routed: i === 0 ? 'unrouted' : 'target' });
  log(eid, null, 'recorded', { source: app ? 'app-data' : 'task-center', routed: 'target', submitter_kind: app ? 'unverified' : 'human', targets: 1 });
  if (i === 0) continue;
  const st = states[i % states.length]; const decided = ['accept', 'ask', 'decline'].includes(st);
  const did = ins('workbench_event_deliveries', { event_id: eid, target_team: 'syn/1a2b3c4d', target_url: 'http://127.0.0.1:9/notify', caller_session: 'market/synthetic', status: decided ? 'sent' : st, message: st === 'pending' || st === 'held' ? '{}' : '', attempts: st === 'dead' ? 8 : 1, reply_token_sha256: app ? '' : sha('r' + i), decision: decided ? st : '', decision_reason: st === 'ask' ? '要哪个店铺？' : '', decided_by: decided ? 'syn-receiver' : '', decided_at: decided ? now() : '', sent_at: decided || st === 'sent' ? now() : '' });
  log(eid, did, st === 'held' ? 'held' : 'queued', { target_team: 'syn/1a2b3c4d' });
  if (decided || st === 'sent') log(eid, did, 'sent');
  if (st === 'dead') log(eid, did, 'dead', { error: 'synthetic' });
  if (st === 'cancelled') log(eid, did, 'cancelled', { reason: 'task withdrawn' });
  if (decided) log(eid, did, 'decision:' + st, { reason: st === 'ask' ? '要哪个店铺？' : '', ref: '' });
}
for (const [slug, status] of [['syn-form', 'pending'], ['syn-board', 'approved']]) ins('change_requests', { kind: 'app', slug, op: 'rollback', target_version: 1, reason: '合成', source: 'mcp', requested_by: 'mcp:synthetic', status });
const sess = [1, 2, 3].map((i) => ins('mcp_sessions', { name: 'syn-session-' + i, token_sha256: sha('tok' + i), grants: JSON.stringify(i === 1 ? ['workbench_list'] : []) }));
ins('mcp_access_requests', { session_id: sess[0], tools: '["app_sync"]', reason: '合成', status: 'pending' });
const board = ins('workbenches', { name: '看板', url: '/owner-pending', type: 'web', enabled: 1 });
for (const [key, kind, value, by] of [['config.owner', 'const', { owner_login: 'boss' }, 'odoo:boss'], ['item.1', 'var', { no: 1, question: '合成问题' }, 'mcp:writer'], ['answer.1', 'const', { summary: '答了' }, 'odoo:boss']]) {
  ins('workbench_vars', { workbench_id: board, key, kind, value: JSON.stringify(value), revision: 1, updated_by: by, owner: kind === 'const' ? by : '' });
  ins('workbench_var_audit', { workbench_id: board, key, action: 'create', actor: by, kind, old_revision: 0, new_revision: 1, new_sha256: sha(JSON.stringify(value)) });
}
console.log('SEEDED ' + JSON.stringify({ rows: written, events }));
`;

function cleanup() { if (!KEEP) rmSync(OUT, { recursive: true, force: true }); }

// ---------- 主流程 ----------
rmSync(OUT, { recursive: true, force: true });
for (const d of ['home', 'tmp', 'data']) mkdirSync(join(OUT, d), { recursive: true });
const baseSha = resolveBase();
const baseTree = join(OUT, 'base');
const deps = extractBase(baseSha, baseTree);
console.log(`[upgrade-smoke] 基线 ${BASE_REF} = ${baseSha.slice(0, 10)}（依赖：${deps === 'shared' ? '与本检出相同，共用' : '另装'}）→ ${HEAD === ROOT ? `本检出 ${(git('rev-parse', '--short', 'HEAD').stdout || '').trim()}` : HEAD}`);
const DATA = join(OUT, 'data');
const DB = join(DATA, 'workbench-market.db');
const report = {};
try {
  // 1. 基线：建库、建凭据库、灌数据、再起一次确认
  let s = await startServer(baseTree, DATA, 'base-1'); servers.push(s);
  if (!s.ok) die(`基线在空目录上起不来：${String(typeof s.log === 'function' ? s.log() : s.log).slice(-600)}`);
  const unlock = await call(s.base, 'POST', '/api/vault/unlock', { password: VAULT_PASSWORD });
  let vaultEntries = 0;
  if (unlock.status === 200) for (let i = 1; i <= 2; i++) if ((await call(s.base, 'POST', '/api/vault/entries', { title: `合成条目${i}`, username: `syn-${i}`, password: `syn-pass-${i}-not-real`, url: `https://example.invalid/${i}` })).status < 300) vaultEntries++;
  await stopServer(s);
  const seedFile = join(OUT, 'seed.mjs'); writeFileSync(seedFile, SEED(baseTree));
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', seedFile], { cwd: baseTree, env: sandboxEnv({ DATA_DIR: DATA }), encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seeded.stdout || '');
  if (!m) die(`灌合成数据失败：${(seeded.stderr || '').slice(-800)}`);
  report.seed = JSON.parse(m[1]);
  s = await startServer(baseTree, DATA, 'base-2'); servers.push(s);
  check(s.ok && (await selfProbe(s.base))?.passed === true, '基线在灌好数据的库上照常启动，自检全过');
  const baseEvents = (await call(s.base, 'GET', '/api/workbench-events?limit=200')).body;
  await stopServer(s);
  const before = schemaOf(DB);

  // 2. 本检出：启动两次
  s = await startServer(HEAD, DATA, 'head-1'); servers.push(s);
  check(s.ok, `本检出的代码在基线的库上能启动（${s.ms} ms）`, s.ok ? '' : String(s.log).slice(-600));
  if (!s.ok) throw new Error('本检出起不来，后面的检查没法做');
  const probe1 = await selfProbe(s.base);
  check(probe1?.passed === true, `启动自检全过（${probe1?.rows?.length ?? 0} 行）`, JSON.stringify(probe1?.failed ?? null));
  const summary = await call(s.base, 'GET', '/api/summary');
  check(summary.status === 200 && summary.body?.total === before.counts.workbenches, `原有工作台都读得出来（${summary.body?.total}）`, JSON.stringify(summary.body).slice(0, 120));
  const evs = await call(s.base, 'GET', '/api/workbench-events?limit=200');
  check(evs.status === 200 && Array.isArray(evs.body) && evs.body.length === report.seed.events && Array.isArray(baseEvents) && evs.body.length === baseEvents.length, `原有工作台事件都读得出来（${Array.isArray(evs.body) ? evs.body.length : evs.status}）`);
  if (vaultEntries) {
    const v = await call(s.base, 'POST', '/api/vault/unlock', { password: VAULT_PASSWORD });
    check(v.status === 200 && v.body?.count === vaultEntries, `凭据库照原主密码解得开，条目数不变（${v.body?.count}）`, JSON.stringify(v.body).slice(0, 120));
  }
  const backfill1 = /回填：核对 (\d+) 个事件，补建 (\d+) 个事项/.exec(s.log());
  await stopServer(s);
  const after1 = schemaOf(DB);
  const droppedTables = before.tables.filter((t) => !after1.tables.includes(t));
  const changedCols = [];
  for (const t of before.tables) for (const c of before.cols[t]) { const now = after1.cols[t]?.find((x) => x.name === c.name); if (!now) changedCols.push(`${t}.${c.name} 被删`); else if (now.decl !== c.decl) changedCols.push(`${t}.${c.name}：${c.decl} → ${now.decl}`); }
  check(droppedTables.length === 0 && changedCols.length === 0, `表结构只加不改（新增 ${after1.tables.length - before.tables.length} 张表）`, [...droppedTables.map((t) => `删了表 ${t}`), ...changedCols].join('；'));
  const lostRows = before.tables.filter((t) => (after1.counts[t] ?? 0) < before.counts[t]);
  check(lostRows.length === 0, '原有各表的行数没有变少', lostRows.map((t) => `${t} ${before.counts[t]} → ${after1.counts[t]}`).join('；'));
  if ('work_items' in after1.counts) {
    // 日志那一行只作佐证（写法以后可能改），判据是表里的数
    check(after1.counts.work_items === before.counts.workbench_events && (!backfill1 || Number(backfill1[2]) === before.counts.workbench_events),
      `回填：每个事件建出一个事项（${after1.counts.work_items} / ${before.counts.workbench_events}）`, backfill1 ? backfill1[0] : '');
  }
  s = await startServer(HEAD, DATA, 'head-2'); servers.push(s);
  const probe2 = await selfProbe(s.base);
  const backfill2 = /回填：核对 (\d+) 个事件，补建 (\d+) 个事项/.exec(s.log());
  await stopServer(s);
  const after2 = schemaOf(DB);
  check(s.ok && probe2?.passed === true, '第二次启动：照常起来，自检全过');
  check(after2.objects === after1.objects, '幂等：第二次启动后表结构逐字节相同');
  const countDiff = Object.keys(after2.counts).filter((t) => after2.counts[t] !== after1.counts[t]);
  check(countDiff.length === 0, '幂等：第二次启动后各表行数相同', countDiff.map((t) => `${t} ${after1.counts[t]} → ${after2.counts[t]}`).join('；'));
  if (backfill2) check(Number(backfill2[2]) === 0, '幂等：第二次启动回填补建 0 个', backfill2[0]);
  report.head = { new_tables: after1.tables.filter((t) => !before.tables.includes(t)), self_probe_rows: probe1?.rows?.length ?? 0, boot_ms: servers.filter((x) => x.label.startsWith('head')).map((x) => x.ms) };

  // 3. 回滚到基线
  s = await startServer(baseTree, DATA, 'rollback'); servers.push(s);
  check(s.ok && (await selfProbe(s.base))?.passed === true, '回滚：基线的代码在升级后的库上照常启动，自检全过', s.ok ? '' : String(s.log).slice(-600));
  if (s.ok) {
    const rs = await call(s.base, 'GET', '/api/summary');
    check(rs.status === 200 && rs.body?.total === before.counts.workbenches, '回滚：原有数据读得出来');
    const w = await call(s.base, 'POST', '/api/workbenches', { name: '回滚后新建', url: 'http://127.0.0.1:18555/', type: 'web' });
    const d = await call(s.base, 'POST', '/api/apps/syn-form/data', { data: { after: 'rollback' } }, { 'sec-fetch-site': 'same-origin' });
    const r = await call(s.base, 'POST', '/api/sop/runs', { slug: 'task-center', started_by: 'upgrade-smoke' }, { 'sec-fetch-site': 'same-origin' });
    check(w.status === 201 && d.status === 201 && r.status === 201, `回滚：照常能写（新建工作台 ${w.status}、台数据 ${d.status}、开录入 ${r.status}）`);
    if (vaultEntries) { const v = await call(s.base, 'POST', '/api/vault/unlock', { password: VAULT_PASSWORD }); check(v.status === 200 && v.body?.count === vaultEntries, '回滚：凭据库照常解得开'); }
  }
  await stopServer(s);

  // 4. 再上线
  s = await startServer(HEAD, DATA, 'reforward'); servers.push(s);
  check(s.ok && (await selfProbe(s.base))?.passed === true, '再上线：本检出的代码再启动，自检全过');
  await stopServer(s);
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const s of servers) await stopServer(s);
}
const line = `${pass} 通过 / ${fail} 失败`;
console.log(`\n[upgrade-smoke] ${JSON.stringify(report)}\n${line}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 升级冒烟\n\n基线 \`${BASE_REF}\`（${baseSha.slice(0, 10)}）→ 本检出：${line}\n`);
cleanup();
process.exit(fail ? 1 : 0);
