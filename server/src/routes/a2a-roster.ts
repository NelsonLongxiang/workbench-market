/**
 * 团队名册的读（阶段七，dsh-open-a2a-net#604 P3）：GET /api/a2a/teams。给前端的团队页、侧栏「AI 员工」、把句柄显示成名字、
 * 「安排一件事」的团队选项（名字和在岗数）用。
 *
 * 可见：登录的人即可读（管理员也行）；没登录 401。只有名册里的席位信息，不含任何事项内容。跨站、别的站的页面来的请求拒。
 * 返回 { teams: [{ team, name, host, peer_zone, reported_at, received_at, seats_online, seats: [{ seat, seat_id, name, role, online, active, queued, last_active_at }] }] }：
 *   · seat 是当前句柄（随成员会话变）；seat_id 是宿主给成员位的稳定 id（上游 B1 起有，旧节点是 ''），分配关系以后挂在它上面；
 *   · team 是 <区>/canvas/<名>，name 是名那一段；没写团队的席位归在 team=''、name='' 那一组；
 *   · role 取 router（总工）/ member（成员）/ observer（观察者），宿主没给是 ''；
 *   · active 是这个席位手头在办的事项数——从事项现算（承接是它、还没结束的），不用宿主报的数；queued 是宿主报的排队数，只显示；
 *   · seats_online 是这个团队里在岗的席位数。
 * 名册只当信息，不授予任何东西：页面拿它显示名字和在岗，判定一律不看它。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { identity } from '../identity.ts';
import { activeItemsBySeat, rosters } from '../services/a2a-roster.ts';

export type RosterRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  crossOriginDenied: (req: express.Request) => boolean;
};

/** 不落地的应答：管理门判不过时写的 403 写到这里 */
function silentRes(): express.Response {
  const res: Record<string, unknown> = { statusCode: 200 };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = () => res;
  return res as unknown as express.Response;
}

export function registerRosterRoutes(app: HttpService, deps: RosterRouteDeps): void {
  app.get('/api/a2a/teams', { action: 'a2a.teams-read', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'teams_cross_origin_denied' });
    (async () => {
      await deps.markOdooAdmin(req);
      if (!deps.adminGuard(req, silentRes())) {
        const cookie = String(req.headers.cookie ?? '');
        if (!cookie) return void res.status(401).json({ error: 'teams_auth_required' });
        const who = await identity().resolveViewer(cookie);
        if (!who.ok) return void res.status(401).json({ error: 'teams_auth_required' });
      }
      const active = activeItemsBySeat();
      const teams = new Map<string, { team: string; name: string; host: string; peer_zone: string; reported_at: string; received_at: string; seats: unknown[]; seats_online: number }>();
      for (const r of rosters()) {
        for (const s of r.seats) {
          const key = `${r.host}\u0000${s.team}`;
          let t = teams.get(key);
          if (!t) { t = { team: s.team, name: s.team.split('/').slice(2).join('/'), host: r.host, peer_zone: r.peer_zone, reported_at: r.reported_at, received_at: r.received_at, seats: [], seats_online: 0 }; teams.set(key, t); }
          t.seats.push({ seat: s.seat, seat_id: s.seat_id, name: s.name, role: s.role, online: s.online, active: active.get(s.seat) ?? 0, queued: s.queued, last_active_at: s.last_active_at });
          if (s.online) t.seats_online++;
        }
      }
      res.json({ teams: [...teams.values()] });
    })().catch(next);
  });
}
