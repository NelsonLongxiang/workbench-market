/** 属主个人令牌（#1063）的接口适配层：页面只在这里碰路径和字段名。
 *  PROVISIONAL：路径与字段名等开发席 feat/owner-personal-token 回传的契约，到了按它改这一个文件。
 *  只认站内本人登录会话：不带 X-Admin-Token（同报告治理），令牌原文只在签发应答里出现一次，不缓存、不落地。 */
export interface SourceResult { status: number; body: unknown }

export const PERSONAL_TOKENS_PATH = '/api/personal-tokens'; // PROVISIONAL

async function call(path: string, init?: RequestInit): Promise<SourceResult> {
  try {
    const r = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}

/** 清单：令牌（不含原文）、可选作用域及说明、有效期上限与缺省 */
export const listPersonalTokens = () => call(PERSONAL_TOKENS_PATH);
/** 签发：应答带仅此一次的原文 */
export const issuePersonalToken = (body: object) => call(PERSONAL_TOKENS_PATH, { method: 'POST', body: JSON.stringify(body) });
/** 撤销 */
export const revokePersonalToken = (id: string) => call(PERSONAL_TOKENS_PATH + '/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
