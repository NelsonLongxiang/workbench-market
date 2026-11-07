#!/usr/bin/env node
/** 技能迁移 POST /api/skills/:slug/migrate-layerfs 冒烟（独立实例 + LayerFS 替身 + 合成技能，直接往合成库插登记行）：
 *  带 0 字节文件（scripts/__init__.py）的技能照常迁移，读回摘要与登记一致才记 commit_id；重跑幂等；
 *  快照读出的摘要与登记不符 → 留档不迁；服务读回丢了空文件 → 不记 commit_id、可重跑；空快照 → 异常。 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = resolve('tmp/skill-migrate-smoke-' + Date.now().toString(36));
const DATA = join(TMP, 'data');
mkdirSync(DATA, { recursive: true });

/** 与 server/src/services/skill.ts SkillService.filesDigest 同算法（字节序排序、路径\0内容 sha256\0） */
function digest(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path); h.update('\0');
    h.update(createHash('sha256').update(Buffer.from(f.content, 'utf8')).digest('hex')); h.update('\0');
  }
  return h.digest('hex');
}

// ---- LayerFS 替身：publish 存文件集；commits/<id>/files 读回（dropEmpty 模拟服务丢掉空文件） ----
const TOKEN = 'skill-migrate-lfs';
const commits = new Map();
const published = [];
let dropEmpty = false;
const lfs = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = (code, b) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/healthz') return json(200, { ok: true });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
  const pm = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(req.url ?? '');
  if (req.method === 'POST' && pm) {
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

// ---- 合成快照 ----
const SKILL = [
  { path: 'SKILL.md', content: '---\nname: zero-byte-demo\n---\n合成技能\n' },
  { path: 'scripts/__init__.py', content: '' },
  { path: 'scripts/run.py', content: 'print("ok")\n' },
];
function snapshot(rel, files) {
  const dir = join(DATA, 'skill-snapshots', rel);
  for (const f of files) { mkdirSync(join(dir, f.path, '..'), { recursive: true }); writeFileSync(join(dir, f.path), f.bytes ?? f.content); }
  if (!files.length) mkdirSync(dir, { recursive: true });
  return `skill-snapshots/${rel}`; // 登记的是相对 DATA_DIR 的路径
}

const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, ADMIN_TOKEN: 'skill-migrate-admin', REDIS_URL: '',
  LAYERFS_SERVICE_URL: `http://127.0.0.1:${lfs.address().port}`, LAYERFS_SERVICE_TOKEN: TOKEN };
for (const k of ['LAYERFS_SERVICE_TOKEN_FILE', 'WM_EXTENSIONS_DIR', 'WM_ODOO_URL', 'LC_ODOO_URL']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const migrate = async (slug) => { const r = await fetch(`${base}/api/skills/${slug}/migrate-layerfs`, { method: 'POST', headers: { 'X-Admin-Token': 'skill-migrate-admin', 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, j: await r.json().catch(() => null) }; };

try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready ' + serverErr.slice(-300)); await sleep(250); }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(DATA, 'workbench-market.db'));
  const addSkill = (slug, files, registered = digest(files)) => {
    const id = db.prepare("INSERT INTO skills (slug, name, layer, layer_name, source) VALUES (?, ?, 1, '合成', 'synthetic')").run(slug, slug).lastInsertRowid;
    db.prepare('INSERT INTO skill_versions (skill_id, version, tree_digest, file_count, total_bytes, snapshot_path) VALUES (?, 1, ?, ?, ?, ?)')
      .run(id, registered, files.length, files.reduce((n, f) => n + Buffer.byteLength(f.content), 0), snapshot(`${slug}/v1`, files));
  };
  addSkill('zero-byte-demo', SKILL);
  addSkill('digest-drift', SKILL, digest([...SKILL, { path: 'extra.txt', content: 'x' }]));
  addSkill('readback-loses-empty', SKILL);
  addSkill('empty-snapshot', [], digest([]));
  addSkill('has-binary', [...SKILL, { path: 'assets/logo.png', content: '', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]) }]);
  const row = (slug) => db.prepare('SELECT v.commit_id, v.shadow_status, v.shadow_error FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.slug = ?').get(slug);

  let r = await migrate('zero-byte-demo');
  const m = r.j?.results?.[0];
  ok('带 0 字节文件的技能：迁移成功', r.status === 200 && m?.result === 'migrated' && m.readback_digest_match === true, JSON.stringify(r.j));
  const sent = published.at(-1);
  ok('0 字节文件原样交给 LayerFS（同路径、空内容）', sent?.branch === 'skill/zero-byte-demo' && sent.files.some((f) => f.path === 'scripts/__init__.py' && f.content === '') && sent.files.length === 3, JSON.stringify(sent?.files?.map((f) => [f.path, f.content.length])));
  ok('读回摘要与登记一致才记 commit_id', row('zero-byte-demo').commit_id === m?.commit_id && row('zero-byte-demo').shadow_status === 'succeeded');
  const before = published.length;
  r = await migrate('zero-byte-demo');
  ok('重跑幂等：跳过、不再发布', r.j?.results?.[0]?.result === 'skip' && published.length === before, JSON.stringify(r.j));

  r = await migrate('digest-drift');
  ok('快照读出的摘要与登记不符：留档不迁、不发布', r.j?.results?.[0]?.result === 'anomaly' && published.length === before && row('digest-drift').commit_id === '', JSON.stringify(r.j));

  dropEmpty = true;
  r = await migrate('readback-loses-empty');
  dropEmpty = false;
  ok('服务读回丢了空文件：不记 commit_id、标失败可重跑', r.j?.results?.[0]?.result === 'error' && row('readback-loses-empty').commit_id === '' && /readback digest mismatch/.test(row('readback-loses-empty').shadow_error), JSON.stringify(r.j));
  ok('孤立的 commit 记进 shadow_error 便于核对', row('readback-loses-empty').shadow_error.includes(`orphan commit ${r.j?.results?.[0]?.commit_id_unrecorded}`) && !!r.j?.results?.[0]?.commit_id_unrecorded, row('readback-loses-empty').shadow_error);
  r = await migrate('readback-loses-empty');
  ok('服务恢复后重跑：迁移成功', r.j?.results?.[0]?.result === 'migrated' && row('readback-loses-empty').commit_id !== '', JSON.stringify(r.j));

  const beforeBin = published.length;
  r = await migrate('has-binary');
  ok('含二进制文件：点名留档不迁、不发布', r.j?.results?.[0]?.result === 'anomaly' && /assets\/logo\.png/.test(r.j.results[0].reason) && published.length === beforeBin && row('has-binary').commit_id === '', JSON.stringify(r.j));
  r = await migrate('empty-snapshot');
  ok('空快照：异常留档', r.j?.results?.[0]?.result === 'anomaly' && row('empty-snapshot').commit_id === '', JSON.stringify(r.j));
  db.close();
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  server.kill(); lfs.close(); await sleep(300); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nskill-migrate-layerfs-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
