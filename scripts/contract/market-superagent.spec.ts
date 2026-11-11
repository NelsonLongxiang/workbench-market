// @vitest-environment node
/**
 * 契约联调：市场主干 × a2a-net next/0.8 的 superagent 宿主（节点侧清单 docs/ops/superagent-market-team.md 从头走到尾）。
 *
 * - 对端是上游自己的宿主：在进程里挂上（和 tests/mesh/superagent-host.spec.ts 同一个夹具），路由和成员是假会话，
 *   它们的决定直接调上游的工具（superagent_route、a2a_ticket_report、superagent_reply），不要模型；
 *   回执、提问、进展、跟进都由宿主自己的代码发出（process face，Sig2 + Sig3，签名是宿主名片密钥）。
 * - 市场是 MARKET_TREE 指向的检出，单独起一个进程，临时数据目录，只听回环；前面挂一个记录请求的代理。
 * - 每一步只记结果、不中断（前提不成立的除外），最后把「步骤 × 结果」写到 CONTRACT_OUT。
 *
 * 不直接跑：由 scripts/contract-upstream-test.mjs 拷进上游检出的 tests/mesh/ 再跑（它带守卫、按「步骤 × 结果」断言）。
 * 来源：阶段三验收会话的契约联调夹具（2026-11-11）；宿主配置经上游自己的 Config schema 取缺省值，
 * 并按节点侧清单把市场句柄列进 bots.a2a、加一条接单规则、acceptMode=auto（与真实部署一致）。
 *
 * 全部合成数据；不连任何真实节点。
 */
import { mkdtempSync } from '../temp-dirs.ts'
import { describe, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, Config } from '../../src/index.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { copyFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { cliEnv, mockGuiLogin } from './harness.ts'

const MARKET_TREE = process.env.MARKET_TREE ?? ''
const OUT = process.env.CONTRACT_OUT ?? join(tmpdir(), 'market-contract.json')
const LABEL = process.env.CONTRACT_LABEL ?? 'main'
const ADMIN = 'contract-synthetic-admin'

class ManyAgents extends Service {
  map = new Map<string, Agent>()
  constructor(ctx: Context) { super(ctx, 'agents') }
  requireInitiator(): never { throw new Error('no initiator in this fiber') }
  roots(): Agent[] { return [...this.map.values()] }
  get(id: Agent['id']): Agent | undefined { return this.map.get(String(id)) }
}
interface TestAgent extends Agent { steered: string[]; host?: Context }
function makeAgent(id: string, name: string): TestAgent {
  const agent = {
    id: SessionId(id), session: { id: SessionId(id), events: [] as unknown[], title: name }, steered: [] as string[],
    followup(message: unknown): void { queueMicrotask(() => { agent.host?.emit('agent/inbox/claimed', { agent, message, turn: 1 }); agent.steer(message) }) },
    steer(payload: unknown): void {
      const text = typeof payload === 'object' && payload !== null && 'content' in (payload as Record<string, unknown>)
        ? ((payload as { content: Array<{ text?: string }> }).content.map(b => b.text ?? '').join(''))
        : String(payload)
      agent.steered.push(text)
      const events = (agent as unknown as { session: { events: unknown[] } }).session.events
      events.push({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `noted by ${name}` }] } } })
      agent.host?.emit('agent/status', { agent: agent as unknown as Agent, status: 'idle' })
    },
  } as unknown as TestAgent
  return agent
}
const R_ID = 'session-a0000000aaaa1111', M_ID = 'session-b1111111bbbb2222'
const execAs = (agent: Agent) => ({ signal: new AbortController().signal, agent }) as never

async function mount(home: string, extra: Partial<Config>) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(TimerService)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(ManyAgents)
  const agents = ctx.get('agents') as unknown as ManyAgents
  const [R, M] = [[R_ID, 'router'], [M_ID, 'member']].map(([id, name]) => makeAgent(id!, name!))
  for (const a of [R!, M!]) { agents.map.set(String(a.id), a); a.host = ctx }
  // 经上游自己的配置 schema 取缺省值（直接传对象会缺 cardTtlMs 这类缺省，名片 expiresAt 成了 null）
  apply(ctx, (Config as unknown as (v: unknown) => Config)({ apiKey: '', session: 'host-sess', team: 'lab', routeTimeoutMs: 5_000, flushTimeoutMs: 300_000, announce: true, agentName: 'sa-host', peers: [], delegates: [], sessionNodes: true, wakeJoinedOnBoot: false, dshHome: home, superagent: true, ...extra }))
  for (const a of [R!, M!]) ctx.emit('agent/created', { agent: a as unknown as Agent })
  const port = (ctx as unknown as { webServer: { port: number } }).webServer.port
  const login = mockGuiLogin()
  const post = async (path: string, body: unknown): Promise<Record<string, any>> => await (await globalThis.fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...login }, body: JSON.stringify(body) })).json() as Record<string, any>
  const sa = async (body: unknown): Promise<Record<string, any>> => await post('/__dsh_a2a/superagent', body)
  const state = async (): Promise<Record<string, any>> => await (await globalThis.fetch(`http://127.0.0.1:${port}/__dsh_a2a/superagent`)).json() as Record<string, any>
  const a2aState = async (): Promise<Record<string, any>> => await (await globalThis.fetch(`http://127.0.0.1:${port}/__dsh_a2a/state`)).json() as Record<string, any>
  const tool = async (name: string, from: Agent, args: Record<string, unknown>): Promise<Record<string, any>> => await ctx.tools.get(name)!.execute(args, execAs(from)) as Record<string, any>
  for (const a of [R!, M!]) await post('/__dsh_a2a/join', { id: String(a.id) })
  return { ctx, port, R: R!, M: M!, post, sa, state, a2aState, tool, dispose: async () => { await ctx.fiber.dispose() } }
}

const freePort = async (): Promise<number> => { const s = netServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as { port: number }).port; await new Promise(r => s.close(r)); return p }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms: number, step = 300): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) { try { const v = await fn(); if (v !== undefined && v !== null && v !== false) return v } catch { /* 再试 */ } if (Date.now() > end) return undefined; await sleep(step) }
}
const findFile = (dir: string, name: string, depth = 5): string | undefined => {
  if (depth < 0) return undefined
  for (const e of readdirSync(dir)) { const p = join(dir, e); try { if (statSync(p).isDirectory()) { const f = findFile(p, name, depth - 1); if (f) return f } else if (e === name) return p } catch { /* 跳过 */ } }
  return undefined
}

describe('契约联调：市场 × superagent 宿主', () => {
  it('节点侧清单从头走到尾', async () => {
    if (!MARKET_TREE) throw new Error('MARKET_TREE 未设')
    const results: Array<{ step: string; result: '过' | '不过' | '未验'; detail: string }> = []
    const rec = (step: string, ok: boolean | null, detail = ''): void => { const result = ok === null ? '未验' : ok ? '过' : '不过'; results.push({ step, result, detail: detail.slice(0, 600) }); console.log(`[${result}] ${step}${detail ? ' — ' + detail.slice(0, 400) : ''}`) }
    const children: ChildProcess[] = [], servers: Server[] = []
    const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: any; status?: number; reply?: string }> = []
    let mlog = ''
    let m: Awaited<ReturnType<typeof mount>> | undefined
    let mdbPath = ''
    try {
      // ---------- 起市场（临时目录、回环）和它前面的记录代理 ----------
      const [PM, PX] = [await freePort(), await freePort()]
      const M = `http://127.0.0.1:${PM}`, X = `http://127.0.0.1:${PX}`
      const mdata = mkdtempSync(join(tmpdir(), 'contract-market-'))
      const market = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
        cwd: join(MARKET_TREE, 'server'),
        env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'contract-home-')), DATA_DIR: mdata, PORT: String(PM), NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: ADMIN, MARKET_PUBLIC_URL: X, A2A_OUTBOX_BACKOFF_SCALE: '0.01', ...JSON.parse(process.env.CONTRACT_MARKET_ENV ?? '{}') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(market); market.stdout!.on('data', d => { mlog += String(d) }); market.stderr!.on('data', d => { mlog += String(d) })
      const proxy = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c)); req.on('end', () => {
          const body = Buffer.concat(chunks)
          const entry = req.url!.startsWith('/a2a/') ? { method: req.method!, url: req.url!, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-')).map(([k, v]) => [k, String(v)])), body: (() => { try { return JSON.parse(body.toString('utf8')) } catch { return body.toString('utf8') } })() } as (typeof seen)[number] : undefined
          if (entry) seen.push(entry)
          const up = httpRequest({ host: '127.0.0.1', port: PM, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${PX}` } }, r => {
            const out: Buffer[] = []
            r.on('data', c => out.push(c)); r.on('end', () => { const b = Buffer.concat(out); if (entry) { entry.status = r.statusCode; entry.reply = b.toString('utf8').slice(0, 300) } res.writeHead(r.statusCode!, r.headers); res.end(b) })
          })
          up.on('error', e => { res.writeHead(502); res.end(String(e)) }); up.end(body)
        })
      })
      await new Promise<void>(r => proxy.listen(PX, '127.0.0.1', r)); servers.push(proxy)
      const ready = await until(async () => (await fetch(M + '/api/health')).status < 500 || undefined, 60_000)
      if (!ready) throw new Error('市场起不来：\n' + mlog.slice(-1500))
      mdbPath = join(mdata, 'workbench-market.db')
      const mdb = new DatabaseSync(mdbPath)
      const q = <T = any>(sql: string, ...a: unknown[]): T[] => mdb.prepare(sql).all(...(a as never[])) as T[]
      const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
        const r = await fetch(M + path, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN, ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
        let j: any = null; try { j = await r.json() } catch { /* 不是 JSON */ }
        return { status: r.status, body: j }
      }

      // ---------- 起上游宿主（lab 区，和市场的 market 区不同 → 期望 remote-ref-foreign） ----------
      const home = mkdtempSync(join(tmpdir(), 'contract-host-'))
      m = await mount(home, { teamScopeRouting: true, peers: [X] } as Partial<Config>)
      const H = `http://127.0.0.1:${m.port}`
      const canvasAddress = 'lab/canvas/team'

      // ---------- 市场侧准备：task-center 台（合成）、绑定、对端登记、派发开关 ----------
      mdb.prepare("INSERT INTO apps (slug, title, kind, status, a2a_node8) VALUES ('task-center', '任务中心（合成）', 'sop', 'published', 'c0ffee01') ON CONFLICT(slug) DO UPDATE SET kind = 'sop', status = 'published', a2a_node8 = 'c0ffee01'").run()
      const bind = await call('POST', '/api/bindings', { target_type: 'sop', target_slug: 'task-center', agent_node: canvasAddress, direction: 'both', mode: 'run', notify_url: H })
      rec('市场：给 task-center 绑定 canvas 地址（派工目标）', bind.status < 300, `${bind.status} ${JSON.stringify(bind.body).slice(0, 200)}`)
      mdb.prepare("INSERT INTO settings (key, value) VALUES ('a2a_peers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([H]))
      const policy = await call('PUT', '/api/task-center/policy', { agent_dispatch_enabled: true })
      rec('市场：打开任务中心的派发总开关', policy.status === 200, String(policy.status))
      const card = await (await fetch(X + '/.well-known/agent-card.json')).json() as any
      const marketSession = `${card.team ?? 'market'}/c0ffee01`
      rec('清单§5 名片能力：canvasMemberProvenance = true', card?.capabilities?.canvasMemberProvenance === true, JSON.stringify(card?.capabilities))
      rec('设计稿 P1：名片声明 progressReceipts（不声明就收不到进展）', card?.capabilities?.progressReceipts === true, JSON.stringify(card?.capabilities))
      rec('名片 sessionTeams 列出派工用的会话句柄', Array.isArray(card?.sessionTeams) && card.sessionTeams.some((t: any) => t.team === marketSession), JSON.stringify(card?.sessionTeams))

      // ---------- 宿主侧：清单 §2 ----------
      // 2.1 互加 seed：宿主 peers 已含市场（X）；等宿主取到市场名片
      const peerSeen = await until(async () => { const s = await m!.a2aState(); const p = JSON.stringify(s.peers ?? s.peerCards ?? s.directory ?? ''); return p.includes(String(PX)) ? p : undefined }, 30_000)
      rec('清单§2.1 互为 seed：宿主看到市场为对端', peerSeen !== undefined, (peerSeen ?? '').slice(0, 200))
      // 2.3 团队绑画布、a2a 来源开（reply）、自动接单
      const teamSet = await (async () => {
        for (const id of [R_ID, M_ID]) await m!.post('/__dsh_a2a/canvas', { action: 'add-member', name: 'team', id })
        return await m!.sa({ action: 'settings', settings: { canvas: 'team', router: R_ID, sources: { a2a: true }, acceptMode: 'auto' } })
      })()
      rec('清单§2.3 团队绑定画布、a2a 来源开', teamSet.ok === true, JSON.stringify(teamSet).slice(0, 200))
      // 2.2 加远端成员（显式选中市场所在的宿主）
      const added = await m.post('/__dsh_a2a/canvas', { action: 'add-member', name: 'team', id: marketSession, peer: X })
      const members = JSON.stringify(((await m.a2aState()).canvas?.teams ?? []).find((t: any) => t.name === 'team')?.members ?? [])
      rec('清单§2.2 把市场加成团队画布的远端成员', added.ok === true, JSON.stringify(added).slice(0, 300))
      rec('清单§5 成员已钉：市场一项带 @<8 位指纹>', new RegExp(`${marketSession.replace('/', '\\/')}@[0-9a-f]{8}`).test(members), members.slice(0, 300))
      // 2.4 准入：用团队的 CLI 身份
      const teamCli = await until(() => findFile(home, 'cli.json'), 20_000)
      let admission: any = null
      if (teamCli) {
        const out = await new Promise<string>(resolve => { const c = spawn(process.execPath, [join(process.cwd(), 'cli/a2a.mjs'), 'admission', marketSession, '--json', '--home', H], { env: cliEnv(join(teamCli, '..')) }); let s = ''; c.stdout.on('data', d => { s += d }); c.stderr.on('data', d => { s += d }); c.on('close', () => resolve(s)) })
        try { admission = JSON.parse(out) } catch { admission = out }
      }
      rec('清单§2.4 准入：admitted=true，规则 remote-ref-*', admission?.admitted === true && /^remote-ref-/.test(String(admission?.rule)), JSON.stringify(admission).slice(0, 300))

      // ---------- 派工：市场发布一件任务 ----------
      let runSeq = 0
      const publish = async (title: string): Promise<{ eventId: string; task: string; item: any } | undefined> => {
        runSeq++
        const data = { title: { value: title }, intent: { value: '契约联调' }, deliverable: { value: '一句话结论' } }
        const runId = Number(mdb.prepare("INSERT INTO sop_runs (sop_slug, sop_version, status, started_by, data) VALUES ('task-center', 1, 'finished', 'tester', ?)").run(JSON.stringify(data)).lastInsertRowid)
        const pub = await call('POST', '/api/task-center/tasks', { intake_run_id: runId, published_by: 'tester', agent_dispatch: true })
        if (pub.status !== 201) { rec(`市场：发布「${title}」`, false, `${pub.status} ${JSON.stringify(pub.body)}`); return undefined }
        const eventId = String(pub.body.event_id)
        const sent = await until(() => q<any>('SELECT d.status, d.last_error, t.task_id FROM workbench_event_deliveries d LEFT JOIN a2a_sent_tasks t ON t.delivery_id = d.id WHERE d.event_id = ? ORDER BY t.created_at DESC', eventId).find(r => r.status === 'sent' || r.status === 'dead' || r.last_error), 30_000)
        const item = q<any>('SELECT * FROM work_items WHERE event_id = (SELECT id FROM workbench_events WHERE event_id = ?)', eventId)[0]
        rec(`派工「${title}」：市场投递到 canvas 地址，宿主收下`, sent?.status === 'sent', JSON.stringify(sent))
        return sent?.status === 'sent' ? { eventId, task: String(sent.task_id), item } : undefined
      }
      const itemState = (eventId: string): any => q<any>('SELECT id, state, eval, receipt_outcome, open_asks, progress_summary FROM work_items WHERE event_id = (SELECT id FROM workbench_events WHERE event_id = ?)', eventId)[0]
      const fromHost = (taskPrefix: string) => seen.filter(e => typeof e.body === 'object' && typeof e.body?.task_id === 'string' && e.body.task_id.startsWith(taskPrefix))
      const candidate = async (task: string): Promise<string | undefined> => {
        const card = await until(() => m!.R.steered.find(t => t.includes('[superagent candidate]') && t.includes(task)), 45_000)
        return card ? /^trigger (\S+) /m.exec(card)?.[1] : undefined
      }

      const t1 = await publish('任务一：走完整条路')
      if (!t1) throw new Error('派工没送到，后面没法走')
      // 来信判定：宿主怎么看市场这条派工
      const inbound = (await m.a2aState()).tasks?.find((r: any) => r.taskId === t1.task) ?? (await m.a2aState()).archived?.find((r: any) => r.taskId === t1.task)
      rec('派工：上游判市场的来信（签名、来源）', inbound !== undefined, JSON.stringify(inbound ?? {}).slice(0, 400))
      let trigger = await candidate(t1.task)
      if (trigger === undefined) {
        const s = await m.state()
        const refused = JSON.stringify(s.threads?.flatMap((t: any) => t.decisions ?? []) ?? []).slice(0, 300)
        rec('派工进路由席（清单没写要把市场列进团队名单）', false, `没有成为候选；宿主判定：${refused}`)
        const allow = await m.sa({ action: 'settings', settings: { bots: { a2a: [marketSession] }, rules: [{ name: 'market', text: 'Work the workbench market dispatches to this team.' }] } })
        rec('补：把市场的会话句柄列进 bots.a2a，并加一条接市场派工的团队规则', allow.ok === true, JSON.stringify(allow).slice(0, 200))
      } else rec('派工进路由席成为候选', true, `trigger ${trigger}`)
      const t1b = trigger === undefined ? await publish('任务一（列进名单、加规则之后重发）') : t1
      if (trigger === undefined && t1b) trigger = await candidate(t1b.task)
      const T1 = t1b ?? t1
      if (trigger === undefined) throw new Error('派工始终没成为候选')

      // 路由接单 → ack-<task>
      const accepted = await m.tool('superagent_route', m.R, { items: [{ trigger_id: trigger, kind: 'accept', title: '契约联调一', scope: '一句话', reason: '联调', rules: ['market'] }] })
      const ticket1 = accepted.results?.[0]?.ticket_id as string | undefined
      rec('路由接单（宿主建工单）', ticket1 !== undefined, JSON.stringify(accepted).slice(0, 200))
      const ack = await until(() => fromHost(`ack-${T1.task}`).find(e => e.status !== undefined), 40_000)
      rec('确认：市场收到 ack-<task>，宿主签名被接受', ack?.status !== undefined && ack.status < 300, ack ? `${ack.status} ${ack.reply} 头：${Object.keys(ack.headers).join(',')}` : '没收到')
      rec('确认：信封 disposition=acknowledged、idempotencyKey=<task>、onBehalfOf=canvas 地址', ack !== undefined && /"disposition":"acknowledged"/.test(String(ack.body?.message)) && String(ack.body?.message).includes(`"idempotencyKey":"${T1.task}"`) && String(ack.body?.message).includes(`"onBehalfOf":"${canvasAddress}"`), String(ack?.body?.message ?? '').slice(0, 300))
      rec('确认：带 Sig3（body 绑定）', ack !== undefined && 'x-a2a-caller-sig3' in ack.headers, Object.keys(ack?.headers ?? {}).join(','))
      await sleep(500)
      rec('确认后市场事项状态 = accepted', itemState(T1.eventId)?.state === 'accepted', JSON.stringify(itemState(T1.eventId)))

      // 成员接手、进展 → progress-<task>-<n>
      const assigned = await until(() => m!.M.steered.find(t => t.includes(ticket1!)), 20_000)
      rec('成员拿到工单', assigned !== undefined, (assigned ?? '').slice(0, 120))
      if (ticket1 === undefined) throw new Error('路由没接下单，后面的成员步骤没法走')
      const progress = await m.tool('a2a_ticket_report', m.M, { ticket_id: ticket1, state: 'progress', summary: '正在核对第一步' })
      const prog = await until(() => fromHost(`progress-${T1.task}-`).find(e => e.status !== undefined), 20_000)
      rec('进展：市场收到 progress-<task>-<n>', prog?.status !== undefined && prog.status < 300, prog ? `${prog.status} ${prog.reply}` : `没收到（成员汇报 ${JSON.stringify(progress).slice(0, 120)}）`)
      await sleep(300)
      rec('进展后市场事项状态 = progress（或保持 accepted）', ['progress', 'accepted'].includes(itemState(T1.eventId)?.state), JSON.stringify(itemState(T1.eventId)))

      // 成员提问 → 路由转述 → attention-<task>-<qid>
      const asked = await m.tool('a2a_ticket_report', m.M, { ticket_id: ticket1, state: 'waiting', summary: '需要人定一件事', question: '发哪个环境？', options: ['测试', '生产'], recommended: '测试' })
      rec('成员提问（带结构化选项）', asked.ok === true, JSON.stringify(asked).slice(0, 200))
      await until(() => m!.R.steered.find(t => t.includes('[superagent report]') && t.includes(ticket1!)), 15_000)
      const relayed = await m.tool('superagent_reply', m.R, { purpose: 'attention', ticket_id: ticket1, text: '需要你定一下', question: '发哪个环境？' })
      rec('路由把提问转给市场（superagent_reply attention）', relayed.ok === true, JSON.stringify(relayed).slice(0, 200))
      const att = await until(() => [...fromHost(`attention-${T1.task}-`), ...fromHost(`receipt-${T1.task}`).filter(e => /"disposition":"attention"/.test(String(e.body?.message)))].find(e => e.status !== undefined), 30_000)
      const followups = () => seen.filter(e => typeof e.body?.task_id === 'string' && e.body.task_id.startsWith('a2a-') && e.body.context_id === `wb:task-center:${String(runSeq)}`)
      rec('提问：市场收到 attention-<task>-<qid>（带 question）', att !== undefined && att.body.task_id.startsWith(`attention-${T1.task}-`) && (att.status ?? 999) < 300 && /"question":\{/.test(String(att.body?.message)), att ? `${att.body.task_id} ${att.status} ${String(att.body?.message).slice(0, 200)}` : `没收到；跟进 ${followups().length} 条`)
      await sleep(300)
      const afterAsk = itemState(T1.eventId)
      // 迁移表定的是 ask → blocked（在问你）
      rec('提问后市场事项状态 = blocked，open_asks 有这一问', afterAsk?.state === 'blocked' && /发哪个环境/.test(afterAsk?.open_asks ?? ''), JSON.stringify(afterAsk))
      rec('提问不结清原派工（市场没把它记成终局回执）', q('SELECT * FROM a2a_inbound_receipts WHERE task_id = ? AND class = ?', T1.task, 'final').length === 0, JSON.stringify(q('SELECT * FROM a2a_inbound_receipts WHERE task_id = ?', T1.task)))

      // 跟进：宿主的普通路由（a2a-…）——市场要回结清回执
      const fu = followups()
      rec('跟进：宿主发来 a2a-<hash> 跟进（本轮是否出现）', fu.length > 0 ? true : null, fu.length ? `${fu.length} 条，市场应答 ${fu.map(f => f.status).join(',')}` : '这一轮没有产生跟进（提问走了 attention-…）')

      // 市场的答复：作为同 context 新任务发回（R2 #546 才有）
      const deliveryId = q<any>('SELECT delivery_id FROM a2a_sent_tasks WHERE task_id = ?', T1.task)[0]?.delivery_id
      const listed = await call('GET', '/api/attention')
      const seatAsk = (listed.body?.items ?? []).find((x: any) => x.source === 'seat-asks')
      rec('提问出现在市场「关注」里（seat-asks）', seatAsk !== undefined, JSON.stringify((listed.body?.items ?? []).map((x: any) => [x.source, x.source_id, x.answers])).slice(0, 300))
      const ans = await call('POST', '/api/attention/answer', { source: 'seat-asks', source_id: String(seatAsk?.source_id ?? deliveryId), answer: 'answer', input: { text: '测试环境' } })
      if (ans.status === 404 || ans.status === 400 && /not_offered|unknown/.test(JSON.stringify(ans.body))) rec('答复：市场把人的答复作为同 context 新任务发回', false, `这一版市场没有答复席位提问的入口：${ans.status} ${JSON.stringify(ans.body).slice(0, 160)}`)
      else {
        rec('答复：市场记下答复并排发', ans.status < 300 && ans.body?.sent !== false, `${ans.status} ${JSON.stringify(ans.body).slice(0, 240)}`)
        const answerOut = await until(() => q<any>("SELECT task_id FROM a2a_sent_tasks WHERE kind = 'answer' AND delivery_id = ?", deliveryId)[0], 30_000)
        rec('答复：作为同 context 的新任务发出（a2a_sent_tasks kind=answer）', answerOut !== undefined, JSON.stringify(answerOut))
        const got = await until(() => m!.M.steered.find(t => t.includes('测试环境')) ?? m!.R.steered.find(t => t.includes('测试环境')), 40_000)
        rec('答复：宿主把答复交给在办工单的成员（轻路径，不经路由）', got !== undefined && m.M.steered.some(t => t.includes('测试环境')), `成员收到 ${m.M.steered.some(t => t.includes('测试环境'))}，路由收到 ${m.R.steered.some(t => t.includes('测试环境'))}`)
      }

      // 结果：成员 ready → 路由 result → receipt-<task> completed
      const readyReport = await m.tool('a2a_ticket_report', m.M, { ticket_id: ticket1, state: 'ready', summary: '做完了：结论一句话' })
      rec('成员报 ready', readyReport.ok === true, JSON.stringify(readyReport).slice(0, 160))
      await until(() => m!.R.steered.find(t => t.includes('[superagent report]') && t.includes(ticket1!) && t.includes('ready')), 15_000)
      const resultSent = await m.tool('superagent_reply', m.R, { purpose: 'result', ticket_id: ticket1, text: '做完了：结论一句话' })
      rec('路由发结果（superagent_reply result）', resultSent.ok === true, JSON.stringify(resultSent).slice(0, 200))
      const res1 = await until(() => fromHost(`receipt-${T1.task}`).find(e => /"disposition":"result"/.test(String(e.body?.message)) && e.status !== undefined), 40_000)
      rec('结果：市场收到 receipt-<task> outcome=completed，签名被接受', res1 !== undefined && (res1.status ?? 999) < 300 && /"outcome":"completed"/.test(String(res1.body?.message)), res1 ? `${res1.status} ${String(res1.body?.message).slice(0, 200)}` : '没收到')
      await sleep(500)
      rec('结果后市场事项状态 = ready（completed 回执推到待验收）', itemState(T1.eventId)?.state === 'ready', JSON.stringify(itemState(T1.eventId)))
      rec('结果结清原派工（市场记了终局回执）', q('SELECT * FROM a2a_inbound_receipts WHERE task_id = ? AND class = ?', T1.task, 'final').some((r: any) => r.outcome === 'completed'), JSON.stringify(q('SELECT * FROM a2a_inbound_receipts WHERE task_id = ?', T1.task)))

      // 其余三种结局：failed（成员报 failed）、rejected（成员报 dropped）、abandoned（属主停）
      if (process.env.CONTRACT_QUICK === '1') throw new Error('快速模式：只走第一件任务')
      // failed、rejected 两种结局要等宿主的结束回执宽限（5 分钟）加路由收尾，夹具做不出来，不在这里验
      rec('结局 failed、rejected（夹具不模拟路由收尾）', null)
      for (const [label, how, expect, expectState] of [
        ['abandoned', 'stop', 'abandoned', 'dropped'],
      ] as const) {
        const t = await publish(`任务：结局 ${label}`)
        if (!t) continue
        const trig = await candidate(t.task)
        if (!trig) { rec(`结局 ${label}：派工成为候选`, false, '没有'); continue }
        const acc = await m.tool('superagent_route', m.R, { items: [{ trigger_id: trig, kind: 'accept', title: `结局 ${label}`, scope: '一句话', reason: '联调', rules: ['market'] }] })
        const tk = acc.results?.[0]?.ticket_id as string
        await until(() => fromHost(`ack-${t.task}`).find(e => e.status !== undefined), 30_000)
        await until(() => m!.M.steered.find(x => x.includes(tk)), 20_000)
        if (how === 'stop') await m.sa({ action: 'stop', ticket_id: tk, reason: '联调：属主停' })
        else await m.tool('a2a_ticket_report', m.M, { ticket_id: tk, state: how, summary: `结局 ${label}` })
        const marketTookAny = seen.some(e => typeof e.body?.task_id === 'string' && /^(ack|receipt|attention|progress)-/.test(e.body.task_id) && (e.status ?? 999) < 300)
        const r = await until(() => fromHost(`receipt-${t.task}`).find(e => /"disposition":"result"/.test(String(e.body?.message)) && e.status !== undefined), 420_000, 1000)
        rec(`结局 ${label}：市场收到 receipt-<task> outcome=${expect}`, r !== undefined && (r.status ?? 999) < 300 && String(r.body?.message).includes(`"outcome":"${expect}"`), r ? `${r.status} ${String(r.body?.message).slice(0, 200)}` : '没收到（宿主的结束回执有 5 分钟宽限）')
        await sleep(500)
        const st = itemState(t.eventId)
        rec(`结局 ${label}：市场事项状态 ∈ {${expectState}}`, expectState.split('|').includes(st?.state), JSON.stringify(st))
      }

      // 市场被拒的请求（任何非 2xx）一律列出来
      const rejected = seen.filter(e => e.url.startsWith('/a2a/direct') && (e.status ?? 0) >= 300)
      rec('市场对宿主经 /a2a/direct 的来信没有拒收（非 2xx）', rejected.length === 0, rejected.map(e => `${e.body?.task_id} → ${e.status} ${e.reply}`).join(' | '))
      // 宿主发给远端成员的其它端点（canvas-changed、superagent-member）市场还没接：只列出来，不算失败
      const other = [...new Set(seen.filter(e => !e.url.startsWith('/a2a/direct')).map(e => `${e.url} → ${e.status}`))]
      rec('宿主发来的其它端点（只列出）', null, other.join(' | '))
    } catch (error) {
      rec('跑不下去', false, String((error as Error)?.stack ?? error))
    } finally {
      let hostDiag: any = null
      try { if (m) { const s = await m.state(), a = await m.a2aState(); hostDiag = { refusals: a.refusals ?? s.refusals, threads: (s.threads ?? []).map((t: any) => ({ key: t.key, triggers: (t.triggers ?? []).map((x: any) => ({ id: x.id, actor: x.actor, source: x.source })), decisions: t.decisions })), a2a: s.a2a, tasks: (a.tasks ?? []).slice(-10), archived: (a.archived ?? []).slice(-10), steeredR: m.R.steered.map(t => t.slice(0, 300)), steeredM: m.M.steered.map(t => t.slice(0, 300)) } } } catch (e) { hostDiag = String(e) }
      writeFileSync(OUT, JSON.stringify({ label: LABEL, market: MARKET_TREE, at: new Date().toISOString(), results, seen: seen.map(e => ({ url: e.url, task: e.body?.task_id, status: e.status, headers: e.headers, body: e.body, reply: e.reply })), hostDiag, marketLog: mlog.split('\n').filter(l => /a2a|回执|receipt|sig/i.test(l)).slice(-60) }, null, 1))
      if (mdbPath) for (const ext of ['', '-wal', '-shm']) try { copyFileSync(mdbPath + ext, OUT.replace(/\.json$/, '.db') + ext) } catch { /* 没有就算了 */ }
      for (const s of servers) s.close()
      for (const c of children) try { c.kill() } catch { /* 已退出 */ }
      if (m) await m.dispose()
    }
  }, 30 * 60_000)
})
