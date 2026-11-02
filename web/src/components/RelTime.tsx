/** 相对时间（PATTERNS.md §5：显示「3 小时前」，悬停看绝对时间）。服务端时间是 UTC 的 'YYYY-MM-DD HH:mm:ss'。 */
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Tooltip, Typography } from 'antd';

dayjs.extend(relativeTime);

/** 纯日期（如截止日 2026-11-05）按本地日期；带时间但无时区的按 UTC（服务端 SQLite 时间）；带时区的照原样 */
export const parseServerTime = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s)
  ? dayjs(s)
  : dayjs(`${s.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'}`));

export default function RelTime({ value }: { value?: string | null }) {
  if (!value) return <Typography.Text type="secondary">-</Typography.Text>;
  const t = parseServerTime(value);
  if (!t.isValid()) return <Typography.Text type="secondary">{value}</Typography.Text>;
  return (
    <Tooltip title={t.format('YYYY-MM-DD HH:mm:ss')}>
      <Typography.Text type="secondary" className="wm-num wm-caption">{t.fromNow()}</Typography.Text>
    </Tooltip>
  );
}
