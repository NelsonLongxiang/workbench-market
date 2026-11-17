#!/usr/bin/env node
/**
 * Odoo 下线的上线前预检（只读）：在要上线的库上回答三件事，只报人数，不列名字、不列登录名。
 *
 *   一、只靠 Odoo 登录、还没有站内账号的人：启用的人、名下绑着 Odoo 身份、没绑站内账号（local）。
 *       另报其中绑着飞书身份的人数（飞书登录开着时他们还能进来；飞书现在缺省关）。
 *   二、至少一个完整管理员授予（生效中、范围 *、角色 owner）落在能用站内账号登录的人身上
 *       （人是启用的、绑着站内账号、账号还在）。没有的话，下线之后只剩管理口令能管。
 *   三、待办读权（项目读权 task_source_read_grants、运行读权 sop_run_read_grants，生效中的）
 *       有没有落在只靠 Odoo 登录的人身上：下线之后这些读权没人用得上。
 *
 * 判定：二不满足、三大于 0、一大于 0 都算红（退出码 1）。一大于 0 而属主确认这些人不再需要登录的，
 *       带 --accept-odoo-only=<人数>（要和实际人数相等，人数变了就重新确认）。
 * 只读：库以只读方式打开，不写、不迁移；表不存在按「没有」算。
 *
 *   node scripts/ops/odoo-offboard-preflight.mjs --db <库文件>            人看的
 *   node scripts/ops/odoo-offboard-preflight.mjs --db <库文件> --json     机器读的
 *   不带 --db 时读 DATA_DIR 下的 workbench-market.db
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function args(argv) {
  const out = { db: '', json: false, accept: null };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a.startsWith('--db=')) out.db = a.slice(5);
    else if (a.startsWith('--accept-odoo-only=')) {
      const v = a.slice('--accept-odoo-only='.length);
      if (!/^(0|[1-9][0-9]{0,6})$/.test(v)) throw new Error('--accept-odoo-only 要写人数（非负整数）');
      out.accept = Number(v);
    } else if (a === '--db') out.db = '\u0000next';
    else if (out.db === '\u0000next') out.db = a;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (out.db === '\u0000next') throw new Error('--db 后面要跟库文件');
  return out;
}

export function preflight(db, now = Date.now()) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const n = (sql, ...p) => Number(db.prepare(sql).get(...p)?.n ?? 0);
  const ready = has('principals') && has('principal_identities');
  // 能用站内账号登录的人：启用的人、绑着 local 身份、站内账号还在
  const localOk = has('local_accounts')
    ? "EXISTS (SELECT 1 FROM principal_identities l JOIN local_accounts a ON a.username = l.external_id WHERE l.principal_id = p.id AND l.provider = 'local')"
    : '0';
  const odooOnly = ready
    ? `p.kind = 'person' AND p.status = 'active'
       AND EXISTS (SELECT 1 FROM principal_identities o WHERE o.principal_id = p.id AND o.provider = 'odoo')
       AND NOT EXISTS (SELECT 1 FROM principal_identities l WHERE l.principal_id = p.id AND l.provider = 'local')`
    : '0';
  const odooOnlyPeople = ready ? n(`SELECT COUNT(*) AS n FROM principals p WHERE ${odooOnly}`) : 0;
  const odooOnlyWithFeishu = ready ? n(`SELECT COUNT(*) AS n FROM principals p WHERE ${odooOnly}
      AND EXISTS (SELECT 1 FROM principal_identities f WHERE f.principal_id = p.id AND f.provider = 'feishu')`) : 0;
  const fullAdminsOnLocal = ready && has('grants') ? n(`SELECT COUNT(DISTINCT g.principal_id) AS n FROM grants g JOIN principals p ON p.id = g.principal_id
      WHERE g.role = 'owner' AND g.scope = '*' AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?)
        AND p.kind = 'person' AND p.status = 'active' AND ${localOk}`, now) : 0;
  const taskGrants = ready && has('task_source_read_grants') ? n(`SELECT COUNT(*) AS n FROM task_source_read_grants t JOIN principals p ON p.id = t.subject
      WHERE t.revoked_at = '' AND datetime(t.expires_at) > datetime('now') AND ${odooOnly}`) : 0;
  const runGrants = ready && has('sop_run_read_grants') ? n(`SELECT COUNT(*) AS n FROM sop_run_read_grants r JOIN principals p ON p.id = r.subject
      WHERE r.revoked_at = '' AND (r.expires_at IS NULL OR r.expires_at = '' OR datetime(r.expires_at) > datetime('now')) AND ${odooOnly}`) : 0;
  const readHolders = ready ? n(`SELECT COUNT(*) AS n FROM principals p WHERE ${odooOnly} AND (
        ${has('task_source_read_grants') ? "EXISTS (SELECT 1 FROM task_source_read_grants t WHERE t.subject = p.id AND t.revoked_at = '' AND datetime(t.expires_at) > datetime('now'))" : '0'}
     OR ${has('sop_run_read_grants') ? "EXISTS (SELECT 1 FROM sop_run_read_grants r WHERE r.subject = p.id AND r.revoked_at = '' AND (r.expires_at IS NULL OR r.expires_at = '' OR datetime(r.expires_at) > datetime('now')))" : '0'})`) : 0;
  return {
    odoo_only_people: odooOnlyPeople,
    odoo_only_people_with_feishu: odooOnlyWithFeishu,
    full_admins_on_local_accounts: fullAdminsOnLocal,
    odoo_only_read_grants: { task_source: taskGrants, sop_run: runGrants, people: readHolders },
  };
}

export function verdict(r, accept = null) {
  const red = [];
  if (r.odoo_only_people > 0 && accept !== r.odoo_only_people) red.push('odoo-only-people');
  if (r.full_admins_on_local_accounts < 1) red.push('no-full-admin-on-local-account');
  if (r.odoo_only_read_grants.task_source + r.odoo_only_read_grants.sop_run > 0) red.push('read-grants-only-via-odoo');
  return { ok: red.length === 0, red };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  let opts;
  try { opts = args(process.argv.slice(2)); } catch (e) { console.error(String(e.message ?? e)); process.exit(2); }
  const file = opts.db || (process.env.DATA_DIR ? join(process.env.DATA_DIR, 'workbench-market.db') : '');
  if (!file || !existsSync(file)) { console.error('找不到库文件：用 --db <库文件>，或设 DATA_DIR'); process.exit(2); }
  const db = new DatabaseSync(file, { readOnly: true });
  let r;
  try { r = preflight(db); } finally { db.close(); }
  const v = verdict(r, opts.accept);
  if (opts.json) console.log(JSON.stringify({ ...r, ...v }));
  else {
    console.log(`一、只靠 Odoo 登录、没有站内账号的人：${r.odoo_only_people} 人（其中绑着飞书的 ${r.odoo_only_people_with_feishu} 人）${opts.accept !== null ? `；确认数 ${opts.accept}` : ''}`);
    console.log(`二、落在站内账号上的完整管理员（owner、范围 *、生效中）：${r.full_admins_on_local_accounts} 人`);
    console.log(`三、只靠 Odoo 才用得上的待办读权：项目读权 ${r.odoo_only_read_grants.task_source} 条、运行读权 ${r.odoo_only_read_grants.sop_run} 条，涉及 ${r.odoo_only_read_grants.people} 人`);
    console.log(v.ok ? '结论：绿，可以上线' : `结论：红（${v.red.join('、')}），不上线`);
  }
  process.exit(v.ok ? 0 : 1);
}
