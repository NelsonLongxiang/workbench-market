/** 事项的时间线（详情页和驾驶舱右栏「办理过程」共用）：日志只增不改，每条事实一行；被拒的（表里没有、终态之后才到）也留一行「收到，未采信」，带原因。
 *  连续的进展上报、连续的未采信记录收成一组，点开看。名字怎么显示由用的地方给（nameOf）。 */
import { Empty, Space, Tag, Timeline, Typography } from 'antd';
import { describe, type LogRow } from '../attention-view';
import { rowActor } from '../work-item-view';
import { VIEWER_NONE, askIdOf, groupTimeline, stateLabel, timelineLabel, type Viewer } from '../work-item-view';

/** 状态的颜色和中性叫法（不带「你」；列表页也用它）。详情页按看的人能做什么另取叫法：stateLabel */
const STATE_COLOR: Record<string, string> = {
  draft: 'default', held: 'default', delivered: 'blue', accepted: 'cyan', progress: 'geekblue', waiting: 'orange',
  blocked: 'gold', ready: 'green', done: 'success', failed: 'error', dropped: 'default', cancelled: 'default',
};
export const STATE: Record<string, { label: string; color: string }> = Object.fromEntries(Object.entries(STATE_COLOR).map(([k, color]) => [k, { label: stateLabel(k), color }]));

const FACT: Record<string, string> = {
  create: '建立', submit: '提交', release: '放行', withdraw: '撤回', delivery: '投递结果', eval: '接单判断', report: '进展上报', ask: '席位问了',
  receipt: '回执', verify: '验收', return: '打回重做', answer: '答复', note: '备注',
};

const REJECTED: Record<string, string> = { not_allowed: '这时候不该有这条事实', terminal: '事项已经结束之后才到' };
function LogLine({ row, askIds, nameOf }: { row: LogRow; askIds?: Set<string>; nameOf?: (s: string) => string }) {
  const ask = askIdOf(row);
  const jump = ask && askIds?.has(ask) && !(row.fact_id ?? '').includes(':closes-ask:') ? ask : null;
  return <div data-testid="timeline-row">
    <Space wrap size={4}>
      <Typography.Text strong>{timelineLabel(row, FACT)}</Typography.Text>
      {jump && <Typography.Link data-testid="timeline-ask-link" onClick={() => document.getElementById(`ask-${jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>看这条提问</Typography.Link>}
      {row.from_state !== row.to_state ? <>{stateTag(row.from_state)}→{stateTag(row.to_state)}</> : null}
      {row.rejected && <Tag color="default">收到，未采信：{REJECTED[row.rejected] ?? row.rejected}</Tag>}
    </Space>
    <div><Typography.Text type="secondary">{row.at} · {nameOf ? nameOf(rowActor(row)) : rowActor(row)}</Typography.Text></div>
    {describe(row) && <div>{describe(row)}</div>}
  </div>;
}
export const stateTag = (s: string, viewer: Viewer = VIEWER_NONE) => <Tag color={STATE[s]?.color ?? 'default'}>{stateLabel(s, viewer)}</Tag>;

/** askIds：这页上列出来的提问号；时间线里提到它们时给「看这条提问」（在页面里滚过去）。驾驶舱里不传 */
export default function WorkItemTimeline({ log, askIds, nameOf }: { log: LogRow[]; askIds?: Set<string>; nameOf?: (s: string) => string }) {
  if (log.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有记录" />;
  return <Timeline items={groupTimeline(log).map((g) => g.kind === 'row'
    ? { key: g.row.seq, color: g.row.rejected ? 'gray' : g.row.from_state !== g.row.to_state ? 'blue' : 'green', children: <LogLine row={g.row} askIds={askIds} nameOf={nameOf} /> }
    : { key: `${g.kind}-${g.rows[0].seq}`, color: g.kind === 'rejected' ? 'gray' : 'green', children: <details data-testid={g.kind === 'rejected' ? 'timeline-rejected' : 'timeline-progress'}><summary><Typography.Text type="secondary">{g.kind === 'rejected'
      ? `${g.rows.length} 条收到、未采信的记录（${REJECTED[g.rows[0].rejected] ?? g.rows[0].rejected}）`
      : `席位报了 ${g.rows.length} 次进展（最新一次在「正在处理」里）`}</Typography.Text></summary>{g.rows.map((row) => <LogLine key={row.seq} row={row} askIds={askIds} nameOf={nameOf} />)}</details> })} />;
}
