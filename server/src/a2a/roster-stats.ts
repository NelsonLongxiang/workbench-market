/**
 * 团队名册入站的结果计数（health 的 a2a.roster）：名册「悄悄不收」的各种原因在这里都看得到。
 * 名册停推、或者推来了却没收下，过去市场这边哪里都看不出来（试联名册停更两个多小时才发现）。
 *
 * 只有计数和最近一次的时间，没有对端的标识、地址、团队名——/api/health 是匿名可读的。进程内、重启清零（和 refused 一样）。
 * 结果：
 *   recorded            收下了（最新的一份，替换旧的）
 *   stale               不比已收下的那份新（宿主报的时间没往前走），没替换
 *   not_accepted        节点键或首行指纹和验过签的公钥对不上、时间缺失或超过收到时间加签名时间窗
 *   host_conflict       这个节点键已经由别的根地址报过
 *   not_delivered_peer  来源不是投递过的宿主（照普通来信走）
 *   unverified          签名验不过（照普通来信走）
 *   not_declared        名片没声明 teamRoster（WM_A2A_TEAM_ROSTER=off，照普通来信走）
 */
export const ROSTER_OUTCOMES = ['recorded', 'stale', 'not_accepted', 'host_conflict', 'not_delivered_peer', 'unverified', 'not_declared'] as const;
export type RosterOutcome = (typeof ROSTER_OUTCOMES)[number];

const counts = new Map<RosterOutcome, { count: number; last_at: string }>();
let since = new Date().toISOString();

export function noteRoster(outcome: RosterOutcome, now = Date.now()): void {
  const c = counts.get(outcome) ?? { count: 0, last_at: '' };
  counts.set(outcome, { count: c.count + 1, last_at: new Date(now).toISOString() });
}

/** 各结果的次数和最近一次的时间；没发生过的不列 */
export function rosterOutcomeCounts(): { since: string; outcomes: Record<string, { count: number; last_at: string }> } {
  return { since, outcomes: Object.fromEntries(ROSTER_OUTCOMES.filter((o) => counts.has(o)).map((o) => [o, { ...counts.get(o)! }])) };
}

/** 测试用：清零 */
export function resetRosterOutcomeCounts(): void { counts.clear(); since = new Date().toISOString(); }
