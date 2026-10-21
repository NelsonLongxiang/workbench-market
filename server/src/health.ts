export interface ProbeResult {
  status: 'up' | 'down';
  latency_ms: number;
  http_code: number | null;
  error: string;
}

/** 校验并返回标准 URL；仅允许 http/https（内网工具的最低安全线） */
export function assertHttpUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`非法 URL：${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`仅支持 http/https 协议：${raw}`);
  return u;
}

/** base + health_path 组合探测地址；health_path 为完整 URL 时直接使用，空则用 base */
export function composeProbeUrl(base: string, healthPath: string): string {
  const hp = (healthPath || '').trim();
  if (!hp) return base;
  if (/^https?:\/\//i.test(hp)) return hp;
  const u = assertHttpUrl(base);
  return new URL(hp, u).toString();
}

export async function probe(
  rawUrl: string,
  opts: { method?: string; timeoutMs?: number; expectStatus?: number | null } = {}
): Promise<ProbeResult> {
  try {
    assertHttpUrl(rawUrl);
  } catch (e: any) {
    return { status: 'down', latency_ms: 0, http_code: null, error: String(e?.message ?? e) };
  }
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(rawUrl, {
      method: opts.method ?? 'GET',
      signal: ctrl.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'workbench-market/0.1 health-probe' },
    });
    const latency_ms = Math.round(performance.now() - started);
    const expect = opts.expectStatus ?? null;
    const ok = expect == null ? true : res.status === expect;
    return {
      status: ok ? 'up' : 'down',
      latency_ms,
      http_code: res.status,
      error: ok ? '' : `期望状态码 ${expect}，实际 ${res.status}`,
    };
  } catch (e: any) {
    const latency_ms = Math.round(performance.now() - started);
    const reason =
      e?.cause?.code ?? (e?.name === 'AbortError' ? `超时（>${opts.timeoutMs ?? 5000}ms）` : e?.message ?? String(e));
    return { status: 'down', latency_ms, http_code: null, error: String(reason) };
  } finally {
    clearTimeout(timer);
  }
}
