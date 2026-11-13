#!/usr/bin/env node
/**
 * 把台的提交记录和附件的元数据从主库抄进各台卡片的台库（docs/data-views.md 第十三节第 6 条）。只打印数字，不打印任何内容、台名、文件名。
 * 附件字节不搬：storage_path 原样记进台库，下载照旧从那个路径读。数据目录照服务一样取 DATA_DIR。
 * 服务是 main、shadow 档时可以在运行中跑；bench 档服务运行中只跑 --dry-run、--compare（服务进程里同一个台的操作排队，脚本是另一个进程，排不进那个队）。
 *
 *   DATA_DIR=<数据目录> node scripts/app-data-migrate.mjs --dry-run   只数：几个台、几行、要写几行；没有卡片的台、孤儿、一个台几张卡片的、磁盘上找不到的附件；不写、不建台库
 *   DATA_DIR=<数据目录> node scripts/app-data-migrate.mjs             正式抄（能重复跑：两边摘要一样的台跳过，第二次跑应当是零写入）
 *   DATA_DIR=<数据目录> node scripts/app-data-migrate.mjs --compare   逐台比两边的摘要（每一行全部的列，data 取 sha256），报不一致的台的个数（不报台名）
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (!process.env.DATA_DIR) { console.error('要设 DATA_DIR（数据目录）'); process.exit(2); }
const unknown = argv.filter((a) => !['--dry-run', '--compare'].includes(a));
if (unknown.length) { console.error(`不认识的参数：${unknown.join(' ')}`); process.exit(2); }
const { root } = await import('../server/src/root-context.ts');
const { svc } = await import('../server/src/context.ts');
const { dataDir } = await import('../server/src/db.ts');
const { closeBenchStores } = await import('../server/src/services/bench-store.ts');
const A = svc('appData');
let code = 0;
try {
  if (argv.includes('--compare')) {
    let compared = 0, mismatched = 0;
    for (const slug of A.slugsWithRows()) {
      if (A.cardOf(slug) === null) continue;
      compared++;
      if (!(await A.compare(slug)).same) mismatched++;
    }
    console.log(JSON.stringify({ compared, mismatched }));
    if (mismatched) code = 1;
  } else {
    const r = await A.migrate({ dryRun: argv.includes('--dry-run'), fileExists: (p) => existsSync(join(dataDir, p)) });
    console.log(JSON.stringify({ dry_run: argv.includes('--dry-run'), ...r }));
  }
} finally {
  await closeBenchStores();
  await root.fiber.dispose();
}
process.exit(code);
