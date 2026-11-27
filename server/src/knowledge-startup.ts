/**
 * 经验库接入的启动自检行（#894 复活、#1089）：生产上经验库「从未同步」，原因是同步周期被设成 0、容器里没有 ygl-trees 命令行和正式库源，
 * 而启动时这三样都不报。这里启动时打一行，把三样一起报出来；有一样不满足就是 warn，并点名哪样——不拒绝启动（0 是合法配置，没接 ygl 也能跑）。
 * 只依赖 ygl-cli.ts 与文件系统，不导入 db.ts；同步周期由调用方（index.ts）从经验库的配置读好传进来。
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { yglCliEntry, yglHome, yglHomeRaw } from './ygl-cli.ts';

export type KnowledgeStartupState = {
  /** ygl-trees 入口文件；没找到是 null */
  cli: string | null;
  /** YGL_HOME 原值；没设是空串 */
  homeRaw: string;
  /** 可用的工作区目录（存在的绝对路径）；不能用是 null */
  home: string | null;
  /** 工作区里有 ygl-trees.db */
  dbPresent: boolean;
  /** 运行用户能写工作区目录 */
  writable: boolean;
  /** 运行用户能写库文件（「记成经验」要写库）；没有库文件时为 null */
  dbWritable: boolean | null;
  /** 同步周期（分钟），0 = 不同步 */
  syncMinutes: number;
};

/** 读本机实际状态（入口、工作区、库文件）；同步周期由调用方给 */
export function knowledgeStartupState(syncMinutes: number): KnowledgeStartupState {
  const home = yglHome();
  const dbPath = home === null ? null : join(home, 'ygl-trees.db');
  const dbPresent = dbPath !== null && existsSync(dbPath);
  return {
    cli: yglCliEntry(),
    homeRaw: yglHomeRaw(),
    home,
    dbPresent,
    writable: home !== null && canWrite(home),
    dbWritable: dbPresent ? canWrite(dbPath) : null,
    syncMinutes,
  };
}

function canWrite(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

/** 启动自检那一行：三样都齐是 info；缺哪样就 warn 并逐项点名（经验库不会同步的原因） */
export function knowledgeStartupLine(s: KnowledgeStartupState): { level: 'info' | 'warn'; line: string; problems: string[] } {
  const problems: string[] = [];
  if (!s.cli) problems.push('找不到 ygl-trees 命令行（WM_YGL_CLI 没设或指的文件不在，安装目录里也没有）');
  if (!s.homeRaw) problems.push('YGL_HOME 没设（没有库源）');
  else if (!s.home) problems.push('YGL_HOME 不是已存在的绝对路径目录（库源没挂上）');
  else if (!s.dbPresent) problems.push('YGL_HOME 里没有 ygl-trees.db（库源是空的）');
  if (s.home && !s.writable) problems.push('YGL_HOME 不可写（运行用户写不进，「记成经验」会失败）');
  if (s.dbWritable === false) problems.push('ygl-trees.db 不可写（运行用户写不进库文件，「记成经验」会失败）');
  if (s.syncMinutes === 0) problems.push('同步周期是 0（WM_KNOWLEDGE_SYNC_MINUTES=0，不同步）');
  const home = s.home ? s.home + (s.dbPresent ? '（有 ygl-trees.db）' : '（没有 ygl-trees.db）') + (s.writable && s.dbWritable !== false ? '' : '（不可写）') : s.homeRaw ? s.homeRaw + '（不可用）' : '没设';
  const line = '[knowledge] 经验库接入：ygl-trees 入口 ' + (s.cli ?? '没找到') + '；YGL_HOME ' + home + '；同步' + (s.syncMinutes ? '每 ' + s.syncMinutes + ' 分钟' : '关闭（0）')
    + (problems.length ? '。经验库不会同步：' + problems.join('；') : '');
  return { level: problems.length ? 'warn' : 'info', line, problems };
}
