#!/usr/bin/env node
/**
 * 建事项时的标题和派给（试联看出来的两处）：
 *
 *   标题：任务中心发布的事项取任务标题；任务没了、标题空白、不是任务中心来的，退到来源坐标「来源 · 台 · 条目」
 *   派给：事件每个投递的目标团队（投递表里一个事件对一个团队只有一行），按投递顺序用「, 」连起来；没有投递（unrouted）是空串
 *   新建：回填和实时建出来的一样（syncEvent）
 *   存量：标题还是来源坐标、派给空着的，启动时补上（不随回填版本走）；人改过的标题不动；重复跑不再改（返回 0）
 *
 * 进程内，临时数据目录，不起服务。启动补存量那一条起一个子进程装事项服务。
 *
 *   node scripts/work-item-title-team-test.mjs              测本仓库
 *   node scripts/work-item-title-team-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-title-team-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { db } = await import(at('server/src/db.ts'));
  const ev = await import(at('server/src/workbench-events.ts'));
  ev.initWorkbenchEvents();

  // ---------- 造数据：任务、事件、投递、「已记录」那一行 ----------
  const task = (title) => Number(db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'published')").run(title).lastInsertRowid);
  let n = 0;
  const event = (source, workbench, item, teams) => {
    const id = 'wbe-' + (++n).toString(16).padStart(16, '0');
    db.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, ?, ?, ?, ?, 'human', 'human:x', 1, 'h', 1, ?)")
      .run(id, source, workbench, item, `wb:${workbench}:${n}`, teams.length ? 'target' : 'unrouted');
    db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, NULL, 'market', 'recorded', '{}')").run(id);
    for (const t of teams) {
      const d = Number(db.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, message) VALUES (?, ?, 'http://peer.invalid', 'market/test', 'held', '')").run(id, t).lastInsertRowid);
      db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'held', ?)").run(id, d, JSON.stringify({ target_team: t }));
    }
    return id;
  };
  const t1 = task('  试联：用一句话\n说明这次联调的目的  '), tBlank = task('   ');
  const E = {
    titled: event('task-center', 'task-center', `task:${t1}`, ['dsh/canvas/b', 'dsh/canvas/a']),
    gone: event('task-center', 'sop-x', 'task:999', ['dsh/canvas/c']),
    blank: event('task-center', 'task-center', `task:${tBlank}`, []),
    oddItem: event('task-center', 'task-center', 'task:0x1', ['dsh/canvas/d']),
    appData: event('app-data', 'shop-form', 'item:5', ['dsh/canvas/e']),
  };
  const coord = (src, wb, item) => `${src} · ${wb} · ${item}`;

  const { root } = await import(at('server/src/root-context.ts'));
  const { WorkItemService, itemIdForEvent } = await import(at('server/src/services/work-item.ts'));
  await root.plugin(WorkItemService);
  const items = root.get('workItems');
  for (let i = 0; i < 2000 && items.backfillStatus().state !== 'done'; i++) await new Promise((r) => setImmediate(r));
  const get = (k) => items.get(itemIdForEvent(E[k]));

  // ---------- 新建（回填建出来的） ----------
  check(get('titled')?.title === '试联：用一句话 说明这次联调的目的', '任务中心发布的事项：标题取任务标题（空白收成一个空格、去首尾）', show(get('titled')?.title));
  check(get('titled')?.target_team === 'dsh/canvas/b, dsh/canvas/a', '派给：每个投递的目标团队，按投递顺序、用「, 」连起来（held 的也算）', show(get('titled')?.target_team));
  check(get('gone')?.title === coord('task-center', 'sop-x', 'task:999') && get('gone')?.target_team === 'dsh/canvas/c', '任务没了：标题退到来源坐标；派给照样写上', show(get('gone')));
  check(get('blank')?.title === coord('task-center', 'task-center', `task:${tBlank}`) && get('blank')?.target_team === '', '任务标题空白：退到来源坐标；没有投递（unrouted）派给是空串', show(get('blank')));
  check(get('oddItem')?.title === coord('task-center', 'task-center', 'task:0x1'), '条目不是 task:<正整数>（0x1）：不去查任务，退到来源坐标', show(get('oddItem')?.title));
  check(get('appData')?.title === coord('app-data', 'shop-form', 'item:5') && get('appData')?.target_team === 'dsh/canvas/e', '台数据来的：标题是来源坐标（没有任务标题），派给照样写上', show(get('appData')));

  // ---------- 实时建（syncEvent） ----------
  {
    const t2 = task('实时发布的任务');
    const id = event('task-center', 'task-center', `task:${t2}`, ['dsh/canvas/f']);
    items.syncEvent(id);
    const w = items.get(itemIdForEvent(id));
    check(w?.title === '实时发布的任务' && w.target_team === 'dsh/canvas/f', '实时建事项（syncEvent）和回填一样：任务标题、派给', show(w));
  }

  // ---------- 存量：补自动的缺省值 ----------
  const asOld = () => {
    for (const k of Object.keys(E)) {
      const e = db.prepare('SELECT source, workbench, item FROM workbench_events WHERE event_id = ?').get(E[k]);
      db.prepare("UPDATE work_items SET title = ?, target_team = '' WHERE id = ?").run(coord(e.source, e.workbench, e.item), itemIdForEvent(E[k]));
    }
    db.prepare("UPDATE work_items SET title = '人改过的标题' WHERE id = ?").run(itemIdForEvent(E.gone));
  };
  asOld();
  db.prepare("UPDATE work_items SET title = '也被改过' WHERE id = ?").run(itemIdForEvent(E.titled));
  items.syncEvent(E.titled);
  check(get('titled')?.title === '也被改过' && get('titled')?.target_team === 'dsh/canvas/b, dsh/canvas/a', '任务还在、标题却被改过：同步时标题不动（只换自动起的来源坐标），派给补上', show(get('titled')));
  asOld();
  items.syncEvent(E.titled);
  check(get('titled')?.title === '试联：用一句话 说明这次联调的目的' && get('titled')?.target_team === 'dsh/canvas/b, dsh/canvas/a', '存量事项再同步一次（来了新的事件日志）：同一个规则补上标题和派给', show(get('titled')));
  asOld();
  const filled = items.fillDerivedAll();
  check(get('titled')?.title === '试联：用一句话 说明这次联调的目的' && get('titled')?.target_team === 'dsh/canvas/b, dsh/canvas/a', '存量事项：标题还是来源坐标的换成任务标题，派给空着的写上', show(get('titled')));
  check(get('gone')?.title === '人改过的标题' && get('gone')?.target_team === 'dsh/canvas/c', '标题不是来源坐标（别处改过的）：不动；派给照样补', show(get('gone')));
  check(get('appData')?.title === coord('app-data', 'shop-form', 'item:5') && get('appData')?.target_team === 'dsh/canvas/e', '台数据来的存量：标题不变，派给补上', show(get('appData')));
  check(filled === 4, '补了 4 件（titled、gone、oddItem、appData；blank 没有可补的）', show(filled));
  const before = show(db.prepare('SELECT id, title, target_team, updated_at FROM work_items ORDER BY id').all());
  check(items.fillDerivedAll() === 0 && show(db.prepare('SELECT id, title, target_team, updated_at FROM work_items ORDER BY id').all()) === before, '再跑一遍：一件不改（返回 0，行逐字相同）');
  const logs = db.prepare("SELECT COUNT(*) AS n FROM work_item_log WHERE fact NOT IN ('create', 'submit', 'note')").get().n;
  check(logs === 0, '补标题、派给不写事项日志（它们是从事件推出来的显示信息，不是事实）', show(logs));

  // ---------- 启动时补存量 ----------
  {
    asOld();
    db.close?.();
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
      const { WorkItemService, itemIdForEvent } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
      await root.plugin(WorkItemService);
      const items = root.get('workItems');
      for (let i = 0; i < 2000 && items.backfillStatus().state !== 'done'; i++) await new Promise((r) => setImmediate(r));
      const w = items.get(itemIdForEvent(${JSON.stringify(E.titled)}));
      console.log('STARTED ' + JSON.stringify({ title: w.title, team: w.target_team }));
      process.exit(0);`], { env: { ...process.env, DATA_DIR: OUT }, encoding: 'utf8' });
    const m = /STARTED (.*)/.exec(child.stdout);
    const r = m ? JSON.parse(m[1]) : null;
    check(r?.title === '试联：用一句话 说明这次联调的目的' && r.team === 'dsh/canvas/b, dsh/canvas/a' && /补了 \d+ 件存量事项/.test(child.stdout),
      '重启装上事项服务：回填版本没变也补存量的标题和派给，并记一行', show({ r, out: child.stdout.slice(-300), err: child.stderr.slice(-300) }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
