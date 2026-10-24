/**
 * A2A 网络接入（GH #17 P1）：Ed25519 签名卡片 + 人工绑定数据面。
 *
 * canonical/签名/验签与上游 dsh-open-a2a-net src/card.ts（裁判钉 75a3ebd）逐字节一致：
 * 签名面 {capabilities, expiresAt, name, [records], session, team}（键序固定），
 * Ed25519 pure（sign(undefined, payload)），公钥为 SPKI DER base64。
 * 修订 3 落实：卡片不发布 teamMemberships（绑定图不出门）；id8 每 SOP 随机生成持久化
 * （禁 slug 推导防抢注）；ADMIN_TOKEN 只经启动环境。
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signCard, verifyCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';
import { formatReceipt, parseReceipt } from '@nelsonlongxiang/dsh-open-a2a-net/receipt';
import { MAX_ROUTE_BODY_BYTES } from '@nelsonlongxiang/dsh-open-a2a-net/transport-caps';
import { A2aClient } from '@nelsonlongxiang/dsh-open-a2a-net/a2a-client';
import { dataDir, db } from './db.ts';

export const MARKET_TEAM = process.env.MARKET_TEAM || 'market';
export const CARD_TTL_MS = 45 * 3600 * 1000; // 45h ≤ 上游 48h 预算

let cachedKey: KeyObject | null = null;

/** 首启生成 Ed25519 并存 DATA_DIR/a2a-key.pem（0600）；之后加载。 */
export function loadOrCreateKey(keyPath: string): KeyObject {
  if (cachedKey) return cachedKey;
  if (existsSync(keyPath)) {
    cachedKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
    return cachedKey;
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* Windows 权限语义尽力而为 */ }
  cachedKey = privateKey;
  return cachedKey;
}

/**
 * 卡片签名 / 验签 / 回执编解码 / 512KiB 上限——全部走官方子路径
 * `@nelsonlongxiang/dsh-open-a2a-net/{card,receipt,transport-caps}`（#17 P5：
 * 删掉市场里的镜像代码，协议 wire 由上游库保证）。
 */
export function signMarketCard(
  core: { capabilities: unknown; expiresAt: number; name: string; session: string; team: string },
  privateKey: KeyObject,
): Record<string, unknown> & { publicKey: string; signature: string } {
  return signCard(core as never, privateKey) as never;
}

/** 验签（官方 verifyCard；E2E 与自检用） */
export function verifyMarketCard(wire: unknown, now: number): { ok: boolean } {
  return verifyCard(wire as never, now) as never;
}

/** 回执文本（P3 完成回执用）：第一行固定模板 + 第二行单个 JSON 信封 */
export function formatA2aReceipt(taskId: string, summary: string, fields?: { outcome?: string; idempotencyKey?: string; sessionKey?: string; elapsedMs?: number }): string {
  return formatReceipt(taskId, summary, fields as never);
}

/** 回执解析（收到对端回执时核销账本用） */
export function parseA2aReceipt(message: string): ReturnType<typeof parseReceipt> {
  return parseReceipt(message);
}

/** 512 KiB 消息上限（官方 transport-caps 常量） */
export const A2A_DIRECT_MAX_BYTES = MAX_ROUTE_BODY_BYTES;

/** SOP 的 a2a 节点短 id：随机 8 hex，一次生成持久化（apps.a2a_node8）——禁 slug 推导（修订 3 防抢注）。 */
export function sopNode8(slug: string): string {
  const row = db.prepare('SELECT a2a_node8 FROM apps WHERE slug = ?').get(slug) as { a2a_node8?: string } | undefined;
  if (row?.a2a_node8) return row.a2a_node8;
  const id8 = randomBytes(4).toString('hex');
  db.prepare('UPDATE apps SET a2a_node8 = ? WHERE slug = ?').run(id8, slug);
  return id8;
}

/** ADMIN_TOKEN 常量时间比较（两侧 sha256 定长再比；未设置一律拒绝）。 */
export function adminTokenOk(provided: string | undefined): boolean {
  const expect = process.env.ADMIN_TOKEN;
  if (!expect) return false;
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(String(provided ?? '')), h(expect));
}

/**
 * 组装市场卡片（上卡规则：sessionTeams 只列 published 且 ≥1 有效绑定的 SOP；
 * 不发布 teamMemberships——绑定图不出门）。
 */
export function buildAgentCard(keyPath: string): Record<string, unknown> {
  const priv = loadOrCreateKey(keyPath);
  const now = Date.now();
  const rows = db.prepare(
    `SELECT DISTINCT a.slug, a.title, a.description, a.a2a_node8
       FROM apps a
       JOIN sop_bindings b ON b.sop_slug = a.slug AND b.revoked_at = ''
      WHERE a.kind = 'sop' AND a.status = 'published'
      ORDER BY a.slug`
  ).all() as { slug: string; title: string; description: string; a2a_node8: string }[];
  const sessionTeams = rows.map((r) => ({
    team: `${MARKET_TEAM}/${r.a2a_node8 || sopNode8(r.slug)}`,
    name: r.slug,
    description: r.description || r.title,
  }));
  let peers: string[] = [];
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'a2a_peers'").get() as { value: string } | undefined;
    const parsed = raw ? JSON.parse(raw.value) : [];
    if (Array.isArray(parsed)) peers = parsed.filter((x) => typeof x === 'string');
  } catch { /* 配置坏值忽略 */ }
  const core = {
    capabilities: { sop: true, bindings: 'human-only', stage: 'P1-readonly' },
    expiresAt: now + CARD_TTL_MS,
    name: 'workbench-market',
    session: MARKET_TEAM,
    team: MARKET_TEAM,
  };
  const signed = signMarketCard(core, priv);
  return { ...signed, sessionTeams, ...(peers.length ? { peers } : {}), version: 'p1' };
}

export function a2aKeyPath(): string {
  return join(dataDir, 'a2a-key.pem');
}

// ---------- P2：/a2a/direct 准入与执行（协议对齐上游 src/index.ts @1efd613） ----------

export interface A2aDirectResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** 进程内幂等窗：task_id → payload 指纹（上游 idempotencyStore 同语义：replay=-32003 / conflict=-32002） */
const idemStore = new Map<string, string>();
const IDEM_TTL_MS = 30 * 60 * 1000;
const idemAt = new Map<string, number>();

export function a2aDirectFingerprint(team: string, caller: string, message: string): string {
  return `${team}\u0000${caller}\u0000${message}`;
}

function idemClaim(taskId: string, fp: string): 'fresh' | 'replay' | 'conflict' {
  const now = Date.now();
  for (const [k, t] of idemAt) if (now - t > IDEM_TTL_MS) { idemStore.delete(k); idemAt.delete(k); }
  const prev = idemStore.get(taskId);
  if (prev === undefined) {
    idemStore.set(taskId, fp);
    idemAt.set(taskId, now);
    return 'fresh';
  }
  return prev === fp ? 'replay' : 'conflict';
}

/**
 * 市场版 /a2a/direct 准入链（P2）：
 * ① team → SOP 解析（查无 → 404 不泄露）② caller 准入（匿名拒/精确绑定匹配/mode 判定）
 * ③ 幂等（-32003 replay / -32002 conflict）④ 结构化消息（start/note/status）→ run ↔ context_id
 * ⑤ 响应 TASK_STATE_DELIVERED 形状（对齐上游 wait:false 异步语义）
 * DSH 侧那半绑定（canvas 远端成员）是主人操作前置——修订 1 如实口径。
 */
export function a2aDirectHandle(body: any, rawBytes: number, runOps: {
  start: (slug: string, startedBy: string) => number;
  saveNote: (runId: number, text: string) => void;
  statusOf: (runId: number) => { status: string; steps: number } | null;
  ctxBind: (contextId: string) => number | null; // context → runId（已绑定）
  ctxRegister: (contextId: string, runId: number) => void;
  /** P3：登记派单来源（task_id/caller/team）与回执地址校验结果 */
  ctxRegisterSource?: (r: { contextId: string; runId: number; taskId: string; caller: string; team: string; receiptStatus: string }) => void;
  /** P3：绑定上的 callback_url（人填；空=不可回执） */
  bindingCallback?: (slug: string, caller: string) => string;
  /** P3：把绑定上的 callback_url 落到 ctx（供 finish 时构造 outbox） */
  ctxAttachCallback?: (runId: number, callbackUrl: string) => void;
}): A2aDirectResult {
  const team = typeof body?.team === 'string' ? body.team : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  const caller = typeof body?.caller_session === 'string' ? body.caller_session : '';
  const contextId = typeof body?.context_id === 'string' && body.context_id !== '' ? body.context_id : `ctx-${Math.random().toString(16).slice(2, 10)}`;
  const taskId = typeof body?.task_id === 'string' && body.task_id !== '' ? body.task_id : `direct-${Math.random().toString(16).slice(2, 10)}`;
  if (rawBytes > A2A_DIRECT_MAX_BYTES) return { httpStatus: 413, body: { error: 'payload exceeds 512 KiB limit', code: -32000, task_id: taskId } };
  if (team === '' || message === '') return { httpStatus: 200, body: { error: 'team and message are required', code: -32000 } };

  // SOP 解析：team = market/<id8> → apps.a2a_node8
  const tm = /^([a-z][a-z0-9-]*)\/([0-9a-f]{8})$/i.exec(team);
  if (!tm) return { httpStatus: 404, body: { error: 'not found' } };
  const sop = db.prepare('SELECT slug, status FROM apps WHERE kind = ? AND a2a_node8 = ?').get('sop', tm[2]) as { slug: string; status: string } | undefined;
  if (!sop) return { httpStatus: 404, body: { error: 'not found' } };

  // 准入（市场侧）：caller 必须精确匹配一条有效绑定（修订 1：DSH 侧 canvas 那半是前置）
  if (caller === '') {
    return { httpStatus: 200, body: { error: 'caller_session is required (anonymous delivery refused)', code: -32000, team, task_status: 'TASK_STATE_FAILED' } };
  }
  const binding = db.prepare("SELECT mode FROM sop_bindings WHERE sop_slug = ? AND node = ? AND revoked_at = ''").get(sop.slug, caller) as { mode: string } | undefined;
  if (!binding) {
    // A10（评审席选项 A，存在性不泄露）：无有效绑定与查无 SOP 同答 404——
    // 200 no-valid-binding 会区分「SOP 存在但未绑定」与「SOP 不存在」
    return { httpStatus: 404, body: { error: 'not found' } };
  }

  // 幂等（上游族：replay -32003 / conflict -32002；在准入后、执行前）
  const verdict = idemClaim(taskId, a2aDirectFingerprint(team, caller, message));
  if (verdict !== 'fresh') {
    const replay = verdict === 'replay';
    return {
      httpStatus: 409,
      body: { error: replay ? 'duplicate task id within the idempotency window' : 'task id reused with a different payload', code: replay ? -32003 : -32002, task_id: taskId, replay },
    };
  }

  // 消息语义（设计取舍 1）：结构化 {"sop":{"action":"start|note|status",...}}；自由文本=开 run + 原文记备注
  let action = 'start';
  let noteText = '';
  let parsed: any = null;
  try {
    parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object' && parsed.sop && typeof parsed.sop.action === 'string') {
      action = parsed.sop.action === 'note' || parsed.sop.action === 'status' ? parsed.sop.action : 'start';
      noteText = typeof parsed.sop.text === 'string' ? parsed.sop.text : '';
    } else { parsed = null; }
  } catch { parsed = null; }
  if (!parsed) noteText = message; // 自由文本 → start + 备注

  if (sop.status !== 'published') {
    return { httpStatus: 200, body: { error: `SOP status is ${sop.status}, not published`, code: -32000, team, task_status: 'TASK_STATE_FAILED' } };
  }
  if (binding.mode !== 'run' && action !== 'status') {
    return { httpStatus: 200, body: { error: 'binding mode is read — only status queries allowed', code: -32000, team, task_status: 'TASK_STATE_FAILED' } };
  }

  // run ↔ context_id：start 续沿同一 context 开新 run；note/status 按 context 找 run
  let runId = runOps.ctxBind(contextId);
  if (action === 'start') {
    runId = runOps.start(sop.slug, caller);
    runOps.ctxRegister(contextId, runId);
    // P3（评审席裁定）：回执只投人建绑定时填的 callback_url；自报 callback 不一致 → rejected 且不写 outbox
    const bindingCb = runOps.bindingCallback?.(sop.slug, caller) ?? '';
    const selfCb = typeof body?.callback === 'string' ? body.callback.trim() : '';
    let receiptStatus = '';
    if (selfCb !== '' && selfCb !== bindingCb) receiptStatus = 'rejected:callback-mismatch';
    else if (bindingCb === '') receiptStatus = '';
    runOps.ctxRegisterSource?.({ contextId, runId, taskId, caller, team, receiptStatus });
    if (receiptStatus === '' && bindingCb !== '') runOps.ctxAttachCallback?.(runId, bindingCb);
  } else if (runId === null) {
    return { httpStatus: 200, body: { error: 'no run bound to this context_id (send a start first)', code: -32000, team, task_id: taskId, task_status: 'TASK_STATE_FAILED' } };
  } else if (action === 'note') {
    runOps.saveNote(runId, noteText || '(empty note)');
  }
  const st = runOps.statusOf(runId);
  return {
    httpStatus: 200,
    body: {
      routed: true,
      delivered: true,
      team,
      session: team, // 市场 SOP 节点即会话面
      task_id: taskId,
      context_id: contextId,
      task_status: 'TASK_STATE_DELIVERED',
      artifacts: [],
      consumed: false,
      receipt: 'routed',
      sop: { slug: sop.slug, run_id: runId, run_status: st?.status ?? 'unknown', steps: st?.steps ?? 0 },
    },
  };
}

// ---------- 出站（#17 P4 的最小面：市场作为客户端向对端派单/发消息） ----------
// 用官方 A2aClient：fetchCardDetail（带 OriginClaim 信封取全卡）+ routeDirect（投递）。
// 三件自实现按官方示例：身份密钥（DATA_DIR/a2a-key.pem）、OriginClaim 签名、fetch/schedule 适配。
export interface OutboundTarget { baseUrl: string; team: string }

function originClaimHeaders(privateKey: KeyObject, zone: string, baseUrl: string): Record<string, string> {
  const ts = Date.now();
  const signature = edSign(undefined, Buffer.from(JSON.stringify([zone, baseUrl, ts]), 'utf8'), privateKey).toString('base64');
  return { 'X-A2A-Caller': zone, 'X-A2A-Caller-Url': baseUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Sig': signature };
}

export async function a2aSendOutbound(keyPath: string, target: OutboundTarget, message: string, contextId?: string): Promise<unknown> {
  const priv = loadOrCreateKey(keyPath);
  const base = process.env.MARKET_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 9800}`;
  const client = new A2aClient({
    apiKey: '',
    sessionId: MARKET_TEAM,
    cardCaller: MARKET_TEAM,
    originClaim: () => originClaimHeaders(priv, MARKET_TEAM, base),
    schedule: (cb: () => void, ms: number) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
    fetch: (url: string, init?: RequestInit) => fetch(url, init).then(async (r) => ({ ok: r.ok, status: r.status, text: () => r.text() })),
  } as never);
  const taskId = `market-${randomBytes(4).toString('hex')}`;
  return client.routeDirect(target.baseUrl, target.team, message, contextId, undefined, MARKET_TEAM, false, taskId);
}
