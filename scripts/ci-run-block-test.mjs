#!/usr/bin/env node
/**
 * scripts/ci-run-block.mjs 的正反例。纯函数部分直接调；端到端用 tmp/ 下的合成 workflow 起子进程，不碰真实 CI、不联网、不装东西。
 *
 *   node scripts/ci-run-block-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SOCKET_ROOT_MAX, UsageError, checkoutDecls, classify, expand, materialGaps, parseArgs, runtimeTooLong, stripShallowFetch, summarize } from './ci-run-block.mjs';

const ROOT = resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))); } };
const J = (x) => JSON.stringify(x);
const usageOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e instanceof UsageError ? 'usage' : 'throw'; } };
const ctx = { workspace: '/w', runnerTemp: '/o/runner-temp', env: {} };

console.log('一、执行前的核对（纯函数）');
{
  const s = stripShallowFetch('git fetch --no-tags --depth=1 origin main\n  git fetch --depth 5 origin x\ngit fetch origin main\necho git fetch --depth=1\nnode scripts/tech-route-check.mjs --strict');
  ok('只剔会改写共享 Git 的浅取行（--depth=1、--depth 5）；普通 fetch、echo 里提到的、其他命令逐字留着',
    J(s.removed) === J(['git fetch --no-tags --depth=1 origin main', 'git fetch --depth 5 origin x']) && s.run === 'git fetch origin main\necho git fetch --depth=1\nnode scripts/tech-route-check.mjs --strict', s);
  const unknown = new Set();
  const t = expand('a=$' + '{{ env.A }} w=$' + '{{ github.workspace }} t=$' + '{{ runner.temp }} s=$' + '{{ secrets.TOKEN }} h=$' + "{{ hashFiles('x') }}", { ...ctx, env: { A: '1' } }, unknown);
  ok('表达式：env.X、github.workspace、runner.temp 展开；secrets、hashFiles 原样留着并记下（不猜、不取凭据）',
    t === 'a=1 w=/w t=/o/runner-temp s=$' + '{{ secrets.TOKEN }} h=$' + "{{ hashFiles('x') }}" && J([...unknown]) === J(['secrets.TOKEN', "hashFiles('x')"]), [t, [...unknown]]);
  const c = (step) => { const r = classify(step, 1, { BASE: 'b' }, ctx); return r.status + ':' + r.reason; };
  const got = {
    action: c({ uses: 'actions/checkout@v4' }),
    diag: c({ name: 'd', if: 'failure()', run: 'cat log' }),
    cond: c({ name: 'c', if: "github.event_name == 'push'", run: 'echo x' }),
    install: c({ name: 'i', run: 'pnpm install --frozen-lockfile' }),
    pip: c({ name: 'p', run: 'python3 -m pip install x' }),
    secret: c({ name: 's', run: 'echo $' + '{{ secrets.T }}' }),
    stepEnvSecret: c({ name: 's2', env: { T: '$' + '{{ secrets.T }}' }, run: 'echo hi' }),
    onlyFetch: c({ name: 'f', run: 'git fetch --no-tags --depth=1 origin main' }),
    plain: c({ name: 'r', run: 'echo $BASE' }),
  };
  ok('分类：actions 不跑；failure() 这类诊断条件记未触发；别的 if 记材料不足；安装不跑；未知表达式（run 或步骤 env 里）材料不足；只有浅取的步骤剔完不跑；普通 run 照跑',
    J(got) === J({ action: 'not-run:action', diag: 'not-run:not-triggered', cond: 'insufficient:condition', install: 'not-run:install', pip: 'not-run:install', secret: 'insufficient:expression', stepEnvSecret: 'insufficient:expression', onlyFetch: 'not-run:shallow-fetch-only', plain: 'run:' }), got);
  // #1084 B1：剔完以后任何形式残留的浅取都不跑（不论在行首、复合命令、子 shell、续行里，还是 --deepen、--shallow-*）
  const shallow = {
    chained: 'echo a && git fetch --no-tags --depth=1 origin main',
    semicolon: 'echo a; git fetch --depth 1 origin main',
    subshell: '(git fetch --depth=1 origin main)',
    ifThen: 'if true; then git fetch --deepen=1 origin; fi',
    dashC: 'git -C /some/dir fetch --depth=1 origin main',
    envPrefix: 'GIT_TRACE=1 git fetch --depth=1 origin main',
    continued: 'git \\\n  fetch --depth=1 origin main',
    depthAtEnd: 'git fetch origin main --depth=1',
    since: 'git fetch --shallow-since=2020-01-01 origin',
    exclude: 'git fetch --shallow-exclude=v1 origin',
    unshallow: 'git fetch --unshallow origin',
  };
  const shallowGot = Object.fromEntries(Object.entries(shallow).map(([k, run]) => [k, c({ name: k, run })]));
  ok('浅取的各种写法（复合命令、子 shell、if、git -C、环境变量前缀、反斜杠续行、--depth 在行尾、--deepen、--shallow-since/exclude、--unshallow）：一律不跑。行首那种剔掉后记 shallow-fetch-only，其余记 insufficient:shallow-fetch',
    shallowGot.depthAtEnd === 'not-run:shallow-fetch-only' && Object.entries(shallowGot).filter(([k]) => k !== 'depthAtEnd').every(([, v]) => v === 'insufficient:shallow-fetch'), shallowGot);
  ok('普通 fetch 照跑；行首那一种照旧剔掉后不跑', c({ name: 'f2', run: 'git fetch origin main' }) === 'run:' && c({ name: 'f3', run: 'git fetch --no-tags --depth=1 origin main\necho ok' }) === 'run:');
  const inst = ['pnpm -C server install', 'pnpm --filter web install', 'pnpm exec playwright install chromium', 'playwright install --with-deps', 'npm --prefix x ci', 'yarn install', 'pnpm add left-pad', 'pipx install x', 'pip3.11 install x', 'python3 -m pip install -r r.txt'];
  const instGot = Object.fromEntries(inst.map((run) => [run, c({ name: 'i', run })]));
  const notInst = ['pnpm --filter web typecheck', 'pnpm test', 'node scripts/install-check-test.mjs', 'npm run build'];
  const notInstGot = Object.fromEntries(notInst.map((run) => [run, c({ name: 'n', run })]));
  ok('安装：包管理器隔着选项再跟 install/ci/add、pnpm exec 或裸 playwright install、pipx、pip3.11、python -m pip 都认出来不跑；typecheck、test、脚本名里带 install、npm run 照跑',
    Object.values(instGot).every((v) => v === 'not-run:install') && Object.values(notInstGot).every((v) => v === 'run:'), [instGot, notInstGot]);
  const ifs = { always: c({ name: 'a', if: 'always()', run: 'x' }), notCancelled: c({ name: 'nc', if: '!cancelled()', run: 'x' }), failure: c({ name: 'f', if: 'failure()', run: 'x' }), wrapped: c({ name: 'w', if: '$' + '{{ failure() }}', run: 'x' }), failureAnd: c({ name: 'fa', if: "failure() && steps.x.outcome == 'failure'", run: 'x' }) };
  ok('条件：always()、!cancelled() 在 CI 里会跑，本机不求值，记材料不足；failure()、cancelled() 开头的诊断才记未触发',
    J(ifs) === J({ always: 'insufficient:condition', notCancelled: 'insufficient:condition', failure: 'not-run:not-triggered', wrapped: 'not-run:not-triggered', failureAnd: 'not-run:not-triggered' }), ifs);
  ok('短 runtime 根恰好 ' + SOCKET_ROOT_MAX + ' 字节照收，多 1 字节就拒（按字节算，中文按 UTF-8）',
    runtimeTooLong('/' + 'a'.repeat(SOCKET_ROOT_MAX - 1)) === false && runtimeTooLong('/' + 'a'.repeat(SOCKET_ROOT_MAX)) === true && runtimeTooLong('/' + '中'.repeat(27)) === true);
  const r = classify({ name: 'e', env: { X: '$' + '{{ env.BASE }}-x' }, run: 'echo "$X"' }, 2, { BASE: 'b' }, ctx);
  ok('步骤 env 可以引用 job 层 env；run 本身逐字不改', r.status === 'run' && r.env.X === 'b-x' && r.run === 'echo "$X"', r);
  const S = (...st) => summarize(st.map((status) => ({ status })));
  ok('汇总：全跑全过 PASS/0；有失败 FAIL/1；没失败但有没跑的 INCOMPLETE/3；一步都没有也不算 PASS',
    J([S('pass', 'pass'), S('pass', 'fail', 'not-run'), S('pass', 'not-run'), S('pass', 'insufficient'), S()].map((x) => x.status + '/' + x.code)) === J(['PASS/0', 'FAIL/1', 'INCOMPLETE/3', 'INCOMPLETE/3', 'INCOMPLETE/3']));
  ok('参数：--worktree、--out 必须显式；不认识的参数、--step 0、值缺失都是用法错误',
    J([usageOf(() => parseArgs(['--out', 'x'])), usageOf(() => parseArgs(['--worktree', 'x'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', 'o', '--nope'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', 'o', '--step', '0'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', '--plan'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', 'o', '--step', '2', '--step-name', 'x']))])
      === J(['usage', 'usage', 'usage', 'usage', 'usage', 'ok']));
}

console.log('一b、上游材料预检（纯函数；夹具只在 tmp/）');
{
  const base = join(ROOT, 'tmp', 'ci-run-block-material-' + process.pid);
  rmSync(base, { recursive: true, force: true });
  try {
    const ws = join(base, 'ws'), up = join(ws, 'up');
    mkdirSync(join(up, 'src'), { recursive: true });
    const c2 = { workspace: ws, runnerTemp: join(base, 'rt'), env: {} };
    const steps = [
      { uses: 'actions/checkout@v4' },
      { uses: 'actions/checkout@v4', with: { repository: 'example/up', ref: 'abc123', path: 'up' } },
      { uses: 'actions/setup-node@v4' },
      { uses: 'actions/checkout@v4', with: { repository: 'example/other' } },
    ];
    const d = checkoutDecls(steps, c2);
    ok('checkout 声明：本仓那份不算上游；带 repository 和 path 的记 repository、ref、path 并展开成工作区里的目录；没给 path 的上游不当材料目录；别的 action 不算',
      d.length === 3 && d[0].upstream === false && d[1].upstream === true && d[1].repository === 'example/up' && d[1].ref === 'abc123' && d[1].dir === up && d[2].upstream === false, d);
    const a = join(up, 'src', 'a.ts');
    const g0 = materialGaps({ SRC: a, OTHER: '/usr/bin/env', REL: 'up/src/a.ts' }, d);
    ok('缺主文件：点名 env、所缺路径、来自哪一步 checkout、哪个仓哪个提交；上游目录之外的绝对路径和相对写法不管',
      g0.length === 1 && g0[0].env === 'SRC' && g0[0].path === a && g0[0].checkout === 2 && g0[0].repository === 'example/up' && g0[0].ref === 'abc123', g0);
    writeFileSync(a, "import { b } from './b.ts';\nimport type { T } from './types.ts';\nexport { c } from '../lib/c.mjs';\nimport './side.ts';\nconst x = await import('./dyn.ts');\nimport { y } from 'node:fs';\nimport { z } from '../../outside.ts';\n");
    const g1 = materialGaps({ SRC: a }, d).map((g) => g.path).sort();
    const want = [join(up, 'lib', 'c.mjs'), join(up, 'src', 'b.ts'), join(up, 'src', 'dyn.ts'), join(up, 'src', 'side.ts')].sort();
    ok('主文件在、相对依赖缺：顺着 import / export from / 裸 import / 动态 import 查出所缺依赖；import type 不算；包名与目录外的相对引入不管',
      J(g1) === J(want), g1);
    for (const p of want) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, p.endsWith('b.ts') ? "import { e } from './e.ts';\n" : '\n'); }
    const g2 = materialGaps({ SRC: a }, d).map((g) => g.path);
    ok('依赖的依赖也查（b.ts 再引 e.ts）', J(g2) === J([join(up, 'src', 'e.ts')]), g2);
    writeFileSync(join(up, 'src', 'e.ts'), '\n');
    ok('材料齐全：没有缺口；env 里直接指上游目录本身也算在内且不报缺', materialGaps({ SRC: a, DIR: up }, d).length === 0);
    ok('本仓 checkout 不核材料：指向工作区里不存在的文件也不报（那是工作树本身的事）', materialGaps({ X: join(ws, 'nope.ts') }, d).length === 0);
    ok('同前缀的兄弟目录（up 之外的 upper/）不算在上游目录里', materialGaps({ SIB: join(ws, 'upper', 'x.ts') }, d).length === 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

console.log('二、端到端（合成 workflow，在本仓库 tmp/ 下）');
{
  const base = join(ROOT, 'tmp', 'ci-run-block-test-' + process.pid);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  try {
  const wf = join(base, 'wf.yml');
  writeFileSync(wf, [
    'env:',
    '  TOP: top-value',
    'jobs:',
    '  j:',
    '    env:',
    '      MID: $' + '{{ env.TOP }}-mid',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: ok-step',
    '        env:',
    '          OWN: own',
    '        run: |',
    '          git fetch --no-tags --depth=1 no-such-remote-for-ci-run-block main',
    '          echo "$MID $OWN $' + '{{ runner.temp }}" > "$RUNNER_TEMP/marker.txt"',
    '      - name: fail-step',
    '        run: exit 7',
    '      - name: python-step',
    '        run: python -c "import sys; print(sys.version_info[0])"',
    '      - name: signal-step',
    '        run: kill -TERM $$',
    '      - name: diag',
    '        if: failure()',
    '        run: echo diag',
    '',
  ].join('\n'));
  const run = (...args) => { const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', ROOT, '--workflow', 'tmp/ci-run-block-test-' + process.pid + '/wf.yml', '--job', 'j', ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  const results = (out) => JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));

  const o1 = join(base, 'o1');
  const r1 = run('--out', o1, '--step-name', 'ok-step');
  const m = existsSync(join(o1, 'runner-temp', 'marker.txt')) ? readFileSync(join(o1, 'runner-temp', 'marker.txt'), 'utf8').trim() : '';
  ok('只选通过的一步：PASS 退出 0；浅取行被剔并点名（没去拉不存在的远端）；workflow→job→步骤三层 env 与 runner.temp 都展开了',
    r1.code === 0 && /RUNBLOCK status=PASS selected=1 passed=1/.test(r1.out) && /STRIPPED step 2: git fetch --no-tags --depth=1 no-such-remote/.test(r1.out) && m === 'top-value-mid own ' + join(o1, 'runner-temp'), [r1.code, r1.out.slice(-300), m]);

  const o2 = join(base, 'o2');
  const r2 = run('--out', o2);
  const res2 = results(o2).results;
  ok('全部步骤：有一步退出 7 就是 FAIL 退出 1；每步按身份记：action 未跑、失败那步记真实退出码 7、被信号杀掉的那步记 SIGTERM 且算失败、诊断步骤未触发，没被算成通过',
    r2.code === 1 && /RUNBLOCK status=FAIL/.test(r2.out) && res2.find((x) => x.name === 'fail-step')?.exit === 7 && res2.find((x) => x.index === 1)?.reason === 'action' && res2.find((x) => x.name === 'diag')?.reason === 'not-triggered'
    && res2.find((x) => x.name === 'signal-step')?.status === 'fail' && res2.find((x) => x.name === 'signal-step')?.signal === 'SIGTERM',
    [r2.code, res2.map((x) => x.index + ':' + x.status + ':' + (x.reason ?? x.exit))]);

  const o3 = join(base, 'o3');
  const r3 = run('--out', o3, '--step', '1', '--step', '2');
  ok('选中的步骤里有没跑的（action），即使其余都过：INCOMPLETE 退出 3，不冒充全绿', r3.code === 3 && /RUNBLOCK status=INCOMPLETE selected=2 passed=1 failed=0 not_run=1/.test(r3.out), [r3.code, r3.out.slice(-200)]);

  const o4 = join(base, 'o4');
  const r4 = run('--out', o4, '--plan');
  ok('--plan 只核不跑：没有步骤日志，退出 3', r4.code === 3 && !existsSync(join(o4, 'step-002.log')) && results(o4).results.every((x) => x.status !== 'pass'), [r4.code]);

  const pyCmd = ['python3', 'python'].find((c) => spawnSync(c, ['-c', 'pass']).status === 0);
  if (pyCmd) {
    const o5 = join(base, 'o5');
    const r5 = run('--out', o5, '--step-name', 'python-step', '--python', pyCmd);
    ok('--python 用本机已有的 ' + pyCmd + '：run 里写的 python 指向它，步骤通过', r5.code === 0 && existsSync(join(o5, 'step-004.log')) && readFileSync(join(o5, 'step-004.log'), 'utf8').trim() === '3', [r5.code, r5.out.slice(-200)]);
  } else ok('（本机没有 python，跳过 --python 正例）', true);

  const bad = {
    noPython: run('--out', join(base, 'o6'), '--python', 'no-such-python-for-ci-run-block').code,
    // 不依赖仓库在哪：专门建一个肯定超过上限的目录（CI 机器上仓库路径比本机短）
    longRuntime: (() => { const long = join(base, 'r'.repeat(SOCKET_ROOT_MAX)); mkdirSync(long, { recursive: true }); return run('--out', join(base, 'o7'), '--runtime-dir', long).code; })(),
    trackedOut: run('--out', join(ROOT, 'scripts')).code,
    noJob: spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', ROOT, '--out', join(base, 'o8'), '--workflow', 'tmp/ci-run-block-test-' + process.pid + '/wf.yml', '--job', 'ghost'], { encoding: 'utf8' }).status,
    notRoot: spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', join(ROOT, 'scripts'), '--out', join(base, 'o9')], { encoding: 'utf8' }).status,
  };
  ok('用法错误退出 2：--python 找不到（不装）、--runtime-dir 太长、--out 是被跟踪的目录、没有这个 job、--worktree 不是工作树根',
    Object.values(bad).every((c) => c === 2) && !existsSync(join(ROOT, 'scripts', 'results.json')), bad);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

console.log('二b、端到端：上游材料预检（合成 workflow，材料只在 tmp/）');
{
  const rel = 'tmp/ci-run-block-mat-e2e-' + process.pid;
  const base = join(ROOT, rel);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  try {
    const up = join(base, 'up'), a = join(up, 'src', 'a.ts'), b = join(up, 'src', 'b.ts');
    const workflow = (path, source = rel + '/up/src/a.ts') => writeFileSync(join(base, 'wf.yml'), [
      'env:', '  TOP: ' + rel, 'jobs:', '  mat:', '    runs-on: ubuntu-latest', '    env:', '      UP: $' + '{{ env.TOP }}/up', '    steps:',
      '      - uses: actions/checkout@v4', '        with:', '          repository: example/up', '          ref: abc123', '          path: ' + path,
      '      - name: uses material', '        env:', '          SRC: $' + '{{ github.workspace }}/' + source,
      '        run: node "$SRC"', ''].join('\n'));
    workflow(rel + '/up');
    const run = (o) => { const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', ROOT, '--workflow', rel + '/wf.yml', '--job', 'mat', '--step', '2', '--out', join(base, o)], { encoding: 'utf8' }); return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }; };
    const r1 = run('o1');
    ok('缺主文件：执行前列出 checkout 声明（仓、提交、路径），点名所缺路径，这一步记 insufficient:material 不跑（没有步骤日志），INCOMPLETE 退出 3',
      r1.code === 3 && r1.out.includes('CHECKOUT step 1 repository=example/up ref=abc123 path=' + rel + '/up') && r1.out.includes('MATERIAL step 2 missing ' + a) && /STEP 2 insufficient:material/.test(r1.out) && !existsSync(join(base, 'o1', 'step-002.log')) && /RUNBLOCK status=INCOMPLETE/.test(r1.out), r1);
    mkdirSync(join(up, 'src'), { recursive: true });
    writeFileSync(a, "import { b } from './b.ts';\n");
    const r2 = run('o2');
    ok('主文件在、相对依赖缺：只点名依赖 b.ts，仍不跑、INCOMPLETE', r2.code === 3 && r2.out.includes('MATERIAL step 2 missing ' + b) && !r2.out.includes('missing ' + a) && !existsSync(join(base, 'o2', 'step-002.log')), r2);
    writeFileSync(b, 'export const b = 1;\n');
    writeFileSync(a, "import './b.ts';\nconsole.log('material-ok');\n");
    const r3 = run('o3');
    const res = JSON.parse(readFileSync(join(base, 'o3', 'results.json'), 'utf8'));
    ok('材料齐全：照常执行、PASS 退出 0；results.json 带上 checkout 声明',
      r3.code === 0 && !r3.out.includes('MATERIAL ') && readFileSync(join(base, 'o3', 'step-002.log'), 'utf8').includes('material-ok') && res.checkouts.some((d) => d.repository === 'example/up' && d.ref === 'abc123'), r3);
    const samples = [
      ['注释里的假 import', "// import './line-comment.ts';\n/* export * from './block-comment.ts'; */"],
      ['字符串和模板里的假 import', "const quoted = \"import './quoted.ts'\"; const template = `export * from './template.ts'`;"],
      ['只作类型的 import 和 export', "import type { T } from './type-only.ts';\nexport type { U } from './types.ts';"],
    ];
    for (const [idx, [label, input]] of samples.entries()) {
      writeFileSync(a, input + "\nconsole.log('material-ok');\n");
      const out = 'text-' + idx;
      const r = run(out);
      const log = join(base, out, 'step-002.log');
      ok(label + '：材料齐全，实际执行', r.code === 0 && !r.out.includes('MATERIAL ') && existsSync(log) && readFileSync(log, 'utf8').includes('material-ok'), r);
    }
    writeFileSync(a, "import('./no-runtime-module.ts', {});\n");
    const dyn = run('dynamic');
    ok('带选项的字面量动态 import 缺文件时在执行前停下', dyn.code === 3 && dyn.out.includes('missing ' + join(up, 'src', 'no-runtime-module.ts')) && !existsSync(join(base, 'dynamic', 'step-002.log')), dyn);

    const outside = join(base, 'other');
    mkdirSync(outside);
    writeFileSync(join(outside, 'marker.ts'), "import './only-listed-if-read.ts';\n");
    symlinkSync(join(outside, 'marker.ts'), join(up, 'src', 'linked.ts'));
    workflow(rel + '/up', rel + '/up/src/linked.ts');
    const link = run('symlink');
    ok('指向声明根外的符号链接报告边界错误，无步骤日志', link.code === 3 && link.out.includes('MATERIAL step 2 outside-root ' + join(up, 'src', 'linked.ts'))
      && !link.out.includes('only-listed-if-read.ts') && !existsSync(join(base, 'symlink', 'step-002.log')), link);
    renameSync(up, join(base, 'original-up'));
    symlinkSync(outside, up, 'dir');
    workflow(rel + '/up', rel + '/up/marker.ts');
    const rootLink = run('root-symlink');
    ok('checkout 目录被符号链接替换也在读取前拒绝', rootLink.code === 3 && rootLink.out.includes('outside-root ' + join(up, 'marker.ts'))
      && !rootLink.out.includes('only-listed-if-read.ts') && !existsSync(join(base, 'root-symlink', 'step-002.log')), rootLink);
    rmSync(up);

    workflow('$' + '{{ env.UP }}', '$' + '{{ env.UP }}/src/a.ts');
    const merged = run('merged-env');
    ok('checkout.path 与 run.env 使用同一份 workflow、job env，缺料记 INCOMPLETE', merged.code === 3 && merged.out.includes('path=' + rel + '/up')
      && merged.out.includes('missing ' + a) && !existsSync(join(base, 'merged-env', 'step-002.log')), merged);
    workflow('$' + '{{ env.UNKNOWN_UP }}');
    const unknown = run('unknown-path');
    ok('无从展开的上游 checkout.path 单独报告，受影响步骤不执行', unknown.code === 3 && /CHECKOUT step 1 .*unknown=env.UNKNOWN_UP/.test(unknown.out)
      && /STEP 2 insufficient:checkout-expression/.test(unknown.out) && !existsSync(join(base, 'unknown-path', 'step-002.log')), unknown);
  } finally { rmSync(base, { recursive: true, force: true }); }
}
console.log('\nci-run-block-test: ' + pass + ' passed / ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
