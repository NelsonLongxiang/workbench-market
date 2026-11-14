#!/usr/bin/env node
/**
 * 经验库后台同步的生命周期（单测，不起 HTTP）：同步是周期任务，要随服务一起停，出错不能把进程带崩。
 *   一、服务没停、库先关了（别的测试载入服务端模块、用完关库，就是这样）：排着的那一轮照跑，碰到「库没开」接住，
 *       记一行（不带路径），进程正常退出、没有未接的错误；
 *   二、起服务、马上停、关库：排着的第一轮不再开始，假命令行一次都没被调，没有告警；
 *   三、同步跑到一半（命令行还没应答）停服务、关库：应答回来以后不再碰库，进程正常退出，没有告警；
 *   四、同上但库不关：停了以后一行都不写（条目、同步状态都没有）。
 * 每种情况在一个子进程里跑（崩不崩看子进程的退出码和 stderr）。临时数据目录、假的 ygl-trees 命令行，都是合成的。
 *   node scripts/knowledge-lifecycle-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FAKE_CLI = join(HERE, 'fixtures', 'ygl-library-fake.mjs');
const at = (p) => pathToFileURL(join(ROOT, p)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === '--child') {
  // 子进程：DATA_DIR、YGL_HOME、WM_YGL_CLI、WM_KNOWLEDGE_SYNC_MINUTES 由父进程给
  const mode = process.argv[3];
  // 和真的进程一样从 context.ts 进（它装上全部服务，经验库在其中）；停服务就是把经验库这个插件从注册表里卸掉
  const { ctx } = await import(at('server/src/context.ts'));
  const { db } = await import(at('server/src/db.ts'));
  const { KnowledgeService } = await import(at('server/src/services/knowledge.ts'));
  const stop = async () => { await ctx.registry.delete(KnowledgeService)?.dispose?.(); };
  if (mode === 'close-only') db.close();
  else if (mode === 'stop-then-close') { await stop(); db.close(); }
  else if (mode === 'stop-midway' || mode === 'stop-midway-open') {
    // 等第一轮真的调到命令行（calls.log 出现），在它应答之前停服务（stop-midway 再关库；-open 不关库，看停了以后有没有往库里写）
    const log = join(process.env.YGL_HOME, 'calls.log');
    for (let i = 0; i < 200 && !existsSync(log); i++) await sleep(10);
    await stop();
    if (mode === 'stop-midway') db.close();
  }
  await sleep(1500);  // 等过排着的那一轮和命令行的应答
  if (mode === 'stop-midway-open') {
    const n = (sql) => db.prepare(sql).get().n;
    process.stdout.write(`rows=${JSON.stringify({ items: n('SELECT COUNT(*) AS n FROM knowledge_items'), sync: n('SELECT COUNT(*) AS n FROM knowledge_sync') })}\n`);
  }
  process.stdout.write('child-done\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const OUT = join(ROOT, 'tmp', `knowledge-lifecycle-${process.pid}-${Date.now().toString(36)}`);
rmSync(OUT, { recursive: true, force: true });

function child(mode, fixture) {
  const dir = join(OUT, mode), ygl = join(dir, 'ygl'), data = join(dir, 'data');
  mkdirSync(ygl, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(ygl, 'library-fixture.json'), JSON.stringify({ items: { note: [{ kind: 'note', id: 'n1', title: '合成', summary: '', scope: '*', created: '2030-01-01T00:00:00Z', updated: '2030-01-01T00:00:00Z' }] }, ...fixture }));
  const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: data, YGL_HOME: ygl, WM_YGL_CLI: FAKE_CLI, WM_KNOWLEDGE_SYNC_MINUTES: '1' };
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], { env, encoding: 'utf8', timeout: 60_000 });
  const calls = existsSync(join(ygl, 'calls.log')) ? readFileSync(join(ygl, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', calls, root: dir };
}
const lines = (err) => err.split('\n').filter((l) => l.includes('[knowledge]'));

try {
  {
    const r = child('close-only', {});
    const ks = lines(r.err);
    check(r.code === 0 && r.out.includes('child-done') && !/Unhandled|ERR_INVALID_STATE\b.*\n\s+at /.test(r.err) && !r.err.includes('    at ')
      && ks.length === 1 && ks[0].includes('经验库后台同步出错') && ks[0].includes('下一轮再试') && !ks[0].includes(r.root) && !ks[0].includes('/'),
      '库先关、服务没停：排着的一轮碰到「库没开」接住，记一行不带路径，进程正常退出', JSON.stringify({ code: r.code, err: r.err.slice(-600) }));
  }
  {
    const r = child('stop-then-close', {});
    check(r.code === 0 && r.out.includes('child-done') && r.calls === 0 && lines(r.err).length === 0 && !r.err.includes('    at '),
      '起服务、马上停、关库：排着的第一轮不再开始，命令行一次都没调，没有告警、没有未接的错误', JSON.stringify({ code: r.code, calls: r.calls, err: r.err.slice(-600) }));
  }
  {
    const r = child('stop-midway', { delay_ms: 400 });
    check(r.code === 0 && r.out.includes('child-done') && r.calls === 1 && lines(r.err).length === 0 && !r.err.includes('    at '),
      '跑到一半停：命令行应答回来以后不再碰库、不再调下一类，进程正常退出、没有告警', JSON.stringify({ code: r.code, calls: r.calls, err: r.err.slice(-600) }));
  }
  {
    const r = child('stop-midway-open', { delay_ms: 400 });
    const rows = JSON.parse(/rows=(\{.*\})/.exec(r.out)?.[1] ?? 'null');
    check(r.code === 0 && r.calls === 1 && rows?.items === 0 && rows?.sync === 0 && lines(r.err).length === 0,
      '跑到一半停、库还开着：命令行应答回来以后一行都不写（条目、同步状态都没有）', JSON.stringify({ code: r.code, calls: r.calls, rows, err: r.err.slice(-400) }));
  }
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`knowledge-lifecycle-test: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
