/**
 * 登录方式插件：飞书（网页应用的标准授权码流程）。向 identity 服务登记一个登录方式，只管和飞书打交道的两步：
 *   begin    把浏览器送去飞书的授权页（带上核心给的 state 和回调地址）；
 *   complete 拿回调带回来的 code 去飞书换 user_access_token，再取用户信息，交回 union_id、显示名、企业邮箱。
 * state 的核销、回到哪里、对到主体、发会话，都是核心的事（routes/login-flows.ts），这里不碰。
 *
 * 配置（启动时读一次并校验，不合法拒绝启动；见 README）：
 *   WM_FEISHU_LOGIN=on            打开（缺省关）
 *   WM_FEISHU_AUTHORIZE_URL       授权页，缺省飞书开放平台文档里的地址
 *   WM_FEISHU_TOKEN_URL           用 code 换 user_access_token，缺省同上
 *   WM_FEISHU_USERINFO_URL        取用户信息，缺省同上
 *   WM_FEISHU_TENANT_TOKEN_URL    对账用：取 tenant_access_token，缺省同上
 *   WM_FEISHU_CONTACT_USER_URL    对账用：按 union_id 查一个人（地址后面接 union_id），缺省同上
 *   WM_FEISHU_VAULT_ENTRY         应用的标识和密钥在凭据库里的条目名（缺省 feishu-login）：username 是 App ID，password 是 App Secret
 *   WM_FEISHU_TENANT_KEY          可选：只认这个租户的人（用户信息里的 tenant_key 必须相等）
 *   WM_FEISHU_AUTO_BIND_EMAIL=on  没对到主体的人，按飞书给的企业邮箱自动对到已有的主体上（缺省关；必须同时配 WM_FEISHU_TENANT_KEY；规则见 routes/login-flows.ts）
 * 地址只收 https；本机回环的 http 只给测试用（本机起的假飞书）。应用的密钥只发给换令牌、取 tenant_access_token 这两个地址。
 *
 * 失效通知（handleEvent，飞书通讯录事件，事件订阅要配 Encrypt Key）：照飞书文档验签——
 *   sha256(X-Lark-Request-Timestamp + X-Lark-Request-Nonce + Encrypt Key + 原始请求体) 和 X-Lark-Signature 相等，时间戳在 5 分钟内；
 *   验过再解密（AES-256-CBC，密钥是 sha256(Encrypt Key)，密文前 16 字节是 IV），再核对 Verification Token 和 App ID。
 *   Encrypt Key、Verification Token 放在凭据库同一条的自定义字段 encrypt_key、verification_token 里。
 *   员工离职（contact.user.deleted_v3）、员工被修改成离职、冻结、退出（contact.user.updated_v3）：交回 union_id 停用。
 * 对账（checkMembers）：用 tenant_access_token 按 union_id 逐个查人，状态明确说离职、冻结、退出才算 gone；查不到、出错都是 unknown。
 *
 * 从 identity.ts 只引用类型：那边在装配时引用本插件，带值的引用会绕成环。凭据库在用到时才引入（引入它会开库）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { FlowBegin, FlowComplete, FlowEvent, IdentityService, LoginFlow } from '../../identity.ts';

const DEFAULTS = {
  authorize: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  token: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  userinfo: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
  tenantToken: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
  contactUser: 'https://open.feishu.cn/open-apis/contact/v3/users/',
};

/** 地址只收 https；http 只收本机回环（测试用的假飞书）。带用户名密码、带片段的不收 */
function endpoint(name: string, raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim() || fallback;
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`[feishu] 拒绝启动：${name} 不是合法的地址`); }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) || u.username || u.password || u.hash) {
    throw new Error(`[feishu] 拒绝启动：${name} 只收 https 地址（本机回环的 http 只给测试用），不能带用户名、密码或片段`);
  }
  return u.href;
}

function readConfig(env: NodeJS.ProcessEnv) {
  const mode = String(env.WM_FEISHU_LOGIN ?? '').trim();
  if (mode !== '' && mode !== 'on' && mode !== 'off') throw new Error('[feishu] 拒绝启动：WM_FEISHU_LOGIN 只接受 on / off / 不设');
  const vaultEntry = String(env.WM_FEISHU_VAULT_ENTRY ?? '').trim() || 'feishu-login';
  if (vaultEntry.length > 200 || /[\x00-\x1f\x7f]/.test(vaultEntry)) throw new Error('[feishu] 拒绝启动：WM_FEISHU_VAULT_ENTRY 不合法');
  const autoBind = String(env.WM_FEISHU_AUTO_BIND_EMAIL ?? '').trim();
  if (autoBind !== '' && autoBind !== 'on' && autoBind !== 'off') throw new Error('[feishu] 拒绝启动：WM_FEISHU_AUTO_BIND_EMAIL 只接受 on / off / 不设');
  const tenant = String(env.WM_FEISHU_TENANT_KEY ?? '').trim();
  if (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new Error('[feishu] 拒绝启动：WM_FEISHU_TENANT_KEY 不合法');
  // 按邮箱自动对上要能确认邮箱来自本组织：没配租户就打开自动对上，拒绝启动
  if (autoBind === 'on' && !tenant) throw new Error('[feishu] 拒绝启动：WM_FEISHU_AUTO_BIND_EMAIL=on 时必须配 WM_FEISHU_TENANT_KEY（只认本组织的企业邮箱）');
  return {
    on: mode === 'on',
    authorize: endpoint('WM_FEISHU_AUTHORIZE_URL', env.WM_FEISHU_AUTHORIZE_URL, DEFAULTS.authorize),
    token: endpoint('WM_FEISHU_TOKEN_URL', env.WM_FEISHU_TOKEN_URL, DEFAULTS.token),
    userinfo: endpoint('WM_FEISHU_USERINFO_URL', env.WM_FEISHU_USERINFO_URL, DEFAULTS.userinfo),
    tenantToken: endpoint('WM_FEISHU_TENANT_TOKEN_URL', env.WM_FEISHU_TENANT_TOKEN_URL, DEFAULTS.tenantToken),
    contactUser: endpoint('WM_FEISHU_CONTACT_USER_URL', env.WM_FEISHU_CONTACT_USER_URL, DEFAULTS.contactUser),
    vaultEntry,
    tenant,
    autoBind: autoBind === 'on',
  };
}

/** 启动时读一次 */
const config = readConfig(process.env);

/** 飞书的 union_id：on_ 加 32 位十六进制。形状不对的一律不认（缺失、被篡改、塞了别的东西） */
const UNION_ID = /^on_[0-9a-f]{32}$/;
/** 授权码：只收这些字符，长度有限。真正的校验在飞书那边 */
const CODE = /^[A-Za-z0-9_.-]{1,512}$/;
const REQUEST_MS = 8_000;
const fail = (http: number, error: string) => ({ ok: false as const, http, error });

async function credential(): Promise<{ id: string; secret: string; fields: Record<string, string> } | null> {
  const { vaultCredential } = await import('../../vault-api.ts');
  return vaultCredential(config.vaultEntry);
}

/** 发一个请求、读 JSON。不跟随跳转；超时、非 JSON、读失败都返回 null */
async function json(url: string, init: RequestInit): Promise<{ status: number; body: any } | null> {
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_MS) });
    const text = await res.text();
    if (text.length > 64 * 1024) return null;
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** 事件的时间戳最多和本机差这么多秒：再旧的按重放处理 */
const EVENT_SKEW_S = 300;
const reject = (http: number, error: string): FlowEvent => ({ http, body: { error } });

/** AES-256-CBC 解密：密钥 sha256(Encrypt Key)，密文（base64）前 16 字节是 IV。解不开返回 null */
function decrypt(encryptKey: string, encrypted: string): unknown {
  try {
    const buf = Buffer.from(encrypted, 'base64');
    if (buf.length < 32 || buf.length % 16 !== 0) return null;
    const key = createHash('sha256').update(encryptKey, 'utf8').digest();
    const d = createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

const gone = (status: unknown): boolean => {
  const s = status as { is_resigned?: unknown; is_frozen?: unknown; is_exited?: unknown } | null | undefined;
  return s?.is_resigned === true || s?.is_frozen === true || s?.is_exited === true;
};

async function handleEvent({ headers, rawBody }: { headers: Record<string, string>; rawBody: Buffer }): Promise<FlowEvent> {
  const ts = headers['x-lark-request-timestamp'] ?? '', nonce = headers['x-lark-request-nonce'] ?? '', sig = headers['x-lark-signature'] ?? '';
  if (!/^[0-9]{1,12}$/.test(ts) || !nonce || nonce.length > 128 || !/^[0-9a-f]{64}$/.test(sig)) return reject(401, 'event_unauthorized');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > EVENT_SKEW_S) return reject(401, 'event_unauthorized');
  const cred = await credential();
  const encryptKey = cred?.fields.encrypt_key ?? '', verificationToken = cred?.fields.verification_token ?? '';
  if (!cred || !encryptKey || !verificationToken) return reject(503, 'event_unavailable');
  const expected = createHash('sha256').update(Buffer.concat([Buffer.from(ts + nonce + encryptKey, 'utf8'), rawBody])).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return reject(401, 'event_unauthorized');
  // 签名对了才读内容
  let outer: { encrypt?: unknown };
  try { outer = JSON.parse(rawBody.toString('utf8')); } catch { return reject(400, 'event_malformed'); }
  const payload = typeof outer?.encrypt === 'string' ? decrypt(encryptKey, outer.encrypt) as Record<string, any> | null : null;
  if (!payload || typeof payload !== 'object') return reject(400, 'event_malformed');
  if (payload.type === 'url_verification') {
    return payload.token === verificationToken && typeof payload.challenge === 'string' ? { http: 200, body: { challenge: payload.challenge } } : reject(401, 'event_unauthorized');
  }
  const h = payload.header ?? {};
  if (payload.schema !== '2.0' || h.token !== verificationToken || h.app_id !== cred.id) return reject(401, 'event_unauthorized');
  const eventId = typeof h.event_id === 'string' ? h.event_id : '';
  if (!eventId) return reject(400, 'event_malformed');
  // 配了租户：别的租户的事件不处理（回 200，免得对方一直重试）
  if (config.tenant && h.tenant_key !== config.tenant) return { http: 200, body: {}, eventId, offboard: [] };
  const object = payload.event?.object ?? {};
  const unionId = typeof object.union_id === 'string' && UNION_ID.test(object.union_id) ? object.union_id : null;
  let offboard: string[] = [];
  if (unionId && h.event_type === 'contact.user.deleted_v3') offboard = [unionId];
  else if (unionId && h.event_type === 'contact.user.updated_v3' && gone(object.status)) offboard = [unionId];
  return { http: 200, body: {}, eventId, offboard };
}

async function checkMembers(externalIds: string[]): Promise<{ gone: string[]; unknown: string[] }> {
  const cred = await credential();
  if (!cred) return { gone: [], unknown: externalIds };
  const token = await json(config.tenantToken, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: cred.id, app_secret: cred.secret }) });
  const tenantToken = token && token.status === 200 && token.body?.code === 0 ? token.body.tenant_access_token : null;
  if (typeof tenantToken !== 'string' || !tenantToken) return { gone: [], unknown: externalIds };
  const out = { gone: [] as string[], unknown: [] as string[] };
  let next = 0;
  // 同时最多查 8 个
  await Promise.all(Array.from({ length: Math.min(8, externalIds.length) }, async () => {
    while (next < externalIds.length) {
      const id = externalIds[next++];
      if (!UNION_ID.test(id)) { out.unknown.push(id); continue; }
      const r = await json(`${config.contactUser}${encodeURIComponent(id)}?user_id_type=union_id`, { method: 'GET', headers: { authorization: `Bearer ${tenantToken}` } });
      const user = r && r.status === 200 && r.body?.code === 0 ? r.body.data?.user : null;
      if (!user) out.unknown.push(id);
      else if (gone(user.status)) out.gone.push(id);
    }
  }));
  return out;
}

const flow: LoginFlow = {
  name: 'feishu',
  label: '用飞书登录',
  available: () => config.on,
  autoBindByEmail: config.autoBind,
  handleEvent,
  checkMembers,

  async begin({ state, callbackUrl }): Promise<FlowBegin> {
    const cred = await credential();
    if (!cred) return fail(503, '飞书登录暂时不可用：凭据库里取不到应用凭证');
    const u = new URL(config.authorize);
    // 新旧两版授权页的参数名不同（client_id / app_id），两个都带上
    u.searchParams.set('client_id', cred.id);
    u.searchParams.set('app_id', cred.id);
    u.searchParams.set('redirect_uri', callbackUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', state);
    return { ok: true, location: u.href };
  },

  async complete(query, { callbackUrl }): Promise<FlowComplete> {
    if (query.error !== undefined) return fail(401, '飞书那边没有同意授权');
    const code = query.code;
    if (typeof code !== 'string' || !CODE.test(code)) return fail(400, '回调里没有合格的授权码');
    const cred = await credential();
    if (!cred) return fail(503, '飞书登录暂时不可用：凭据库里取不到应用凭证');
    const token = await json(config.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: cred.id, client_secret: cred.secret, code, redirect_uri: callbackUrl }),
    });
    const accessToken = token && token.status === 200 && token.body?.code === 0 ? token.body.access_token : null;
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) return fail(502, '飞书没有换出令牌');
    const info = await json(config.userinfo, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } });
    const data = info && info.status === 200 && info.body?.code === 0 ? info.body.data : null;
    const unionId = data?.union_id;
    if (typeof unionId !== 'string' || !UNION_ID.test(unionId)) return fail(502, '飞书返回的用户标识缺失或形状不对');
    // 配了租户而租户不符：不直接报错，交回身份并标成外人——核心只把它记进待对接清单、留痕，不给会话
    const outsider = Boolean(config.tenant) && data.tenant_key !== config.tenant;
    return {
      ok: true,
      identity: {
        externalId: unionId,
        displayName: typeof data.name === 'string' ? data.name : null,
        email: typeof data.enterprise_email === 'string' && data.enterprise_email ? data.enterprise_email : null,
        // 只有配了租户、而且核对过（上面不相等已经回 403），企业邮箱才算本组织的
        emailTrusted: Boolean(config.tenant) && !outsider,
        outsider,
      },
    };
  },
};

export const name = 'login-provider-feishu';
export const inject = ['identity'];
export function apply(ctx: Context): void {
  ctx.effect(() => (ctx.get('identity') as IdentityService).registerFlow(flow), 'identity.registerFlow(feishu)');
}
