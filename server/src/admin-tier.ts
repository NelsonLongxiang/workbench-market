/**
 * 系统管理员的边界（docs/local-accounts.md 第 5 节）：只持 admin 授予的人管系统，不看业务数据，也不能借系统面拿到业务——
 * 不能对业务侧的主体（持 owner 授予，或持任何碰业务的授予）动手：重置密码、绑定或解绑身份、停用或恢复、收回授予；
 * 那些要属主，或者完整的管理员（持 owner 授予的人、管理口令、本机命令行）。
 *
 * index.ts 认管理员时，只是系统管理员的请求在这里标一下（不改留痕的写法）；各管理接口按需问。
 */
import { svc } from './context.ts';
import type { GrantService } from './services/grant.ts';

const systemOnly = new WeakSet<object>();

/** 这次请求认出的管理员只是系统管理员（index.ts 的 markAdmin 调） */
export function markSystemAdminOnly(req: object): void { systemOnly.add(req); }

/** 这次请求的管理员只是系统管理员（口令、本机命令行、持 owner 授予的都不是） */
export function isSystemAdminOnly(req: object): boolean { return systemOnly.has(req); }

/** 系统管理员要对这个主体动手时的拒绝（业务侧的主体不行）；不是系统管理员、主体不是业务侧的，回 null */
export function systemAdminTargetRefusal(req: object, principal: string | null | undefined): { error: string; message: string } | null {
  if (!principal || !isSystemAdminOnly(req)) return null;
  if (!svc<GrantService>('grants').businessProtected(principal)) return null;
  return { error: 'system_admin_business_principal', message: '这个人持有业务授予或属主授予：系统管理员不能对他做这件事，要属主或完整的管理员来做' };
}
