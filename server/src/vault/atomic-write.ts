/**
 * 本地移植 @deepseek-ai/dsh-atomic-write@0.1.0-rc.6（MIT，零依赖）——原包依赖 cordis 运行时，市场不引。
 * 协议与原包逐字一致：临时文件 wx 创建 + rename 原子替换；写者锁 = `<file>.lock` 的 wx 创建，
 * 退避 20→200ms、2s 超时、从不删别人的锁。DSH 插件与市场同时写同一个库文件时靠它互斥。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFileAtomic(filename: string, content: string, options: { mode?: number; dirMode?: number } = {}): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) });
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' });
    await rename(temp, filename);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const LOCK_TIMEOUT_MS = 2000;

export async function withFileLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filename}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { force: true });
  }
}
