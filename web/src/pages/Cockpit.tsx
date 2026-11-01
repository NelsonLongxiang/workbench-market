import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRequest } from 'ahooks';
import { Space, Input, App, Alert, Badge, Button, Card, Col, Empty, Flex, Popconfirm, Select, Spin, Tooltip, Typography } from 'antd';
import { EditOutlined, ArrowLeftOutlined, ExportOutlined, PlusOutlined, ReloadOutlined, CloseOutlined } from '@ant-design/icons';
import GridLayout from 'react-grid-layout';
import { WidthProvider } from 'react-grid-layout';
import type { Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { api } from '../api';
import GoFrame from '../components/GoFrame';
import type { Cockpit as CockpitT, PanelConfig, Workbench } from '../types';
import { surface } from '../surface';
import WmPage from '../components/WmPage';

/** #302 方案③：驾驶舱写（/api/cockpits）是管理写，业务面浏览器发来一律 403；驾驶舱又只在业务面提供。
 *  所以业务面只读：隐藏新建/删除/改名/加移面板，网格不可拖拽，给出命令行提示，免得点了才报 403 */
const READ_ONLY = surface === 'market';
const READ_ONLY_HINT = '业务面不提供驾驶舱编辑（管理写只在控制面或本机命令行做，而驾驶舱页面只在业务面）。新建、加/移面板、改名、删除请在服务器本机用命令行调用 /api/cockpits。';

const Grid = WidthProvider(GridLayout);
const COLS = 12;
const ROW_H = 36;

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

import { TasksView } from './Tasks';

export default function Cockpit() {
  const { id } = useParams();
  const nav = useNavigate();
  const { message } = App.useApp();

  const [panels, setPanels] = useState<PanelConfig[] | null>(null);
  // 驾驶舱改名（监督席 direct-3b98f8c2 用户报障：后端 PUT name 一直在，前端无入口）
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

  // 切换驾驶舱时装载其面板布局
  const loadedId = useRef<number | null>(null);
  useEffect(() => {
    const cur = active?.id ?? null;
    if (loadedId.current !== cur) {
      loadedId.current = cur;
      setPanels(active ? active.panels : null);
    }
  }, [active]);

  const wbById = useMemo(() => new Map(workbenches.map((w) => [w.id, w])), [workbenches]);

  const persist = (next: PanelConfig[], immediate = false) => {
    if (READ_ONLY) return; // 业务面只读：网格对重叠布局的自动归一也不能触发保存（否则不点也会 PUT 403 + 报错）
    setPanels(next);
    if (!active) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const doSave = async () => {
      setSaving(true);
      try {
        await api.updateCockpit(active.id, { panels: next });
      } catch (e) {
        message.error(`布局保存失败：${(e as Error).message}`);
      } finally {
        setSaving(false);
      }
    };
    if (immediate) void doSave();
    else saveTimer.current = setTimeout(doSave, 600);
  };

  const onLayoutChange = (layout: Layout[]) => {
    if (!panels) return;
    const next = layout
      .map((l) => {
        const p = panels.find((p2) => p2.i === l.i);
        return p ? { ...p, x: l.x, y: l.y, w: l.w, h: l.h } : null;
      })
      .filter((p): p is PanelConfig => !!p);
    // GridLayout 初次挂载也触发 onLayoutChange——仅几何真实变化时保存
    const changed = next.some((p) => {
      const o = panels.find((p2) => p2.i === p.i);
      return o && (o.x !== p.x || o.y !== p.y || o.w !== p.w || o.h !== p.h);
    });
    if (changed) persist(next);
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
        subTitle="把常用的 2-4 个工作台拼成一屏分屏视图，按场景切换"
        extra={!READ_ONLY && <Button
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
      <Flex vertical gap={16} style={{ width: '100%' }} align="start">
        {READ_ONLY && <Alert type="info" showIcon className="wm-cockpit-readonly" message="驾驶舱在这里只能查看" description={READ_ONLY_HINT} />}
        {listReq.data?.length ? (
          <Flex gap={16} wrap="wrap" style={{ width: '100%', rowGap: 16 }}>
            {listReq.data.map((c) => (
              <div key={c.id} style={{ flex: '1 1 260px', maxWidth: 360, minWidth: 240 }}>
                <Card hoverable onClick={() => nav(`/cockpit/${c.id}`)} styles={{ body: { padding: 16 } }}>
                  <Flex justify="space-between" align="start" gap={8}>
                    <Flex vertical gap={4}>
                      <Typography.Text strong style={{ fontSize: 15 }}>{c.name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {c.panels.length} 个面板 · {c.updated_at.slice(0, 16).replace('T', ' ')}
                      </Typography.Text>
                    </Flex>
                    {!READ_ONLY && <Popconfirm
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
          <Empty description={READ_ONLY ? '还没有驾驶舱' : '还没有驾驶舱——新建一个，把工作台拼成一屏'} style={{ marginTop: 48 }}>
            {!READ_ONLY && <Button
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
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      </WmPage>
    );
  }

  return (
    <WmPage detail={active.name}>
    <Flex vertical gap={12} style={{ width: '100%' }} align="start">
      <Flex justify="space-between" align="center" gap={12} style={{ width: '100%', flexWrap: 'wrap', rowGap: 8 }}>
        <Flex align="center" gap={8}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/cockpit')} aria-label="返回驾驶舱列表" />
          <Select
            value={active.id}
            style={{ minWidth: 200 }}
            onChange={(v) => nav(`/cockpit/${v}`)}
            options={(listReq.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
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
        {!READ_ONLY && <Button
          disabled={panels.some((p) => p.kind === 'tasks')}
          onClick={() => {
            const maxY = panels.reduce((m, p) => Math.max(m, p.y + p.h), 0);
            persist([...panels, { i: 'tasks', workbenchId: 0, kind: 'tasks' as const, x: 0, y: maxY, w: 6, h: 12 }], true);
          }}
        >
          加待办卡
        </Button>}
      </Flex>
      {READ_ONLY && <Alert type="info" showIcon className="wm-cockpit-readonly" message="驾驶舱在这里只能查看" description={READ_ONLY_HINT} style={{ width: '100%' }} />}

      {panels.length === 0 ? (
        <Empty description={READ_ONLY ? '空驾驶舱' : '空驾驶舱——从右上角选择工作台加入分屏'} style={{ marginTop: 48 }} />
      ) : (
        <Grid
          className="wm-cockpit-grid"
          layout={panels.map((p) => ({ i: p.i, x: p.x, y: p.y, w: p.w, h: p.h, minW: 3, minH: 6 }))}
          cols={COLS}
          rowHeight={ROW_H}
          width={1200}
          draggableHandle=".wm-panel-head"
          draggableCancel=".wm-panel-actions, .wm-panel-actions *"
          isDraggable={!READ_ONLY}
          isResizable={!READ_ONLY}
          onLayoutChange={READ_ONLY ? undefined : onLayoutChange}
        >
          {panels.map((p) => {
            if (p.kind === 'tasks') {
              return (
                <div key={p.i} className="wm-panel">
                  <div className="wm-panel-head">
                    <span className="wm-panel-grip" aria-hidden>⠿</span>
                    <Badge status="processing" text={<Typography.Text strong style={{ fontSize: 13 }}>统一待办</Typography.Text>} />
                    <span className="wm-panel-actions">
                      <Link to="/tasks" style={{ fontSize: 12, marginRight: 8 }}>全部</Link>
                      {!READ_ONLY && <Button size="small" type="text" onClick={() => persist(panels.filter((q) => q.i !== 'tasks'), true)}>移除</Button>}
                    </span>
                  </div>
                  <div className="wm-panel-body" style={{ overflow: 'auto' }}>
                    <TasksView compact />
                  </div>
                </div>
              );
            }
            const w = wbById.get(p.workbenchId);
            const fk = frameKeys[p.workbenchId] ?? 0;
            return (
              <div key={p.i} className="wm-panel">
                <div className="wm-panel-head">
                  <span className="wm-panel-grip" aria-hidden>⠿</span>
                  <Badge
                    status={w?.last_status === 'up' ? 'success' : w?.last_status === 'down' ? 'error' : 'default'}
                    text={
                      <Typography.Text strong style={{ fontSize: 13 }}>
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
        </Grid>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {READ_ONLY ? '' : '拖动面板标题栏移动，右下角拉伸调整大小，布局自动保存 · '}部分工作台通过 X-Frame-Options 禁止内嵌，空白时用「新窗口」打开 ·{' '}
        <Link to="/market">去工作台市场</Link>
      </Typography.Text>
    </Flex>
    </WmPage>
  );
}
