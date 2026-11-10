/**
 * 主体域（principals + principal_identities）：「谁」的那一张表，和挂在主体上的外部身份。
 *
 * 身份服务经契约 PrincipalDirectory（identity.ts）用它：登录提供方认出的人，对到一个主体上才算数。
 *   · 见过的外部身份：取出它的主体。主体停用了就不认。
 *   · 没见过的：建一个人（标识 `user:<对方的用户标识>`）和这条外部身份，同一个事务。
 *   · 标识已经被别的主体占着、却没有绑定这个外部身份：不自动认领（那等于让一个外来账号顶替已有的主体），不认。
 * 停用和恢复是本地动作，改的是 status 这一列；每个入口认人时现查，所以立即生效。
 *
 * 这一版只有「人」在用。席位、台、系统、外部节点只建好了结构（类别、标识前缀、责任人必填由表的约束守着）。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import type { Admission, ExternalIdentity, PrincipalDirectory } from '../identity.ts';

export type PrincipalKind = 'person' | 'seat' | 'app' | 'system' | 'node';
export type PrincipalStatus = 'active' | 'disabled';

export type PrincipalRow = {
  id: string; kind: PrincipalKind; display_name: string; owner: string; status: PrincipalStatus;
  status_changed_at: string; status_changed_by: string; status_reason: string; created_at: string;
};
export type PrincipalIdentity = { provider: string; external_id: string; created_at: string };
export type PrincipalView = PrincipalRow & { identities: PrincipalIdentity[] };

/** 提供方的名字：小写字母、数字、连字符、下划线 */
const providerOk = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v);
/** 对方的用户标识：和身份服务对登录名的要求同一把尺（非空、不超过 128、两头没有空白、没有控制字符） */
const externalIdOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '');

type Bound = { id: string; kind: PrincipalKind; status: PrincipalStatus };

export class PrincipalService extends Service implements PrincipalDirectory {
  constructor(ctx: any) {
    super(ctx, 'principals');
  }

  private boundTo(provider: string, externalId: string): Bound | undefined {
    return db.prepare('SELECT p.id AS id, p.kind AS kind, p.status AS status FROM principal_identities i JOIN principals p ON p.id = i.principal_id WHERE i.provider = ? AND i.external_id = ?')
      .get(provider, externalId) as Bound | undefined;
  }

  /** 把提供方认出的人对到主体。入参形状不对就抛错（身份服务按目录不可用处理，不放行） */
  admit(identity: ExternalIdentity): Admission {
    const provider = identity?.provider, externalId = identity?.externalId;
    if (!providerOk(provider) || !externalIdOk(externalId)) throw new Error('外部身份的形状不对');
    // 登录认出来的只能是人；绑在别的类别上的外部身份（席位的凭据、节点的句柄）不能拿来登录
    const verdict = (b: Bound): Admission => (b.kind !== 'person' ? { ok: false, reason: 'unbound' } : b.status === 'active' ? { ok: true, principal: b.id } : { ok: false, reason: 'disabled' });
    const bound = this.boundTo(provider, externalId);
    if (bound) return verdict(bound);

    const id = `user:${externalId}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      // 拿到写锁之后再看一眼：共用数据目录的另一个实例可能刚建好
      const again = this.boundTo(provider, externalId);
      let out: Admission;
      if (again) out = verdict(again);
      else if (db.prepare('SELECT 1 FROM principals WHERE id = ?').get(id)) out = { ok: false, reason: 'unbound' };
      else {
        db.prepare("INSERT INTO principals (id, kind, display_name) VALUES (?, 'person', ?)").run(id, text(identity.displayName, 256));
        db.prepare('INSERT INTO principal_identities (provider, external_id, principal_id) VALUES (?, ?, ?)').run(provider, externalId, id);
        out = { ok: true, principal: id };
      }
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务没开成 */ }
      throw e;
    }
  }

  get(id: string): PrincipalView | null {
    const row = db.prepare('SELECT * FROM principals WHERE id = ?').get(id) as PrincipalRow | undefined;
    if (!row) return null;
    return { ...row, identities: db.prepare('SELECT provider, external_id, created_at FROM principal_identities WHERE principal_id = ? ORDER BY provider, external_id').all(id) as PrincipalIdentity[] };
  }

  /** 全部主体，连同各自的外部身份。按标识排序 */
  list(): PrincipalView[] {
    const rows = db.prepare('SELECT * FROM principals ORDER BY id').all() as PrincipalRow[];
    const byPrincipal = new Map<string, PrincipalIdentity[]>();
    for (const i of db.prepare('SELECT principal_id, provider, external_id, created_at FROM principal_identities ORDER BY provider, external_id').all() as (PrincipalIdentity & { principal_id: string })[]) {
      const { principal_id, ...identity } = i;
      const list = byPrincipal.get(principal_id);
      if (list) list.push(identity); else byPrincipal.set(principal_id, [identity]);
    }
    return rows.map((r) => ({ ...r, identities: byPrincipal.get(r.id) ?? [] }));
  }

  /** 这个外部身份绑在哪个主体上；没绑为 null */
  principalOf(provider: string, externalId: string): string | null {
    return this.boundTo(provider, externalId)?.id ?? null;
  }

  /**
   * 停用或恢复。主体不存在返回 null；已经是这个状态时不改、不动上一次的变更记录（changed=false）。
   * by 是谁做的（留痕里的写法），reason 是为什么。
   */
  setStatus(id: string, status: PrincipalStatus, by: string, reason: string): { changed: boolean; principal: PrincipalView } | null {
    const changed = db.prepare("UPDATE principals SET status = ?, status_changed_at = datetime('now'), status_changed_by = ?, status_reason = ? WHERE id = ? AND status <> ?")
      .run(status, text(by, 256), text(reason, 500), id, status).changes === 1;
    const principal = this.get(id);
    return principal ? { changed, principal } : null;
  }
}
