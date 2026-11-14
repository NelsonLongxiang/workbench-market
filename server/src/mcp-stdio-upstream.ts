/** #474 ygl-trees 作为 MCP 上游：市场按配置启动 `ygl-trees mcp`（stdio），把它的工具以 <前缀>__<工具> 并进 /mcp。
 *  只认这一种内置程序：入口由服务端自己解析（与统一待办同一个 ygl-trees），配置里只写前缀和工作区目录，不能写任意命令。
 *  安全口径：
 *    - 子进程只拿运行必需的系统变量，不继承市场的口令、令牌、网关密钥；HOME 指向工作区，不读宿主用户目录下的配置。
 *    - YGL_VERIFY_ALLOW_CMD 显式置空：verify 的 command 型检查一律判 ERROR，远程会话不能借它在宿主机上执行命令。
 *    - 工作区必须是已存在的绝对路径目录，且不能是服务端自己的 YGL_HOME（统一待办读的那份，属主个人工作区）。
 *    - 一个前缀一个子进程，调用串行；超时就杀掉子进程，下次调用重启（状态不明时不复用）。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { yglCliEntry } from './tasks.ts';
import { defineConfig, loadConfig, passEnv, str } from './config.ts';

/** 服务端自己的工作区（统一待办读的那份）：上游不许指到它 */
export const Config = defineConfig((env) => ({ yglHome: str(env.YGL_HOME) }));
const config = loadConfig(Config);

export interface YglUpstreamCfg { prefix: string; yglHome: string }

const MAX_LINE = 8 * 1024 * 1024;

/** 工作区目录不合格时返回原因（中文），合格返回 null */
export function yglHomeProblem(home: unknown): string | null {
  if (typeof home !== 'string' || !home.trim()) return 'ygl_home 必填';
  if (!isAbsolute(home) || home.includes('\0')) return 'ygl_home 必须是绝对路径';
  if (home.split(/[\\/]/).includes('..')) return 'ygl_home 不能含 ..';
  let real: string;
  try {
    if (!statSync(home).isDirectory()) return 'ygl_home 不是目录';
    real = realpathSync(home);
  } catch { return 'ygl_home 不存在'; }
  const own = config.yglHome;
  if (own) { try { if (realpathSync(own) === real) return 'ygl_home 不能是服务端自己的 YGL_HOME（统一待办读的那份工作区）'; } catch { /* 服务端的工作区不存在，不冲突 */ } }
  return null;
}

/** 子进程环境：只放运行必需的系统变量 + 工作区，市场自己的环境变量一个不带 */
export function yglChildEnv(cfg: YglUpstreamCfg): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = passEnv(['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']);
  env.HOME = cfg.yglHome;
  env.USERPROFILE = cfg.yglHome;
  env.YGL_HOME = cfg.yglHome;
  env.YGL_VERIFY_ALLOW_CMD = '';
  env.YGL_SESSION = `market-${cfg.prefix}`;
  return env;
}

interface Pending { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

class StdioMcpClient {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private entry: string;
  private cfg: YglUpstreamCfg;
  constructor(entry: string, cfg: YglUpstreamCfg) { this.entry = entry; this.cfg = cfg; }

  private fail(p: ChildProcess, why: string): void {
    if (this.proc !== p) return;
    this.proc = null; this.ready = null;
    for (const [, x] of this.pending) { clearTimeout(x.timer); x.reject(new Error(`upstream ${this.cfg.prefix}: ${why}`)); }
    this.pending.clear();
  }

  private start(timeoutMs: number): Promise<void> {
    const p = spawn(process.execPath, [this.entry, 'mcp'], { cwd: this.cfg.yglHome, env: yglChildEnv(this.cfg), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = p;
    const rl = createInterface({ input: p.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length > MAX_LINE) return;
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (!m || typeof m.id !== 'number') return;
      const x = this.pending.get(m.id);
      if (!x) return;
      this.pending.delete(m.id); clearTimeout(x.timer); x.resolve(m);
    });
    p.on('exit', () => this.fail(p, '子进程已退出'));
    p.on('error', () => this.fail(p, '子进程启动失败'));
    p.stdin!.on('error', () => this.fail(p, '子进程输入关闭'));
    this.ready = this.send(p, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'workbench-market', version: '1' } }, timeoutMs)
      .then((m) => {
        if (m.error) throw new Error(`upstream ${this.cfg.prefix}: 初始化失败`);
        p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      });
    return this.ready;
  }

  private send(p: ChildProcess, method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`upstream ${this.cfg.prefix}: 超时（${timeoutMs}ms）`));
        // 状态不明：杀掉，下次调用重启
        if (this.proc === p) { this.proc = null; this.ready = null; try { p.kill(); } catch { /* 已退出 */ } }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); } catch { /* stdin 已关，由 exit 统一回 */ }
    });
  }

  /** 串行执行：同一个工作区一次只跑一个调用 */
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const run = async () => {
      if (!this.proc || !this.ready) this.start(timeoutMs);
      await this.ready;
      const m = await this.send(this.proc!, method, params, timeoutMs);
      if (m.error) throw new Error(`upstream ${this.cfg.prefix}: ${m.error.message ?? 'error'}`);
      return m.result;
    };
    const r = this.chain.then(run, run);
    this.chain = r.catch(() => undefined);
    return r;
  }

  close(): void {
    const p = this.proc;
    this.proc = null; this.ready = null;
    if (p) { try { p.kill(); } catch { /* 已退出 */ } }
  }
}

const clients = new Map<string, { key: string; client: StdioMcpClient }>();

/** 调 ygl-trees 上游；配置变了（工作区或入口不同）就换一个子进程 */
export function yglUpstreamRpc(cfg: YglUpstreamCfg, method: string, params: unknown, timeoutMs: number): Promise<any> {
  const problem = yglHomeProblem(cfg.yglHome);
  if (problem) return Promise.reject(new Error(`upstream ${cfg.prefix}: ${problem}`));
  const entry = yglCliEntry();
  if (!entry) return Promise.reject(new Error(`upstream ${cfg.prefix}: 服务端没装 ygl-trees`));
  const key = JSON.stringify([entry, realpathSync(cfg.yglHome)]);
  let c = clients.get(cfg.prefix);
  if (!c || c.key !== key) { c?.client.close(); c = { key, client: new StdioMcpClient(entry, cfg) }; clients.set(cfg.prefix, c); }
  return c.client.request(method, params, timeoutMs);
}

/** 上游配置整体替换时调用：关掉所有子进程，下次调用按新配置重启 */
export function closeYglUpstreams(): void {
  for (const [, c] of clients) c.client.close();
  clients.clear();
}
