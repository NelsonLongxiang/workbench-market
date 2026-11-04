/** 扩展清单：仓库里恒为空。vite 构建时由 web/vite-extensions.mjs 换成 WM_EXTENSIONS_DIR 下各扩展的 web/index.tsx；
 *  esbuild 打的测试夹具直接用这份空清单。 */
import type { WebExtension } from '../extensions';

const extensions: WebExtension[] = [];
export default extensions;
