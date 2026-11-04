// 扩展挂载点（与 server/src/extensions.ts 同一目录约定）：WM_EXTENSIONS_DIR 下每个含 web/index.tsx 的子目录并入构建。
// 目录设了却不存在/不是绝对路径 → 构建失败并点名，不静默产出缺页面的包。单独成 .mjs：web 的 tsc 不带 node 类型。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 扩展从这里取宿主组件：import { WmPage } from '@wm/host' */
export const HOST_ALIAS = fileURLToPath(new URL('./src/ext/host.ts', import.meta.url));

const ID = 'virtual:wm-extensions';
const RESOLVED = '\0' + ID;

/** 列出扩展的前端入口（绝对路径，按扩展名排序）；dir 为空返回 [] */
export function extensionWebEntries(dirRaw = process.env.WM_EXTENSIONS_DIR) {
  const dir = String(dirRaw ?? '').trim();
  if (!dir) return [];
  if (!isAbsolute(dir)) throw new Error(`WM_EXTENSIONS_DIR 须为绝对路径：${dir}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`WM_EXTENSIONS_DIR 不存在或不是目录：${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
    .map((x) => join(dir, x.name, 'web', 'index.tsx'))
    .filter((f) => existsSync(f))
    .sort();
}

export function wmExtensions() {
  const entries = extensionWebEntries();
  return {
    name: 'wm-extensions',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load: (id) => id === RESOLVED
      ? entries.map((f, i) => `import e${i} from ${JSON.stringify(f)};`).join('\n') + `\nexport default [${entries.map((_, i) => `e${i}`).join(', ')}];\n`
      : null,
  };
}
