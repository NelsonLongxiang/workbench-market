#!/usr/bin/env node
/**
 * 对外面的快照：路由（带挂载顺序，和每条路由前面挂的守卫）、MCP 工具、表结构。
 * 起一个隔离实例（临时数据目录、随机回环端口、固定的最小环境变量），从运行中的进程里导出，
 * 再和 surfaces/ 下已提交的三份比较。改了面（加路由、加工具、改表）就跑一次 --write，
 * 连同代码一起提交：PR 里看得见面变了什么。
 *
 *   node scripts/surface-snapshot.mjs             比较；不一致退出 1，并列出差异
 *   node scripts/surface-snapshot.mjs --write     把当前的面写进 surfaces/
 *   node scripts/surface-snapshot.mjs --json      只输出 {changed, counts}（给路线体检用），退出码恒为 0
 *   node scripts/surface-snapshot.mjs --selftest  比较逻辑的自检（不起实例）
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const FILES = { routes: 'routes.json', tools: 'mcp-tools.json', schema: 'schema.json' };
const ENV_NOTE = '隔离实例：MCP_GATEWAY=off、NODE_ENV=test、WM_CONTROL_PORT=0，不带任何别的配置。随配置才挂的路由、用到才建的表不在其中。';

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

/** 起隔离实例，导出三份面。 */
async function exportSurfaces() {
  const { MCP_TOOLS } = await import(pathToFileURL(join(ROOT, 'server/src/mcp-tools.ts')).href);
  const tools = MCP_TOOLS.map((t) => `${t.name}  ${t.category}${t.exempt ? '  exempt' : ''}`).sort();

  const port = await freePort();
  const data = join(ROOT, 'tmp', `surface-snapshot-${process.pid}`);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(HERE, 'surface-recorder.mjs')).href, 'src/index.ts'], {
    cwd: join(ROOT, 'server'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200; } catch { /* 还没起来 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`隔离实例没起来：${stderr.trim().split('\n').slice(-3).join(' | ') || '没有输出'}`);
    const apps = await new Promise((resolveDump, reject) => {
      const timer = setTimeout(() => reject(new Error('实例没有回传路由（10 秒超时）')), 10000);
      child.on('message', (msg) => { if (msg?.wmSurface) { clearTimeout(timer); resolveDump(msg.wmSurface); } });
      child.send('wm-surface-dump');
    });
    return { routes: { note: ENV_NOTE, apps }, tools, schema: readSchema(join(data, 'workbench-market.db')) };
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
    rmSync(data, { recursive: true, force: true });
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
  console.log(failed ? `===== 快照自检：${failed} 项失败 =====` : '===== 快照自检：全过 =====');
  return failed ? 1 : 0;
}

async function main() {
  if (flag('--selftest')) process.exit(selftest());
  const fresh = await exportSurfaces();
  const counts = {
    routes: fresh.routes.apps.flat().filter((line) => !line.trim().startsWith('USE ')).length,
    tools: fresh.tools.length,
    tables: Object.keys(fresh.schema.tables).length,
  };
  if (flag('--write')) {
    mkdirSync(OUT, { recursive: true });
    for (const [key, name] of Object.entries(FILES)) writeFileSync(join(OUT, name), render(fresh[key]));
    say(`已写入 surfaces/：${counts.routes} 条路由、${counts.tools} 个工具、${counts.tables} 张表`);
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
    : `✓ 三份快照与当前的面一致：${counts.routes} 条路由、${counts.tools} 个工具、${counts.tables} 张表`);
  return changed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(`[surface-snapshot] ${err.message}`); process.exit(2); });
