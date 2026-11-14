/**
 * 录制回放用的夹具（--import 预加载）：给市场进程配上内容面（随配置才挂的那几层），端口每次现找一个空的。
 *
 * 内容面的配置要在 index.ts 读环境变量之前定好，端口又得是空的、每次不一样，所以由这里找好端口、写进 process.env：
 *   WM_CONTENT_PORT         现找的空闲端口（只听 127.0.0.1）
 *   WM_CONTENT_IP           127.0.0.1
 *   WM_CONTENT_MARKET_ORIGIN http://market.replay.test（请求带 Host: market.replay.test 才算从可信入口来；面按端口认，不看 Host）
 *   WM_CONTENT_TARGETS      两个目标：2 号台开迁移（migrateBrowser），3 号台不开；上游指到不可达的 127.0.0.1:9（录制不走到代理那一步）；目标主机名照内容面的规矩写成 w-<号>-test.internal（合成的）
 *   WM_CONTENT_ODOO_ORIGIN、WM_ODOO_URL、IDENTITY_FAKE_TRUSTED_ORIGIN  http://odoo.replay.test（查看人认的是可信 Odoo 源；配合 identity-fake 夹具认人，假登录方也要认这个源）
 * 内容面自己的端口写进页面的只有启动页里的表单地址，那一条请求只比状态码。
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里给市场配上内容面。
 */
import { createServer } from 'node:net';

if (process.env.NODE_ENV !== 'test') {
  console.error('[content-surface-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
});
const ODOO = 'http://odoo.replay.test';
Object.assign(process.env, {
  WM_CONTENT_PORT: String(port),
  WM_CONTENT_IP: '127.0.0.1',
  WM_CONTENT_MARKET_ORIGIN: 'http://market.replay.test',
  WM_CONTENT_TARGETS: JSON.stringify([
    { id: 2, origin: `http://w-2-test.internal:${port}`, upstreamUrl: 'http://127.0.0.1:9/', migrateBrowser: true },
    { id: 3, origin: `http://w-3-test.internal:${port}`, upstreamUrl: 'http://127.0.0.1:9/' },
  ]),
  WM_CONTENT_ODOO_ORIGIN: ODOO,
  WM_ODOO_URL: ODOO,
  IDENTITY_FAKE_TRUSTED_ORIGIN: ODOO,
});
