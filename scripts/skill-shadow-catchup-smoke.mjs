#!/usr/bin/env node
/** 技能影子补推冒烟（server/src/skill-shadow.ts；独立实例 + LayerFS 替身 + 合成技能，直接往合成库插登记行，模拟导入器写的版本）：
 *  一、LayerFS 起来时就不通：启动不受影响；几轮下来每轮最多撞一次，日志只打一行「连不上」，不打 [P1-shadow]；撞到的那版记 failed
 *  二、LayerFS 恢复：当前版本推上去、读回摘要一致才记 succeeded（日志一行「恢复」）；旧版本、回滚后不是当前的版本不推；
 *      含二进制的记 skipped、不推；摘要与登记不符的记 failed、写明原因、不推；遗产登记（legacy）不碰
 *  三、读回不一致：记 failed，下一轮重试，服务正常后变 succeeded
 *  四、整库重建：当前版本 commit_id 和 succeeded 同时写上（不等重启）；旧版本 commit_id 清掉、状态回到 pending；skipped 不动
 *  定时器随根上下文停：见 scripts/timers-unload-test.mjs。 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = resolve('tmp/skill-shadow-smoke-' + Date.now().toString(36));
const DATA = join(TMP, 'data');
mkdirSync(DATA, { recursive: true });
const EVERY = 800;

/** 与 SkillService.filesDigest 同算法 */
function digest(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path); h.update('\0');
    h.update(createHash('sha256').update(f.bytes ?? Buffer.from(f.content, 'utf8')).digest('hex')); h.update('\0');
  }
  return h.digest('hex');
}

// ---- LayerFS 替身：down 时发布回 503；dropEmpty 时读回丢掉空文件 ----
const TOKEN = 'skill-shadow-lfs';
const commits = new Map();
const published = [];
let down = true, dropEmpty = false, publishAttempts = 0, deletes = 0;
const lfs = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = (code, b) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/healthz') return json(200, { ok: true });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
  if (req.method === 'DELETE' && /^\/v1\/projects\/[^/]+$/.test(req.url ?? '')) { deletes++; return json(200, { ok: true }); }
  const pm = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(req.url ?? '');
  if (req.method === 'POST' && pm) {
    publishAttempts++;
    if (down) return json(503, { error: 'down' });
    const files = JSON.parse(body || '{}').files ?? [];
    const id = 'c' + randomBytes(6).toString('hex');
    commits.set(id, files); published.push({ branch: decodeURIComponent(pm[2]), files });
    return json(200, { commit_id: id, changed: true });
  }
  const cm = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(req.url ?? '');
  if (req.method === 'GET' && cm) {
    const files = commits.get(cm[3]);
    if (!files) return json(404, { error: 'no such commit' });
    return json(200, { files: dropEmpty ? files.filter((f) => f.content !== '') : files });
  }
  json(200, { ok: true });
});
await new Promise((r) => lfs.listen(0, '127.0.0.1', r));

const T = (name, v) => [{ path: 'SKILL.md', content: `---\nname: ${name}\n---\n合成技能 v${v}\n` }];
function snapshot(rel, files) {
  const dir = join(DATA, 'skill-snapshots', rel);
  for (const f of files) { mkdirSync(join(dir, f.path, '..'), { recursive: true }); writeFileSync(join(dir, f.path), f.bytes ?? f.content); }
  return `skill-snapshots/${rel}`;
}

const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN = 'skill-shadow-admin';
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, REDIS_URL: '',
  LAYERFS_SERVICE_URL: `http://127.0.0.1:${lfs.address().port}`, LAYERFS_SERVICE_TOKEN: TOKEN, WM_SKILL_SHADOW_EVERY_MS: String(EVERY), WM_SKILL_SHADOW_BATCH: '10' };
for (const k of ['LAYERFS_SERVICE_TOKEN_FILE', 'WM_EXTENSIONS_DIR', 'WM_ODOO_URL', 'LC_ODOO_URL']) delete env[k];
const t0 = Date.now();
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let log = ''; server.stderr.on('data', (c) => (log += c)); server.stdout.on('data', (c) => (log += c));
const lines = (re) => log.split('\n').filter((l) => re.test(l));
const admin = async (method, path) => { const r = await fetch(base + path, { method, headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, j: await r.json().catch(() => null) }; };

try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready ' + log.slice(-1500)); await sleep(200); }
  ok('一 LayerFS 不通也照常启动（health 可读）', Date.now() - t0 < 40_000, `${Date.now() - t0}ms`);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 });
  const skill = (slug, legacy = 0) => Number(db.prepare("INSERT INTO skills (slug, name, layer, layer_name, source, legacy) VALUES (?, ?, 5, '合成', 'agents-skills', ?)").run(slug, slug, legacy).lastInsertRowid);
  const version = (id, slug, v, files, registered = digest(files)) => db.prepare("INSERT INTO skill_versions (skill_id, version, tree_digest, file_count, total_bytes, snapshot_path, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, 'importer')")
    .run(id, v, registered, files.length, 1, files.length ? snapshot(`${slug}/v${v}`, files) : '');
  const a = skill('agents:imp-a'); version(a, 'agents:imp-a', 1, T('imp-a', 1)); version(a, 'agents:imp-a', 2, T('imp-a', 2));
  const bin = skill('agents:imp-bin'); version(bin, 'agents:imp-bin', 1, [...T('imp-bin', 1), { path: 'logo.png', bytes: Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00]) }]);
  const drift = skill('agents:imp-drift'); version(drift, 'agents:imp-drift', 1, T('imp-drift', 1), digest(T('imp-drift', 9)));
  const leg = skill('jf:legacy-one', 1); version(leg, 'jf:legacy-one', 1, [], '');
  const rolled = skill('agents:imp-rolled'); version(rolled, 'agents:imp-rolled', 1, T('imp-rolled', 1)); version(rolled, 'agents:imp-rolled', 2, T('imp-rolled', 2));
  db.prepare('UPDATE skills SET active_version = 1 WHERE id = ?').run(rolled);
  const empty = skill('agents:imp-empty'); version(empty, 'agents:imp-empty', 1, [...T('imp-empty', 1), { path: 'pkg/__init__.py', content: '' }]);
  const row = (slug, v) => db.prepare('SELECT v.commit_id, v.shadow_status, v.shadow_error FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.slug = ? AND v.version = ?').get(slug, v);

  // 一、不通：等 5 轮
  const attempts0 = publishAttempts;
  await sleep(EVERY * 5 + 300);
  const rounds = 6; // 最多可能跑到的轮数（含插行前那一轮）
  ok('一 不通时每轮最多撞一次（推到第一个失败就停）', publishAttempts - attempts0 >= 2 && publishAttempts - attempts0 <= rounds, `撞了 ${publishAttempts - attempts0} 次`);
  ok('一 日志只打一行「连不上」', lines(/\[skill-shadow\].*连不上/).length === 1, lines(/\[skill-shadow\]/).join(' | '));
  ok('一 不打 [P1-shadow]（补推走安静模式）', lines(/\[P1-shadow\]/).length === 0, lines(/\[P1-shadow\]/).slice(0, 3).join(' | '));
  ok('一 撞到的那版记 failed', row('agents:imp-a', 2).shadow_status === 'failed' && row('agents:imp-a', 2).commit_id === '', JSON.stringify(row('agents:imp-a', 2)));
  ok('一 不通时没有一版被记成 succeeded', db.prepare("SELECT COUNT(*) AS n FROM skill_versions WHERE shadow_status = 'succeeded'").get().n === 0);

  // 二、恢复
  down = false;
  dropEmpty = true; // 三：imp-empty 读回会丢空文件
  const until = async (cond, ms = EVERY * 12) => { const e = Date.now() + ms; while (Date.now() < e) { if (cond()) return true; await sleep(100); } return cond(); };
  await until(() => row('agents:imp-a', 2).shadow_status === 'succeeded' && row('agents:imp-rolled', 1).shadow_status === 'succeeded' && row('agents:imp-empty', 1).shadow_status === 'failed');
  const a2 = row('agents:imp-a', 2);
  ok('二 当前版本推上去、读回一致：commit_id 和 succeeded', a2.shadow_status === 'succeeded' && /^c[0-9a-f]{12}$/.test(a2.commit_id) && published.some((p) => p.branch === 'skill/agents:imp-a' && p.files[0]?.content?.includes('v2')), JSON.stringify(a2));
  ok('二 日志一行「恢复」', lines(/\[skill-shadow\] LayerFS 恢复/).length === 1, lines(/\[skill-shadow\]/).join(' | '));
  ok('二 旧版本不推（只推当前版本）', row('agents:imp-a', 1).shadow_status === 'pending' && row('agents:imp-a', 1).commit_id === '' && !published.some((p) => p.files[0]?.content?.includes('imp-a\n---\n合成技能 v1')), JSON.stringify(row('agents:imp-a', 1)));
  ok('二 回滚过的技能推回滚到的那版，最新版不推', row('agents:imp-rolled', 1).shadow_status === 'succeeded' && row('agents:imp-rolled', 2).shadow_status === 'pending', JSON.stringify([row('agents:imp-rolled', 1), row('agents:imp-rolled', 2)]));
  ok('二 含二进制：记 skipped、不推', row('agents:imp-bin', 1).shadow_status === 'skipped' && /logo\.png/.test(row('agents:imp-bin', 1).shadow_error) && !published.some((p) => p.branch === 'skill/agents:imp-bin'), JSON.stringify(row('agents:imp-bin', 1)));
  ok('二 摘要与登记不符：记 failed、写明原因、不推', row('agents:imp-drift', 1).shadow_status === 'failed' && /摘要与登记不符/.test(row('agents:imp-drift', 1).shadow_error) && !published.some((p) => p.branch === 'skill/agents:imp-drift'), JSON.stringify(row('agents:imp-drift', 1)));
  ok('二 遗产登记（legacy）不碰', row('jf:legacy-one', 1).shadow_status === 'pending' && row('jf:legacy-one', 1).shadow_error === '', JSON.stringify(row('jf:legacy-one', 1)));

  // 三、读回不一致 → failed，下一轮重试
  const e1 = row('agents:imp-empty', 1);
  ok('三 读回不一致：记 failed、不记 commit_id', e1.shadow_status === 'failed' && e1.commit_id === '' && /readback digest mismatch/.test(e1.shadow_error), JSON.stringify(e1));
  dropEmpty = false;
  await until(() => row('agents:imp-empty', 1).shadow_status === 'succeeded');
  ok('三 服务正常后下一轮重试成功', row('agents:imp-empty', 1).shadow_status === 'succeeded' && row('agents:imp-empty', 1).commit_id !== '', JSON.stringify(row('agents:imp-empty', 1)));

  // 四、整库重建：先让 imp-a 的旧版本也有 commit（手动 migrate-layerfs 会推所有版本）
  let r = await admin('POST', '/api/skills/agents:imp-a/migrate-layerfs');
  ok('四 准备：migrate-layerfs 应答形状照旧（旧版 migrated、当前版 skip，没有多出的字段）', r.status === 200 && r.j?.results?.[0]?.result === 'migrated' && r.j.results[1]?.result === 'skip' && r.j.results.every((x) => !('kind' in x) && !('unreachable' in x)), JSON.stringify(r.j));
  const oldCommit = row('agents:imp-a', 2).commit_id;
  ok('四 准备：旧版本也是 succeeded', row('agents:imp-a', 1).shadow_status === 'succeeded');
  r = await admin('POST', '/api/admin/rebuild-wm-skills');
  ok('四 重建跑完', r.status === 200 && r.j?.ok === true && deletes >= 1, JSON.stringify(r.j));
  const ra2 = row('agents:imp-a', 2), ra1 = row('agents:imp-a', 1);
  ok('四 当前版本：新 commit_id 和 succeeded 同时写上（不等重启）', ra2.shadow_status === 'succeeded' && ra2.commit_id !== '' && ra2.commit_id !== oldCommit, JSON.stringify(ra2));
  ok('四 旧版本：commit_id 清掉、状态回到 pending', ra1.commit_id === '' && ra1.shadow_status === 'pending' && ra1.shadow_error === '', JSON.stringify(ra1));
  ok('四 skipped 不动', row('agents:imp-bin', 1).shadow_status === 'skipped' && /logo\.png/.test(row('agents:imp-bin', 1).shadow_error), JSON.stringify(row('agents:imp-bin', 1)));
  ok('四 succeeded 的行都有 commit_id（没有「succeeded 但 commit_id 空」）', db.prepare("SELECT COUNT(*) AS n FROM skill_versions WHERE shadow_status = 'succeeded' AND commit_id = ''").get().n === 0);
  db.close();
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  server.kill(); lfs.close(); await sleep(300); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nskill-shadow-catchup-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
