/** 单个台的详情（/market/wb/:id）：市场卡片右下角的「详情」入口进来；卡片本身点了照原型直接打开。
 *  头部（图标、名字、类别、在线状态和上次检测时间）、说明和标签、「打开」；管理员多一栏：立即检测、编辑（先回到管理页的那一行）、停用 / 启用。
 *  「这个台的数据视图」：数据视图的台上记着对应的登记台号（#674 的 workbench_id），按它找；找到了列视图的名字（只读），说在驾驶舱里怎么挂。
 *  找不到、没权限、数据视图没开、这个台没有视图——整块不出现，不报错；不按名字去配。
 *  读不到时分「不在了 / 请先登录 / 没权限 / 读不到」各说各的；停用的台对不是管理员的人只说已停用。判断在 web/src/market-view.ts。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { App, Button, Card, Empty, Flex, Popconfirm, Skeleton, Space, Tag, Typography } from 'antd';
import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import './market.css';
import WmPage from '../../components/WmPage';
import RelTime from '../../components/RelTime';
import { api, getBenchViewDoc, getMarketWorkbench, listBenchViews } from '../../api';
import { adminActive, subscribeAdminToken } from '../../admin-token';
import { benchSlugFor, detailProblem, healthLabel, initialOf, manageHref, usableIcon, viewTitles, workbenchIdOf, NO_DESCRIPTION } from '../../market-view';
import type { Workbench } from '../../types';

type State = { phase: 'loading' } | { phase: 'ok'; w: Workbench } | { phase: 'problem'; kind: 'gone' | 'login' | 'denied' | 'error'; text: string };
const TONE: Record<string, string> = { up: 'success', down: 'error' };

export default function WorkbenchDetail() {
  const { id: raw } = useParams();
  const id = workbenchIdOf(raw);
  const navigate = useNavigate();
  const { message } = App.useApp();
  const admin = useSyncExternalStore(subscribeAdminToken, adminActive);
  const [s, setS] = useState<State>({ phase: 'loading' });
  const [busy, setBusy] = useState<'check' | 'toggle' | null>(null);

  const load = useCallback(async () => {
    if (id === null) { setS({ phase: 'problem', ...detailProblem(404)! }); return; }
    setS((cur) => (cur.phase === 'ok' ? cur : { phase: 'loading' }));
    const r = await getMarketWorkbench(id);
    const p = detailProblem(r.status);
    setS(p ? { phase: 'problem', ...p } : { phase: 'ok', w: r.body as Workbench });
  }, [id]);
  useEffect(() => { void load(); }, [load, admin]);
  // 这个台的数据视图：先在数据视图的台清单里按台号找，找到了再取它的视图名。任何一步没取到都当没有（这一块不出现）
  const [views, setViews] = useState<string[]>([]);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    setViews([]);
    void (async () => {
      const list = await listBenchViews();
      const slug = benchSlugFor(list.status, list.body, id);
      if (!slug) return;
      const doc = await getBenchViewDoc(slug);
      if (live) setViews(viewTitles(doc.status, doc.body));
    })();
    return () => { live = false; };
  }, [id]);

  const act = async (what: 'check' | 'toggle', run: () => Promise<Workbench>, done: (w: Workbench) => string) => {
    setBusy(what);
    try { const w = await run(); setS({ phase: 'ok', w }); void message.success(done(w)); }
    catch (e) { void message.error(e instanceof Error ? e.message : '没办成，稍后再试'); }
    finally { setBusy(null); }
  };

  const w = s.phase === 'ok' ? s.w : null;
  const icon = w ? usableIcon(w.icon) : null;
  const hidden = !!w && w.enabled === false && !admin;
  return <WmPage title={w?.name ?? '工作台'} detail={w?.name ?? '工作台'} onBack={() => navigate('/market')}
    extra={w && !hidden && w.enabled !== false ? <Button type="primary" icon={<ExportOutlined />} onClick={() => navigate(`/use/${w.id}`)} data-testid="wbd-open">打开</Button> : undefined}>
    <div className="wm-reading">
      {s.phase === 'loading' && <Card><Skeleton active avatar paragraph={{ rows: 3 }} /></Card>}
      {s.phase === 'problem' && <Card data-testid="wbd-problem" data-kind={s.kind}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={s.text}>
          <Space>
            {s.kind === 'error' && <Button icon={<ReloadOutlined />} onClick={() => void load()}>再试一次</Button>}
            <Link to="/market">回到工作台市场</Link>
          </Space>
        </Empty>
      </Card>}
      {hidden && <Card data-testid="wbd-disabled"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个台已经停用，现在打不开。"><Link to="/market">回到工作台市场</Link></Empty></Card>}
      {w && !hidden && <Flex vertical gap="middle">
        <Card data-testid="wbd-main">
          <Flex vertical gap="middle">
            <div className="wm-wbd-head">
              <span className={icon ? 'wm-mkt-ic' : 'wm-mkt-ic wm-mkt-ic-initial'} aria-hidden>{icon ?? initialOf(w.name)}</span>
              <div>
                <h2 className="wm-wbd-name" data-testid="wbd-name">{w.name}</h2>
                <Space size={6} className="wm-wbd-sub" wrap>
                  {w.category && <span data-testid="wbd-category">{w.category}</span>}
                  <Tag color={TONE[String(w.last_status)] ?? 'default'} data-testid="wbd-status">{healthLabel(w.last_status)}</Tag>
                  {w.last_checked_at && <span>上次检测 <RelTime value={w.last_checked_at} /></span>}
                  {w.enabled === false && <Tag data-testid="wbd-off">已停用</Tag>}
                </Space>
              </div>
            </div>
            {w.description?.trim()
              ? <Typography.Paragraph className="wm-wbd-desc wm-m-0" data-testid="wbd-desc">{w.description.trim()}</Typography.Paragraph>
              : <Typography.Text type="secondary" data-testid="wbd-desc">{NO_DESCRIPTION}</Typography.Text>}
            {Array.isArray(w.tags) && w.tags.length > 0 && <div className="wm-mkt-tags" data-testid="wbd-tags">{w.tags.map((t) => <span key={t} className="wm-mkt-tag">{t}</span>)}</div>}
          </Flex>
        </Card>
        {views.length > 0 && <Card size="small" title={`这个台的数据视图 ${views.length}`} data-testid="wbd-views">
          <Flex vertical gap="small">
            <div className="wm-mkt-tags">{views.map((t) => <span key={t} className="wm-mkt-tag" data-testid="wbd-view">{t}</span>)}</div>
            <Typography.Text type="secondary" className="wm-caption">要在驾驶舱里看：打开一个驾驶舱，点「数据视图」把它们挂上。<Link to="/cockpit">去驾驶舱 →</Link></Typography.Text>
          </Flex>
        </Card>}
        {admin && <Card size="small" title="管理" data-testid="wbd-admin">
          <Flex vertical gap="small">
            <Space wrap>
              <Button loading={busy === 'check'} disabled={busy !== null} onClick={() => void act('check', () => api.checkOne(w.id), (x) => `检测完了：${healthLabel(x.last_status)}`)} data-testid="wbd-check">立即检测</Button>
              <Button onClick={() => navigate(manageHref(w.name))} data-testid="wbd-edit">编辑</Button>
              {w.enabled === false
                ? <Button loading={busy === 'toggle'} disabled={busy !== null} onClick={() => void act('toggle', () => api.updateWorkbench(w.id, { enabled: true }), () => '已启用，市场里又能看到它了')} data-testid="wbd-enable">启用</Button>
                : <Popconfirm title="停用这个台？" description="停用之后市场里不再出现它，也打不开；登记的信息都留着，随时可以再启用。" okText="停用" cancelText="再想想"
                    onConfirm={() => act('toggle', () => api.updateWorkbench(w.id, { enabled: false }), () => '已停用')}>
                    <Button danger loading={busy === 'toggle'} disabled={busy !== null} data-testid="wbd-disable">停用</Button>
                  </Popconfirm>}
            </Space>
            <Typography.Text type="secondary" className="wm-caption">编辑先回到管理页的这一行，在那里改。</Typography.Text>
          </Flex>
        </Card>}
        {!admin && <Typography.Text type="secondary" className="wm-caption" data-testid="wbd-readonly">登记、编辑、停用由管理员来。</Typography.Text>}
      </Flex>}
    </div>
  </WmPage>;
}
