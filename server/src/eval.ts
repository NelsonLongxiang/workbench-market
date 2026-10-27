/** #178 skill_search 评估模型客户端（TypeSafe jev 经 Vercel AI Gateway·裸 JSON 协议）。
 *  纪律（属主/评审席#178）：五个协议头缺一不可·模型 ID 在头不在 body·boolean 一候选一题·批≤15·
 *  429/529 指数退避≤3 次·400/401 不重试·超时 15s·不可用报错不降级（绝不回退关键词匹配冒充置信度）。 */

const DEFAULT_GATEWAY = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
const MODEL_ID = 'typesafe-ai/jev';
const BATCH_MAX = 15;
const TIMEOUT_MS = 15_000;
const RETRY_MAX = 3;

export type EvalCandidate = { qid: string; slug: string; name: string; description: string; argumentHint: string };

/** 一次评估请求的返回：qid → P(true) */
export type EvalAnswers = Record<string, number>;

export class EvalUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'EvalUnavailableError'; }
}

function gatewayUrl(): string {
  return String(process.env.EVAL_GATEWAY_URL ?? '').trim() || DEFAULT_GATEWAY;
}

function apiKey(): string {
  const k = String(process.env.AI_GATEWAY_API_KEY ?? '').trim();
  if (!k) throw new EvalUnavailableError('AI_GATEWAY_API_KEY 未配置——skill_search 不可用（不降级）');
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单批评估（≤15 题）。失败按纪律重试/报错。 */
async function evalBatch(need: string, cands: EvalCandidate[]): Promise<EvalAnswers> {
  if (cands.length === 0) return {};
  if (cands.length > BATCH_MAX) throw new Error(`内部错误：单批超过 ${BATCH_MAX} 题`);
  const token = apiKey();
  const skills: Record<string, unknown> = {};
  const questions: Record<string, unknown> = {};
  for (const c of cands) {
    skills[c.qid] = { slug: c.slug, name: c.name, description: c.description, argument_hint: c.argumentHint };
    questions[c.qid] = { type: 'boolean', instructions: `state.skills.${c.qid} 这个技能能满足 state.need 吗？` };
  }
  const body = JSON.stringify({ state: { need, skills }, questions });
  const headers = {
    authorization: `Bearer ${token}`,
    'ai-model-id': MODEL_ID,
    'ai-evaluation-model-specification-version': '4',
    'ai-gateway-protocol-version': '0.0.1',
    'ai-gateway-auth-method': 'api-key',
    'content-type': 'application/json',
  };

  let lastErr = '';
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt));
    let res: Response;
    try {
      res = await fetch(gatewayUrl(), { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      lastErr = `Gateway 请求失败：${(e as Error).message}`;
      if (attempt === RETRY_MAX) throw new EvalUnavailableError(lastErr);
      continue;
    }
    if (res.status === 429 || res.status === 529) {
      lastErr = `Gateway 限流 HTTP ${res.status}`;
      if (attempt === RETRY_MAX) throw new EvalUnavailableError(lastErr + '（重试耗尽）');
      continue; // 指数退避后重试
    }
    if (res.status === 400 || res.status === 401) {
      // 协议/鉴权错误：不重试
      const txt = await res.text().catch(() => '');
      throw new EvalUnavailableError(`Gateway 拒绝 HTTP ${res.status}：${txt.slice(0, 200)}`);
    }
    if (!res.ok) {
      lastErr = `Gateway HTTP ${res.status}`;
      if (attempt === RETRY_MAX) throw new EvalUnavailableError(lastErr);
      continue;
    }
    let json: any;
    try { json = await res.json(); } catch { throw new EvalUnavailableError('Gateway 返回非 JSON'); }
    const answers = json?.answers;
    if (!answers || typeof answers !== 'object') throw new EvalUnavailableError('Gateway 返回缺少 answers');
    const out: EvalAnswers = {};
    for (const c of cands) {
      const p = Number(answers?.[c.qid]?.probability);
      if (!Number.isFinite(p)) throw new EvalUnavailableError(`Gateway 返回缺少 qid=${c.qid} 的 probability`);
      out[c.qid] = p;
    }
    return out;
  }
  throw new EvalUnavailableError(lastErr || 'Gateway 不可用');
}

/** 全部候选分批评估（每批 ≤15）。返回 qid → P(true)。 */
export async function evalCandidates(need: string, cands: EvalCandidate[]): Promise<EvalAnswers> {
  const out: EvalAnswers = {};
  for (let i = 0; i < cands.length; i += BATCH_MAX) {
    const part = cands.slice(i, i + BATCH_MAX);
    const got = await evalBatch(need, part);
    Object.assign(out, got);
  }
  return out;
}

export const EVAL_BATCH_MAX = BATCH_MAX;
