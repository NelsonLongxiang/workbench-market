/**
 * 服务容器（Cordis 化 S1）：把 server 的数据访问按域收进 Service。
 *
 * 纪律（监督席派单 direct-8585549e 红线）：**SQL 原文搬运**——同语句、同参数、同结果形状，
 * 只换容器；行为等价是唯一标准。迁移顺序：S1 骨架 → S2 调用点迁移 → S3 端点瘦身。
 *
 * 用法：`import { svc } from './context.ts'`；服务通过 `svc<X>('name')` 取用。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { root } from './root-context.ts';
import { db } from './db.ts';
import { WorkbenchService } from './services/workbench.ts';
import { SopService } from './services/sop.ts';
import { AppService } from './services/app.ts';
import { AppDataService } from './services/app-data.ts';
import { McpService } from './services/mcp.ts';
import { CookieService } from './services/cookie.ts';
import { CockpitService } from './services/cockpit.ts';
import { SettingService } from './services/setting.ts';
import { SkillService } from './services/skill.ts';
import { SandboxService } from './services/sandbox.ts';
import { WorkbenchVarsService } from './services/workbench-vars.ts';
import { PrincipalService } from './services/principal.ts';
import { BindingService } from './services/binding.ts';
import { ChangeRequestService } from './services/change-request.ts';
import { TaskCenterService } from './services/task-center.ts';
import { RemoteAllowService } from './services/remote-allow.ts';
import { LoginSessionService } from './services/login-session.ts';
import { GrantService } from './services/grant.ts';
import { JudgmentCompareService } from './services/judgment-compare.ts';
import { WorkItemService } from './services/work-item.ts';
import { AttentionService } from './services/attention.ts';
import { HttpService } from './http.ts';

/** 数据库连接服务：唯一持有 db 的地方（其余服务经注入取用）。 */
export class DbService extends Service {
  readonly db = db;
  constructor(ctx: Context) {
    super(ctx, 'db');
  }
}

/** 全进程一个上下文：就是 root-context.ts 的根（身份服务也装在它上面）。 */
export const ctx = root;

// 八域 + db + http + 主体：全部注册（顺序不影响语义，Cordis 按名解析）。http 持有 Express 应用，域模块经它注册路由。
// 主体目录（principals）装在同一个根上：身份服务认人时按名字取它，取不到就不认任何人。
// ctx.plugin 异步装配，等全部就绪再交出模块——否则 index.ts 的 listen 回调里 svc() 取到 undefined（#32）
await Promise.all([
  DbService,
  WorkbenchService,
  SopService,
  AppService,
  AppDataService,
  McpService,
  CookieService,
  CockpitService,
  SettingService,
  SkillService,
  SandboxService,
  WorkbenchVarsService,
  PrincipalService,
  LoginSessionService,
  GrantService,
  JudgmentCompareService,
  BindingService,
  ChangeRequestService,
  TaskCenterService,
  RemoteAllowService,
  WorkItemService,
  AttentionService,
  HttpService
].map((P) => ctx.plugin(P)));

/** 便捷取用：`svc<WorkbenchService>('workbench')` */
export function svc<T>(name: string): T {
  return ctx.get(name) as unknown as T;
}
