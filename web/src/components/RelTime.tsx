/** 相对时间（PATTERNS.md §5：显示「3 小时前」，悬停看绝对时间）。服务端时间是 UTC 的 'YYYY-MM-DD HH:mm:ss'。 */
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Tooltip, Typography } from 'antd';

dayjs.extend(relativeTime);

export const parseServerTime = (s: string) => dayjs(`${s.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'}`);

export default function RelTime({ value }: { value?: string | null }) {
  if (!value) return <Typography.Text type="secondary">-</Typography.Text>;
  const t = parseServerTime(value);
  if (!t.isValid()) return <Typography.Text type="secondary">{value}</Typography.Text>;
  return (
    <Tooltip title={t.format('YYYY-MM-DD HH:mm:ss')}>
      <Typography.Text type="secondary" className="wm-num" style={{ fontSize: 12 }}>{t.fromNow()}</Typography.Text>
    </Tooltip>
  );
}
