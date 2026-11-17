/**
 * 测试起隔离实例时，分清「环境问题」和「真失败」（给各测试脚本共用）。
 *
 * 实例启动时先跑启动安全自检，有一行不过就拒绝启动。不过的原因有两类：
 *   · 真失败：应答不对（reason 是 unexpected-status-or-challenge 之类）——被测的代码不安全，测试就该红；
 *   · 环境问题：timeout（单条自检请求等不到应答）、surface-not-listening（等不到监听）——CI 机器忙，和被测的行为无关。
 * 只有每一条不过的原因都属于环境问题，才算环境问题：可以有限次重试；用完了在报错里写明「环境问题」，不和真失败混在一起。
 * 自检的判定本身不放宽：测试环境（NODE_ENV=test）里服务端只是等得久一点（见 server/src/startup-security-self-probe.ts 的 TEST_ENV_WAITS）。
 */
export const ENVIRONMENT_REASONS = new Set(['timeout', 'surface-not-listening']);

/** 实例日志里自检不过的那几行：[{ id, reason }] */
export function selfProbeFailures(log) {
  return [...String(log).matchAll(/"source":"self-probe","id":"([^"]+)"[^}]*"verdict":"fail"[^}]*"reason":"([^"]*)"/g)].map((m) => ({ id: m[1], reason: m[2] }));
}

/** 拒绝启动是不是只因为环境（至少一行不过，且每一行的原因都是超时或面没在听） */
export function environmentOnlyRefusal(log) {
  const rows = selfProbeFailures(log);
  return rows.length > 0 && rows.every((r) => ENVIRONMENT_REASONS.has(r.reason));
}

/** 实例没起来时抛的错：环境问题打上 environment = true，报错开头写明 */
export function instanceStartError(what, log) {
  const env = environmentOnlyRefusal(log);
  const tail = String(log).trim().split('\n').slice(-4).join(' | ') || '没有输出';
  const err = new Error(env
    ? `环境问题（不是被测行为失败）：${what}——启动自检只因超时或面没在听而拒绝启动，机器太忙。${tail}`
    : `${what}：${tail}`);
  err.environment = env;
  err.log = String(log);
  return err;
}

/**
 * 起实例，遇到环境问题有限次重试（缺省共 3 次）。真失败（不是环境问题的错）立刻抛出，不重试。
 * startOnce 每次都要起一个全新的实例（新端口）；抛错时用 instanceStartError 打标。
 */
export async function startWithEnvironmentRetry(startOnce, { attempts = 3, label = '实例' } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await startOnce(i); } catch (e) {
      if (!e?.environment) throw e;
      last = e;
      console.log(`  · ${label} 第 ${i} 次没起来（环境问题：自检超时或面没在听），${i < attempts ? '重试' : '不再重试'}`);
    }
  }
  throw last;
}
