#!/usr/bin/env node
/**
 * 阶段七：名册以（peer_root, key_fingerprint）为键，按 host 匹配只经视图 a2a_rosters_live（server/src/db.ts）。
 *
 * 一、升级：旧库（a2a_rosters 以 host 为主键、a2a_roster_seats 以 (host, team, seat)）打开时重建一次：
 *    对端登记表里钉住了公钥、指纹前 8 位就是 host 的 → 回填完整指纹、参与匹配，席位跟着走；
 *    对端没登记、没钉住键、指纹前 8 位对不上 host 的 → 指纹留空、needs_review = 1，不参与匹配（席位也不出现）；
 *    a2a_roster_changes 补两列，原有的变化记录还在；再打开一次不重做。
 * 二、匹配（视图）：
 *    同一个 host 下两个节点（撞号抢注）→ 两个都不算，不是先来的赢；停用其中一个之后另一个恢复；
 *    对端换了键（管理员确认了新键）之后，记着旧指纹的那行不算；对端停用、等确认新键的不算。
 * 测试数据都是编的。
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const DATA = resolve('tmp/a2a-roster-key');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const DB = join(DATA, 'workbench-market.db');

function key() {
  const pk = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const hex = createHash('sha256').update(Buffer.from(pk, 'base64')).digest('hex');
  return { pk, hex, host: hex.slice(0, 8), fp: `sha256:${hex}` };
}
const K1 = key(), K2 = key(), K3 = key();
const t = '2026-11-13 00:00:00';

// ---------- 旧库：名册两张表按旧结构建，对端登记表照 db.ts 里的建表语句建 ----------
{
  const src = readFileSync(join(ROOT, 'server/src/db.ts'), 'utf8');
  const peers = /CREATE TABLE IF NOT EXISTS a2a_peers \([\s\S]*?\n\);/.exec(src)?.[0];
  if (!peers) throw new Error('db.ts 里找不到 a2a_peers 的建表语句');
  const d = new DatabaseSync(DB);
  d.exec(`
CREATE TABLE a2a_rosters (host TEXT PRIMARY KEY, peer_root TEXT NOT NULL, peer_zone TEXT NOT NULL, reported_at TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE a2a_roster_seats (host TEXT NOT NULL, team TEXT NOT NULL, seat TEXT NOT NULL, seat_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'router', 'member', 'observer')), online INTEGER NOT NULL DEFAULT 0, queued INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL, PRIMARY KEY (host, team, seat));
CREATE TABLE a2a_roster_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, kind TEXT NOT NULL, team TEXT NOT NULL, seat TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
${peers}`);
  const peer = d.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, public_key, key_fingerprint, status, registered_by, registered_at, updated_at) VALUES (?, ?, 'z', 'n', ?, ?, ?, 'test', ?, ?)");
  peer.run('p_good', 'https://good.synthetic.invalid', K1.pk, K1.fp, 'active', t, t);          // 钉住的就是报名册的那把
  peer.run('p_mismatch', 'https://mismatch.synthetic.invalid', K3.pk, K3.fp, 'active', t, t);   // 钉住的不是 host 那把
  peer.run('p_pending', 'https://pending.synthetic.invalid', '', '', 'pending_registration', t, t); // 还没钉住键
  const r = d.prepare("INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, 'z', ?, ?)");
  r.run(K1.host, 'https://good.synthetic.invalid', t, t);
  r.run(K2.host, 'https://mismatch.synthetic.invalid', t, t);
  r.run('0badf00d', 'https://pending.synthetic.invalid', t, t);
  r.run('5ca1ab1e', 'https://unregistered.synthetic.invalid', t, t);
  const s = d.prepare("INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, first_seen_at) VALUES (?, 'z/canvas/t', ?, ?, '合成', 'member', ?)");
  s.run(K1.host, 'z/0000000a', 'seat-a', t); s.run(K2.host, 'z/0000000b', 'seat-b', t); s.run('0badf00d', 'z/0000000c', 'seat-c', t); s.run('5ca1ab1e', 'z/0000000d', 'seat-d', t);
  d.prepare("INSERT INTO a2a_roster_changes (host, kind, team, at) VALUES (?, 'team-added', 'z/canvas/t', ?)").run(K1.host, t);
  d.close();
}

/** 在子进程里打开库（跑一遍 db.ts 的建表和迁移），再跑 then 里的语句，返回它打印的 JSON */
function open(then = '') {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    ${then}
    const out = {
      rosters: db.prepare('SELECT peer_root, key_fingerprint, host, needs_review FROM a2a_rosters ORDER BY peer_root').all(),
      seats: db.prepare('SELECT peer_root, key_fingerprint, host, seat FROM a2a_roster_seats ORDER BY seat').all(),
      live: db.prepare('SELECT host, peer_root FROM a2a_rosters_live ORDER BY peer_root').all().map((x) => x.peer_root),
      changes: db.prepare('SELECT host, peer_root, key_fingerprint, kind FROM a2a_roster_changes').all(),
    };
    console.log('OUT ' + JSON.stringify(out));`], { env: { ...process.env, DATA_DIR: DATA, NODE_ENV: 'test' }, encoding: 'utf8' });
  const line = r.stdout.split('\n').find((l) => l.startsWith('OUT '));
  if (!line) throw new Error('打开库失败：' + r.stderr.slice(-800));
  return JSON.parse(line.slice(4));
}

try {
  console.log('一、升级：按钉住的公钥回填完整指纹，回填不上的要人确认');
  const a = open();
  const row = (root) => a.rosters.find((x) => x.peer_root === root);
  ok('钉住了公钥、前 8 位就是 host → 回填完整指纹，参与匹配', row('https://good.synthetic.invalid')?.key_fingerprint === K1.fp && row('https://good.synthetic.invalid')?.needs_review === 0 && a.live.includes('https://good.synthetic.invalid'), JSON.stringify(a.rosters));
  ok('钉住的不是 host 那把、还没钉住键、没登记 → 指纹留空、needs_review = 1，都不参与匹配',
    ['https://mismatch.synthetic.invalid', 'https://pending.synthetic.invalid', 'https://unregistered.synthetic.invalid'].every((u) => row(u)?.key_fingerprint === '' && row(u)?.needs_review === 1 && !a.live.includes(u)), JSON.stringify({ rosters: a.rosters, live: a.live }));
  ok('席位跟着名册行走（带上根地址和指纹）', a.seats.length === 4 && a.seats.find((x) => x.seat === 'z/0000000a')?.key_fingerprint === K1.fp && a.seats.every((x) => x.peer_root !== ''), JSON.stringify(a.seats));
  ok('原有的变化记录还在，补了两列', a.changes.length === 1 && a.changes[0].host === K1.host && a.changes[0].peer_root === '' && a.changes[0].key_fingerprint === '', JSON.stringify(a.changes));
  const again = open();
  ok('再打开一次不重做（行和指纹不变）', JSON.stringify(again.rosters) === JSON.stringify(a.rosters) && JSON.stringify(again.seats) === JSON.stringify(a.seats), JSON.stringify(again.rosters));

  console.log('二、匹配：同号两个节点都不算；换键后的旧行、停用的不算');
  const add = (root, fp, host) => `db.prepare("INSERT INTO a2a_rosters (peer_root, key_fingerprint, host, peer_zone, reported_at, received_at) VALUES ('${root}', '${fp}', '${host}', 'z', '${t}', '${t}')").run();`;
  // 撞号抢注：另一个根地址、另一把键，报同一个 host
  const squat = open(add('https://squatter.synthetic.invalid', 'sha256:' + 'e'.repeat(64), K1.host));
  ok('撞号抢注：同一个 host 下来了第二个节点 → 原来的和新来的都不参与匹配（不是先来的赢，也不是后来的覆盖）',
    !squat.live.includes('https://good.synthetic.invalid') && !squat.live.includes('https://squatter.synthetic.invalid'), JSON.stringify(squat.live));
  const resolved = open(`db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, registered_by, registered_at, updated_at) VALUES ('p_sq', 'https://squatter.synthetic.invalid', 'z', 'n', 'disabled', 'test', '${t}', '${t}')").run();`);
  ok('……管理员停用抢注的那台之后，原来的恢复匹配', resolved.live.includes('https://good.synthetic.invalid') && !resolved.live.includes('https://squatter.synthetic.invalid'), JSON.stringify(resolved.live));
  // 换键：管理员确认了新键（钉住的变成 K3），记着旧指纹 K1 的那行不再算
  const rotated = open(`db.prepare("UPDATE a2a_peers SET public_key = ?, key_fingerprint = ? WHERE root_url = 'https://good.synthetic.invalid'").run(${JSON.stringify(K3.pk)}, ${JSON.stringify(K3.fp)});`);
  ok('对端换了键（钉住的变了）→ 记着旧指纹的那行不参与匹配', !rotated.live.includes('https://good.synthetic.invalid'), JSON.stringify(rotated.live));
  const back = open(`db.prepare("UPDATE a2a_peers SET public_key = ?, key_fingerprint = ?, status = 'key_changed' WHERE root_url = 'https://good.synthetic.invalid'").run(${JSON.stringify(K1.pk)}, ${JSON.stringify(K1.fp)});`);
  ok('对端在等确认新键（key_changed）→ 不参与匹配', !back.live.includes('https://good.synthetic.invalid'), JSON.stringify(back.live));
  const off = open(`db.prepare("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = 'https://good.synthetic.invalid'").run();`);
  ok('对端停用 → 不参与匹配', !off.live.includes('https://good.synthetic.invalid'), JSON.stringify(off.live));
  const on = open(`db.prepare("UPDATE a2a_peers SET status = 'active' WHERE root_url = 'https://good.synthetic.invalid'").run();`);
  ok('对照：恢复 active、钉住的就是记着的那把 → 又参与匹配', on.live.includes('https://good.synthetic.invalid'), JSON.stringify(on.live));
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
}
rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
