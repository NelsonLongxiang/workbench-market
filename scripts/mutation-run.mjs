#!/usr/bin/env node
/**
 * 变异运行器：评审「这条测试守住了这一行」的固定入口。改一行、跑测试、看它变红。
 * 移植自 dsh-open-a2a-net 的 scripts/mutation-run.mjs（next/0.8 63cb499f），按本仓的测试形状改了两处：
 *   · 测试不是「一个命令 + 文件列表」：本仓的测试多是独立脚本（不少起浏览器、数据库），所以 narrow、wide 写成
 *     完整的命令列表（每条是不经 shell 的参数数组），逐条按写的样子跑，任一条非 0 就算红。要跑哪些、怎么跑，锁在规格里。
 *   · 只写工作树以内：--out 必须在仓库里且被 git 忽略（缺省 tmp/mutation-run/<时间>/），被改的只有规格点名的已跟踪文件。
 *   · 没有「探针」（往测试文件末尾追加一条再跑）：本仓的测试脚本没有统一的「追加一条用例」的写法。
 *
 * 规格是数据（JSON）：改哪个文件、原文（字面）、换成什么、第几处。运行器
 *   - 工作树不干净就拒绝；动手前核对每个锚点（没写 occurrence 时恰好命中 1 次）；narrow 基线必须全绿；
 *   - 一次一条变异：改、读回确认、跑 narrow；narrow 没抓住的再跑 wide；给了 oldTests 时，对 narrow 抓住的再把那些测试文件
 *     换成 rev 时的版本跑一遍 narrow，分出「只有新用例抓得住」；
 *   - 每条之后写回原字节、再 git checkout 兜底，并核工作树干净，才做下一条；
 *   - 收尾核「跑了的条数 = 规格里的条数」且工作树干净。
 * 每次测试命令有自己的进程组；SIGINT、SIGTERM、SIGHUP 或 timeoutMs 到时先给整组 SIGTERM，5 秒后不论直接子进程在不在都给整组 SIGKILL。
 * 不读任何环境变量开关，不碰 git 索引，不提交、不推送。
 * 退出码：0 每条结果都符合预期；1 有变异存活（或不符合 expect）；2 用法或预检错误，什么都没改；3 还原或计数失败，请看工作树；
 *        130 被 SIGINT/SIGTERM/SIGHUP 中断，已先还原。
 *
 *   node scripts/mutation-run.mjs <spec.json> [--root DIR] [--out DIR] [--json]
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ ok: 0, survived: 1, usage: 2, integrity: 3, interrupted: 130 });
/** 请求本身有问题；抛出时什么都还没改 */
export class UsageError extends Error {}
/** 运行器没守住承诺（还原、计数）；要人去看工作树 */
export class IntegrityError extends Error {}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new UsageError(`git ${args.join(' ')} failed: ${String(r.stderr || r.error).trim()}`);
  return r.stdout;
}
const gitOk = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status === 0;
/** 改过、暂存、未跟踪的路径（git status --porcelain 的写法）；被忽略的不算 */
export const dirtyLines = (root) => git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);

const str = (v) => typeof v === 'string' && v.length > 0;
const strs = (v) => Array.isArray(v) && v.length > 0 && v.every(str);
const commands = (v) => Array.isArray(v) && v.length > 0 && v.every(strs);

/** 校验规格（对象或 JSON 文本）；有问题抛 UsageError，点名第一处 */
export function parseSpec(raw) {
  let s;
  try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { throw new UsageError(`spec is not JSON: ${e.message}`); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new UsageError('spec must be a JSON object');
  if (s.version !== 1) throw new UsageError('spec.version must be 1');
  if (s.command !== undefined) throw new UsageError('spec.command is not used here: write each test as a full command in narrow (and wide), e.g. "narrow": [["node", "scripts/x-test.mjs"]]');
  if (!commands(s.narrow)) throw new UsageError('spec.narrow must be a non-empty list of commands, each a non-empty array of strings (no shell)');
  if (s.wide !== undefined && !commands(s.wide)) throw new UsageError('spec.wide, when given, must be a non-empty list of commands, each a non-empty array of strings (no shell)');
  if (s.oldTests !== undefined && (!s.oldTests || !str(s.oldTests.rev) || !strs(s.oldTests.files))) throw new UsageError('spec.oldTests needs rev and files');
  if (s.timeoutMs !== undefined && !(Number.isSafeInteger(s.timeoutMs) && s.timeoutMs > 0)) throw new UsageError('spec.timeoutMs, when given, must be a whole number of milliseconds above 0');
  if (s.probes !== undefined) throw new UsageError('spec.probes are not supported in this repository (see the header of scripts/mutation-run.mjs)');
  const mutations = s.mutations;
  if (!Array.isArray(mutations) || mutations.length === 0) throw new UsageError('spec.mutations must be a non-empty array');
  const ids = new Set();
  for (const m of mutations) {
    if (!m || !str(m.id) || !str(m.file) || !str(m.find) || typeof m.replace !== 'string') throw new UsageError(`mutation ${JSON.stringify(m?.id)} needs id, file, find and replace`);
    if (!/^[A-Za-z0-9_.-]+$/.test(m.id)) throw new UsageError(`mutation ${m.id}: id may only use letters, digits, _ . -`);
    if (m.find === m.replace) throw new UsageError(`mutation ${m.id}: replace equals find, nothing would change`);
    if (m.occurrence !== undefined && !(Number.isSafeInteger(m.occurrence) && m.occurrence >= 1)) throw new UsageError(`mutation ${m.id}: occurrence must be a whole number from 1`);
    if (m.expect !== undefined && m.expect !== 'killed' && m.expect !== 'survived') throw new UsageError(`mutation ${m.id}: expect is killed or survived`);
    if (ids.has(m.id)) throw new UsageError(`duplicate id ${m.id}`);
    ids.add(m.id);
  }
  return { ...s, mutations };
}

/** 仓库相对路径 → 绝对路径；绝对路径、离开仓库的路径一律拒绝 */
export function inside(root, path) {
  if (isAbsolute(path)) throw new UsageError(`path must be relative to the repository: ${path}`);
  const full = resolve(root, path), rel = relative(root, full);
  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new UsageError(`path leaves the repository: ${path}`);
  return full;
}

export function countOccurrences(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

/** 只换第 occurrence 处（从 1 数）；没有那一处时返回 undefined */
export function replaceOccurrence(text, find, replace, occurrence) {
  let at = -1;
  for (let k = 0, from = 0; k < occurrence; k++) { at = text.indexOf(find, from); if (at === -1) return undefined; from = at + find.length; }
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

/** 锚点问题，一条一行；全部能按写的样子改时为空 */
export function checkAnchors(root, mutations) {
  const problems = [];
  for (const m of mutations) {
    const full = inside(root, m.file);
    if (!existsSync(full)) { problems.push(`${m.id}: ${m.file} does not exist`); continue; }
    const n = countOccurrences(readFileSync(full, 'utf8'), m.find);
    const want = m.occurrence === undefined ? 'exactly 1' : `at least ${m.occurrence}`;
    if (m.occurrence === undefined ? n !== 1 : n < m.occurrence) problems.push(`${m.id}: the anchor is found ${n} time(s) in ${m.file}, needs ${want}`);
  }
  return problems;
}

/** 跑了的条数不等于规格里的条数就抛 */
export function account(what, defined, ran) {
  if (ran !== defined) throw new IntegrityError(`ran ${ran} ${what} of ${defined} defined`);
}

/** --out 必须在仓库里、被 git 忽略：运行器只写工作树以内 */
export function checkOut(root, out) {
  const rel = relative(root, out);
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new UsageError(`--out must be a folder inside the repository (it writes nothing outside the working tree): ${out}`);
  if (!gitOk(root, ['check-ignore', '-q', '--', rel])) throw new UsageError(`--out ${rel} is not ignored by git; its logs would dirty the tree (tmp/ is ignored)`);
}

function preflight(root, spec, out) {
  checkOut(root, out);
  const dirty = dirtyLines(root);
  if (dirty.length) throw new UsageError(`the working tree is not clean; restore these first (git checkout -- <file>, or remove the untracked file):\n${dirty.join('\n')}`);
  const problems = checkAnchors(root, spec.mutations);
  for (const m of spec.mutations) if (existsSync(inside(root, m.file)) && !gitOk(root, ['ls-files', '--error-unmatch', '--', m.file])) problems.push(`${m.id}: ${m.file} is not tracked by git, so it could not be restored`);
  for (const f of [...spec.mutations.map((m) => m.file), ...(spec.oldTests?.files ?? [])]) {
    const full = inside(root, f);
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) problems.push(`${f} is a symbolic link; the runner only writes regular files (a link can point outside the repository)`);
  }
  if (spec.oldTests) {
    if (!gitOk(root, ['rev-parse', '--verify', '--quiet', spec.oldTests.rev + '^{commit}'])) problems.push(`oldTests: ${spec.oldTests.rev} is not a commit here`);
    else for (const f of spec.oldTests.files) {
      inside(root, f);
      if (!gitOk(root, ['cat-file', '-e', `${spec.oldTests.rev}:${f}`])) problems.push(`oldTests: ${f} does not exist at ${spec.oldTests.rev}`);
      else if (!gitOk(root, ['ls-files', '--error-unmatch', '--', f])) problems.push(`oldTests: ${f} is not tracked by git here, so it could not be restored`);
    }
  }
  if (problems.length) throw new UsageError(`preflight failed; nothing was changed:\n${problems.join('\n')}`);
  mkdirSync(out, { recursive: true });
}

/** 停掉的测试命令的进程组：SIGTERM 之后等这么久再 SIGKILL */
export const KILL_GRACE_MS = 5000;

/**
 * 停掉一次测试命令和它起的一切：整组 SIGTERM，KILL_GRACE_MS 后不论直接子进程在不在都给整组 SIGKILL
 * （包装命令收到 SIGTERM 就退出，它下面的测试进程可能不理 SIGTERM）。pending 记着还没到点的定时器，run() 先结束时立即补发。
 */
export function stopChild(child, pending) {
  if (!child?.pid) return;
  const send = (signal) => { try { process.kill(-child.pid, signal); return; } catch { /* 组已没了 */ } try { child.kill(signal); } catch { /* 已没了 */ } };
  send('SIGTERM');
  const timer = setTimeout(() => { pending?.delete(timer); send('SIGKILL'); }, KILL_GRACE_MS);
  timer.unref();
  pending?.set(timer, send);
}

/** 跑一条命令（不经 shell），输出追加进 fd */
function runOne(state, root, spec, argv, fd) {
  return new Promise((done) => {
    let settled = false, timedOut = false, timer;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); state.child = undefined; done(timedOut ? { ...result, timedOut: true } : result); };
    const exe = argv[0].includes('/') && !isAbsolute(argv[0]) ? resolve(root, argv[0]) : argv[0];
    writeSync(fd, `$ ${JSON.stringify(argv)}\n`);
    // 自己的进程组：停的时候连它起的子进程（pnpm、浏览器、数据库实例）一起停
    const child = spawn(exe, argv.slice(1), { cwd: root, stdio: ['ignore', fd, fd], detached: true });
    state.child = child;
    if (spec.timeoutMs) timer = setTimeout(() => { timedOut = true; stopChild(child, state.pending); }, spec.timeoutMs);
    child.on('error', (error) => finish({ code: -1, error: String(error) }));
    child.on('close', (code, signal) => finish({ code: code ?? -1, signal: signal ?? undefined }));
  });
}

/** 按顺序跑一组命令；第一条非 0 就停，整组算红 */
async function runTests(state, root, spec, list, logPath) {
  const fd = openSync(logPath, 'w');
  try {
    let timedOut = false;
    for (const argv of list) {
      const r = await runOne(state, root, spec, argv, fd);
      timedOut ||= r.timedOut === true;
      writeSync(fd, `# exit ${r.code}${r.signal ? ' ' + r.signal : ''}${r.timedOut ? ' (timeout)' : ''}\n`);
      if (r.code !== 0 || state.interrupted) return { code: r.code === 0 ? -1 : r.code, timedOut };
    }
    return { code: 0, timedOut };
  } finally { closeSync(fd); }
}

/** 把动过的文件放回：先写回原字节，再 git checkout 兜底 */
function restore(root, touched) {
  const tracked = [];
  for (const [rel, bytes] of touched) { writeFileSync(join(root, rel), bytes); tracked.push(rel); }
  touched.clear();
  if (tracked.length) git(root, ['checkout', '--', ...tracked]);
}

const colour = (r) => (r === undefined ? null : r.code === 0 ? 'GREEN' : 'RED');

/** 把旧测试文件（oldTests 在 rev 时的版本）放上；restore() 换回现在的 */
function useOldTests(state, root, spec) {
  for (const f of spec.oldTests.files) {
    const path = inside(root, f);
    if (!state.touched.has(f)) state.touched.set(f, readFileSync(path));
    writeFileSync(path, git(root, ['show', `${spec.oldTests.rev}:${f}`]));
  }
}

async function runMutation(state, root, spec, m, out) {
  const full = inside(root, m.file), original = readFileSync(full), text = original.toString('utf8');
  const next = replaceOccurrence(text, m.find, m.replace, m.occurrence ?? 1);
  if (next === undefined || next === text) throw new IntegrityError(`${m.id}: the mutation did not change ${m.file}`);
  writeFileSync(join(out, 'current.json'), JSON.stringify({ mutation: m.id, file: m.file }) + '\n');
  state.touched.set(m.file, original);
  writeFileSync(full, next);
  if (readFileSync(full, 'utf8') !== next) throw new IntegrityError(`${m.id}: ${m.file} does not read back as written`);
  const narrow = await runTests(state, root, spec, spec.narrow, join(out, `${m.id}.narrow.log`));
  let wide, old;
  if (!state.interrupted && narrow.code === 0 && spec.wide) wide = await runTests(state, root, spec, spec.wide, join(out, `${m.id}.wide.log`));
  const killed = narrow.code !== 0 || (wide !== undefined && wide.code !== 0);
  // 旧测试只回答「PR 之前的测试抓不抓得住」，只对 narrow 抓住的变异问
  if (!state.interrupted && narrow.code !== 0 && spec.oldTests) {
    useOldTests(state, root, spec);
    old = await runTests(state, root, spec, spec.narrow, join(out, `${m.id}.old.log`));
  }
  const verdict = !killed ? 'survived' : narrow.code !== 0 ? (old === undefined ? 'killed' : old.code === 0 ? 'only-new-kills' : 'old-also-kills') : 'killed-by-wide';
  const expected = m.expect ?? 'killed';
  return { id: m.id, narrow: colour(narrow), wide: colour(wide), old: colour(old), verdict, expected, asExpected: (verdict === 'survived') === (expected === 'survived'), timedOut: [narrow, wide, old].some((r) => r?.timedOut === true) };
}

/** 对 root 上的仓库跑已校验的规格，日志写进 out。返回退出码与结果；抛 UsageError（2）或 IntegrityError（3） */
export async function run({ root, spec, out, signals = true }) {
  preflight(root, spec, out);
  const state = { touched: new Map(), child: undefined, interrupted: false, pending: new Map() };
  const onSignal = () => { state.interrupted = true; stopChild(state.child, state.pending); };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (signals) for (const s of SIGNALS) process.on(s, onSignal);
  const results = [];
  let failure;
  try {
    const base = await runTests(state, root, spec, spec.narrow, join(out, 'baseline.log'));
    if (!state.interrupted && base.code !== 0) throw new UsageError(`baseline: the narrow tests are not green before any change (exit ${base.code}); see ${join(out, 'baseline.log')}`);
    // 旧测试是「只有新用例抓得住」的对照：在没改的代码上必须是绿的，否则它「抓住」什么都说明不了
    if (!state.interrupted && spec.oldTests) {
      let old;
      try { useOldTests(state, root, spec); old = await runTests(state, root, spec, spec.narrow, join(out, 'baseline.old.log')); } finally { restore(root, state.touched); }
      if (!state.interrupted && old.code !== 0) throw new UsageError(`baseline: the old tests (${spec.oldTests.files.join(', ')} at ${spec.oldTests.rev}) are not green on the unmutated tree (exit ${old.code}), so "only the new tests catch it" cannot be judged; drop oldTests or pick a rev whose tests pass here. See ${join(out, 'baseline.old.log')}`);
    }
    for (const m of spec.mutations) {
      if (state.interrupted) break;
      let r;
      try { r = await runMutation(state, root, spec, m, out); } finally { restore(root, state.touched); rmSync(join(out, 'current.json'), { force: true }); }
      const dirty = dirtyLines(root);
      if (dirty.length) throw new IntegrityError(`after ${m.id} the tree is not clean:\n${dirty.join('\n')}`);
      if (state.interrupted) break;
      results.push(r);
    }
    if (!state.interrupted) account('mutations', spec.mutations.length, results.length);
  } catch (error) {
    failure = error;
  } finally {
    // 停了还在等 SIGKILL 的，现在就补发：测试起的东西不比运行器活得久
    for (const [timer, send] of state.pending) { clearTimeout(timer); send('SIGKILL'); }
    state.pending.clear();
    restore(root, state.touched);
    if (signals) for (const s of SIGNALS) process.off(s, onSignal);
  }
  const dirty = dirtyLines(root);
  if (failure && (failure instanceof IntegrityError || dirty.length === 0)) throw failure;
  if (dirty.length) throw new IntegrityError(`${failure ? failure.message + '\n' : ''}the tree is not clean at the end:\n${dirty.join('\n')}`);
  const summary = { ran: results.length, defined: spec.mutations.length, results, out };
  if (state.interrupted) return { code: EXIT.interrupted, ...summary };
  return { code: results.every((r) => r.asExpected) ? EXIT.ok : EXIT.survived, ...summary };
}

function line(r) {
  const why = r.verdict === 'only-new-kills' ? 'killed, only by the new tests' : r.verdict === 'old-also-kills' ? 'killed, the old tests too' : r.verdict === 'killed-by-wide' ? 'killed, only by the wide tests' : r.verdict;
  return `${r.id}\tnarrow=${r.narrow}\twide=${r.wide ?? '-'}\told=${r.old ?? '-'}\t${why}${r.timedOut ? '\t(timeout)' : ''}${r.asExpected ? '' : `\t(expected ${r.expected})`}`;
}

export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--root' || a === '--out') { if (!argv[i + 1]) { io.err(`${a} needs a value\n`); return EXIT.usage; } opts[a.slice(2)] = argv[++i]; }
    else if (a.startsWith('--')) { io.err(`unknown option ${a}\n`); return EXIT.usage; }
    else pos.push(a);
  }
  if (pos.length !== 1) { io.err('usage: node scripts/mutation-run.mjs <spec.json> [--root DIR] [--out DIR] [--json]\n'); return EXIT.usage; }
  try {
    const root = realpathSync(opts.root ? resolve(opts.root) : git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) throw new UsageError(`--root ${root} is not the top of a git repository`);
    let text;
    try { text = readFileSync(pos[0], 'utf8'); } catch (e) { throw new UsageError(`cannot read the spec: ${e.message}`); }
    const spec = parseSpec(text);
    const out = opts.out ? resolve(opts.out) : join(root, 'tmp', 'mutation-run', new Date().toISOString().replace(/[:.]/g, '-'));
    const result = await run({ root, spec, out });
    for (const r of result.results) io.out(line(r) + '\n');
    io.out(`ran ${result.ran}/${result.defined} mutations; logs in ${out}${result.code === EXIT.interrupted ? '; interrupted, restored' : ''}\n`);
    if (opts.json) io.out(JSON.stringify(result) + '\n');
    return result.code;
  } catch (error) {
    io.err(`${error.message}\n`);
    return error instanceof UsageError ? EXIT.usage : EXIT.integrity;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
