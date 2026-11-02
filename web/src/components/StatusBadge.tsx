import { Badge, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import type { HealthStatus } from '../types';

const map: Record<HealthStatus, { badge: 'success' | 'error' | 'default'; text: string }> = {
  up: { badge: 'success', text: '在线' },
  down: { badge: 'error', text: '离线' },
  unknown: { badge: 'default', text: '未探测' },
};

/** SQLite datetime('now') 是 UTC，补 Z 转本地时区展示 */
export function fmtCheckedAt(s?: string): string {
  if (!s) return '';
  return dayjs(`${s.replace(' ', 'T')}Z`).format('MM-DD HH:mm:ss');
}

export default function StatusBadge({
  status,
  latency,
  error,
  checkedAt,
}: {
  status: HealthStatus;
  latency?: number | null;
  error?: string;
  checkedAt?: string;
}) {
  const m = map[status] ?? map.unknown;
  const tip: string[] = [];
  if (checkedAt) tip.push(`检测于 ${fmtCheckedAt(checkedAt)}`);
  if (latency != null) tip.push(`延迟 ${latency} ms`);
  if (error) tip.push(`原因：${error}`);
  const node = (
    <span>
      <Badge status={m.badge} text={m.text} />
      {status === 'up' && latency != null ? (
        <Typography.Text type="secondary" className="wm-num wm-caption" style={{ marginLeft: 8 }}>
          {latency}ms
        </Typography.Text>
      ) : null}
    </span>
  );
  return tip.length ? <Tooltip title={tip.join(' · ')}>{node}</Tooltip> : node;
}
