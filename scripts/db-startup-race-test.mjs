#!/usr/bin/env node
/**
 * 多个进程同时打开同一个主库时，启动迁移不能互相撞（#933 的 CI 上 bench-provenance-test 的两进程用例偶发红）。
 * 被测的就是 server/src/db.ts 的启动本身，所以这里由子进程直接加载它（不经接口）；每个子进程有超时，到点杀掉按失败交回，不会挂住。
 *
 *   一、视图定义没变：先由一个进程把库建好，再让 N 个进程约好同一时刻加载 db.ts——全部成功、都没有删了重建（unchanged）、视图定义对
 *   二、视图定义变了也会更新：库里的 a2a_rosters_live 先换成一个过时的定义，再让 N 个进程同时加载——全部成功、
 *       只有一个进程重建（replaced）、其余看到已经是新定义就跳过（unchanged），最后的定义就是 db.ts 里的那一份。
 *       WM_TEST_SCHEMA_PAUSE_MS 把「核对定义」「删」「建」之间的窗口撑大：去掉事务的话 N 个进程都删了再建，后建的必然报 view already exists（这一节每次都红）
 *   三、视图被删了：同样 N 个进程同时加载，只有一个建（created），全部成功
 *   四、WM_TEST_SCHEMA_PAUSE_MS 只给测试用：不是 NODE_ENV=test 时设了拒绝启动；值不合法拒绝启动
 *   五、旧库缺列：先记下建好的库每张表的 PRAGMA table_info，再用 DROP COLUMN 拿掉一批列，冒充升级前的旧库
 *       （单列补、循环补、workbenches.access 那段「补列加回填」、teams 四张表那段「补列加回填」都有份），再让 N 个进程同时加载——
 *       全部成功，拿掉的列都补回来了，每张表的列（名字、类型、非空、缺省值、主键）和索引、触发器、视图的定义都和原来一样。
 *       拿掉再补回来的列排到了表尾，所以这一节按列名比、不比列的位置；按位置的逐表比对用真的旧版本库做（见 PR 描述）。
 *       这一节证明「旧库升级完和新建的一样」；列定义本身没被改写，是拿真的旧版本库、按位置逐表比的（见 PR 描述）
 *   六、两个补列函数本身：N 个进程都先把 db.ts 加载完，再约好同一时刻对一张临时表调 addColumnIfMissing / migrateOnce——
 *       全部成功，只有一个进程补上（added / did 为真），列只有一份。停顿撑大「核对」和「补列」之间的窗口，去掉事务里的再核一次，
 *       后补的必然报 duplicate column（这一节每次都红）。
 *   七、teams 四张表那段「补列加回填」：库里拿掉这四张表的 peer_root、key_fingerprint，N 个进程同时启动，
 *       用 WM_TEST_SCHEMA_BARRIER 在这段前面凑齐 N 个进程、一起进去——全部成功、八列都补回来。这一段里的 ALTER 是直接写的（外层 migrateOnce 已在事务里再核），
 *       所以这段不经 migrateOnce、或者在事务外核的回归，靠停顿撑不开，要靠集合才每次都撞上（这一节每次都红）。
 *   八、旧库缺只增触发器：拿掉 db.ts 给只增表、留痕表新补的那些触发器（两批，见 append-only-tables-test），冒充升级前的旧库，
 *       再让 N 个进程同时加载——全部成功，触发器都补回来了，索引、触发器、视图的定义和每张表的列都和新建的库一样。
 *       触发器都是 CREATE TRIGGER IF NOT EXISTS：「有没有」在拿到写锁以后才判，同时启动的进程只有一个真建，别的看到已经有了就跳过
 *
 *   真实的整段启动里也会撞上这个窗口，只是概率性的：各进程前面的迁移快慢不一、还会在写锁上排队，到某一处补列的时刻前后错开。
 *   验收在改之前的 main 上实测过：8 个进程同时升级一个缺 teams.peer_root、workbenches.access 的旧库，40 个进程里 4 个报 duplicate column。
 *   所以测试里用停顿（WM_TEST_SCHEMA_PAUSE_MS）撑开窗口、用集合（WM_TEST_SCHEMA_BARRIER）对齐时刻，让回归每次都红，而不是碰运气
 *
 *   node scripts/db-startup-race-test.mjs              测本仓库
 *   node scripts/db-startup-race-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `db-startup-race-${process.pid}-${Date.now().toString(36)}`);
const DB_URL = pathToFileURL(join(ROOT, 'server', 'src', 'db.ts')).href;
const N = 8;
/** 子进程的系统临时目录（os.tmpdir() 读 TMPDIR）：单独给一个，和 DATA_DIR 分开——集合点的目录只认 DATA_DIR，放在系统临时目录下的要被拒 */
const SYS_TMP = join(OUT, 'systmp');
/** db.ts 自己引的模块先在约好的时刻之前加载好：过了那个时刻只剩 db.ts 本身，各进程进迁移的时间差压到最小 */
const PREWARM = ['config.ts', 'db-busy.ts', 'portal-access.ts'].map((f) => `await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server', 'src', f)).href)});`).join(' ');
const CHILD_TIMEOUT_MS = 30_000;
const PAUSE_MS = 300;
/** 旧库缺列那一节的停顿：比各进程加载 db.ts 的时间差大，「核对」和「补列」之间才一定重叠 */
const COL_PAUSE_MS = 400;

let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };

/** 起一个子进程跑一段代码；超时杀掉，按失败交回（timedOut: true） */
function run(code, env) {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', TMPDIR: SYS_TMP, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (exit) => {
      clearTimeout(timer);
      let result = null; try { result = JSON.parse(out.trim().split('\n').pop()); } catch { /* 没跑到输出那一行 */ }
      res({ exit, timedOut, result, err: err.trim().split('\n').filter((l) => /Error|拒绝/.test(l)).slice(0, 2).join(' | ') || err.slice(-200) });
    });
  });
}
/** 加载 db.ts，报告这一次视图做了什么、最后的定义对不对。startAt：约好的时刻，先空转等到再加载，让 N 个进程尽量同时进迁移 */
const loadCode = (startAt) => `${PREWARM}
while (Date.now() < ${startAt}) {}
const m = await import(${JSON.stringify(DB_URL)});
console.log(JSON.stringify({ setup: m.a2aRostersLiveSetup, ok: m.viewSql('a2a_rosters_live') === m.A2A_ROSTERS_LIVE_SQL }));`;
/** 在库里改视图（造「定义过时」「被删了」两种起点）：加载 db.ts 之后用它的连接改 */
const tamperCode = (sql) => `const m = await import(${JSON.stringify(DB_URL)}); m.db.exec(${JSON.stringify(sql)});
console.log(JSON.stringify({ after: m.viewSql('a2a_rosters_live') }));`;
const together = async (dir, env = {}) => {
  const startAt = Date.now() + 1200;
  return Promise.all(Array.from({ length: N }, () => run(loadCode(startAt), { DATA_DIR: dir, ...env })));
};
/** 每张表的列（按列名排，不带位置 cid）和索引、触发器、视图的定义 */
const schemaCode = `const m = await import(${JSON.stringify(DB_URL)});
const tables = {};
for (const { name } of m.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
  tables[name] = m.db.prepare('PRAGMA table_info("' + name + '")').all().map(({ cid, ...c }) => ({ ...c })).sort((a, b) => (a.name < b.name ? -1 : 1));
const objects = m.db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') ORDER BY type, name").all().map((r) => ({ ...r }));
console.log(JSON.stringify({ tables, objects }));`;
/**
 * 冒充旧库拿掉的列，每种补法各取一处：单列补（market_sessions）、循环补（local_accounts、work_items）、
 * workbenches.access 那段「补列加回填」（两列）、teams 四张表那段「补列加回填」（八列，四张表一起补，要拿就一起拿）。
 * 不多拿：停顿按「真的要补的那一次」算，补的进程一次接一次拿写锁，拿多了等着的进程会超过等锁上限（DB_BUSY_TIMEOUT_MS）报 database is locked——那是停顿造成的，不是被测的行为
 */
const DROPPED = [['market_sessions', 'max_expires_at'], ['local_accounts', 'credential_by_system_at'], ['work_items', 'area_reason'],
  ['workbenches', 'access_logins'], ['workbenches', 'access'],
  ...['teams', 'team_leads', 'seat_assignments', 'team_events'].flatMap((t) => [[t, 'key_fingerprint'], [t, 'peer_root']])];
/** 加载 db.ts 之后，DROPPED 里还缺几列（在加载它的这个进程里数，数完不再有别的进程先加载一遍） */
const gapsExpr = `${JSON.stringify(DROPPED)}.filter(([t, c]) => !m.tableColumns(t).some((x) => x.name === c)).length`;
const summary = (rs) => rs.map((r) => (r.timedOut ? 'timeout' : r.exit !== 0 ? `exit ${r.exit}: ${r.err}` : `${r.result?.setup}/${r.result?.ok}`));
const count = (rs, setup) => rs.filter((r) => r.exit === 0 && r.result?.setup === setup).length;
const allOk = (rs) => rs.every((r) => !r.timedOut && r.exit === 0 && r.result?.ok === true);

rmSync(OUT, { recursive: true, force: true });
try {
  const dir = join(OUT, 'data');
  mkdirSync(dir, { recursive: true });
  mkdirSync(SYS_TMP, { recursive: true });

  console.log('一、视图定义没变');
  const first = await run(loadCode(0), { DATA_DIR: dir });
  check(first.exit === 0 && first.result?.setup === 'created' && first.result.ok === true, '（准备）第一个进程建库：视图是新建的（created），定义对', summary([first]));
  const same = await together(dir);
  check(allOk(same) && count(same, 'unchanged') === N, `${N} 个进程同时加载：全部成功，都没有删了重建（unchanged），视图定义对`, summary(same));

  console.log('二、视图定义变了也会更新');
  const stale = await run(tamperCode('DROP VIEW a2a_rosters_live; CREATE VIEW a2a_rosters_live AS SELECT 1 AS stale'), { DATA_DIR: dir });
  check(stale.exit === 0 && stale.result?.after === 'CREATE VIEW a2a_rosters_live AS SELECT 1 AS stale', '（准备）库里的视图换成了一个过时的定义', summary([stale]));
  const upd = await together(dir, { WM_TEST_SCHEMA_PAUSE_MS: String(PAUSE_MS) });
  check(allOk(upd) && count(upd, 'replaced') === 1 && count(upd, 'unchanged') === N - 1,
    `${N} 个进程同时加载（核对、删、建之间各停 ${PAUSE_MS} 毫秒）：全部成功；只有一个重建（replaced），其余看到已经是新定义就跳过；最后的定义就是 db.ts 里的那一份`, summary(upd));

  console.log('三、视图被删了');
  const gone = await run(tamperCode('DROP VIEW a2a_rosters_live'), { DATA_DIR: dir });
  check(gone.exit === 0 && gone.result?.after === null, '（准备）库里的视图删掉了', summary([gone]));
  const re = await together(dir, { WM_TEST_SCHEMA_PAUSE_MS: String(PAUSE_MS) });
  check(allOk(re) && count(re, 'created') === 1 && count(re, 'unchanged') === N - 1, `${N} 个进程同时加载：全部成功，只有一个建（created），定义对`, summary(re));

  console.log('四、测试用的停顿只给测试用');
  const prod = await run(loadCode(0), { DATA_DIR: dir, NODE_ENV: 'production', WM_TEST_SCHEMA_PAUSE_MS: '10' });
  const badVal = await run(loadCode(0), { DATA_DIR: dir, WM_TEST_SCHEMA_PAUSE_MS: '9999' });
  const prodBarrier = await run(loadCode(0), { DATA_DIR: dir, NODE_ENV: 'production', WM_TEST_SCHEMA_BARRIER: `teams@2@${dir}` });
  const badBarrier = await run(loadCode(0), { DATA_DIR: dir, WM_TEST_SCHEMA_BARRIER: 'teams@soon' });
  check(prodBarrier.exit !== 0 && !prodBarrier.timedOut && /WM_TEST_SCHEMA_BARRIER 只给测试用/.test(prodBarrier.err) && badBarrier.exit !== 0 && /名字>@<进程数>@<绝对路径的目录/.test(badBarrier.err),
    '不是 NODE_ENV=test 时设了 WM_TEST_SCHEMA_BARRIER：拒绝启动；写法不对：拒绝启动', { prod: summary([prodBarrier]), bad: summary([badBarrier]) });
  // 集合点的目录各进程要往里写文件：读配置时就收紧，不满足的拒绝启动，而且一个文件都不写
  const outside = join(OUT, 'outside'); // 不在 DATA_DIR 下（也不在子进程的系统临时目录下）
  mkdirSync(join(dir, 'ok'), { recursive: true }); mkdirSync(outside, { recursive: true }); mkdirSync(join(SYS_TMP, 'meet'), { recursive: true });
  symlinkSync(outside, join(dir, 'link-out'));
  writeFileSync(join(dir, 'a-file'), '');
  const dirCases = {
    '带 ..（<目录>/ok/../.. 落到 DATA_DIR 外面）': [`${dir}/ok/../..`, /不能带 \.\./],
    '带 ..（落点仍在 DATA_DIR 里也不收）': [`${dir}/ok/..`, /不能带 \.\./],
    '软链指到外面': [join(dir, 'link-out'), /要在 DATA_DIR 之下（按软链展开/],
    '目录不存在': [join(dir, 'no-such-dir'), /不存在/],
    '在 DATA_DIR 以外': [outside, /要在 DATA_DIR 之下（按软链展开/],
    '在系统临时目录下（只认 DATA_DIR）': [join(SYS_TMP, 'meet'), /要在 DATA_DIR 之下（按软链展开/],
    '相对路径': ['meet-teams', /绝对路径/],
    '是文件不是目录': [join(dir, 'a-file'), /不是目录/],
    'TMPDIR=/ 时用外面的目录': [outside, /要在 DATA_DIR 之下（按软链展开/, { TMPDIR: '/' }],
    '目录写成 DATA_DIR 本身（库文件会算进人数）': [dir, /不能是 DATA_DIR 本身/],
    'DATA_DIR=/': [outside, /DATA_DIR 是 \/ 或只有一层的根/, { DATA_DIR: '/' }],
    'DATA_DIR 只有一层（/usr）': [outside, /DATA_DIR 是 \/ 或只有一层的根/, { DATA_DIR: '/usr' }],
    // 只靠「在 DATA_DIR 之下」挡不住这一种：/usr/bin 确实在 /usr 下面。要靠「DATA_DIR 不能只有一层」这一条
    'DATA_DIR 只有一层、目录在它下面（/usr、/usr/bin）': ['/usr/bin', /DATA_DIR 是 \/ 或只有一层的根/, { DATA_DIR: '/usr' }],
  };
  const dirRes = {};
  for (const [name, [path, want, extraEnv]] of Object.entries(dirCases)) {
    const r = await run(loadCode(0), { DATA_DIR: dir, WM_TEST_SCHEMA_BARRIER: `teams@1@${path}`, ...(extraEnv ?? {}) });
    dirRes[name] = !r.timedOut && r.exit !== 0 && want.test(r.err) ? 'refused' : `${r.exit}: ${r.err}`;
  }
  const leaked = (await import('node:fs')).readdirSync(outside).length;
  check(Object.values(dirRes).every((x) => x === 'refused') && leaked === 0,
    'WM_TEST_SCHEMA_BARRIER 的目录只认 DATA_DIR 之下：带 ..、软链指到外面、不存在、在 DATA_DIR 以外、在系统临时目录下、相对路径、是文件、TMPDIR=/、DATA_DIR 是 / 或只有一层——读配置时就拒绝启动，外面的目录里一个文件都没写', { ...dirRes, leaked });
  const okData = await run(loadCode(0), { DATA_DIR: dir, WM_TEST_SCHEMA_BARRIER: `teams@1@${join(dir, 'ok')}` });
  check(okData.exit === 0 && !okData.timedOut, 'WM_TEST_SCHEMA_BARRIER 的目录在 DATA_DIR 之下：照常启动', summary([okData]));
  check(prod.exit !== 0 && !prod.timedOut && /WM_TEST_SCHEMA_PAUSE_MS 只给测试用/.test(prod.err) && badVal.exit !== 0 && /0～5000/.test(badVal.err),
    '不是 NODE_ENV=test 时设了 WM_TEST_SCHEMA_PAUSE_MS：拒绝启动；值超出 0～5000：拒绝启动', { prod: summary([prod]), bad: summary([badVal]) });

  console.log('五、旧库缺列');
  const before = await run(schemaCode, { DATA_DIR: dir });
  const missing = (snap) => DROPPED.filter(([t, c]) => !snap?.tables?.[t]?.some((x) => x.name === c)).length;
  // 拿掉列、数缺口在同一个进程里做：之后第一个加载 db.ts 的就是下面同时启动的那 N 个（别的进程先加载会把列补回去）
  const drop = await run(`const m = await import(${JSON.stringify(DB_URL)}); m.db.exec(${JSON.stringify(DROPPED.map(([t, c]) => `ALTER TABLE ${t} DROP COLUMN ${c};`).join(' '))});
console.log(JSON.stringify({ gaps: ${gapsExpr} }));`, { DATA_DIR: dir });
  check(before.exit === 0 && missing(before.result) === 0 && drop.exit === 0 && drop.result?.gaps === DROPPED.length,
    `（准备）拿掉 ${DROPPED.length} 列冒充旧库（${new Set(DROPPED.map(([t]) => t)).size} 张表）`, { before: before.exit, drop: summary([drop]), gaps: drop.result?.gaps });
  const startAt = Date.now() + 1200;
  const up = await Promise.all(Array.from({ length: N }, () => run(`${PREWARM}
while (Date.now() < ${startAt}) {}
const m = await import(${JSON.stringify(DB_URL)});
console.log(JSON.stringify({ gaps: ${gapsExpr} }));`, { DATA_DIR: dir, WM_TEST_SCHEMA_PAUSE_MS: String(COL_PAUSE_MS) })));
  const after = await run(schemaCode, { DATA_DIR: dir });
  const diffTables = Object.keys({ ...before.result?.tables, ...after.result?.tables }).filter((t) => JSON.stringify(before.result?.tables?.[t]) !== JSON.stringify(after.result?.tables?.[t]));
  const sameObjects = JSON.stringify(before.result?.objects) === JSON.stringify(after.result?.objects);
  check(up.every((r) => !r.timedOut && r.exit === 0 && r.result?.gaps === 0) && after.exit === 0 && missing(after.result) === 0 && diffTables.length === 0 && sameObjects,
    `${N} 个进程同时加载这个旧库：全部成功；拿掉的列都补回来了；每张表的列和索引、触发器、视图的定义都和原来一样`, { up: up.map((r) => (r.timedOut ? 'timeout' : r.exit !== 0 ? `exit ${r.exit}: ${r.err}` : `gaps=${r.result?.gaps}`)), missing: missing(after.result), diffTables, sameObjects });

  console.log('六、两个补列函数本身');
  const prep = await run(`const m = await import(${JSON.stringify(DB_URL)}); m.db.exec('CREATE TABLE zz_race_a (id INTEGER PRIMARY KEY); CREATE TABLE zz_race_b (id INTEGER PRIMARY KEY)');
console.log(JSON.stringify({ ok: true }));`, { DATA_DIR: dir });
  check(prep.exit === 0, '（准备）两张临时表', summary([prep]));
  const race = async (call) => {
    const at = Date.now() + 2000; // 都先把 db.ts 加载完（迁移在这之前做完），再一起调
    return Promise.all(Array.from({ length: N }, () => run(`const m = await import(${JSON.stringify(DB_URL)});
while (Date.now() < ${at}) {}
const r = ${call};
console.log(JSON.stringify({ r, n: m.tableColumns(${JSON.stringify('zz_race_a')}).length + m.tableColumns(${JSON.stringify('zz_race_b')}).length }));`, { DATA_DIR: dir, WM_TEST_SCHEMA_PAUSE_MS: String(PAUSE_MS) })));
  };
  const show = (rs) => rs.map((x) => (x.timedOut ? 'timeout' : x.exit !== 0 ? `exit ${x.exit}: ${x.err}` : String(x.result?.r)));
  const a = await race(`m.addColumnIfMissing('zz_race_a', "c TEXT NOT NULL DEFAULT ''")`);
  check(a.every((x) => !x.timedOut && x.exit === 0) && a.filter((x) => x.result?.r === true).length === 1,
    `addColumnIfMissing：${N} 个进程同时补同一列，全部成功，只有一个补上`, show(a));
  const b = await race(`m.migrateOnce(() => !m.hasColumn('zz_race_b', 'c'), () => m.db.exec("ALTER TABLE zz_race_b ADD COLUMN c TEXT NOT NULL DEFAULT ''"))`);
  check(b.every((x) => !x.timedOut && x.exit === 0) && b.filter((x) => x.result?.r === true).length === 1,
    `migrateOnce：${N} 个进程同时做同一段「补列加回填」，全部成功，只有一个做了`, show(b));

  console.log('七、teams 四张表那段「补列加回填」');
  const TEAMS = ['teams', 'team_leads', 'seat_assignments', 'team_events'].flatMap((t) => [[t, 'key_fingerprint'], [t, 'peer_root']]);
  const teamGaps = `${JSON.stringify(TEAMS)}.filter(([t, c]) => !m.tableColumns(t).some((x) => x.name === c)).length`;
  const tdrop = await run(`const m = await import(${JSON.stringify(DB_URL)}); m.db.exec(${JSON.stringify(TEAMS.map(([t, c]) => `ALTER TABLE ${t} DROP COLUMN ${c};`).join(' '))});
console.log(JSON.stringify({ gaps: ${teamGaps} }));`, { DATA_DIR: dir });
  check(tdrop.exit === 0 && tdrop.result?.gaps === TEAMS.length, `（准备）拿掉 teams 四张表的 ${TEAMS.length} 列`, summary([tdrop]));
  // 各进程加载 db.ts 到 teams 那段的快慢不一：在那里凑齐 N 个再一起进去（最多等 10 秒，见 db.ts 的 testBarrier）
  const meetDir = join(dir, 'meet-teams'); // 集合点的目录要在系统临时目录或 DATA_DIR 之下
  mkdirSync(meetDir, { recursive: true });
  const tup = await Promise.all(Array.from({ length: N }, () => run(`const m = await import(${JSON.stringify(DB_URL)});
console.log(JSON.stringify({ gaps: ${teamGaps} }));`, { DATA_DIR: dir, WM_TEST_SCHEMA_BARRIER: `teams@${N}@${meetDir}` })));
  check(tup.every((r) => !r.timedOut && r.exit === 0 && r.result?.gaps === 0),
    `${N} 个进程在 teams 那段前面集合、同一时刻进去：全部成功，八列都补回来`, tup.map((r) => (r.timedOut ? 'timeout' : r.exit !== 0 ? `exit ${r.exit}: ${r.err}` : `gaps=${r.result?.gaps}`)));

  console.log('八、旧库缺只增触发器');
  const AO = ['task_events_no_replace', 'wbe_log_no_replace', 'custom_role_events_no_update', 'custom_role_events_no_delete', 'custom_role_events_no_replace',
    'team_events_no_update', 'team_events_no_delete', 'team_events_no_replace',
    'knowledge_project_dept_log_no_update', 'knowledge_project_dept_log_no_delete', 'knowledge_project_dept_log_no_replace',
    // 第二批（#976 裁定）
    ...['bench_bind_audit', 'bench_mcp_audit', 'mcp_grant_audit', 'sop_run_file_audit', 'sop_run_upgrade_audit', 'workbench_var_audit', 'a2a_roster_changes', 'task_center_events']
      .flatMap((t) => [`${t}_no_update`, `${t}_no_delete`, `${t}_no_replace`]),
    'mcp_calls_no_update', 'mcp_calls_no_replace', 'a2a_seat_token_log_no_update', 'a2a_seat_token_log_no_replace',
    'wbe_events_no_update', 'wbe_events_no_replace', 'login_events_seen_no_update', 'attention_answers_done_fixed', 'attention_answers_done_kept',
    'a2a_inbound_receipts_no_update', 'a2a_inbound_receipts_no_delete', 'work_item_requests_no_update', 'work_item_requests_no_delete', 'work_item_requests_no_replace',
    ...['a2a_rosters', 'a2a_roster_seats'].flatMap((t) => [`${t}_frozen_insert`, `${t}_frozen_update`, `${t}_frozen_delete`])];
  const aoGaps = `${JSON.stringify(AO)}.filter((n) => !m.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(n)).length`;
  const aoBefore = await run(schemaCode, { DATA_DIR: dir });
  const aoDrop = await run(`const m = await import(${JSON.stringify(DB_URL)}); m.db.exec(${JSON.stringify(AO.map((n) => `DROP TRIGGER ${n};`).join(' '))});
console.log(JSON.stringify({ gaps: ${aoGaps} }));`, { DATA_DIR: dir });
  check(aoBefore.exit === 0 && aoDrop.exit === 0 && aoDrop.result?.gaps === AO.length, `（准备）拿掉 ${AO.length} 条只增触发器冒充旧库`, summary([aoDrop]));
  const aoAt = Date.now() + 1200;
  const aoUp = await Promise.all(Array.from({ length: N }, () => run(`${PREWARM}
while (Date.now() < ${aoAt}) {}
const m = await import(${JSON.stringify(DB_URL)});
console.log(JSON.stringify({ gaps: ${aoGaps} }));`, { DATA_DIR: dir })));
  const aoAfter = await run(schemaCode, { DATA_DIR: dir });
  check(aoUp.every((r) => !r.timedOut && r.exit === 0 && r.result?.gaps === 0) && aoAfter.exit === 0
    && JSON.stringify(aoBefore.result) === JSON.stringify(aoAfter.result),
    `${N} 个进程同时加载这个旧库：全部成功；触发器都补回来了，整库的列和索引、触发器、视图都和原来一样`,
    aoUp.map((r) => (r.timedOut ? 'timeout' : r.exit !== 0 ? `exit ${r.exit}: ${r.err}` : `gaps=${r.result?.gaps}`)));

  console.log('九、触发器定义变了也会更新（#1057：报告维度生效指针的守卫）');
  const T = 'report_dimensions_active_reviewed';
  const tStale = await run(`const m = await import(${JSON.stringify(DB_URL)});
m.db.exec("DROP TRIGGER ${T}; CREATE TRIGGER ${T} BEFORE UPDATE OF active_version ON report_dimensions BEGIN SELECT 1; END");
console.log(JSON.stringify({ after: m.triggerSql(${JSON.stringify(T)}) }));`, { DATA_DIR: dir });
  check(tStale.exit === 0 && /SELECT 1; END$/.test(tStale.result?.after ?? ''), '（准备）库里的触发器换成了一个过时的定义（冒充 #1046 时的旧库）', summary([tStale]));
  const tAt = Date.now() + 1200;
  const tUp = await Promise.all(Array.from({ length: N }, () => run(`${PREWARM}
while (Date.now() < ${tAt}) {}
const m = await import(${JSON.stringify(DB_URL)});
console.log(JSON.stringify({ setup: m.reportDimensionsActiveReviewedSetup, ok: m.triggerSql(${JSON.stringify(T)}) === m.REPORT_DIMENSIONS_ACTIVE_REVIEWED_SQL }));`, { DATA_DIR: dir, WM_TEST_SCHEMA_PAUSE_MS: String(PAUSE_MS) })));
  check(allOk(tUp) && count(tUp, 'replaced') === 1 && count(tUp, 'unchanged') === N - 1,
    `${N} 个进程同时加载（核对、删、建之间各停 ${PAUSE_MS} 毫秒）：全部成功；只有一个重写触发器（replaced），其余看到已经是新定义就跳过；最后的定义就是 db.ts 里的那一份`, summary(tUp));
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`db-startup-race-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
