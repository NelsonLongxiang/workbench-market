import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Skeleton, Typography } from 'antd';
import { getLifecycle } from '../api';
import { LINES_DOWN } from '../home-view';
import { loginHref } from '../login-href';
import type { LifecycleRead, LifecycleResult, LifecycleTime } from '../lifecycle-view';

export function useLifecycleData<T>(read: (get: LifecycleRead) => Promise<LifecycleResult<T>>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LifecycleResult<T> | null>(null);
  const [lastGood, setLastGood] = useState<{ value: T; time: LifecycleTime } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => controller.abort(), 12000);
    setLoading(true);
    void read((path) => getLifecycle(path, controller.signal)).then((next) => {
      if (!active) return;
      setResult(next);
      if (next.kind === 'ok') {
        setLastGood({ value: next.value, time: { ...next.time, lastOk: next.time.lastOk ?? new Date().toISOString() } });
      } else if (next.kind === 'login' || next.kind === 'forbidden' || next.kind === 'not-installed') {
        setLastGood(null);
      }
    }).catch(() => {
      if (active) setResult({ kind: 'unknown' });
    }).finally(() => {
      window.clearTimeout(timer);
      if (active) setLoading(false);
    });
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [read, attempt]);
  return { result, lastGood, loading, retry: () => setAttempt((value) => value + 1) };
}

const WORDING = {
  'not-installed': '生命周期功能未接入，暂时无法展示公司的线。',
  unavailable: '生命周期数据暂不可用，登记或依赖尚未就绪。',
  unknown: '暂时无法确认生命周期状态，请稍后重试。',
  login: '请登录后查看',
  forbidden: '当前账号无权查看',
  'identity-down': LINES_DOWN,
  empty: '暂无符合条件的生命周期对象。',
  stale: '数据已过期，以下为上次成功结果',
};

export function LifecycleStatus({ result, loading, admin, retry, last, filter, label }: {
  result: LifecycleResult<unknown> | null;
  loading: boolean;
  admin: boolean;
  retry: () => void;
  last?: { count: number; time: LifecycleTime };
  filter?: string;
  label: string;
}) {
  const location = useLocation();
  const kind = result?.kind === 'ok' ? 'empty' : result?.kind;
  const failure = result && 'requestId' in result ? result : undefined;
  const retryAt = failure?.retryAt;
  const [canRetry, setCanRetry] = useState(false);
  useEffect(() => {
    if (!retryAt) return;
    let timer: number;
    function check() {
      const remaining = (retryAt ?? 0) - Date.now();
      setCanRetry(remaining <= 0);
      if (remaining > 0) timer = window.setTimeout(check, Math.min(remaining, 2147483647));
    }
    check();
    return () => window.clearTimeout(timer);
  }, [retryAt]);
  if (!result || !kind) return <Skeleton active paragraph={{ rows: 4 }} />;
  const historical = kind === 'stale' ? last : undefined;
  const actualTime = kind === 'stale' && 'time' in result ? result.time : undefined;
  const timestamp = historical?.time.lastOk ?? historical?.time.asOf ?? actualTime?.lastOk;
  const retryDisabled = !!retryAt && (!canRetry || Date.now() < retryAt);
  return <section className="wm-home-box" data-testid="lifecycle-state" data-state={kind}
    aria-label={label} aria-busy={loading}>
    <Typography.Text strong>{label}　<span data-testid="lifecycle-kpi">{kind === 'empty' ? 0 : '—'}</span></Typography.Text>
    <p role="status" data-testid={kind === 'identity-down' ? 'home-lines-down' : undefined}>
      {kind === 'stale' && !historical ? '数据已过期，暂无可展示的上次成功结果。' : WORDING[kind]}
      {kind === 'stale' && historical ? (timestamp ? '（' + timestamp + '）' : '。') : null}
    </p>
    {historical && <p>上次成功数量：{historical.count}{historical.time.asOf ? ' · 数据时点 ' + historical.time.asOf : ''}</p>}
    {kind === 'stale' && !historical && timestamp && <p>上次成功时间：{timestamp}</p>}
    {kind === 'stale' && !historical && actualTime?.asOf && <p>数据时点：{actualTime.asOf}</p>}
    {filter && <Typography.Paragraph type="secondary">筛选：{filter}</Typography.Paragraph>}
    {kind === 'not-installed' && admin && <p>联系维护方核扩展交付</p>}
    {kind === 'login' && <Button href={loginHref(null, location.pathname + location.search)}>登录</Button>}
    {(kind === 'unavailable' || kind === 'unknown' || kind === 'stale') && <Button onClick={retry} loading={loading} disabled={retryDisabled}>
      {retryDisabled ? '暂不能重试' : '重试'}
    </Button>}
    {failure?.requestId && <p className="wm-caption">请求编号：{failure.requestId}</p>}
  </section>;
}
