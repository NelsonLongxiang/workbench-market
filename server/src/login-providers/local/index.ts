/**
 * 登录方式插件：账号密码（站内账号，docs/local-accounts.md）。向 identity 服务登记登录方式 local，带站内表单：
 *   begin     把浏览器送到本站的表单页 /login/local/form?state=…（state 由核心签好）；
 *   form      GET 出登录表单；POST 核对用户名和密码（账号服务 localAccounts），对了发一个一次性码，去核心的回调；
 *             临时密码对了的（管理员建的人、重置过的）先出改密码的一步，改好才发码；
 *             每提交一次就把 state 换一个（loginSessions.rotateState，一次性）：页面、码、改密码票都接着用新的，
 *             用过的、重放的、并发拿同一个来交的，只有一个换得到，别的不进哈希。账号密码那一步先占核对名额再换（见 verify 的 claim），
 *             名额占不上回 429，state 不动；
 *   complete  回调拿码换回用户名（码绑着这次的 state，60 秒、用一次）。
 * 对到主体、等待页、发会话、停用，都是核心的事（routes/login-flows.ts），这里不碰。
 *
 * 配置：WM_LOCAL_LOGIN=on|off，缺省 on（不设就开）；别的值拒绝启动。
 *       WM_LOCAL_SIGNUP=approval|off，缺省 off（没有注册入口）；approval：表单页有「注册新账号」，自己注册的账号要管理员核准才进得去（第 4 节）。
 *       WM_LOCAL_SIGNUP_PENDING_MAX：等核准的自己注册账号全站最多几个，缺省 50（1～10000 的整数，别的值拒绝启动）；到了就暂停注册（503）。
 *       启动时打一行日志写明这几项当下的值。
 * 注册：表单页 ?view=signup 出注册页；提交（mode=signup）只建站内账号，然后照常去回调——核心发现没对接，进待对接清单、给等待页。
 * 提示只说「用户名或密码不对」，不分没这个人、密码错、锁着了；页面不带任何从库里来的东西（只有用户自己刚输的用户名）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FlowBegin, FlowComplete, FlowForm, FlowFormInput, IdentityService, LoginFlow } from '../../identity.ts';
import type { LocalAccountService } from '../../services/local-account.ts';
import type { LoginSessionService } from '../../services/login-session.ts';
import { PASSWORD_MIN, SIGNUP_PENDING_MAX_DEFAULT } from '../../services/local-account.ts';
import { defineConfig, loadConfig } from '../../config.ts';

export const Config = defineConfig((env) => {
  const raw = String(env.WM_LOCAL_LOGIN ?? '').trim();
  if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`[local] 拒绝启动：WM_LOCAL_LOGIN 只接受 on / off / 不设，现在是 ${JSON.stringify(raw)}`);
  const signup = String(env.WM_LOCAL_SIGNUP ?? '').trim();
  if (signup !== '' && signup !== 'approval' && signup !== 'off') throw new Error(`[local] 拒绝启动：WM_LOCAL_SIGNUP 只接受 approval / off / 不设，现在是 ${JSON.stringify(signup)}`);
  const capRaw = String(env.WM_LOCAL_SIGNUP_PENDING_MAX ?? '').trim();
  const cap = capRaw === '' ? SIGNUP_PENDING_MAX_DEFAULT : /^[1-9][0-9]{0,4}$/.test(capRaw) && Number(capRaw) <= 10_000 ? Number(capRaw) : NaN;
  if (Number.isNaN(cap)) throw new Error(`[local] 拒绝启动：WM_LOCAL_SIGNUP_PENDING_MAX 只接受 1～10000 的整数或不设，现在是 ${JSON.stringify(capRaw)}`);
  return { on: raw !== 'off', signup: signup === 'approval', signupPendingMax: cap };
});
const config = loadConfig(Config);

let accounts: () => LocalAccountService = () => { throw new Error('localAccounts 还没装上'); };
let sessions: () => LoginSessionService = () => { throw new Error('loginSessions 还没装上'); };
/** 注册时问主体目录：这个用户名对接成主体时会不会撞名。没装上就当占着（失败关闭） */
let nameTaken: (username: string) => boolean = () => true;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BAD = '用户名或密码不对。连续输错多次，账号会暂时锁定一会儿。';

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><style>body{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;background:#F6F7F9;color:#0F172A;margin:0}`
    + `main{max-width:360px;margin:12vh auto;background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:28px}`
    + `h1{font-size:20px;margin:0 0 16px}label{display:block;font-size:14px;margin:12px 0 4px}`
    + `input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #CBD5E1;border-radius:6px;font-size:14px}`
    + `button{margin-top:18px;width:100%;padding:9px;border:0;border-radius:6px;background:#1E3A5F;color:#fff;font-size:14px;cursor:pointer}`
    + `p.err{color:#DC2626;font-size:14px;margin:0 0 8px}p.hint{color:#5A6577;font-size:13px}a{color:#1E3A5F}</style>`
    + `<main><h1>${esc(title)}</h1>${body}<p class="hint"><a href="/login">换一种登录方式</a></p></main></html>`;
}

const action = (state: string) => `/login/local/form?state=${encodeURIComponent(state)}`;
const signupHref = (state: string) => `${action(state)}&view=signup`;

function loginPage(state: string, status: number, error = '', username = ''): FlowForm {
  return { kind: 'page', status, html: shell('账号密码登录',
    `${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<form method="post" action="${esc(action(state))}">`
    + `<label for="u">用户名</label><input id="u" name="username" autocomplete="username" required maxlength="64" value="${esc(username.slice(0, 64))}">`
    + `<label for="p">密码</label><input id="p" name="password" type="password" autocomplete="current-password" required maxlength="512">`
    + `<button type="submit">登录</button></form>`
    + (config.signup ? `<p class="hint">还没有账号？<a href="${esc(signupHref(state))}">注册新账号</a>（管理员核准后才能用）</p>` : '')) };
}

function signupPage(state: string, status: number, error = '', username = '', displayName = ''): FlowForm {
  return { kind: 'page', status, html: shell('注册新账号',
    `<p class="hint">注册之后要等管理员核准才能进去。</p>`
    + `${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<form method="post" action="${esc(action(state))}">`
    + `<input type="hidden" name="mode" value="signup">`
    + `<label for="u">用户名</label><input id="u" name="username" autocomplete="username" required maxlength="32" value="${esc(username.slice(0, 32))}">`
    + `<label for="d">显示名（可不填）</label><input id="d" name="display_name" autocomplete="name" maxlength="64" value="${esc(displayName.slice(0, 64))}">`
    + `<label for="p">密码</label><input id="p" name="password" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN}" maxlength="512">`
    + `<label for="c">再输一次</label><input id="c" name="confirm" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN}" maxlength="512">`
    + `<button type="submit">注册</button></form><p class="hint"><a href="${esc(action(state))}">已有账号，去登录</a></p>`) };
}

const NO_SIGNUP: FlowForm = { kind: 'page', status: 404, html: shell('没有注册入口', '<p class="hint">这里不开放自己注册，请联系管理员开通账号。</p>') };

function changePage(state: string, ticket: string, status: number, error = ''): FlowForm {
  return { kind: 'page', status, html: shell('先设一个新密码',
    `<p class="hint">你用的是管理员发的临时密码，设好自己的密码才能进去（至少 ${PASSWORD_MIN} 位，不能和用户名一样）。</p>`
    + `${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<form method="post" action="${esc(action(state))}">`
    + `<input type="hidden" name="ticket" value="${esc(ticket)}">`
    + `<label for="n">新密码</label><input id="n" name="next" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN}" maxlength="512">`
    + `<label for="c">再输一次</label><input id="c" name="confirm" type="password" autocomplete="new-password" required minlength="${PASSWORD_MIN}" maxlength="512">`
    + `<button type="submit">设好，进去</button></form>`) };
}

function toCallback(callbackUrl: string, state: string, code: string): FlowForm {
  const u = new URL(callbackUrl);
  u.searchParams.set('state', state);
  u.searchParams.set('code', code);
  return { kind: 'redirect', location: u.href };
}

/** state 用过了（重放、并发里没换到、过期）：这一次登录不能接着走了，回到登录页重来 */
function stalePage(): FlowForm {
  return { kind: 'page', status: 400, html: shell('登录请求已经用过或过期了', '<p class="hint">这个登录表单已经提交过了。请回到登录页重新登录。</p>') };
}

async function form(input: FlowFormInput): Promise<FlowForm> {
  const { state, fields } = input;
  if (input.method === 'GET') return input.view === 'signup' && config.signup ? signupPage(state, 200) : loginPage(state, 200);
  const acc = accounts();
  // 自己注册：只建站内账号，不建主体；然后照常去回调（核心发现没对接：进待对接清单、给等待页）。
  // state 和登录一样一次性：先换掉，之后的页面、码都用新的；换不到（重放、并发、过期）给「已经用过」页
  if (fields.mode === 'signup') {
    if (!config.signup) return NO_SIGNUP;
    const fresh = sessions().rotateState('local', state);
    if (!fresh) return stalePage();
    const typedName = typeof fields.username === 'string' ? fields.username : '';
    const typedDisplay = typeof fields.display_name === 'string' ? fields.display_name : '';
    const r = await acc.register({ username: typedName, displayName: typedDisplay, password: fields.password, confirm: fields.confirm }, input.source, (u) => nameTaken(u));
    if (!r.ok) return signupPage(fresh, r.reason === 'throttled' ? 429 : r.reason === 'taken' ? 409 : r.reason === 'paused' ? 503 : 400, r.message, typedName, typedDisplay);
    console.log(JSON.stringify({ source: 'local-accounts', event: 'signup', username: r.username, at: new Date().toISOString() }));
    return toCallback(input.callbackUrl, fresh, acc.issueCode(r.username, fresh));
  }
  // 改密码那一步：票绑着交上来的那个 state，用一次作废；state 先换掉（一次性），之后都用新的；没改成（两次不一致、不合规）再发一张新票
  if (typeof fields.ticket === 'string' && fields.ticket) {
    const fresh = sessions().rotateState('local', state);
    if (!fresh) return stalePage();
    const username = acc.takeTicket(fields.ticket, state);
    if (!username) return loginPage(fresh, 400, '这一步已经过期了，请重新输入用户名和临时密码。');
    const problem = fields.next !== fields.confirm ? '两次输的新密码不一样' : await acc.setPassword(username, fields.next);
    if (problem) return changePage(fresh, acc.issueTicket(username, fresh), 400, problem);
    // 密码换了：这个账号已有的市场会话一律注销
    sessions().revokeForIdentity('local', username);
    return toCallback(input.callbackUrl, fresh, acc.issueCode(username, fresh));
  }
  const typed = typeof fields.username === 'string' ? fields.username : '';
  // 先占核对名额（来源、用户名、全进程），占上了再换 state，换上了才算哈希
  let fresh: string | null = null;
  const r = await acc.verify(typed, fields.password, input.source, Date.now(), { claim: () => (fresh = sessions().rotateState('local', state)) !== null });
  if (!r.ok && r.reason === 'stale') return stalePage();
  if (!r.ok && r.reason === 'throttled') return loginPage(state, 429, '尝试太频繁或系统正忙，请稍后再试。', typed);
  const next = fresh ?? state;
  if (!r.ok) return loginPage(next, 401, BAD, typed);
  if (r.mustChange) return changePage(next, acc.issueTicket(r.username, next), 200);
  return toCallback(input.callbackUrl, next, acc.issueCode(r.username, next));
}

const fail = (http: number, error: string) => ({ ok: false as const, http, error });

const flow: LoginFlow = {
  name: 'local',
  label: '账号密码',
  available: () => config.on,
  form,

  async begin({ state, callbackUrl }): Promise<FlowBegin> {
    const u = new URL(callbackUrl);
    u.pathname = u.pathname.replace(/\/callback$/, '/form');
    u.search = '';
    u.searchParams.set('state', state);
    return { ok: true, location: u.href };
  },

  async complete(query, { state }): Promise<FlowComplete> {
    const username = accounts().takeCode(query.code, state);
    if (!username) return fail(400, '登录码无效或已过期');
    const account = accounts().get(username);
    if (!account) return fail(400, '登录码无效或已过期');
    accounts().noteLogin(username);
    return { ok: true, identity: { externalId: username, displayName: account.display_name || username, email: null, emailTrusted: false, outsider: false } };
  },
};

export const name = 'login-provider-local';
export const inject = ['identity', 'localAccounts', 'loginSessions', 'principals'];
export function apply(ctx: Context): void {
  accounts = () => ctx.get('localAccounts') as LocalAccountService;
  sessions = () => ctx.get('loginSessions') as LoginSessionService;
  nameTaken = (username) => {
    const p = ctx.get('principals') as { nameTaken?: (provider: string, externalId: string) => boolean } | undefined;
    return typeof p?.nameTaken === 'function' ? p.nameTaken('local', username) === true : true;
  };
  ctx.effect(() => accounts().setSignupPolicy({ open: config.on && config.signup, pendingMax: config.signupPendingMax }), 'localAccounts.setSignupPolicy');
  console.log(JSON.stringify({ source: 'local-accounts', event: 'config', login: config.on ? 'on' : 'off', signup: config.on && config.signup ? 'approval' : 'off', signup_pending_max: config.signupPendingMax, at: new Date().toISOString() }));
  ctx.effect(() => (ctx.get('identity') as IdentityService).registerFlow(flow), 'identity.registerFlow(local)');
}
