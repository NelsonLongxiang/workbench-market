/**
 * 配置的落点：每个插件（和还没成插件的域模块）自己的 Config。
 *
 * 一个 Config 说清这个模块认哪些环境变量、怎么解析、缺省是什么：`defineConfig((env) => ({ … env.名字 … }))`。
 * 它按 Standard Schema 的样子长（`~standard.validate`），Cordis 4 的 `ctx.plugin(P, config)` 就按插件的 `Config` 校验配置：
 * - 服务类插件写成 `static Config = defineConfig(…)`，构造函数第二个参数就是解析好的配置；装的时候不给配置，就从启动环境取。
 * - 还不是插件的域模块，在模块加载时 `loadConfig(Config)` 取一次。
 *
 * 规矩：
 * - 启动时取一次，用到的地方不再读 `process.env`。缺省的 `process.env` 只在这个文件里出现（给子进程带系统变量用 `passEnv`）。
 * - 解析沿用原来的口径；值不合法要拒绝启动的，在 read 里抛错（Cordis 装插件时报 ValidationError，loadConfig 直接抛）。
 * - 新的配置项写进 README（体检 env-docs 按 `env.名字` 认）。
 * - env 是传进来的：测试可以给自己的一份，不用改全局环境。
 */

/** 环境变量形状的输入：启动环境，或调用方给的同形对象 */
export type Env = Readonly<Record<string, string | undefined>>;

type Result<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string }[] };

export interface Config<T> {
  /** 从环境变量（或同形对象）解析出这个模块的配置；值不合法时抛错 */
  readonly read: (env: Env) => T;
  /** Standard Schema v1：Cordis 装插件时按它校验。不给配置（undefined）就取启动环境 */
  readonly '~standard': { readonly version: 1; readonly vendor: 'workbench-market'; readonly validate: (input: unknown) => Result<T> };
}

export function defineConfig<T>(read: (env: Env) => T): Config<T> {
  return {
    read,
    '~standard': {
      version: 1,
      vendor: 'workbench-market',
      validate(input) {
        try { return { value: read((input ?? process.env) as Env) }; } catch (e) { return { issues: [{ message: String((e as Error)?.message ?? e) }] }; }
      },
    },
  };
}

/** 还不是插件的模块在加载时取一次配置 */
export function loadConfig<T>(config: Config<T>, env: Env = process.env): T {
  return config.read(env);
}

/**
 * 起子进程时原样带过去的几个系统变量（PATH、TEMP 之类）：只取点名的、非空的。这不是模块的配置，是给子进程的环境；
 * 放在这里，是为了模块里不再出现 process.env（每次调用现取，和原来逐个读一样）
 */
export function passEnv(keys: readonly string[], env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) { const v = env[k]; if (v) out[k] = v; }
  return out;
}

/** 去掉首尾空白；没设是空串 */
export const str = (v: string | undefined): string => String(v ?? '').trim();
