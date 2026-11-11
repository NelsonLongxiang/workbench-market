/** 「等你拍板」里审核类卡片的纯函数（不碰 React，scripts/review-ui-unit.mjs 直接测；只引类型）。
 *  变更申请（回滚 / 删除一个工作台或技能）当场办：数据是「关注」条目上的 detail（#580）。
 *  统一待办的条目不是审核（kind：任务、SOP 执行……），没有当场的答法，按 kind 说清是什么。 */
import type { AttentionItem } from './attention-view';

export type ChangeDetail = {
  kind: 'app' | 'skill'; op: 'rollback' | 'delete'; slug: string; title: string; exists: boolean;
  current_version: number | null; target_version: number | null; target_changelog: string;
  requested_by: string; reason: string; created_at: string; irreversible: boolean; impact?: { versions: number; files: number };
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 取变更申请的 detail：只认 change-requests 来源、kind 和 op 认得的；别的字段形状不对就按空值收，不让卡片崩 */
export function changeDetailOf(item: Pick<AttentionItem, 'source'> & { detail?: unknown }): ChangeDetail | null {
  if (item.source !== 'change-requests' || !item.detail || typeof item.detail !== 'object') return null;
  const d = item.detail as Record<string, unknown>;
  if ((d.kind !== 'app' && d.kind !== 'skill') || (d.op !== 'rollback' && d.op !== 'delete')) return null;
  const imp = d.impact && typeof d.impact === 'object' ? d.impact as Record<string, unknown> : null;
  return {
    kind: d.kind, op: d.op, slug: str(d.slug), title: str(d.title), exists: d.exists !== false,
    current_version: num(d.current_version), target_version: num(d.target_version), target_changelog: str(d.target_changelog),
    requested_by: str(d.requested_by), reason: str(d.reason), created_at: str(d.created_at),
    irreversible: d.irreversible === true || d.op === 'delete',
    ...(imp ? { impact: { versions: num(imp.versions) ?? 0, files: num(imp.files) ?? 0 } } : {}),
  };
}

const KIND: Record<ChangeDetail['kind'], string> = { app: '工作台', skill: '技能' };
const nameOf = (d: ChangeDetail): string => d.title.trim() || d.slug;

/** 卡片上怎么写一条变更申请：一句标题、几行说明（要动什么、影响多大、申请理由）、提醒（对象已经不在了） */
export function changeCard(d: ChangeDetail): { title: string; lines: string[]; warn: string } {
  const what = KIND[d.kind], name = nameOf(d);
  const lines: string[] = [];
  if (d.op === 'rollback') {
    const to = d.target_version === null ? '没写要回到哪一版' : `回到第 ${d.target_version} 版${d.target_changelog ? `（${d.target_changelog}）` : ''}`;
    lines.push(d.current_version === null ? to : `现在是第 ${d.current_version} 版，${to}`);
  } else if (d.impact) {
    lines.push(`会一并删掉 ${d.impact.versions} 个版本、${d.impact.files} 个文件，删了收不回来。`);
  } else {
    lines.push('删了收不回来。');
  }
  lines.push(d.reason.trim() ? `申请理由：${d.reason.trim()}` : '没写申请理由');
  return {
    title: d.op === 'rollback' ? `回滚${what}「${name}」${d.target_version === null ? '' : `到第 ${d.target_version} 版`}` : `删除${what}「${name}」`,
    lines,
    warn: d.exists ? '' : `这个${what}已经不在了，这条申请办不成，可以直接不通过。`,
  };
}

/** 答法的叫法：变更申请叫「通过 / 不通过」；别的来源用卡片通用的叫法（返回 null） */
export function reviewAnswerLabel(source: string, answer: string, item?: { source: string; detail?: unknown }): string | null {
  if (source !== 'change-requests') return null;
  if (answer === 'reject') return '不通过';
  if (answer !== 'approve') return null;
  // 按钮上就写清后果：通过并删除 / 通过并回滚；读不出是哪一种时只写「通过」（点了会先确认）
  const d = item ? changeDetailOf(item) : null;
  return d ? (d.op === 'delete' ? '通过并删除' : '通过并回滚') : '通过';
}

/** 这一步要不要先填一句：变更申请不通过必须写理由（≤500 字，会记在申请上） */
export const REVIEW_NEEDS: Record<string, Record<string, { key: string; label: string; max: number }>> = {
  'change-requests': { reject: { key: 'reason', label: '不通过的理由（必填，会记在这条申请上）', max: 500 } },
};

/** 点下去之前要不要再确认一次，以及确认时说什么；不用确认返回 null。
 *  变更申请：通过一条删除申请要确认（写清会删掉什么）；通过回滚、不通过都不用（不通过已经要写理由）。
 *  别的来源：撤回、不给这类收不回来的要确认。 */
export function confirmText(item: Pick<AttentionItem, 'source'> & { detail?: unknown }, answer: string): string | null {
  const d = changeDetailOf(item);
  if (item.source === 'change-requests') {
    if (answer !== 'approve') return null;
    // 读不出这条申请要动什么（可能是删除）：照收不回来的办，先确认
    if (!d) return '读不出这条申请要动什么。通过之后可能收不回来，最好先去看清楚。';
    if (!d.irreversible) return null;
    return d.impact ? `会删掉${KIND[d.kind]}「${nameOf(d)}」的 ${d.impact.versions} 个版本、${d.impact.files} 个文件，删了收不回来。` : `会删掉${KIND[d.kind]}「${nameOf(d)}」，删了收不回来。`;
  }
  return answer === 'withdraw' || answer === 'reject' ? '这一步做了就收不回来。' : null;
}

/** 统一待办条目是哪一类（#580 的 kind）：不是审核，卡片标签按它写；不是统一待办的返回 null */
const TASK_KIND: Record<string, string> = { task: '任务中心的任务', 'sop-run': 'SOP 执行', ygl: '研究待办', a2a: '团队来的待办', other: '待办' };
export function taskKindLabel(item: Pick<AttentionItem, 'source'> & { kind?: unknown }): string | null {
  if (item.source !== 'tasks') return null;
  return TASK_KIND[typeof item.kind === 'string' ? item.kind : 'other'] ?? TASK_KIND.other;
}
