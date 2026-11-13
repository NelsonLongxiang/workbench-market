/**
 * 驾驶舱的路由（/api/cockpits）。处理函数和两个只有它们用的辅助函数原样搬自 index.ts，一个字没改；
 * 路由那一段只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 这一组路由没有自己的守卫：写请求由 index.ts 里的写请求总门把关，读开放。
 * 读的应答里带 can：{ edit } 说这个请求能不能改驾驶舱（改名、加面板、删除），页面照它显示编辑入口。
 * 判法由 index.ts 传进来，就是写请求总门对这一个请求的判断（本机命令行，或有效口令、Odoo 管理员且同源）——
 * 「谁能改」从页面挪到服务端算，规则一字不变。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { CockpitService } from '../services/cockpit.ts';
import type { WorkbenchService } from '../services/workbench.ts';
import { rowToCockpit, type CockpitRow, type PanelConfig } from '../db.ts';
import { HttpError, bad } from '../errors.ts';

function getCockpit(id: number): CockpitRow {
  const row = svc<CockpitService>('cockpit').byId(id) as unknown as CockpitRow | undefined;
  if (!row) throw new HttpError(404, `cockpit not found: ${id}`);
  return row;
}

/** 视图面板引用的名字：和台库那边的台标识、视图键同一套字符集（bench-query.ts），这里只用来挡住别的字符 */
const BENCH_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIEW_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_VIEW_PANELS = 24;

function validatePanels(raw: unknown): PanelConfig[] {
  if (!Array.isArray(raw)) bad('layout_config 必须是面板数组');
  const seen = new Set<number>();
  const seenViews = new Set<string>();
  return raw.map((p: any) => {
    // 视图面板（数据视图）：kind='bench-view'，引用一个视图台的一份视图，workbenchId=0 占位。
    // 这里只看形状和字符集：不查这个台、这份视图存不存在，也不查保存的人看不看得到——
    // 看不看得到在取数那一刻按看的人判（/api/bench-views/<台>/render），存下来的只是一个名字。
    if (p?.kind === 'bench-view') {
      const bench = p?.bench, view = p?.view;
      if (typeof bench !== 'string' || !BENCH_SLUG.test(bench)) bad('视图面板的 bench 不是合法的台标识');
      if (typeof view !== 'string' || !VIEW_KEY.test(view)) bad('视图面板的 view 不是合法的视图键');
      const tab = p?.tab === undefined ? 'board' : p.tab;
      if (tab !== 'board' && tab !== 'detail') bad('视图面板的 tab 只能是 board 或 detail');
      const order = p?.order === undefined ? 0 : p.order;
      if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > 9999) bad('视图面板的 order 要是 0 到 9999 的整数');
      const i = `bv-${bench}-${view}`;
      if (seenViews.has(i)) bad(`面板重复引用视图 ${i}`);
      seenViews.add(i);
      if (seenViews.size > MAX_VIEW_PANELS) bad(`一个驾驶舱最多放 ${MAX_VIEW_PANELS} 个视图面板`);
      const vw = Math.min(12, Math.max(1, Number(p?.w) || 6));
      const vh = Math.min(40, Math.max(4, Number(p?.h) || 10));
      return { i, workbenchId: 0, kind: 'bench-view' as const, bench, view, tab, order, x: Math.min(12 - vw, Math.max(0, Number(p?.x) || 0)), y: Math.max(0, Number(p?.y) || 0), w: vw, h: vh };
    }
    // 统一待办卡（omni-inbox）：kind='tasks'，workbenchId=0 占位，不引用工作台
    if (p?.kind === 'tasks' && String(p?.i ?? '') === 'tasks') {
      const tw = Math.min(12, Math.max(3, Number(p?.w) || 6));
      const th = Math.min(40, Math.max(6, Number(p?.h) || 12));
      return { i: 'tasks', workbenchId: 0, kind: 'tasks' as const, x: Math.min(12 - tw, Math.max(0, Number(p?.x) || 0)), y: Math.max(0, Number(p?.y) || 0), w: tw, h: th };
    }
    const workbenchId = Number(p?.workbenchId ?? Number(String(p?.i ?? '').replace('wb-', '')));
    if (!Number.isInteger(workbenchId) || workbenchId < 1) bad(`面板 workbenchId 非法: ${JSON.stringify(p)}`);
    if (seen.has(workbenchId)) bad(`面板重复引用工作台 ${workbenchId}`);
    seen.add(workbenchId);
    if (!svc<WorkbenchService>('workbench').idById(workbenchId)) bad(`面板引用的工作台不存在: ${workbenchId}`);
    const w = Math.min(12, Math.max(1, Number(p?.w) || 6));
    const h = Math.min(40, Math.max(4, Number(p?.h) || 10));
    return {
      i: `wb-${workbenchId}`,
      workbenchId,
      x: Math.min(12 - w, Math.max(0, Number(p?.x) || 0)),
      y: Math.max(0, Number(p?.y) || 0),
      w, h,
    };
  });
}

/** 异步的处理函数：出错（包括取不到驾驶舱的 404）交给错误中间件，和同步的处理函数一样 */
const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => { fn(req, res).catch(next); };

/** 从 index.ts 传进来的：这个请求过不过得了写请求总门（就是「能不能改驾驶舱」） */
export interface CockpitDeps {
  canEdit: (req: express.Request) => Promise<boolean>;
}

export function registerCockpitRoutes(app: HttpService, deps: CockpitDeps): void {
  app.get('/api/cockpits', { action: 'cockpit.list', kind: 'read' }, wrap(async (req, res) => {
    const rows = svc<CockpitService>('cockpit').list() as unknown as CockpitRow[];
    const can = { edit: await deps.canEdit(req) };
    res.json(rows.map((r) => ({ ...rowToCockpit(r), can })));
  }));

  app.post('/api/cockpits', { action: 'cockpit.create', kind: 'admin' }, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) bad('name 不能为空');
    const description = String(req.body?.description ?? '');
    const panels = validatePanels(req.body?.panels ?? []);
    const r = svc<CockpitService>('cockpit').create(name, description, JSON.stringify(panels)) as unknown as { lastInsertRowid: number | bigint };
    res.status(201).json(rowToCockpit(getCockpit(Number(r.lastInsertRowid))));
  });

  app.get('/api/cockpits/:id', { action: 'cockpit.read', kind: 'read' }, wrap(async (req, res) => {
    const row = getCockpit(Number(req.params.id));
    res.json({ ...rowToCockpit(row), can: { edit: await deps.canEdit(req) } });
  }));

  app.put('/api/cockpits/:id', { action: 'cockpit.update', kind: 'admin' }, (req, res) => {
    const cur = getCockpit(Number(req.params.id));
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : cur.name;
    if (!name) bad('name 不能为空');
    const description = req.body?.description !== undefined ? String(req.body.description) : cur.description;
    const panels = req.body?.panels !== undefined ? validatePanels(req.body.panels) : JSON.parse(cur.layout_config || '[]');
    svc<CockpitService>('cockpit').update(cur.id, name, description, JSON.stringify(panels));
    res.json(rowToCockpit(getCockpit(cur.id)));
  });

  app.delete('/api/cockpits/:id', { action: 'cockpit.delete', kind: 'admin' }, (req, res) => {
    const cur = getCockpit(Number(req.params.id));
    svc<CockpitService>('cockpit').delete(cur.id);
    res.json({ ok: true });
  });
}
