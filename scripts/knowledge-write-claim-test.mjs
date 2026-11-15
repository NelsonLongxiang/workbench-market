#!/usr/bin/env node
/**
 * 记成经验的写入只由一方执行（单测，不起 HTTP）：同一行待写不能同时被「当场试写」和「后台重试」各写一次，
 * 后完成的一方失败也不能把已经写成的状态改回待写。
 *   一、当场试写进行中，后台重试那一轮到点：命令行只被调一次，remember 回 written；
 *   二、一行到点的待写，两轮后台重试同时跑：命令行只被调一次，状态是 written。
 * 每种情况在一个子进程里跑。临时数据目录、假的 ygl-trees 命令行（delay_ms 让每次调用慢一点，好让两方真的并发），都是合成的。
 *   node scripts/knowledge-write-claim-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FAKE_CLI = join(HERE, 'fixtures', 'ygl-library-fake.mjs');
const at = (p) => pathToFileURL(join(ROOT, p)).href;

if (process.argv[2] === '--child') {
  const mode = process.argv[3];
  const { ctx } = await import(at('server/src/context.ts'));
  const svc = ctx.knowledge;
  const fx = join(process.env.YGL_HOME, 'library-fixture.json');
  const fixture = (patch) => writeFileSync(fx, JSON.stringify({ ...JSON.parse(readFileSync(fx, 'utf8')), ...patch }));
  const kbCalls = () => { try { return readFileSync(join(process.env.YGL_HOME, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('kb add')).length; } catch { return 0; } };
  // 经服务自己的查询读状态，不直接开库
  const statusOf = (key) => svc.rememberedOf([key]).get(key);
  const input = (key) => ({ answerKey: key, principal: 'synthetic-admin', scope: '*', cue: '合成：并发写入', lesson: '同一行只写一次', evidence: 'market:answer/synthetic' });
  let result;
  if (mode === 'inline-vs-retry') {
    // 当场试写开始（命令行还没应答）时，后台重试那一轮到点
    const now = Date.now();
    const p = svc.remember(input('k-inline'), now);
    const round = svc.retryWrites(now);
    const [out] = await Promise.all([p, round]);
    result = { outcome: out.status, status: statusOf('k-inline'), calls: kbCalls() };
  } else if (mode === 'retry-vs-retry') {
    // 先让第一次写失败，留下一行到点的待写；再让命令行恢复（慢一点），两轮重试同时跑
    fixture({ kb_add_fail: 'exit1' });
    const first = await svc.remember(input('k-retry'));
    fixture({ kb_add_fail: null });
    const before = kbCalls();
    const later = Date.now() + 60_000;
    await Promise.all([svc.retryWrites(later), svc.retryWrites(later)]);
    result = { first: first.status, status: statusOf('k-retry'), calls: kbCalls() - before };
  }
  process.stdout.write(`result=${JSON.stringify(result)}\n`);
  await ctx.registry.delete(svc.constructor)?.dispose?.();
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const OUT = join(ROOT, 'tmp', `knowledge-write-claim-${process.pid}-${Date.now().toString(36)}`);
rmSync(OUT, { recursive: true, force: true });

function child(mode) {
  const dir = join(OUT, mode), ygl = join(dir, 'ygl'), data = join(dir, 'data');
  mkdirSync(ygl, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(ygl, 'library-fixture.json'), JSON.stringify({ items: { claim: [], note: [], skill: [], check: [] }, bodies: {}, delay_ms: 400 }));
  // 后台重试的定时器不开（=0），两方的「到点」都由子进程手动触发，时序可控
  const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: data, YGL_HOME: ygl, WM_YGL_CLI: FAKE_CLI, WM_KNOWLEDGE_SYNC_MINUTES: '0', WM_KNOWLEDGE_WRITE_RETRY_SECONDS: '0' };
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--child', mode], { env, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('result='));
  return { rc: r.status, result: line ? JSON.parse(line.slice(7)) : null, stderr: (r.stderr ?? '').slice(-800) };
}

try {
  const a = child('inline-vs-retry');
  check(a.rc === 0 && a.result?.outcome === 'written' && a.result.status === 'written' && a.result.calls === 1,
    '一、当场试写进行中、后台重试到点：命令行只调一次，remember 回 written', JSON.stringify(a));
  const b = child('retry-vs-retry');
  check(b.rc === 0 && b.result?.first === 'pending' && b.result.status === 'written' && b.result.calls === 1,
    '二、到点的待写、两轮重试同时跑：命令行只调一次，状态是 written', JSON.stringify(b));
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`knowledge-write-claim-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
