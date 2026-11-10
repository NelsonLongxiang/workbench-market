/**
 * 快照用的预加载钩子：只在 scripts/surface-snapshot.mjs 起的隔离实例里用（node --import）。
 * 记下进程里建出来的 Express 应用；父进程经 IPC 发来 'wm-surface-dump' 时，把每个应用的层按挂载顺序回传。
 * 不改任何行为：只是在应用初始化时多记一个引用。
 */
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

/** 一层一行。路由行：方法 路径 <- 这条路由上依次挂的处理函数名（守卫在前）。子路由缩进。 */
function dump(stack, depth = 0) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const layer of stack || []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase()).sort().join(',');
      const path = Array.isArray(layer.route.path) ? layer.route.path.map(String).join(' | ') : String(layer.route.path);
      lines.push(`${pad}${methods} ${path}  <- ${layer.route.stack.map((l) => l.name || '<anonymous>').join(', ')}`);
    } else {
      lines.push(`${pad}USE ${mountOf(layer)}  <- ${layer.name || '<anonymous>'}`);
      if (layer.handle?.stack) lines.push(...dump(layer.handle.stack, depth + 1));
    }
  }
  return lines;
}

process.on('message', (msg) => {
  if (msg !== 'wm-surface-dump') return;
  process.send?.({ wmSurface: apps.map((app) => dump(app._router?.stack)) });
});
