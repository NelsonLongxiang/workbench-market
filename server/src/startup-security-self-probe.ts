/** #326: fixed anonymous loopback checks, with a closed ingress until all mandatory rows pass. */
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage, type Server } from 'node:http';
import type { RequestHandler } from 'express';

const internalRequests = new WeakSet<IncomingMessage>();
export const isStartupProbeRequest = (req: IncomingMessage): boolean => internalRequests.has(req);
type Row = { id: string; surface: 'market' | 'control'; method: string; path: string; verdict: 'pass' | 'fail' | 'warn' | 'skip'; status: number | null; reason: string | null };
type State = { passed: boolean; failed: string[]; at: string | null; rows: Row[] };
type Target = { port: number; surface: 'market' | 'control' };
type Options = { market: Server; control?: Server; gatewayOn: boolean; nodeEnv?: string; loginGate?: 'enforce' | 'off' };
/** Login-gate rows impersonate a remote anonymous browser behind a same-host proxy, so the local-CLI exemption cannot apply. */
const REMOTE_ANON = { 'x-forwarded-for': '192.0.2.1', accept: 'text/html' };

const LISTEN_WAIT_MS = 10_000;

/** Does not import the application DB or read host/request-provided targets. */
export function createStartupSecurityProbe({ timeoutMs = 1500, log = (row: unknown) => console.log(JSON.stringify(row)) } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error('Invalid self-probe timeout');
  const marker = randomBytes(32).toString('hex');
  let state: State = { passed: false, failed: [], at: null, rows: [] };
  let running: Promise<State> | undefined;
  let expected: { port: number; method: string; path: string } | undefined;
  const snapshot = (): State => structuredClone(state);
  const middleware: RequestHandler = (req, res, next) => {
    if (state.passed) return next();
    const ip = req.socket.remoteAddress;
    const loopback = ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip === '::1';
    if (loopback && expected && req.socket.localPort === expected.port && req.method === expected.method &&
        req.url === expected.path && req.headers['x-wm-self-probe'] === marker) {
      internalRequests.add(req); // observation only: never bypasses downstream auth or validation
      return next();
    }
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' && (req.path.toLowerCase() === '/api/health' || req.path.toLowerCase() === '/api/health/ready')) {
      return res.status(503).json({ ok: false, self_probe: snapshot() });
    }
    return res.status(503).json({ error: 'startup_security_check_pending' });
  };

  function listener(server: Server | undefined): Promise<Target | null> {
    if (!server) return Promise.resolve(null);
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        server.off('listening', finish); server.off('error', finish);
        const address = server.address();
        resolve(address && typeof address !== 'string' ? { port: address.port, surface: 'market' } : null);
      };
      // 等监听与单次请求超时分开：启动慢（CI 繁忙）时 listening 可能晚于 1.5s 才到，不能当成「面没在听」；始终没听上照旧判失败
      const timer = setTimeout(finish, Math.max(timeoutMs, LISTEN_WAIT_MS));
      if (server.listening) return finish();
      server.once('listening', finish); server.once('error', finish);
    });
  }

  function send(target: Target, method: string, path: string, body?: string, origin = false, extra: Record<string, string> = {}): Promise<{ status: number | null; bearer: boolean; location: string; reason: string | null }> {
    return new Promise(resolve => {
      expected = { port: target.port, method, path };
      let settled = false;
      const finish = (result: { status: number | null; bearer: boolean; location: string; reason: string | null }) => {
        if (settled) return;
        settled = true; clearTimeout(timer); expected = undefined; resolve(result);
      };
      // All destinations and paths come from this module's closed table, never Host or an env URL.
      const req = request({ hostname: '127.0.0.1', port: target.port, method, path, agent: false,
        headers: { 'user-agent': 'workbench-market/self-probe', 'x-wm-self-probe': marker, 'x-internal-probe': '1',
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          ...(origin ? { origin: 'http://127.0.0.1:' + target.port } : {}), ...extra } }, res => {
        const bearer = /^Bearer(?:\s|$)/i.test(String(res.headers['www-authenticate'] ?? ''));
        finish({ status: res.statusCode ?? null, bearer, location: String(res.headers.location ?? ''), reason: null });
        res.destroy(); // status/header checks only; never collect potentially sensitive response bodies
      });
      const timer = setTimeout(() => { finish({ status: null, bearer: false, location: '', reason: 'timeout' }); req.destroy(); }, timeoutMs);
      req.once('error', () => finish({ status: null, bearer: false, location: '', reason: 'transport' }));
      req.end(body);
    });
  }

  async function execute({ market, control, gatewayOn, nodeEnv, loginGate = 'off' }: Options): Promise<State> {
    const [m, c] = await Promise.all([listener(market), listener(control)]);
    if (c) c.surface = 'control';
    const table = [
      { id: 'market.mcp.initialize', target: m, surface: 'market', method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}', status: 401, bearer: true, mcp: true },
      { id: 'market.mcp.tools-list', target: m, surface: 'market', method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', status: 401, mcp: true },
      // enforce: the login gate answers the anonymous browser first (401) before the admin write guard (403)
      { id: 'market.browser-workbench-write', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"","url":""}', origin: true, status: loginGate === 'enforce' ? 401 : 403 },
      { id: 'market.invalid-write-control', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"","url":""}', status: 400 },
      { id: 'control.admin-read', target: c, surface: 'control', method: 'GET', path: '/api/mcp/sessions', status: 403 },
      // 主体管理面：远程匿名浏览器列不出主体。登录门关着时由路由自己的管理门拒（403），开着时登录门先拦（401）。
      // 不带任何凭据，所以这一行不会去问登录提供方，也不读主体表
      { id: 'market.principals.admin-read', target: m, surface: 'market', method: 'GET', path: '/api/principals', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 登录回调：拿一个编出来的 state（形状合格、库里没有）来，必须 400、不跳转、不发会话。登录门开不开都一样（回调本来就放行）；
      // 不管配没配登录方式，这条路由都在
      // 失效通知：不带签名的事件必须 401（配没配登录方式都一样），不能停用任何人
      { id: 'market.login-flow.unsigned-event', target: m, surface: 'market', method: 'POST', path: '/login/feishu/events', body: '{"schema":"2.0"}', headers: REMOTE_ANON, status: 401 },
      { id: 'market.login-flow.forged-callback', target: m, surface: 'market', method: 'GET', path: '/login/feishu/callback?state=wm-self-probe-forged-state-000000000000000&code=x', headers: REMOTE_ANON, status: 400 },
      // Login gate (enforce only): fixed synthetic slug, so a bypass shows up as 404/200 instead of the login redirect
      ...(loginGate === 'enforce' ? [
        { id: 'market.login-gate.page', target: m, surface: 'market', method: 'GET', path: '/', headers: REMOTE_ANON, status: 302, login: true },
        { id: 'market.login-gate.app', target: m, surface: 'market', method: 'GET', path: '/apps/wm-self-probe/', headers: REMOTE_ANON, status: 302, login: true },
        { id: 'market.login-gate.api', target: m, surface: 'market', method: 'GET', path: '/api/apps', headers: REMOTE_ANON, status: 401 },
        // /a2a/direct 放行到路由、由签名判定：无签名的投递必须 401（合成队名，签名关掉时会落到 404）
        { id: 'market.a2a-direct.unsigned', target: m, surface: 'market', method: 'POST', path: '/a2a/direct', body: '{"team":"market/00000000","message":"x","caller_session":"wm-self-probe/00000000"}', headers: REMOTE_ANON, status: 401 },
      ] as const : []),
    ] as const;
    for (const test of table) {
      const row: Row = { id: test.id, surface: test.surface, method: test.method, path: test.path, verdict: 'fail', status: null, reason: null };
      if (test.surface === 'control' && !c) {
        row.verdict = 'skip'; row.reason = control ? 'control-not-listening' : 'control-disabled';
      } else if (!test.target) row.reason = 'surface-not-listening';
      else if ('mcp' in test && !gatewayOn) {
        // Anonymous MCP is a local-only exception, never inferred from an absent/unknown NODE_ENV.
        const localMode = nodeEnv === 'development' || nodeEnv === 'test';
        row.verdict = localMode ? 'warn' : 'fail';
        row.reason = localMode ? 'gateway-explicitly-off' : 'gateway-off-forbidden';
      }
      else {
        const result = await send(test.target, test.method, test.path, 'body' in test ? test.body : undefined, 'origin' in test && test.origin, 'headers' in test ? test.headers : {});
        row.status = result.status;
        const passed = result.status === test.status && (!('bearer' in test) || result.bearer) && (!('login' in test) || /^\/login(\?|$)/.test(result.location));
        row.verdict = passed ? 'pass' : 'fail';
        row.reason = passed ? null : result.reason ?? 'unexpected-status-or-challenge';
      }
      state.rows.push(row);
      log({ source: 'self-probe', ...row }); // allowlisted fields only, no headers, body, marker or raw error
    }
    state = { passed: state.rows.every(r => r.verdict !== 'fail'), failed: state.rows.filter(r => r.verdict === 'fail').map(r => r.id), at: new Date().toISOString(), rows: state.rows };
    return snapshot();
  }
  return { middleware, snapshot, run(options: Options) {
    return running ??= execute(options);
  } };
}
