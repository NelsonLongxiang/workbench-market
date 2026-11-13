#!/usr/bin/env node
/**
 * 把工作台的常量、变量从主库搬进各卡片的台库（docs/data-views.md 第十三节第 5 条第 5 步）。只打印数字，不打印任何值。
 * 数据目录照服务一样取 DATA_DIR。可以在服务运行时跑（两边都是 SQLite，靠文件锁）；生产上先在副本上演练（统筹安排，见设计稿）。
 *
 *   DATA_DIR=<数据目录> node scripts/vars-migrate.mjs --dry-run   只数：要搬几张卡片、几行、要写几行、孤儿几行、hot. 开头的键几个；不写、不建台库
 *   DATA_DIR=<数据目录> node scripts/vars-migrate.mjs             正式搬（能重复跑：两边一致的卡片跳过，第二次跑应当是零写入；规矩见 workbench-vars.ts 的 syncCard）
 *                                                                 两边都改过的卡片不动，报在 diverged 里，退出码 1
 *   DATA_DIR=<数据目录> node scripts/vars-migrate.mjs --compare   逐卡片比对主库那份和台库那份的摘要（每个键的 kind、revision、owner、值的 sha256），报不一致的卡片号
 *   DATA_DIR=<数据目录> node scripts/vars-migrate.mjs --resolve <卡片 id> --keep main|bench
 *                                                                 处置分叉的卡片：以 keep 那边为准，另一边整份换掉；换掉的键按键写审计（只记摘要）
 */
const argv = process.argv.slice(2);
if (!process.env.DATA_DIR) { console.error('要设 DATA_DIR（数据目录）'); process.exit(2); }
const valueOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const resolveId = valueOf('--resolve'), keep = valueOf('--keep');
const unknown = argv.filter((a, i) => !['--dry-run', '--compare', '--resolve', '--keep'].includes(a) && !['--resolve', '--keep'].includes(argv[i - 1]));
if (unknown.length) { console.error(`不认识的参数：${unknown.join(' ')}`); process.exit(2); }
if ((resolveId !== undefined || keep !== undefined) && (!/^[1-9]\d*$/.test(resolveId ?? '') || !['main', 'bench'].includes(keep ?? ''))) { console.error('--resolve 要给卡片 id，并且带 --keep main 或 --keep bench'); process.exit(2); }
const { root } = await import('../server/src/root-context.ts');
await import('../server/src/context.ts');
const V = await import('../server/src/workbench-vars.ts');
const { closeBenchStores } = await import('../server/src/services/bench-store.ts');
const { svc } = await import('../server/src/context.ts');
let code = 0;
try {
  if (resolveId !== undefined) {
    console.log(JSON.stringify(await V.resolveCardVars(Number(resolveId), keep, 'builtin:local-cli')));
  } else if (argv.includes('--compare')) {
    const ids = svc('workbenchVars').workbenchIds();
    const bad = [];
    for (const id of ids) { if (!svc('workbench').byId(id)) continue; const c = await V.compareCardVars(id); if (!c.same) bad.push(id); }
    console.log(JSON.stringify({ cards: ids.length, mismatched: bad.length, mismatched_cards: bad }));
    if (bad.length) code = 1;
  } else {
    const hot = V.hotVarKeys();
    const r = await V.migrateVars({ dryRun: argv.includes('--dry-run') });
    console.log(JSON.stringify({ dry_run: argv.includes('--dry-run'), ...r, hot_keys: hot.map((h) => `${h.workbench_id}:${h.key}`) }));
    if (r.diverged.length) code = 1;
  }
} finally {
  await closeBenchStores();
  await root.fiber.dispose();
}
process.exit(code);
