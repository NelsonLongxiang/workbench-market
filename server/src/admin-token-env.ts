/**
 * 启动环境给的管理口令（ADMIN_TOKEN）：启动时取一次，全进程只认这一份。
 * 口令本身只留在这个模块里，对外只给三样：有没有、常量时间比对、登录门用的指纹。
 * 用到的地方（index.ts 的口令校验和判定事实、a2a.ts、管理口令路由）都经这里，不再各自现读环境变量——
 * 运行中有代码改了环境变量，这几处既不会彼此对不上，也不会因此多出一个能用的口令。要换口令：改启动环境并重启。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { defineConfig, loadConfig } from './config.ts';

/** 原样取（不去空白，和原来各处现读的口径一样）；空串算没设 */
export const Config = defineConfig((env) => ({ token: env.ADMIN_TOKEN ?? '' }));
const { token } = loadConfig(Config);

/** 启动环境里有没有非空的管理口令 */
export function adminTokenFromEnv(): boolean { return token !== ''; }

/** 和启动环境的口令比（两侧 sha256 定长再比；没设一律拒绝） */
export function envAdminTokenOk(provided: string | undefined): boolean {
  if (!token) return false;
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(String(provided ?? '')), h(token));
}

/** 登录门签管理员会话用的指纹：sha256('env|' + 口令)；没设是空串 */
export function envAdminTokenFingerprint(): string {
  return token ? createHash('sha256').update('env|' + token, 'utf8').digest('hex') : '';
}
