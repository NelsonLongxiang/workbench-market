import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { Space, Input, App, Badge, Button, Card, Col, Empty, Flex, Popconfirm, Popover, Select, Spin, Tooltip, Typography } from 'antd';
import { EditOutlined, ExportOutlined, PlusOutlined, ReloadOutlined, CloseOutlined } from '@ant-design/icons';
import 'react-resizable/css/styles.css';
import { api } from '../api';
import GoFrame from '../components/GoFrame';
import type { Cockpit as CockpitT, PanelConfig, Workbench } from '../types';
import { useSyncExternalStore } from 'react';
import { adminActive, subscribeAdminToken } from '../admin-token';
import WmPage from '../components/WmPage';
import CockpitFrame from '../components/cockpit/CockpitFrame';
import { AttentionPane, ItemsPane, ProcessPane, StaffPane } from '../components/cockpit/SidePanes';
import ArrangeDrawer from '../components/ArrangeDrawer';
import BenchViewTab from '../components/cockpit/BenchViewTab';
import BenchViewManage from '../components/cockpit/BenchViewManage';
import { benchViewRefs, isBenchViewPanel, itemsTabLabel, mainTabKeys, refsOfTab } from '../cockpit-frame-view';

/** 驾驶舱写（/api/cockpits）是管理写：不是管理员（口令或 Odoo 管理员）时只读，隐藏新建/删除/改名/加移面板，网格不可拖拽 */
/** 不是管理员时的一行说明：只说只能看、谁来调，不教人去拿口令（新外壳也没有顶栏口令入口） */
const READ_ONLY_LIST = '驾驶舱你只能看，新建和调整由管理员来。';
const READ_ONLY_HINT = '这个驾驶舱你只能看，布局由管理员调整。';
const NO_PICKS: Record<string, string> = {};


function PanelHeadActions(props: { wid: number; url?: string; onRefresh: () => void; onRemove?: () => void }) {
  return (
    <span className="wm-panel-actions">
      <Tooltip title="刷新此面板">
        <ReloadOutlined onClick={props.onRefresh} />
      </Tooltip>
      {props.url && (
        <Tooltip title="新窗口打开">
          <a href={props.url} target="_blank" rel="noreferrer">
            <ExportOutlined />
          </a>
        </Tooltip>
      )}
      {props.onRemove && (
        <Tooltip title="移除此面板">
          <CloseOutlined onClick={props.onRemove} />
        </Tooltip>
      )}
    </span>
  );
}


export default function Cockpit() {
  // 管理身份（口令或 Odoo 管理员）：只用在不属于某一个驾驶舱的地方——新建驾驶舱、右栏事项的标签。
  // 改某一个驾驶舱（改名、加面板、删除……）照服务端在这个驾驶舱上给的 can.edit
  const ADMIN = useSyncExternalStore(subscribeAdminToken, adminActive);
  const { id } = useParams();
  const nav = useNavigate();
  const { message } = App.useApp();

  const [panels, setPanels] = useState<PanelConfig[] | null>(null);
  // 驾驶舱改名（监督席 direct-3b98f8c2 用户报障：后端 PUT name 一直在，前端无入口）
  const [attentionCount, setAttentionCount] = useState<number | null>(null);
  const [itemsView, setItemsView] = useState<unknown>(undefined);
  /** 左栏点了「看办理过程」的那件事项；右栏跟着切到「办理过程」 */
  const [picked, setPicked] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<string | null>(null);
  const [arrange, setArrange] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // 数据视图那排共用筛选里人选的值：一个驾驶舱一份，「看板」「明细」共用；只在这一页的内存里
  const [viewPicks, setViewPicks] = useState<Record<number, Record<string, string>>>({});
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const submitRename = async () => {
    if (!active) return;
    const name = renameValue.trim();
    if (!name) { message.warning('名称不能为空'); return; }
    try {
      await api.updateCockpit(active.id, { name });
      message.success('已重命名');
      setRenaming(false);
      listReq.refresh();
    } catch (e) {
      message.error(`重命名失败：${(e as Error).message}`);
    }
  };
  const [saving, setSaving] = useState(false);
  const [frameKeys, setFrameKeys] = useState<Record<number, number>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listReq = useRequest(api.listCockpits);
  const wbsReq = useRequest(api.listWorkbenches, { pollingInterval: 30000 });
  const workbenches = wbsReq.data ?? [];

  const active: CockpitT | undefined = useMemo(
    () => listReq.data?.find((c) => String(c.id) === id),
    [listReq.data, id]
  );
  const READ_ONLY = active?.can?.edit !== true;
  // 口令输入、清掉、换了 Odoo 管理员之后，服务端算的 can 会变：重读一次
  useEffect(() => subscribeAdminToken(() => listReq.refresh()), [listReq.refresh]);

  // 切换驾驶舱时装载其面板布局
  const loadedId = useRef<number | null>(null);
  useEffect(() => {
    const cur = active?.id ?? null;
    if (loadedId.current !== cur) {
      loadedId.current = cur;
      // 数据视图的引用不进面板栅格（它们画在「看板」「明细」页签里）
      setPanels(active ? active.panels.filter((p) => !isBenchViewPanel(p)) : null);
    }
  }, [active]);

  const wbById = useMemo(() => new Map(workbenches.map((w) => [w.id, w])), [workbenches]);
  // #320 读时迁移：渲染用吸附到 3/4/6/12 的布局，不回写；管理员真改动时才存吸附后的值

  const persist = (next: PanelConfig[], immediate = false) => {
    if (READ_ONLY) return; // 业务面只读：网格对重叠布局的自动归一也不能触发保存（否则不点也会 PUT 403 + 报错）
    setPanels(next);
    if (!active) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const doSave = async () => {
      setSaving(true);
      try {
        // 存布局时把数据视图的引用原样带回去，不能因为拖了一下面板就把它们丢掉
        await api.updateCockpit(active.id, { panels: [...next, ...active.panels.filter((p) => isBenchViewPanel(p))] });
      } catch (e) {
        message.error(`布局保存失败：${(e as Error).message}`);
      } finally {
        setSaving(false);
      }
    };
    if (immediate) void doSave();
    else saveTimer.current = setTimeout(doSave, 600);
  };

  const addPanels = (wbIds: number[]) => {
    if (!panels) return;
    const maxY = panels.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    const next = [...panels];
    for (const wid of wbIds) {
      if (panels.some((p) => p.workbenchId === wid)) continue;
      next.push({ i: `wb-${wid}`, workbenchId: wid, x: 0, y: maxY, w: 6, h: 12 });
    }
    persist(next, true);
  };

  const removePanel = (wid: number) => {
    if (!panels) return;
    persist(panels.filter((p) => p.workbenchId !== wid), true);
  };

  const inCockpit = new Set((panels ?? []).map((p) => p.workbenchId));

  // ---------- 列表视图 ----------
  if (!id) {
    return (
      <WmPage
        subTitle="一屏看住一条线或一个工作台：中间是它的看板和明细，左边是等你拍板的，右边是办理过程"
        extra={ADMIN && <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={async () => {
              try {
                const c = await api.createCockpit({ name: `驾驶舱 ${(listReq.data?.length ?? 0) + 1}` });
                message.success('已创建，添加工作台面板开始使用');
                nav(`/cockpit/${c.id}`);
              } catch (e) {
                message.error(`创建失败：${(e as Error).message}`);
              }
            }}
          >
            新建驾驶舱
          </Button>}
      >
      <Flex vertical gap={16} className="wm-w-full" align="start">
        {!ADMIN && <Typography.Text type="secondary" className="wm-cockpit-readonly wm-caption">{READ_ONLY_LIST}</Typography.Text>}
        {listReq.data?.length ? (
          <Flex gap={16} wrap="wrap" className="wm-w-full" style={{ rowGap: 16 }}>
            {listReq.data.map((c) => (
              <div key={c.id} style={{ flex: '1 1 260px', maxWidth: 360, minWidth: 240 }}>
                <Card hoverable onClick={() => nav(`/cockpit/${c.id}`)} styles={{ body: { padding: 16 } }}>
                  <Flex justify="space-between" align="start" gap={8}>
                    <Flex vertical gap={4}>
                      <Typography.Text strong className="wm-text-subtitle">{c.name}</Typography.Text>
                      <Typography.Text type="secondary" className="wm-caption">
                        {c.panels.length} 个面板 · {c.updated_at.slice(0, 16).replace('T', ' ')}
                      </Typography.Text>
                    </Flex>
                    {c.can?.edit === true && <Popconfirm
                      title={`删除「${c.name}」？`}
                      onConfirm={async (e) => {
                        e?.stopPropagation();
                        try {
                          await api.deleteCockpit(c.id);
                          message.success('已删除');
                          listReq.refresh();
                        } catch (err) {
                          message.error(`删除失败：${(err as Error).message}`);
                        }
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button size="small" type="text" danger onClick={(e) => e.stopPropagation()}>
                        删除
                      </Button>
                    </Popconfirm>}
                  </Flex>
                </Card>
              </div>
            ))}
          </Flex>
        ) : (
          <Empty description={!ADMIN ? '还没有驾驶舱' : '还没有驾驶舱。建一个，就能一屏看住一条线或一个工作台的看板、等你拍板的事和办理过程'} style={{ marginTop: 48 }}>
            {ADMIN && <Button
              type="primary"
              onClick={() => api.createCockpit({ name: '我的驾驶舱' }).then((c) => nav(`/cockpit/${c.id}`))}
            >
              新建驾驶舱
            </Button>}
          </Empty>
        )}
      </Flex>
      </WmPage>
    );
  }

  // ---------- 单驾驶舱视图 ----------
  if (listReq.loading || !active || panels === null) {
    return (
      <WmPage detail={active?.name}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      </WmPage>
    );
  }

  // 骨架照原型的驾驶舱：左「等你拍板」；中间的页签——「看板」「明细」留给数据视图的块（这个驾驶舱配了才出现），
  // 内嵌的工作台单独放「工作台」页签，按栏宽单列排、一个台占满栏宽（要并排看的用放大）；右「事项」
  // 顶上一排照原型：左边留给「看的是 …」（现在没有筛选来源，不放）；右边是操作。
  // 改名、加面板不常驻，收进「编辑」；切换驾驶舱在侧栏「我的驾驶舱」里，顶上不再放下拉。
  const editPanel = (
    <Flex vertical gap={8} className="wm-ck-edit" data-testid="ck-edit-panel">
      <Flex align="center" gap={8}>
          {READ_ONLY ? null : renaming ? (
            <Input
              size="small"
              style={{ width: 180 }}
              defaultValue={active.name}
              onChange={(e) => setRenameValue(e.target.value)}
              onPressEnter={submitRename}
              autoFocus
              suffix={(
                <Space size={2}>
                  <Button type="link" size="small" onClick={submitRename}>确定</Button>
                  <Button type="link" size="small" onClick={() => setRenaming(false)}>取消</Button>
                </Space>
              )}
            />
          ) : (
            <Button size="small" icon={<EditOutlined />} onClick={() => { setRenameValue(active.name); setRenaming(true); }}>改名</Button>
          )}
          {!READ_ONLY && <Typography.Text type="secondary">{saving ? '保存中…' : '布局已自动保存'}</Typography.Text>}
      </Flex>
        {!READ_ONLY && <Select
          mode="multiple"
          placeholder="添加工作台面板"
          style={{ minWidth: 260 }}
          value={[]}
          showSearch
          // optionFilterProp 被 antd-cli 标弃用（建议移入 showSearch 对象），但本机
          // antd 5.29.3 类型 showSearch 仅 boolean——spread 绕过静态检查，运行时照常生效
          {...{ optionFilterProp: 'label' }}
          onChange={(vals: number[]) => {
            if (vals.length) addPanels(vals);
          }}
          options={workbenches
            .filter((w) => !inCockpit.has(w.id))
            .map((w: Workbench) => ({
              value: w.id,
              label: `${w.icon || '▢'} ${w.name}（${w.last_status === 'up' ? '在线' : w.last_status === 'down' ? '离线' : '未探测'}）`,
            }))}
        />}
        {!READ_ONLY && <Button onClick={() => { setEditOpen(false); setViewsOpen(true); }} data-testid="ck-bv-manage">数据视图</Button>}
    </Flex>
  );
  // 顶上右边：「就这个安排一件事」（原型）；管理员另有「编辑」（改名、加面板），不常驻
  const extra = <>
    {!READ_ONLY && <Popover trigger="click" placement="bottomRight" content={editPanel} open={editOpen} onOpenChange={setEditOpen}>
      <Button icon={<EditOutlined />} data-testid="ck-edit">编辑</Button>
    </Popover>}
    <Button type="primary" icon={<PlusOutlined />} onClick={() => setArrange(true)} data-testid="ck-arrange">就这个安排一件事</Button>
  </>;
  const refs = benchViewRefs(active.panels);
  const board = (
    <Flex vertical gap={12} className="wm-w-full wm-ck-pad" align="start">
      {READ_ONLY && <Typography.Text type="secondary" className="wm-cockpit-readonly wm-caption">{READ_ONLY_HINT}</Typography.Text>}

      {panels.filter((p) => p.kind !== 'tasks').length === 0 ? (
        <Empty description={READ_ONLY ? '这个驾驶舱里还没有要看的东西' : '这个驾驶舱里还没有要看的东西——点右上角「编辑」，加一个工作台进来'} style={{ marginTop: 48 }} />
      ) : (
        <div className="wm-ck-benches" data-testid="ck-benches">
          {[...panels].sort((a, b) => a.y - b.y || a.x - b.x).map((p) => {
            // 「统一待办」卡随 /tasks 一起退役（旧页面删除清单第二批）：存着的面板数据不动，页面不再画它；要看事项去右栏「事项」
            if (p.kind === 'tasks') return null;
            const w = wbById.get(p.workbenchId);
            const fk = frameKeys[p.workbenchId] ?? 0;
            return (
              <div key={p.i} className="wm-panel">
                <div className="wm-panel-head">
                  <Badge
                    status={w?.last_status === 'up' ? 'success' : w?.last_status === 'down' ? 'error' : 'default'}
                    text={
                      <Typography.Text strong className="wm-text-body">
                        {w?.icon || '▢'} {w?.name ?? `工作台 #${p.workbenchId}`}
                      </Typography.Text>
                    }
                  />
                  <PanelHeadActions
                    wid={p.workbenchId}
                    url={w?.url}
                    onRefresh={() => setFrameKeys((m) => ({ ...m, [p.workbenchId]: (m[p.workbenchId] ?? 0) + 1 }))}
                    onRemove={READ_ONLY ? undefined : () => removePanel(p.workbenchId)}
                  />
                </div>
                <div className="wm-panel-body">
                  {w ? (
                    <GoFrame wid={w.id} name={w.name} frameKey={fk} />
                  ) : (
                    <Empty description={`工作台 #${p.workbenchId} 已不存在`} style={{ marginTop: 32 }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Flex>
  );
  return (
    <WmPage detail={active.name} wide>
      <CockpitFrame storageKey={String(active.id)} extra={extra}
        left={{ id: 'attention', tabs: [{ key: 'attention', label: '等你拍板', count: attentionCount, content: <AttentionPane onCount={setAttentionCount} picked={picked} onPick={(id) => { setPicked(id); setRightTab('process'); }} /> }] }}
        main={{ id: 'board', tabs: mainTabKeys(refs, panels.length).map((k) => (k === 'benches'
          ? { key: 'benches', label: '工作台', content: board }
          : { key: k, label: k === 'board' ? '看板' : '明细', content: <BenchViewTab key={k} refs={refsOfTab(refs, k)} chosen={viewPicks[active.id] ?? NO_PICKS} onChosen={(next) => setViewPicks((cur) => ({ ...cur, [active.id]: next }))} /> })) }}
        right={{ id: 'items', active: rightTab, onTab: setRightTab, tabs: [
          { key: 'process', label: '办理过程', content: <ProcessPane itemId={picked} /> },
          { key: 'staff', label: 'AI 员工', content: <StaffPane /> },
          { key: 'items', label: itemsTabLabel(itemsView, ADMIN), content: <ItemsPane onView={setItemsView} /> },
        ] }} />
      <ArrangeDrawer open={arrange} onClose={() => setArrange(false)} />
      {!READ_ONLY && <BenchViewManage cockpit={active} open={viewsOpen} onClose={() => setViewsOpen(false)} onSaved={listReq.refresh} />}
    </WmPage>
  );
}
