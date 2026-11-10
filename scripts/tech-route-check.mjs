#!/usr/bin/env node
/**
 * 路线体检：把技术路线上的每条约定量成数字，对照仓库根 tech-route.json 里的基线。
 * 只读、零依赖。档位是 count 的检查只报告；budget 超过基线、redline 超过目标，退出码才是 1。
 * 第一批全部是 count，不拦任何 PR。约定本身见仓库根的 CONTRIBUTING.md。
 *
 *   node scripts/tech-route-check.mjs               打印体检表（CI 里同时写进摘要页）
 *   node scripts/tech-route-check.mjs --json        机器可读
 *   node scripts/tech-route-check.mjs --selftest    每个检查先红后绿：干净样本必为 0，违规样本必被数到
 *   node scripts/tech-route-check.mjs --init        按现状写基线（只在建清单或新增检查时用）
 *   node scripts/tech-route-check.mjs --tighten     把变小了的基线收紧（只减不增）
 *   node scripts/tech-route-check.mjs --no-types    跳过类型检查那一项（它要跑一遍 tsc，最慢）
 *   node scripts/tech-route-check.mjs --root DIR    体检另一棵目录树
 *
 * 退出码：0 通过；1 有预算或红线被突破；2 用法或清单错误。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const LIST = 'tech-route.json';
const SKIP_DIRS = new Set(['node_modules', 'data', 'dist', 'tmp']);
const count = (text, re) => (text.match(re) || []).length;
const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);
const sum = (map) => Object.values(map).reduce((a, n) => a + n, 0);
const keep = (map) => Object.fromEntries(Object.entries(map).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)));

/** 一棵目录树的只读视图：路径一律相对仓库根、用正斜杠。 */
function openRepo(root) {
  const cache = new Map();
  const read = (p) => {
    if (!cache.has(p)) { try { cache.set(p, readFileSync(join(root, p), 'utf8')); } catch { cache.set(p, ''); } }
    return cache.get(p);
  };
  const walk = (dir, out = []) => {
    let names;
    try { names = readdirSync(join(root, dir)); } catch { return out; }
    for (const n of names.sort()) {
      if (SKIP_DIRS.has(n) || n.startsWith('.')) continue;
      const p = dir ? `${dir}/${n}` : n;
      if (statSync(join(root, p)).isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const server = () => walk('server/src').filter((f) => f.endsWith('.ts'));
  const perFile = (files, re) => keep(Object.fromEntries(files.map((f) => [f, count(read(f), re)])));
  return { root, read, walk, server, perFile, exists: (p) => existsSync(join(root, p)) };
}

const RE = {
  route: /\b(?:app|router|r|api)\.(?:get|post|put|patch|delete)\(\s*['"`\/\[]/g,
  sql: /\bdb\.(?:prepare|exec)\(/g,
  create: /CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)?\s+[A-Za-z0-9_]+/g,
  alter: /ALTER TABLE\s+[A-Za-z0-9_]+/g,
  env: /\bprocess\.env\.[A-Z0-9_]+/g,
  interval: /\bsetInterval\(/g,
  fetch: /\bfetch\(/g,
  express: /from\s+['"]express['"]/,
  a2a: /from\s+['"]@nelsonlongxiang\/dsh-open-a2a-net[^'"]*['"]/,
  identity: /from\s+['"]\.{1,2}\/(?:[\w-]+\/)*odoo-[\w-]+\.ts['"]/,
  nonErasable: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w|^\s*(?:export\s+)?(?:declare\s+)?namespace\s+\w|constructor\([^)]*\b(?:private|public|protected|readonly)\s+\w/gm,
  readmePath: /(?:^|[^\w./-])((?:scripts|server\/src|web\/src|deploy|docs)\/[\w./-]+\.(?:mjs|cjs|js|ts|tsx|py|sh|md|json|yml))/g,
  testLike: /(?:-|_)(?:test|smoke|mutation)s?\.(?:mjs|js|py|sh)$/,
  runnable: /\.(?:mjs|js|py|sh)$/,
};
const outsideServices = (f) => f !== 'server/src/db.ts' && !f.startsWith('server/src/services/');

/** 调仓库里已有的检查脚本，取它的 JSON 输出；脚本不在就返回 null。 */
function runScript(repo, script, args) {
  const file = join(repo.root, 'scripts', script);
  if (!existsSync(file)) return null;
  const r = spawnSync(process.execPath, [file, ...args], { cwd: repo.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '' };
}

function typecheck(repo) {
  if (flag('--no-types')) return { total: 0, skipped: '按 --no-types 跳过' };
  const tsc = ['web/node_modules/typescript/bin/tsc', 'node_modules/typescript/bin/tsc'].map((p) => join(repo.root, p)).find(existsSync);
  const store = join(repo.root, 'node_modules/.pnpm');
  const nodeTypes = existsSync(store)
    ? readdirSync(store).filter((n) => n.startsWith('@types+node@')).sort().map((n) => join(store, n, 'node_modules/@types')).filter(existsSync).pop()
    : undefined;
  if (!tsc || !nodeTypes) return { total: 0, skipped: '没装依赖（缺 typescript 或 @types/node）' };
  const dir = mkdtempSync(join(tmpdir(), 'tech-route-tsc-'));
  try {
    const config = {
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, allowImportingTsExtensions: true,
        skipLibCheck: true, strict: false, erasableSyntaxOnly: true,
        typeRoots: [nodeTypes, join(repo.root, 'server/node_modules/@types')], types: ['node'],
      },
      include: [join(repo.root, 'server/src/**/*.ts')],
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
    const r = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: repo.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = {};
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
      if (!m) continue;
      const f = relative(repo.root, resolve(repo.root, m[1])).split('\\').join('/');
      files[f] = (files[f] || 0) + 1;
    }
    return { total: sum(files), files: keep(files) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 这次改动了哪些文件（相对 main）。取不到对比基准就返回 null。 */
function changedFiles(repo) {
  for (const range of [['origin/main...HEAD'], ['origin/main', 'HEAD'], ['FETCH_HEAD', 'HEAD']]) {
    const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=AM', ...range], { cwd: repo.root, encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split('\n').filter(Boolean).filter((f) => existsSync(join(repo.root, f)));
  }
  return null;
}

/**
 * 检查项。measure 返回 { total, files?, items?, note?, skipped? }：
 * files 是「文件 → 次数」，items 是一串名字；两者都没有就只比 total。
 * sample 是自检用的两棵最小目录树：clean 必须量出 0，dirty 必须量出 expect。
 */
const RULES = [
  {
    id: 'entry-routes', what: 'index.ts 里的路由数', target: 0, proposed: 'budget',
    measure: (repo) => {
      const text = repo.read('server/src/index.ts');
      const n = count(text, RE.route);
      const all = sum(repo.perFile(repo.server(), RE.route));
      return { total: n, files: n ? { 'server/src/index.ts': n } : {}, note: `index.ts ${lineCount(text)} 行；全部路由 ${all} 条` };
    },
    sample: {
      clean: { 'server/src/index.ts': "import './routes.ts';\n" },
      dirty: { 'server/src/index.ts': "app.get('/api/x', h);\napp.post(\"/api/y\", h);\n" }, expect: 2,
    },
  },
  {
    id: 'sql-outside-services', what: 'services/ 与 db.ts 之外的 SQL 调用点', target: 0, proposed: 'budget',
    measure: (repo) => { const files = repo.perFile(repo.server().filter(outsideServices), RE.sql); return { total: sum(files), files, note: `${Object.keys(files).length} 个文件` }; },
    sample: {
      clean: { 'server/src/db.ts': "db.exec('x');\n", 'server/src/services/a.ts': "db.prepare('SELECT 1');\n" },
      dirty: { 'server/src/foo.ts': "db.prepare('SELECT 1').get();\n" }, expect: 1,
    },
  },
  {
    id: 'schema-only-in-db', what: 'db.ts 之外的建表、改表语句', target: 0, proposed: 'budget',
    measure: (repo) => {
      const outside = repo.server().filter((f) => f !== 'server/src/db.ts');
      const creates = repo.perFile(outside, RE.create), alters = repo.perFile(outside, RE.alter);
      const files = { ...creates };
      for (const [f, n] of Object.entries(alters)) files[f] = (files[f] || 0) + n;
      return { total: sum(files), files: keep(files), note: `${sum(creates)} 张表 + ${sum(alters)} 处改表` };
    },
    sample: {
      clean: { 'server/src/db.ts': 'CREATE TABLE IF NOT EXISTS t (id INTEGER);\n' },
      dirty: { 'server/src/foo.ts': "db.exec('CREATE TABLE IF NOT EXISTS t (id)'); db.exec('ALTER TABLE t ADD COLUMN c');\n" }, expect: 2,
    },
  },
  {
    id: 'tests-registered', what: '不在 CI、也没登记理由的测试脚本', target: 0, proposed: 'budget',
    measure: (repo, list) => {
      const ci = repo.read('.github/workflows/ci.yml');
      const tests = repo.walk('scripts').filter((f) => f.split('/').length === 2 && RE.testLike.test(f)).map((f) => basename(f));
      const inCi = (n) => ci.includes(`scripts/${n}`) || ci.includes(`scripts/${n.replace(/\.[a-z]+$/, '')} `);
      const outside = tests.filter((n) => !inCi(n));
      const packages = ['package.json', 'server/package.json', 'web/package.json'].map(repo.read).join('\n');
      const runnable = repo.walk('scripts').filter((f) => RE.runnable.test(f));
      const hasEntry = (n) => packages.includes(n) || runnable.some((f) => basename(f) !== n && repo.read(f).includes(n));
      const registered = new Set(Object.keys(list?.tests || {}));
      const items = outside.filter((n) => !registered.has(n)).sort();
      return { total: items.length, items, note: `测试类脚本 ${tests.length} 个，${tests.length - outside.length} 个在 CI；不在 CI 的 ${outside.length} 个里 ${outside.filter((n) => !hasEntry(n)).length} 个没有任何执行入口` };
    },
    sample: {
      clean: { 'scripts/a-test.mjs': '', '.github/workflows/ci.yml': 'run: node scripts/a-test.mjs\n' },
      dirty: { 'scripts/b-smoke.mjs': '', '.github/workflows/ci.yml': 'run: node scripts/a-test.mjs\n' }, expect: 1,
    },
  },
  {
    id: 'server-typecheck', what: 'server 的类型错误（宽松模式）', target: 0, proposed: 'budget',
    measure: (repo) => typecheck(repo),
  },
  {
    id: 'readme-tree', what: 'README 没提到的 server 文件', target: 0, proposed: 'budget',
    measure: (repo) => {
      const readme = repo.read('README.md');
      const items = repo.server().filter((f) => !readme.includes(basename(f)) && !readme.includes(`${basename(f, '.ts')}/`));
      return { total: items.length, items, note: `顶层 ${items.filter((f) => f.split('/').length === 3).length} 个` };
    },
    sample: {
      clean: { 'server/src/foo.ts': '', 'README.md': '目录：foo.ts\n' },
      dirty: { 'server/src/foo.ts': '', 'README.md': '目录：bar.ts\n' }, expect: 1,
    },
  },
  {
    id: 'readme-stale-paths', what: 'README 提到但已不存在的文件', target: 0, proposed: 'budget',
    measure: (repo) => {
      const seen = new Set([...repo.read('README.md').matchAll(RE.readmePath)].map((m) => m[1]));
      const items = [...seen].filter((p) => !repo.exists(p)).sort();
      return { total: items.length, items, note: `核对了 ${seen.size} 个路径` };
    },
    sample: {
      clean: { 'README.md': '见 `scripts/a.mjs`。\n', 'scripts/a.mjs': '' },
      dirty: { 'README.md': '见 `scripts/gone.mjs`。\n' }, expect: 1,
    },
  },
  {
    id: 'env-via-config', what: '直接读环境变量的地方', target: 0, proposed: 'budget',
    measure: (repo) => {
      const files = repo.perFile(repo.server(), RE.env);
      const names = new Set(repo.server().flatMap((f) => repo.read(f).match(RE.env) || []));
      return { total: sum(files), files, note: `${names.size} 个变量名，${Object.keys(files).length} 个文件` };
    },
    sample: { clean: { 'server/src/foo.ts': 'const port = config.port;\n' }, dirty: { 'server/src/foo.ts': 'const port = process.env.PORT;\n' }, expect: 1 },
  },
  {
    id: 'timers-in-context', what: '裸的 setInterval', target: 0, proposed: 'budget',
    measure: (repo) => { const files = repo.perFile(repo.server(), RE.interval); return { total: sum(files), files, note: `${Object.keys(files).length} 个文件` }; },
    sample: { clean: { 'server/src/foo.ts': 'ctx.timer.setInterval;\n' }, dirty: { 'server/src/foo.ts': 'setInterval(() => {}, 1000);\n' }, expect: 1 },
  },
  {
    id: 'identity-in-core', what: '核心里直接引用身份具体实现的文件', target: 0, proposed: 'budget',
    measure: (repo) => {
      const items = repo.server().filter((f) => !basename(f).startsWith('odoo-') && RE.identity.test(repo.read(f)));
      return { total: items.length, items };
    },
    sample: {
      clean: { 'server/src/odoo-session.ts': "import { x } from './odoo-viewer.ts';\n" },
      dirty: { 'server/src/foo.ts': "import { x } from './odoo-viewer.ts';\n" }, expect: 1,
    },
  },
  {
    id: 'erasable-syntax', what: '不可擦除的语法（enum、namespace、参数属性）', target: 0, proposed: 'redline',
    measure: (repo) => { const files = repo.perFile(repo.server(), RE.nonErasable); return { total: sum(files), files }; },
    sample: {
      clean: { 'server/src/foo.ts': "export const A = { X: 'x' } as const;\n" },
      dirty: { 'server/src/foo.ts': 'enum A { X }\nnamespace N {}\nclass C { constructor(private x: number) {} }\n' }, expect: 3,
    },
  },
  {
    id: 'services-no-express', what: '引用 express 的领域服务', target: 0, proposed: 'redline',
    measure: (repo) => { const items = repo.server().filter((f) => f.startsWith('server/src/services/') && RE.express.test(repo.read(f))); return { total: items.length, items }; },
    sample: {
      clean: { 'server/src/index.ts': "import express from 'express';\n" },
      dirty: { 'server/src/services/a.ts': "import express from 'express';\n" }, expect: 1,
    },
  },
  {
    id: 'a2a-import-sites', what: '引用 a2a-net 的文件', target: null, proposed: 'count',
    measure: (repo) => { const items = repo.server().filter((f) => RE.a2a.test(repo.read(f))); return { total: items.length, items, note: '外部节点插件建好后，只允许它引用' }; },
    sample: {
      clean: { 'server/src/foo.ts': "import { x } from './a2a.ts';\n" },
      dirty: { 'server/src/foo.ts': "import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';\n" }, expect: 1,
    },
  },
  {
    id: 'deps-registered', what: '没登记的运行时依赖', target: 0, proposed: 'redline',
    measure: (repo, list) => {
      const items = [];
      for (const [name, file] of [['root', 'package.json'], ['server', 'server/package.json'], ['web', 'web/package.json']]) {
        let deps = {};
        try { deps = JSON.parse(repo.read(file) || '{}').dependencies || {}; } catch { /* 坏的 package.json 当作没有依赖 */ }
        const known = new Set(list?.deps?.[name] || []);
        for (const dep of Object.keys(deps)) if (!known.has(dep)) items.push(`${name}:${dep}`);
      }
      return { total: items.length, items: items.sort() };
    },
    sample: {
      clean: { 'server/package.json': '{"dependencies":{}}' },
      dirty: { 'server/package.json': '{"dependencies":{"left-pad":"1.0.0"}}' }, expect: 1,
    },
  },
  {
    id: 'env-docs', what: '环境变量与 README 对不上的个数', target: 0, proposed: 'redline',
    measure: (repo) => {
      const r = runScript(repo, 'docs-env-face.mjs', [repo.root]);
      if (!r) return { total: 0, skipped: '没有 scripts/docs-env-face.mjs' };
      let out;
      try { out = JSON.parse(r.stdout); } catch { return { total: 0, skipped: 'docs-env-face.mjs 的输出读不懂' }; }
      const items = [...(out.missing || []).map((k) => `没写进 README：${k}`), ...(out.extra || []).map((k) => `README 多写了：${k}`)];
      return { total: items.length, items };
    },
  },
  {
    id: 'public-hygiene', what: '这次改动的文件里的隐私命中', target: 0, proposed: 'redline',
    measure: (repo) => {
      const files = changedFiles(repo);
      if (files === null) return { total: 0, skipped: '取不到对比基准（origin/main）' };
      if (files.length === 0) return { total: 0, note: '没有改动的文件' };
      const r = runScript(repo, 'privacy-gate.mjs', files);
      if (!r) return { total: 0, skipped: '没有 scripts/privacy-gate.mjs' };
      return { total: r.status === 0 ? 0 : 1, note: `扫了 ${files.length} 个改动的文件；通用模式，业务词表未接` };
    },
  },
  {
    id: 'web-fetch', what: 'api.ts 之外直接 fetch', target: 0, proposed: 'count',
    measure: (repo) => {
      const pages = repo.walk('web/src').filter((f) => /\.tsx?$/.test(f) && f !== 'web/src/api.ts');
      const files = repo.perFile(pages, RE.fetch);
      return { total: sum(files), files, note: `${Object.keys(files).length} 个文件` };
    },
    sample: {
      clean: { 'web/src/api.ts': "fetch('/api/x');\n", 'web/src/pages/A.tsx': "apiFetch('/api/x');\n" },
      dirty: { 'web/src/pages/A.tsx': "fetch('/api/x');\n" }, expect: 1,
    },
  },
  {
    id: 'design-counts', what: '内联样式', target: null, proposed: 'count',
    measure: (repo) => {
      const r = runScript(repo, 'inline-style-count.mjs', ['--json']);
      if (!r) return { total: 0, skipped: '没有 scripts/inline-style-count.mjs' };
      let out;
      try { out = JSON.parse(r.stdout); } catch { return { total: 0, skipped: 'inline-style-count.mjs 的输出读不懂' }; }
      return { total: out.total.style, note: `写死的色值 ${out.total.colors}，档位外字号 ${out.total.offScaleFont}` };
    },
  },
];

const today = () => new Date().toISOString().slice(0, 10);
const baselineOf = (m) => (m.items ? { total: m.total, items: m.items } : m.files ? { total: m.total, files: m.files } : { total: m.total });

/** 实际值对照基线：over 是「比基线多出来的」，每条都点名。豁免未过期的不算。 */
function compare(rule, m, waivers = [], now = today()) {
  const base = rule.baseline;
  if (!base) return { over: [], delta: 0, note: '没有基线' };
  const over = [];
  if (m.items) { const known = new Set(base.items || []); for (const it of m.items) if (!known.has(it)) over.push(it); }
  else if (m.files) { for (const [f, n] of Object.entries(m.files)) { const b = base.files?.[f] ?? 0; if (n > b) over.push(`${f}（${b} → ${n}）`); } }
  else if (m.total > base.total) over.push(`${base.total} → ${m.total}`);
  const waived = (text) => waivers.some((w) => w.rule === rule.id && text.startsWith(w.item) && String(w.until) >= now);
  return { over: over.filter((o) => !waived(o)), delta: m.total - base.total };
}

function verdict(rule, m, cmp) {
  if (m.skipped) return { fail: false, change: `未量：${m.skipped}` };
  const tier = rule.tier || 'count';
  const fail = (tier === 'budget' && cmp.over.length > 0) || (tier === 'redline' && rule.target !== null && m.total > rule.target);
  const change = cmp.over.length ? `多出 ${cmp.over.length} 处：${cmp.over.slice(0, 3).join('、')}${cmp.over.length > 3 ? ' 等' : ''}`
    : cmp.delta < 0 ? `少了 ${-cmp.delta}` : cmp.note || '持平';
  return { fail, change };
}

function loadList(root) {
  const file = join(root, LIST);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`${LIST} 不是合法的 JSON：${e.message}`); process.exit(2); }
}

function run(root) {
  const repo = openRepo(root);
  const list = loadList(root);
  const byId = new Map((list?.rules || []).map((r) => [r.id, r]));
  return {
    list,
    rows: RULES.map((def) => {
      const rule = { ...def, ...(byId.get(def.id) || {}) };
      const m = def.measure(repo, list);
      const cmp = compare(rule, m, list?.waivers || []);
      return { rule, m, cmp, ...verdict(rule, m, cmp) };
    }),
  };
}

const TIER = { count: '计数', budget: '预算', redline: '红线' };
function table(rows, hasList) {
  const lines = ['| 检查 | 查什么 | 现在 | 基线 | 目标 | 档位 | 变化 |', '|---|---|---|---|---|---|---|'];
  for (const { rule, m, change } of rows) {
    const now = m.skipped ? '—' : `${m.total}${m.note ? `（${m.note}）` : ''}`;
    lines.push(`| \`${rule.id}\` | ${rule.what} | ${now} | ${rule.baseline ? rule.baseline.total : '—'} | ${rule.target ?? '—'} | ${TIER[rule.tier || 'count']} | ${change} |`);
  }
  const moved = rows.filter((r) => !r.m.skipped && (r.cmp.over.length || r.cmp.delta !== 0));
  const unmeasured = rows.filter((r) => r.m.skipped).map((r) => r.rule.id);
  lines.push('', !hasList ? `还没有 ${LIST}：只有现状，没有基线。`
    : `本次变化：${moved.length ? moved.map((r) => `${r.rule.id} ${r.cmp.delta > 0 ? '+' : ''}${r.cmp.delta}`).join(' · ') : '与基线一致'}${unmeasured.length ? `（未量：${unmeasured.join('、')}）` : ''}`);
  return lines.join('\n');
}

function writeList(root, rows, previous, mode) {
  const packages = { root: 'package.json', server: 'server/package.json', web: 'web/package.json' };
  const deps = previous?.deps || Object.fromEntries(Object.entries(packages).map(([k, f]) => {
    try { return [k, Object.keys(JSON.parse(readFileSync(join(root, f), 'utf8')).dependencies || {}).sort()]; } catch { return [k, []]; }
  }));
  const changes = [];
  const rules = rows.map(({ rule, m }) => {
    const old = rule.baseline;
    let baseline = old;
    if (m.skipped) { /* 没量到的保留原基线 */ }
    else if (mode === 'init' || !old) baseline = baselineOf(m);
    else if (m.items) { const items = (old.items || []).filter((it) => m.items.includes(it)); baseline = { total: items.length, items }; }
    else if (m.files) { const files = keep(Object.fromEntries(Object.entries(old.files || {}).map(([f, n]) => [f, Math.min(n, m.files[f] ?? 0)]))); baseline = { total: sum(files), files }; }
    else baseline = { total: Math.min(old.total, m.total) };
    if (old && baseline.total !== old.total) changes.push(`${rule.id} ${old.total} → ${baseline.total}`);
    return { id: rule.id, tier: rule.tier || 'count', proposed: rule.proposed, what: rule.what, target: rule.target, baseline };
  });
  const list = {
    schema: 1,
    as_of: today(),
    doc: '路线清单：规则、档位、基线、豁免。由 scripts/tech-route-check.mjs 读写，约定见 CONTRIBUTING.md。tier 是现在生效的档位（count 只报告，budget 超过基线失败，redline 超过目标失败）；proposed 是建议档位，等属主裁定。deps 是登记过的运行时依赖；tests 登记不进 CI 的测试脚本和理由；waivers 是豁免：{rule, item, reason, by, until}，过期不算。',
    rules,
    deps,
    tests: previous?.tests || {},
    waivers: previous?.waivers || [],
  };
  writeFileSync(join(root, LIST), `${JSON.stringify(list, null, 2)}\n`);
  return changes;
}

/** 自检：每个检查先红后绿，外加档位与豁免的判定。 */
function selftest() {
  let failed = 0;
  const check = (ok, label) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) failed++; };
  const plant = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'tech-route-selftest-'));
    for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
    return root;
  };
  for (const def of RULES) {
    if (!def.sample) { console.log(`  · ${def.id} 调的是已有脚本或 tsc，由它们自己的测试负责`); continue; }
    const roots = [plant(def.sample.clean), plant(def.sample.dirty)];
    try {
      const clean = def.measure(openRepo(roots[0]), { deps: {}, tests: {} });
      const dirty = def.measure(openRepo(roots[1]), { deps: {}, tests: {} });
      check(clean.total === 0, `${def.id} 干净样本量出 ${clean.total}（应为 0）`);
      check(dirty.total === def.sample.expect, `${def.id} 违规样本量出 ${dirty.total}（应为 ${def.sample.expect}）`);
    } finally { for (const r of roots) rmSync(r, { recursive: true, force: true }); }
  }
  const rule = (tier, baseline, target = 0) => ({ id: 'x', tier, target, baseline });
  const m = { total: 3, files: { 'a.ts': 2, 'b.ts': 1 } };
  const same = compare(rule('budget', { total: 3, files: { 'a.ts': 2, 'b.ts': 1 } }), m);
  const grown = compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m);
  check(same.over.length === 0 && !verdict(rule('budget', {}), m, same).fail, '预算档：与基线一致，通过');
  check(grown.over.length === 1 && verdict(rule('budget', {}), m, grown).fail, '预算档：基线之外的新文件，失败并点名');
  check(!verdict(rule('count', {}), m, grown).fail, '计数档：同样的超出，只报告');
  check(verdict(rule('redline', {}), m, same).fail, '红线档：高于目标就失败，不看基线');
  const waiver = (until) => [{ rule: 'x', item: 'b.ts', reason: '自检', by: '自检', until }];
  check(compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m, waiver('2999-01-01')).over.length === 0, '豁免未过期：不算超出');
  check(compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m, waiver('2000-01-01')).over.length === 1, '豁免已过期：照算');
  console.log(failed ? `===== 路线体检自检：${failed} 项失败 =====` : '===== 路线体检自检：全过 =====');
  return failed ? 1 : 0;
}

function main() {
  if (flag('--selftest')) process.exit(selftest());
  const root = resolve(opt('--root') || join(HERE, '..'));
  const { list, rows } = run(root);
  if (flag('--init') || flag('--tighten')) {
    if (flag('--tighten') && !list) { console.error(`没有 ${LIST}，先用 --init 建`); process.exit(2); }
    const changes = writeList(root, rows, list, flag('--init') ? 'init' : 'tighten');
    // 第一次建清单时，依赖登记是这一步才写进去的；再量一遍，基线才是「登记之后」的数。
    if (flag('--init') && !list) { const again = run(root); writeList(root, again.rows, again.list, 'init'); }
    console.log(flag('--init') ? `已按现状写入 ${LIST}` : changes.length ? `已收紧：${changes.join('；')}` : '没有可收紧的');
    return;
  }
  if (flag('--json')) {
    console.log(JSON.stringify(rows.map(({ rule, m, cmp, fail, change }) => ({ id: rule.id, tier: rule.tier || 'count', total: m.total, baseline: rule.baseline?.total ?? null, target: rule.target, skipped: m.skipped || null, over: cmp.over, change, fail })), null, 2));
  } else {
    const text = table(rows, Boolean(list));
    console.log(`# 路线体检 ${today()}\n\n${text}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 路线体检\n\n${text}\n`);
  }
  process.exit(rows.some((r) => r.fail) ? 1 : 0);
}

main();
