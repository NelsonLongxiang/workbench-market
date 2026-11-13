/** #326: fixed anonymous loopback checks, with a closed ingress until all mandatory rows pass. */
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage, type Server } from 'node:http';
import type { RequestHandler } from 'express';

const internalRequests = new WeakSet<IncomingMessage>();
export const isStartupProbeRequest = (req: IncomingMessage): boolean => internalRequests.has(req);
type Row = { id: string; surface: 'market' | 'control'; method: string; path: string; verdict: 'pass' | 'fail' | 'warn' | 'skip'; status: number | null; reason: string | null };
type State = { passed: boolean; failed: string[]; at: string | null; rows: Row[] };
type Target = { port: number; surface: 'market' | 'control' };
type Options = { market: Server; control?: Server; gatewayOn: boolean; nodeEnv?: string; loginGate?: 'enforce' | 'off'; appDataRead?: 'enforce' | 'warn'; sopRunWrite?: 'enforce' | 'warn'; benchViews?: boolean; outbound?: () => Promise<{ ok: boolean; reason: string | null }> };
/** Login-gate rows impersonate a remote anonymous browser behind a same-host proxy, so the local-CLI exemption cannot apply. */
const REMOTE_ANON = { 'x-forwarded-for': '192.0.2.1', accept: 'text/html' };

const LISTEN_WAIT_MS = 10_000;
/**
 * 测试环境（NODE_ENV=test）的等待时长：CI 机器忙的时候，单条自检请求 1.5 秒、等监听 10 秒都可能不够，实例会因为「超时」「面没在听」拒绝启动，
 * 测试跟着红，和被测的行为无关。只拉长等待，判定一条不改：应答不对照样不过、照样拒绝启动。生产（NODE_ENV 不是 test）不受影响。
 */
export const TEST_ENV_WAITS = { timeoutMs: 8000, listenWaitMs: 60_000 } as const;

/** Does not import the application DB or read host/request-provided targets. */
export function createStartupSecurityProbe({ timeoutMs = 1500, listenWaitMs = LISTEN_WAIT_MS, log = (row: unknown) => console.log(JSON.stringify(row)) } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TEST_ENV_WAITS.timeoutMs) throw Error('Invalid self-probe timeout');
  if (!Number.isInteger(listenWaitMs) || listenWaitMs < 1 || listenWaitMs > TEST_ENV_WAITS.listenWaitMs) throw Error('Invalid self-probe listen wait');
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
      const timer = setTimeout(finish, Math.max(timeoutMs, listenWaitMs));
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

  async function execute({ market, control, gatewayOn, nodeEnv, loginGate = 'off', appDataRead = 'enforce', sopRunWrite = 'enforce', benchViews = false, outbound }: Options): Promise<State> {
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
      // 导出真值：远程匿名带 reveal=1 拿不到真值。登录门关着时由路由的管理员门拒（403，不降级成掩码），开着时登录门先拦（401）
      // 建立人验收入口（8e）：它不经写请求总门，远程匿名来必须 401（登录门开着时登录门先拦，也是 401）
      { id: 'market.work-items.creator-decision-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/decision', body: '{"answer":"verify"}', origin: true, headers: REMOTE_ANON, status: 401 },
      // L20：「关注」的答复入口经写请求总门放行，能不能答由条目的来源判。远程匿名答一个只给管理员的来源（变更申请）必须被拒
      { id: 'market.attention.answer-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/attention/answer', body: '{"source":"change-requests","source_id":"1","answer":"approve"}', origin: true, headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 规范 14：负责人放行的入口同样经写请求总门放行、路由内认人，远程匿名来必须 401
      { id: 'market.work-items.lead-release-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/release', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 阶段七 R2：事项对话里回复席位消息的入口同样经写请求总门放行、路由内认人，远程匿名来必须 401
      { id: 'market.work-items.seat-reply-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/messages/1/reply', body: '{"text":"selfprobe"}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 事项列表（GET /api/work-items）：只给管理员和登录的人，远程匿名必须 401（登录门开着时登录门先拦，也是 401）；不放行本机页面
      { id: 'market.work-items.list-anonymous', target: m, surface: 'market', method: 'GET', path: '/api/work-items', headers: REMOTE_ANON, status: 401 },
      // 「安排一件事」（POST /api/work-items）：不经管理门，远程匿名来必须 401（登录门开着时登录门先拦，也是 401）
      { id: 'market.work-items.arrange-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 建立人回答席位提问的入口同样经写请求总门放行、路由内认人，远程匿名来必须 401
      { id: 'market.work-items.seat-ask-answer-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/asks/1/answer', body: '{"text":"selfprobe"}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 驾驶舱的写（不经写请求总门，路由自己判）：远程匿名改一个不存在的驾驶舱必须 401——认人在找驾驶舱之前，所以门坏了会回 404，也不会改到任何东西
      { id: 'market.cockpits.anonymous-write', target: m, surface: 'market', method: 'PUT', path: '/api/cockpits/999999999', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 「安排一件事」的附件上传、改截止日期：同样经写请求总门放行、路由内认人，远程匿名来必须 401
      { id: 'market.work-items.attachment-upload-anonymous', target: m, surface: 'market', method: 'PUT', path: '/api/work-items/attachments/selfprobe.txt', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.work-items.due-set-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/due', body: '{"due":null}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.export.reveal-anonymous', target: m, surface: 'market', method: 'GET', path: '/api/export?reveal=1', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 数据视图的入口（WM_BENCH_VIEWS=on 才有这两行；关着时整组路由回 404，由 scripts/bench-views-entry-test.mjs 看）：
      // 远程匿名读不到台的清单、也登记不了台（登录门开不开都是 401：登录门先拦，或者路由自己认不出人）
      ...(benchViews ? [
        { id: 'market.bench-views.anonymous-read', target: m, surface: 'market' as const, method: 'GET', path: '/api/bench-views', headers: REMOTE_ANON, status: 401 },
        { id: 'market.bench-views.anonymous-write', target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views', body: '{"slug":"wm-self-probe","title":"x"}', headers: REMOTE_ANON, status: 401 },
      ] : []),
      // 授予管理面：远程匿名列不出授予（GET 不经写请求总门，拒的是路由自己的管理门；登录门开着时登录门先拦 401）
      // L19：授予的读对登录的人放开（只看自己能放行的），远程匿名仍然读不到（没登录 401）
      { id: 'market.grants.admin-read', target: m, surface: 'market', method: 'GET', path: '/api/grants', headers: REMOTE_ANON, status: 401 },
      // L19：授予的放行经写请求总门放行、路由内认人，远程匿名来必须 401（能不能放行再由三档规则判）
      // 经验库：远程匿名列不出条目（路由自己认人，登录门开着时登录门先拦，都是 401）
      { id: 'market.knowledge.anonymous-read', target: m, surface: 'market', method: 'GET', path: '/api/knowledge', headers: REMOTE_ANON, status: 401 },
      // 经验库的「项目 → 部门」对照经写请求总门放行、路由内认人：远程匿名来改必须 401（能不能改再按拍板类问判定）
      { id: 'market.knowledge.project-depts-anonymous-write', target: m, surface: 'market', method: 'PUT', path: '/api/knowledge/project-depts', body: '{"project":"wm-self-probe","department":null}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.grants.approve-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/grants/1/approve', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 团队的改派经写请求总门放行、路由内认人，远程匿名来必须 401（能不能改派再由团队负责人的判法判）。键的写法要合法，否则先回 400
      { id: 'market.teams.reassign-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/teams/reassign', body: '{"host":"00000000","team":"","seat":"selfprobe/00000000","principal":"user:selfprobe"}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 台数据：远程匿名不带台令牌读不到任何台的数据（守卫先于查台，台不存在也是 403；登录门开着时登录门先拦 401）。
      // WM_APP_DATA_READ=warn 是上线过渡，读照旧放行，这一行不跑
      ...(appDataRead === 'warn' ? [] : [{ id: 'market.app-data.anonymous-read', target: m, surface: 'market' as const, method: 'GET', path: '/api/apps/wm-self-probe/data', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 }]),
      // 工作台变量：判权在查台之前。远程匿名读一个不存在的台（号是编出来的）也必须 403，和存在的台同一句——回 404 就是先查了台、透露了台在不在
      // （登录门开着时登录门先拦 401）
      { id: 'market.workbench-vars.anonymous-read-missing', target: m, surface: 'market', method: 'GET', path: '/api/workbenches/999999999999/vars', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 写 run：远程匿名不带 run 的写凭据，按 run 号保存一步必须被拒（守卫先于查 run，run 不存在也是 403；登录门开着时登录门先拦 401）。
      // 不碰任何真实的 run：号是编出来的。WM_SOP_RUN_WRITE=warn 是上线过渡，这一行不跑
      ...(sopRunWrite === 'warn' ? [] : [{ id: 'market.sop-run.anonymous-write', target: m, surface: 'market' as const, method: 'PUT', path: '/api/sop/runs/999999999', body: '{"stepKey":"wm-self-probe","value":null}', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 }]),
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
    // 对外断开（WM_OUTBOUND=off）时加一行：真的去连一个不可路由的地址，确认在连之前就被闸拦下。不过就拒绝启动
    if (outbound) {
      const g = await outbound();
      const row: Row = { id: 'market.outbound.disconnected', surface: 'market', method: 'CONNECT', path: '192.0.2.1:9', verdict: g.ok ? 'pass' : 'fail', status: null, reason: g.ok ? 'outbound-off' : g.reason };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    state = { passed: state.rows.every(r => r.verdict !== 'fail'), failed: state.rows.filter(r => r.verdict === 'fail').map(r => r.id), at: new Date().toISOString(), rows: state.rows };
    return snapshot();
  }
  return { middleware, snapshot, run(options: Options) {
    return running ??= execute(options);
  } };
}
