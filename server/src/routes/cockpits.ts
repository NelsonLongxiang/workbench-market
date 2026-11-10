/**
 * 驾驶舱的路由（/api/cockpits）。处理函数和两个只有它们用的辅助函数原样搬自 index.ts，一个字没改；
 * 路由那一段只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 这一组路由没有自己的守卫：写请求由 index.ts 里的写请求总门把关，读开放。
 */
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

function validatePanels(raw: unknown): PanelConfig[] {
  if (!Array.isArray(raw)) bad('layout_config 必须是面板数组');
  const seen = new Set<number>();
  return raw.map((p: any) => {
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

export function registerCockpitRoutes(app: HttpService): void {
  app.get('/api/cockpits', (_req, res) => {
    const rows = svc<CockpitService>('cockpit').list() as unknown as CockpitRow[];
    res.json(rows.map(rowToCockpit));
  });

  app.post('/api/cockpits', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) bad('name 不能为空');
    const description = String(req.body?.description ?? '');
    const panels = validatePanels(req.body?.panels ?? []);
    const r = svc<CockpitService>('cockpit').create(name, description, JSON.stringify(panels)) as unknown as { lastInsertRowid: number | bigint };
    res.status(201).json(rowToCockpit(getCockpit(Number(r.lastInsertRowid))));
  });

  app.get('/api/cockpits/:id', (req, res) => {
    res.json(rowToCockpit(getCockpit(Number(req.params.id))));
  });

  app.put('/api/cockpits/:id', (req, res) => {
    const cur = getCockpit(Number(req.params.id));
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : cur.name;
    if (!name) bad('name 不能为空');
    const description = req.body?.description !== undefined ? String(req.body.description) : cur.description;
    const panels = req.body?.panels !== undefined ? validatePanels(req.body.panels) : JSON.parse(cur.layout_config || '[]');
    svc<CockpitService>('cockpit').update(cur.id, name, description, JSON.stringify(panels));
    res.json(rowToCockpit(getCockpit(cur.id)));
  });

  app.delete('/api/cockpits/:id', (req, res) => {
    const cur = getCockpit(Number(req.params.id));
    svc<CockpitService>('cockpit').delete(cur.id);
    res.json({ ok: true });
  });
}
