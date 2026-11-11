#!/usr/bin/env node
/**
 * 周期定时器随上下文停（CONTRIBUTING「周期任务：能随所属模块一起停掉的定时器」）。
 *
 * 在子进程里起一个最小实例：临时数据目录，装上服务容器，引入并启动 index.ts 之外所有带周期定时器的模块
 * （端点计数落库、保险库闲置上锁、工作台事件投递、登录方式每日对账、授予到期标记），然后卸载根上下文。
 *
 *   T1 起来之后这些周期定时器确实在跑（不然后面的「没残留」是空话）
 *   T2 卸载根上下文之后，一个周期定时器都不剩
 *   T3 子进程自己退出：子进程里把 unref 换成空操作，留下任何一个定时器进程都会挂着，到时限算失败
 *
 * index.ts 里的两个（发件箱 worker、每日检查）不在这里：index.ts 只在搬最后两批路由时动。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_LIMIT_MS = 20_000;
/** 一秒以上算周期任务；更短的是请求超时、让出事件循环这一类，不归这里管 */
const LONG_MS = 1000;

if (process.env.TIMERS_UNLOAD_CHILD === '1') {
  await child();
} else {
  await parent();
}

async function child() {
  // 记下每个定时器：建的时候登记，清掉或一次性的触发之后注销；unref 换成空操作，留下就会挂住进程
  const live = new Map();
  const wrap = (name, orig, clear, once) => {
    globalThis[name] = function (fn, ms, ...args) {
      let t;
      const run = once ? function (...a) { live.delete(t); return fn.apply(this, a); } : fn;
      t = orig.call(globalThis, run, ms, ...args);
      live.set(t, { kind: name, ms: Number(ms) || 0, at: new Error().stack.split('\n').slice(2).find((l) => l.includes('/server/src/'))?.trim() ?? '?' });
      t.unref = function () { return this; };
      return t;
    };
    const origClear = globalThis[clear];
    globalThis[clear] = function (t) { live.delete(t); return origClear.call(globalThis, t); };
  };
  wrap('setInterval', setInterval, 'clearInterval', false);
  wrap('setTimeout', setTimeout, 'clearTimeout', true);
  const longOnes = () => [...live.values()].filter((v) => v.ms >= LONG_MS);

  const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
  const { root } = await import(src('root-context.ts'));
  const { svc } = await import(src('context.ts'));
  await import(src('endpoint-stats.ts'));
  await import(src('vault-api.ts'));
  const { startWorkbenchEventWorker } = await import(src('workbench-events.ts'));
  startWorkbenchEventWorker();
  const { registerLoginEventRoutes } = await import(src('routes/login-events.ts'));
  const { registerGrantRoutes } = await import(src('routes/grants.ts'));
  const http = svc('http');
  registerLoginEventRoutes(http);
  const refuse = () => { throw new Error('测试里不该走到'); };
  registerGrantRoutes(http, { markOdooAdmin: refuse, adminGuard: refuse, adminActor: refuse });

  const started = longOnes();
  await root.fiber.dispose();
  const left = longOnes();
  process.stdout.write(`${JSON.stringify({ started, left })}\n`);
}

async function parent() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
  const dataDir = mkdtempSync(join(tmpdir(), 'wm-timers-'));
  try {
    const env = { ...process.env, TIMERS_UNLOAD_CHILD: '1', DATA_DIR: dataDir, WM_VAULT_PATH: join(dataDir, 'vault.json') };
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const kill = setTimeout(() => { proc.kill('SIGKILL'); resolve('timeout'); }, EXIT_LIMIT_MS);
      proc.on('exit', (c) => { clearTimeout(kill); resolve(c); });
    });
    const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    const report = line ? JSON.parse(line) : null;
    if (!report) console.log(err.slice(-2000));
    const where = (list) => list.map((t) => `${t.kind}(${t.ms}) ${t.at}`).join('；');

    const started = report?.started ?? [];
    const expect = ['endpoint-stats.ts', 'vault-api.ts', 'workbench-events.ts', 'routes/login-events.ts', 'routes/grants.ts'];
    for (const f of expect) ok(`T1 起来之后 ${f} 的周期定时器在跑`, started.some((t) => t.at.includes(`/server/src/${f}:`)), `起来的：${where(started)}`);
    ok('T2 卸载根上下文之后一个周期定时器都不剩', !!report && report.left.length === 0, report ? `剩下：${where(report.left)}` : '子进程没给报告');
    ok(`T3 子进程自己退出（${code === 'timeout' ? `${EXIT_LIMIT_MS}ms 还挂着` : `${Date.now() - t0}ms，退出码 ${code}`}）`, code === 0, code === 'timeout' ? '' : err.slice(-1000));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n${pass} 过，${fail} 没过`);
  process.exit(fail ? 1 : 0);
}
