import type { Request, Response, RequestHandler } from 'express';
import type { HttpService } from '../http.ts';
import { capabilityDenied } from '../capabilities.ts';

type Session = { id: number; name: string; grants: string[] };
export function registerCapabilityRoutes<S extends Session>(app: HttpService, deps: {
  wrap: (handler: (req: Request, res: Response) => Promise<unknown>) => RequestHandler;
  mcpGatewaySession: (req: Request, res: Response) => S | null | undefined;
  mcpPublicOrigin: (req: Request) => string;
  invokeCapability: (session: S, target: unknown, args: unknown, channel: 'rest', origin: string) => Promise<unknown>;
}) {
  app.post('/api/mcp-rest/capabilities/:target', {
    action: 'mcp-rest.capability-call', kind: 'write', statusNotVerdict: '按会话责任人和指定领域能力判定',
  }, deps.wrap(async (req, res) => {
    const session = deps.mcpGatewaySession(req, res);
    if (session === undefined) return;
    if (session === null) capabilityDenied();
    res.setHeader('Cache-Control', 'no-store');
    res.json(await deps.invokeCapability(session, req.params.target, req.body === undefined ? {} : req.body, 'rest', deps.mcpPublicOrigin(req)));
  }));
}
