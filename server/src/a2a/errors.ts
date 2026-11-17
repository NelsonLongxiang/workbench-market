/**
 * A2A 拒收原因表（阶段七第 5 步）：每个原因一个键 → 对外的错误码、HTTP 状态、对外文案（原样，不改线上行为），
 * 以及给市场自己看的中文原因和处理办法。
 *
 * public 是 /api/health 里公开计数用的桶。对外刻意答成同一种的原因（查无 SOP 与没有绑定都答 404，
 * 没登记取卡地址、取不到卡、卡上身份不对、签名对不上卡都答 no-card）在公开计数里也并成同一个桶，否则匿名的人发一条请求、
 * 比一下计数涨了哪一格，就能分出「SOP 存在但没绑定」和「SOP 不存在」，或者某个调用方有没有绑定。
 */
export type A2aErrorKey =
  | 'payload-too-large' | 'missing-fields' | 'unknown-team' | 'anonymous' | 'not-admitted'
  | 'replay' | 'conflict' | 'sop-not-published' | 'read-only-binding' | 'no-run-for-context'
  | 'callback-mismatch' | 'receipt:replay' | 'receipt:unaccepted' | 'followup:over-cap' | 'followup:rate-limited' | 'progress:over-cap'
  | 'sig:absent' | 'sig:unbound-only' | 'sig:body-sig-required' | 'sig:bad-shape' | 'sig:bad-ts' | 'sig:wrong-audience'
  | 'sig:identity-mismatch' | 'sig:unregistered' | 'sig:no-card' | 'sig:not-derivable' | 'sig:bad-body-digest' | 'sig:bad-sig' | 'sig:replay';

export interface A2aErrorInfo {
  /** JSON-RPC 风格错误码；没有错误码的（只记录不拒收）为 null */
  code: number | null;
  http: number;
  /** 公开计数的桶 */
  public: string;
  reason: string;
  fix: string;
}

const SIG_FIX = '用 OriginClaim Sig2（X-A2A-Caller/-Url/-Ts/-Aud/-Sig2）签名，密钥用绑定上登记的地址发布的名片里的那把。';

export const A2A_ERRORS: Record<A2aErrorKey, A2aErrorInfo> = {
  'payload-too-large': { code: -32000, http: 413, public: 'payload-too-large', reason: '消息超过 512 KiB 上限。', fix: '拆小消息，或把大内容放到文件里只发引用。' },
  'missing-fields': { code: -32000, http: 200, public: 'missing-fields', reason: '请求里缺 team 或 message。', fix: '补上 team（市场名片里 sessionTeams 的 team）和 message。' },
  'unknown-team': { code: null, http: 404, public: 'not-found', reason: 'team 的格式不对，或者没有这个 SOP 节点。对外与「没有绑定」同答 404，不泄露 SOP 是否存在。', fix: '从市场名片的 sessionTeams 里取 team；SOP 下架或改了节点号要重新取名片。' },
  anonymous: { code: -32000, http: 200, public: 'anonymous', reason: '没带 caller_session，匿名派单一律拒收。', fix: '带上调用方会话（区限定句柄，如 zone/节点号）。' },
  'not-admitted': { code: null, http: 404, public: 'not-found', reason: '调用方在这个 SOP 上没有有效的准入绑定（admits 或 both，未撤销）。对外与查无 SOP 同答 404。', fix: '请市场管理员为这个调用方在该 SOP 上建一条准入绑定。' },
  replay: { code: -32003, http: 409, public: 'replay', reason: '30 分钟内同一个 task_id、同一份内容又发了一次，按重放拒收，没有重复执行。', fix: '不用处理；要再执行一次就换一个 task_id。' },
  conflict: { code: -32002, http: 409, public: 'conflict', reason: '30 分钟内同一个 task_id 带了不同的内容。', fix: '每个任务用新的 task_id；同一任务重发时内容要一致。' },
  'sop-not-published': { code: -32000, http: 200, public: 'sop-not-published', reason: 'SOP 不在已发布状态（草稿或已下架）。', fix: '等 SOP 重新发布后再派单。' },
  'read-only-binding': { code: -32000, http: 200, public: 'read-only-binding', reason: '绑定是只读模式，只能查状态，不能开 run 或写备注。', fix: '只发 status；要执行请管理员把绑定改成 run 模式。' },
  'no-run-for-context': { code: -32000, http: 200, public: 'no-run-for-context', reason: '这个 context_id 还没有绑定 run，note / status 找不到对象。', fix: '先用同一个 context_id 发一次 start。' },
  'callback-mismatch': { code: null, http: 200, public: 'callback-mismatch', reason: '请求自带的回执地址和绑定上登记的不一致：run 照常开，但不发完成回执。', fix: '去掉自带的 callback，或请管理员把绑定上的回执地址改对。' },
  'receipt:replay': { code: -32003, http: 409, public: 'receipt:replay', reason: '同一任务号的这类回执（接单回执或终局回执）已经收过一次，这次没有重复记。', fix: '不用处理；一个任务只有一条接单回执和一条终局回执。' },
  'receipt:unaccepted': { code: null, http: 200, public: 'receipt:unaccepted', reason: '回执签名验过了，但内容市场不采信：disposition 或 outcome 不在约定的词表里（expired / sync_completed / unknown 也不采信），或 idempotencyKey 和回执头的任务号不一致。只记录，不改事项状态。', fix: '结果回执的 outcome 用 completed / failed / rejected / abandoned 之一，idempotencyKey 填回执所答的那个任务号。' },
  'followup:over-cap': { code: null, http: 200, public: 'followup:over-cap', reason: '席位发来的消息（跟进）超过每次投递 50 条的上限：照常回执、照存进事项对话，但不再算未读。', fix: '请席位把多条消息合并。' },
  'followup:rate-limited': { code: -32000, http: 200, public: 'followup:rate-limited', reason: '同一对端 10 分钟内发来的跟进超过限频（WM_A2A_FOLLOWUP_RATE_10MIN，缺省 300）：照常回执，但不存正文、只计数。', fix: '请对端降低跟进频率；或调高限频。' },
  'progress:over-cap': { code: null, http: 200, public: 'progress:over-cap', reason: '同一任务收到的进展超过 200 步：照常应答，但不再记录。', fix: '对端每分钟最多一步，正常不会到；到了说明对端的进展节流坏了。' },
  'sig:absent': { code: -32000, http: 401, public: 'sig:absent', reason: '入站签名设为必验，请求没带签名。', fix: SIG_FIX },
  'sig:unbound-only': { code: -32000, http: 401, public: 'sig:unbound-only', reason: '只带了不绑路由的旧签名（v1），这里不认。', fix: SIG_FIX },
  'sig:body-sig-required': { code: -32000, http: 401, public: 'sig:body-sig-required', reason: '要求同时签 body 摘要（X-WM-Body-Sha256 / X-WM-Body-Sig），请求只签了路由。', fix: '升级调用方，同时发 body 签名。' },
  'sig:bad-shape': { code: -32000, http: 401, public: 'sig:bad-shape', reason: '签名头格式不对或缺项。', fix: SIG_FIX },
  'sig:bad-ts': { code: -32000, http: 401, public: 'sig:bad-ts', reason: '签名时间戳和市场时钟相差超过 5 分钟。', fix: '校准调用方时钟，每次请求现签。' },
  'sig:wrong-audience': { code: -32000, http: 401, public: 'sig:wrong-audience', reason: '签名里的受众不是市场的对外地址。', fix: '按市场对外地址（请求实际打到的源）签受众。' },
  'sig:identity-mismatch': { code: -32000, http: 401, public: 'sig:identity-mismatch', reason: '签名身份、名片 team 与 caller_session 的 zone 对不上。', fix: '用和 caller_session 同一个 zone 的密钥签名。' },
  'sig:unregistered': { code: -32000, http: 401, public: 'sig:no-card', reason: '调用方绑定上没登记取卡地址，市场拿不到公钥。对外与「取不到卡」同答，不泄露绑定是否存在。', fix: '请管理员在绑定上登记调用方的名片地址。' },
  'sig:no-card': { code: -32000, http: 401, public: 'sig:no-card', reason: '从登记地址取不到有效名片（超时、重定向、超过 64 KiB、验签不过）。', fix: '检查调用方名片地址可达、不跳转、名片未过期。' },
  'sig:not-derivable': { code: -32000, http: 401, public: 'sig:no-card', reason: '名片里的公钥无法解析。', fix: '重新签发调用方名片。' },
  'sig:bad-body-digest': { code: -32000, http: 401, public: 'sig:bad-body-digest', reason: 'body 摘要和实际收到的内容对不上（内容被改过）。', fix: '对实际发出的原始字节算摘要再签。' },
  'sig:bad-sig': { code: -32000, http: 401, public: 'sig:no-card', reason: '签名验不过（密钥不对或签名面不一致）。', fix: SIG_FIX },
  'sig:replay': { code: -32000, http: 401, public: 'sig:replay', reason: '同一个签名用过一次了。', fix: '每次请求重新签名。' },
};

/** 拒收计数（进程内，重启清零；since 记起点） */
const counts = new Map<string, number>();
let since = new Date().toISOString();

export function noteA2aError(key: A2aErrorKey): void {
  const info = A2A_ERRORS[key];
  if (!info) return;
  counts.set(info.public, (counts.get(info.public) ?? 0) + 1);
}

/** 公开计数：只有桶，没有原始键 */
export function a2aErrorCounts(): { since: string; counts: Record<string, number> } {
  return { since, counts: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) };
}

/** 测试用：清零 */
export function resetA2aErrorCounts(): void {
  counts.clear();
  since = new Date().toISOString();
}
