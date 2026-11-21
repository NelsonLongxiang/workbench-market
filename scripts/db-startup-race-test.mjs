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
 *
 *   node scripts/db-startup-race-test.mjs              测本仓库
 *   node scripts/db-startup-race-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `db-startup-race-${process.pid}-${Date.now().toString(36)}`);
const DB_URL = pathToFileURL(join(ROOT, 'server', 'src', 'db.ts')).href;
const N = 8;
const CHILD_TIMEOUT_MS = 30_000;
const PAUSE_MS = 300;

let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };

/** 起一个子进程跑一段代码；超时杀掉，按失败交回（timedOut: true） */
function run(code, env) {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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
const loadCode = (startAt) => `while (Date.now() < ${startAt}) {}
const m = await import(${JSON.stringify(DB_URL)});
console.log(JSON.stringify({ setup: m.a2aRostersLiveSetup, ok: m.viewSql('a2a_rosters_live') === m.A2A_ROSTERS_LIVE_SQL }));`;
/** 在库里改视图（造「定义过时」「被删了」两种起点）：加载 db.ts 之后用它的连接改 */
const tamperCode = (sql) => `const m = await import(${JSON.stringify(DB_URL)}); m.db.exec(${JSON.stringify(sql)});
console.log(JSON.stringify({ after: m.viewSql('a2a_rosters_live') }));`;
const together = async (dir, env = {}) => {
  const startAt = Date.now() + 1500;
  return Promise.all(Array.from({ length: N }, () => run(loadCode(startAt), { DATA_DIR: dir, ...env })));
};
const summary = (rs) => rs.map((r) => (r.timedOut ? 'timeout' : r.exit !== 0 ? `exit ${r.exit}: ${r.err}` : `${r.result?.setup}/${r.result?.ok}`));
const count = (rs, setup) => rs.filter((r) => r.exit === 0 && r.result?.setup === setup).length;
const allOk = (rs) => rs.every((r) => !r.timedOut && r.exit === 0 && r.result?.ok === true);

rmSync(OUT, { recursive: true, force: true });
try {
  const dir = join(OUT, 'data');
  mkdirSync(dir, { recursive: true });

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
  check(prod.exit !== 0 && !prod.timedOut && /WM_TEST_SCHEMA_PAUSE_MS 只给测试用/.test(prod.err) && badVal.exit !== 0 && /0～5000/.test(badVal.err),
    '不是 NODE_ENV=test 时设了 WM_TEST_SCHEMA_PAUSE_MS：拒绝启动；值超出 0～5000：拒绝启动', { prod: summary([prod]), bad: summary([badVal]) });
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`db-startup-race-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
