/** 浏览器回归等脚本要起 Python（Playwright）时，统一从这里取解释器，免得每次在命令前手写 PYTHON=<绝对路径>。
 *  顺序：PYTHON 环境变量（CI 用它）→ 仓库根的 .venv（本机按 README 建，已 gitignore）→ 系统 python3（Windows 为 python）。 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function pythonBin() {
  const env = String(process.env.PYTHON ?? '').trim();
  if (env) return env;
  const venv = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}
