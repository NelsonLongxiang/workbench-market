#!/usr/bin/env node
/**
 * scripts/ci-run-block.mjs 的正反例。纯函数部分直接调；端到端用 tmp/ 下的合成 workflow 起子进程，不碰真实 CI、不联网、不装东西。
 *
 *   node scripts/ci-run-block-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SOCKET_ROOT_MAX, UsageError, classify, expand, innerArgs, isInstall, parseArgs, reexecForReviewEnv, runtimeTooLong, stripShallowFetch, summarize } from './ci-run-block.mjs';

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

console.log('一b、文本兜底加固（#1084 评审的非阻断观察）');
{
  const c = (run) => { const r = classify({ name: 'x', run }, 1, {}, ctx); return r.status + ':' + r.reason; };
  const refused = {
    pull: 'git pull --depth=1 origin main',
    pullSince: 'git pull --shallow-since=2020-01-01 origin main',
    abbrDepth: 'git fetch --dep=1 origin main',
    abbrDeepen: 'git fetch --deepe=1 origin',
    abbrUnshallow: 'git fetch --unsh origin',
    dquoted: 'git fetch "--depth=1" origin main',
    squoted: "git fetch '--deepen=1' origin",
    subst: 'echo $(git fetch --depth=1 origin main)',
    afterEcho: 'echo start && git fetch --depth=1 origin main',
  };
  const refusedGot = Object.fromEntries(Object.entries(refused).map(([k, run]) => [k, c(run)]));
  ok('浅取复查扩到 git pull，认带引号的选项名和 git 接受的缩写（--dep、--deepe、--unsh），echo 里套命令替换的照样拒：一律不跑',
    Object.values(refusedGot).every((v) => v === 'insufficient:shallow-fetch'), refusedGot);
  const allowed = {
    commentLine: '# git fetch --depth=1 origin main 在 CI 里才跑\necho ok',
    trailingComment: 'echo hi # git pull --depth 1',
    echoText: 'echo "use git fetch --depth=1 to make a shallow clone"',
    printfText: "printf '%s\\n' 'git fetch --deepen=1'",
    plainFetch: 'git fetch origin main',
    plainPull: 'git pull origin main',
    hashInQuotes: 'echo "#x" && git fetch origin main',
  };
  const allowedGot = Object.fromEntries(Object.entries(allowed).map(([k, run]) => [k, c(run)]));
  const viaShell = {
    procSubIn: 'echo <(git fetch --depth=1 origin main)',
    procSubOut: "printf '%s' >(git fetch --depth=1 origin main)",
    echoPipeBash: 'echo "git fetch --depth=1 origin main" | bash',
    printfPipeSh: "printf 'git fetch --depth=1 origin main\\n' | sh",
    echoToScript: 'echo "git fetch --depth=1 origin main" > x.sh; bash x.sh',
    unPrefix: 'git fetch --un origin',
  };
  const viaShellGot = Object.fromEntries(Object.entries(viaShell).map(([k, run]) => [k, c(run)]));
  ok('#1097 B1：echo/printf 的内容经进程替换、管道交给 shell、写成脚本再跑时照样拒（这一行一段也不剔）；--un 也认作 --unshallow',
    Object.values(viaShellGot).every((v) => v === 'insufficient:shallow-fetch'), viaShellGot);
  ok('注释里、不含命令替换的 echo/printf 文字里提到浅取不误拒；普通 fetch、pull 照跑',
    Object.values(allowedGot).every((v) => v === 'run:'), allowedGot);
  const inst = ['pnpm exec playwright install-deps', 'npx playwright install-deps chromium', 'pnpm dlx playwright install chromium', 'yarn', 'npm i', 'sudo apt-get update'];
  const notInst = ['npm run ci', 'npm run add', 'pnpm test -- add', 'pnpm run install-check', 'git add .', 'pip --version', 'pnpm --filter web exec tsc --noEmit'];
  const instGot = Object.fromEntries(inst.map((r) => [r, isInstall(r)]));
  const notInstGot = Object.fromEntries(notInst.map((r) => [r, isInstall(r)]));
  ok('安装：pnpm exec / npx 的 playwright install-deps、dlx、裸 yarn、npm i、apt-get 都认出；npm run ci、npm run add、pnpm test -- add、git add、pip --version 不算安装',
    Object.values(instGot).every(Boolean) && !Object.values(notInstGot).some(Boolean), [instGot, notInstGot]);
  ok('真实 job 那条 pnpm install --frozen-lockfile 仍判安装、不跑', c('pnpm install --frozen-lockfile') === 'not-run:install');
  const wrapped = ['time pnpm install', 'env CI=1 pnpm install', 'echo a | xargs -n1 pnpm install', 'nohup pnpm install &', 'timeout 60 npm ci', 'exec npm ci', '! pnpm install', 'corepack pnpm install', 'npx pnpm install', 'npm exec -- pnpm install', 'bash -c "cd x && pnpm install"'];
  const wrappedGot = Object.fromEntries(wrapped.map((r) => [r, isInstall(r)]));
  ok('#1097 B2：命令名前有前缀或包装（time、env、xargs、nohup、timeout、exec、!、corepack、npx pnpm、npm exec --、bash -c）照样认作安装',
    Object.values(wrappedGot).every(Boolean), wrappedGot);
  const step9 = [
    'retry 4 python -m pip install --retries 5 "playwright==${PLAYWRIGHT_VERSION}" \\',
    '  || fail "pip 装 playwright 四次都没成"',
    'retry 4 python -m playwright install chromium || fail "下载 Chromium 四次都没成"',
    'sudo timeout 240 apt-get install -y --no-install-recommends $missing',
  ].join('\n');
  ok('#1097 B2：真实 ci.yml browser-security 第 9 步（retry 4 python -m pip install、retry 4 python -m playwright install、sudo timeout 240 apt-get）判安装、不跑',
    c(step9) === 'not-run:install' && isInstall('retry 4 python -m pip install x') && isInstall('retry 4 python -m playwright install chromium') && isInstall('sudo timeout 240 apt-get install -y x'));
  const outer = ['--worktree', 'w', '--review-env', '--out', 'o', '--step', '2', '--step-name', 'x'];
  const inner = innerArgs(outer);
  const po = parseArgs(outer), pi = parseArgs(inner);
  ok('--review-env 转交：内层参数去掉 --review-env、补上 --inside-review-env，其余原样且顺序不变；外层转交、内层不再转交',
    J(inner) === J(['--worktree', 'w', '--out', 'o', '--step', '2', '--step-name', 'x', '--inside-review-env'])
    && reexecForReviewEnv(po) === true && reexecForReviewEnv(pi) === false
    && reexecForReviewEnv(parseArgs([...outer, '--inside-review-env'])) === false, [inner, po.reviewEnv, pi.inside]);
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

console.log('\nci-run-block-test: ' + pass + ' passed / ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
