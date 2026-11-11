#!/usr/bin/env node
/**
 * 对外面的快照：路由（带挂载顺序，和每条路由前面挂的守卫）、动作（每条路由报的动作名和类别，和路由一行对一行）、MCP 工具、表结构。
 * 起一个隔离实例（临时数据目录、在回环上探到的空闲端口、固定的最小环境变量），从运行中的进程里导出，
 * 再和 surfaces/ 下已提交的四份比较。动作清单和路由快照对不上（行数、顺序、方法、路径）直接报错。改了面（加路由、加工具、改表）就跑一次 --write，
 * 连同代码一起提交：PR 里看得见面变了什么。
 *
 *   node scripts/surface-snapshot.mjs             比较；不一致退出 1，并列出差异
 *   node scripts/surface-snapshot.mjs --write     把当前的面写进 surfaces/
 *   node scripts/surface-snapshot.mjs --json      只输出 {changed, counts}（给路线体检用），退出码恒为 0
 *   node scripts/surface-snapshot.mjs --selftest  比较逻辑的自检（不起实例）
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'surfaces');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const quiet = flag('--json');
const say = (text) => { if (!quiet) console.log(text); };

const FILES = { routes: 'routes.json', actions: 'actions.json', tools: 'mcp-tools.json', schema: 'schema.json' };
const ACTIONS_NOTE = '动作清单（阶段六 6a）：apps 和 routes.json 的路由行一一对应，「方法 路径 -> 动作 类别」；还直接挂在 Express 上的存量路由记（未登记），搬进域模块时补。tools 是 MCP 工具，类别沿用工具自己的（read 读、write 写、admin 管理）。';

/** 路由行和动作行的「方法 路径」部分（带缩进）：两边要一一对上 */
const routeKey = (line) => line.split('  <- ')[0];
const actionKey = (line) => line.split('  -> ')[0];
/** 动作清单和路由快照对不对得上：返回对不上的地方（空数组就是对上了） */
export function alignActions(routeApps, actionApps) {
  const problems = [];
  if (routeApps.length !== actionApps.length) problems.push(`应用个数不同：路由 ${routeApps.length}，动作 ${actionApps.length}`);
  routeApps.forEach((lines, i) => {
    const routes = lines.filter((l) => !l.trim().startsWith('USE ')).map(routeKey);
    const actions = (actionApps[i] ?? []).map(actionKey);
    if (routes.length !== actions.length) problems.push(`第 ${i + 1} 个应用：路由 ${routes.length} 条，动作 ${actions.length} 条`);
    routes.forEach((r, j) => { if (actions[j] !== r) problems.push(`第 ${i + 1} 个应用第 ${j + 1} 条：路由「${r.trim()}」对着动作「${String(actions[j] ?? '（没有）').trim()}」`); });
  });
  return problems;
}
const ENV_NOTE = '隔离实例：MCP_GATEWAY=off、NODE_ENV=test、WM_CONTROL_PORT=0，不带任何别的配置，按前端已构建的形态导出。随配置才挂的路由、用到才建的表不在其中。';
// 有没有 web/dist 会差三层（静态托管、页面兜底、404）。快照取「前端已构建」的形态：没构建时临时放一个占位目录，导出完就删。
const WEB_DIST = join(ROOT, 'web', 'dist');
const STUB_PREFIX = '.surface-snapshot-stub-';
const STUB_HTML = '<!doctype html><title>surface-snapshot</title>\n';
const stubMarks = () => { try { return readdirSync(WEB_DIST).filter((n) => n.startsWith(STUB_PREFIX)); } catch { return []; } };

/** 占位目录：每个进程放自己的标记，最后一个用完的才删目录；目录里出现了别的东西（真的构建产物）就不删。 */
function claimStub() {
  // 先清掉已经不在了的进程留下的标记（上次被 SIGKILL 的话，标记和占位目录都会留下）。
  for (const name of stubMarks()) {
    const pid = Number(name.slice(STUB_PREFIX.length));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) rmSync(join(WEB_DIST, name), { force: true });
  }
  const leftover = existsSync(WEB_DIST) && stubMarks().length === 0 && readdirSync(WEB_DIST).join() === 'index.html' && readFileSync(join(WEB_DIST, 'index.html'), 'utf8') === STUB_HTML;
  if (existsSync(WEB_DIST) && stubMarks().length === 0 && !leftover) return false; // 有真的构建产物，不动它
  mkdirSync(WEB_DIST, { recursive: true });
  writeFileSync(join(WEB_DIST, `${STUB_PREFIX}${process.pid}`), '');
  if (!existsSync(join(WEB_DIST, 'index.html'))) writeFileSync(join(WEB_DIST, 'index.html'), STUB_HTML);
  return true;
}
function releaseStub() {
  rmSync(join(WEB_DIST, `${STUB_PREFIX}${process.pid}`), { force: true });
  let names;
  try { names = readdirSync(WEB_DIST); } catch { return; }
  const onlyStub = names.length === 1 && names[0] === 'index.html' && readFileSync(join(WEB_DIST, 'index.html'), 'utf8') === STUB_HTML;
  if (onlyStub) rmSync(WEB_DIST, { recursive: true, force: true });
}

/** 收尾的事放在一处：正常结束、出错、被 SIGINT / SIGTERM 打断，都走这里。 */
const cleanups = [];
function cleanupAll() { while (cleanups.length) { try { cleanups.pop()(); } catch { /* 收尾不再抛 */ } } }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanupAll(); process.exit(130); });

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

function readSchema(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      tables[name] = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all()
        .map((c) => `${c.name} ${c.type || '-'}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''}${c.pk ? ' PK' : ''}`);
    }
    const named = (type) => db.prepare('SELECT name, tbl_name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL ORDER BY name').all(type)
      .map((r) => `${r.name} ON ${r.tbl_name}: ${flat(r.sql)}`);
    return { tables, indexes: named('index'), triggers: named('trigger') };
  } finally { db.close(); }
}

/** 起隔离实例，导出四份面。 */
async function exportSurfaces() {
  const { MCP_TOOLS } = await import(pathToFileURL(join(ROOT, 'server/src/mcp-tools.ts')).href);
  const tools = MCP_TOOLS.map((t) => `${t.name}  ${t.category}${t.exempt ? '  exempt' : ''}`).sort();
  const toolActions = MCP_TOOLS.map((t) => `${t.name}  ${t.category}`).sort();
  const { BUILTINS, NARROWED, unknownBuiltinActions } = await import(pathToFileURL(join(ROOT, 'server/src/judgment-builtins.ts')).href);
  const { PLATFORM_ROLES, SYSTEM_DOMAINS, BUSINESS_DOMAINS, unclassifiedDomains } = await import(pathToFileURL(join(ROOT, 'server/src/roles.ts')).href);

  if (claimStub()) cleanups.push(releaseStub);
  const port = await freePort();
  const data = join(ROOT, 'tmp', `surface-snapshot-${process.pid}`);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  // 实例确认退出之后才删（见 finally）；删不掉只警告，不改结果
  cleanups.push(() => { try { rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.warn(`⚠ 临时目录没删干净（不影响结果）：${data}：${e?.code ?? e}`); } });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(HERE, 'surface-recorder.mjs')).href, 'src/index.ts'], {
    cwd: join(ROOT, 'server'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200; } catch { /* 还没起来 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) {
      // 报错的那一行通常在中间（后面是调用栈和 Node 版本），挑带 Error 的；挑不到就取开头几行。
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const why = lines.find((l) => /Error|错误|拒绝/.test(l)) || lines.slice(0, 2).join(' ') || '没有输出';
      throw new Error(`隔离实例没起来：${why.slice(0, 200)}`);
    }
    const dumped = await new Promise((resolveDump, reject) => {
      const timer = setTimeout(() => reject(new Error('实例没有回传路由（10 秒超时）')), 10000);
      child.on('message', (msg) => { if (msg?.wmSurface) { clearTimeout(timer); resolveDump(msg); } });
      child.send('wm-surface-dump');
    });
    const apps = dumped.wmSurface, actionApps = dumped.wmActions ?? [];
    const misaligned = alignActions(apps, actionApps);
    if (misaligned.length) throw new Error(`动作清单和路由快照对不上：${misaligned.slice(0, 5).join('；')}`);
    // 内置身份（judgment-builtins.ts）清单里的动作都要在：路由报的（含细分的）或 MCP 工具名。对不上导出失败
    const known = new Set(MCP_TOOLS.map((t) => t.name));
    for (const line of actionApps.flat()) for (const m of String(line).matchAll(/(?:-> |；细分：)([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)  /g)) known.add(m[1]);
    const unknown = unknownBuiltinActions((a) => known.has(a));
    if (unknown.length) throw new Error(`内置身份引用了动作清单里没有的动作：${unknown.join('、')}`);
    const builtins = { identities: BUILTINS.map((b) => ({ name: b.name, label: b.label, ...(b.roles ? { roles: [...b.roles] } : {}), actions: [...b.actions], actsForOwner: [...b.actsForOwner] })), narrowed: NARROWED.map((n) => ({ action: n.action, only: [...n.only], why: n.why })) };
    // 每个已登记动作的域要么在系统域清单里、要么明确算业务：两边都不算的导出失败（新长出来的域要有人决定它算哪边）
    const loose = unclassifiedDomains(known);
    if (loose.length) throw new Error(`动作的域没有归类（server/src/roles.ts 的 SYSTEM_DOMAINS 或 BUSINESS_DOMAINS）：${loose.join('、')}`);
    const domains = { system: [...SYSTEM_DOMAINS], business: [...BUSINESS_DOMAINS] };
    const presets = PLATFORM_ROLES.map((r) => ({ id: r.id, name: r.name, ...(r.includes ? { includes: [...r.includes] } : {}), permissions: r.permissions.map((p) => ({ ...p })) }));
    return { routes: { note: ENV_NOTE, apps }, actions: { note: ACTIONS_NOTE, apps: actionApps, tools: toolActions, builtins, domains, presets }, tools, schema: readSchema(join(data, 'workbench-market.db')) };
  } finally {
    // 先请它退出；3 秒不退就强杀，并且等到它真的退出，再删数据目录
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
    child.kill('SIGTERM');
    await waitExit(3000);
    if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); }
    cleanupAll();
  }
}

const render = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** 两份文本的差异：多出来的行、少掉的行；行都一样但文本不同，就是顺序变了。 */
export function diffLines(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const ca = count(a), cb = count(b);
  const removed = [], added = [];
  for (const [line, n] of ca) for (let i = cb.get(line) || 0; i < n; i++) removed.push(line.trim());
  for (const [line, n] of cb) for (let i = ca.get(line) || 0; i < n; i++) added.push(line.trim());
  return { added, removed, reordered: added.length === 0 && removed.length === 0 && before !== after };
}

function selftest() {
  let failed = 0;
  const check = (ok, label) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) failed++; };
  const base = 'a\nb\nc\n';
  check(diffLines(base, base).added.length === 0 && !diffLines(base, base).reordered, '相同：没有差异');
  check(diffLines(base, 'a\nb\nc\nd\n').added.join() === 'd', '多了一行：点名多出来的');
  check(diffLines(base, 'a\nc\n').removed.join() === 'b', '少了一行：点名少掉的');
  check(diffLines(base, 'b\na\nc\n').reordered, '只换了顺序：报顺序变了');
  check(diffLines('a\na\n', 'a\n').removed.length === 1, '重复的行按次数算');
  const routes = [['USE /  <- query', 'GET /a  <- h', 'POST /a  <- g, h', 'USE /x  <- router', '  GET /b  <- h']];
  check(alignActions(routes, [['GET /a  -> a.read  read', 'POST /a  -> a.create  admin', '  GET /b  -> （未登记）']]).length === 0, '动作和路由一一对上：没有问题');
  check(alignActions(routes, [['GET /a  -> a.read  read', '  GET /b  -> （未登记）']]).length > 0, '少了一条动作：报对不上');
  check(alignActions(routes, [['POST /a  -> a.create  admin', 'GET /a  -> a.read  read', '  GET /b  -> （未登记）']]).length > 0, '顺序不同：报对不上');
  check(alignActions(routes, [['GET /a  -> a.read  read', 'POST /a  -> a.create  admin', 'GET /b  -> （未登记）']]).length > 0, '缩进（挂载层级）不同：报对不上');
  check(alignActions(routes, []).length > 0, '没有动作清单：报对不上');
  console.log(failed ? `===== 快照自检：${failed} 项失败 =====` : '===== 快照自检：全过 =====');
  return failed ? 1 : 0;
}

async function main() {
  if (flag('--selftest')) process.exit(selftest());
  const fresh = await exportSurfaces();
  const counts = {
    routes: fresh.routes.apps.flat().filter((line) => !line.trim().startsWith('USE ')).length,
    actions: fresh.actions.apps.flat().filter((line) => !line.endsWith('（未登记）')).length,
    tools: fresh.tools.length,
    tables: Object.keys(fresh.schema.tables).length,
  };
  if (flag('--write')) {
    mkdirSync(OUT, { recursive: true });
    for (const [key, name] of Object.entries(FILES)) writeFileSync(join(OUT, name), render(fresh[key]));
    say(`已写入 surfaces/：${counts.routes} 条路由（${counts.actions} 条报了动作）、${counts.tools} 个工具、${counts.tables} 张表`);
    return 0;
  }
  const changed = [];
  for (const [key, name] of Object.entries(FILES)) {
    const file = join(OUT, name);
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const after = render(fresh[key]);
    if (before === after) continue;
    changed.push(name);
    const d = diffLines(before, after);
    say(`\n✗ surfaces/${name} 与当前的面不一致${before ? '' : '（文件不存在）'}`);
    for (const line of d.added.slice(0, 20)) say(`  + ${line}`);
    for (const line of d.removed.slice(0, 20)) say(`  - ${line}`);
    if (d.added.length + d.removed.length > 40) say(`  …共多 ${d.added.length} 行、少 ${d.removed.length} 行`);
    if (d.reordered) say('  行都一样，顺序变了');
  }
  if (quiet) { console.log(JSON.stringify({ changed, counts })); return 0; }
  say(changed.length ? '\n面变了：确认是有意的，就跑 node scripts/surface-snapshot.mjs --write，连同代码一起提交。'
    : `✓ 四份快照与当前的面一致：${counts.routes} 条路由（${counts.actions} 条报了动作）、${counts.tools} 个工具、${counts.tables} 张表`);
  return changed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(`[surface-snapshot] ${err.message}`); process.exit(2); });
