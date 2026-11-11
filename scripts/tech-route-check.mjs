#!/usr/bin/env node
/**
 * 路线体检：把技术路线上的每条约定量成数字，对照仓库根 tech-route.json 里的基线。
 * 只读、零依赖。档位是 count 的检查只报告；budget 超过基线、redline 超过目标，退出码才是 1。
 * 每个检查现在是哪一档，写在 tech-route.json 里。约定本身见仓库根的 CONTRIBUTING.md。
 *
 *   node scripts/tech-route-check.mjs               打印体检表（CI 里同时写进摘要页）
 *   node scripts/tech-route-check.mjs --json        机器可读
 *   node scripts/tech-route-check.mjs --selftest    每个检查先红后绿：干净样本必为 0，违规样本必被数到
 *   node scripts/tech-route-check.mjs --init        按现状写基线（只在建清单或新增检查时用）
 *   node scripts/tech-route-check.mjs --tighten     把变小了的基线收紧（只减不增）
 *   node scripts/tech-route-check.mjs --no-types    跳过类型检查那一项（它要跑一遍 tsc）
 *   node scripts/tech-route-check.mjs --no-boot     跳过快照那一项（它要起一个隔离实例）
 *   node scripts/tech-route-check.mjs --strict      预算档、红线档的检查量不出来也算失败（CI 用这个）
 *   node scripts/tech-route-check.mjs --root DIR    体检另一棵目录树
 *
 * 退出码：0 通过；1 有预算或红线被突破；2 用法或清单错误（清单缺失、缺规则、档位写错、豁免不完整）。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
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
  moduleRef: /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*['"`]([^'"`]+)['"`]/g,
  nonErasable: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w|^\s*(?:export\s+)?(?:declare\s+)?namespace\s+\w|constructor\([^)]*\b(?:private|public|protected|readonly)\s+\w/gm,
  readmePath: /(?:^|[^\w./-])((?:scripts|server\/src|web\/src|deploy|docs)\/[\w./-]+\.(?:json|yaml|yml|mjs|cjs|tsx|ts|js|py|sh|md))(?![\w-])/g,
  testLike: /(?:-|_)(?:test|smoke|mutation)s?\.(?:mjs|js|py|sh)$/,
  runnable: /\.(?:mjs|js|py|sh)$/,
};
const outsideServices = (f) => f !== 'server/src/db.ts' && !f.startsWith('server/src/services/');

// 身份的具体实现只许待在登录提供方目录里；目录之外的 server 文件都算核心。
const PROVIDERS_DIR = 'server/src/login-providers/';
// 核心里唯一放行的一条引用：装配点从提供方清单引入 loginProviders（一串插件）。只认下面这一种写法——
// 多引一个名字、整包引入、转出（export … from）、动态引入都不放行，免得实现里的函数经清单和契约文件洗一道流进核心。
const IDENTITY_ASSEMBLY = 'server/src/identity.ts';
const PROVIDERS_LIST = 'server/src/login-providers/index.ts';
const ASSEMBLY_IMPORT = /^import \{ loginProviders \} from '\.\/login-providers\/index\.ts';\r?$/gm;
/** 一个文件里所有的模块引用（import … from、export … from、import '…'、import('…')、require('…')），相对路径解析成仓库路径。 */
function moduleRefs(file, text) {
  return [...text.matchAll(RE.moduleRef)].map((m) => (m[1].startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), m[1])) : m[1]));
}
/**
 * 这个核心文件有没有直接引用身份的具体实现。两条都算：
 *   a. 引用指到登录提供方目录里面（装配点那一句除外）；
 *   b. 引用指到文件名是 odoo-*.ts 的模块——挪目录之前的量法，留着：实现文件换个地方放、或者又长回核心里，照样数得到。
 * 量的是写在源码里的引用。路径是算出来的（先存进变量、拼接）数不到，这是按文本量的固有限制。
 */
function refsIdentityImpl(file, text) {
  const refs = moduleRefs(file, text);
  const inside = refs.filter((ref) => ref.startsWith(PROVIDERS_DIR));
  if (refs.some((ref) => !ref.startsWith(PROVIDERS_DIR) && /^odoo-[\w-]+\.ts$/.test(posix.basename(ref)))) return true;
  if (inside.length === 0) return false;
  if (file !== IDENTITY_ASSEMBLY) return true;
  // 装配点：指进提供方目录的引用，每一条都得是放行的那一句
  return inside.some((ref) => ref !== PROVIDERS_LIST) || inside.length !== count(text, ASSEMBLY_IMPORT);
}

/** 调仓库里已有的检查脚本，取它的 JSON 输出；脚本不在就返回 null。 */
function runScript(repo, script, args) {
  const file = join(repo.root, 'scripts', script);
  if (!existsSync(file)) return null;
  const r = spawnSync(process.execPath, [file, ...args], { cwd: repo.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
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
        // strictNullChecks 必须开：关着的时候 TypeScript 不按真假值收窄「成功 / 失败」这种联合类型，
        // 会把 if (!r.ok) return r.hint 这样正确的写法判成错误。其余仍是宽松模式。
        skipLibCheck: true, strict: false, strictNullChecks: true, erasableSyntaxOnly: true,
        typeRoots: [nodeTypes, join(repo.root, 'server/node_modules/@types')], types: ['node'],
      },
      include: [join(repo.root, 'server/src/**/*.ts')],
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
    const r = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: repo.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = {}, detail = {};
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^(.+?)(\(\d+,\d+\): error TS\d+:.*)$/.exec(line);
      if (!m) continue;
      const f = relative(repo.root, resolve(repo.root, m[1])).split('\\').join('/');
      files[f] = (files[f] || 0) + 1;
      (detail[f] ||= []).push(`${f}${m[2]}`.slice(0, 240));
    }
    return { total: sum(files), files: keep(files), detail };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 这次改动了哪些文件（相对 main；新增、修改、改名都算）。取不到对比基准就返回 null。 */
function changedFiles(repo) {
  for (const range of [['origin/main...HEAD'], ['origin/main', 'HEAD'], ['FETCH_HEAD', 'HEAD']]) {
    const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=AMR', ...range], { cwd: repo.root, encoding: 'utf8' });
    if (r.status === 0) return r.stdout.split('\n').filter(Boolean).filter((f) => existsSync(join(repo.root, f)));
  }
  return null;
}

/**
 * 检查项。measure 返回 { total, files?, items?, note?, skipped? }：
 * files 是「文件 → 次数」，items 是一串名字；两者都没有就只比 total。
 * sample 是自检用的两棵最小目录树：clean 必须量出 0，dirty 必须量出 expect。
 * cases 是更多的自检样本，一种写法一份：{ label, files, expect }。
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
    id: 'server-typecheck', what: 'server 的类型错误（带空值检查，其余宽松）', target: 0, proposed: 'budget',
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
      clean: { 'README.md': '见 `scripts/a.mjs`、`scripts/b.json`、`web/src/C.tsx`。\n', 'scripts/a.mjs': '', 'scripts/b.json': '{}', 'web/src/C.tsx': '' },
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
      const core = repo.server().filter((f) => !f.startsWith(PROVIDERS_DIR));
      const items = core.filter((f) => refsIdentityImpl(f, repo.read(f)));
      return { total: items.length, items, note: `核心 ${core.length} 个文件；登录提供方目录 ${repo.server().length - core.length} 个` };
    },
    sample: {
      clean: {
        'server/src/identity.ts': "import { loginProviders } from './login-providers/index.ts';\n",
        'server/src/login-providers/index.ts': "import * as odoo from './odoo/index.ts';\n",
        'server/src/login-providers/odoo/index.ts': "import type { LoginProvider } from '../../identity.ts';\nimport { resolveOdooViewer } from './odoo-viewer.ts';\n",
        'server/src/login-providers/odoo/odoo-viewer.ts': "import { odooSessionOf } from './odoo-session.ts';\n",
        'server/src/tasks-read-access.ts': "import { identity } from './identity.ts';\n",
        'server/src/services/a.ts': "import { identity } from '../identity.ts';\n",
      },
      dirty: { 'server/src/foo.ts': "import { x } from './login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1,
    },
    // 每种绕法各一份：都必须被数到。干净的那几份防的是量法误伤。
    cases: [
      { label: '核心静态引用提供方目录里的实现', files: { 'server/src/foo.ts': "import { resolveOdooViewer } from './login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '只引用类型也算', files: { 'server/src/foo.ts': "import type { X } from './login-providers/odoo/odoo-session.ts';\n" }, expect: 1 },
      { label: '转出（export … from）也算', files: { 'server/src/foo.ts': "export { resolveOdooViewer } from './login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '动态 import() 也算', files: { 'server/src/foo.ts': "const m = await import('./login-providers/odoo/index.ts');\n" }, expect: 1 },
      { label: '只为副作用的 import 也算', files: { 'server/src/foo.ts': "import './login-providers/odoo/index.ts';\n" }, expect: 1 },
      { label: 'require() 也算', files: { 'server/src/foo.ts': "const m = require('./login-providers/odoo/odoo-session.ts');\n" }, expect: 1 },
      { label: '子目录里的核心文件往上引用也算', files: { 'server/src/services/a.ts': "import { x } from '../login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '装配点绕过清单、直接引用实现', files: { 'server/src/identity.ts': "import { resolveOdooViewer } from './login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '装配点之外的核心文件引用清单', files: { 'server/src/foo.ts': "import { loginProviders } from './login-providers/index.ts';\n" }, expect: 1 },
      { label: '实现文件留在核心里（旧位置、旧文件名）', files: { 'server/src/odoo-session.ts': '', 'server/src/foo.ts': "import { x } from './odoo-session.ts';\n" }, expect: 1 },
      { label: '实现文件换个目录放、不进提供方目录', files: { 'server/src/auth/odoo-viewer.ts': '', 'server/src/foo.ts': "import { x } from './auth/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '核心里的 odoo-*.ts 引用提供方目录（按位置算核心，不看文件名）', files: { 'server/src/odoo-extra.ts': "import { x } from './login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '洗一道：装配点把清单里的东西转出去，核心再从契约文件拿', files: { 'server/src/identity.ts': "import { loginProviders } from './login-providers/index.ts';\nexport { resolveOdooViewer } from './login-providers/index.ts';\n", 'server/src/foo.ts': "import { identity, resolveOdooViewer } from './identity.ts';\n" }, expect: 1 },
      { label: '装配点从清单多引一个名字', files: { 'server/src/identity.ts': "import { loginProviders, resolveOdooViewer } from './login-providers/index.ts';\n" }, expect: 1 },
      { label: '装配点整包引入清单', files: { 'server/src/identity.ts': "import * as providers from './login-providers/index.ts';\n" }, expect: 1 },
      { label: '装配点把清单整个转出', files: { 'server/src/identity.ts': "import { loginProviders } from './login-providers/index.ts';\nexport * from './login-providers/index.ts';\n" }, expect: 1 },
      { label: '装配点动态引入清单', files: { 'server/src/identity.ts': "const { loginProviders } = await import('./login-providers/index.ts');\n" }, expect: 1 },
      { label: '多行的 import（from 另起一行）也算', files: { 'server/src/foo.ts': "import {\n  resolveOdooViewer,\n}\n  from\n  './login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: '绕路的相对路径也算', files: { 'server/src/foo.ts': "import { x } from './services/../login-providers/odoo/odoo-viewer.ts';\n" }, expect: 1 },
      { label: 'import() 里的模板字面量也算', files: { 'server/src/foo.ts': "const load = (n) => import(`./login-providers/${n}/index.ts`);\n" }, expect: 1 },
      { label: '装配点只引入 loginProviders：放行', files: { 'server/src/identity.ts': "import { root } from './root-context.ts';\nimport { loginProviders } from './login-providers/index.ts';\n" }, expect: 0 },
      { label: '提供方目录内部互相引用不算', files: { 'server/src/login-providers/odoo/index.ts': "import { x } from './odoo-viewer.ts';\nimport { y } from '../index.ts';\n" }, expect: 0 },
      { label: '注释和字符串里提到文件名不算', files: { 'server/src/foo.ts': "// 见 login-providers/odoo/odoo-session.ts\nconst hint = 'odoo-session.ts';\n" }, expect: 0 },
      { label: '引用契约不算', files: { 'server/src/foo.ts': "import { identity, loginRelay } from './identity.ts';\n" }, expect: 0 },
    ],
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
      const items = [...new Set([...r.stderr.matchAll(/^\s*✗ (.+?) — /gm)].map((m) => m[1]))].sort();
      if (r.status !== 0 && items.length === 0) items.push('隐私闸报了命中，但没读出文件名');
      return { total: items.length, items, note: `扫了 ${files.length} 个改动的文件；通用模式，业务词表未接` };
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
  {
    id: 'surface-snapshots', what: '与快照不一致的对外面（路由、MCP 工具、表结构）', target: 0, proposed: 'redline',
    measure: (repo) => {
      if (flag('--no-boot')) return { total: 0, skipped: '按 --no-boot 跳过' };
      if (!repo.exists('server/node_modules')) return { total: 0, skipped: '没装依赖（起不了隔离实例）' };
      const r = runScript(repo, 'surface-snapshot.mjs', ['--json']);
      if (!r) return { total: 0, skipped: '没有 scripts/surface-snapshot.mjs' };
      let out;
      try { out = JSON.parse(r.stdout); } catch { return { total: 1, items: [`快照脚本没跑成：${(r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 160) || '没有输出'}`] }; }
      return { total: out.changed.length, items: out.changed, note: `${out.counts.routes} 条路由、${out.counts.tools} 个工具、${out.counts.tables} 张表` };
    },
  },
];

const today = () => new Date().toISOString().slice(0, 10);
const baselineOf = (m) => (m.items ? { total: m.total, items: m.items } : m.files ? { total: m.total, files: m.files } : { total: m.total });

const TIERS = ['count', 'budget', 'redline'];

/** 清单本身有没有毛病。有就不往下跑：一条规则被悄悄关掉，比检查失败更糟。 */
function listProblems(list, { allowMissing = false } = {}) {
  const problems = [];
  const known = new Set(RULES.map((r) => r.id));
  const seen = new Set();
  for (const r of list.rules || []) {
    if (!known.has(r.id)) problems.push(`清单里有不认识的规则：${r.id}`);
    if (seen.has(r.id)) problems.push(`规则重复：${r.id}`);
    seen.add(r.id);
    if (!TIERS.includes(r.tier)) problems.push(`${r.id} 的 tier 是「${r.tier}」，只能是 ${TIERS.join('、')}`);
    if (!allowMissing && typeof r.baseline?.total !== 'number') problems.push(`${r.id} 没有基线`);
  }
  if (!allowMissing) for (const id of known) if (!seen.has(id)) problems.push(`清单里缺规则：${id}`);
  for (const [i, w] of (list.waivers || []).entries()) {
    const where = `第 ${i + 1} 条豁免`;
    for (const k of ['rule', 'item', 'reason', 'by', 'until']) if (typeof w?.[k] !== 'string' || !w[k].trim()) problems.push(`${where}缺 ${k}`);
    if (typeof w?.until === 'string' && w.until.trim() && (!/^\d{4}-\d{2}-\d{2}$/.test(w.until) || Number.isNaN(Date.parse(w.until)))) problems.push(`${where}的 until 要写成 YYYY-MM-DD`);
    if (typeof w?.rule === 'string' && w.rule.trim() && !known.has(w.rule)) problems.push(`${where}的 rule 不认识：${w.rule}`);
  }
  for (const [name, reason] of Object.entries(list.tests || {})) if (typeof reason !== 'string' || !reason.trim()) problems.push(`tests 里的 ${name} 没写理由`);
  return problems;
}

/** 实际值对照基线：over 是「比基线多出来的」，每条都点名。豁免未过期的不算。 */
function compare(rule, m, waivers = [], now = today()) {
  const base = rule.baseline;
  // 豁免只认整项：条目相等，或文件型条目的「文件（b → n）」。不按前缀，免得 a 顺带豁免了 a2a.ts。
  // until 必须是 YYYY-MM-DD（读清单时校验过）；这里再守一道，格式不对的一律不算。
  const waived = (text) => waivers.some((w) => w.rule === rule.id && (text === w.item || text.startsWith(`${w.item}（`)) && /^\d{4}-\d{2}-\d{2}$/.test(String(w.until)) && w.until >= now);
  // live：去掉未过期豁免之后还剩多少，红线档拿它和目标比。
  const live = m.items ? m.items.filter((it) => !waived(it)).length
    : m.files ? Object.entries(m.files).filter(([f]) => !waived(f)).reduce((a, [, n]) => a + n, 0)
    : m.total;
  const waivedCount = (m.items || Object.keys(m.files || {})).filter(waived).length;
  if (!base) return { over: [], delta: 0, live, waivedCount, note: '没有基线' };
  const over = [];
  if (m.items) { const known = new Set(base.items || []); for (const it of m.items) if (!known.has(it)) over.push(it); }
  else if (m.files) { for (const [f, n] of Object.entries(m.files)) { const b = base.files?.[f] ?? 0; if (n > b) over.push(`${f}（${b} → ${n}）`); } }
  else if (m.total > base.total) over.push(`${base.total} → ${m.total}`);
  return { over: over.filter((o) => !waived(o)), delta: m.total - base.total, live, waivedCount };
}

function verdict(rule, m, cmp, strict = false) {
  const tier = rule.tier || 'count';
  // 量不出来：平时只提示；--strict 下，预算档和红线档量不出来就算失败，免得一条规则无声地失效。
  if (m.skipped) return { fail: strict && tier !== 'count', change: `未量：${m.skipped}` };
  const fail = (tier === 'budget' && cmp.over.length > 0) || (tier === 'redline' && rule.target !== null && cmp.live > rule.target);
  const base = cmp.over.length ? `多出 ${cmp.over.length} 处：${cmp.over.slice(0, 3).join('、')}${cmp.over.length > 3 ? ' 等' : ''}`
    : cmp.delta < 0 ? `少了 ${-cmp.delta}，合并后可以收紧基线` : cmp.note || '持平';
  return { fail, change: cmp.waivedCount ? `${base}（豁免 ${cmp.waivedCount} 处）` : base };
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
      return { rule, m, cmp, ...verdict(rule, m, cmp, flag('--strict')) };
    }),
  };
}

const TIER = { count: '计数', budget: '预算', redline: '红线' };

/** 清单相对 main 放宽了什么：档位、基线、目标、豁免、登记。取不到 main 上的清单返回 null。 */
function listLoosened(root, list) {
  const r = spawnSync('git', ['show', `origin/main:${LIST}`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  let main;
  try { main = JSON.parse(r.stdout); } catch { return null; }
  return diffLists(main, list);
}

/** 两份清单比较：list 相对 main 放宽了什么。 */
function diffLists(main, list) {
  const rank = { count: 0, budget: 1, redline: 2 };
  const before = new Map((main.rules || []).map((x) => [x.id, x]));
  const now = new Map((list.rules || []).map((x) => [x.id, x]));
  const out = [];
  for (const [id, b] of before) {
    const a = now.get(id);
    if (!a) { out.push(`${id} 被删掉`); continue; }
    if (rank[a.tier] < rank[b.tier]) out.push(`${id} 档位放宽（${TIER[b.tier]} → ${TIER[a.tier]}）`);
    if (a.baseline?.total > b.baseline?.total) out.push(`${id} 基线变大（${b.baseline.total} → ${a.baseline.total}）`);
    if ((a.tier || 'count') !== 'count') {
      // 预算档、红线档按文件（条目）比：总数不变或变小，也可能是把额度挪给了别的文件
      const grown = [];
      const bf = b.baseline?.files || {}, bi = new Set(b.baseline?.items || []);
      for (const [f, n] of Object.entries(a.baseline?.files || {})) if (n > (bf[f] ?? 0)) grown.push(f in bf ? `${f} ${bf[f]} → ${n}` : `${f} 新增 ${n}`);
      for (const it of a.baseline?.items || []) if (!bi.has(it)) grown.push(`${it} 新增`);
      if (grown.length) out.push(`${id} 按文件放宽 ${grown.length} 处（${grown.slice(0, 3).join('、')}${grown.length > 3 ? ' 等' : ''}）`);
    }
    if ((a.target ?? Infinity) > (b.target ?? Infinity)) out.push(`${id} 目标放宽`);
  }
  const key = (w) => `${w.rule} ${w.item}`;
  const had = new Set((main.waivers || []).map(key));
  const added = (list.waivers || []).map(key).filter((k) => !had.has(k));
  if (added.length) out.push(`新增豁免 ${added.length} 处（${added.slice(0, 3).join('、')}${added.length > 3 ? ' 等' : ''}）`);
  const tests = Object.keys(list.tests || {}).filter((k) => !(k in (main.tests || {})));
  if (tests.length) out.push(`新登记不进 CI 的测试 ${tests.length} 个`);
  return out;
}

const cell = (text) => String(text).replace(/\|/g, '¦').replace(/\s*\n\s*/g, ' ');
function table(rows, hasList, loosened) {
  const lines = ['| 检查 | 查什么 | 现在 | 基线 | 目标 | 档位 | 变化 |', '|---|---|---|---|---|---|---|'];
  for (const { rule, m, change } of rows) {
    const now = m.skipped ? '—' : `${m.total}${m.note ? `（${m.note}）` : ''}`;
    lines.push(`| \`${rule.id}\` | ${cell(rule.what)} | ${cell(now)} | ${rule.baseline ? rule.baseline.total : '—'} | ${rule.target ?? '—'} | ${TIER[rule.tier || 'count']} | ${cell(change)} |`);
  }
  const moved = rows.filter((r) => !r.m.skipped && (r.cmp.over.length || r.cmp.delta !== 0));
  const unmeasured = rows.filter((r) => r.m.skipped).map((r) => r.rule.id);
  lines.push('', !hasList ? `还没有 ${LIST}：只有现状，没有基线。`
    : `本次变化：${moved.length ? moved.map((r) => `${r.rule.id} ${r.cmp.delta > 0 ? '+' : ''}${r.cmp.delta}`).join(' · ') : '与基线一致'}${unmeasured.length ? `（未量：${unmeasured.join('、')}）` : ''}`);
  if (hasList) lines.push(`清单变化（相对 main）：${loosened === null ? '取不到 main 上的清单' : loosened.length ? loosened.join('；') : '没有放宽'}`);
  // 文件型检查超了的，把量到的原始报错行贴出来（类型检查用得上：只给「文件 0 → 1」看不出是哪一行）。
  for (const { rule, m, cmp } of rows) {
    if (!m.detail || !cmp.over.length) continue;
    const files = Object.keys(m.files || {}).filter((f) => (m.files[f] || 0) > (rule.baseline?.files?.[f] ?? 0));
    lines.push('', `${rule.id} 多出来的文件，量到的原始报错（这些文件里原有的也在内）：`, '', '```');
    for (const f of files.slice(0, 8)) lines.push(...(m.detail[f] || []).slice(0, 12));
    lines.push('```');
  }
  return lines.join('\n');
}

/**
 * --tighten 对一项基线的收紧。
 * 计数档只报告，基线照实际记：收紧后总数不会低于当次量出的数；代码从旧文件挪到新文件时，新文件按实际值记进去。
 * 预算档、红线档只减不增：已有文件取基线和实际的较小值；新文件和变多的部分是违规（要豁免或先修），不收进基线。
 */
function tightenBaseline(old, m, tier) {
  if (tier === 'count') return m.items ? { total: m.items.length, items: [...m.items] } : m.files ? { total: sum(keep(m.files)), files: keep(m.files) } : { total: m.total };
  if (m.items) { const items = (old.items || []).filter((it) => m.items.includes(it)); return { total: items.length, items }; }
  if (m.files) { const files = keep(Object.fromEntries(Object.entries(old.files || {}).map(([f, n]) => [f, Math.min(n, m.files[f] ?? 0)]))); return { total: sum(files), files }; }
  return { total: Math.min(old.total, m.total) };
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
    else baseline = tightenBaseline(old, m, rule.tier || 'count');
    const shape = (b) => { const v = b.files || b.items; return v && Object.keys(v).length ? JSON.stringify(v) : ''; };
    if (old && (baseline.total !== old.total || shape(baseline) !== shape(old))) changes.push(`${rule.id} ${old.total} → ${baseline.total}${baseline.total > old.total ? '（计数档，按实际记）' : baseline.total === old.total ? '（总数不变，按文件重记）' : ''}`);
    return { id: rule.id, tier: rule.tier || 'count', proposed: rule.proposed, what: rule.what, target: rule.target, ...(rule.note ? { note: rule.note } : {}), baseline };
  });
  const list = {
    schema: 1,
    as_of: today(),
    doc: '路线清单：规则、档位、基线、豁免。由 scripts/tech-route-check.mjs 读写，约定见 CONTRIBUTING.md。tier 是现在生效的档位（count 只报告，budget 超过基线失败，redline 超过目标失败）；proposed 是建议档位。属主 2026-11-10 裁定按建议档位开；落点还没建好的检查先留在 count，rule.note 写明什么时候开。deps 是登记过的运行时依赖；tests 登记不进 CI 的测试脚本和理由；waivers 是豁免：{rule, item, reason, by, until} 五项都要写，until 是 YYYY-MM-DD，过期不算。',
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
    for (const c of def.cases || []) {
      const root = plant(c.files);
      try {
        const got = def.measure(openRepo(root), { deps: {}, tests: {} }).total;
        check(got === c.expect, `${def.id} ${c.label}：量出 ${got}（应为 ${c.expect}）`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
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
  const prefix = [{ rule: 'x', item: 'b', reason: '自检', by: '自检', until: '2999-01-01' }];
  check(compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m, prefix).over.length === 1, '豁免只认整项：item 是 b，不会顺带豁免 b.ts');
  const both = [...waiver('2999-01-01'), { rule: 'x', item: 'a.ts', reason: '自检', by: '自检', until: '2999-01-01' }];
  check(!verdict(rule('redline', {}), m, compare(rule('redline', {}), m, both)).fail, '红线档：全部有未过期的豁免，通过');
  check(verdict(rule('redline', {}), m, compare(rule('redline', {}), m, waiver('2999-01-01'))).fail, '红线档：只豁免了一部分，照样失败');
  check(compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m, [{ rule: 'x', item: 'b.ts' }]).over.length === 1, '豁免没写期限：不算');
  check(compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m, [{ rule: 'x', item: 'b.ts', until: 'never' }]).over.length === 1, '豁免的期限不是日期：不算');
  check(compare(rule('budget', { total: 2, files: { 'a.ts': 2 } }), m, waiver('2999-01-01')).waivedCount === 1, '豁免了几处数得出来');
  const skipped = { total: 0, skipped: '自检' };
  check(!verdict(rule('redline', {}), skipped, compare(rule('redline', {}), skipped)).fail, '量不出来：平时只提示');
  check(verdict(rule('redline', {}), skipped, compare(rule('redline', {}), skipped), true).fail, '量不出来：--strict 下红线档算失败');
  check(!verdict(rule('count', {}), skipped, compare(rule('count', {}), skipped), true).fail, '量不出来：--strict 下计数档仍只提示');
  // --tighten：旧文件减少、同时有新文件（把代码从 a.ts 挪到 c.ts）
  const moved = { total: 5, files: { 'a.ts': 3, 'c.ts': 2 } };
  const countAfter = tightenBaseline({ total: 5, files: { 'a.ts': 5 } }, moved, 'count');
  check(countAfter.total === 5 && countAfter.files['a.ts'] === 3 && countAfter.files['c.ts'] === 2, `收紧：计数档旧文件减少、同时有新文件，基线按实际记（得到 ${JSON.stringify(countAfter.files)}）`);
  const grewAfter = tightenBaseline({ total: 3, files: { 'a.ts': 2, 'b.ts': 1 } }, { total: 4, files: { 'a.ts': 1, 'b.ts': 3 } }, 'count');
  check(grewAfter.total === 4, `收紧：计数档有文件变多，总数不低于实际（得到 ${grewAfter.total}）`);
  const budgetAfter = tightenBaseline({ total: 5, files: { 'a.ts': 5 } }, moved, 'budget');
  check(budgetAfter.total === 3 && !('c.ts' in budgetAfter.files), '收紧：预算档的新文件不收进基线（它是违规，要豁免或先修）');
  check(tightenBaseline({ total: 2, items: ['x', 'y'] }, { total: 2, items: ['y', 'z'] }, 'count').total === 2, '收紧：计数档按条目记时，新条目按实际记');
  // 「清单变化」：预算档按文件挪额度、计数档按文件重记
  const listOf = (tier, files) => ({ rules: [{ id: 'x', tier, target: 0, baseline: { total: sum(files), files } }], waivers: [], tests: {} });
  const movedOut = diffLists(listOf('budget', { 'a.ts': 3 }), listOf('budget', { 'a.ts': 2, 'c.ts': 1 }));
  check(movedOut.some((x) => x.includes('c.ts')), `清单变化：预算档总数不变、额度从旧文件挪到新文件，点名新文件（得到 ${JSON.stringify(movedOut)}）`);
  const shifted = diffLists(listOf('budget', { 'a.ts': 2, 'b.ts': 2 }), listOf('budget', { 'a.ts': 1, 'b.ts': 3 }));
  check(shifted.some((x) => x.includes('b.ts')) && !shifted.some((x) => x.includes('a.ts')), `清单变化：预算档在已有文件之间挪额度，点名变大的文件（得到 ${JSON.stringify(shifted)}）`);
  const itemsAdded = diffLists({ rules: [{ id: 'x', tier: 'redline', target: 0, baseline: { total: 1, items: ['p'] } }] }, { rules: [{ id: 'x', tier: 'redline', target: 0, baseline: { total: 1, items: ['q'] } }] });
  check(itemsAdded.some((x) => x.includes('q')), `清单变化：红线档换了一个条目，点名新条目（得到 ${JSON.stringify(itemsAdded)}）`);
  const recounted = diffLists(listOf('count', { 'a.ts': 3 }), listOf('count', { 'a.ts': 2, 'c.ts': 1 }));
  check(recounted.length === 0, `清单变化：计数档按文件重记、总数不变，不点名（得到 ${JSON.stringify(recounted)}）`);
  check(diffLists(listOf('budget', { 'a.ts': 3 }), listOf('budget', { 'a.ts': 2 })).length === 0, '清单变化：预算档只是变小，不点名');
  const good = { rules: RULES.map((r) => ({ id: r.id, tier: 'count', baseline: { total: 0 } })), waivers: [], tests: {} };
  const broken = (patch) => listProblems({ ...good, ...patch }).length > 0;
  check(listProblems(good).length === 0, '清单校验：完整的清单没有问题');
  check(broken({ rules: good.rules.slice(1) }), '清单校验：缺一条规则，报错');
  check(broken({ rules: good.rules.map((r, i) => (i ? r : { ...r, tier: 'redlne' })) }), '清单校验：档位写错一个字母，报错');
  check(broken({ rules: [...good.rules, { id: 'no-such-rule', tier: 'count', baseline: { total: 0 } }] }), '清单校验：不认识的规则，报错');
  check(broken({ waivers: [{ rule: RULES[0].id, item: 'a.ts' }] }), '清单校验：豁免缺理由、批准人、期限，报错');
  check(broken({ waivers: [{ rule: RULES[0].id, item: 'a.ts', reason: 'r', by: 'b', until: 'never' }] }), '清单校验：豁免的期限不是日期，报错');
  check(!broken({ waivers: [{ rule: RULES[0].id, item: 'a.ts', reason: 'r', by: 'b', until: '2999-01-01' }] }), '清单校验：五项齐全的豁免，通过');
  check(broken({ tests: { 'a-test.mjs': '' } }), '清单校验：登记的测试没写理由，报错');
  console.log(failed ? `===== 路线体检自检：${failed} 项失败 =====` : '===== 路线体检自检：全过 =====');
  return failed ? 1 : 0;
}

function main() {
  if (flag('--selftest')) process.exit(selftest());
  const root = resolve(opt('--root') || join(HERE, '..'));
  const existing = loadList(root);
  if (!existing && !flag('--init')) { console.error(`没有 ${LIST}。它是提交在仓库里的；确实要新建，跑 --init。`); process.exit(2); }
  if (existing) {
    const problems = listProblems(existing, { allowMissing: flag('--init') });
    if (problems.length) { console.error(`${LIST} 有问题，先修好再跑：\n- ${problems.join('\n- ')}`); process.exit(2); }
  }
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
    console.log(JSON.stringify(rows.map(({ rule, m, cmp, fail, change }) => ({ id: rule.id, tier: rule.tier || 'count', total: m.total, baseline: rule.baseline?.total ?? null, target: rule.target, skipped: m.skipped || null, over: cmp.over, waived: cmp.waivedCount || 0, change, fail })), null, 2));
  } else {
    const text = table(rows, Boolean(list), list ? listLoosened(root, list) : null);
    console.log(`# 路线体检 ${today()}\n\n${text}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 路线体检\n\n${text}\n`);
  }
  process.exit(rows.some((r) => r.fail) ? 1 : 0);
}

main();
