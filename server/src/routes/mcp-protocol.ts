/**
 * MCP 协议入口 /mcp（无状态 StreamableHTTP）：POST 收 JSON-RPC（initialize、ping、tools/list、tools/call），GET、DELETE 回 405。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。三条在 index.ts 里连在一起，在原来的位置注册。
 * 会话认定、审计、工具聚合与授权、工具执行都留在 index.ts（MCP 内嵌的 REST 也用），经参数传进来。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { HttpError } from '../errors.ts';

type McpSess = { id: number; name: string; grants: string[] };
type McpChannel = 'mcp' | 'rest';

/** 从 index.ts 传进来的：会话认定与审计、REST 入口、公开地址、协议版本、工具聚合与授权、工具执行。 */
export interface McpProtocolDeps {
  mcpGatewaySession: (req: express.Request, res: express.Response) => McpSess | null | undefined;
  mcpAudit: (sess: McpSess | null, channel: McpChannel, method: string, tool: string, ok: boolean, error: string, durationMs: number, args: unknown) => void;
  mcpRestInfo: (origin: string) => Record<string, string>;
  mcpPublicOrigin: (req: express.Request) => string;
  MCP_KNOWN_PROTOCOLS: string[];
  MCP_PROTOCOL: string;
  mcpAggregatedTools: () => Promise<{ name: string; description: string; inputSchema: unknown }[]>;
  mcpToolGranted: (sess: McpSess | null, toolName: string) => boolean;
  mcpInvokeTool: (sess: McpSess | null, toolName: string, args: any, channel: McpChannel, origin: string, t0?: number) => Promise<any>;
}

export function registerMcpProtocolRoutes(app: HttpService, deps: McpProtocolDeps): void {
  const { mcpGatewaySession, mcpAudit, mcpRestInfo, mcpPublicOrigin, MCP_KNOWN_PROTOCOLS, MCP_PROTOCOL, mcpAggregatedTools, mcpToolGranted, mcpInvokeTool } = deps;
  // /mcp 网关化（MCP_GATEWAY=on）：Bearer 有效→会话；无效/缺失/吊销→401+WWW-Authenticate（含 initialize，无兼容期）
  app.post('/mcp', { action: 'mcp.rpc', kind: 'write', statusNotVerdict: 'MCP 会话令牌与工具授权由网关判，不是登录身份的结论' }, async (req, res) => {
    const msg = req.body ?? {};
    const fail = (code: number, message: string) => res.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });

    // 网关会话判定 + 审计
    const sess = mcpGatewaySession(req, res);
    if (sess === undefined) return;
    const audit = (method: string, tool: string, ok: boolean, error: string, durationMs: number, args: unknown) =>
      mcpAudit(sess, 'mcp', method, tool, ok, error, durationMs, args);
    const t0 = Date.now();

    if (typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      audit('invalid', '', false, 'Invalid Request', 0, msg);
      return fail(-32600, 'Invalid Request');
    }
    if (msg.id === undefined || msg.id === null) return res.status(202).end(); // notification（含 notifications/initialized）——stateless 无会话态需要跟踪
    try {
      if (msg.method === 'initialize') {
        const want = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
        audit('initialize', '', true, '', Date.now() - t0, msg.params);
        const rest = mcpRestInfo(mcpPublicOrigin(req));
        return res.json({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: MCP_KNOWN_PROTOCOLS.includes(want) ? want : MCP_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'workbench-market', version: '0.1.0', title: '工作台市场' },
            instructions: `缺工具先调 access_info。大文件上传下载与资源读取可用同一会话令牌走 REST：${rest.rest_base}（OpenAPI：${rest.openapi_url}）。上传成功的应答自带核对结果（integrity、sha256），不需要下载回读。`,
            ...rest,
          },
        });
      }
      if (msg.method === 'ping') {
        audit('ping', '', true, '', Date.now() - t0, null);
        return res.json({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
      if (msg.method === 'tools/list') {
        const all = await mcpAggregatedTools(); // 本地 + 上游（P2 聚合）
        // 按授权过滤；access_info / access_request 始终列出（缺权限时靠它们看目录、提申请）
        const tools = all.filter((t) => mcpToolGranted(sess, t.name))
          .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        audit('tools/list', '', true, '', Date.now() - t0, null);
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      }
      if (msg.method === 'tools/call') {
        if (typeof msg.params?.name !== 'string') {
          audit('tools/call', '', false, 'params.name 必填', Date.now() - t0, msg.params);
          return fail(-32602, 'params.name 必填');
        }
        // 未授权与不存在同应答——不泄露存在性
        const toolName = msg.params.name;
        const r = await mcpInvokeTool(sess, toolName, msg.params?.arguments, 'mcp', mcpPublicOrigin(req), t0);
        if (r.kind === 'not_granted') return fail(-32601, `Method not found: ${msg.method}`); // 与未知工具同文案族
        if (r.kind === 'ok') {
          // 上游结果已是 MCP 形状（{content,isError?}）→ 原样透传（下游客户端语义无损）；
          // 本地工具结果是业务对象 → 序列化为 text content。
          const out = r.out;
          if (r.upstream && out && typeof out === 'object' && Array.isArray((out as any).content)) {
            return res.json({ jsonrpc: '2.0', id: msg.id, result: out });
          }
          return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
        }
        // 工具执行失败按 MCP 规范走 isError（协议层错误才用 JSON-RPC error）
        // 带具名字段的错误（如数据契约 violations）把状态码与字段原样附在后面，agent 能逐条改
        const e = r.error;
        const detail = e instanceof HttpError && e.extra ? `\n${JSON.stringify({ status: e.status, ...e.extra })}` : '';
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `执行失败：${e?.message || e}${detail}` }], isError: true } });
      }
      audit(msg.method, '', false, 'Method not found', Date.now() - t0, msg.params);
      return fail(-32601, `Method not found: ${msg.method}`);
    } catch (e: any) {
      audit(msg.method, '', false, 'Internal error', Date.now() - t0, msg.params);
      return fail(-32603, `Internal error: ${e?.message || e}`);
    }
  });
  app.get('/mcp', { action: 'mcp.stream', kind: 'read' }, (_req, res) => res.status(405).json({ error: 'stateless StreamableHTTP：仅支持 POST（无服务端会话流）' }));
  app.delete('/mcp', { action: 'mcp.session-end', kind: 'write' }, (_req, res) => res.status(405).json({ error: '无会话可终止（stateless）' }));
}
