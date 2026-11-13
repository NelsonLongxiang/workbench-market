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
import { duplicateNode8s, node8Taken } from './services/a2a-handles.ts';
import { claimA2aTask } from './services/a2a-idempotency.ts';
import { noteA2aError } from './a2a/errors.ts';

export const MARKET_TEAM = process.env.MARKET_TEAM || 'market';
export const CARD_TTL_MS = 45 * 3600 * 1000; // 45h ≤ 上游 48h 预算

/**
 * 名片是否声明 canvasMemberProvenance（a2a-net 0.8 起，对钉了公钥的画布成员只往声明了它的宿主转发——
 * 不声明，席位的回执在对方宿主那一跳就停了）。声明即承诺，市场逐条兑现（测试 scripts/a2a-member-provenance-test.mjs）：
 *   ① 名片 sessionTeams 只列本节点自己服务的句柄，形如 <team>/<8 hex>，同一句柄只对应一个台（存量重复的不上卡）；
 *   ② 发给这些句柄的消息只在本节点投递，绝不转给别的宿主；查无或有歧义一律 404（失败关闭），不解释 @<fp> 后缀；
 *   ③ 句柄只由本节点密钥签发：出站的 OriginClaim 用本名片的密钥签，别的密钥签不出能被验过的「market」消息；
 *   ④ 换钥即换身份：密钥只在 DATA_DIR 首启生成一次，不轮换、不迁移。
 * 开关 WM_A2A_MEMBER_PROVENANCE（缺省 on；off 时名片不声明、行为与之前逐字节相同），启动时由 index.ts 读一次并设进来。
 */
let memberProvenance = true;
export function memberProvenanceMode(env: NodeJS.ProcessEnv = process.env): 'on' | 'off' | null {
  const raw = String(env.WM_A2A_MEMBER_PROVENANCE ?? '');
  if (raw === '' || raw === 'on') return 'on';
  return raw === 'off' ? 'off' : null;
}
export function setMemberProvenance(on: boolean): void { memberProvenance = on; }

/**
 * 名片是否声明 progressReceipts（a2a-net next/0.8 #605 起，宿主只给声明了它的调用方发进展回执 progress-<task>-<n>——
 * 旧接收方遇到不认识的 disposition 会把原派工当成已结清，所以要先能正确收、再声明）。声明即承诺：
 * 进展只记录、不结清、不推状态，认不得的 state 只记录（receipt-inbound.ts 的 progress 分支，测试 scripts/a2a-answers-test.mjs）。
 * 开关 WM_A2A_PROGRESS_RECEIPTS（缺省 on；off 时名片不声明，宿主不发进展），启动时由 index.ts 读一次并设进来。
 */
let progressReceipts = true;
export function progressReceiptsMode(env: NodeJS.ProcessEnv = process.env): 'on' | 'off' | null {
  const raw = String(env.WM_A2A_PROGRESS_RECEIPTS ?? '');
  if (raw === '' || raw === 'on') return 'on';
  return raw === 'off' ? 'off' : null;
}
export function setProgressReceipts(on: boolean): void { progressReceipts = on; }

/**
 * 名片是否声明 teamRoster（a2a-net next/0.8：宿主只给声明了它的画布远端成员推团队名册 [A2A roster]）。
 * 声明了，入站名册照 #581 的规矩收（投递过的宿主、Sig3、节点键取自验过签的公钥、时间上限、只收本区席位）；
 * 不声明，入站名册一律不收（照普通来信走）——不声明就不该有人推，推来的也不认。
 * 开关 WM_A2A_TEAM_ROSTER（缺省 on；off 时名片不声明、不收名册），启动时由 index.ts 读一次并设进来。
 */
let teamRoster = true;
export function teamRosterMode(env: NodeJS.ProcessEnv = process.env): 'on' | 'off' | null {
  const raw = String(env.WM_A2A_TEAM_ROSTER ?? '');
  if (raw === '' || raw === 'on') return 'on';
  return raw === 'off' ? 'off' : null;
}
export function setTeamRoster(on: boolean): void { teamRoster = on; }
export function teamRosterDeclared(): boolean { return teamRoster; }

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
export function sopNode8(slug: string, gen: () => string = () => randomBytes(4).toString('hex')): string {
  const row = db.prepare('SELECT a2a_node8 FROM apps WHERE slug = ?').get(slug) as { a2a_node8?: string } | undefined;
  if (row?.a2a_node8) return row.a2a_node8;
  // 句柄唯一（canvasMemberProvenance 的前提）：避开已占用的；连撞 16 次说明生成器坏了，宁可失败也不发重复句柄
  let id8 = gen();
  for (let i = 0; node8Taken(id8); i++) {
    if (i >= 16) throw new Error('a2a node8 生成连续撞车，拒绝发出重复句柄');
    id8 = gen();
  }
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
  // 联合评审① C：统一绑定表——admits 方向行才上卡（notify-only 行不上）
  const rows = db.prepare(
    `SELECT DISTINCT a.slug, a.title, a.description, a.a2a_node8
       FROM apps a
       JOIN bindings b ON b.target_type = 'sop' AND b.target_slug = a.slug AND b.revoked_at = ''
        AND b.direction IN ('admits','both')
      WHERE a.kind = 'sop' AND a.status = 'published'
      ORDER BY a.slug`
  ).all() as { slug: string; title: string; description: string; a2a_node8: string }[];
  const dup = memberProvenance ? duplicateNode8s() : new Set<string>();
  const sessionTeams = rows.filter((r) => !dup.has(r.a2a_node8)).map((r) => ({
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
    capabilities: { sop: true, bindings: 'human-only', stage: 'P1-readonly', reworkReturns: true, ...(memberProvenance ? { canvasMemberProvenance: true } : {}), ...(progressReceipts ? { progressReceipts: true } : {}), ...(teamRoster ? { teamRoster: true } : {}) },
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

export function a2aDirectFingerprint(team: string, caller: string, message: string): string {
  return `${team}\u0000${caller}\u0000${message}`;
}

/**
 * 市场版 /a2a/direct 准入链（P2）：
 * ① team → SOP 解析（查无 → 404 不泄露）② caller 准入（匿名拒/精确绑定匹配/mode 判定）
 * ③ 幂等（-32003 replay / -32002 conflict）④ 结构化消息（start/note/status）→ run ↔ context_id
 * ⑤ 响应 TASK_STATE_DELIVERED 形状（对齐上游 wait:false 异步语义）
 * DSH 侧那半绑定（canvas 远端成员）是主人操作前置——修订 1 如实口径。
 */
export async function a2aDirectHandle(body: any, rawBytes: number, runOps: {
  uploadToken?: (id: number) => string;
  /** #309 phase2：start 现返回 {id, read_capability}——创建即得 run 级读能力（明文仅此一次） */
  start: (slug: string, startedBy: string) => { id: number; read_capability: string };
  saveNote: (runId: number, text: string) => void | Promise<void>;
  statusOf: (runId: number) => { status: string; steps: number } | null;
  ctxBind: (contextId: string) => number | null; // context → runId（已绑定）
  ctxRegister: (contextId: string, runId: number) => void;
  /** P3：登记派单来源（task_id/caller/team）与回执地址校验结果 */
  ctxRegisterSource?: (r: { contextId: string; runId: number; taskId: string; caller: string; team: string; receiptStatus: string }) => void;
  /** P3：绑定上的 callback_url（人填；空=不可回执） */
  bindingCallback?: (slug: string, caller: string) => string;
  /** P3：把绑定上的 callback_url 落到 ctx（供 finish 时构造 outbox） */
  ctxAttachCallback?: (runId: number, callbackUrl: string) => void;
}): Promise<A2aDirectResult> {
  const team = typeof body?.team === 'string' ? body.team : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  const caller = typeof body?.caller_session === 'string' ? body.caller_session : '';
  const contextId = typeof body?.context_id === 'string' && body.context_id !== '' ? body.context_id : `ctx-${Math.random().toString(16).slice(2, 10)}`;
  const taskId = typeof body?.task_id === 'string' && body.task_id !== '' ? body.task_id : `direct-${Math.random().toString(16).slice(2, 10)}`;
  if (rawBytes > A2A_DIRECT_MAX_BYTES) { noteA2aError('payload-too-large'); return { httpStatus: 413, body: { error: 'payload exceeds 512 KiB limit', code: -32000, task_id: taskId } }; }
  if (team === '' || message === '') { noteA2aError('missing-fields'); return { httpStatus: 200, body: { error: 'team and message are required', code: -32000 } }; }

  // SOP 解析：team = market/<id8> → apps.a2a_node8
  const tm = /^([a-z][a-z0-9-]*)\/([0-9a-f]{8})$/i.exec(team);
  if (!tm) { noteA2aError('unknown-team'); return { httpStatus: 404, body: { error: 'not found' } }; }
  const sop = db.prepare('SELECT slug, status FROM apps WHERE kind = ? AND a2a_node8 = ?').get('sop', tm[2]) as { slug: string; status: string } | undefined;
  if (!sop) { noteA2aError('unknown-team'); return { httpStatus: 404, body: { error: 'not found' } }; }
  // canvasMemberProvenance 义务②：只承接本 zone 的句柄；句柄有歧义（存量随机撞车）时失败关闭。两者都与查无同答
  if (memberProvenance && (tm[1] !== MARKET_TEAM || duplicateNode8s().has(tm[2]))) { noteA2aError('unknown-team'); return { httpStatus: 404, body: { error: 'not found' } }; }

  // 准入（市场侧）：caller 必须精确匹配一条有效绑定（修订 1：DSH 侧 canvas 那半是前置）
  if (caller === '') {
    noteA2aError('anonymous');
    return { httpStatus: 200, body: { error: 'caller_session is required (anonymous delivery refused)', code: -32000, team, task_status: 'TASK_STATE_FAILED' } };
  }
  // 联合评审① C：统一绑定表——admits 方向行（授 notify 不过此门·方向独立性铁律）
  const binding = db.prepare("SELECT mode FROM bindings WHERE target_type = 'sop' AND target_slug = ? AND agent_node = ? AND direction IN ('admits','both') AND revoked_at = ''").get(sop.slug, caller) as { mode: string } | undefined;
  if (!binding) {
    // A10（评审席选项 A，存在性不泄露）：无有效绑定与查无 SOP 同答 404——
    // 200 no-valid-binding 会区分「SOP 存在但未绑定」与「SOP 不存在」
    noteA2aError('not-admitted');
    return { httpStatus: 404, body: { error: 'not found' } };
  }

  // 幂等（上游族：replay -32003 / conflict -32002；在准入后、执行前；登记落库，见 services/a2a-idempotency.ts）
  const verdict = claimA2aTask(taskId, a2aDirectFingerprint(team, caller, message));
  if (verdict !== 'fresh') {
    const replay = verdict === 'replay';
    noteA2aError(verdict);
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
    noteA2aError('sop-not-published');
    return { httpStatus: 200, body: { error: `SOP status is ${sop.status}, not published`, code: -32000, team, task_status: 'TASK_STATE_FAILED' } };
  }
  if (binding.mode !== 'run' && action !== 'status') {
    noteA2aError('read-only-binding');
    return { httpStatus: 200, body: { error: 'binding mode is read — only status queries allowed', code: -32000, team, task_status: 'TASK_STATE_FAILED' } };
  }

  // run ↔ context_id：start 续沿同一 context 开新 run；note/status 按 context 找 run
  let runId = runOps.ctxBind(contextId);
  let startReadCap = '';
  if (action === 'start') {
    const started = runOps.start(sop.slug, caller);
    runId = started.id;
    startReadCap = started.read_capability;
    runOps.ctxRegister(contextId, runId);
    // P3（评审席裁定）：回执只投人建绑定时填的 callback_url；自报 callback 不一致 → rejected 且不写 outbox
    const bindingCb = runOps.bindingCallback?.(sop.slug, caller) ?? '';
    const selfCb = typeof body?.callback === 'string' ? body.callback.trim() : '';
    let receiptStatus = '';
    if (selfCb !== '' && selfCb !== bindingCb) { receiptStatus = 'rejected:callback-mismatch'; noteA2aError('callback-mismatch'); }
    else if (bindingCb === '') receiptStatus = '';
    runOps.ctxRegisterSource?.({ contextId, runId, taskId, caller, team, receiptStatus });
    if (receiptStatus === '' && bindingCb !== '') runOps.ctxAttachCallback?.(runId, bindingCb);
  } else if (runId === null) {
    noteA2aError('no-run-for-context');
    return { httpStatus: 200, body: { error: 'no run bound to this context_id (send a start first)', code: -32000, team, task_id: taskId, task_status: 'TASK_STATE_FAILED' } };
  } else if (action === 'note') {
    await runOps.saveNote(runId, noteText || '(empty note)');
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
      sop: { slug: sop.slug, run_id: runId, run_status: st?.status ?? 'unknown', steps: st?.steps ?? 0, ...(action === 'start' ? { upload_token: runOps.uploadToken?.(runId) ?? '', read_capability: startReadCap } : {}) }, // Write/read credentials only on creation; status/note queries never reissue
    },
  };
}

// ---------- 出站（#17 P4 的最小面：市场作为客户端向对端派单/发消息） ----------
// 用官方 A2aClient：fetchCardDetail（带 OriginClaim 信封取全卡）+ routeDirect（投递）。
// 三件自实现按官方示例：身份密钥（DATA_DIR/a2a-key.pem）、OriginClaim 签名、fetch/schedule 适配。
export interface OutboundTarget { baseUrl: string; team: string }

/** OriginClaim 绑定形式（v2）的域标签——与上游 src/origin-claim.ts ORIGIN_CLAIM_BOUND_TAG 一致，v1 签名永远验不成 v2。 */
export const ORIGIN_CLAIM_BOUND_TAG = 'a2a-origin-claim/2';
/** body 绑定形式（v3）的域标签——与上游 src/origin-claim.ts ORIGIN_CLAIM_BODY_TAG 一致 */
export const ORIGIN_CLAIM_BODY_TAG = 'a2a-origin-claim/3';

/** v1 不绑定签名是否还发（A2A_ORIGIN_CLAIM_UNBOUND=off 停发）；/api/health 的 a2a 块也读它 */
export function originClaimV1Enabled(): boolean {
  return process.env.A2A_ORIGIN_CLAIM_UNBOUND !== 'off';
}

/**
 * OriginClaim 信封（上游 docs/protocol/delivery-origin-auth.md §2.1）：按真实目标 url/method 签。
 * - 绑定形式（v2）：X-A2A-Caller-Aud = 目标 origin，X-A2A-Caller-Sig2 签
 *   [tag, caller, callerUrl, ts, audience, METHOD, path]——只在那台主机、那条路由上有效。#64 关窗后对端只认它。
 * - 不绑定形式（v1）：X-A2A-Caller-Sig 签 [caller, callerUrl, ts]，未升级的对端在开窗期间仍认。默认两种同时带，A2A_ORIGIN_CLAIM_UNBOUND=off 停发 v1。
 * 钉住的 0.6.25 A2aClient 调 originClaim() 不给目标，所以签名放在 fetch 适配层（那里有 url 与 method）。
 */
export function originClaimHeaders(privateKey: KeyObject, zone: string, baseUrl: string, target: { url: string; method: string; body?: string | Uint8Array }, ts = Date.now()): Record<string, string> {
  const sign = (text: string): string => edSign(undefined, Buffer.from(text, 'utf8'), privateKey).toString('base64');
  const headers: Record<string, string> = { 'X-A2A-Caller': zone, 'X-A2A-Caller-Url': baseUrl, 'X-A2A-Caller-Ts': String(ts) };
  // v1 只为未升级对端保留；全舰队关窗后设 A2A_ORIGIN_CLAIM_UNBOUND=off 停发（v1 不绑路由，未升级对端上可被剥 Sig2 重放）
  if (originClaimV1Enabled()) headers['X-A2A-Caller-Sig'] = sign(JSON.stringify([zone, baseUrl, ts]));
  let audience = '';
  let path = '';
  try {
    const u = new URL(target.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') { audience = u.origin; path = u.pathname; }
  } catch { /* 非 http(s) 目标只带 v1 */ }
  if (audience !== '') {
    headers['X-A2A-Caller-Aud'] = audience;
    headers['X-A2A-Caller-Sig2'] = sign(JSON.stringify([ORIGIN_CLAIM_BOUND_TAG, zone, baseUrl, ts, audience, target.method.toUpperCase(), path]));
    // body 绑定形式（v3，上游 a2a-origin-claim/3）：带正文的请求再签一份连正文摘要的，对端宿主间要求 Sig2 与 Sig3 都带。
    // 摘要按真正发出去的字节算（不重新序列化）
    if (target.body !== undefined) {
      const digest = createHash('sha256').update(target.body).digest('base64url');
      headers['X-A2A-Body-Sha256'] = digest;
      headers['X-A2A-Caller-Sig3'] = sign(JSON.stringify([ORIGIN_CLAIM_BODY_TAG, zone, baseUrl, ts, audience, target.method.toUpperCase(), path, digest]));
    }
  }
  return headers;
}

/** 市场对外的基址（OriginClaim 的 callerUrl；对端按它取卡验签） */
export function marketPublicUrl(): string {
  return process.env.MARKET_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 9800}`;
}

/** 带市场 OriginClaim 信封的出站请求头（回执 outbox 等不走 A2aClient 的出站用） */
export function marketOriginClaim(keyPath: string, target: { url: string; method: string; body?: string | Uint8Array }): Record<string, string> {
  return originClaimHeaders(loadOrCreateKey(keyPath), MARKET_TEAM, marketPublicUrl(), target);
}

export async function a2aSendOutbound(keyPath: string, target: OutboundTarget, message: string, contextId?: string, callerSession?: string, opts: { taskId?: string; async?: boolean } = {}): Promise<unknown> {
  const priv = loadOrCreateKey(keyPath);
  const base = marketPublicUrl();
  const client = new A2aClient({
    apiKey: '',
    sessionId: MARKET_TEAM,
    cardCaller: MARKET_TEAM,
    schedule: (cb: () => void, ms: number) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
    fetch: async (url: string, init?: RequestInit) => {
      // The claim is bound to this origin/method/path: never forward it or the payload to Location.
      const r = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init?.headers as Record<string, string> | undefined), ...originClaimHeaders(priv, MARKET_TEAM, base, { url, method: String(init?.method ?? 'GET'), ...(typeof init?.body === 'string' ? { body: init.body } : {}) }) } });
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel();
        throw new Error('A2A redirect rejected: HTTP ' + r.status);
      }
      return { ok: r.ok, status: r.status, text: () => r.text() };
    },
  } as never);
  const taskId = opts.taskId ?? `market-${randomBytes(4).toString('hex')}`;
  // 联合评审①后补：推送 caller 必须是区限定句柄（market/<node8>）——裸 zone 标签在对端
  // free-form 准入分支无画布路径永不可入（.157 实测发现·判据②c2）
  return client.routeDirect(target.baseUrl, target.team, message, contextId, undefined, callerSession ?? MARKET_TEAM, opts.async === true, taskId);
}
