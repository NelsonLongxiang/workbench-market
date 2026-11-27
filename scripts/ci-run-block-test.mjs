#!/usr/bin/env node
/**
 * scripts/ci-run-block.mjs 的正反例。纯函数部分直接调；端到端用 tmp/ 下的合成 workflow 起子进程，不碰真实 CI、不联网、不装东西。
 *
 *   node scripts/ci-run-block-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SOCKET_ROOT_MAX, UsageError, checkoutDecls, classify, expand, fastSelection, innerArgs, isInstall, materialGaps, parseArgs, reexecForReviewEnv, runtimeTooLong, stripShallowFetch, summarize, outLocation, realish } from './ci-run-block.mjs';

const ROOT = resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))); } };
const J = (x) => JSON.stringify(x);
const usageOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e instanceof UsageError ? 'usage' : 'throw'; } };
const ctx = { workspace: '/w', runnerTemp: '/o/runner-temp', env: {} };
// realish 的夹具：tmp/ 下一个真实存在的目录（已建出来），它下面的路径不创建
const realishTmp = join(resolve('tmp'), 'ci-run-block-test-realish-' + process.pid);
mkdirSync(realishTmp, { recursive: true });

console.log('一、执行前的核对（纯函数）');
  // --out 相对工作树的位置：只用原生路径关系判断。Windows 的 realpath 是反斜杠，原先拿正斜杠 startsWith 会把工作树里的目录全漏成“在外面”。
  {
    const win = (w, o) => outLocation(w, o, path.win32), posix = (w, o) => outLocation(w, o, path.posix);
    ok('Windows：工作树里（反斜杠）算 inside，不再漏成外面',
      J([win('C:\\w', 'C:\\w\\scripts'), win('C:\\w', 'C:\\w\\tmp\\t'), win('c:\\w', 'C:\\W\\scripts')]) === J(['inside', 'inside', 'inside']),
      [win('C:\\w', 'C:\\w\\scripts'), win('C:\\w', 'C:\\w\\tmp\\t'), win('c:\\w', 'C:\\W\\scripts')]);
    ok('Windows：恰为工作树根算 root；以 .. 逃出、跨盘符、UNC 都算 outside',
      J([win('C:\\w', 'C:\\w'), win('C:\\w', 'C:\\w\\..'), win('C:\\w', 'C:\\w\\..\\x'), win('C:\\w', 'D:\\o'), win('C:\\w', '\\\\srv\\share\\o')]) === J(['root', 'outside', 'outside', 'outside', 'outside']),
      [win('C:\\w', 'C:\\w'), win('C:\\w', 'C:\\w\\..'), win('C:\\w', 'C:\\w\\..\\x'), win('C:\\w', 'D:\\o'), win('C:\\w', '\\\\srv\\share\\o')]);
    ok('Windows：名字前缀相同但不是子目录的算 outside（/w/foo 与 /w/foobar）',
      win('C:\\w\\foo', 'C:\\w\\foobar') === 'outside', win('C:\\w\\foo', 'C:\\w\\foobar'));
    ok('POSIX：工作树里算 inside，根算 root，.. 与绝对路径算 outside',
      J([posix('/w', '/w/scripts'), posix('/w', '/w/tmp/t'), posix('/w', '/w'), posix('/w', '/w/..'), posix('/w', '/w/../x'), posix('/w', '/o')]) === J(['inside', 'inside', 'root', 'outside', 'outside', 'outside']),
      [posix('/w', '/w/scripts'), posix('/w', '/w'), posix('/w', '/w/..'), posix('/w', '/o')]);
    ok('POSIX：名字前缀相同但不是子目录的算 outside',
      posix('/w/foo', '/w/foobar') === 'outside', posix('/w/foo', '/w/foobar'));
    const n = join(realishTmp, 'a', 'not-yet', 'deeper');
    ok('realish：目录还不存在也能给出真实路径，分隔符与平台一致，且不创建它',
      realish(n).endsWith(join('a', 'not-yet', 'deeper')) && !existsSync(join(realishTmp, 'a')) && realish(realishTmp) === realpathSync(realishTmp), realish(n));
  }

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
  // 契约是“任何输出副作用之前拒绝”：除了退出码，还要钉住 --out 目录本身没被建出来。
  // 用一个尚不存在的子目录，旧实现在拒绝前就 mkdirSync，会把它建出来；并排一个在工作树外、同样不存在的目录做对照（合法路径照常建出）。
  const notYet = join(ROOT, 'scripts', 'ci-run-block-test-not-yet-' + process.pid);
  const outsideNotYet = join(base, 'outside-not-yet', 'deeper');
  bad.trackedOutNotYet = run('--out', notYet).code;
  bad.rootOut = run('--out', ROOT).code;
  const outsideOk = run('--out', outsideNotYet, '--step-name', 'ok-step').code;
  const sideEffects = {
    trackedNotYetCreated: existsSync(notYet),
    resultsJson: existsSync(join(ROOT, 'scripts', 'results.json')),
    runnerTemp: existsSync(join(ROOT, 'scripts', 'runner-temp')),
    outsideCreated: existsSync(outsideNotYet),
  };
  rmSync(notYet, { recursive: true, force: true });
  ok('用法错误退出 2：--python 找不到（不装）、--runtime-dir 太长、--out 是被跟踪的目录、没有这个 job、--worktree 不是工作树根',
    Object.values(bad).every((c) => c === 2) && !sideEffects.resultsJson, bad);
  ok('拒绝发生在任何输出之前：被跟踪目录下尚不存在的 --out 没被建出，scripts/results.json 与 runner-temp 都没有；工作树外的同名路径照常建出',
    sideEffects.trackedNotYetCreated === false && sideEffects.runnerTemp === false && sideEffects.outsideCreated === true && outsideOk === 0, sideEffects);
  // 合法目标不能被误拒（复核阻断 B1）：目标由自身的规则忽略（dist/ 只匹配目录），而它的父目录既没被忽略也还不存在。
  // 旧实现在问 git 前把探针上溯到父目录，父目录没被忽略就拒绝；正确做法是直接问“这个目录里的东西会不会被忽略”。
  const freshParent = join(ROOT, 'tmp', 'ci-run-block-test-b1-' + process.pid);
  const ownRuleTarget = join(freshParent, 'dist');
  const b1 = run('--out', ownRuleTarget, '--step-name', 'ok-step');
  const b1ok = b1.code === 0 && existsSync(join(ownRuleTarget, 'results.json'));
  ok('合法目标不被误拒：目标由自身规则忽略（dist/）、父目录未被忽略且尚不存在，照常接受并建出', b1ok, [b1.code, b1.out.slice(-160)]);
  // 同一目标若未被子目录规则覆盖、也未被忽略，仍必须拒绝——正例不能把反例带坏
  const plainChild = join(ROOT, 'tmp-not-ignored-' + process.pid, 'x');
  const b1neg = run('--out', plainChild, '--step-name', 'ok-step');
  ok('对照：父目录同样不存在、但目标未被任何规则忽略的，仍拒绝且不建目录', b1neg.code === 2 && !existsSync(plainChild), [b1neg.code, existsSync(plainChild)]);
  rmSync(freshParent, { recursive: true, force: true }); rmSync(join(ROOT, 'tmp-not-ignored-' + process.pid), { recursive: true, force: true });
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

console.log('三、快基线 profile');
{
  const sample = [
    { name: '无关标题', run: 'node --disable-warning=ExperimentalWarning scripts/app-html-unit.mjs' },
    { name: '并在一起', run: 'node scripts/not-a-unit-smoke.mjs && node --require "./setup.cjs" ./scripts/skill-tool-names-test.mjs && node --test scripts/answer-label-unit.mjs' },
    { name: '只是文字', run: 'echo "&& node scripts/quoted-unit.mjs" # ; node scripts/comment-unit.mjs' },
    { name: '不是脚本入口', run: 'node --require scripts/preloaded-unit.mjs scripts/nonunit-smoke.mjs' },
    { name: '路线体检', run: 'git fetch --no-tags --depth=1 origin main\nnode scripts/tech-route-check.mjs --selftest\nnode scripts/tech-route-check.mjs --strict' },
    { name: '未运行校验', run: 'node --check scripts/checked-unit.mjs' },
  ];
  const selected = fastSelection(sample);
  ok('fast 按 Node 脚本选完整步骤：识别命令链、选项（含带值选项）和显式技能检查，忽略文字、预加载和语法检查',
    J(selected.steps.map(s => [s.index, s.checks])) === J([
      [1, ['app-html-unit.mjs']],
      [2, ['skill-tool-names-test.mjs', 'answer-label-unit.mjs']],
      [5, ['tech-route-check.mjs --strict']],
    ]) && selected.missing.includes('ci-run-block-test.mjs'), selected);
  const requiredArgs = ['--worktree', 'w', '--out', 'o'];
  ok('fast 只用于 tsc-and-syntax，和手选规则互斥',
    parseArgs([...requiredArgs, '--profile', 'fast']).profile === 'fast'
    && [['--profile', 'nope'], ['--profile', 'fast', '--step', '1'], ['--profile', 'fast', '--step-name', 'x'], ['--profile', 'fast', '--job', 'upgrade-smoke']]
      .every(args => usageOf(() => parseArgs([...requiredArgs, ...args])) === 'usage'));

  const require = createRequire(join(ROOT, 'server/package.json'));
  const workflow = require('yaml').parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs['tsc-and-syntax'].steps;
  const real = fastSelection(steps);
  ok('真实 CI 快基线包含全部必需项；app-html 和技能工具名检查均可在清单定位',
    real.missing.length === 0 && ['app-html-unit.mjs', 'skill-tool-names-test.mjs'].every(check => real.steps.some(step => step.checks.includes(check))), real.missing);

  const sqlite = 'mcp-service-sqlite-test.mjs';
  const sqliteStep = steps.findIndex(step => step.run?.trim() === 'node scripts/' + sqlite);
  ok('真实 CI 快基线选中 MCP SQLite 必需单测',
    sqliteStep >= 0 && real.steps.some(step => step.index === sqliteStep + 1 && step.checks.includes(sqlite)), real);

  const withoutSqlite = fastSelection(steps.filter((_, index) => index !== sqliteStep));
  const otherResults = withoutSqlite.steps.map(() => ({ status: 'pass' }));
  const incomplete = summarize(otherResults, withoutSqlite.missing.length > 0);
  ok('删除真实 CI 的 MCP SQLite 步骤后，即使其余步骤全过也必须 INCOMPLETE',
    sqliteStep >= 0 && J(withoutSqlite.missing) === J([sqlite]) && incomplete.status === 'INCOMPLETE'
    && incomplete.code === 3 && incomplete.failed === 0 && incomplete.passed === otherResults.length, incomplete);

  const processTree = 'lib/test-process-tree.test.mjs';
  const mutationRunner = 'mutation-run-test.mjs';
  const processTreeRun = 'node --test scripts/' + processTree;
  const processTreeStep = steps.findIndex(step => step.run?.split(' && ').includes(processTreeRun));
  const selectedProcessTree = real.steps.find(step => step.index === processTreeStep + 1);
  ok('真实 CI 快基线按路径选中进程树单测及同一步的变异运行器自测',
    processTreeStep >= 0 && selectedProcessTree?.checks.includes(processTree) && selectedProcessTree.checks.includes(mutationRunner),
    selectedProcessTree);

  const withoutProcessTree = fastSelection(steps.map((step, index) => index === processTreeStep
    ? { ...step, run: step.run.split(' && ').filter(command => command !== processTreeRun).join(' && ') }
    : step));
  const remainingResults = withoutProcessTree.steps.map(() => ({ status: 'pass' }));
  const withoutProcessTreeSummary = summarize(remainingResults, withoutProcessTree.missing.length > 0);
  ok('仅移除进程树单测后，同一步的变异运行器仍入选，但必需路径缺失使快基线 INCOMPLETE',
    J(withoutProcessTree.missing) === J([processTree])
    && J(withoutProcessTree.steps.find(step => step.index === processTreeStep + 1)?.checks) === J([mutationRunner])
    && withoutProcessTreeSummary.status === 'INCOMPLETE' && withoutProcessTreeSummary.code === 3
    && withoutProcessTreeSummary.failed === 0 && withoutProcessTreeSummary.passed === remainingResults.length,
    { missing: withoutProcessTree.missing, summary: withoutProcessTreeSummary });

  const wrongPath = fastSelection([{ run: 'node --test scripts/other/test-process-tree.test.mjs' }]);
  ok('相同文件名的其它路径不满足进程树必需项',
    wrongPath.steps.length === 0 && wrongPath.missing.includes(processTree), wrongPath);
}

{
  const base = join(ROOT, 'tmp', 'ci-run-block-fast-' + process.pid);
  mkdirSync(join(base, 'scripts'), { recursive: true });
  try {
    const script = join(base, 'scripts', 'app-html-unit.mjs');
    const workflow = join(base, 'workflow.json');
    const makeWorkflow = (run) => writeFileSync(workflow, J({ jobs: { 'tsc-and-syntax': { steps: [
      { name: '普通步骤', run: 'exit 77' },
      { name: '快基线样本', 'working-directory': relative(ROOT, base), run },
    ] } } }));
    const run = (name, ...extra) => {
      const out = join(base, name);
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-run-block.mjs'), '--worktree', ROOT, '--workflow', workflow, '--out', out, '--profile', 'fast', ...extra], { encoding: 'utf8' });
      return { code: r.status, output: r.stdout + r.stderr, out, json: JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) };
    };
    makeWorkflow('git fetch --no-tags --depth=1 no-such-remote main\nnode --no-warnings scripts/app-html-unit.mjs && echo companion');
    const plan = run('plan', '--plan');
    ok('fast --plan 列步骤、命中脚本和缺项，不执行步骤',
      plan.code === 3 && plan.json.selection.profile === 'fast' && plan.json.selection.steps[0]?.index === 2
      && J(plan.json.selection.steps[0]?.checks) === J(['app-html-unit.mjs'])
      && plan.output.includes('PROFILE fast missing: skill-tool-names-test.mjs') && !existsSync(join(plan.out, 'step-002.log')), plan.output);
    writeFileSync(script, 'console.log("fixture")\n');
    const partial = run('partial');
    ok('缺必需项时已选全过仍为 INCOMPLETE；按原样运行复合命令，浅取准备照旧剔除',
      partial.code === 3 && partial.json.summary.passed === 1 && partial.json.results[0]?.removed.length === 1
      && readFileSync(join(partial.out, 'step-002.log'), 'utf8').trim() === 'fixture\ncompanion', partial.output);
    writeFileSync(script, 'process.exitCode = 7;\n');
    const failed = run('failed');
    ok('fast 实际执行失败优先记 FAIL，即使也有缺项',
      failed.code === 1 && failed.json.summary.status === 'FAIL' && failed.json.results[0]?.exit === 7, failed.output);

    const checkoutPath = relative(ROOT, join(base, 'up'));
    const material = join(base, 'up', 'source.mjs');
    writeFileSync(workflow, J({ jobs: { 'tsc-and-syntax': { steps: [
      { uses: 'actions/checkout@v4', with: { repository: 'example/up', ref: 'abc123', path: checkoutPath } },
      { name: '快基线材料样本', 'working-directory': relative(ROOT, base), env: { SRC: material }, run: 'node scripts/app-html-unit.mjs' },
    ] } } }));
    const mixed = run('mixed');
    ok('fast 同时保留 selection 和 checkouts；前置 checkout 缺材料时已选步骤不执行',
      mixed.code === 3 && mixed.json.selection.steps[0]?.index === 2
      && mixed.json.checkouts.some(d => d.index === 1 && d.repository === 'example/up' && d.ref === 'abc123')
      && mixed.json.results[0]?.reason === 'material' && mixed.json.results[0]?.missing[0]?.path === material
      && !existsSync(join(mixed.out, 'step-002.log')), mixed.output);
  } finally { rmSync(base, { recursive: true, force: true }); }
}

console.log('\nci-run-block-test: ' + pass + ' passed / ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
