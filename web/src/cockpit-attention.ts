/** 驾驶舱左栏「等你拍板」的紧凑行（照原型 3fbfd0b 的驾驶舱：一行一条，标题、一行小字、右边一个标签，没有按钮）。
 *  选中一行后，右栏「办理过程」上面放这一条的答法（DecisionCard，和全景同一套），下面是时间线。
 *  哪些算「等你拍板」、件数多少，和侧栏角标、全景同一个判法（attention-view 的 groupCards / isMyDecision），这里不另判。
 *  纯函数，不引别的文件：scripts/cockpit-attention-unit.mjs 直接测。 */

type Item = { source: string; source_id: string; category: string; link?: string };

/** 一条的键：来源 + 来源里的编号（同一件事项可能有几条，例如一条验收、一条席位提问） */
export const rowKey = (x: Pick<Item, 'source' | 'source_id'>): string => `${x.source}:${x.source_id}`;

/** 右边的标签：等你做什么。在问你的写「某某在问你」（who 是问的人的名字，页面用 people.ts 的 waitingLabel 给，没有就不写名字） */
export function rowTag(x: Pick<Item, 'category'>, who = ''): string {
  const name = who.trim();
  switch (x.category) {
    case 'accept': return '等你验收';
    case 'glance': return '等你过目';
    case 'ask': return name ? `${name} 在问你` : '在问你';
    case 'grant': return '等你核准';
    case 'review': return '等你审核';
    default: return '等你处理';
  }
}

/** 标签的颜色档：和全景卡片同一组（问的用金色，验收绿，过目灰，核准紫，审核蓝） */
export const TAG_COLOR: Record<string, string> = { ask: 'gold', accept: 'green', glance: 'default', grant: 'purple', review: 'blue' };

/** 选中的那一条还在不在列表里（答完一条它会从「关注」里消失，右栏就回到没选的样子） */
export function stillThere(picked: string | null, rows: Pick<Item, 'source' | 'source_id'>[]): boolean {
  return picked !== null && rows.some((r) => rowKey(r) === picked);
}
