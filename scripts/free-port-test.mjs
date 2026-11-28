#!/usr/bin/env node
/** scripts/lib/free-port.mjs 的正反例：端口不重复、相邻端口一并预留、被占的端口不会发出、withPortRetry 只对端口原因重试。 */
import { createServer } from 'node:net';
import { freePort, withPortRetry } from './lib/free-port.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const listen = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(null)); s.listen(port, '127.0.0.1', () => resolve(s)); });

const ports = [];
for (let i = 0; i < 40; i++) ports.push(await freePort());
ok('连取 40 次互不重复', new Set(ports).size === 40);
ok('相邻的 +1 也没被别的次发出', ports.every((p) => !ports.includes(p + 1)));
ok('都在 1024–65534 内', ports.every((p) => p > 1024 && p <= 65534));

// 发出的端口 +1 没有监听（脚本里有「业务端口 + 1 没有监听」的断言）
const probe = await listen(ports[0] + 1);
ok('发出端口的 +1 可以被占用（确实空闲）', probe !== null);
probe?.close();

// 反例：被占的端口不会发出——占住一批，再取，结果里不含被占的
const held = [];
for (let i = 0; i < 5; i++) { const s = await listen(0); held.push(s); }
const heldPorts = held.map((s) => s.address().port);
const more = [];
for (let i = 0; i < 20; i++) more.push(await freePort());
ok('被占着的端口不会再发出', more.every((p) => !heldPorts.includes(p) && !heldPorts.includes(p + 1)));
held.forEach((s) => s.close());

// 确定性用例：把随机数钉死，让「随机挑中的端口」每次都是同一个，才能区分「查了已发端口/相邻端口」和「碰巧没撞上」
{
  const realRandom = Math.random;
  try {
    Math.random = () => 0.5; // 候选端口恒为 26000
    const first = await freePort();
    const second = await freePort();
    ok('随机挑中同一个端口时，第二次不会再发出同一个端口，也不发相邻的（已发端口记录有效）', first !== second && Math.abs(first - second) > 1, { first, second });
    Math.random = () => 0.6; // 候选端口恒为 27200
    const blocker = await listen(27201);
    if (blocker) {
      const got = await freePort();
      ok('随机挑中的端口的 +1 被别的进程占着：跳过它，不发出（相邻端口检查有效）', got !== 27200 && got !== 27201, { got });
      blocker.close();
    } else ok('（跳过）27201 本机已被占，无法构造相邻被占的场景', true);
  } finally { Math.random = realRandom; }
}

// withPortRetry
let calls = 0;
const r1 = await withPortRetry(async () => { if (++calls < 3) { const e = new Error('listen EADDRINUSE: address already in use'); throw e; } return 'ok'; }, 3, () => {});
ok('端口被占：换端口重试，第 3 次成功', r1 === 'ok' && calls === 3);
calls = 0;
let err1 = null;
try { await withPortRetry(async () => { calls++; throw new Error('隔离实例没起来：{"reason":"surface-not-listening"}'); }, 3, () => {}); } catch (e) { err1 = e; }
ok('一直占着：重试到上限后照实抛出', err1 && calls === 3);
calls = 0;
let err2 = null;
try { await withPortRetry(async () => { calls++; throw new Error('SyntaxError: 代码改坏了'); }, 3, () => {}); } catch (e) { err2 = e; }
ok('别的原因（代码起不来）不重试，直接抛', err2 && calls === 1);

console.log(`free-port-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
