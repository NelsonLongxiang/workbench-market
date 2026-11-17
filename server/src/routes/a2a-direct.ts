/**
 * A2A 入站 /a2a/direct：POST 收对端节点的投递，GET 一律 404（只收 POST）。原样搬自 index.ts，只多了两格缩进。
 *
 * POST 的顺序：回执窄分流（阶段七 R3）→ 入站签名（WM_A2A_DIRECT_SIG）→ 绑定准入、幂等、开 run / 记备注 / 查状态（a2a.ts 的 a2aDirectHandle）。
 * 放不放行看签名和绑定，不看登录身份，所以声明了「状态码不代表授权」。
 * 启动时读一次的开关（签名模式、跟进限频）、签名校验器、run 的读写桥由 index.ts 传进来；不在这里重新读环境变量。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { SopService } from '../services/sop.ts';
import type { SopRunRow } from '../db.ts';
import { HttpError } from '../errors.ts';
import { a2aDirectHandle, marketPublicUrl } from '../a2a.ts';
import { noteA2aError, type A2aErrorKey } from '../a2a/errors.ts';
import { handleInboundReceipt } from '../a2a/receipt-inbound.ts';
import { shownRefusal, type createDirectSigVerifier, type DirectSigMode, type SigRefusal } from '../a2a-direct-sig.ts';
import type { createRunCheckpoints } from '../sop-state-checkpoints.ts';
import type { runStateRestore as RunStateRestore } from '../redis.ts';

/** 从 index.ts 传进来的：启动时定下的开关与校验器、run 的读写桥 */
export interface A2aDirectDeps {
  A2A_DIRECT_SIG: DirectSigMode;
  A2A_FOLLOWUP_RATE: number;
  FETCH_STEP_REFUSALS: ReadonlySet<string>;
  directSig: ReturnType<typeof createDirectSigVerifier>;
  sopRunStartCore: (slug: string, startedBy: string) => { id: number; read_capability: string };
  runCheckpoints: ReturnType<typeof createRunCheckpoints>;
  sopRunRow: (id: number) => SopRunRow;
  storedRunData: (row: SopRunRow) => Record<string, unknown>;
  runLiveData: (row: SopRunRow, strict: boolean, writing?: boolean) => Promise<{ data: Record<string, unknown> }>;
  runStateRestore: typeof RunStateRestore;
  runCacheCheckpoint: (row: SopRunRow) => string;
}

export function registerA2aDirectRoutes(app: HttpService, deps: A2aDirectDeps): void {
  const { A2A_DIRECT_SIG, A2A_FOLLOWUP_RATE, FETCH_STEP_REFUSALS, directSig, sopRunStartCore, runCheckpoints, sopRunRow, storedRunData, runLiveData, runStateRestore, runCacheCheckpoint } = deps;
  app.post('/a2a/direct', { action: 'a2a.direct-inbound', kind: 'write', statusNotVerdict: '入站签名与绑定准入判，不是登录身份的结论' }, express.json({ limit: '600kb' }), async (req, res) => {
    const rawBytes = Number(req.headers['content-length'] ?? 0) || JSON.stringify(req.body ?? {}).length;
    // 阶段七 R3：A2A 回执的窄分流——正文是回执、任务号是我们发出的、签名方是当初投递到的那台宿主，三条都成立才走这里；否则照原路，应答不变
    const inboundReceipt = await handleInboundReceipt(req, { audiences: () => [marketPublicUrl()], followupRate: A2A_FOLLOWUP_RATE });
    if (inboundReceipt) { res.status(inboundReceipt.status).json(inboundReceipt.body); return; }
    // 入站签名（WM_A2A_DIRECT_SIG）：签名身份对上 caller_session 才进下面的绑定准入
    if (A2A_DIRECT_SIG !== 'off') {
      const caller = typeof req.body?.caller_session === 'string' ? req.body.caller_session : '';
      const presence = directSig.presence(req);
      let reason = '';
      if (presence === 'signed') {
        const v = await directSig.verify(req, (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0), caller);
        // accept：取卡或验签这一步失败（没登记、取不到卡、卡上身份不对、签名对不上卡）一律按未签名的老路走——
        // 不比不带签名的请求更宽、也不更严。内部日志照旧记原因
        if (!v.ok && A2A_DIRECT_SIG === 'accept' && FETCH_STEP_REFUSALS.has(v.reason)) console.warn(JSON.stringify({ source: 'a2a-direct-sig', unverified: v.reason, fallback: 'unsigned' }));
        else if (!v.ok) reason = v.reason;
      } else if (A2A_DIRECT_SIG === 'require') reason = presence === 'unbound' ? 'unbound-only' : 'absent';
      if (reason !== '') {
        console.warn(JSON.stringify({ source: 'a2a-direct-sig', refused: reason }));
        noteA2aError(`sig:${reason}` as A2aErrorKey);
        // 对外把取卡这一步的几种失败（没登记、取不到卡、卡上身份不对、签名对不上卡）并成一种，不泄露绑定是否存在；内部日志照旧分开
        const shown = shownRefusal(reason as SigRefusal);
        res.status(401).json({ error: `untrusted-origin: signature verification failed (${shown}) — sign with OriginClaim Sig2 (X-A2A-Caller/-Url/-Ts/-Aud/-Sig2) using the card key published at the address registered on your binding`, code: -32000, task_status: 'TASK_STATE_FAILED' });
        return;
      }
    }
    // run 操作桥（P2 note 写入走 sop_runs 的哑数据面：step_key=note-<ts> 追加不覆盖）
    const runOps = {
      start: (slug: string, startedBy: string): { id: number; read_capability: string } => { const r = sopRunStartCore(slug, startedBy); return { id: r.id, read_capability: r.read_capability }; },
      uploadToken: (id: number): string => String((svc<SopService>('sop').runUploadToken(id) as { upload_token?: string } | undefined)?.upload_token ?? ''), // P0：派单回执带令牌（创建者即得）
      saveNote: (runId: number, text: string): Promise<void> => runCheckpoints.serial(runId, async () => {
        const row = sopRunRow(runId);
        if (row.status !== 'running') throw new HttpError(409, 'run ' + runId + ' 已 ' + row.status + '，不可再写');
        const data = row.sop_slug === 'task-center' ? storedRunData(row) : (await runLiveData(row, false, true)).data; // #448: a note is a write too
        const notes = Array.isArray(data['a2a-notes']) ? data['a2a-notes'] as unknown[] : [];
        notes.push({ at: new Date().toISOString(), text });
        data['a2a-notes'] = notes;
        if (row.sop_slug === 'task-center') {
          svc<SopService>('sop').runUpdateData(runId, JSON.stringify(data));
          runCheckpoints.forget(runId); // pure SQLite path must never retain a stale note snapshot
        } else {
          runCheckpoints.remember(runId, data, true); // delivered note requires SQLite success before cache publication
          await runStateRestore(runId, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data, runCacheCheckpoint(sopRunRow(runId)));
        }
      }),
      statusOf: (runId: number): { status: string; steps: number } | null => {
        const row = svc<SopService>('sop').runStatusData(runId) as { status: string; data: string } | undefined;
        if (!row) return null;
        let n = 0;
        try { n = Object.keys(JSON.parse(row.data || '{}')).length; } catch { n = 0; }
        return { status: row.status, steps: n };
      },
      ctxBind: (contextId: string): number | null => {
        const hit = svc<SopService>('sop').ctxRunId(contextId) as { run_id: number } | undefined;
        return hit ? hit.run_id : null;
      },
      ctxRegister: (contextId: string, runId: number): void => {
        svc<SopService>('sop').ctxRegister(contextId, runId);
      },
      ctxRegisterSource: (r: { contextId: string; runId: number; taskId: string; caller: string; team: string; receiptStatus: string }): void => {
        svc<SopService>('sop').ctxRegisterSource(r);
      },
      bindingCallback: (slug: string, caller: string): string => {
        const b = svc<SopService>('sop').bindingByNodeFull(slug, caller) as { callback_url?: string } | undefined;
        return b?.callback_url ?? '';
      },
      ctxAttachCallback: (runId: number, callbackUrl: string): void => {
        svc<SopService>('sop').ctxSetCallback(runId, callbackUrl);
      },
    };
    try {
      const out = await a2aDirectHandle(req.body, rawBytes, runOps);
      res.status(out.httpStatus).json(out.body);
    } catch (e: any) {
      res.status(200).json({ error: `direct handler failed: ${String(e?.message ?? e)}`, code: -32000, task_status: 'TASK_STATE_FAILED' });
    }
  });
  app.get('/a2a/direct', { action: 'a2a.direct-probe', kind: 'read' }, (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
}
