#!/usr/bin/env node
/**
 * scripts/ci-run-block.mjs 的正反例。纯函数部分直接调；端到端用 tmp/ 下的合成 workflow 起子进程，不碰真实 CI、不联网、不装东西。
 *
 *   node scripts/ci-run-block-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, classify, expand, parseArgs, stripShallowFetch, summarize } from './ci-run-block.mjs';

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
  const r = classify({ name: 'e', env: { X: '$' + '{{ env.BASE }}-x' }, run: 'echo "$X"' }, 2, { BASE: 'b' }, ctx);
  ok('步骤 env 可以引用 job 层 env；run 本身逐字不改', r.status === 'run' && r.env.X === 'b-x' && r.run === 'echo "$X"', r);
  const S = (...st) => summarize(st.map((status) => ({ status })));
  ok('汇总：全跑全过 PASS/0；有失败 FAIL/1；没失败但有没跑的 INCOMPLETE/3；一步都没有也不算 PASS',
    J([S('pass', 'pass'), S('pass', 'fail', 'not-run'), S('pass', 'not-run'), S('pass', 'insufficient'), S()].map((x) => x.status + '/' + x.code)) === J(['PASS/0', 'FAIL/1', 'INCOMPLETE/3', 'INCOMPLETE/3', 'INCOMPLETE/3']));
  ok('参数：--worktree、--out 必须显式；不认识的参数、--step 0、值缺失都是用法错误',
    J([usageOf(() => parseArgs(['--out', 'x'])), usageOf(() => parseArgs(['--worktree', 'x'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', 'o', '--nope'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', 'o', '--step', '0'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', '--plan'])), usageOf(() => parseArgs(['--worktree', 'w', '--out', 'o', '--step', '2', '--step-name', 'x']))])
      === J(['usage', 'usage', 'usage', 'usage', 'usage', 'ok']));
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
  ok('全部步骤：有一步退出 7 就是 FAIL 退出 1；每步按身份记：action 未跑、失败那步记真实退出码 7、诊断步骤未触发，没被算成通过',
    r2.code === 1 && /RUNBLOCK status=FAIL/.test(r2.out) && res2.find((x) => x.name === 'fail-step')?.exit === 7 && res2.find((x) => x.index === 1)?.reason === 'action' && res2.find((x) => x.name === 'diag')?.reason === 'not-triggered',
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
    longRuntime: run('--out', join(base, 'o7'), '--runtime-dir', base).code,
    trackedOut: run('--out', join(ROOT, 'scripts')).code,
    noJob: spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', ROOT, '--out', join(base, 'o8'), '--workflow', 'tmp/ci-run-block-test-' + process.pid + '/wf.yml', '--job', 'ghost'], { encoding: 'utf8' }).status,
    notRoot: spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', join(ROOT, 'scripts'), '--out', join(base, 'o9')], { encoding: 'utf8' }).status,
  };
  ok('用法错误退出 2：--python 找不到（不装）、--runtime-dir 太长、--out 是被跟踪的目录、没有这个 job、--worktree 不是工作树根',
    Object.values(bad).every((c) => c === 2) && !existsSync(join(ROOT, 'scripts', 'results.json')), bad);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

console.log('\nci-run-block-test: ' + pass + ' passed / ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
