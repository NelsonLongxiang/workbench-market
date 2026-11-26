/** 属主个人令牌（#1063）的接口适配层：页面只在这里碰路径。
 *  契约（开发席回传，2026-11-25）：GET /api/owner/personal-tokens → { personal_tokens }（只有元数据）；
 *  POST 同路径 { name, scopes, benches, expires_in_days? } → 201 { token, personal_token }；DELETE /api/owner/personal-tokens/:id → 204。
 *  只认站内本人登录会话：不带管理口令（同报告治理），令牌原文只在签发应答里出现一次，不缓存、不落地。 */
export interface SourceResult { status: number; body: unknown }

export const PERSONAL_TOKENS_PATH = '/api/owner/personal-tokens';
export const personalTokenPath = (id: string) => PERSONAL_TOKENS_PATH + '/' + encodeURIComponent(id);

async function call(path: string, init?: RequestInit): Promise<SourceResult> {
  try {
    const r = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
    // 撤销是 204，没有应答体
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}

export const listPersonalTokens = () => call(PERSONAL_TOKENS_PATH);
export const issuePersonalToken = (body: object) => call(PERSONAL_TOKENS_PATH, { method: 'POST', body: JSON.stringify(body) });
export const revokePersonalToken = (id: string) => call(personalTokenPath(id), { method: 'DELETE' });
