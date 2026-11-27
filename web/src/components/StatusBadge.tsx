import { Badge, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import type { HealthStatus } from '../types';
import { cardHealthKey, type CardHealthKey } from '../bench-link-view';

const map: Record<CardHealthKey, { badge: 'success' | 'error' | 'default' | 'warning'; text: string }> = {
  up: { badge: 'success', text: '在线' },
  down: { badge: 'error', text: '离线' },
  unknown: { badge: 'default', text: '未探测' },
  // #1086 地址是本站的数据视图台页面、还没对应到台：不判离线（悬停写下一步）
  pending: { badge: 'warning', text: '待对应' },
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
  url,
}: {
  status: HealthStatus;
  latency?: number | null;
  error?: string;
  checkedAt?: string;
  /** 卡片地址：是本站 /use/<台> 时显示「待对应」，不显示「离线」（#1086） */
  url?: string;
}) {
  const m = map[cardHealthKey(status, error, url, window.location.origin)] ?? map.unknown;
  const tip: string[] = [];
  if (checkedAt) tip.push(`检测于 ${fmtCheckedAt(checkedAt)}`);
  if (latency != null) tip.push(`延迟 ${latency} ms`);
  if (error) tip.push(`原因：${error}`);
  const node = (
    <span>
      <Badge status={m.badge} text={m.text} />
      {status === 'up' && latency != null ? (
        <Typography.Text type="secondary" className="wm-num wm-caption wm-ml-2">
          {latency}ms
        </Typography.Text>
      ) : null}
    </span>
  );
  return tip.length ? <Tooltip title={tip.join(' · ')}>{node}</Tooltip> : node;
}
