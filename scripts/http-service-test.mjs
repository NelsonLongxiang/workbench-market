#!/usr/bin/env node
/**
 * HTTP 服务（server/src/http.ts）的单测。不起市场实例、不碰数据目录：每组自己建一个 Cordis 上下文，应用只在回环的随机端口上听。
 *   H1 经服务注册的路由，和直接写 app.get(...) 落在同一个栈、同一个位置，处理函数原样（不包装）：两边的路由栈逐行相同
 *   H2 注册返回撤销函数：撤销后这条路由从栈里消失，请求落到后面的层；别的路由不动；撤销两次不出错；再注册是挂在栈尾
 *   H3 插件里注册的路由随插件卸载一起撤销；根上和别的插件注册的不动
 *   H4 撤销是换一个新数组：撤销发生时正在处理中的请求照样走完后面的层
 *   H5 不带处理函数的注册直接报错，栈不变（Express 里 app.get(x) 是读配置项）
 *   H6 expressApp() 给出的是 Express 应用本身，不是代理
 */
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 从 server/ 解析 express 和 cordis：拿到的才是 server 自己用的那一份
const require = createRequire(pathToFileURL(join(ROOT, 'server/src/http.ts')));
const express = require('express');
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { HttpService } = await import(pathToFileURL(join(ROOT, 'server/src/http.ts')).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

/** 和 scripts/surface-recorder.mjs 同一个口径：一层一行，路由行带方法、路径、处理函数名。 */
function dump(app) {
  return (app._router?.stack ?? []).map((layer) => {
    if (!layer.route) return `USE <- ${layer.name || '<anonymous>'}`;
    const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).sort().join(',');
    const path = Array.isArray(layer.route.path) ? layer.route.path.map(String).join(' | ') : String(layer.route.path);
    return `${methods} ${path} <- ${layer.route.stack.map((l) => l.name || '<anonymous>').join(', ')}`;
  });
}

async function fresh() {
  const ctx = new Context();
  await ctx.plugin(HttpService);
  const http = ctx.get('http');
  return { ctx, http, app: http.expressApp() };
}

const servers = [];
async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path) => {
    const r = await fetch(base + path, { method });
    const text = await r.text();
    let body = text; try { body = JSON.parse(text); } catch { /* 不是 JSON 就按文本 */ }
    return { status: r.status, body };
  };
}

function named(req, res) { res.json({ route: 'named', id: req.params.id ?? null }); }
function guard(_req, _res, next) { next(); }
const tail = (_req, res) => res.status(404).json({ error: 'fell-through' });

try {
  // ---------- H1：和直接注册逐行相同 ----------
  {
    const { http, app } = await fresh();
    const twin = express();
    const build = (target, routes) => {
      target.use((_req, res, next) => { res.setHeader('x-before', '1'); next(); });
      routes.get('/a', (_req, res) => res.json({ route: 'a' }));
      target.get('/direct', (_req, res) => res.json({ route: 'direct' }));
      routes.post('/b/:id', guard, named);
      routes.put('/b/:id(\\d+)', named);
      routes.patch(['/c', '/d'], named);
      routes.delete(/^\/re\/\d+$/, named);
      routes.all('/any', guard, named);
      target.use(tail);
    };
    build(app, http);
    build(twin, twin);
    const mine = dump(app), theirs = dump(twin);
    ok('H1 经服务注册和直接注册，路由栈逐行相同（顺序、方法、路径、处理函数个数与名字）', mine.join('\n') === theirs.join('\n'), `\n${mine.join('\n')}\n--- 直接注册 ---\n${theirs.join('\n')}`);
    ok('H1 服务没有多挂东西：Express 自带 2 层 + 1 层中间件 + 7 条路由 + 1 层兜底，共 11 层', mine.length === 11, String(mine.length));
    const layer = app._router.stack.find((l) => l.route?.path === '/b/:id' && l.route.methods.post);
    ok('H1 处理函数原样传入，没有包装', layer?.route.stack.length === 2 && layer.route.stack[0].handle === guard && layer.route.stack[1].handle === named);
    const call = await serve(app), callTwin = await serve(twin);
    const probes = [['GET', '/a'], ['GET', '/direct'], ['POST', '/b/7'], ['PUT', '/b/7'], ['PUT', '/b/x'], ['PATCH', '/d'], ['DELETE', '/re/12'], ['DELETE', '/re/x'], ['GET', '/any'], ['POST', '/any'], ['GET', '/nope']];
    const got = [], want = [];
    for (const [m, p] of probes) { got.push(JSON.stringify(await call(m, p))); want.push(JSON.stringify(await callTwin(m, p))); }
    ok('H1 同一组请求，两边的状态码和响应体相同', got.join('\n') === want.join('\n'), `\n${got.join('\n')}\n--- 直接注册 ---\n${want.join('\n')}`);
  }

  // ---------- H2：撤销 ----------
  {
    const { http, app } = await fresh();
    const revokeA = http.get('/a', (_req, res) => res.json({ route: 'a' }));
    app.get('/direct', (_req, res) => res.json({ route: 'direct' }));
    http.post('/b/:id', named);
    app.use(tail);
    const call = await serve(app);
    const before = dump(app);
    ok('H2 撤销之前：三条路由都应答', (await call('GET', '/a')).status === 200 && (await call('GET', '/direct')).status === 200 && (await call('POST', '/b/7')).body.id === '7');
    ok('H2 注册返回的是函数', typeof revokeA === 'function');
    revokeA();
    const after = dump(app);
    ok('H2 撤销后栈里少了这一层，其余的顺序不变', after.length === before.length - 1 && after.join('\n') === before.filter((l) => !l.startsWith('GET /a ')).join('\n'), `\n${after.join('\n')}`);
    const gone = await call('GET', '/a');
    ok('H2 撤销后请求落到后面的层（这里是兜底的 404）', gone.status === 404 && gone.body.error === 'fell-through', JSON.stringify(gone));
    ok('H2 别的路由不受影响', (await call('GET', '/direct')).body.route === 'direct' && (await call('POST', '/b/9')).body.id === '9');
    let threw = false; try { revokeA(); revokeA(); } catch { threw = true; }
    ok('H2 撤销两次不出错，栈不再变', !threw && dump(app).join('\n') === after.join('\n'));
    http.get('/a', (_req, res) => res.json({ route: 'a-again' }));
    const again = dump(app);
    ok('H2 再注册是挂在栈尾（调用那一刻的位置），所以排在兜底后面、到不了', again[again.length - 1].startsWith('GET /a ') && (await call('GET', '/a')).status === 404);
  }

  // ---------- H3：随插件卸载 ----------
  {
    const { ctx, http, app } = await fresh();
    http.get('/root', (_req, res) => res.json({ owner: 'root' }));
    const one = ctx.plugin({ name: 'one', inject: ['http'], apply(c) { c.http.get('/one/a', (_req, res) => res.json({ owner: 'one' })); c.http.put('/one/b', named); } });
    await one;
    const two = ctx.plugin({ name: 'two', inject: ['http'], apply(c) { c.http.get('/two', (_req, res) => res.json({ owner: 'two' })); } });
    await two;
    app.use(tail);
    const call = await serve(app);
    const before = dump(app);
    ok('H3 卸载之前：根上和两个插件注册的路由都应答', (await call('GET', '/root')).body.owner === 'root' && (await call('GET', '/one/a')).body.owner === 'one' && (await call('PUT', '/one/b')).status === 200 && (await call('GET', '/two')).body.owner === 'two');
    await one.dispose();
    const after = dump(app);
    ok('H3 卸载一个插件：它注册的两条路由一起撤销，其余的顺序不变', after.join('\n') === before.filter((l) => !l.includes('/one/')).join('\n'), `\n${after.join('\n')}`);
    ok('H3 被卸载插件的路由落到兜底', (await call('GET', '/one/a')).status === 404 && (await call('PUT', '/one/b')).status === 404);
    ok('H3 根上和另一个插件注册的路由不动', (await call('GET', '/root')).body.owner === 'root' && (await call('GET', '/two')).body.owner === 'two');
    await two.dispose();
    ok('H3 再卸载另一个插件：只剩根上注册的', dump(app).filter((l) => !l.startsWith('USE')).join('\n') === before.filter((l) => l.startsWith('GET /root ')).join('\n'));
  }

  // ---------- H4：撤销时正在处理中的请求 ----------
  {
    const { http, app } = await fresh();
    let entered, release;
    const inside = new Promise((r) => { entered = r; });
    const gate = new Promise((r) => { release = r; });
    const revokeEarly = http.get('/early', (_req, res) => res.json({ route: 'early' }));
    http.get('/slow', async (_req, _res, next) => { entered(); await gate; next(); });
    app.use((_req, res) => res.json({ reached: 'tail' }));
    const call = await serve(app);
    const pending = call('GET', '/slow');
    await inside;
    revokeEarly(); // 栈里排在 /slow 前面的一层被摘掉
    release();
    const done = await pending;
    ok('H4 撤销发生时正在处理中的请求，照样走到后面的层', done.status === 200 && done.body.reached === 'tail', JSON.stringify(done));
    ok('H4 撤销本身生效：新请求打不到被撤销的路由', (await call('GET', '/early')).body.reached === 'tail');
  }

  // ---------- H5、H6 ----------
  {
    const { http, app } = await fresh();
    app.use(tail);
    const before = dump(app);
    let message = ''; try { http.get('/setting-like'); } catch (e) { message = String(e?.message ?? e); }
    ok('H5 不带处理函数的注册直接报错，栈不变', message.includes('没有处理函数') && dump(app).join('\n') === before.join('\n'), message);
    ok('H6 expressApp() 是 Express 应用本身：是函数、有 handle、不是代理、每次拿到同一个', typeof app === 'function' && typeof app.handle === 'function' && !types.isProxy(app) && http.expressApp() === app);
  }
} finally {
  for (const s of servers) { s.closeAllConnections(); s.close(); }
}

console.log(`\n===== HTTP 服务单测 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
