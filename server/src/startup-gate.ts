/**
 * 启动闸：后台任务等「启动自检通过」再开始。
 *
 * 服务进程（index.ts）最先引入 startup-gate-hold.ts 把闸拉上，启动自检通过后调 startupPassed() 放开；
 * 自检没过，进程拒绝启动、闸一直不放，后台任务不会开始。
 * 没拉闸的进程（测试里直接装服务、命令行工具）afterStartup 照旧在下一轮事件循环开始，行为不变。
 *
 * 为什么要闸：启动自检的第一条请求在端口一开就发出，后台任务（事项回填）要是同时在同一个事件循环里跑一大段同步工作，
 * 那条请求的应答要等它跑完才回得来；慢环境里超过自检的超时，进程就按设计拒绝启动。自检通过之前，入口本来就关着（除自检请求外 503），晚开没有损失。
 * 没有依赖：服务的插件在 context.ts 的顶层 await 里装上，那之前就得知道闸拉没拉上。
 */
let held = false;
const waiting = new Set<() => void>();

/** 拉上闸（只由 startup-gate-hold.ts 调） */
export function holdUntilStartupPassed(): void { held = true; }

/** 启动自检通过：放开闸，排着的后台任务各自在下一轮事件循环开始 */
export function startupPassed(): void {
  held = false;
  for (const f of [...waiting]) { waiting.delete(f); setImmediate(f); }
}

/** 闸放开之后开始 f（没拉闸就是下一轮事件循环）。返回撤销函数：还没开始的不再开始 */
export function afterStartup(f: () => void): () => void {
  if (!held) { const t = setImmediate(f); return () => clearImmediate(t); }
  let cancelled = false;
  const run = () => { if (!cancelled) f(); };
  waiting.add(run);
  return () => { cancelled = true; waiting.delete(run); };
}
