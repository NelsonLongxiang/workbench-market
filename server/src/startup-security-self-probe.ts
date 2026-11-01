/** #326: fixed anonymous loopback checks, with a closed ingress until all mandatory rows pass. */
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage, type Server } from 'node:http';
import type { RequestHandler } from 'express';

const internalRequests = new WeakSet<IncomingMessage>();
export const isStartupProbeRequest = (req: IncomingMessage): boolean => internalRequests.has(req);
type Row = { id: string; surface: 'market' | 'control'; method: string; path: string; verdict: 'pass' | 'fail' | 'warn' | 'skip'; status: number | null; reason: string | null };
type State = { passed: boolean; failed: string[]; at: string | null; rows: Row[] };
type Target = { port: number; surface: 'market' | 'control' };
type Options = { market: Server; control?: Server; gatewayOn: boolean; nodeEnv?: string };

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
    if (req.method === 'GET' && req.path.toLowerCase() === '/api/health') {
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
      const timer = setTimeout(finish, timeoutMs);
      if (server.listening) return finish();
      server.once('listening', finish); server.once('error', finish);
    });
  }

  function send(target: Target, method: string, path: string, body?: string, origin = false): Promise<{ status: number | null; bearer: boolean; reason: string | null }> {
    return new Promise(resolve => {
      expected = { port: target.port, method, path };
      let settled = false;
      const finish = (result: { status: number | null; bearer: boolean; reason: string | null }) => {
        if (settled) return;
        settled = true; clearTimeout(timer); expected = undefined; resolve(result);
      };
      // All destinations and paths come from this module's closed table, never Host or an env URL.
      const req = request({ hostname: '127.0.0.1', port: target.port, method, path, agent: false,
        headers: { 'user-agent': 'workbench-market/self-probe', 'x-wm-self-probe': marker, 'x-internal-probe': '1',
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          ...(origin ? { origin: 'http://127.0.0.1:' + target.port } : {}) } }, res => {
        const bearer = /^Bearer(?:\s|$)/i.test(String(res.headers['www-authenticate'] ?? ''));
        finish({ status: res.statusCode ?? null, bearer, reason: null });
        res.destroy(); // status/header checks only; never collect potentially sensitive response bodies
      });
      const timer = setTimeout(() => { finish({ status: null, bearer: false, reason: 'timeout' }); req.destroy(); }, timeoutMs);
      req.once('error', () => finish({ status: null, bearer: false, reason: 'transport' }));
      req.end(body);
    });
  }

  async function execute({ market, control, gatewayOn, nodeEnv }: Options): Promise<State> {
    const [m, c] = await Promise.all([listener(market), listener(control)]);
    if (c) c.surface = 'control';
    const table = [
      { id: 'market.mcp.initialize', target: m, surface: 'market', method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}', status: 401, bearer: true, mcp: true },
      { id: 'market.mcp.tools-list', target: m, surface: 'market', method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', status: 401, mcp: true },
      { id: 'market.browser-workbench-write', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"","url":""}', origin: true, status: 403 },
      { id: 'market.invalid-write-control', target: m, surface: 'market', method: 'POST', path: '/api/workbenches', body: '{"name":"","url":""}', status: 400 },
      { id: 'control.admin-read', target: c, surface: 'control', method: 'GET', path: '/api/mcp/sessions', status: 403 },
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
        const result = await send(test.target, test.method, test.path, 'body' in test ? test.body : undefined, 'origin' in test && test.origin);
        row.status = result.status;
        const passed = result.status === test.status && (!('bearer' in test) || result.bearer);
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
