/** 事项列表：按状态分组（等你拍板 / 在办 / 已结束 / 未派发）或按对象分组。
 *  数据来自 GET /api/work-items：管理员看全部，登录的人只看自己建立的；最近变化的在前，游标翻页。
 *  各组角标用服务端给的按状态计数（覆盖整个可见范围），已取回的行不够时组底注明「已加载 x / 共 n」，页底「加载更多」。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Collapse, Empty, Flex, List, Segmented, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { api } from '../api';
import { adminActive, subscribeAdminToken } from '../admin-token';
import { STATE } from './WorkItem';
import { STATE_GROUPS, appendPage, byObject, byState, groupCount, objectName, phaseName, rowLine, rowTime, viewsFor, type Who, type WorkItemListRow } from '../work-items-view';
import { actorLabel, seatLabel } from '../people';

/** 「谁」的写法同事项详情（people.ts）：席位「名字（句柄）」，来源标记去前缀 */
const WHO: Who = { seat: (s) => seatLabel(s), actor: (s, seat) => actorLabel(s, seat) };

type Mode = 'state' | 'object';
const MODE_KEY = 'wm-work-items-mode';
const savedMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'object' ? 'object' : 'state'; } catch { return 'state'; } };

function Row({ r, mode }: { r: WorkItemListRow; mode: Mode }) {
  const st = STATE[r.state];
  const unread = Number(r.unread) || 0;
  return <List.Item data-testid="work-item-row"
    extra={<Space size="middle" align="center">
      {mode === 'object' && phaseName(r.phase) ? <Tag>{phaseName(r.phase)}</Tag> : null}
      <Tag color={st?.color ?? 'default'}>{st?.label ?? r.state}</Tag>
      <RelTime value={rowTime(r)} />
    </Space>}>
    <List.Item.Meta
      title={<Space size={6}>
        <Link to={`/work-items/${encodeURIComponent(r.id)}`}>{r.title || r.id}</Link>
        {unread > 0 ? <Badge count={unread} title={`${unread} 条未读的席位消息`} data-testid="work-item-unread" /> : null}
      </Space>}
      description={<Typography.Text type="secondary" ellipsis={{ tooltip: true }}>{rowLine(r, mode, WHO)}</Typography.Text>} />
  </List.Item>;
}

/** 组的件数：只有「等你拍板」用醒目的角标，其余用次要文字，免得满屏红点 */
function Count({ n, urgent }: { n: number; urgent?: boolean }) {
  return urgent && n > 0 ? <Badge count={n} /> : <Typography.Text type="secondary" className="wm-num">{n}</Typography.Text>;
}

function Rows({ rows, mode, empty, total }: { rows: WorkItemListRow[]; mode: Mode; empty: string; total?: number }) {
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={total ? `还没加载到（共 ${total} 件，往下点「加载更多」）` : empty} />;
  return <>
    <List size="small" dataSource={rows} rowKey="id" renderItem={(r) => <Row r={r} mode={mode} />} />
    {total !== undefined && total > rows.length ? <Typography.Text type="secondary" className="wm-caption">已加载 {rows.length} / 共 {total} 件</Typography.Text> : null}
  </>;
}

export default function WorkItems() {
  // 只用来说明接口现在给的是哪个可见范围（管理员是全部）；视角由服务端按身份给出之后，这一处换成接口的字段
  const seesAll = useSyncExternalStore(subscribeAdminToken, adminActive);
  const [mode, setMode] = useState<Mode>(savedMode);
  const [rows, setRows] = useState<WorkItemListRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchPage = useCallback(async (after: string | null) => {
    setLoading(true); setError('');
    try {
      const page = await api.listWorkItems(after ? { cursor: after } : {});
      setRows((prev) => (after ? appendPage(prev, page.items) : page.items));
      setCounts(page.counts ?? {}); setTotal(page.total ?? 0); setCursor(page.next_cursor); setLoaded(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '读取失败';
      setError(/auth_required/.test(msg) ? '请先登录' : msg);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void fetchPage(null); }, [fetchPage]);

  const changeMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 存不了就只在本页有效 */ } };
  const grouped = byState(rows);

  return <WmPage
    extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void fetchPage(null)}>刷新</Button>}>
    <Flex vertical gap="middle">
      {/* 视角在最上面一排；「按状态 / 按对象」是视角里面的分组 */}
      <div className="wm-view-row" data-testid="work-items-views">
        {viewsFor(seesAll, total).map((v) => <span key={v.key} className="wm-view on" data-testid={`work-items-view-${v.key}`}>{v.label}{loaded ? <i>{v.count}</i> : null}</span>)}
        <span className="wm-view-group">
          <Typography.Text type="secondary" className="wm-caption">分组</Typography.Text>
          <Segmented<Mode> size="small" value={mode} onChange={changeMode} data-testid="work-items-mode"
            options={[{ label: '按状态', value: 'state' }, { label: '按对象', value: 'object' }]} />
        </span>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {loaded && total === 0 && !error ? <Card><Empty description="还没有事项" /></Card> : null}
      {loaded && total > 0 && mode === 'state' ? STATE_GROUPS.map((g) => {
        const n = groupCount(counts, g.key);
        const head = <Space size={6}><span>{g.title}</span><Count n={n} urgent={g.key === 'decide'} /></Space>;
        const body = <Rows rows={grouped[g.key]} mode="state" empty={g.empty} total={n} />;
        return g.collapsed
          ? <Collapse key={g.key} data-testid={`work-items-group-${g.key}`} items={[{ key: g.key, label: head, children: body }]} />
          : <Card key={g.key} size="small" title={head} data-testid={`work-items-group-${g.key}`}>{body}</Card>;
      }) : null}
      {loaded && total > 0 && mode === 'object' ? byObject(rows).map((g) => (
        <Card key={g.object || '-'} size="small" data-testid="work-items-object"
          title={<Space size={6}><span>{g.object ? objectName(g.object) : '没关联对象'}</span><Count n={g.rows.length} /></Space>}>
          <Rows rows={g.rows} mode="object" empty="这条线上现在没有事项" />
        </Card>
      )) : null}
      {loaded && cursor ? <Flex justify="center">
        <Button loading={loading} onClick={() => void fetchPage(cursor)} data-testid="work-items-more">加载更多（已加载 {rows.length} / 共 {total} 件）</Button>
      </Flex> : null}
      {loaded && mode === 'object' && cursor ? <Typography.Text type="secondary" className="wm-caption">按对象分组只数已加载的事项；要看全部，先加载完。</Typography.Text> : null}
    </Flex>
  </WmPage>;
}
