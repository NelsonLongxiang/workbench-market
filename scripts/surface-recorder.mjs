/**
 * 快照用的预加载钩子：只在 scripts/surface-snapshot.mjs 起的隔离实例里用（node --import）。
 * 记下进程里建出来的 Express 应用；父进程经 IPC 发来 'wm-surface-dump' 时，把每个应用的层按挂载顺序回传，
 * 同时回传每条路由报的动作（经 HTTP 服务注册时记在路由对象的 wmAction 上；直接挂在应用上的存量路由没有）。
 * 不改任何行为：只是在应用初始化时多记一个引用。
 */
import { METHODS } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 实例的工作目录是 server/：从那里解析 express，拿到的才是 server 自己用的那一份。
const require = createRequire(pathToFileURL(join(process.cwd(), 'src/index.ts')));
const express = require('express');

const apps = [];
const init = express.application.init;
express.application.init = function recordedInit(...args) { apps.push(this); return init.apply(this, args); };

/** 挂载点：Express 只留了正则，还原成路径的样子，够稳定就行。 */
function mountOf(layer) {
  if (layer.regexp?.fast_slash) return '/';
  if (layer.regexp?.fast_star) return '*';
  return String(layer.regexp?.source ?? '').replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/') || '/';
}

const EVERY_METHOD = METHODS.map((m) => m.toLowerCase());

/** 一层一行。路由行：方法 路径 <- 这条路由上依次挂的处理函数名（守卫在前）。子路由缩进。 */
function dump(stack, depth = 0) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const layer of stack || []) {
    if (layer.route) {
      // app.all 在 Express 里是把每个 HTTP 方法各注册一遍。方法表随 Node 版本变，所以记成 ALL，处理函数只留一轮。
      const every = EVERY_METHOD.every((m) => layer.route.methods[m]);
      const methods = every ? 'ALL' : Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).sort().join(',');
      const path = Array.isArray(layer.route.path) ? layer.route.path.map(String).join(' | ') : String(layer.route.path);
      const names = layer.route.stack.map((l) => l.name || '<anonymous>');
      const chain = every && names.length % EVERY_METHOD.length === 0 ? names.slice(0, names.length / EVERY_METHOD.length) : names;
      lines.push(`${pad}${methods} ${path}  <- ${chain.join(', ')}`);
    } else {
      lines.push(`${pad}USE ${mountOf(layer)}  <- ${layer.name || '<anonymous>'}`);
      if (layer.handle?.stack) lines.push(...dump(layer.handle.stack, depth + 1));
    }
  }
  return lines;
}

/** 每条路由一行，和 dump 里的路由行一一对应（同一个顺序、同样的方法和路径）：方法 路径 -> 动作 类别，没报的记（未登记） */
function actionsOf(stack, depth = 0) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const layer of stack || []) {
    if (layer.route) {
      const every = EVERY_METHOD.every((m) => layer.route.methods[m]);
      const methods = every ? 'ALL' : Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).sort().join(',');
      const path = Array.isArray(layer.route.path) ? layer.route.path.map(String).join(' | ') : String(layer.route.path);
      const a = layer.route.wmAction;
      const refine = a?.refine ? a.refine.map((r) => `；细分：${r.action}  ${r.kind}（${r.why}）`).join('') : '';
      lines.push(`${pad}${methods} ${path}  -> ${a ? `${a.action}  ${a.kind}${a.statusNotVerdict ? `  （状态码不代表授权：${a.statusNotVerdict}）` : ''}${a.unauthenticated ? '  （没认出人回 401）' : ''}${refine}` : '（未登记）'}`);
    } else if (layer.handle?.stack) {
      lines.push(...actionsOf(layer.handle.stack, depth + 1));
    }
  }
  return lines;
}

// 父进程没了（被打断、被杀），实例自己退出，不留孤儿。
process.on('disconnect', () => process.exit(0));

process.on('message', async (msg) => {
  if (msg !== 'wm-surface-dump') return;
  // 扩展报的路由和没报动作的（只在带扩展起实例时才有）：和实例用的是同一份模块，读它登记的
  let wmExtensions = { routes: [], undeclared: [] };
  try {
    const ext = await import(pathToFileURL(join(process.cwd(), 'src/extensions.ts')).href);
    wmExtensions = { routes: ext.extensionRoutes?.() ?? [], undeclared: ext.extensionUndeclared?.() ?? [], middleware: ext.extensionMiddleware?.() ?? [] };
  } catch { /* 没有这个模块的旧代码：留空 */ }
  process.send?.({ wmSurface: apps.map((app) => dump(app._router?.stack)), wmActions: apps.map((app) => actionsOf(app._router?.stack)), wmExtensions });
});
