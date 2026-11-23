#!/usr/bin/env node
/**
 * scripts/mutation-run.mjs 的自测。每例起一个一次性的 git 仓库当夹具，用假的测试命令（check.mjs 读「指令行」），
 * 不起浏览器、不连数据库。夹具、规格和进程号文件都放在本仓 tmp/mutation-run-test-<pid>/ 下，跑完删掉。
 *
 *   node scripts/mutation-run-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { account, parseSpec, replaceOccurrence, UsageError } from './mutation-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'mutation-run.mjs');
const BASE_DIR = join(HERE, '..', 'tmp', `mutation-run-test-${process.pid}`);
let pass = 0, fail = 0, seq = 0;
const check = (ok, label, detail) => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail === undefined ? '' : '（' + JSON.stringify(detail).slice(0, 400) + '）'}`); } };

// 假的测试命令：每个测试文件是若干指令行
//   contains <file> <text>          <file> 不含 <text> 就失败
//   endswith <file> <text>          <file> 不以 <text> 结尾就失败
//   sleepif <file> <text> <ms>      <file> 含 <text> 时睡一会儿
//   touchif <file> <text> <target>  <file> 含 <text> 时改写 <target>
//   pidfileif <file> <text> <path>  <file> 含 <text> 时把本进程号写进 <path>
//   ignoretermif <file> <text>      <file> 含 <text> 时不理 SIGTERM（不肯好好停的测试进程）
const CHECK = `import { readFileSync, writeFileSync } from 'node:fs'
let bad = 0
for (const f of process.argv.slice(2)) for (const l of readFileSync(f, 'utf8').split('\\n')) {
  const c = l.match(/^contains (\\S+) (.*)$/); if (c && !readFileSync(c[1], 'utf8').includes(c[2])) bad++
  const e = l.match(/^endswith (\\S+) (.*)$/); if (e && !readFileSync(e[1], 'utf8').trimEnd().endsWith(e[2])) bad++
  const s = l.match(/^sleepif (\\S+) (\\S+) (\\d+)$/); if (s && readFileSync(s[1], 'utf8').includes(s[2])) await new Promise(r => setTimeout(r, Number(s[3])))
  const t = l.match(/^touchif (\\S+) (\\S+) (\\S+)$/); if (t && readFileSync(t[1], 'utf8').includes(t[2])) writeFileSync(t[3], 'touched\\n')
  const p = l.match(/^pidfileif (\\S+) (\\S+) (\\S+)$/); if (p && readFileSync(p[1], 'utf8').includes(p[2])) writeFileSync(p[3], String(process.pid))
  const q = l.match(/^ignoretermif (\\S+) (\\S+)$/); if (q && readFileSync(q[1], 'utf8').includes(q[2])) process.on('SIGTERM', () => {})
}
process.exit(bad ? 1 : 0)
`;
// 像 pnpm、npx 那样的包装：真正的测试进程是它的子进程、运行器的孙进程
const WRAP = "import { spawnSync } from 'node:child_process'\nconst r = spawnSync(process.execPath, ['check.mjs', ...process.argv.slice(2)], { stdio: 'inherit' })\nprocess.exit(r.status ?? 1)\n";
const LIB = "export const LIMIT = 3\nexport const NAME = 'alpha'\nexport const TWIN = 1\nexport const TWIN = 1\n";

const g = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout;
};
const dir = (name) => { const d = join(BASE_DIR, `${name}-${++seq}`); mkdirSync(d, { recursive: true }); return d; };
function fixture(files = {}) {
  const repo = dir('repo');
  const all = { 'check.mjs': CHECK, 'wrap.mjs': WRAP, 'src/lib.js': LIB, '.gitignore': 'logs/\n', 'tests/strong.t': "contains src/lib.js LIMIT = 3\ncontains src/lib.js NAME = 'alpha'\n", 'tests/weak.t': 'contains src/lib.js NAME\n', ...files };
  g(repo, 'init', '-q');
  for (const [p, text] of Object.entries(all)) { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), text); }
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'fixture');
  return repo;
}
const node = process.execPath;
const t = (...files) => [node, 'check.mjs', ...files];
const base = { version: 1 };
function cli(repo, spec, opts = {}) {
  const specPath = join(dir('spec'), 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  const out = opts.out ?? join(repo, 'logs', `run-${++seq}`);
  const r = spawnSync(node, [RUNNER, specPath, '--root', repo, '--out', out, '--json'], { encoding: 'utf8' });
  const last = r.stdout.trim().split('\n').pop() ?? '';
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out, json: last.startsWith('{') ? JSON.parse(last) : undefined };
}
const clean = (repo) => g(repo, 'status', '--porcelain', '--untracked-files=all');
const lib = (repo) => readFileSync(join(repo, 'src/lib.js'), 'utf8');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gone = async (pid, ms = 5000) => { const until = Date.now() + ms; while (alive(pid) && Date.now() < until) await sleep(50); return !alive(pid); };
const K = { id: 'K', file: 'src/lib.js', find: 'LIMIT = 3', replace: 'LIMIT = 4' };

try {
  console.log('结果');
  {
    const repo = fixture();
    const r = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [K, { id: 'S', file: 'src/lib.js', find: 'TWIN = 1', replace: 'TWIN = 2', occurrence: 1, expect: 'survived' }] });
    check(r.code === 0 && JSON.stringify(r.json?.results.map((x) => [x.id, x.verdict])) === JSON.stringify([['K', 'killed'], ['S', 'survived']]) && r.json.ran === 2 && r.json.defined === 2 && clean(repo) === '' && lib(repo) === LIB,
      '打红的记 killed、登记的等价存活记 survived，跑满 2/2，工作树干净、文件原样', { code: r.code, err: r.stderr });
  }
  {
    const repo = fixture();
    const r = cli(repo, { ...base, narrow: [t('tests/weak.t')], mutations: [K] });
    check(r.code === 1 && r.json?.results[0].verdict === 'survived' && r.json.results[0].asExpected === false && clean(repo) === '', '本该打红却存活：退出 1', { code: r.code });
  }
  {
    const repo = fixture();
    const r = cli(repo, { ...base, narrow: [t('tests/weak.t')], wide: [t('tests/strong.t')], mutations: [K, { id: 'byNarrow', file: 'src/lib.js', find: 'NAME', replace: 'NOM' }] });
    check(r.code === 0 && JSON.stringify(r.json?.results.map((x) => [x.narrow, x.wide, x.verdict])) === JSON.stringify([['GREEN', 'RED', 'killed-by-wide'], ['RED', null, 'killed']]) && r.stdout.includes('killed, only by the wide tests'),
      'wide 只对 narrow 存活的跑；只被 wide 抓住的记 killed-by-wide', { code: r.code, out: r.stdout });
  }
  {
    const repo = fixture();
    const old = g(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'tests/weak.t'), 'contains src/lib.js NAME\ncontains src/lib.js LIMIT = 3\n');
    g(repo, 'commit', '-q', '-am', 'new tests');
    const r = cli(repo, { ...base, narrow: [t('tests/weak.t')], wide: [t('tests/strong.t')], oldTests: { rev: old, files: ['tests/weak.t'] }, mutations: [K, { id: 'both', file: 'src/lib.js', find: 'NAME', replace: 'NOM' }] });
    check(r.code === 0 && JSON.stringify(r.json?.results.map((x) => x.verdict)) === JSON.stringify(['only-new-kills', 'old-also-kills']) && clean(repo) === '' && readFileSync(join(repo, 'tests/weak.t'), 'utf8').includes('LIMIT = 3'),
      'oldTests：分出「只有新用例抓得住」与「旧用例也抓得住」，测试文件换回现在的', { code: r.code, err: r.stderr });
  }
  {
    const repo = fixture();
    const old = g(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'tests/weak.t'), 'contains src/lib.js NAME\n# changed\n'); g(repo, 'commit', '-q', '-am', 'new tests');
    const r = cli(repo, { ...base, narrow: [t('tests/weak.t')], wide: [t('tests/strong.t')], oldTests: { rev: old, files: ['tests/weak.t'] }, mutations: [K] });
    check(r.code === 0 && r.json?.results[0].verdict === 'killed-by-wide' && r.json.results[0].old === null && !existsSync(join(r.out, 'K.old.log')), '只被 wide 抓住的不问旧测试', { code: r.code });
  }
  {
    // 命令的形状锁在规格里：narrow 是命令列表，逐条按写的样子跑，第一条红就停
    const repo = fixture();
    const r = cli(repo, { ...base, narrow: [t('tests/weak.t'), [node, 'wrap.mjs', 'tests/strong.t']], mutations: [K, { id: 'first', file: 'src/lib.js', find: 'NAME', replace: 'NOM' }] });
    const kLog = r.out && existsSync(join(r.out, 'K.narrow.log')) ? readFileSync(join(r.out, 'K.narrow.log'), 'utf8') : '';
    const fLog = r.out && existsSync(join(r.out, 'first.narrow.log')) ? readFileSync(join(r.out, 'first.narrow.log'), 'utf8') : '';
    check(r.code === 0 && kLog.includes('"wrap.mjs","tests/strong.t"') && kLog.includes('"check.mjs","tests/weak.t"') && fLog.includes('"check.mjs","tests/weak.t"') && !fLog.includes('wrap.mjs'),
      '多条 narrow 命令：按写的参数逐条跑、日志记下每条参数，第一条红就不跑后面的', { code: r.code, kLog: kLog.slice(0, 200), fLog: fLog.slice(0, 200) });
  }

  console.log('拒绝时什么都不改');
  for (const [name, mutation, message] of [
    ['锚点没命中', { id: 'A', file: 'src/lib.js', find: 'LIMIT = 9', replace: 'x' }, '0 time'],
    ['锚点命中两次', { id: 'A', file: 'src/lib.js', find: 'TWIN = 1', replace: 'x' }, '2 time'],
    ['occurrence 超出', { id: 'A', file: 'src/lib.js', find: 'TWIN = 1', replace: 'x', occurrence: 3 }, 'at least 3'],
    ['路径离开仓库', { id: 'A', file: '../lib.js', find: 'x', replace: 'y' }, 'leaves the repository'],
    ['绝对路径', { id: 'A', file: '/etc/hosts', find: 'x', replace: 'y' }, 'relative to the repository'],
  ]) {
    const repo = fixture();
    const r = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [K, mutation] });
    check(r.code === 2 && r.stderr.includes(message) && lib(repo) === LIB && clean(repo) === '', `${name}：退出 2，什么都没改`, { code: r.code, err: r.stderr });
  }
  {
    const repo = fixture();
    writeFileSync(join(repo, 'stray.txt'), 'x\n');
    const r = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [K] });
    check(r.code === 2 && r.stderr.includes('stray.txt') && lib(repo) === LIB, '工作树不干净（未跟踪文件）：退出 2，点名文件', { code: r.code });
  }
  {
    const repo = fixture();
    mkdirSync(join(repo, 'logs'), { recursive: true }); writeFileSync(join(repo, 'logs/ignored.js'), 'LIMIT = 3\n');
    const r = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [{ id: 'I', file: 'logs/ignored.js', find: 'LIMIT = 3', replace: 'LIMIT = 4' }] });
    check(r.code === 2 && r.stderr.includes('not tracked by git') && readFileSync(join(repo, 'logs/ignored.js'), 'utf8') === 'LIMIT = 3\n', '被改文件没被 git 跟踪（还原不了）：退出 2', { code: r.code, err: r.stderr });
  }
  {
    const repo = fixture({ 'tests/red.t': 'contains src/lib.js NOPE\n' });
    const r = cli(repo, { ...base, narrow: [t('tests/red.t')], mutations: [K] });
    check(r.code === 2 && r.stderr.includes('baseline') && clean(repo) === '' && !existsSync(join(r.out, 'K.narrow.log')), 'narrow 基线是红的：退出 2，一条变异都不跑', { code: r.code });
  }
  {
    const repo = fixture({ 'tests/weak.t': 'contains src/lib.js LIMIT = 9\n' });
    const old = g(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'tests/weak.t'), 'contains src/lib.js LIMIT = 3\n'); g(repo, 'commit', '-q', '-am', 'new tests');
    const r = cli(repo, { ...base, narrow: [t('tests/weak.t')], oldTests: { rev: old, files: ['tests/weak.t'] }, mutations: [K] });
    check(r.code === 2 && r.stderr.includes('the old tests (tests/weak.t at ' + old + ') are not green') && existsSync(join(r.out, 'baseline.old.log')) && !existsSync(join(r.out, 'K.narrow.log')) && readFileSync(join(repo, 'tests/weak.t'), 'utf8') === 'contains src/lib.js LIMIT = 3\n' && clean(repo) === '',
      '旧测试在没改的代码上不绿：退出 2，一条变异都不跑，测试文件换回', { code: r.code, err: r.stderr });
  }
  {
    const repo = fixture();
    const outside = join(dir('outside'), 'lib.js'); writeFileSync(outside, LIB);
    symlinkSync(outside, join(repo, 'src/link.js')); g(repo, 'add', 'src/link.js'); g(repo, 'commit', '-q', '-m', 'link');
    const r = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [{ id: 'L', file: 'src/link.js', find: 'LIMIT = 3', replace: 'LIMIT = 4' }] });
    check(r.code === 2 && r.stderr.includes('symbolic link') && readFileSync(outside, 'utf8') === LIB, '被改的是已跟踪的符号链接：退出 2，链接指向的文件不动', { code: r.code });
  }
  {
    const repo = fixture();
    const outsideOut = dir('out-outside');
    const a = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [K] }, { out: outsideOut });
    const b = cli(repo, { ...base, narrow: [t('tests/strong.t')], mutations: [K] }, { out: join(repo, 'src', 'out') });
    check(a.code === 2 && a.stderr.includes('inside the repository') && b.code === 2 && b.stderr.includes('not ignored') && !existsSync(join(repo, 'src', 'out')) && lib(repo) === LIB && clean(repo) === '',
      '--out 在仓库外、或在仓库里但没被忽略：都退出 2，一个文件都不写', { a: [a.code, a.stderr], b: [b.code, b.stderr] });
  }
  {
    const bad = (s) => { try { parseSpec(s); return 'accepted'; } catch (e) { return e instanceof UsageError ? e.message : 'other: ' + e.message; } };
    const ok = { ...base, narrow: [t('t')], mutations: [{ id: 'a', file: 'f', find: 'x', replace: 'y' }] };
    const r = {
      json: bad('{'), same: bad({ ...ok, mutations: [{ id: 'a', file: 'f', find: 'x', replace: 'x' }] }),
      dup: bad({ ...ok, mutations: [ok.mutations[0], { id: 'a', file: 'f', find: 'z', replace: 'y' }] }),
      oldShape: bad({ ...ok, command: [node, 'check.mjs'], narrow: ['tests/strong.t'] }), strNarrow: bad({ ...ok, narrow: ['node scripts/x-test.mjs'] }),
      probes: bad({ ...ok, probes: [] }), timeout: bad({ ...ok, timeoutMs: 0 }), none: bad({ ...ok, mutations: [] }), version: bad({ ...ok, version: 2 }), ok: bad(ok),
    };
    check(r.json.includes('not JSON') && r.same.includes('nothing would change') && r.dup.includes('duplicate') && r.oldShape.includes('spec.command is not used') && r.strNarrow.includes('list of commands') && r.probes.includes('probes') && r.timeout.includes('timeoutMs') && r.none.includes('non-empty') && r.version.includes('version') && r.ok === 'accepted',
      '规格校验：坏 JSON、改了等于没改、重复 id、旧的 command 写法、narrow 写成字符串、probes、timeoutMs 0、没有变异、版本号', r);
  }

  console.log('第几处');
  {
    const repo = fixture({ 'tests/last.t': 'endswith src/lib.js TWIN = 1\n' });
    const r = cli(repo, { ...base, narrow: [t('tests/last.t')], mutations: [{ id: 'second', file: 'src/lib.js', find: 'TWIN = 1', replace: 'TWIN = 2', occurrence: 2 }, { id: 'first', file: 'src/lib.js', find: 'TWIN = 1', replace: 'TWIN = 2', occurrence: 1, expect: 'survived' }] });
    check(replaceOccurrence('a b a b a', 'a', 'X', 2) === 'a b X b a' && replaceOccurrence('a b a', 'a', 'X', 3) === undefined && r.code === 0 && JSON.stringify(r.json?.results.map((x) => x.verdict)) === JSON.stringify(['killed', 'survived']) && lib(repo) === LIB,
      '只换点名的那一处', { code: r.code, err: r.stderr });
  }

  console.log('还原与计数');
  {
    const repo = fixture({ 'tests/toucher.t': 'touchif src/lib.js LIMIT_X tests/weak.t\ncontains src/lib.js NAME\n' });
    const r = cli(repo, { ...base, narrow: [t('tests/toucher.t')], mutations: [{ id: 'T', file: 'src/lib.js', find: 'LIMIT = 3', replace: 'LIMIT_X = 3' }, { id: 'next', file: 'src/lib.js', find: 'NAME', replace: 'NOM' }] });
    check(r.code === 3 && r.stderr.includes('after T the tree is not clean') && r.stderr.includes('tests/weak.t') && !existsSync(join(r.out, 'next.narrow.log')) && lib(repo) === LIB,
      '测试弄脏了一个已跟踪文件：退出 3，点名文件，后面的变异不跑，被改的文件照样还原', { code: r.code, err: r.stderr });
    g(repo, 'checkout', '--', 'tests/weak.t');
  }
  {
    let thrown = '';
    try { account('mutations', 3, 2); } catch (e) { thrown = e.constructor.name + ':' + e.message; }
    check(thrown === 'IntegrityError:ran 2 mutations of 3 defined', '计数对不上抛 IntegrityError', thrown);
  }
  {
    const repo = fixture({ 'tests/slow.t': 'sleepif src/lib.js SLOW 20000\ncontains src/lib.js NAME\n' });
    const started = Date.now();
    const r = cli(repo, { ...base, timeoutMs: 1500, narrow: [t('tests/slow.t')], mutations: [{ id: 'hang', file: 'src/lib.js', find: 'LIMIT = 3', replace: 'SLOW = 3' }] });
    check(r.code === 0 && r.json?.results[0].narrow === 'RED' && r.json.results[0].timedOut === true && r.stdout.includes('(timeout)') && Date.now() - started < 15000 && lib(repo) === LIB,
      'timeoutMs：卡住的测试被停掉，记打红并标 timeout', { code: r.code, took: Date.now() - started });
  }
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    const pidFile = join(dir('pid'), 'pid');
    // 测试进程不理 SIGTERM，只有运行器收尾时给整组的 SIGKILL 才停得住它
    const repo = fixture({ 'tests/slow.t': `ignoretermif src/lib.js SLOW\npidfileif src/lib.js SLOW ${pidFile}\nsleepif src/lib.js SLOW 20000\ncontains src/lib.js NAME\n` });
    const specPath = join(dir('spec'), 'spec.json'), out = join(repo, 'logs', 'sig');
    writeFileSync(specPath, JSON.stringify({ ...base, narrow: [[node, 'wrap.mjs', 'tests/slow.t']], mutations: [{ id: 'slow', file: 'src/lib.js', find: 'LIMIT = 3', replace: 'SLOW = 3' }, { id: 'never', file: 'src/lib.js', find: 'NAME', replace: 'NOM' }] }));
    const child = spawn(node, [RUNNER, specPath, '--root', repo, '--out', out, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', (b) => { stdout += String(b); });
    const exited = new Promise((done) => child.on('close', (code) => done(code)));
    const until = Date.now() + 15000;
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '') && Date.now() < until) await sleep(50);
    const mutated = lib(repo).includes('SLOW'), grandchild = Number(readFileSync(pidFile, 'utf8') || 0), wasAlive = grandchild > 0 && alive(grandchild);
    const sent = Date.now(); child.kill(signal);
    const code = await Promise.race([exited, sleep(15000).then(() => 'hung')]);
    const took = Date.now() - sent, dead = await gone(grandchild);
    check(mutated && wasAlive && code === 130 && took < 5000 && dead && lib(repo) === LIB && clean(repo) === '' && JSON.parse(stdout.trim().split('\n').pop() || '{}').ran === 0,
      `跑到一半收到 ${signal}：停掉测试和它起的进程（不理 SIGTERM 的孙进程也停）、还原文件、退出 130`, { code, took, dead, mutated, wasAlive });
    if (code === 'hung') child.kill('SIGKILL');
  }
  {
    // 包装进程收到 SIGTERM 就退，它下面不理 SIGTERM 的测试进程要等宽限期满的 SIGKILL；下一条变异让运行器还活着
    const pidFile = join(dir('pid'), 'pid');
    const repo = fixture({ 'tests/slow.t': `ignoretermif src/lib.js HANG\npidfileif src/lib.js HANG ${pidFile}\nsleepif src/lib.js HANG 30000\nsleepif src/lib.js BUSY 6500\ncontains src/lib.js NAME\n` });
    const specPath = join(dir('spec'), 'spec.json'), out = join(repo, 'logs', 'grace');
    // 超时 7 秒停掉 hang（包装退出、孙进程不理 SIGTERM），约 12 秒宽限期满 SIGKILL；busy 睡 6.5 秒（不超时），运行器活到约 13.5 秒
    writeFileSync(specPath, JSON.stringify({ ...base, timeoutMs: 7000, narrow: [[node, 'wrap.mjs', 'tests/slow.t']], mutations: [{ id: 'hang', file: 'src/lib.js', find: 'LIMIT = 3', replace: 'HANG = 3' }, { id: 'busy', file: 'src/lib.js', find: 'TWIN = 1', replace: 'BUSY = 1', occurrence: 1, expect: 'survived' }] }));
    const child = spawn(node, [RUNNER, specPath, '--root', repo, '--out', out, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let running = true; const exited = new Promise((done) => child.on('close', (code) => { running = false; done(code); }));
    const until = Date.now() + 15000;
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '') && Date.now() < until) await sleep(50);
    const grandchild = Number(readFileSync(pidFile, 'utf8') || 0);
    const dead = await gone(grandchild, 15000), runnerStillRunning = running;
    const code = await Promise.race([exited, sleep(30000).then(() => 'hung')]);
    check(grandchild > 0 && dead && runnerStillRunning && code === 0 && lib(repo) === LIB && clean(repo) === '',
      '超时后宽限期满给整组 SIGKILL，即使直接子进程（包装）早已退出、运行器还在跑下一条', { grandchild, dead, runnerStillRunning, code });
    if (code === 'hung') child.kill('SIGKILL');
  }
} finally {
  rmSync(BASE_DIR, { recursive: true, force: true });
}
console.log(`mutation-run-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
