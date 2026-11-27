#!/usr/bin/env node
/**
 * server/src/knowledge-startup.ts 的单测（#894 复活、#1089）：经验库接入的启动自检行。
 * 一、纯函数：三样都齐是 info；缺入口、YGL_HOME 没设、目录不在、库文件不在、目录或库文件不可写、同步周期 0 各自 warn 并点名。
 * 二、读真实状态：设好 WM_YGL_CLI、YGL_HOME 再导入，指到 tmp/ 下的假入口和假工作区。夹具只在 tmp/，跑完删掉。
 *
 *   node scripts/knowledge-startup-line-unit.mjs
 */
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + JSON.stringify(extra)); } };

const base = join(ROOT, 'tmp', 'knowledge-startup-line-unit-' + process.pid);
rmSync(base, { recursive: true, force: true });
const cli = join(base, 'ygl', 'bin.cjs'), home = join(base, 'home');
mkdirSync(join(base, 'ygl'), { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(cli, '// fake ygl-trees entry\n');
process.env.WM_YGL_CLI = cli;
process.env.YGL_HOME = home;
try {
  const { knowledgeStartupLine, knowledgeStartupState } = await import('../server/src/knowledge-startup.ts');

  console.log('一、纯函数');
  const good = { cli: '/opt/ygl/node_modules/ygl-trees/dist/bundle/bin.cjs', homeRaw: '/var/lib/ygl', home: '/var/lib/ygl', dbPresent: true, writable: true, dbWritable: true, syncMinutes: 10 };
  const g = knowledgeStartupLine(good);
  ok('三样都齐：info，一行里报入口、YGL_HOME（有 ygl-trees.db）和「每 10 分钟」，没有问题项',
    g.level === 'info' && g.problems.length === 0 && g.line.startsWith('[knowledge] 经验库接入：') && g.line.includes(good.cli) && g.line.includes('/var/lib/ygl（有 ygl-trees.db）') && g.line.includes('每 10 分钟'), g);
  const cases = {
    noCli: [{ ...good, cli: null }, '找不到 ygl-trees 命令行'],
    noHomeEnv: [{ ...good, homeRaw: '', home: null, dbPresent: false, writable: false, dbWritable: null }, 'YGL_HOME 没设'],
    homeMissing: [{ ...good, home: null, dbPresent: false, writable: false, dbWritable: null }, '库源没挂上'],
    emptyHome: [{ ...good, dbPresent: false, dbWritable: null }, '库源是空的'],
    syncZero: [{ ...good, syncMinutes: 0 }, 'WM_KNOWLEDGE_SYNC_MINUTES=0'],
    notWritable: [{ ...good, writable: false }, 'YGL_HOME 不可写'],
    dbReadonly: [{ ...good, dbWritable: false }, 'ygl-trees.db 不可写'],
  };
  const readonlyLine = knowledgeStartupLine(cases.dbReadonly[0]);
  ok('库文件不可写时，启动行标出「（不可写）」',
    readonlyLine.line.includes(good.home + '（有 ygl-trees.db）（不可写）'), readonlyLine);
  const got = Object.fromEntries(Object.entries(cases).map(([k, [s, want]]) => { const r = knowledgeStartupLine(s); return [k, r.level === 'warn' && r.problems.length === 1 && r.problems[0].includes(want) && r.line.includes('经验库不会同步：')]; }));
  ok('缺一样就 warn，并且只点名那一样：没有入口、YGL_HOME 没设、目录不在、库文件不在、目录或库文件不可写、同步周期 0', Object.values(got).every(Boolean), got);
  const all = knowledgeStartupLine({ cli: null, homeRaw: '', home: null, dbPresent: false, writable: false, dbWritable: null, syncMinutes: 0 });
  ok('生产上的那种状态（周期 0、没有命令行、没有库源）三样一起点名', all.level === 'warn' && all.problems.length === 3 && all.line.includes('同步关闭（0）'), all);

  console.log('二、读真实状态');
  const s1 = knowledgeStartupState(10);
  ok('WM_YGL_CLI 指到存在的文件、YGL_HOME 是存在的目录但没有库文件：入口认出、库源判「空」', s1.cli === cli && s1.home === home && s1.homeRaw === home && s1.dbPresent === false && s1.dbWritable === null && s1.writable === true && knowledgeStartupLine(s1).problems.join('').includes('库源是空的'), s1);
  const dbFile = join(home, 'ygl-trees.db');
  writeFileSync(dbFile, '');
  const s2 = knowledgeStartupState(10);
  ok('放进 ygl-trees.db 之后三样都齐：info', s2.dbPresent === true && s2.dbWritable === true && knowledgeStartupLine(s2).level === 'info', s2);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const readonlyState = (path, mode) => {
      const originalMode = statSync(path).mode & 0o777;
      try {
        chmodSync(path, mode);
        return knowledgeStartupState(10);
      } finally {
        chmodSync(path, originalMode);
      }
    };
    const s3 = readonlyState(home, 0o555);
    const dirWarning = knowledgeStartupLine(s3);
    ok('工作区目录只读：警告指出目录不可写，且工作区路径后标「（不可写）」',
      !s3.writable && dirWarning.level === 'warn' && dirWarning.problems.some((p) => p.startsWith('YGL_HOME 不可写'))
      && dirWarning.line.includes(home + '（有 ygl-trees.db）（不可写）'), dirWarning);
    const s4 = readonlyState(dbFile, 0o444);
    const fileWarning = knowledgeStartupLine(s4);
    ok('工作区可写而库文件只读：警告指出库文件不可写，且工作区路径后标「（不可写）」',
      s4.writable && s4.dbPresent && fileWarning.level === 'warn' && fileWarning.problems.length === 1
      && fileWarning.problems[0].startsWith('ygl-trees.db 不可写')
      && fileWarning.line.includes(home + '（有 ygl-trees.db）（不可写）'), fileWarning);
    ok('恢复权限后自检回到 info', knowledgeStartupLine(knowledgeStartupState(10)).level === 'info');
  } else console.log('  - 跳过 POSIX 只读权限用例（需要非 root 用户）');
  rmSync(cli);
  ok('入口文件拿走：判「找不到 ygl-trees 命令行」', knowledgeStartupState(10).cli === null);
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log('\nknowledge-startup-line-unit: ' + pass + ' passed / ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
