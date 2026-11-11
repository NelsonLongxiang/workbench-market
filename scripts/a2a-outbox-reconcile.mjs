#!/usr/bin/env node
/**
 * 唯一 outbox 双写期对账（阶段七第 3 步）：旧表 a2a_outbox 与新表 a2a_outbox_items（kind=run-receipt）逐行比。
 * 只读打开库，不触发迁移。零差异退出 0，有差异退出 1，打开失败退出 2。切读前必须零差异；部署方每日跑一次。
 *
 *   node scripts/a2a-outbox-reconcile.mjs [数据目录]      # 缺省取 DATA_DIR，再缺省 server/data
 *   加 --json 只输出 JSON。
 */
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { reconcileReceiptOutbox } from '../server/src/services/a2a-outbox-reconcile.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? process.env.DATA_DIR ?? 'server/data');
const file = join(dir, 'workbench-market.db');
if (!existsSync(file)) { console.error(`找不到库：${file}`); process.exit(2); }
let h;
try {
  h = new DatabaseSync(file, { readOnly: true });
  h.exec('PRAGMA busy_timeout = 2000');
} catch (e) { console.error(`打不开库：${e?.message ?? e}`); process.exit(2); }
let r;
try { r = reconcileReceiptOutbox(h); } catch (e) { console.error(`对账失败（新表可能还没建，先用新版本起一次服务）：${e?.message ?? e}`); process.exit(2); } finally { h.close(); }
if (json) console.log(JSON.stringify(r));
else {
  console.log(`回执 outbox 对账：旧表 ${r.old_rows} 行，新表 ${r.new_rows} 行`);
  console.log(`  按状态  旧 ${JSON.stringify(r.by_status.old)}  新 ${JSON.stringify(r.by_status.new)}`);
  if (r.missing.length) console.log(`  新表缺 ${r.missing.length} 行：run ${r.missing.slice(0, 20).join(', ')}${r.missing.length > 20 ? ' …' : ''}`);
  if (r.extra.length) console.log(`  新表多 ${r.extra.length} 行：ref ${r.extra.slice(0, 20).join(', ')}${r.extra.length > 20 ? ' …' : ''}`);
  for (const m of r.mismatched.slice(0, 20)) console.log(`  run ${m.ref} 字段不同：${m.fields.join(', ')}`);
  console.log(r.ok ? '零差异' : '有差异');
}
process.exit(r.ok ? 0 : 1);
