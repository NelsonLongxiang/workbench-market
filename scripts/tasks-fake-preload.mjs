/**
 * 录制回放用的夹具（--import 预加载）：给统一待办（/api/tasks）准备三个假的来源，每次的应答都一样。
 *   · ygl-trees：临时目录里放一个工作区（YGL_HOME 指过去）和一个占位的命令行入口（PNPM_HOME 指过去）；
 *     市场调这个入口时被截下，不起子进程：project list 回两个进行中的项目 alpha、beta，task list 按项目各回两条（一条待办、一条已完成）。
 *   · A2A：本机起一个假的状态端点（只听 127.0.0.1），A2A_STATE_URL、A2A_API_KEY 指过去；在途一条、归档一条；键不对回 401。
 *   · 扩展来源：临时目录里放三个扩展（WM_EXTENSIONS_DIR 指过去）：replay-ok 按 cookie 里有没有 session_id 回一条或要求登录；
 *     replay-broken 的 collect 一调就抛错，replay-leaky 不抛错、自己在 meta 里回 ok:false 和一段原始错误
 *     （两种都录「来源降级为稳定码，不透传原始错误」）。
 * 所有东西都是合成的：项目名、标题、团队名、键都不是真的。临时目录在进程退出时删掉。
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里把待办来源指到假的上。
 */
import { createServer } from 'node:http';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.NODE_ENV !== 'test') {
  console.error('[tasks-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'wm-tasks-fake-'));
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 退出时尽力而为 */ } });

// ---------- ygl-trees ----------
const yglHome = join(root, 'ygl-home');
mkdirSync(yglHome);
writeFileSync(join(yglHome, 'ygl-trees.db'), 'replay-synthetic-ygl-workspace');
const cliDir = join(root, 'pnpm-home', 'node_modules', 'ygl-trees', 'dist', 'bundle');
mkdirSync(cliDir, { recursive: true });
writeFileSync(join(cliDir, 'bin.cjs'), '// 占位：只会经 tasks-fake-preload 的截获走到');
process.env.YGL_HOME = yglHome;
process.env.PNPM_HOME = join(root, 'pnpm-home');

const native = cp.execFile;
cp.execFile = function (file, args, options, callback) {
  const entry = String(args?.[0] ?? '').replaceAll('\\', '/');
  if (!entry.endsWith('/ygl-trees/dist/bundle/bin.cjs')) return native.call(this, file, args, options, callback);
  const a = args.slice(1);
  let rows;
  if (a[0] === 'project') rows = [{ name: 'alpha', status: 'active' }, { name: 'beta', status: 'active' }, { name: 'gamma', status: 'archived' }];
  else {
    const project = a.find((x) => x.startsWith('--project='))?.slice('--project='.length) ?? '';
    const base = { alpha: 10, beta: 20 }[project] ?? 90; // 编号在工作区里唯一：每个项目一段
    rows = [
      { id: base + 1, title: `replay ${project} 待办`, status: 'todo', due: '2030-01-02', project },
      { id: base + 2, title: `replay ${project} 已完成`, status: 'done', due: null, project },
    ];
  }
  queueMicrotask(() => callback(null, JSON.stringify(rows), ''));
  return { kill() {} };
};
syncBuiltinESMExports();

// ---------- A2A 状态端点 ----------
const A2A_KEY = 'replay-synthetic-a2a-key-0123456789';
const a2a = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-api-key'] !== A2A_KEY) { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
  if (req.url !== '/__dsh_a2a/state') { res.statusCode = 404; res.end('{}'); return; }
  res.end(JSON.stringify({
    tasks: [{ taskId: 'replay-a2a-1', team: 'replay-team', peer: 'replay-peer', direction: 'out', brief: 'replay 在途任务' }],
    archived: [{ taskId: 'replay-a2a-0', team: 'replay-team', endedBy: 'receipt', outcome: 'done', summary: 'replay 已归档任务' }],
  }));
});
await new Promise((resolve) => a2a.listen(0, '127.0.0.1', resolve));
a2a.unref();
process.env.A2A_STATE_URL = `http://127.0.0.1:${a2a.address().port}`;
process.env.A2A_API_KEY = A2A_KEY;

// ---------- 扩展来源 ----------
const extDir = join(root, 'extensions');
mkdirSync(join(extDir, 'replay-ok'), { recursive: true });
mkdirSync(join(extDir, 'replay-broken'), { recursive: true });
mkdirSync(join(extDir, 'replay-leaky'), { recursive: true });
writeFileSync(join(extDir, 'replay-ok', 'server.mjs'), `export function register(ctx) {
  ctx.tasks.addSource({ key: 'replay-ok', label: 'replay 扩展来源', color: 'blue', async collect(req) {
    const signedIn = /(?:^|;\\s*)session_id=/.test(String(req.headers.cookie ?? ''));
    if (!signedIn) return { tasks: [], meta: { ok: false, count: 0, latency_ms: 0, auth_required: true } };
    return { tasks: [
      { id: 'replay-ok:1', source: 'replay-ok', title: 'replay 扩展待办', status: 'todo', due: null, link: null, project: null },
      { id: 'other:1', source: 'other', title: '别的来源键的条目（宿主应丢掉）', status: 'todo', due: null, link: null, project: null },
    ], meta: { ok: true, count: 1, latency_ms: 0 } };
  } });
}
`);
writeFileSync(join(extDir, 'replay-broken', 'server.mjs'), `export function register(ctx) {
  ctx.tasks.addSource({ key: 'replay-broken', label: 'replay 坏来源', async collect() { throw new Error('replay-synthetic-private-detail'); } });
}
`);
writeFileSync(join(extDir, 'replay-leaky', 'server.mjs'), `export function register(ctx) {
  ctx.tasks.addSource({ key: 'replay-leaky', label: 'replay 自报错误的来源', async collect() {
    return { tasks: [], meta: { ok: false, count: 0, latency_ms: 0, error: 'replay-synthetic-private-detail' } };
  } });
}
`);
process.env.WM_EXTENSIONS_DIR = extDir;
