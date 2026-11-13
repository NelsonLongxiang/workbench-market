/** 沙箱域（第十域 · LayerFS 步骤 4）：market-bridge 派发——VM sandbox 容器执行 + Commit 入 Store。
 *  边界（技术审定）：bridge 是唯一通道（9800 不直连 Docker）；Commit 不可变性=Store CAS，市场只存引用。 */
import { outboundOff, noteBlocked } from '../outbound-gate.ts';
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { defineConfig } from '../config.ts';

export class SandboxService extends Service {
  /** 桥地址和令牌的兜底：库里 settings 没设时用启动环境的（没设是 undefined） */
  static Config = defineConfig((env) => ({ bridgeUrl: env.SANDBOX_BRIDGE_URL, bridgeToken: env.SANDBOX_BRIDGE_TOKEN }));

  private readonly config: { bridgeUrl?: string; bridgeToken?: string };

  constructor(ctx: any, config: { bridgeUrl?: string; bridgeToken?: string }) {
    super(ctx, 'sandbox');
    this.config = config;
  }

  bridgeUrl(): string {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sandbox_bridge_url'").get() as { value?: string } | undefined;
    return (row?.value ?? this.config.bridgeUrl ?? '').trim();
  }

  /** 派发沙箱执行——bridge POST /dispatch { run_id, script, image_tag?, timeout_ms? }
   *  返回 { ok, commit_hash, exit_code, stdout_tail, stderr_tail, duration_ms }（技术审三态错误面） */
  async dispatch(r: { runId: number; script: string; imageTag?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const base = this.bridgeUrl();
    if (outboundOff()) { noteBlocked('sandbox'); throw new Error('对外已断开（WM_OUTBOUND=off）：沙箱桥不可用'); } // 库里随副本带来的桥地址一律按关处理
    if (!base) throw new Error('sandbox bridge 未配置（settings.sandbox_bridge_url 或 env SANDBOX_BRIDGE_URL）');
    // #94 S0⑥：bridge 请求带 Bearer（settings.sandbox_bridge_token ?? env SANDBOX_BRIDGE_TOKEN——契约 §1 鉴权）
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'sandbox_bridge_token'").get() as { value?: string } | undefined;
    const token = (tokenRow?.value ?? this.config.bridgeToken ?? '').trim();
    const res = await fetch(base.replace(/\/+$/, '') + '/dispatch', {
      method: 'POST',
      headers: token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: r.runId, script: r.script, image_tag: r.imageTag ?? 'node:22-slim', timeout_ms: r.timeoutMs ?? 300000 }),
      signal: AbortSignal.timeout((r.timeoutMs ?? 300000) + 10000),
    });
    if (!res.ok) {
      const err = new Error('bridge 不可达（HTTP ' + res.status + '）') as Error & { retryable?: boolean };
      err.retryable = true;
      throw err;
    }
    return res.json();
  }
}
