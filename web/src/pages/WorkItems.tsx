/** 事项列表：最上面一排是视角（我安排的 / 我的 AI 员工手上的 / 我的团队的 / 全部，服务端按身份给哪些能用、各几件），
 *  切视角改地址里的 ?view=，刷新、分享链接回到同一个视角；视角里面按状态分组（等你拍板 / 在办 / 已结束 / 未派发）或按对象分组。
 *  数据来自 GET /api/work-items；最近变化的在前，游标翻页。
 *  各组角标用服务端给的按状态计数（覆盖整个可见范围），已取回的行不够时组底注明「已加载 x / 共 n」，页底「加载更多」。 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, Collapse, Empty, Flex, List, Segmented, Skeleton, Space, Tag, Typography } from 'antd';
import { ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import WmPage from '../components/WmPage';
import RelTime from '../components/RelTime';
import { ATTENTION_CHANGED, api, getAttention, getLifecycleNameSources, getRosterTeams } from '../api';
import { adminActive, subscribeAdminToken } from '../admin-token';
import { answerChoices, workItemTurns, type AttentionItem } from '../attention-view';
import { STATE } from './WorkItem';
import { STATE_GROUPS, appendPage, byObject, byState, groupCount, objectName, phaseName, rowLine, rowTime, viewsFor, emptyText, OTHERS_GROUP, othersTurnLabel, splitDecide, avatarChar, lifecycleNames, urlFilter, NO_NAMES, type Names, type View, type ViewKey, type Who, type WorkItemListRow } from '../work-items-view';
import { rosterNames, seatNameOnly, speakerName } from '../people';

/** 列表行里「谁」只写名字（句柄在详情里才带）：席位查名册；来源标记 receiver:<区> 用承接席位顶上，别的去前缀 */
const whoFor = (roster: Record<string, string>): Who => ({
  seat: (x) => seatNameOnly(x, roster),
  actor: (x, seat) => speakerName(x, seat, roster),
});

type Mode = 'state' | 'object';
const MODE_KEY = 'wm-work-items-mode';
const savedMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'object' ? 'object' : 'state'; } catch { return 'state'; } };

/** turn：不轮到你时这一行等的是谁（「等别人处理」组用），有它就用中性色写它，代替状态名 */
function Row({ r, mode, who, names, turn }: { r: WorkItemListRow; mode: Mode; who: Who; names: Names; turn?: string }) {
  const seat = who.seat(r.seat ?? '');
  const st = STATE[r.state];
  const unread = Number(r.unread) || 0;
  return <List.Item data-testid="work-item-row"
    extra={<Space size="middle" align="center">
      {mode === 'object' && phaseName(r.phase, names) ? <Tag>{phaseName(r.phase, names)}</Tag> : null}
      {turn ? <Tag data-testid="work-item-turn">{turn}</Tag> : <Tag color={st?.color ?? 'default'}>{st?.label ?? r.state}</Tag>}
      <RelTime value={rowTime(r)} />
    </Space>}>
    <List.Item.Meta
      avatar={<span className={seat ? 'wm-avatar' : 'wm-avatar wm-avatar-none'} title={seat || '还没有席位'} aria-hidden="true">{avatarChar(seat) || (seat ? <RobotOutlined /> : null)}</span>}
      title={<Space size={6}>
        <Link to={`/work-items/${encodeURIComponent(r.id)}`}>{r.title || r.id}</Link>
        {unread > 0 ? <Badge count={unread} title={`${unread} 条未读的席位消息`} data-testid="work-item-unread" /> : null}
      </Space>}
      description={<Typography.Text type="secondary" ellipsis={{ tooltip: true }}>{rowLine(r, mode, who, names)}</Typography.Text>} />
  </List.Item>;
}

/** 组的件数：只有「等你拍板」用醒目的角标，其余用次要文字，免得满屏红点 */
function Count({ n, urgent }: { n: number; urgent?: boolean }) {
  return urgent && n > 0 ? <Badge count={n} /> : <Typography.Text type="secondary" className="wm-num">{n}</Typography.Text>;
}

function Rows({ rows, mode, empty, total, who, names, turnOf }: { rows: WorkItemListRow[]; mode: Mode; empty: string; total?: number; who: Who; names: Names; turnOf?: (r: WorkItemListRow) => string }) {
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={total ? `还没加载到（共 ${total} 件，往下点「加载更多」）` : empty} />;
  return <>
    <List size="small" dataSource={rows} rowKey="id" renderItem={(r) => <Row r={r} mode={mode} who={who} names={names} turn={turnOf?.(r)} />} />
    {total !== undefined && total > rows.length ? <Typography.Text type="secondary" className="wm-caption">已加载 {rows.length} / 共 {total} 件</Typography.Text> : null}
  </>;
}

export default function WorkItems() {
  const [mode, setMode] = useState<Mode>(savedMode);
  const [rows, setRows] = useState<WorkItemListRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [views, setViews] = useState<View[]>([]);
  const [view, setView] = useState<ViewKey | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [roster, setRoster] = useState<Record<string, string>>({});
  useEffect(() => { void getRosterTeams().then((t) => setRoster(rosterNames(t))); }, []);
  const who = useMemo(() => whoFor(roster), [roster]);
  const [names, setNames] = useState<Names>(NO_NAMES);
  // 哪些事项轮到你：和侧栏角标、全景同一份「关注」、同一个判法（isMyDecision）；读不到是 null，这时不标红
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  // undefined = 还在读（「等你拍板」那一组先用骨架，不先按状态数出一个数再改）；null = 读不到
  const [items, setItems] = useState<AttentionItem[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () => { void getAttention().then((a) => { if (live) setItems(a.status >= 200 && a.status < 300 ? a.items as unknown as AttentionItem[] : null); }); };
    read(); window.addEventListener(ATTENTION_CHANGED, read);
    return () => { live = false; window.removeEventListener(ATTENTION_CHANGED, read); };
  }, []);
  const turns = useMemo(() => (items ? workItemTurns(items, (x) => answerChoices(admin, x)) : null), [items, admin]);
  useEffect(() => { void getLifecycleNameSources().then((x) => setNames(lifecycleNames(x.types, x.objects))); }, []);

  // 地址里带的视角、席位（驾驶舱「AI 员工」点卡过来的）；这个视角对看的人还不能用（403）就退回不带，告诉一声
  const { search } = useLocation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState(() => urlFilter(search));
  useEffect(() => { setFilter(urlFilter(search)); }, [search]);
  const [filterNote, setFilterNote] = useState('');
  const fetchPage = useCallback(async (after: string | null) => {
    setLoading(true); setError('');
    try {
      let page: Awaited<ReturnType<typeof api.listWorkItems>>;
      try { page = await api.listWorkItems({ ...filter, ...(after ? { cursor: after } : {}) }); }
      catch (e) {
        if (!(filter.view || filter.seat) || !/view_unavailable|seat|view_invalid/.test(e instanceof Error ? e.message : '')) throw e;
        setFilterNote('地址里要的视角你现在还看不了，先给你看能看的全部。');
        page = await api.listWorkItems(after ? { cursor: after } : {});
      }
      setRows((prev) => (after ? appendPage(prev, page.items) : page.items));
      if (!after) { setViews(viewsFor(page.views)); setView(page.view ?? null); }
      setCounts(page.counts ?? {}); setTotal(page.total ?? 0); setCursor(page.next_cursor); setLoaded(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '读取失败';
      // 401 是没登录；身份服务连不上（502 identity_unavailable）由请求层（#641）换成「身份服务暂时连不上，稍后再试」，这里原样显示
      setError(/auth_required/.test(msg) ? '请先登录' : msg);
    } finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { setFilterNote(''); void fetchPage(null); }, [fetchPage]);

  const changeMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 存不了就只在本页有效 */ } };
  const grouped = byState(rows);

  return <WmPage
    extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={() => void fetchPage(null)}>刷新</Button>}>
    <Flex vertical gap="middle">
      {filter.seat && !filterNote && <Typography.Text type="secondary" data-testid="work-items-url-filter">
        只看这个 AI 员工手上的：{seatNameOnly(filter.seat, roster)} · <a onClick={() => navigate(`/work-items?view=${view ?? 'seats'}`)}>看这个视角的全部</a>
      </Typography.Text>}
      {filterNote && <Alert type="info" showIcon closable message={filterNote} data-testid="work-items-url-filter-note" onClose={() => setFilterNote('')} />}
      {/* 视角在最上面一排；「按状态 / 按对象」是视角里面的分组 */}
      {/* 只出能用的视角；切换改地址（去掉按席位的筛选），件数是这个视角的全部 */}
      <div className="wm-view-row" role="tablist" aria-label="视角" data-testid="work-items-views">
        {views.map((v) => <button type="button" role="tab" key={v.key} aria-selected={v.key === view} className={v.key === view ? 'wm-view on' : 'wm-view'} data-testid={`work-items-view-${v.key}`}
          onClick={() => { if (v.key !== view || filter.seat) navigate(`/work-items?view=${v.key}`); }}>{v.label}<i>{v.count}</i></button>)}
        <span className="wm-view-group">
          <Typography.Text type="secondary" className="wm-caption">分组</Typography.Text>
          <Segmented<Mode> size="small" value={mode} onChange={changeMode} data-testid="work-items-mode"
            options={[{ label: '按状态', value: 'state' }, { label: '按对象', value: 'object' }]} />
        </span>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {/* 第一页回来之前：骨架，不留白、也不先说「没有」 */}
      {!loaded && !error ? <Card data-testid="work-items-loading"><Skeleton active paragraph={{ rows: 5 }} /></Card> : null}
      {loaded && total === 0 && !error ? <Card data-testid="work-items-empty"><Empty description={emptyText(view, filter.seat)} /></Card> : null}
      {loaded && total > 0 && mode === 'state' ? STATE_GROUPS.flatMap((g) => {
        const n = groupCount(counts, g.key);
        if (g.key === 'decide') {
          if (items === undefined) return [<Card key="decide" size="small" data-testid="work-items-group-decide-loading" title={g.title}><Skeleton active title={false} paragraph={{ rows: 2 }} /></Card>];
          // 「等你拍板」只放轮到你、能当场办的，红色数就是它；别人的另成「等别人处理」，写清等谁，中性色。
          // 读不到「关注」时分不出来：整组叫「等拍板」，不标红
          if (!turns) return [<Card key="decide" size="small" data-testid="work-items-group-decide" title={<Space size={6}><span>等拍板</span><Count n={n} /></Space>}>
            <Rows rows={grouped.decide} mode="state" empty={g.empty} total={n} who={who} names={names} /></Card>];
          const sp = splitDecide(rows, turns.mine, n);
          const label = (r: WorkItemListRow) => othersTurnLabel(r.state, String(turns.byItem.get(r.id)?.creator?.display_name ?? ''));
          return [
            <Card key="decide" size="small" data-testid="work-items-group-decide" title={<Space size={6}><span>{g.title}</span><Count n={sp.mineCount} urgent /></Space>}>
              <Rows rows={sp.mine} mode="state" empty={g.empty} who={who} names={names} /></Card>,
            ...(sp.othersCount > 0 ? [<Card key="others" size="small" data-testid="work-items-group-others" title={<Space size={6}><span>{OTHERS_GROUP.title}</span><Count n={sp.othersCount} /></Space>}>
              <Rows rows={sp.others} mode="state" empty={OTHERS_GROUP.empty} total={sp.othersCount} who={who} names={names} turnOf={label} /></Card>] : []),
          ];
        }
        const head = <Space size={6}><span>{g.title}</span><Count n={n} /></Space>;
        const body = <Rows rows={grouped[g.key]} mode="state" empty={g.empty} total={n} who={who} names={names} />;
        return [g.collapsed
          ? <Collapse key={g.key} data-testid={`work-items-group-${g.key}`} items={[{ key: g.key, label: head, children: body }]} />
          : <Card key={g.key} size="small" title={head} data-testid={`work-items-group-${g.key}`}>{body}</Card>];
      }) : null}
      {loaded && total > 0 && mode === 'object' ? byObject(rows).map((g) => (
        <Card key={g.object || '-'} size="small" data-testid="work-items-object"
          title={<Space size={6}><span>{g.object ? objectName(g.object, names) : '没关联对象'}</span><Count n={g.rows.length} /></Space>}>
          <Rows rows={g.rows} mode="object" empty="这条线上现在没有事项" who={who} names={names} />
        </Card>
      )) : null}
      {loaded && cursor ? <Flex justify="center">
        <Button loading={loading} onClick={() => void fetchPage(cursor)} data-testid="work-items-more">加载更多（已加载 {rows.length} / 共 {total} 件）</Button>
      </Flex> : null}
      {loaded && mode === 'object' && cursor ? <Typography.Text type="secondary" className="wm-caption">按对象分组只数已加载的事项；要看全部，先加载完。</Typography.Text> : null}
    </Flex>
  </WmPage>;
}
