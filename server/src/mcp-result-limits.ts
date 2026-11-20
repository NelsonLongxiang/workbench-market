/**
 * 大结果给引用（渐进开放第 5 步，docs/productization/16-progressive-capability-access.md）的阈值和期限。
 *
 * 生产上固定：结果（紧凑 JSON）超过 64 KB 就换成引用，引用 15 分钟过期。
 * WM_MCP_RESULT_LIMITS（inline=<字节>,ttl=<毫秒>）只给测试调小用：只在 NODE_ENV=test 时认；
 * 别的环境设了它就拒绝启动——不让生产上悄悄把阈值关掉或放大。写法不对也拒绝启动。
 */
import { defineConfig, loadConfig } from './config.ts';

export type McpResultLimits = { inline: number; ttl: number };
export const MCP_RESULT_DEFAULTS: McpResultLimits = { inline: 64 * 1024, ttl: 15 * 60_000 };

export const Config = defineConfig((env): McpResultLimits => {
  const raw = String(env.WM_MCP_RESULT_LIMITS ?? '');
  if (!raw) return MCP_RESULT_DEFAULTS;
  if (env.NODE_ENV !== 'test') throw new Error('[mcp] 拒绝启动：WM_MCP_RESULT_LIMITS 只给测试用（NODE_ENV=test），生产上不要设');
  const m = /^inline=(\d{1,9}),ttl=(\d{1,9})$/.exec(raw.trim());
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Error('[mcp] 拒绝启动：WM_MCP_RESULT_LIMITS 写成 inline=<字节>,ttl=<毫秒>');
  return { inline: Number(m[1]), ttl: Number(m[2]) };
});

/** 启动时取一次 */
export const MCP_RESULT_LIMITS: McpResultLimits = loadConfig(Config);
