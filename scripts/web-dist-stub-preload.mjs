/**
 * 录制回放用的夹具（--import 预加载）：市场进程看到的前端构建目录（仓库的 web/dist）换成一个占位目录，内容每次都一样。
 * 有没有 web/dist、里面是什么，会改变最后三层（静态托管、页面兜底、404）的应答：本机常有真的构建产物（每次构建的文件名都不同），
 * CI 跑回放的那一步又没有。录页面兜底这一层时两边都要是同一个占位，所以不看真的目录。
 *
 * 做法：进程里对 web/dist 之下的路径，fs 的几个读函数（existsSync、statSync、readFileSync、stat、lstat、createReadStream）
 * 改读占位目录里同名的文件，再同步给 ESM 的具名导入（index.ts 用的是 import { existsSync } from 'node:fs'）。
 * 只改这一个目录下的路径，别的路径原样走。真的 web/dist 一个字节都不碰（不建、不删、不改）。
 *
 * 占位目录放在实例的数据目录旁边（DATA_DIR 的上一层），随实例的临时目录一起删。内容：
 *   index.html          带 <head>（页面兜底往 <head> 里注入两个 meta，看得见注入）
 *   assets/app.js       一个静态资源（静态托管照常回 200）
 *   robots.txt          根目录下带扩展名的文件
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里把前端换成占位。
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';

if (process.env.NODE_ENV !== 'test') {
  console.error('[web-dist-stub-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}
const root = process.env.WM_REPLAY_ROOT;
const data = process.env.DATA_DIR;
if (!root || !data) {
  console.error('[web-dist-stub-preload] 拒绝加载：要有 WM_REPLAY_ROOT（仓库根）和 DATA_DIR');
  process.exit(1);
}

export const STUB_FILES = {
  'index.html': '<!doctype html>\n<html><head><title>占位前端</title></head><body><div id="root"></div></body></html>\n',
  'assets/app.js': 'console.log("stub");\n',
  'robots.txt': 'User-agent: *\n',
};

const REAL = resolve(root, 'web', 'dist');
const STUB = resolve(data, '..', 'web-dist-stub');
for (const [name, content] of Object.entries(STUB_FILES)) {
  fs.mkdirSync(dirname(join(STUB, name)), { recursive: true });
  fs.writeFileSync(join(STUB, name), content);
}

const swap = (p) => {
  if (typeof p !== 'string') return p;
  const abs = resolve(p);
  return abs === REAL || abs.startsWith(REAL + sep) ? STUB + abs.slice(REAL.length) : p;
};
for (const name of ['existsSync', 'statSync', 'readFileSync', 'stat', 'lstat', 'createReadStream']) {
  const original = fs[name];
  fs[name] = function (p, ...rest) { return original.call(this, swap(p), ...rest); };
}
syncBuiltinESMExports();
