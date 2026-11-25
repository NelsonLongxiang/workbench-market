/** #326: fixed anonymous loopback checks, with a closed ingress until all mandatory rows pass. */
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage, type Server } from 'node:http';
import type { RequestHandler } from 'express';
import { marketPublicOrigin } from './surfaces.ts';

const internalRequests = new WeakSet<IncomingMessage>();
export const isStartupProbeRequest = (req: IncomingMessage): boolean => internalRequests.has(req);
type Row = { id: string; surface: 'market' | 'control'; method: string; path: string; verdict: 'pass' | 'fail' | 'warn' | 'skip'; status: number | null; reason: string | null };
type State = { passed: boolean; failed: string[]; at: string | null; rows: Row[] };
type Target = { port: number; surface: 'market' | 'control' };
type Options = { market: Server; control?: Server; gatewayOn: boolean; nodeEnv?: string; loginGate?: 'enforce' | 'off'; appDataRead?: 'enforce' | 'warn'; sopRunWrite?: 'enforce' | 'warn'; benchViews?: boolean; portalForward?: () => { ok: boolean; reason: string | null }; portalSessionStrip?: () => { ok: boolean; reason: string | null }; outbound?: () => Promise<{ ok: boolean; reason: string | null }> ; sessionSeal?: () => { ok: boolean; reason: string | null }; sessionRenewal?: () => { ok: boolean; reason: string | null }; sessionLegacyTtl?: boolean; appendOnly?: () => { ok: boolean; reason: string | null; warn?: boolean } };
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

  async function execute({ market, control, gatewayOn, nodeEnv, loginGate = 'off', appDataRead = 'enforce', sopRunWrite = 'enforce', benchViews = false, portalForward, portalSessionStrip, outbound, sessionSeal, sessionRenewal, sessionLegacyTtl = false, appendOnly }: Options): Promise<State> {
    const [m, c] = await Promise.all([listener(market), listener(control)]);
    if (c) c.surface = 'control';
    const publicOrigin = marketPublicOrigin();
    const benchDecision = { target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views/wm-self-probe/mcp-requests/0', body: '{}' };
    const publicHeaders = publicOrigin ? { ...REMOTE_ANON, host: new URL(publicOrigin).host, 'sec-fetch-site': 'same-origin' } : null;
    const table = [
      { id: 'market.mcp.initialize', target: m, surface: 'market', method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}', status: 401, bearer: true, mcp: true },
      { id: 'market.mcp.tools-list', target: m, surface: 'market', method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', status: 401, mcp: true },
      // enforce: the login gate answers the anonymous browser first (401) before the admin write guard (403)
      { id: 'market.browser-workbench-write', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"","url":""}', origin: true, status: loginGate === 'enforce' ? 401 : 403 },
      { id: 'market.invalid-write-control', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"","url":""}', status: 400 },
      // Invalid policy is rejected before URL admission; both expected paths create no workbench.
      { id: 'market.workbench-access-validate', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"wm-self-probe","url":"http://wm-self-probe.invalid/","access":"wm-self-probe-invalid"}', status: 400 },
      { id: 'control.admin-read', target: c, surface: 'control', method: 'GET', path: '/api/mcp/sessions', status: 403 },
      // 主体管理面：远程匿名浏览器列不出主体。登录门关着时由路由自己的管理门拒（403），开着时登录门先拦（401）。
      // 不带任何凭据，所以这一行不会去问登录提供方，也不读主体表
      { id: 'market.principals.admin-read', target: m, surface: 'market', method: 'GET', path: '/api/principals', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 站内账号的管理面：远程匿名浏览器列不出账号（口径同主体管理面）
      { id: 'market.local-accounts.admin-read', target: m, surface: 'market', method: 'GET', path: '/api/local-accounts', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      { id: 'market.owner-personal-token.anonymous-issue', target: m, surface: 'market', method: 'POST', path: '/api/owner/personal-tokens', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 自己注册的核准（P3）：远程匿名浏览器核准不了任何账号（核准就是给对方开通站内访问）
      { id: 'market.local-accounts.approve-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/local-accounts/selfprobe/approve', body: '{}', origin: true, headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
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
      // 统一待办（GET /api/tasks，#324）：远程匿名必须 401、不带任何来源的任务信封，且不查私有源（登录门开着时登录门先拦，也是 401）
      { id: 'market.tasks.anonymous', target: m, surface: 'market', method: 'GET', path: '/api/tasks', headers: REMOTE_ANON, status: 401 },
      // 「安排一件事」（POST /api/work-items）：不经管理门，远程匿名来必须 401（登录门开着时登录门先拦，也是 401）
      { id: 'market.work-items.arrange-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 建立人回答席位提问的入口同样经写请求总门放行、路由内认人，远程匿名来必须 401
      { id: 'market.work-items.seat-ask-answer-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/asks/1/answer', body: '{"text":"selfprobe"}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 驾驶舱的写（不经写请求总门，路由自己判）：远程匿名改一个不存在的驾驶舱必须 401——认人在找驾驶舱之前，所以门坏了会回 404，也不会改到任何东西
      { id: 'market.cockpits.anonymous-write', target: m, surface: 'market', method: 'PUT', path: '/api/cockpits/999999999', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 「安排一件事」的附件上传、改截止日期：同样经写请求总门放行、路由内认人，远程匿名来必须 401
      { id: 'market.work-items.attachment-upload-anonymous', target: m, surface: 'market', method: 'PUT', path: '/api/work-items/attachments/selfprobe.txt', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.work-items.due-set-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/due', body: '{"due":null}', origin: true, headers: REMOTE_ANON, status: 401 },
      // #941 第 1a 步：改优先级没登录 401（优先级以后决定机器判定能不能直接当验收结论）
      { id: 'market.work-items.priority-set-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/work-items/wi_selfprobe/priority', body: '{"priority":"P3"}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.export.reveal-anonymous', target: m, surface: 'market', method: 'GET', path: '/api/export?reveal=1', headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 领域（docs/domains-step1.md）：远程匿名建不了领域、定不了规范（写请求总门先拦；登录门开着时登录门先拦 401），也列不出领域（路由自己认人，401）
      { id: 'market.areas.anonymous-create', target: m, surface: 'market', method: 'POST', path: '/api/areas', body: '{"id":"wm-self-probe","name":"x"}', origin: true, headers: REMOTE_ANON, status: loginGate === 'enforce' ? 401 : 403 },
      // 定规范经写请求总门放行、路由内认人（持 area-spec 的人多半不是管理员）：远程匿名来必须 401
      { id: 'market.areas.anonymous-spec-set', target: m, surface: 'market', method: 'POST', path: '/api/areas/wm-self-probe/specs', body: '{"body":"x"}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.areas.anonymous-read', target: m, surface: 'market', method: 'GET', path: '/api/areas', headers: REMOTE_ANON, status: 401 },
      { id: 'market.area-access.anonymous-approve', target: m, surface: 'market', method: 'POST', path: '/api/areas/wm-self-probe/access-requests/1/approve', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      ...(publicOrigin?.startsWith('https://') && publicHeaders ? [
        { id: 'market.relations.public-origin-approve-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/relations/proposals/1/approve', body: '{}', headers: { ...publicHeaders, origin: publicOrigin }, status: 401 },
        { id: 'market.report-dimensions.public-origin-activate-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/report-dimensions/wm-self-probe/activate', body: '{}', headers: { ...publicHeaders, origin: publicOrigin }, status: 401 },
        { id: 'market.areas.public-origin-activate-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/areas/wm-self-probe/specs/activate', body: '{}', headers: { ...publicHeaders, origin: publicOrigin }, status: 401 },
        { id: 'market.area-access.public-origin-approve-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/areas/wm-self-probe/access-requests/1/approve', body: '{}', headers: { ...publicHeaders, origin: publicOrigin }, status: 401 },
        ...(benchViews ? [{ id: 'market.report-governance.public-origin-confirm-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/report-governance/inbox/p-1/confirm', body: '{}', headers: { ...publicHeaders, origin: publicOrigin }, status: 401 }] : []),
      ] : []),
      { id: 'market.mcp-responsibility.anonymous-confirm', target: m, surface: 'market', method: 'POST', path: '/api/mcp/responsibilities/1/confirm', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      // 报告维度（docs/report-step1.md 第四节）：定报告维度经写请求总门放行、路由内认人（持 area-report 的人多半不是管理员），远程匿名来必须 401；
      // 建维度、发模板两条都看（认人在查维度之前，门坏了会回 400 或 404，也不会建出东西）；读也要先登录
      { id: 'market.report-dimensions.anonymous-create', target: m, surface: 'market', method: 'POST', path: '/api/report-dimensions', body: '{"id":"wm-self-probe","title":"x"}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.report-dimensions.anonymous-template-add', target: m, surface: 'market', method: 'POST', path: '/api/report-dimensions/wm-self-probe/templates', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
      { id: 'market.report-dimensions.anonymous-read', target: m, surface: 'market', method: 'GET', path: '/api/report-dimensions', headers: REMOTE_ANON, status: 401 },
      // 旧部门接口停写（docs/domains-step1.md 第六节）：本机命令行（属主，鉴权最宽的那一档）删一个编出来的部门也必须 410。
      // 停写在查部门之前，所以门坏了会回 404（部门不在），不会改到任何东西
      { id: 'market.departments.write-closed', target: m, surface: 'market', method: 'DELETE', path: '/api/departments/wm-self-probe', status: 410 },
      // 数据视图的入口（WM_BENCH_VIEWS=on 才有这三行；关着时整组路由回 404，由 scripts/bench-views-entry-test.mjs 看）：
      // 远程匿名读不到台的清单、也登记不了台（登录门开不开都是 401：登录门先拦，或者路由自己认不出人）
      ...(benchViews && publicHeaders && publicOrigin ? [
        { ...benchDecision, id: 'market.bench-mcp.public-origin-anonymous', headers: { ...publicHeaders, origin: publicOrigin }, status: 401 },
        { ...benchDecision, id: 'market.bench-mcp.other-origin-anonymous', headers: { ...publicHeaders, origin: 'null' }, status: loginGate === 'enforce' ? 401 : 403 },
      ] : []),
      ...(benchViews ? [
        { id: 'market.bench-views.anonymous-read', target: m, surface: 'market' as const, method: 'GET', path: '/api/bench-views', headers: REMOTE_ANON, status: 401 },
        { id: 'market.bench-views.var-render-anonymous', target: m, surface: 'market' as const, method: 'GET', path: '/api/bench-views/wm-self-probe/render?var=wm-self-probe', headers: REMOTE_ANON, status: 401 },
        { id: 'market.bench-views.table-export-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views/wm-self-probe/table/export', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
        // 图片代取以报告作来源（docs/image-step1.md 用例 8，PR C）：远程匿名带 report= 也认不出人，401，不判报告、不外发
        { id: 'market.bench-views.report-image-anonymous', target: m, surface: 'market' as const, method: 'GET', path: '/api/bench-views/wm-self-probe/image?u=photos%2Fwm-self-probe.png&report=1', headers: REMOTE_ANON, status: 401 },
        { id: 'market.bench-views.table-row-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views/wm-self-probe/table/row', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
        // 报告（docs/report-step1.md，报告第 1 步 PR B）：远程匿名生成不了报告（路由自己认不出人，401）
        { id: 'market.bench-views.report-generate-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views/wm-self-probe/reports', body: '{}', origin: true, headers: REMOTE_ANON, status: 401 },
        { id: 'market.bench-views.anonymous-write', target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views', body: '{"slug":"wm-self-probe","title":"x"}', headers: REMOTE_ANON, status: 401 },
        { id: 'market.bench-views.anonymous-stop-report', target: m, surface: 'market' as const, method: 'POST', path: '/api/bench-views/wm-self-probe/reports/probe/binding/stop', body: '{}', headers: REMOTE_ANON, status: 401 },
        { id: 'market.report-governance.anonymous-confirm', target: m, surface: 'market' as const, method: 'POST', path: '/api/report-governance/inbox/p-1/confirm', body: '{}', headers: REMOTE_ANON, status: 401 },
        { id: 'market.report-governance.anonymous-dimension-propose', target: m, surface: 'market' as const, method: 'POST', path: '/api/report-governance/proposals', body: '{"op":"dimension-create","args":{"area":"probe","id":"probe","title":"probe"},"idempotency_key":"probe"}', headers: REMOTE_ANON, status: 403 },
        { id: 'market.report-governance.anonymous-template-publish', target: m, surface: 'market' as const, method: 'POST', path: '/api/report-governance/proposals', body: '{"op":"template-publish","args":{"dimension":"probe"},"idempotency_key":"probe"}', headers: REMOTE_ANON, status: 403 },
        { id: 'market.report-governance.anonymous-dimension-activate', target: m, surface: 'market' as const, method: 'POST', path: '/api/report-governance/proposals', body: '{"op":"dimension-activate","args":{"dimension":"probe","version":1,"body_sha256":"0000000000000000000000000000000000000000000000000000000000000000","criteria_sha256":"0000000000000000000000000000000000000000000000000000000000000000","expected_active_version":null,"review_version":1},"idempotency_key":"probe"}', headers: REMOTE_ANON, status: 403 },
        { id: 'market.report-governance.anonymous-open-review-invite', target: m, surface: 'market' as const, method: 'GET', path: '/api/report-governance/review-invites/i-1', headers: REMOTE_ANON, status: 401 },
      ] : []),
      // 授予管理面：远程匿名列不出授予（GET 不经写请求总门，拒的是路由自己的管理门；登录门开着时登录门先拦 401）
      // L19：授予的读对登录的人放开（只看自己能放行的），远程匿名仍然读不到（没登录 401）
      { id: 'market.grants.admin-read', target: m, surface: 'market', method: 'GET', path: '/api/grants', headers: REMOTE_ANON, status: 401 },
      // L19：授予的放行经写请求总门放行、路由内认人，远程匿名来必须 401（能不能放行再由三档规则判）
      // 经验库：远程匿名列不出条目（路由自己认人，登录门开着时登录门先拦，都是 401）
      { id: 'market.knowledge.anonymous-read', target: m, surface: 'market', method: 'GET', path: '/api/knowledge', headers: REMOTE_ANON, status: 401 },
      // 记成经验经写请求总门放行、路由内认人：远程匿名来记必须 401
      { id: 'market.knowledge.remember-anonymous', target: m, surface: 'market', method: 'POST', path: '/api/knowledge/remember', body: '{"source":"work-items","source_id":"wi_selfprobe","lesson":"x"}', origin: true, headers: REMOTE_ANON, status: 401 },
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
      // 席位换令牌：签名是编出来的（形状合格、时间戳早已过期、节点不在名册）——必须 401、换不出令牌。登录门开不开都一样（路由本来就放行）
      // 上传票的直传（PUT /api/mcp-rest/uploads/<票>）不认会话令牌，票本身就是凭据：编出来的票（形状合格、仓库里没有）必须 404、什么都不写。
      // 登录门开不开都一样（/api/mcp-rest/ 本来就放行）；门坏了会回 201 或 400（按 size 核字节）
      // 大结果的引用（GET /api/mcp-rest/results/<编号>）只给建它的会话：远程匿名拿一个编出来的编号来，必须 401、取不到任何东西。
      // 网关关着（本机开发）时没有会话可认，这一行不跑
      ...(gatewayOn ? [{ id: 'market.mcp-rest.result-ref-anonymous', target: m, surface: 'market' as const, method: 'GET', path: `/api/mcp-rest/results/${'A'.repeat(22)}`, headers: REMOTE_ANON, status: 401 }] : []),
      ...(gatewayOn && benchViews ? [{ id: 'market.bench-mcp.report-preflight-anonymous', target: m, surface: 'market' as const, method: 'POST', path: '/api/mcp-rest/tools/report_template_get', body: '{"bench":"wm-self-probe","dimension":"probe"}', headers: REMOTE_ANON, status: 401 }] : []),
      ...(gatewayOn ? [{ id: 'market.capability.anonymous-invoke', target: m, surface: 'market' as const, method: 'POST', path: '/api/mcp-rest/capabilities/probe.read', body: '{}', headers: REMOTE_ANON, status: 401 }] : []),
      { id: 'market.mcp-rest.ticket-upload-forged', target: m, surface: 'market', method: 'PUT', path: `/api/mcp-rest/uploads/${'A'.repeat(43)}`, body: '{}', headers: REMOTE_ANON, status: 404 },
      { id: 'market.a2a-seat-token.forged', target: m, surface: 'market', method: 'POST', path: '/api/a2a/seat-token', body: `{"v":1,"root":"https://wm-self-probe.invalid","host":"00000000","seat_id":"wm-self-probe","ts":1,"nonce":"wm-self-probe-nonce-0000","aud":"https://wm-self-probe.invalid","sig":"${'A'.repeat(86)}=="}`, headers: REMOTE_ANON, status: 401 },
      { id: 'market.login-flow.unsigned-event', target: m, surface: 'market', method: 'POST', path: '/login/feishu/events', body: '{"schema":"2.0"}', headers: REMOTE_ANON, status: 401 },
      // 团队的决策卡（观察者落地 T8）：/a2a/direct 上的这条分流不跟 WM_A2A_DIRECT_SIG 的 accept 走——不带签名的卡在任何配置下都必须 401、不落库。
      // 合成队名、合成卡；门坏了会回 200（收下）或落到原路的别的状态码
      { id: 'market.a2a-decision-card.unsigned', target: m, surface: 'market', method: 'POST', path: '/a2a/direct', body: JSON.stringify({ team: 'market/00000000', caller_session: 'wm-self-probe/00000000', message: '[A2A decision-card] v1\n{"event":"created","rev":1,"card":{}}' }), headers: REMOTE_ANON, status: 401 },
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
    // 门户转发前去掉市场自身的认证信息：拿编出来的请求头过一遍门户转发用的那份清单，市场的口令、令牌、会话 cookie 摘干净、台自己的留下才算过。不过就拒绝启动
    if (portalForward) {
      const g = portalForward();
      const row: Row = { id: 'market.portal.forward-strips-market-auth', surface: 'market', method: 'CHECK', path: '/go/*', verdict: g.ok ? 'pass' : 'fail', status: null, reason: g.ok ? null : g.reason };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    // 门户对任何上游都剥掉浏览器带来的 session_id（Odoo 会话）：合成的 Cookie 头，不碰任何台、账号、上游
    if (portalSessionStrip) {
      let ok = false;
      try { ok = portalSessionStrip().ok === true; } catch { /* fail closed, do not copy errors to health/audit */ }
      const row: Row = { id: 'market.portal.session-id-stripped', surface: 'market', method: 'CHECK', path: '/go/*', verdict: ok ? 'pass' : 'fail', status: null, reason: ok ? null : 'session-id-forwarded' };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    // 对外断开（WM_OUTBOUND=off）时加一行：真的去连一个不可路由的地址，确认在连之前就被闸拦下。不过就拒绝启动
    if (outbound) {
      const g = await outbound();
      const row: Row = { id: 'market.outbound.disconnected', surface: 'market', method: 'CONNECT', path: '192.0.2.1:9', verdict: g.ok ? 'pass' : 'fail', status: null, reason: g.ok ? 'outbound-off' : g.reason };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    // 由市场维持的登录会话存着身份来源的会话号（等同凭据）：加密能往返、密文里看不出原文、改过的解不开、密钥文件权限 600。不过就拒绝启动
    if (sessionSeal) {
      let g: { ok: boolean; reason: string | null };
      try { g = sessionSeal(); } catch { g = { ok: false, reason: 'error' }; }
      const row: Row = { id: 'market.login-session.upstream-sealed', surface: 'market', method: 'LOCAL', path: 'market_sessions.upstream_sealed', verdict: g.ok ? 'pass' : 'fail', status: null, reason: g.ok ? null : g.reason };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    // 一次登录持续保持：续期有界——满一天才续、不超过上限、注销和过期的续不回来（在回滚掉的事务里拨着时间核）。不过就拒绝启动
    if (sessionRenewal) {
      let g: { ok: boolean; reason: string | null };
      try { g = sessionRenewal(); } catch { g = { ok: false, reason: 'error' }; }
      const row: Row = { id: 'market.login-session.renewal-bounded', surface: 'market', method: 'LOCAL', path: 'market_sessions.expires_at', verdict: g.ok ? 'pass' : 'fail', status: null, reason: g.ok ? null : g.reason };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    // 只增表（留痕）在库这一层改不了：防改、防删、防覆盖的触发器都在，事件日志用同一个 id 覆盖被拒（回滚掉的保存点里核，不留痕）。不过就拒绝启动
    if (appendOnly) {
      let g: { ok: boolean; reason: string | null; warn?: boolean };
      try { g = appendOnly(); } catch { g = { ok: false, reason: 'error' }; }
      // 名单缺了、覆盖被接受了：不通过（拒绝启动）。试写那一步因为库忙、只读、盘满没做成：warn，照常启动（见 db.ts 的 appendOnlySelfCheck）
      const row: Row = { id: 'market.db.append-only-guarded', surface: 'market', method: 'LOCAL', path: 'db.append-only-triggers', verdict: !g.ok ? 'fail' : g.warn ? 'warn' : 'pass', status: null, reason: g.ok && !g.warn ? null : g.reason };
      state.rows.push(row);
      log({ source: 'self-probe', ...row });
    }
    // 只设了旧变量 WM_SESSION_TTL_MIN（两个新变量都没设）：会话按它当绝对上限、不续期——登录持久化没生效。记一行 warn，部署时一眼看得出 .env 里还留着旧变量
    if (sessionLegacyTtl) {
      const row: Row = { id: 'market.login-session.persistence', surface: 'market', method: 'LOCAL', path: 'WM_SESSION_TTL_MIN', verdict: 'warn', status: null, reason: 'persistence-off-legacy-ttl-min' };
      state.rows.push(row);
      log({ source: 'self-probe', ...row, message: '登录持久化未生效：只设了已弃用的 WM_SESSION_TTL_MIN，会话按它当绝对上限、不续期；改用 WM_SESSION_IDLE_DAYS / WM_SESSION_MAX_DAYS' });
    }
    state = { passed: state.rows.every(r => r.verdict !== 'fail'), failed: state.rows.filter(r => r.verdict === 'fail').map(r => r.id), at: new Date().toISOString(), rows: state.rows };
    return snapshot();
  }
  return { middleware, snapshot, run(options: Options) {
    return running ??= execute(options);
  } };
}
