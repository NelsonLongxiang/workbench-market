/** 沙箱域（第十域 · LayerFS 步骤 4）：market-bridge 派发——VM sandbox 容器执行 + Commit 入 Store。
 *  边界（技术审定）：bridge 是唯一通道（9800 不直连 Docker）；Commit 不可变性=Store CAS，市场只存引用。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class SandboxService extends Service {
  constructor(ctx: any) {
    super(ctx, 'sandbox');
  }

  bridgeUrl(): string {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sandbox_bridge_url'").get() as { value?: string } | undefined;
    return (row?.value ?? process.env.SANDBOX_BRIDGE_URL ?? '').trim();
  }

  /** 派发沙箱执行——bridge POST /dispatch { run_id, script, image_tag?, timeout_ms? }
   *  返回 { ok, commit_hash, exit_code, stdout_tail, stderr_tail, duration_ms }（技术审三态错误面） */
  async dispatch(r: { runId: number; script: string; imageTag?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const base = this.bridgeUrl();
    if (!base) throw new Error('sandbox bridge 未配置（settings.sandbox_bridge_url 或 env SANDBOX_BRIDGE_URL）');
    const res = await fetch(base.replace(/\/+$/, '') + '/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
