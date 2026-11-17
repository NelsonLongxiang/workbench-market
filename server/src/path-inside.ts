/**
 * 路径落点判断（只此一处）：一个路径是不是落在某个根目录之内。
 *
 * 规范化之后，要么就是根本身，要么以「根加分隔符」开头。只比字面，不去文件系统查：
 *   · 不跟随符号链接（和原来一样：根里的符号链接指到根外，这里不管，取文件的地方怎么处理照旧）；
 *   · 大小写按字面比较（和原来的写法一样；文件系统本身是否区分大小写，由取文件那一步决定）。
 * 原来各处写的是 abs.startsWith(root)，没带分隔符：root 是 …/v1 时，…/v10/x 也算「在根里」。
 * 前面那一道（规范化之后拦「.」「/」「..」开头）在的时候走不到这一点；这一道要在前一道失效时也独立成立。
 */
import { resolve, sep } from 'node:path';

export function isInsideRoot(root: string, target: string): boolean {
  const r = resolve(root), t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}
