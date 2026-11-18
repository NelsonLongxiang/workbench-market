/**
 * Odoo 已下线（2026-11-17，认人和业务台中继一起）：以前的这几个环境变量不再起作用。
 * 部署环境里还设着的，启动时逐个打一行「已下线、忽略」警告，不拒绝启动（线上环境是旧的，多一个变量不能起不来）。
 */
import { defineConfig, loadConfig } from './config.ts';

export const OFFBOARDED_ODOO_VARS = ['WM_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_ODOO_BROWSER_URL', 'WM_ODOO_LOGIN_PROXY', 'WM_CONTENT_ODOO_ORIGIN', 'LC_ODOO_URL', 'WM_CONTENT_IP', 'WM_CONTENT_MARKET_ORIGIN', 'WM_CONTENT_TARGETS'] as const;

export const Config = defineConfig((env) => {
  const set: string[] = [];
  if (String(env.WM_ODOO_URL ?? '').trim()) set.push('WM_ODOO_URL');
  if (String(env.WM_ODOO_ORIGINS ?? '').trim()) set.push('WM_ODOO_ORIGINS');
  if (String(env.WM_ODOO_BROWSER_URL ?? '').trim()) set.push('WM_ODOO_BROWSER_URL');
  if (String(env.WM_ODOO_LOGIN_PROXY ?? '').trim()) set.push('WM_ODOO_LOGIN_PROXY');
  if (String(env.WM_CONTENT_ODOO_ORIGIN ?? '').trim()) set.push('WM_CONTENT_ODOO_ORIGIN');
  if (String(env.LC_ODOO_URL ?? '').trim()) set.push('LC_ODOO_URL');
  // 内容查看面只能凭 Odoo 会话认人：设了端口也不启动；它的其余配置只看设没设，不解析（配错了也不拒启动）
  const contentPort = String(env.WM_CONTENT_PORT ?? '').trim();
  if (String(env.WM_CONTENT_IP ?? '').trim()) set.push('WM_CONTENT_IP');
  if (String(env.WM_CONTENT_MARKET_ORIGIN ?? '').trim()) set.push('WM_CONTENT_MARKET_ORIGIN');
  if (String(env.WM_CONTENT_TARGETS ?? '').trim()) set.push('WM_CONTENT_TARGETS');
  return { set, contentSurface: contentPort !== '' && contentPort !== '0' };
});

/** 启动时调一次：还设着的旧变量逐个警告，设了内容面端口也警告；返回设着的名字（测试、自检读） */
export function warnOffboardedOdoo(env?: Record<string, string | undefined>): string[] {
  const { set, contentSurface } = env ? Config.read(env) : loadConfig(Config);
  for (const name of set) console.warn(JSON.stringify({ source: 'odoo-offboarded', event: 'ignored-env', name, message: `${name} 已下线（Odoo 认人和业务台中继已停用），忽略` }));
  if (contentSurface) console.warn(JSON.stringify({ source: 'odoo-offboarded', event: 'content-surface-disabled', message: '内容查看面依赖 Odoo 会话认人，Odoo 已下线：WM_CONTENT_PORT 等设置忽略，不启动内容面' }));
  return set;
}
