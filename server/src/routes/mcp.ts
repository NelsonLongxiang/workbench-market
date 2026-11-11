/**
 * MCP 网关控制面的路由：/api/mcp 的上游（读、整体替换）、会话（建、列、吊销）、会话授权、工具目录、调用记录、
 * 权限申请（列表、批准、驳回）。原样搬自 index.ts，一个字没改，只多了两格缩进。都只给管理员。
 * 它们在 index.ts 里分成十一段，中间夹着网关的常量、开关的启动检查和辅助函数（上游聚合、会话认定、授权校验、
 * 权限申请的工具，/mcp 和 /api/mcp-rest 也用，留在 index.ts），没有别的路由或中间件；按原来的顺序放进注册函数，
 * 在原来最后一段（驳回）的位置调用，11 条路由彼此的先后、和别的路由的先后都不变。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的代码也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import { randomBytes } from 'node:crypto';
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { McpService } from '../services/mcp.ts';
import type { SettingService } from '../services/setting.ts';
import { HttpError } from '../errors.ts';
import { closeYglUpstreams, yglHomeProblem } from '../mcp-stdio-upstream.ts';
import type { McpToolDef } from '../mcp-tools.ts';

/** 上游配置（和 index.ts 里的 McpUpstream 同形） */
type McpUpstream = { prefix: string; url: string; headers?: Record<string, string>; enabled?: boolean; toolCallTimeoutMs?: number; kind?: 'ygl-trees'; ygl_home?: string };
/** 权限申请的一行（和 index.ts 里的 AccessRequestRow 同形） */
type AccessRequestRow = { id: number; session_id: number; tools: string; reason: string; status: string; decided_by: string; decided_at: string; note: string; created_at: string };
type UpstreamHealth = { reachable: boolean; tools: number; last_error: string; last_ok_at: string; last_checked_at: string };

/** 从 index.ts 传进来的：管理员守卫、400 的快捷写法、指纹、网关的几条规则和常量、上游的状态与聚合、授权校验、分页、权限申请的辅助（/mcp、/api/mcp-rest 也用）。 */
export interface McpDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  bad: (msg: string) => never;
  sha256Hex: (s: string) => string;
  MCP_UPSTREAM_PREFIX_RE: RegExp;
  MCP_SESSION_NAME_RE: RegExp;
  MCP_SCOPED_TOOLS: ReadonlySet<string>;
  ACCESS_STATUSES: string[];
  ACCESS_REASON_MAX: number;
  upstreamHealth: Map<string, UpstreamHealth>;
  upstreamToolCache: Map<string, { at: number; tools: McpToolDef[] }>;
  mcpUpstreams: () => McpUpstream[];
  mcpAggregatedTools: () => Promise<McpToolDef[]>;
  mcpRegisteredNames: () => Promise<Set<string>>;
  resolveGrants: (raw: unknown[], held: string[], registered: Set<string>) => { saved: string[]; dropped: string[]; keptUnavailable: string[] };
  pageLimit: (v: unknown, def?: number, max?: number) => number;
  parseToolList: (raw: string) => string[];
  adminActor: (req: express.Request) => string;
  accessRequestId: (req: express.Request) => number;
}

export function registerMcpRoutes(app: HttpService, deps: McpDeps): void {
  const { adminGuard, bad, sha256Hex, MCP_UPSTREAM_PREFIX_RE, MCP_SESSION_NAME_RE, MCP_SCOPED_TOOLS, ACCESS_STATUSES, ACCESS_REASON_MAX, upstreamHealth, upstreamToolCache, mcpUpstreams, mcpAggregatedTools, mcpRegisteredNames, resolveGrants, pageLimit, parseToolList, adminActor, accessRequestId } = deps;
  app.get('/api/mcp/upstreams', { action: 'mcp.upstreams', kind: 'admin' }, (req, res, next) => {
    if (!adminGuard(req, res)) return;
    // 先走一遍聚合（有缓存时不打上游），让每个上游都带上可达状态
    void mcpAggregatedTools().then(() => {
      res.json(mcpUpstreams().map((u) => {
        const h = upstreamHealth.get(u.prefix);
        return { prefix: u.prefix, kind: u.kind ?? 'http', url: u.url ?? '', ygl_home: u.ygl_home, enabled: u.enabled !== false, headers: Object.keys(u.headers ?? {}), toolCallTimeoutMs: u.toolCallTimeoutMs ?? 15000,
          reachable: h ? h.reachable : null, tools: h?.tools ?? 0, last_error: h?.last_error ?? '', last_ok_at: h?.last_ok_at ?? '', last_checked_at: h?.last_checked_at ?? '' };
      }));
    }).catch(next);
  });

  app.put('/api/mcp/upstreams', { action: 'mcp.upstreams-update', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const arr = req.body?.upstreams;
    if (!Array.isArray(arr)) bad('upstreams 必须是数组（整体替换语义）');
    const clean: McpUpstream[] = [];
    for (const u of arr) {
      if (!u || typeof u.prefix !== 'string' || !MCP_UPSTREAM_PREFIX_RE.test(u.prefix)) bad(`prefix 规范：[a-z][a-z0-9]{0,15}——${JSON.stringify(u?.prefix)}`);
      if (clean.some((x) => x.prefix === u.prefix)) bad(`上游前缀重复：${u.prefix}`);
      if (u.kind !== undefined && u.kind !== 'ygl-trees') bad(`上游 ${u.prefix} 的 kind 只能是 ygl-trees 或不写`);
      if (u.kind === 'ygl-trees') {
        // 只认服务端自己解析的 ygl-trees 入口，配置里不能写命令、参数或环境变量
        if (u.url !== undefined || u.headers !== undefined || u.command !== undefined || u.args !== undefined || u.env !== undefined) bad(`上游 ${u.prefix}（ygl-trees）只接受 prefix、ygl_home、enabled、toolCallTimeoutMs`);
        const why = yglHomeProblem(u.ygl_home);
        if (why) bad(`上游 ${u.prefix}：${why}`);
        clean.push({ prefix: u.prefix, kind: 'ygl-trees', ygl_home: u.ygl_home, url: '', enabled: u.enabled !== false, toolCallTimeoutMs: Number(u.toolCallTimeoutMs) || 30000 });
        continue;
      }
      if (typeof u.url !== 'string' || !/^https?:\/\//.test(u.url)) bad(`上游 ${u.prefix} 的 url 必须是 http(s)://`);
      if (u.headers !== undefined && (typeof u.headers !== 'object' || u.headers === null || Object.values(u.headers).some((v) => typeof v !== 'string'))) bad(`上游 ${u.prefix} 的 headers 必须是字符串映射`);
      clean.push({ prefix: u.prefix, url: u.url, headers: u.headers ?? {}, enabled: u.enabled !== false, toolCallTimeoutMs: Number(u.toolCallTimeoutMs) || 15000 });
    }
    svc<SettingService>('setting').upsertStmt().run('mcp_upstreams', JSON.stringify(clean));
    upstreamToolCache.clear();
    closeYglUpstreams();
    res.json({ ok: true, upstreams: clean.map((u) => ({ prefix: u.prefix, kind: u.kind ?? 'http', url: u.url, ygl_home: u.ygl_home, enabled: u.enabled !== false })) });
  });

  // 控制面（全部 X-Admin-Token 常量时间 + Origin 空或同源；MCP 零会话/令牌/授权写工具——人工锁）
  app.post('/api/mcp/sessions', { action: 'mcp.session-create', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().toLowerCase() : '';
    if (!MCP_SESSION_NAME_RE.test(name)) bad('name 规范：小写字母开头，小写字母/数字/连字符，≤64 字符');
    const dup = svc<McpService>('mcp').sessionByName(name);
    if (dup) bad(`会话名已存在: ${name}`);
    // mcp/ 命名空间独立于 dsh/<id8>（A2A 自报身份不混用；关联靠人登记 a2a_node 字段，仅关联不授权）
    const token = randomBytes(32).toString('hex');
    const r = svc<McpService>('mcp').sessionCreateStmt()
      .run(name, sha256Hex(token), '[]') as unknown as { lastInsertRowid: number | bigint }; // 新会话授权空=默认拒绝
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), name, token, grants: [], note: 'token 仅此一次出现——库存 sha256 无取回接口，请立即分发保管' });
  });

  app.get('/api/mcp/sessions', { action: 'mcp.sessions', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const rows = svc<McpService>('mcp').sessions();
    res.json(rows.map((r: any) => ({ ...r, grants: JSON.parse(r.grants || '[]') })));
  });

  app.delete('/api/mcp/sessions/:id', { action: 'mcp.session-revoke', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    const hit = svc<McpService>('mcp').sessionById(id);
    if (!hit) throw new HttpError(404, `session not found: ${id}`);
    svc<McpService>('mcp').sessionRevoke(id); // 软吊销立即生效留审计
    res.json({ ok: true, revoked: id });
  });

  app.put('/api/mcp/sessions/:id/grants', { action: 'mcp.grants-update', kind: 'admin' }, (req, res, next) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    const sess = svc<McpService>('mcp').sessionById(id);
    if (!sess) throw new HttpError(404, `session not found: ${id}`);
    const raw = req.body?.grants;
    if (!Array.isArray(raw)) bad('grants 必须是工具名数组（整体替换语义）');
    // 注册表 = 本地工具 + 上游聚合工具（P2：taste__rules 等也可授权）
    // #379：会话已持有、但当前注册表里没有的名字不再让整次保存 400——
    //   所属上游已配置但暂不可达 → 保留（上游恢复后照常生效，不被无声挤掉）；其余（工具已下线/改名）→ 剔除并在 dropped 里列明。
    //   新加的未知名字仍然 400（防拼写错误）。
    let held: string[] = [];
    try { held = JSON.parse(String((sess as { grants?: string }).grants || '[]')); } catch { held = []; }
    void mcpRegisteredNames().then((registered) => {
      try {
        const { saved, dropped, keptUnavailable } = resolveGrants(raw, held, registered);
        svc<McpService>('mcp').sessionGrants(id, JSON.stringify(saved));
        res.json({ ok: true, id, grants: saved, dropped, kept_unavailable: keptUnavailable });
      } catch (e) {
        next(e);
      }
    }).catch(next);
  });

  app.get('/api/mcp/tools', { action: 'mcp.tools', kind: 'admin' }, (req, res, next) => {
    if (!adminGuard(req, res)) return;
    // 本地 + 上游聚合面（上游不可达时只列本地，不报错）
    void mcpAggregatedTools()
      .then((tools) => res.json(tools.map((t) => ({ name: t.name, description: t.description, category: t.category, ...(MCP_SCOPED_TOOLS.has(t.name) ? { scopable: true } : {}), ...(t.exempt ? { always_allowed: true } : {}) }))))
      .catch(next);
  });

  app.get('/api/mcp/calls', { action: 'mcp.calls', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = svc<McpService>('mcp').calls(limit);
    res.json(rows);
  });

  app.get('/api/mcp/access-requests', { action: 'mcp.access-requests', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && !ACCESS_STATUSES.includes(status)) bad('status 只能是 pending / approved / rejected');
    const limit = pageLimit(req.query.limit, 200, 1000);
    const rows = svc<McpService>('mcp').accessRequests(status, limit) as (AccessRequestRow & { session_name: string | null; session_revoked_at: string | null })[];
    res.json(rows.map((r) => ({ ...r, tools: parseToolList(r.tools), session_revoked: !!r.session_revoked_at || r.session_name === null })));
  });

  // 批准 = 申请的工具并入会话 grants（并集）+ 改申请状态 + 审计行，同一事务；已吊销会话不能批
  app.post('/api/mcp/access-requests/:id/approve', { action: 'mcp.access-approve', kind: 'decide' }, (req, res, next) => {
    if (!adminGuard(req, res)) return;
    const id = accessRequestId(req);
    const note = String(req.body?.note ?? '').trim().slice(0, ACCESS_REASON_MAX);
    const actor = adminActor(req);
    void mcpRegisteredNames().then((registered) => {
      const mcp = svc<McpService>('mcp');
      mcp.accessTxBegin();
      try {
        const r = mcp.accessRequestById(id) as AccessRequestRow | undefined;
        if (!r) throw new HttpError(404, `access request not found: ${id}`);
        if (r.status !== 'pending') throw new HttpError(409, `申请已处理（${r.status}），不能再批准`);
        const sess = mcp.sessionFull(r.session_id) as { id: number; name: string; grants: string; revoked_at: string } | undefined;
        if (!sess || sess.revoked_at) throw new HttpError(409, '会话已吊销，不能批准（可驳回）');
        const tools = parseToolList(r.tools);
        const before = parseToolList(sess.grants);
        // 与 PUT grants 同一口径（resolveGrants）：申请的工具当作「已持有」参与判定——上游暂不可达的保留，已下线的剔除；
        // 申请的工具若被剔除就整单 409（不做部分批准），原有授权里已下线的名字顺带按同口径清掉
        const { saved: after, dropped, keptUnavailable } = resolveGrants([...before, ...tools], [...before, ...tools], registered);
        const gone = tools.filter((t) => dropped.includes(t));
        if (gone.length) throw new HttpError(409, `已不可用（工具已下线，或 工具@台 的台已删除）：${gone.join(', ')}（请驳回后让会话重新申请）`);
        const added = tools.filter((t) => !before.includes(t));
        mcp.sessionGrants(sess.id, JSON.stringify(after));
        mcp.accessRequestDecide(id, 'approved', actor, note);
        mcp.grantAuditInsert(sess.id, id, 'access_request_approve', actor, JSON.stringify(before), JSON.stringify(after), note);
        mcp.accessTxCommit();
        res.json({ ok: true, id, status: 'approved', session: sess.name, added, grants: after, dropped, kept_unavailable: keptUnavailable });
      } catch (e) {
        mcp.accessTxRollback();
        next(e);
      }
    }).catch(next);
  });

  app.post('/api/mcp/access-requests/:id/reject', { action: 'mcp.access-reject', kind: 'decide' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = accessRequestId(req);
    const note = String(req.body?.note ?? '').trim().slice(0, ACCESS_REASON_MAX);
    const actor = adminActor(req);
    const mcp = svc<McpService>('mcp');
    mcp.accessTxBegin();
    try {
      const r = mcp.accessRequestById(id) as AccessRequestRow | undefined;
      if (!r) throw new HttpError(404, `access request not found: ${id}`);
      if (r.status !== 'pending') throw new HttpError(409, `申请已处理（${r.status}），不能再驳回`);
      const sess = mcp.sessionFull(r.session_id) as { grants: string } | undefined;
      const grants = sess?.grants || '[]';
      mcp.accessRequestDecide(id, 'rejected', actor, note);
      mcp.grantAuditInsert(r.session_id, id, 'access_request_reject', actor, grants, grants, note); // 驳回不动 grants
      mcp.accessTxCommit();
    } catch (e) {
      mcp.accessTxRollback();
      throw e;
    }
    res.json({ ok: true, id, status: 'rejected' });
  });
}
