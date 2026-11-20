/**
 * 团队的决策卡入站（观察者落地 T8，信封 v1）：/a2a/direct 上和回执、名册并列的一条窄分流。
 *
 * 只有正文以 `[A2A decision-card] v1` 开头才走这里，其余返回 null、照原路走（应答不变）。走了这里就不再回落：
 *   1. 签名：只认绑定正文的 Sig3（verifyReceiptSigner，和回执同一处：取签名方声称的来源上的名片验签、核受众和时间窗、
 *      已用的签名落库防重放）。签名方的区取自它此刻有效的名册（名册里没有这台宿主的，一律不收）。
 *      不跟 WM_A2A_DIRECT_SIG 的 accept 走：accept 下签名没核成会按未签名放行，这条路上不行。
 *   2. 公钥必须是对端登记表里 active、钉住的那把（pinnedVerdict = ok）；没登记、待确认、停用的都不收。
 *   3. 卡上的团队在签名宿主此刻有效的名册里：别的宿主报不了这台宿主的团队的卡。
 *   4. 形状（services/a2a-decision-cards.ts 的 parseDecisionCardDoc），落库按 rev 和终态的规矩。
 * 应答：签名不对 401，团队不在它名册里 403，形状不对 400，这个团队在等的卡到上限 429，都不落库；收下 200 { ok, status: stored | duplicate | stale }。
 * 对外只给代号，不说是哪一步不对的细节（不泄露登记、名册里有什么）；内部计数分开记。
 */
import type { IncomingMessage } from 'node:http';
import { originOf } from '../a2a-direct-sig.ts';
import { verifyReceiptSigner } from './receipt-inbound.ts';
import { keyFingerprint, pinnedVerdict } from '../services/a2a-peers.ts';
import { liveRosterZone } from '../services/a2a-roster.ts';
import { applyDecisionCard, DECISION_CARD_HEAD, DECISION_CARD_TEXT_MAX, parseDecisionCardDoc, teamInSignerRoster } from '../services/a2a-decision-cards.ts';

type Req = IncomingMessage & { body?: unknown; rawBody?: Buffer };
type Out = { status: number; body: Record<string, unknown> };

/** 内部计数（不进对外应答）：每种结局各记一类 */
const counts: Record<string, number> = {};
export const decisionCardCounts = (): Readonly<Record<string, number>> => ({ ...counts });
const note = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };

const refuse = (status: number, code: string, why: string): Out => { note(why); return { status, body: { ok: false, error: code } }; };

export async function handleInboundDecisionCard(req: Req, deps: { audiences: () => string[]; now?: () => number }): Promise<Out | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : '';
  const nl = message.indexOf('\n');
  if ((nl < 0 ? message : message.slice(0, nl)).trim() !== DECISION_CARD_HEAD) return null;
  if (message.length > DECISION_CARD_TEXT_MAX) return refuse(400, 'decision-card-too-large', 'too_large');
  const now = deps.now?.() ?? Date.now();
  const root = originOf(String(req.headers['x-a2a-caller-url'] ?? ''));
  const zone = liveRosterZone(root);
  if (!zone) return refuse(401, 'untrusted-origin', 'not_in_roster');
  const verdict = await verifyReceiptSigner(req, req.rawBody ?? Buffer.alloc(0), { task_id: '', kind: 'delivery', event_id: '', delivery_id: 0, peer_root: root, peer_zone: zone }, deps.audiences(), now);
  if (!verdict.ok) return refuse(401, 'untrusted-origin', `sig_${verdict.reason}`);
  if (pinnedVerdict(root, verdict.publicKey) !== 'ok') return refuse(401, 'untrusted-origin', 'not_pinned');
  let raw: unknown = null;
  try { raw = JSON.parse(nl < 0 ? '' : message.slice(nl + 1)); } catch { raw = null; }
  const parsed = parseDecisionCardDoc(raw);
  if (!parsed.ok) return refuse(400, 'decision-card-invalid', `bad_${parsed.reason}`);
  const fp = keyFingerprint(verdict.publicKey);
  if (!teamInSignerRoster(parsed.doc.card.team, root, fp)) return refuse(403, 'team-not-bound', 'team_not_bound');
  const status = applyDecisionCard({ peerRoot: root, keyFingerprint: fp }, parsed.doc, now);
  note(status);
  // 这个团队在等的卡已经到上限：新卡不收（已有的卡照常改状态）
  if (status === 'limited') return { status: 429, body: { ok: false, error: 'too-many-waiting' } };
  return { status: 200, body: { ok: true, status } };
}
