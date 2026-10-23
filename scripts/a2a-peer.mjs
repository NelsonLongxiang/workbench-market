#!/usr/bin/env node
/**
 * A2A peer 宿主（上游实现承载，市场只做业务桥接）
 * ---------------------------------------------------------------
 * 设计（主人裁定 2026-10-23）：不自己实现 A2A 协议——把上游
 * `@nelsonlongxiang/dsh-open-a2a-net` 的插件挂进一个真实 Cordis 宿主，
 * 由市场进程启动；收发/签名/幂等/回执/账本全部由上游实现承担。
 *
 * 本文件只做两件事：
 *   1) 起宿主并把插件 apply 上去（卡片、/a2a/direct、/a2a/log、控制面全由插件提供）
 *   2) 桥接：入站 steer 的派单 → 市场 REST（开 SOP run）；对外暴露 /__bridge/send 供市场反向发消息
 *
 * 依赖解析：`node --import ./scripts/a2a-peer-loader.mjs scripts/a2a-peer.mjs`
 * 环境变量：
 *   PEER_PORT      监听端口（默认 9900）
 *   PEER_HOME      DSH home（默认 <repo>/server/data/peer-home；密钥/peers.json 落这里）
 *   PEER_NAME      卡片 agent 名（默认 workbench-market）
 *   PEER_SESSION   会话名（默认 market）
 *   PEER_TEAM      team（默认 market）
 *   PEER_PEERS     逗号分隔的对端 base URL（种子 peers）
 *   MARKET_BASE    市场 REST 基址（默认 http://127.0.0.1:9800）
 */
import { Context, Service } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import TimerService from '@deepseek-ai/cordis-plugin-timer';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import { SessionId } from '@deepseek-ai/dsh-session';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
const { apply } = await import(pathToFileURL('D:/workspace/dsh-open-a2a-net/lib/index.js').href);

const PORT = Number(process.env.PEER_PORT || 9950);
const HOME = process.env.PEER_HOME || 'D:/workspace/workbench-market/server/data/peer-home';
const NAME = process.env.PEER_NAME || 'workbench-market';
const SESSION = process.env.PEER_SESSION || 'market';
const TEAM = process.env.PEER_TEAM || 'market';
const PEERS = (process.env.PEER_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
// 队声明（S3 准入要求：调用方与目标必须共享队）——精确队名走 allowlist，join 由桥接在启动时执行
const TEAMS = (process.env.PEER_TEAMS || '').split(',').map((s) => s.trim()).filter(Boolean);
const MARKET = process.env.MARKET_BASE || 'http://127.0.0.1:9800';

/** 最小 agents 服务：一个常驻"桥接 agent"，steer 即执行桥接逻辑。 */
class BridgeAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents');
    this.agent = undefined;
  }
  requireInitiator() { throw new Error('no initiator'); }
  roots() { return this.agent ? [this.agent] : []; }
  get(id) { return this.agent && this.agent.id === id ? this.agent : undefined; }
}

const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(TimerService);
await ctx.plugin(WebServer, { host: '0.0.0.0', port: PORT });
await ctx.plugin(BridgeAgents);
const agents = ctx.get('agents');

/** 从派单文本里抠出 SOP 请求：兼容对象 / 转义字符串 / 自由文本里夹 JSON 三种形态 */
function extractSopRequest(text) {
  const firstLine = text.indexOf('\n');
  const tail = firstLine >= 0 ? text.slice(firstLine + 1) : text;
  const candidates = [tail, tail.replace(/\\"/g, '"'), text, text.replace(/\\"/g, '"')];
  for (const c of candidates) {
    const idx = c.indexOf('{"sop"');
    const alt = c.indexOf('{ "sop"');
    const start = idx >= 0 ? idx : alt;
    if (start < 0) continue;
    for (let end = c.lastIndexOf('}'); end > start; end = c.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(c.slice(start, end + 1)); } catch { /* 继续缩短 */ }
    }
  }
  return null;
}

async function bridgePayload(text) {
  // 派单文本形如 `[A2A direct] (task …) from "…"（标题）\n<message>`；
  // message 可能是 JSON 对象、JSON 字符串（再一层转义）或自由文本。
  const body = extractSopRequest(text);
  if (body === null) {
    // 自由文本 = 通知/问候，不当作错误：回一条人类可读的收件确认
    const nl = text.indexOf('\n');
    const brief = (nl >= 0 ? text.slice(nl + 1) : text).trim().slice(0, 200);
    return { ok: true, reply: `已收到：${brief || '（空消息）'}。如需开 SOP，请发 {"sop":{"slug":"<台 slug>","action":"start"}}` };
  }
  const sop = body.sop ?? body;
  const action = sop.action || 'start';
  if (!sop.slug) return { ok: false, reply: '桥接：缺少 sop.slug（市场里的 SOP 台 slug）' };
  try {
    if (action === 'start') {
      const r = await fetch(`${MARKET}/api/sop/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: sop.slug, started_by: 'a2a:' + (body.caller || 'peer') }),
      });
      const j = await r.json();
      if (!r.ok) return { ok: false, reply: `桥接：开 run 失败 ${j.error ?? r.status}` };
      return { ok: true, reply: `已受理：${sop.slug} run #${j.id}（业务专家在 Runner 页面验收后完成）` };
    }
    if (action === 'status' && sop.run_id) {
      const r = await fetch(`${MARKET}/api/sop/runs/${sop.run_id}`);
      const j = await r.json();
      return { ok: true, reply: `run #${j.id} 状态 ${j.status}，步骤数据 ${Object.keys(j.data ?? {}).length} 项` };
    }
    return { ok: false, reply: `桥接：不支持的动作 ${action}` };
  } catch (e) {
    return { ok: false, reply: `桥接：调用市场失败 ${String(e?.message ?? e)}` };
  }
}

const agent = {
  id: SessionId('session-0123456789abcdef'),
  session: { events: [] },
  steer: (payload) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    void bridgePayload(text).then((out) => {
      agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: out.reply }] } } });
      ctx.emit('agent/status', { agent, status: 'idle' });
    });
  },
};
agents.agent = agent;
ctx.emit('agent/created', { agent });

apply(ctx, {
  apiKey: '',
  session: SESSION,
  team: TEAM,
  routeTimeoutMs: 60_000,
  flushTimeoutMs: 300_000,
  announce: true,
  agentName: NAME,
  peers: PEERS,
  delegates: [],
  peerAllowlist: [],
  teamJoinAllowlist: TEAMS,
  referralLearning: true,
  sessionNodes: true,
  wakeJoinedOnBoot: true,
  wakePrewarmDelayMs: 0,
  wakePrewarmQuietMs: 0,
  wakeBootStaggerMs: 3_000,
  stateColdRowsTtlMs: 5_000,
  cardCacheTtlMs: 60_000,
  cardCacheNegativeTtlMs: 20_000,
  remoteRowsTtlMs: 30_000,
  dshHome: HOME,
  cardTtlMs: 172_800_000,
});

// ---- 桥接控制面（市场 → peer 出站发消息 / 状态查询）----
const CTL_PORT = Number(process.env.PEER_CTL_PORT || PORT + 1);
const control = createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === 'GET' && req.url?.startsWith('/__bridge/state')) {
    return send(200, { name: NAME, session: SESSION, team: TEAM, port: ctx.webServer?.port ?? PORT, home: HOME, bridge: 'market' });
  }
  if (req.method === 'POST' && req.url?.startsWith('/__bridge/send')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        if (typeof body.team !== 'string' || typeof body.message !== 'string') return send(400, { error: 'team 与 message 必填' });
        const tool = ctx.tools.get('a2a_route');
        if (!tool) return send(500, { error: 'a2a_route 工具未注册' });
        const runCtx = { signal: AbortSignal.timeout(120_000), agent };
        const out = await tool.execute({ team: body.team, message: body.message, ...(body.context_id ? { context_id: body.context_id } : {}), ...(body.async ? { async: true } : {}) }, runCtx);
        return send(200, { ok: true, result: out });
      } catch (e) {
        return send(500, { error: String(e?.message ?? e) });
      }
    });
    return;
  }
  send(404, { error: 'not found' });
});
control.listen(CTL_PORT, '127.0.0.1', () => console.log(`[a2a-peer] 桥接控制面 http://127.0.0.1:${CTL_PORT}（POST /__bridge/send）`));

// 入队（把本会话节点声明进 PEER_TEAMS 指定的队；allowlist 未含该队时会被上游拒绝并记录）
if (TEAMS.length) {
  const joinTool = ctx.tools.get('a2a_team_join');
  for (const team of TEAMS) {
    try {
      const out = await joinTool?.execute({ id: agent.id, team }, { signal: AbortSignal.timeout(10_000), agent });
      console.log(`[a2a-peer] 队声明 ${team}: ${JSON.stringify(out).slice(0, 160)}`);
    } catch (e) {
      console.log(`[a2a-peer] 队声明 ${team} 失败：${String(e?.message ?? e)}`);
    }
  }
}

const port = ctx.webServer?.port ?? PORT;
console.log(`[a2a-peer] ${NAME} 就绪 http://127.0.0.1:${port}`);
console.log(`[a2a-peer] 卡片 /.well-known/agent-card.json · 入站 /a2a/direct · 控制 /__dsh_a2a/*`);
console.log(`[a2a-peer] 桥接：market=${MARKET} · home=${HOME}`);
process.on('SIGTERM', () => { control.close(); void ctx.fiber.dispose().then(() => process.exit(0)); });
