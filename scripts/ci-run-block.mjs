#!/usr/bin/env node
/**
 * 本机复放 CI 某个 job 的 run 步骤（AGENTS.md 第七节第 2、3 条）。只复放 run，不替 GitHub 跑 actions、不装东西、不取凭据。
 *
 *   node scripts/ci-run-block.mjs --worktree <工作树根> --out <任务输出根> [--job tsc-and-syntax] [--workflow .github/workflows/ci.yml]
 *        [--runtime-dir <短路径>] [--python <已有的 python 命令>] [--step <序号>]... [--step-name <名字片段>]... [--plan] [--review-env]
 *
 * 执行前先核每一步（--plan 只核不跑）：
 *   - uses（actions）不跑，记 not-run:action；带 if 的步骤不求值：failure()/always()/cancelled() 这类诊断条件记 not-run:not-triggered，其余记 insufficient:condition；
 *   - 安装类命令（pnpm/npm/yarn 的 install、i、ci、add，pip/pipx install，python -m pip install，playwright install/install-deps，apt、apt-get，brew install）
 *     不跑，记 not-run:install。按每段命令的子命令判断：npm run ci、pnpm test -- add 这类不算安装；
 *   - env 合并 workflow、job、步骤三层。表达式 env.X 展开；github.workspace 取工作树，runner.temp 取输出根下的 runner-temp；
 *     其余表达式（secrets、steps、hashFiles 等）本机没有，记 insufficient:expression，不猜；
 *   - run 里只剔一种行：行首的浅取（git fetch ... --depth）。剔掉的行逐条记下，其余逐字不动。剔完再做一遍浅取复查，命中就整步不跑。
 *     这道复查是对常见写法的文本兜底：只看 run 文本本身，看不到被调用脚本的内部，也认不出用变量拼出来的命令或选项。
 * 每步在工作树根（或步骤的 working-directory）用 bash -eo pipefail 跑，日志写到输出根，记真实退出码和信号。
 * 结束输出 RUNBLOCK status=PASS|FAIL|INCOMPLETE：选中的步骤全跑了且都过才是 PASS（退出 0）；有一步没过是 FAIL（1）；
 * 没有失败但有步骤没跑（not-run、insufficient）是 INCOMPLETE（3）。用法错误退出 2。脚本跑完不等于 CI 全绿。
 *
 * --python 给一个本机已有的命令（如 python3），在输出根里建 python、python3 两个指向它的链接放在 PATH 最前面；找不到就是用法错误，不装。
 * --runtime-dir 给一个已有的短目录，作 TMPDIR 和 XDG_RUNTIME_DIR（macOS 的 Unix socket 路径有长度上限，长的任务路径会让本机服务起不来）。
 * --review-env：工作树还没有依赖时，经 scripts/worktree-review-env.mjs 借主仓同锁的依赖再跑（同一套边界：已登记的关联工作树、同样的依赖声明和锁）。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHALLOW_FETCH = /^\s*git\s+fetch\b[^\n#]*\s--depth(?:=|\s)/;
/**
 * 剔完以后对剩下的文本再查一遍（文本兜底，见文件头）：git ... fetch|pull 后面出现会改写浅仓状态的选项就整步不跑
 * （insufficient:shallow-fetch）。选项名可以带引号，也可以是 git 接受的缩写（--dep=1 即 --depth、--dee 即 --deepen、
 * --shallow-*、--un 即 --unshallow）。复合命令、子 shell、git -C、环境变量前缀、续行都在这一行文本里，照样认得出。
 */
export const SHALLOW_ANYWHERE = /\bgit\b[^\n]*?\b(?:fetch|pull)\b[^\n]*?(?:\s|^)['"]?--(?:dep|dee|shallow|un)[a-z-]*/;

/**
 * 浅取复查看的文本：续行拼回一行，去掉不会执行的文字——行内注释（引号外、行首或空白后的 #），以及纯文字的
 * echo/printf 段（按 ; & && || 切段）。只要这一行有管道、重定向、进程替换或命令替换（| < > <( >( $( 反引号），
 * echo/printf 的内容可能被交给 shell 或写成脚本再跑，这一行就一段也不剔。认不准的一律留着，宁可多拒。
 */
export function executableText(run) {
  return String(run).replace(/\\\n\s*/g, ' ').split('\n').map((line) => {
    let quote = null, cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) { if (ch === quote) quote = null; else if (ch === '\\' && quote === '"') i++; continue; }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '\\') i++;
      else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) { cut = i; break; }
    }
    const code = line.slice(0, cut);
    if (/\$\(|\x60|[<>]|(?:^|[^|])\|(?!\|)/.test(code)) return code;
    return code.split(/(\|\||&&|[;&])/)
      .map((seg) => (/^\s*(?:echo|printf)\b/.test(seg) ? '' : seg)).join('');
  }).join('\n');
}

/** 包管理器的这些选项后面跟一个值，找子命令时连值一起跳过 */
const VALUE_OPTS = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '-w', '--workspace', '--cwd']);

/**
 * 安装类命令：按段（换行、; & | && || 和括号）切开，在段里**任意位置**找包管理器，从它那里取子命令判断，认得出的都不跑。
 * 所以前缀与包装不影响（time、env、nohup、timeout 60、exec、xargs、!、corepack、retry 4、sudo timeout 240 …）。
 * 包管理器隔着选项（-C dir、--filter x、--prefix x）再跟 install/i/ci/add 的算；npm run ci、pnpm test -- add 不算。
 * playwright 后面跟 install…（install、install-deps）在哪都算；apt、apt-get 在哪都算。认不准的偏向「算安装、不跑」。
 */
export function isInstall(run) {
  for (const seg of String(run).replace(/\\\n\s*/g, ' ').split(/\n|\|\||&&|[;|&()]/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]+|['"]+$/g, ''));
    for (let i = 0; i < t.length; i++) {
      const cmd = t[i], rest = t.slice(i + 1);
      if (cmd === 'playwright' && /^install/.test(rest[0] ?? '')) return true;
      if (cmd === 'apt' || cmd === 'apt-get') return true;
      let j = 0;
      while (j < rest.length && rest[j].startsWith('-')) j += VALUE_OPTS.has(rest[j]) ? 2 : 1;
      const sub = rest[j];
      if ((cmd === 'brew' || /^pip(?:x|[0-9.]*)$/.test(cmd)) && sub === 'install') return true;
      if (/^python[0-9.]*$/.test(cmd) && rest[0] === '-m' && rest[1] === 'pip' && rest[2] === 'install') return true;
      if (cmd === 'yarn' && sub === undefined) return true;
      if ((cmd === 'pnpm' || cmd === 'npm' || cmd === 'yarn') && ['i', 'install', 'ci', 'add'].includes(sub)) return true;
    }
  }
  return false;
}

/** --review-env 时交给 worktree-review-env 的内层参数：去掉 --review-env，补上 --inside-review-env，其余原样、顺序不变 */
export function innerArgs(argv) { return [...argv.filter((a) => a !== '--review-env'), '--inside-review-env']; }
/** 只有外层（带 --review-env、不带 --inside-review-env）才转交，内层不再转交，免得无限套娃 */
export function reexecForReviewEnv(o) { return o.reviewEnv && !o.inside; }
/** 只在失败、取消时才跑的诊断步骤：本机不求值，记「未触发」。always() 在 CI 里恒跑，不算这一类（记材料不足） */
const DIAGNOSTIC_IF = /^\s*(?:\$\{\{\s*)?(failure|cancelled)\s*\(\s*\)\s*(?:\}\})?\s*$|^\s*(?:\$\{\{\s*)?(failure|cancelled)\s*\(\s*\)\s*(\|\||&&)/;
const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;
export const SOCKET_ROOT_MAX = 80;

export class UsageError extends Error {}

/** 短 runtime 根的长度上限：恰好 SOCKET_ROOT_MAX 字节照收，多一个字节就拒 */
export function runtimeTooLong(path) { return Buffer.byteLength(path) > SOCKET_ROOT_MAX; }

/** 解析命令行。值缺失、未知参数、必需参数缺失都是用法错误 */
export function parseArgs(argv) {
  const o = { job: 'tsc-and-syntax', workflow: '.github/workflows/ci.yml', steps: [], names: [], plan: false, reviewEnv: false, inside: false };
  const take = (i) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(argv[i] + ' 要跟一个值'); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worktree') o.worktree = take(i++);
    else if (a === '--out') o.out = take(i++);
    else if (a === '--job') o.job = take(i++);
    else if (a === '--workflow') o.workflow = take(i++);
    else if (a === '--runtime-dir') o.runtime = take(i++);
    else if (a === '--python') o.python = take(i++);
    else if (a === '--step') { const n = Number(take(i++)); if (!Number.isInteger(n) || n < 1) throw new UsageError('--step 要写步骤序号（从 1 起）'); o.steps.push(n); }
    else if (a === '--step-name') o.names.push(take(i++));
    else if (a === '--plan') o.plan = true;
    else if (a === '--review-env') o.reviewEnv = true;
    else if (a === '--inside-review-env') o.inside = true;
    else throw new UsageError('不认识的参数：' + a);
  }
  if (!o.worktree || !o.out) throw new UsageError('--worktree 和 --out 必须显式给出');
  return o;
}

/** 展开一段文字里的 GitHub 表达式：能确定的换成值，其余原样留着并记进 unknown */
export function expand(text, ctx, unknown) {
  return String(text).replace(EXPR, (whole, expr) => {
    const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
    if (env && Object.hasOwn(ctx.env, env[1])) return ctx.env[env[1]];
    if (expr === 'github.workspace') return ctx.workspace;
    if (expr === 'runner.temp') return ctx.runnerTemp;
    unknown.add(expr);
    return whole;
  });
}

/** 剔掉会改写共享 Git 状态的浅取行，别的行逐字不动 */
export function stripShallowFetch(run) {
  const removed = [];
  const kept = String(run).split('\n').filter((line) => {
    if (!SHALLOW_FETCH.test(line)) return true;
    removed.push(line.trim());
    return false;
  });
  return { run: kept.join('\n'), removed };
}

/** 一步要不要跑、怎么跑：执行前的核对，不碰文件和进程 */
export function classify(step, index, baseEnv, ctx) {
  const name = step.name ?? (step.uses ? 'uses ' + step.uses : typeof step.run === 'string' ? step.run.split('\n')[0].slice(0, 80) : '(无名)');
  const out = { index, name, status: 'run', reason: '', removed: [], unknown: [] };
  if (step.uses) return { ...out, status: 'not-run', reason: 'action' };
  if (step.if !== undefined) {
    const diag = DIAGNOSTIC_IF.test(String(step.if));
    return { ...out, status: diag ? 'not-run' : 'insufficient', reason: diag ? 'not-triggered' : 'condition', detail: String(step.if) };
  }
  if (typeof step.run !== 'string') return { ...out, status: 'insufficient', reason: 'no-run' };
  const unknown = new Set();
  const env = { ...baseEnv };
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = expand(v, { ...ctx, env }, unknown);
  const { run, removed } = stripShallowFetch(step.run);
  if (SHALLOW_ANYWHERE.test(executableText(run))) return { ...out, status: 'insufficient', reason: 'shallow-fetch', removed };
  const text = expand(run, { ...ctx, env }, unknown);
  const workdir = step['working-directory'] ? expand(step['working-directory'], { ...ctx, env }, unknown) : null;
  if (unknown.size) return { ...out, status: 'insufficient', reason: 'expression', unknown: [...unknown], removed };
  if (isInstall(run)) return { ...out, status: 'not-run', reason: 'install', removed };
  if (!run.trim()) return { ...out, status: 'not-run', reason: 'shallow-fetch-only', removed };
  return { ...out, run: text, env, removed, workdir };
}

/** 读 workflow，取出 job 的步骤和合并好的 env（workflow 层再 job 层） */
export function loadJob(text, job, parseYaml, ctx) {
  const doc = parseYaml(text);
  const j = doc && doc.jobs ? doc.jobs[job] : undefined;
  if (!j || !Array.isArray(j.steps)) throw new UsageError('workflow 里没有 job「' + job + '」或它没有 steps');
  const unknown = new Set();
  const env = {};
  for (const layer of [doc.env ?? {}, j.env ?? {}]) for (const [k, v] of Object.entries(layer)) env[k] = expand(v, { ...ctx, env }, unknown);
  return { steps: j.steps, env, unknown: [...unknown] };
}

/** 汇总：全跑且全过才 PASS；有失败 FAIL；没失败但有没跑的 INCOMPLETE */
export function summarize(results) {
  const n = (f) => results.filter(f).length;
  const failed = n((r) => r.status === 'fail'), passed = n((r) => r.status === 'pass');
  const notRun = n((r) => r.status === 'not-run' || r.status === 'insufficient');
  const status = failed ? 'FAIL' : notRun || !results.length ? 'INCOMPLETE' : 'PASS';
  return { status, code: status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 3, selected: results.length, passed, failed, not_run: notRun };
}

function git(cwd, ...args) { return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); }

/**
 * 选中的 python 自己报告的解释器路径（sys.executable）。macOS 的 /usr/bin/python3 是按调用名分发的转发器，
 * 直接把它链成 python 会去找名叫 python 的工具；链到它报告的真解释器才不受调用名影响。
 */
function resolvePython(cmd, pathEnv) {
  for (const dir of String(pathEnv).split(delimiter)) {
    const p = join(dir, cmd);
    try { if (!statSync(p).isFile()) continue; } catch { continue; }
    const r = spawnSync(p, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 20000 });
    const exe = r.status === 0 ? r.stdout.trim() : '';
    if (exe && isAbsolute(exe) && existsSync(exe)) return realpathSync(exe);
    throw new UsageError('--python ' + cmd + ' 报告不出自己的解释器路径（' + (r.stderr || '').trim().slice(0, 200) + '）；本入口不装 python');
  }
  throw new UsageError('--python ' + cmd + ' 在 PATH 里找不到；本入口不装 python');
}

export async function main(argv) {
  const o = parseArgs(argv);
  const worktree = realpathSync(resolve(o.worktree));
  const top = git(worktree, 'rev-parse', '--show-toplevel');
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== worktree) throw new UsageError('--worktree 要是一个 Git 工作树的根');
  const here = fileURLToPath(import.meta.url);
  if (reexecForReviewEnv(o)) {
    // 依赖借主仓同锁的那份：边界、准备和清理都交给 worktree-review-env，自己只在里面再跑一遍
    const r = spawnSync(process.execPath, [join(worktree, 'scripts/worktree-review-env.mjs'), worktree, '--', process.execPath, here, ...innerArgs(argv)], { stdio: 'inherit' });
    return r.status ?? 1;
  }
  const outArg = isAbsolute(o.out) ? o.out : resolve(o.out);
  mkdirSync(outArg, { recursive: true });
  const out = realpathSync(outArg);
  if (out === worktree) throw new UsageError('--out 不能是工作树根');
  if (out.startsWith(worktree + '/') && git(worktree, 'check-ignore', '-q', join(out, 'probe')).status !== 0) throw new UsageError('--out 在工作树里时要在被忽略的目录下（如 tmp/<任务>/）');
  let runtime = null;
  if (o.runtime) {
    runtime = realpathSync(resolve(o.runtime));
    if (!statSync(runtime).isDirectory()) throw new UsageError('--runtime-dir 要是已有的目录');
    if (runtimeTooLong(runtime)) throw new UsageError('--runtime-dir 太长（' + Buffer.byteLength(runtime) + ' 字节，上限 ' + SOCKET_ROOT_MAX + '），本机 socket 会超限');
  }
  const require = createRequire(join(worktree, 'server/package.json'));
  let parseYaml;
  try { parseYaml = require('yaml').parse; } catch { throw new UsageError('server 的 yaml 解析器加载不了：工作树没有依赖，可加 --review-env'); }
  const runnerTemp = join(out, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  const ctx = { workspace: worktree, runnerTemp, env: {} };
  const job = loadJob(readFileSync(resolve(worktree, o.workflow), 'utf8'), o.job, parseYaml, ctx);
  const env = { ...process.env, ...job.env, CI: 'true', GITHUB_WORKSPACE: worktree, RUNNER_TEMP: runnerTemp };
  if (runtime) Object.assign(env, { TMPDIR: runtime, XDG_RUNTIME_DIR: runtime });
  if (o.python) {
    const py = resolvePython(o.python, env.PATH);
    const shim = join(out, 'python-shim');
    mkdirSync(shim, { recursive: true });
    for (const n of ['python', 'python3']) if (!existsSync(join(shim, n))) symlinkSync(py, join(shim, n));
    env.PATH = shim + delimiter + env.PATH;
  }
  const chosen = job.steps.map((s, i) => [s, i + 1]).filter(([s, i]) => (!o.steps.length && !o.names.length) || o.steps.includes(i) || o.names.some((n) => String(s.name ?? '').includes(n)));
  if (!chosen.length) throw new UsageError('没有选中任何步骤');
  const plan = chosen.map(([s, i]) => (job.unknown.length ? { index: i, name: s.name ?? '', status: 'insufficient', reason: 'job-env-expression', unknown: job.unknown, removed: [] } : classify(s, i, job.env, ctx)));
  const results = [];
  for (const p of plan) {
    if (p.status !== 'run') { results.push(p); continue; }
    if (o.plan) { results.push({ ...p, status: 'not-run', reason: 'plan-only', run: undefined, env: undefined }); continue; }
    const log = join(out, 'step-' + String(p.index).padStart(3, '0') + '.log');
    const t0 = Date.now();
    const r = spawnSync('bash', ['-eo', 'pipefail', '-c', p.run], { cwd: p.workdir ? resolve(worktree, p.workdir) : worktree, env: { ...env, ...p.env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    writeFileSync(log, (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? '\n[ci-run-block] ' + r.error.message + '\n' : ''));
    const exit = r.status ?? (r.signal ? 128 : 1);
    results.push({ index: p.index, name: p.name, status: exit === 0 ? 'pass' : 'fail', exit, signal: r.signal ?? null, ms: Date.now() - t0, log, removed: p.removed });
    console.log('STEP ' + p.index + ' ' + (exit === 0 ? 'pass' : 'fail') + ' exit=' + exit + ' ' + p.name);
  }
  for (const r of results) if (r.status !== 'pass' && r.status !== 'fail') console.log('STEP ' + r.index + ' ' + r.status + ':' + r.reason + (r.unknown && r.unknown.length ? ' ' + r.unknown.join(',') : '') + ' ' + r.name);
  for (const r of results) for (const line of r.removed ?? []) console.log('STRIPPED step ' + r.index + ': ' + line);
  const sum = summarize(results);
  const resultsFile = join(out, 'results.json');
  writeFileSync(resultsFile, JSON.stringify({ worktree, head: git(worktree, 'rev-parse', 'HEAD').stdout.trim(), job: o.job, workflow: o.workflow, plan: o.plan, summary: sum, results }, null, 2));
  console.log('RUNBLOCK status=' + sum.status + ' selected=' + sum.selected + ' passed=' + sum.passed + ' failed=' + sum.failed + ' not_run=' + sum.not_run + ' results=' + resultsFile);
  return sum.code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (e) { console.error('ci-run-block: ' + e.message); process.exitCode = e instanceof UsageError ? 2 : 1; }
}
