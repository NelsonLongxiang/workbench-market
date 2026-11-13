/**
 * 调 ygl-trees 的命令行（同机，无 shell）：统一待办（tasks.ts）、经验库（services/knowledge.ts）、MCP 上游都经这里找入口。
 *
 * 入口：node + 包内真实入口 dist/bundle/bin.cjs（Windows shim 不经 shell）。找的先后：
 *   ① WM_YGL_CLI（显式给的入口文件，绝对路径；部署方把 ygl-trees 装在别处、测试接假的命令行都用它）；
 *   ② node 同目录的 node_modules；③ PNPM_HOME；④ APPDATA/npm。都没有就 null，调用方按「来源不可用」降级。
 * 工作区：YGL_HOME（绝对路径），调用方各自判断要不要。
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { defineConfig, loadConfig, str } from './config.ts';

export const Config = defineConfig((env) => {
  const cli = str(env.WM_YGL_CLI);
  // 显式给了就要是绝对路径：相对路径随启动目录变，宁可拒绝启动也不悄悄找错
  if (cli && !isAbsolute(cli)) throw new Error('WM_YGL_CLI 要是 ygl-trees 入口文件的绝对路径');
  return { cli, home: str(env.YGL_HOME), pnpmHome: env.PNPM_HOME, appData: env.APPDATA };
});
const config = loadConfig(Config);

/** ygl-trees 的入口文件；找不到返回 null */
export function yglCliEntry(): string | null {
  if (config.cli) {
    try { return statSync(config.cli).isFile() ? config.cli : null; } catch { return null; }
  }
  for (const base of [dirname(process.execPath), config.pnpmHome, config.appData ? config.appData + '\\npm' : null]) {
    if (!base) continue;
    const cand = join(base, 'node_modules', 'ygl-trees', 'dist', 'bundle', 'bin.cjs');
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** 工作区（YGL_HOME）：要是存在的绝对路径目录，否则 null */
export function yglHome(): string | null {
  const home = config.home;
  if (!home || !isAbsolute(home)) return null;
  try { return statSync(home).isDirectory() ? home : null; } catch { return null; }
}

export type YglResult = { ok: true; code: 0; json: unknown } | { ok: false; code: number | null; json: unknown; error: 'no_cli' | 'no_home' | 'timeout' | 'exit' | 'not_json' };

/**
 * 调一次，按 ygl-trees 的 --json 契约读 stdout：退出 0 且 stdout 是一个 JSON 值才算成；
 * 退出码非 0 时 stdout 若是 JSON（比如 rc 1 的 {"error":…}）照样交回去，调用方据此区分「不存在」和「坏了」。
 */
export function execYgl(args: readonly string[], opts: { timeoutMs: number; home?: string; maxBuffer?: number }): Promise<YglResult> {
  return new Promise((resolve) => {
    const entry = yglCliEntry();
    if (!entry) return resolve({ ok: false, code: null, json: null, error: 'no_cli' });
    const home = opts.home ?? yglHome();
    if (!home) return resolve({ ok: false, code: null, json: null, error: 'no_home' });
    try {
      execFile(process.execPath, [entry, ...args], { timeout: opts.timeoutMs, windowsHide: true, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, env: { ...process.env, YGL_HOME: home } }, (err, stdout) => {
        let json: unknown = null, parsed = false;
        try { json = JSON.parse(String(stdout)); parsed = true; } catch { /* 不是 JSON */ }
        if (!err) return resolve(parsed ? { ok: true, code: 0, json } : { ok: false, code: 0, json: null, error: 'not_json' });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string };
        if (e.killed || e.signal === 'SIGTERM') return resolve({ ok: false, code: null, json: null, error: 'timeout' });
        resolve({ ok: false, code: typeof e.code === 'number' ? e.code : null, json: parsed ? json : null, error: 'exit' });
      });
    } catch { resolve({ ok: false, code: null, json: null, error: 'exit' }); }
  });
}
