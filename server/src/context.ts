/**
 * 服务容器（Cordis 化 S1）：把 server 的数据访问按域收进 Service。
 *
 * 纪律（监督席派单 direct-8585549e 红线）：**SQL 原文搬运**——同语句、同参数、同结果形状，
 * 只换容器；行为等价是唯一标准。迁移顺序：S1 骨架 → S2 调用点迁移 → S3 端点瘦身。
 *
 * 用法：`import { svc } from './context.ts'`；服务通过 `svc<X>('name')` 取用。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { db } from './db.ts';
import { WorkbenchService } from './services/workbench.ts';
import { SopService } from './services/sop.ts';
import { AppService } from './services/app.ts';
import { AppDataService } from './services/app-data.ts';
import { McpService } from './services/mcp.ts';
import { CookieService } from './services/cookie.ts';
import { CockpitService } from './services/cockpit.ts';
import { SettingService } from './services/setting.ts';

/** 数据库连接服务：唯一持有 db 的地方（其余服务经注入取用）。 */
export class DbService extends Service {
  readonly db = db;
  constructor(ctx: Context) {
    super(ctx, 'db');
  }
}

export const ctx = new Context();

// 八域 + db：全部注册（顺序不影响语义，Cordis 按名解析）
for (const P of [DbService, WorkbenchService, SopService, AppService, AppDataService, McpService, CookieService, CockpitService, SettingService]) {
  ctx.plugin(P as never);
}

/** 便捷取用：`svc<WorkbenchService>('workbench')` */
export function svc<T>(name: string): T {
  return ctx.get(name) as unknown as T;
}
