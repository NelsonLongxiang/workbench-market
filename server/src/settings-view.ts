/**
 * 设置读出去的样子，分两级：
 *   · 管理员（口令或管理员登录，同源）和本机命令行：全部设置，但**凭据类的值一律不出**——只说有没有（'****' 或空串）。
 *     凭据类：键名以 token、secret、password、passwd、api_key、apikey 结尾的（开关类的例外见 FLAG_KEYS），
 *     加上 MCP 上游的 headers 值。管理口令的哈希整项剔除。
 *   · 别人（登录的员工；登录门关着时的匿名）：只给一张白名单（PUBLIC_KEYS）——巡检参数和几个开关。
 *     内网地址（MCP 上游、A2A 对端、LayerFS 服务地址）和凭据都不给。
 * 导出（掩码的和带 reveal 的）用管理员那一级：凭据类的值不进导出文件。
 */
import { ADMIN_TOKEN_KEY } from './services/setting.ts';

/** 别人能看到的设置：巡检参数和开关 */
export const PUBLIC_KEYS: readonly string[] = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'dispatch_sorting_enabled', 'run_upload_require_token', 'patrol_armed_at'];
/** 名字像凭据、其实是开关的键：照常给值 */
const FLAG_KEYS: ReadonlySet<string> = new Set(['run_upload_require_token']);
const SECRET_RE = /(^|_)(token|secret|password|passwd|api_?key)$/i;

/** 这个键的值是不是凭据 */
export const isSecretKey = (key: string): boolean => !FLAG_KEYS.has(key) && SECRET_RE.test(key);

/** 管理员看到的设置：全部，凭据类的值只说有没有，MCP 上游的 headers 值掩掉，管理口令哈希剔除 */
export function settingsForAdmin(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (k === ADMIN_TOKEN_KEY) continue;
    out[k] = isSecretKey(k) ? (v ? '****' : '') : v;
  }
  const raw = out.mcp_upstreams;
  if (!raw) return out;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { ...out, mcp_upstreams: '' };
    const masked = arr.map((u: { headers?: unknown } & Record<string, unknown>) => ({
      ...u,
      headers: u?.headers && typeof u.headers === 'object' ? Object.fromEntries(Object.keys(u.headers as object).map((h) => [h, '****'])) : {},
    }));
    return { ...out, mcp_upstreams: JSON.stringify(masked) };
  } catch {
    return { ...out, mcp_upstreams: '' };
  }
}

/** 别人看到的设置：只有白名单里的 */
export function settingsForPublic(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PUBLIC_KEYS) if (k in settings) out[k] = settings[k];
  return out;
}
