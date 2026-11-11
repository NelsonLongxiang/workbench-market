/**
 * A2A 人工绑定的路由（/api/bindings），和 4 条退役的旧面（一律 410，Location 指向新面），
 * 连同只有它们用的 maskKey。原样搬自 index.ts，一个字没改；路由那一段只多了两格缩进。SQL 在 BindingService 里。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { BindingService } from '../services/binding.ts';
import type { AppRow } from '../db.ts';
import { sopNode8 } from '../a2a.ts';
import { HttpError, bad } from '../errors.ts';

/** 从 index.ts 传进来的：管理员守卫、按 slug 取台（别的路由也用）。 */
export interface BindingDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  getApp: (slug: string) => AppRow;
}

function maskKey(v: string): string {
  return v ? '****' : '';
}

export function registerBindingRoutes(app: HttpService, deps: BindingDeps): void {
  const { adminGuard, getApp } = deps;
  app.get('/api/bindings', { action: 'binding.list', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const type = req.query.type === 'app' ? 'app' : 'sop';
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) bad('slug 必填：/api/bindings?type=(sop|app)&slug=x');
    const rows = svc<BindingService>('binding').listFor(type, slug);
    res.json(rows.map((r: { remote_api_key: string }) => ({ ...r, remote_api_key: maskKey(r.remote_api_key) })));
  });

  app.post('/api/bindings', { action: 'binding.create', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const b = req.body ?? {};
    const targetType = b.target_type === 'app' ? 'app' : 'sop';
    const slug = typeof b.target_slug === 'string' ? b.target_slug.trim() : '';
    const node = typeof b.agent_node === 'string' ? b.agent_node.trim() : '';
    // 评审注 A（direction 显式铁律）：缺 direction 一律 400——不许静默默认任何方向
    const direction = b.direction;
    if (direction !== 'admits' && direction !== 'notify' && direction !== 'both') bad('direction 必填且只许 admits|notify|both（显式选择·无默认）');
    if (!slug) bad('target_slug 必填');
    // 画布队名与上游 canvas-store validName 同规则：trim 后 1–40 字符、不含 /、不能是纯数字（中间可有空格）
    const canvasName = /^[a-z][a-z0-9-]*\/canvas\/([^/]{1,40})$/i.exec(node)?.[1];
    if (!(canvasName !== undefined ? canvasName.trim() === canvasName && !/^\d+$/.test(canvasName) : /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9_-]{0,63}$/i.test(node))) bad('agent_node 形态：<zone>/<id8> 或画布队 <zone>/canvas/<name>，如 dsh/1a2b3c4d、dsh/canvas/procurement');
    const a = getApp(slug);
    if (a.kind !== targetType) bad(`target_type=${targetType} 与台型不符（${slug} 是 ${a.kind}）`);
    const mode = targetType === 'sop' && b.mode === 'run' ? 'run' : 'read'; // app 行 mode 恒 read（跨型 CHECK）
    const remoteKey = targetType === 'sop' && typeof b.remote_api_key === 'string' ? b.remote_api_key.trim() : '';
    const notifyRaw = typeof b.notify_url === 'string' ? b.notify_url.trim().replace(/\/+$/, '') : '';
    if (notifyRaw !== '' && !/^https?:\/\/[^\s]+$/.test(notifyRaw)) bad('notify_url 必须是 http(s):// 根地址（达对端：回执投递/推送基址，也是入站验签的取卡地址）');
    // admits+read 不发回执（P3 口径），但 notify_url 照样留：它是 /a2a/direct 入站验签的取卡地址；notify 向必须带 notify_url
    const notifyUrl = notifyRaw;
    if ((direction === 'notify' || direction === 'both') && notifyUrl === '') bad('notify 向绑定必须携带 notify_url');
    if (targetType === 'sop') sopNode8(slug); // 确保节点短 id 已生成（上卡用）
    // natural key 命中 → upsert（重绑=刷新字段并复活撤销态·绑定管理语义），首绑/重绑皆 201
    const existing = svc<BindingService>('binding').idByNaturalKey(targetType, slug, node, direction) as { id: number } | undefined;
    if (existing) {
      svc<BindingService>('binding').refresh(mode, notifyUrl, remoteKey, existing.id);
      res.status(201).json({ ok: true, id: existing.id, upserted: true, target_type: targetType, target_slug: slug, agent_node: node, direction, mode, notify_url: notifyUrl, remote_api_key: maskKey(remoteKey) });
      return;
    }
    const r = svc<BindingService>('binding').insert(targetType, slug, node, direction, mode, notifyUrl, remoteKey, 'admin') as unknown as { lastInsertRowid: number | bigint };
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), target_type: targetType, target_slug: slug, agent_node: node, direction, mode, notify_url: notifyUrl, remote_api_key: maskKey(remoteKey) });
  });

  app.delete('/api/bindings/:id', { action: 'binding.delete', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const id = Number(req.params.id);
    const hit = svc<BindingService>('binding').activeId(id) as { id: number } | undefined;
    if (!hit) throw new HttpError(404, `binding not found: ${id}`);
    svc<BindingService>('binding').revoke(id);
    res.json({ ok: true, revoked: id });
  });

  // 旧面 410 过渡（评审注 B：一版 Location 指新面，下一版 404）——UI/脚本切换缓冲
  app.all('/api/sops/:slug/bindings', { action: 'binding.legacy', kind: 'admin' }, (req, res) => {
    const loc = `/api/bindings?type=sop&slug=${encodeURIComponent(String(req.params.slug ?? ''))}`;
    res.set('Location', loc).status(410).json({ error: '绑定面已统一：GET/POST /api/bindings（direction 显式必填）', location: loc });
  });
  app.all('/api/sops/:slug/bindings/:id', { action: 'binding.legacy', kind: 'admin' }, (req, res) => {
    res.set('Location', '/api/bindings').status(410).json({ error: '绑定面已统一：DELETE /api/bindings/:id', location: '/api/bindings' });
  });
  app.all('/api/apps/:slug/bindings', { action: 'binding.legacy', kind: 'admin' }, (req, res) => {
    const loc = `/api/bindings?type=app&slug=${encodeURIComponent(String(req.params.slug ?? ''))}`;
    res.set('Location', loc).status(410).json({ error: '绑定面已统一：GET/POST /api/bindings（direction 显式必填）', location: loc });
  });
  app.all('/api/apps/:slug/bindings/:id', { action: 'binding.legacy', kind: 'admin' }, (req, res) => {
    res.set('Location', '/api/bindings').status(410).json({ error: '绑定面已统一：DELETE /api/bindings/:id', location: '/api/bindings' });
  });
}
