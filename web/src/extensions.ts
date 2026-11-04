/** 前端扩展挂载点：构建期 WM_EXTENSIONS_DIR 下每个 <扩展名>/web/index.tsx 默认导出一个 WebExtension，
 *  由 web/vite-extensions.mjs 在构建时替换 ./ext/registry 并入；未设目录时为空数组。扩展用到的宿主组件从 @wm/host 取。 */
import type { ReactNode } from 'react';
import extensions from './ext/registry';

export interface WebExtensionNav {
  /** 菜单分组：已有分组用它的 key（如 /g/work）；新分组给 key + name，排在「管理」组之前 */
  group: { key: string; name?: string };
  page: { path: string; name: string; icon: ReactNode };
}
export interface WebExtension {
  name: string;
  routes?: { path: string; element: ReactNode }[];
  nav?: WebExtensionNav[];
  /** 控制面不提供、要跳回业务面的页面前缀（如 /foo） */
  marketOnly?: string[];
}

export const WEB_EXTENSIONS: WebExtension[] = extensions;
