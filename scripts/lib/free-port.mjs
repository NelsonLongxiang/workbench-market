/** 冒烟脚本取端口的统一写法（#1165 的做法抽成共享件）。
 *  随机取 20000–32000 或写死端口，都不查占用：撞上同脚本里已在跑的实例、上一个脚本没退干净的子进程，或系统刚发给别人的临时端口时，
 *  请求会落到别的实例上，或实例绑不上端口。这里一律让系统分配，并记下本进程发过的端口。
 *  残余窗口：探测 socket 关掉到子进程绑定之间，系统仍可能把这个端口给别的进程——所以起实例的脚本应配 withPortRetry 重试。 */
import { createServer } from 'node:net';

const taken = new Set();

function listenFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(0));
    probe.listen(port, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => resolve(p)); });
  });
}

/** 取一个空闲端口。先在 20000–32000 里随机挑并实测可绑定（这一段在 macOS（49152 起）和 Linux（32768 起）的临时端口段之下：
 *  系统直接分配的端口落在临时端口段里，测试自己发请求的客户端端口会和「业务端口 + 1」撞上——vault-smoke 开控制面时见过自检收到 404/400）；
 *  50 次没挑到再退回系统分配。adjacent（缺省 1）个相邻端口也要空闲并一并预留：有的脚本把业务端口 +1 当控制面端口、或断言 +1 没有监听。
 *  上限 65534 - adjacent：spawn 的受管夹具（owned-script-fixture）不收更大的端口。 */
export async function freePort({ adjacent = 1 } = {}) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await listenFree(attempt < 40 ? 20000 + Math.floor(Math.random() * 12000) : 0);
    if (!port || port > 65534 - adjacent) continue;
    const span = Array.from({ length: adjacent + 1 }, (_, i) => port + i);
    if (span.some((p) => taken.has(p))) continue;
    let free = true;
    for (const p of span.slice(1)) if (!(await listenFree(p))) { free = false; break; }
    if (!free) continue;
    for (const p of span) taken.add(p);
    return port;
  }
  throw new Error('50 次都没取到未用过的空闲端口');
}

/** 起实例的脚本用：start() 里取端口并启动；只有「端口被别人占了」这一类失败（err.portBusy，或报错/输出里有 EADDRINUSE、
 *  surface-not-listening）换端口重来，最多 attempts 次；别的失败（代码改坏了起不来）不重试，直接抛。 */
export async function withPortRetry(start, attempts = 3, note = (line) => console.error(line)) {
  for (let attempt = 1; ; attempt++) {
    try { return await start(); }
    catch (err) {
      const busy = err?.portBusy || /EADDRINUSE|surface-not-listening/.test(String(err?.message ?? err));
      if (!busy || attempt >= attempts) throw err;
      note(`[free-port] 端口被别的进程占了，换一个再起（第 ${attempt + 1} 次）`);
    }
  }
}
