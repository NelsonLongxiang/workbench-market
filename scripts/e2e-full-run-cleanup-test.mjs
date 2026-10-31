#!/usr/bin/env node
/** e2e-full-run 收尾机械回归（#303 监督席 Windows 复核 6539695141）：cleanupOwn 只在**确认自起 server 已退出**后删自己的 TMP。
 *  ① 真子进程正常退出 → 删 TMP、退出码不变；② 假子进程 kill 后始终不发 exit（到期仍活着）→ 不删 TMP、不调 rm、退出码非 0、报出 PID；
 *  ③ 已退出但 rm 抛 EPERM → 如实非 0；④ 原退出码已非 0 时保持原码。 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupOwn } from './e2e-full-run.mjs';

const root = resolve('tmp/e2e-cleanup-test-' + process.pid);
const mk = (n) => { const d = join(root, n); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'f'), 'x'); return d; };
const quiet = () => { const lines = []; return { lines, log: (m) => lines.push(m) }; };
let passed = 0;
const check = async (name, f) => { await f(); passed++; console.log('PASS ' + name); };
try {
  await check('真子进程正常退出：删 TMP、退出码 0', async () => {
    const d = mk('ok');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    assert.equal(await cleanupOwn(child, d, 0, { timeoutMs: 5000 }), 0);
    assert.equal(existsSync(d), false);
  });
  await check('到期仍未退出：不删 TMP、不调 rm、退出码非 0、报 PID', async () => {
    const d = mk('stuck'); const q = quiet(); let rmCalls = 0, kills = 0;
    const fake = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null, kill: () => { kills++; return true; } });
    const t0 = Date.now();
    const code = await cleanupOwn(fake, d, 0, { timeoutMs: 200, rm: () => { rmCalls++; }, log: q.log });
    assert.ok(Date.now() - t0 >= 190, '应等满截止时间');
    assert.equal(kills, 1); assert.equal(rmCalls, 0, '未退出不得尝试删除');
    assert.notEqual(code, 0); assert.equal(existsSync(join(d, 'f')), true, 'TMP 现场应保留');
    assert.ok(q.lines.some((l) => l.includes('424242') && l.includes(d)), q.lines.join('\n'));
  });
  await check('已退出但 rm 抛 EPERM：如实非 0', async () => {
    const d = mk('eperm'); const q = quiet();
    const done = Object.assign(new EventEmitter(), { pid: 1, exitCode: 0, signalCode: null, kill: () => assert.fail('已退出不应再 kill') });
    const code = await cleanupOwn(done, d, 0, { rm: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); }, log: q.log });
    assert.notEqual(code, 0); assert.ok(q.lines.some((l) => l.includes('EPERM')));
  });
  await check('原退出码已非 0：保持原码', async () => {
    const d = mk('keep');
    const fake = Object.assign(new EventEmitter(), { pid: 2, exitCode: null, signalCode: null, kill: () => true });
    assert.equal(await cleanupOwn(fake, d, 3, { timeoutMs: 50, rm: () => {}, log: () => {} }), 3);
  });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`e2e-full-run-cleanup-test: ${passed}/4 PASS`);
