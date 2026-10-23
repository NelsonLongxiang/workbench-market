/**
 * 服务容器（Cordis 化 S1）：把 server 的数据访问按域收进 Service。
 *
 * 纪律（监督席派单 direct-8585549e 红线）：**SQL 原文搬运**——同语句、同参数、同结果形状，
 * 只换容器；行为等价是唯一标准。迁移顺序：S1 骨架 → S2 调用点迁移 → S3 端点瘦身。
 *
 * 用法：`import { ctx } from './context.ts'`；服务通过 `ctx.get('<name>')` 取用。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { db } from './db.ts';

/** 数据库连接服务：唯一持有 db 的地方（其余服务经注入取用）。 */
export class DbService extends Service {
  readonly db = db;
  constructor(ctx: Context) {
    super(ctx, 'db');
  }
}

export const ctx = new Context();

// 注册顺序不影响语义（Cordis 服务按名解析），但保持「db 最先」便于阅读。
ctx.plugin(DbService);

/** 便捷取用：`svc<WorkbenchService>('workbench')` */
export function svc<T>(name: string): T {
  return ctx.get(name) as T;
}
