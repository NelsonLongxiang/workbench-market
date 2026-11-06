#!/usr/bin/env node
/** 工作台市场技能包自带的校验/安装脚本（市场打包时原样放进每个技能包，文件名 .wm-skill-verify.mjs；只依赖 Node 内置模块）。
 *
 *  校验：node .wm-skill-verify.mjs [--dir <技能目录>] [--expect <tree_digest>]
 *        按同目录 .wm-skill.json 的清单逐文件比 sha256，列出新增/缺失/被改的文件，并重算整版指纹；一致 rc=0，不一致 rc=1。
 *  安装：node .wm-skill-verify.mjs --install --expect <tree_digest> [--root <技能根目录>]
 *        在解压出的包目录里运行。--expect 必填，取 MCP skill_download 应答里的 tree_digest：包里的清单可能随包一起被换掉，
 *        只有应答里的值能证明包是市场发的。先校验包本身（清单指纹 ≠ --expect、或文件与清单不一致 rc=2，什么都不动），再把已装的旧版本移进
 *        <root>/.backups/<目录名>/（每个技能最多留 3 个），最后整体换上新版本。root 缺省 ~/.workbench-market/skills。
 *  输出都是一行 JSON。 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const META = '.wm-skill.json';
const SELF = '.wm-skill-verify.mjs';
const KEEP_BACKUPS = 3;

const sha = (b) => createHash('sha256').update(b).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function walk(root) {
  const out = [];
  (function go(d, rel) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), r = rel + e.name;
      if (e.isDirectory()) go(p, r + '/');
      // 符号链接、硬链接、设备文件等一律拒绝整包（不是跳过）：清单里只会有普通文件
      else if (!e.isFile()) out.push({ path: r, bytes: null, reject: e.isSymbolicLink() ? 'symlink' : 'not-regular-file' });
      else if (lstatSync(p).nlink > 1) out.push({ path: r, bytes: null, reject: 'hardlink' });
      else if (r !== META && r !== SELF) out.push({ path: r, bytes: readFileSync(p) });
    }
  })(root, '');
  return out.sort((a, b) => cmp(a.path, b.path));
}

/** 与市场 tree_digest 同一算法：按路径字节序排序，逐个喂「路径 \0 文件sha256 \0」 */
function treeDigest(files) {
  const h = createHash('sha256');
  for (const f of files) { if (!f.bytes) continue; h.update(f.path); h.update('\0'); h.update(sha(f.bytes)); h.update('\0'); }
  return h.digest('hex');
}

function verify(dir) {
  let meta;
  try { meta = JSON.parse(readFileSync(join(dir, META), 'utf8')); } catch { return { ok: false, dir, error: `读不到 ${META}` }; }
  const want = new Map((meta.files ?? []).map((f) => [f.path, f.sha256]));
  const have = walk(dir);
  // 清单里的路径也要合规：绝对路径、反斜杠、空 / . / .. 段一律拒绝
  const rejected = [...want.keys()].filter((p) => typeof p !== 'string' || !p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\') || p.split('/').some((g) => g === '' || g === '.' || g === '..')).map((p) => ({ path: String(p), reason: 'manifest-path' }));
  rejected.push(...have.filter((f) => f.reject).map((f) => ({ path: f.path, reason: f.reject })));
  const seen = new Set();
  const added = [], modified = [];
  for (const f of have) {
    seen.add(f.path);
    if (!f.bytes || !want.has(f.path)) added.push(f.path);
    else if (want.get(f.path) !== sha(f.bytes)) modified.push(f.path);
  }
  const missing = [...want.keys()].filter((p) => !seen.has(p)).sort(cmp);
  const actual = treeDigest(have);
  const ok = rejected.length === 0 && added.length === 0 && modified.length === 0 && missing.length === 0 && actual === meta.tree_digest;
  return { ok, dir, slug: meta.slug, version: meta.version, tree_digest: meta.tree_digest, actual_digest: actual, rejected, added, missing, modified };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function install(src, root, expect) {
  if (!/^[0-9a-f]{64}$/.test(String(expect ?? ''))) return { rc: 2, out: { ok: false, step: 'verify-package', error: '--install 必须带 --expect <tree_digest>（取 MCP skill_download 应答里的值）', note: '未做任何改动' } };
  const pkg = verify(src);
  if (pkg.tree_digest !== expect) return { rc: 2, out: { ok: false, step: 'verify-package', ...pkg, expected: expect, note: '包里清单的指纹与市场应答不符（包可能被整体替换），未做任何改动' } };
  if (!pkg.ok) return { rc: 2, out: { ok: false, step: 'verify-package', ...pkg, note: '包与清单不一致，未做任何改动' } };
  const meta = JSON.parse(readFileSync(join(src, META), 'utf8'));
  const name = String(meta.dir ?? '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return { rc: 2, out: { ok: false, step: 'verify-package', error: `目录名非法: ${name}` } };
  // tree_digest 不覆盖清单里的 dir：装到哪儿以包目录名为准（install_command 按应答的 package_dir 运行脚本），两者不一致就拒
  if (name !== basename(src)) return { rc: 2, out: { ok: false, step: 'verify-package', error: `清单目录名 ${name} 与包目录名 ${basename(src)} 不一致`, note: '未做任何改动' } };
  mkdirSync(root, { recursive: true });
  const target = join(root, name);
  const result = { ok: true, slug: meta.slug, version: meta.version, tree_digest: meta.tree_digest, installed_to: target, previous: null, backup: null, pruned: [] };
  if (existsSync(target)) {
    const old = verify(target);
    result.previous = { version: old.version ?? null, intact: old.ok, added: old.added ?? [], missing: old.missing ?? [], modified: old.modified ?? [] };
    if (old.ok && old.tree_digest === meta.tree_digest) return { rc: 0, out: { ...result, unchanged: true, note: '已是这个版本且未被改动，未重装' } };
  }
  // 先把新版本复制到同一目录下的临时位置（同一文件系统，后面的改名才是原子的）
  const incoming = join(root, `.${name}.incoming-${randomBytes(4).toString('hex')}`);
  cpSync(src, incoming, { recursive: true });
  const backups = join(root, '.backups', name);
  let moved = null;
  try {
    if (existsSync(target)) {
      mkdirSync(backups, { recursive: true });
      moved = join(backups, `v${result.previous?.version ?? 'unknown'}-${stamp()}-${randomBytes(2).toString('hex')}`);
      renameSync(target, moved);
      result.backup = moved;
    }
    renameSync(incoming, target);
  } catch (e) {
    if (moved && !existsSync(target)) { try { renameSync(moved, target); result.backup = null; } catch { /* 留在备份目录 */ } }
    rmSync(incoming, { recursive: true, force: true });
    return { rc: 3, out: { ok: false, step: 'swap', error: String(e?.message ?? e), restored: !!moved && existsSync(target) } };
  }
  if (existsSync(backups)) {
    const all = readdirSync(backups).map((n) => ({ n, t: statSync(join(backups, n)).mtimeMs })).sort((a, b) => b.t - a.t || cmp(b.n, a.n));
    for (const b of all.slice(KEEP_BACKUPS)) { rmSync(join(backups, b.n), { recursive: true, force: true }); result.pruned.push(join(backups, b.n)); }
  }
  return { rc: 0, out: result };
}

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const here = dirname(fileURLToPath(import.meta.url));
if (args.includes('--install')) {
  const { rc, out } = install(here, resolve(opt('--root') ?? join(homedir(), '.workbench-market', 'skills')), opt('--expect'));
  console.log(JSON.stringify(out));
  process.exitCode = rc;
} else {
  const out = verify(resolve(opt('--dir') ?? here));
  const expect = opt('--expect');
  if (expect !== undefined && out.tree_digest !== expect) { out.ok = false; out.expected = expect; }
  console.log(JSON.stringify(out));
  process.exitCode = out.ok ? 0 : 1;
}
