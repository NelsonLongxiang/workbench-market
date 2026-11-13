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
 *   sop-runs          POST /api/sop/runs/:id/finish（派进来的 run 验收）  完成接口里不靠上传令牌的那两条（管理员、本机命令行）  验收
 *   tasks             GET /api/tasks（统一待办）                tasksReadAccess(adminHeaderOk) 审核
 *   owner-pending     GET /api/workbenches/:id/vars（看板台）  vars 接口的读门                提问
 *   principal-pending GET /api/principals/pending              主体路由的管理门               授权
 *   work-items        没有旧接口：验收 = ready（看得到这件事项的人）；过目 = held（负责人；团队没有负责人时管理层代办）  验收 / 过目
 *   bench-mcp         GET /api/bench-views/<台>/mcp-grants（台上的 MCP 授予申请）  那组路由自己的门（benchMcpDecider：先拒管理口令，再按「拍板」问判定）  授权
 *   a2a-peers         GET /api/a2a/peers（对端名片的公钥变了、等确认的）adminGuard           授权
 *   team-health       GET /api/teams（待认领、不在名册里、没有负责人的团队；名册超过阈值没更新的节点） adminGuard  过目
 *   relation-proposals GET /api/relations/proposals（这个人能确认的关系提议，和确认接口同一处 confirmRefusal） 登录的人   授权
 *                     验收条目给看得到这件事项的人（itemRoles 的 canSee，和事项页同一个函数），mine 只对建立人为真
 */
import type express from 'express';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import { collectTasks } from './tasks.ts';
import { tasksReadAccess } from './tasks-read-access.ts';
import { listVars, workbenchScope } from './workbench-vars.ts';
import { principalsAdmin } from './routes/principals.ts';
import { sopRunAcceptance } from './routes/sop-run-lifecycle.ts';
import { buildBoard, findBoardWorkbench, parseConfig, BOARD_PATH, type BoardVar } from './owner-pending.ts';
import { openSeatAsks } from './services/attention-sources.ts';
import { benchMcpDecider, benchViewsConfig } from './routes/bench-views.ts';
import { pendingBenchRequests } from './services/bench-mcp.ts';

/** 提问回执带的选项，接在问题后面给人看（答复仍是自由文本） */
function optionsHint(json: string): string {
  try { const o = JSON.parse(json) as unknown; return Array.isArray(o) && o.length ? `（可选：${o.filter((x) => typeof x === 'string').join(' / ')}）` : ''; } catch { return ''; }
}
import { withAnswers } from './attention-answers.ts';
import { answerVia, type AttentionItem, type AttentionProvider, type AttentionService } from './services/attention.ts';
import type { ChangeRequestService } from './services/change-request.ts';
import type { McpService } from './services/mcp.ts';
import type { SopService } from './services/sop.ts';
import type { PrincipalService } from './services/principal.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { WorkItemService } from './services/work-item.ts';
import type { A2aPeerService } from './services/a2a-peers.ts';
import type { TeamService } from './services/team.ts';
import type { GrantService } from './services/grant.ts';
import type { RelationProposalService } from './services/relation-proposal.ts';
import { browserMarked, rawLoopback } from './surfaces.ts';
import { teamName } from './team-relation.ts';
import { canRelease, canSee, creatorOf, itemDecisionVerdict, requestViewer, stuckGoesTo, turnOf } from './work-item-access.ts';
import { pendingAsksOfEvent } from './services/attention-sources.ts';
import { eventOfItem } from './seat-messages.ts';

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

/** 「停太久」条目：一次最多给几条、从索引里最多扫几条候选 */
const STUCK_LIMIT = 50, STUCK_SCAN = 1000;
const STATE_TEXT: Record<string, string> = { delivered: '已转交', accepted: '已接单', progress: '在做', waiting: '在等', blocked: '卡住了' };

const item = (x: Omit<AttentionItem, 'object' | 'phase' | 'answers' | 'mine'> & Partial<Pick<AttentionItem, 'object' | 'phase' | 'answers' | 'mine'>>): AttentionItem =>
  ({ answers: [], object: '', phase: '', mine: true, ...x });


/** 统一待办条目是哪一类（只增的 kind 字段，前端据此不把它们放进「等你审核」）：它们不是审核，没有当场的答法 */
export const TASK_KINDS = ['task', 'sop-run', 'ygl', 'a2a', 'other'] as const;
function taskKind(t: { id: string; source: string }): (typeof TASK_KINDS)[number] {
  if (t.id.startsWith('market:task-')) return 'task';
  if (t.id.startsWith('market:run-')) return 'sop-run';
  if (t.source === 'ygl-trees') return 'ygl';
  if (t.source === 'a2a') return 'a2a';
  return 'other';
}

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
        ? (svc<ChangeRequestService>('changeRequest').listByStatus('pending') as { id: number; kind: string; slug: string; op: string; target_version: number | null; reason: string; requested_by: string; created_at: string }[]).map((r) => item({
          source: 'change-requests', source_id: String(r.id), category: 'review',
          title: `${r.kind === 'skill' ? '技能' : '台'}${r.op === 'delete' ? '删除' : '回滚'} ${r.slug}${r.reason ? `（${String(r.reason).slice(0, 60)}）` : ''}`,
          waiting_for: r.requested_by, since: r.created_at, answers: ['approve', 'reject'], link: '/market', // 审核页（/reviews）已退役（#664）：变更申请在卡片上答，要看台去市场
          detail: svc<ChangeRequestService>('changeRequest').detailOf(r),
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
    // 入口（WM_BENCH_VIEWS）关着时不登记这个来源：「关注」的应答里不出现它
    ...(benchViewsConfig().on ? [
    provide({
      // 数据视图：会话申请在某个台上用 MCP 工具。谁看得到、谁能批，和 /api/bench-views/<台>/mcp-requests/<编号> 是同一处判断：
      // 有「拍板」的人（现在是管理层）；系统管理员和管理口令看不到——台里是业务数据
      source: 'bench-mcp', label: '台的 MCP 授予申请',
      list: async (req) => {
        if (!benchMcpDecider) return null;
        // 管理层看得到全部；别的人只看得到自己有拍板授予的部门的台上的申请。一条都轮不到、又不是管理层的，整个来源不可见
        const all = await benchMcpDecider(req, silentRes(), null) !== null;
        const seen = new Map<string, boolean>();
        const rows: ReturnType<typeof pendingBenchRequests> = [];
        for (const r of pendingBenchRequests()) {
          if (!all && !seen.has(r.bench)) seen.set(r.bench, await benchMcpDecider(req, silentRes(), r.bench) !== null);
          if (all || seen.get(r.bench)) rows.push(r);
        }
        if (!all && !rows.length) return null;
        return rows.map((r) => item({
          source: 'bench-mcp', source_id: `${r.bench}:${r.id}`, category: 'grant', kind: 'bench-mcp',
          title: `MCP 会话 ${r.session || '（已删）'} 申请在「${r.bench_title}」上用 ${r.tools.length} 个工具${r.tools.some((t) => t.category === 'write') ? '（含写）' : '（只读）'}`,
          waiting_for: r.session ? `mcp:${r.session}` : '', since: new Date(r.created_at).toISOString(), answers: ['approve', 'reject'], link: '',
          detail: { session: r.session, bench: r.bench, bench_title: r.bench_title, tools: r.tools, reason: r.reason, created_at: r.created_at },
          // 能批的人（管理层）多半不是管理员，过不了答复入口前面的写请求总门：卡片照这个地址答，判断和答复入口转过去的是同一处
          answer_via: answerVia('POST', `/api/bench-views/${r.bench}/mcp-requests/${r.id}`, {
            approve: { body: { approve: true }, input: { note: { to: 'note', max: 500 } } },
            reject: { body: { approve: false }, input: { note: { to: 'note', required: true, max: 500 } } },
          }),
        }));
      },
    }),
    ] : []),
    provide({
      source: 'seat-asks', label: '席位的提问',
      // 看得到这件事项的人看得到它的提问（canSee）；答法只给 itemDecisionVerdict 认的人（建立人本人、持有管理层授予的人代办），
      // 和答复入口、详情的 can.answer 同一处。过了管理门而没有管理层授予的，看得到、答不了
      list: async (req) => {
        const admin = passes(deps.adminGuard, req);
        const viewer = await requestViewer(req, admin);
        if (!admin && !viewer.principal) return null;
        const items = svc<WorkItemService>('workItems');
        // 全库还没答的提问（不按最近多少个事件截断），超过上限时按提问先后取最早的、标 more。
        // 上限在可见性过滤之前：只看得到其中一部分的人，more 为真时列出来的会少于上限
        const { asks, more } = openSeatAsks();
        const list = asks.flatMap((a) => {
          const w = items.get(`wi_${a.event_id}`);
          if (!w || !canSee(w, viewer)) return [];
          return [item({
            source: 'seat-asks', source_id: String(a.delivery_id), category: 'ask',
            title: `${a.target_team} 问：${a.question || '（没写问题）'}${optionsHint(a.options)}`,
            waiting_for: a.ask_kind === 'receipt' ? (a.asked_by || a.target_team) : a.asked_by ? `receiver:${a.asked_by}` : a.target_team, since: a.asked_at,
            answers: itemDecisionVerdict(w, viewer, 'answer').ok ? ['answer'] : [],
            link: `/work-items/wi_${a.event_id}`,
            // 提问轮到的是建立人：代办的人（管理层）在这里 mine 为假
            mine: turnOf(w, viewer).answer, creator: creatorOf(w), cockpit_id: w.cockpit_id ?? null,
          })];
        });
        return more ? { items: list, total: list.length, more } : list;
      },
    }),
    provide({
      // 别的节点经 A2A 派进来、还在跑的 SOP run：验收通过就是完成它（和完成接口同一处判断）。旧的 SOP 交付空间页已弃用，在这里当场办。
      // 谁看得到、谁能办：不靠这个 run 的上传令牌就能写 run 的人（管理员、本机命令行），和完成接口同一处（sopRunAcceptance.allowed）
      source: 'sop-runs', label: '待验收的派单执行',
      list: async (req) => {
        if (!sopRunAcceptance || !(await sopRunAcceptance.allowed(req))) return null;
        const out: AttentionItem[] = [];
        for (const r of sop().runsDispatched() as { id: number; sop_slug: string; updated_at: string }[]) {
          const detail = await sopRunAcceptance.detail(r.id);
          const by = detail.dispatcher as { team: string; caller: string };
          out.push(item({
            source: 'sop-runs', source_id: String(r.id), category: 'accept', kind: 'sop-run',
            title: `${String(detail.sop_title || r.sop_slug)} 第 ${r.id} 次执行待验收`,
            waiting_for: by.caller || by.team || '', since: r.updated_at, answers: ['finish'],
            link: `/sops/${encodeURIComponent(r.sop_slug)}/runs/${r.id}`, object: r.sop_slug, detail,
          }));
        }
        return out;
      },
    }),
    provide({
      source: 'tasks', label: '任务中心收件（统一待办）',
      list: async (req) => {
        const access = await tasksReadAccess(deps.adminHeaderOk(req), String(req.headers.cookie ?? ''));
        if (!access.ok) return null;
        const payload = await collectTasks(sop() as never, access.scope);
        // 同一件事在「等你拍板」里只出现一次，以事项为准：任务中心的任务已经有对应事项的（安排的、旧录入路径发布的都算），
        // 统一待办那一条不再列。只在「关注」聚合这里剔，/api/tasks 本身不变
        const taskIdOf = (id: string) => { const m = /^market:task-([1-9]\d{0,15})$/.exec(id); return m ? Number(m[1]) : null; };
        const withItems = svc<WorkItemService>('workItems').taskIdsWithItems(payload.tasks.map((t) => taskIdOf(t.id)).filter((n): n is number => n !== null));
        // 待验收的派单 run：看得到「sop-runs」这个来源的人（能当场验收的），统一待办里的那一条不再列，以「sop-runs」为准
        const accept = sopRunAcceptance && await sopRunAcceptance.allowed(req)
          ? new Set((sop().runsDispatched() as { id: number }[]).map((r) => `market:run-${r.id}`)) : new Set<string>();
        return payload.tasks
          .filter((t) => t.status !== 'done' && !TASKS_DEDUPED_PREFIXES.some((p) => t.id.startsWith(p)))
          .filter((t) => { const n = taskIdOf(t.id); return n === null || !withItems.has(n); })
          .filter((t) => !accept.has(t.id))
          .map((t) => item({
            source: 'tasks', source_id: t.id, category: 'review', title: t.title, waiting_for: t.source,
            since: '', answers: [], link: t.link ?? null, object: t.project ?? '', // 统一待办的信封没有「什么时候开始」；统一待办页已退役（#664），没给链接的就不给
            kind: taskKind(t),
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
        const vars = (await listVars(scope)).items as BoardVar[];
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
        // 绑在非人主体上的：对接（bind）一定是 409，不给这个答法，标题里说清楚要先解绑那条外部身份
        return svc<PrincipalService>('principals').pending().map((p) => item({
          source: 'principal-pending', source_id: `${p.provider}:${p.external_id}`, category: 'grant',
          title: p.reason === 'bound-to-non-person'
            ? `${p.display_name || p.external_id}（${p.provider}）这个账号绑在非人主体（席位、节点）上，不能拿来登录；要让本人登录，先解绑那条外部身份`
            : `${p.display_name || p.external_id}（${p.provider}）等对接到主体`,
          waiting_for: `${p.provider}:${p.external_id}`,
          since: p.last_seen, answers: p.reason === 'bound-to-non-person' ? [] : ['bind'], link: null, // 没有对应的页面：这类条目在卡片上当场办（link 只放站内页面路径，不放接口地址）
        }));
      },
    }),
    provide({
      source: 'work-items', label: '事项的验收和过目',
      list: async (req) => {
        const items = svc<WorkItemService>('workItems');
        const admin = passes(deps.adminGuard, req);
        const viewer = await requestViewer(req, admin);
        if (!admin && !viewer.principal) return null;
        const out: AttentionItem[] = [];
        // 验收：看得到这件事项的人（itemRoles：建立人、成员的主人、负责人、管理层）都看得到这一条，mine 只对轮到的人（建立人）为真；
        // 负责人在「别人的事，你可以代办」里看到本团队的。今天的管理员迁移后是管理层，看到的和原来一样（全部）
        for (const w of items.list({ state: 'ready' })) {
          if (!canSee(w, viewer)) continue;
          // 答法只给答得了的人（itemDecisionVerdict，和答复入口、详情的 can 同一处）：建立人本人和持有管理层授予的人两种都有；
          // 负责人只有退回；看得到但答不了的（只过了管理门的）只列不给答法，免得点下去被拒
          const answers = itemDecisionVerdict(w, viewer, 'verify').ok ? ['verify', 'return'] : itemDecisionVerdict(w, viewer, 'return').ok ? ['return'] : [];
          out.push(item({ source: 'work-items', source_id: w.id, category: 'accept', title: w.title, waiting_for: w.target_team || w.seat || w.created_by, since: w.updated_at, answers, link: `/work-items/${w.id}`, object: w.object, phase: w.phase,
            mine: turnOf(w, viewer).verify, creator: creatorOf(w), cockpit_id: w.cockpit_id }));
        }
        // 过目（规范 14 第九节）：只给能放行的人——负责人、团队没有负责人时代办的管理层、勾了先过目的建立人（canRelease，和详情的 can.release 同一处）。
        // 放行带 answer_via 直接调 POST /api/work-items/:id/release：负责人多半不是管理员，过不了「关注」答复入口前面的写请求总门。
        // 撤回还是任务中心的管理员接口，只给过了管理门的人
        // 过了管理门、又放不了的（管理口令、没有管理层授予的管理员）：照旧列出来，只给撤回，不给放行
        for (const w of items.list({ state: 'held' })) {
          const release = canRelease(w, viewer);
          if (!release && !admin) continue;
          const answers = [...(release ? ['release'] : []), ...(admin ? ['withdraw'] : [])];
          out.push(item({ source: 'work-items', source_id: w.id, category: 'glance', title: w.title, waiting_for: w.created_by, since: w.created_at, answers, link: `/work-items/${w.id}`, object: w.object, phase: w.phase,
            mine: turnOf(w, viewer).release, creator: creatorOf(w), cockpit_id: w.cockpit_id, ...(release ? { answer_via: answerVia('POST', `/api/work-items/${w.id}/release`, { release: { body: {} } }) } : {}) }));
        }
        return out;
      },
    }),
    provide({
      // 停太久的事项（规范 14 第九节「卡住的冒给负责人，没有负责人冒给管理层」）：没有当场的答法，到事项页去催；不算进角标，汇总里单独数。
      // 一次最多给 STUCK_LIMIT 条（按停得最久的排），total 是这个人一共有几条；候选从 (state, updated_at) 索引里按停得最久取，最多 STUCK_SCAN 条
      // 已知的限度：停太久的候选全库超过 STUCK_SCAN 条时，只在停得最久的这些里数，total（和 stuck_count）会偏少。冒给谁要逐件判（负责人、管理层授予），
      // 一条计数 SQL 表达不了；到那个量级时另做按团队的计数
      source: 'work-items-stuck', label: '停太久的事项', stuck: true,
      list: async (req) => {
        const admin = passes(deps.adminGuard, req);
        const viewer = await requestViewer(req, admin);
        if (!viewer.principal && !viewer.management) return null;
        const items = svc<WorkItemService>('workItems');
        const hours = items.stuckThresholdHours();
        const now = Date.now();
        const mine = items.stuckCandidates(now, STUCK_SCAN).filter((w) => {
          const ev = eventOfItem(w);
          if (ev && pendingAsksOfEvent(ev).length > 0) return false; // 在等答复的提问另有席位提问条目
          return stuckGoesTo(w, viewer);
        });
        const stalled = (t: string) => Math.floor((now - Date.parse(t.replace(' ', 'T') + 'Z')) / 3_600_000);
        return {
          total: mine.length,
          items: mine.slice(0, STUCK_LIMIT).map((w) => item({
            source: 'work-items-stuck', source_id: w.id, category: 'glance',
            title: `${w.title}在「${STATE_TEXT[w.state] ?? w.state}」停了 ${stalled(w.updated_at)} 小时（超过 ${hours} 小时算停太久）`,
            waiting_for: w.seat || w.target_team, since: w.updated_at, link: `/work-items/${w.id}`, object: w.object, phase: w.phase,
            creator: creatorOf(w),
          })),
        };
      },
    }),
    provide({
      source: 'a2a-peers', label: '对端公钥待确认',
      // 对端名片上的公钥变了：不自动接受（钉住的还是旧公钥），等管理员对过指纹再确认。只有管理员看得到。投递、入站的拦截由阶段七接上 canDeliver 后生效，标题里不说已挂起
      list: (req) => passes(deps.adminGuard, req)
        ? svc<A2aPeerService>('a2aPeers').list({ status: 'key_changed' }).map((p) => item({
          source: 'a2a-peers', source_id: p.id, category: 'grant',
          title: `对端 ${p.root_url}（${p.zone || '未知域'}）的名片公钥变了：旧 ${p.key_fingerprint.slice(0, 19)}… → 新 ${p.pending_fingerprint.slice(0, 19)}…，核对指纹后确认`,
          waiting_for: p.root_url, since: p.updated_at, answers: [], link: `/a2a-peers?peer=${p.id}`,
        }))
        : null,
    }),
    provide({
      // 团队和名册的毛病：只有管理员看得到；没有当场的答法（认领、指定负责人在团队页做）。页面不显示节点标识，用节点名
      source: 'team-health', label: '团队与名册',
      list: (req) => {
        if (!passes(deps.adminGuard, req)) return null;
        const t = svc<TeamService>('teams');
        const what = { unclaimed: '待认领', 'off-roster': '不在节点名册里了', 'lead-vacant': '没有负责人' } as const;
        const teamsOut = t.needingAttention().map((x) => {
          const node = t.nodeInfo(x.host);
          return item({
            source: 'team-health', source_id: `team:${x.host}:${x.team}`, category: 'glance',
            title: `团队 ${teamName(x.team) || '（没有名字）'}${node.node_name ? `（来自 ${node.node_name}）` : ''}${what[x.status]}`,
            waiting_for: node.node_name ?? '', since: node.roster_received_at ?? '', link: '/team', object: x.team, phase: x.status,
          });
        });
        const stale = t.staleRosters().map((r) => item({
          source: 'team-health', source_id: `roster:${r.host}`, category: 'glance',
          title: `${r.node_name ? `节点 ${r.node_name}` : '一个节点'}的团队名册超过 ${t.rosterStaleMinutes()} 分钟没更新（最近一次收到：${r.roster_received_at}）`,
          waiting_for: r.node_name ?? '', since: r.roster_received_at, link: '/team', phase: 'roster-stale',
        }));
        return [...stale, ...teamsOut];
      },
    }),
    provide({
      // 关系的提议：只列这个人能确认的（和确认接口同一处 confirmRefusal）；确认在团队页、部门页经 /api/relations/proposals 做
      source: 'relation-proposals', label: '关系的提议',
      list: async (req) => {
        const cli = !browserMarked(req) && rawLoopback(req);
        let principal: string | null = null;
        const cookie = String(req.headers.cookie ?? '');
        if (cookie) { const who = await identity().resolveViewer(cookie); if (who.ok) principal = svc<PrincipalService>('principals').principalOf(identity().providerName() ?? '', who.viewer.login) ?? who.viewer.sub; }
        if (!cli && !principal) return null;
        const actor = { by: cli ? 'cli' : principal!, principal, owner: cli || svc<GrantService>('grants').isOwner(principal) };
        const ps = svc<RelationProposalService>('relationProposals');
        const what = { 'dept-lead': '部门负责人', 'team-lead': '团队负责人', 'team-claim': '团队认领到部门' } as const;
        return ps.list().filter((p) => p.status === 'pending' && ps.confirmRefusal(p, actor) === null).map((p) => item({
          source: 'relation-proposals', source_id: String(p.id), category: 'grant',
          title: `${what[p.kind]}：${p.kind === 'team-claim' ? `团队 ${teamName(p.team) || '（没有名字）'} → 部门 ${p.department_id}` : `${p.principal_id}${p.kind === 'dept-lead' ? ` 做部门 ${p.department_id} 的负责人` : ` 做团队 ${teamName(p.team) || '（没有名字）'} 的负责人`}`}（${p.proposed_by} 提议）`,
          waiting_for: p.proposed_by, since: new Date(p.proposed_at).toISOString(), link: '/team', phase: p.kind,
        }));
      },
    }),
  ];
}
