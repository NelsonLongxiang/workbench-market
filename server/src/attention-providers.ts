/**
 * 「关注」的七个提供方（阶段八 8c）。规格见产品化文档 02 附录 8c。
 *
 * 先都写在「关注」自己的这个文件里：只读地调用各来源现有的服务和查询函数，不改来源的文件
 * （阶段三还在搬这些域）。等阶段三做完，再把提供方挪回各域插件（另排）。
 *
 * 可见性：每个提供方用那个来源旧接口现在用的同一个守卫函数（注入进来，不重写判断）。
 * 旧守卫判不过时会自己回 403，这里给它一个不落地的应答对象，只取「过没过」。
 *
 *   来源              旧接口                                   守卫                          类别
 *   change-requests   GET /api/change-requests?status=pending  adminGuard（取数用 changeRequest 服务，和旧接口同一个函数）  审核
 *   mcp-access        GET /api/mcp/access-requests?status=pending adminGuard                 授权
 *   seat-asks         GET /api/workbench-events（决定是 ask 的）adminGuard                    提问
 *   tasks             GET /api/tasks（统一待办）                tasksReadAccess(adminHeaderOk) 审核
 *   owner-pending     GET /api/workbenches/:id/vars（看板台）  vars 接口的读门                提问
 *   principal-pending GET /api/principals/pending              主体路由的管理门               授权
 *   work-items        没有旧接口：验收 = ready（建立人、管理员）；过目 = held（管理员）  验收 / 过目
 *                     建立人只认事项上的建立人主体（isCreator，和建立人验收入口、事项页同一个函数）；建立人主体空着的只有管理员看得到
 */
import type express from 'express';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import { collectTasks } from './tasks.ts';
import { tasksReadAccess } from './tasks-read-access.ts';
import { listVars, workbenchScope } from './workbench-vars.ts';
import { principalsAdmin } from './routes/principals.ts';
import { buildBoard, findBoardWorkbench, parseConfig, BOARD_PATH, type BoardVar } from './owner-pending.ts';
import { openSeatAsks } from './services/attention-sources.ts';
import { withAnswers } from './attention-answers.ts';
import type { AttentionItem, AttentionProvider, AttentionService } from './services/attention.ts';
import type { ChangeRequestService } from './services/change-request.ts';
import type { McpService } from './services/mcp.ts';
import type { SopService } from './services/sop.ts';
import type { PrincipalService } from './services/principal.ts';
import type { WorkbenchService } from './services/workbench.ts';
import { isCreator, type WorkItemService } from './services/work-item.ts';

export type AttentionDeps = {
  /** index.ts 的管理门（变更申请、MCP 权限申请、工作台事件用的就是它） */
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** index.ts 的管理头判断（统一待办把它交给 tasksReadAccess） */
  adminHeaderOk: (req: express.Request) => boolean;
  /** vars 接口的读门（createWorkbenchVars 交出的 authorizeRead） */
  varsAuthorizeRead: (req: express.Request, res: express.Response, scope: ReturnType<typeof workbenchScope>) => Promise<unknown>;
};

/** 不落地的应答：旧守卫判不过时写的 403 写到这里，不进「关注」的应答 */
function silentRes(): express.Response {
  const res: Record<string, unknown> = { statusCode: 200, headersSent: false };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = (...a: unknown[]) => { if (m === 'status') res.statusCode = a[0]; return res; };
  return res as unknown as express.Response;
}
const passes = (guard: (req: express.Request, res: express.Response) => boolean, req: express.Request) => guard(req, silentRes());

const item = (x: Omit<AttentionItem, 'object' | 'phase' | 'answers'> & Partial<Pick<AttentionItem, 'object' | 'phase' | 'answers'>>): AttentionItem =>
  ({ answers: [], object: '', phase: '', ...x });

/** 统一待办里，别的提供方已经单独列出的那几类（按「来源:id」前缀剔掉，同一条不出现两次） */
export const TASKS_DEDUPED_PREFIXES = ['change-request:'] as const;

export function installAttentionProviders(attention: AttentionService, deps: AttentionDeps): Array<() => void> {
  const sop = () => svc<SopService>('sop');
  // 8d：答法和「看不到时怎么拒」挂在提供方上（attention-answers.ts），这里只多包一层
  const provide = (p: AttentionProvider<express.Request>) => attention.provide(withAnswers(p, deps));
  return [
    provide({
      source: 'change-requests', label: '变更申请',
      list: (req) => passes(deps.adminGuard, req)
        // 和旧接口 GET /api/change-requests?status=pending 同一个服务函数（阶段三已收进 changeRequest 服务）
        ? (svc<ChangeRequestService>('changeRequest').listByStatus('pending') as { id: number; kind: string; slug: string; op: string; reason: string; requested_by: string; created_at: string }[]).map((r) => item({
          source: 'change-requests', source_id: String(r.id), category: 'review',
          title: `${r.kind === 'skill' ? '技能' : '台'}${r.op === 'delete' ? '删除' : '回滚'} ${r.slug}${r.reason ? `（${String(r.reason).slice(0, 60)}）` : ''}`,
          waiting_for: r.requested_by, since: r.created_at, answers: ['approve', 'reject'], link: `/reviews?request=${r.id}`,
        }))
        : null,
    }),
    provide({
      source: 'mcp-access', label: 'MCP 权限申请',
      list: (req) => {
        if (!passes(deps.adminGuard, req)) return null;
        const rows = svc<McpService>('mcp').accessRequests('pending', 200) as { id: number; tools: string; reason: string; created_at: string; session_name: string | null }[];
        return rows.map((r) => item({
          source: 'mcp-access', source_id: String(r.id), category: 'grant',
          title: `MCP 会话 ${r.session_name ?? '（已删）'} 申请工具：${(() => { try { return (JSON.parse(r.tools) as string[]).join('、'); } catch { return r.tools; } })()}`,
          waiting_for: r.session_name ? `mcp:${r.session_name}` : '', since: r.created_at, answers: ['approve', 'reject'], link: `/mcp-gateways?access_request=${r.id}`,
        }));
      },
    }),
    provide({
      source: 'seat-asks', label: '席位的提问',
      // 旧接口 /api/workbench-events 在 ADMIN_IDENTITY_PATHS 里，会话登录的管理员在那里也算管理员
      list: (req) => passes(deps.adminGuard, req)
        ? openSeatAsks().map((a) => item({
          source: 'seat-asks', source_id: String(a.delivery_id), category: 'ask',
          title: `${a.target_team} 问：${a.question || '（没写问题）'}`,
          waiting_for: a.ask_kind === 'receipt' ? (a.asked_by || a.target_team) : a.asked_by ? `receiver:${a.asked_by}` : a.target_team, since: a.asked_at, answers: ['answer'],
          link: `/work-items/wi_${a.event_id}`,
        }))
        : null,
    }),
    provide({
      source: 'tasks', label: '任务中心收件（统一待办）',
      list: async (req) => {
        const access = await tasksReadAccess(deps.adminHeaderOk(req), String(req.headers.cookie ?? ''));
        if (!access.ok) return null;
        const payload = await collectTasks(sop() as never, access.scope);
        return payload.tasks
          .filter((t) => t.status !== 'done' && !TASKS_DEDUPED_PREFIXES.some((p) => t.id.startsWith(p)))
          .map((t) => item({
            source: 'tasks', source_id: t.id, category: 'review', title: t.title, waiting_for: t.source,
            since: '', answers: [], link: t.link ?? '/tasks', object: t.project ?? '', // 统一待办的信封没有「什么时候开始」
          }));
      },
    }),
    provide({
      source: 'owner-pending', label: '待属主看板',
      list: async (req) => {
        const list = (svc<WorkbenchService>('workbench').all() as { id: number; url: string }[]).map((w) => ({ id: w.id, url: w.url }));
        const found = findBoardWorkbench(list, `http://${String(req.headers.host ?? 'localhost')}`);
        // 先过读门，再看有没有看板台：没有看板台时也不对看不见的人说「没有」。看板台是外部台，读门只在按台令牌那一支用到台本身
        const scope = 'error' in found ? { id: 0, cls: 'external' as const, slug: null } : workbenchScope(found.id);
        if (!(await deps.varsAuthorizeRead(req, silentRes(), scope))) return null;
        if ('error' in found) return [];
        const vars = listVars(scope).items as BoardVar[];
        const config = parseConfig(vars.find((v) => v.key === 'config.owner'));
        if (!config || 'error' in config) return [];
        return buildBoard(vars, config).rows.filter((r) => r.status === 'open').map((r) => item({
          source: 'owner-pending', source_id: r.no, category: 'ask', title: r.question,
          waiting_for: r.source || r.waitingFor, since: r.firstRaised, answers: r.answerTakenBy ? [] : ['answer'], link: `${BOARD_PATH}#${r.no}`,
        }));
      },
    }),
    provide({
      source: 'principal-pending', label: '待对接清单',
      list: async (req) => {
        if (!principalsAdmin || !(await principalsAdmin(req, silentRes()))) return null;
        return svc<PrincipalService>('principals').pending().map((p) => item({
          source: 'principal-pending', source_id: `${p.provider}:${p.external_id}`, category: 'grant',
          title: `${p.display_name || p.external_id}（${p.provider}）等对接到主体`, waiting_for: `${p.provider}:${p.external_id}`,
          since: p.last_seen, answers: ['bind'], link: '/api/principals/pending',
        }));
      },
    }),
    provide({
      source: 'work-items', label: '事项的验收和过目',
      list: async (req) => {
        const items = svc<WorkItemService>('workItems');
        const admin = passes(deps.adminGuard, req);
        let mine: (w: { creator_principal: string | null }) => boolean = () => false;
        if (!admin) {
          const cookie = String(req.headers.cookie ?? '');
          if (!cookie) return null;
          const who = await identity().resolveViewer(cookie);
          if (!who.ok) return null;
          const sub = who.viewer.sub;
          mine = (w) => isCreator(w, sub);
        }
        const out: AttentionItem[] = [];
        for (const w of items.list({ state: 'ready' })) {
          if (!admin && !mine(w)) continue;
          out.push(item({ source: 'work-items', source_id: w.id, category: 'accept', title: w.title, waiting_for: w.target_team || w.seat || w.created_by, since: w.updated_at, answers: ['verify', 'return'], link: `/work-items/${w.id}`, object: w.object, phase: w.phase }));
        }
        if (admin) for (const w of items.list({ state: 'held' })) {
          out.push(item({ source: 'work-items', source_id: w.id, category: 'glance', title: w.title, waiting_for: w.created_by, since: w.created_at, answers: ['release', 'withdraw'], link: `/work-items/${w.id}`, object: w.object, phase: w.phase }));
        }
        return out;
      },
    }),
  ];
}
