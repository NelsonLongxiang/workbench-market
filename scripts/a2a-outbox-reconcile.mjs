#!/usr/bin/env node
/**
 * 唯一 outbox 双写期对账（阶段七第 3 步）：回执（a2a_outbox）与事件投递（workbench_event_deliveries 里非 held 的行）
 * 分别和新表 a2a_outbox_items 逐行逐字段比；held 的投递单独计数并列出。
 * 只读打开库，不触发迁移。零差异退出 0，有差异退出 1，打开失败退出 2。切读前必须零差异；部署方每日跑一次。
 *
 *   node scripts/a2a-outbox-reconcile.mjs [数据目录]      # 缺省取 DATA_DIR，再缺省 server/data
 *   加 --json 只输出 JSON。
 */
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { reconcileDeliveryOutbox, reconcileReceiptOutbox } from '../server/src/services/a2a-outbox-reconcile.ts';

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
try { const receipts = reconcileReceiptOutbox(h); const events = reconcileDeliveryOutbox(h); r = { receipts, events, ok: receipts.ok && events.ok }; } catch (e) { console.error(`对账失败（新表可能还没建，先用新版本起一次服务）：${e?.message ?? e}`); process.exit(2); } finally { h.close(); }
if (json) console.log(JSON.stringify(r));
else {
  const show = (name, x) => {
    console.log(`${name}：旧表 ${x.old_rows} 行，新表 ${x.new_rows} 行`);
    console.log(`  按状态  旧 ${JSON.stringify(x.by_status.old)}  新 ${JSON.stringify(x.by_status.new)}`);
    if (x.missing.length) console.log(`  新表缺 ${x.missing.length} 行：${x.missing.slice(0, 20).join(', ')}${x.missing.length > 20 ? ' …' : ''}`);
    if (x.extra.length) console.log(`  新表多 ${x.extra.length} 行：${x.extra.slice(0, 20).join(', ')}${x.extra.length > 20 ? ' …' : ''}`);
    for (const m of x.mismatched.slice(0, 20)) console.log(`  ${m.ref} 字段不同：${m.fields.join(', ')}`);
  };
  show('回执 outbox（a2a_outbox ↔ run-receipt）', r.receipts);
  show('事件投递（非 held 的投递 ↔ event-delivery）', r.events);
  console.log(`  等放行（held，不在 outbox 里是预期）：${r.events.held.count} 行${r.events.held.count ? `：${r.events.held.refs.slice(0, 20).join(', ')}${r.events.held.count > 20 ? ' …' : ''}` : ''}`);
  console.log(r.ok ? '零差异' : '有差异');
}
process.exit(r.ok ? 0 : 1);
