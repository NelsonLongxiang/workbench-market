/**
 * 主体域（principals + principal_identities）：「谁」的那一张表，和挂在主体上的外部身份。
 *
 * 身份服务经契约 PrincipalDirectory（identity.ts）用它：登录提供方认出的人，对到一个主体上才算数。
 *   · 见过的外部身份：取出它的主体。主体停用了就不认。
 *   · 没见过的：建一个人（标识 `user:<对方的用户标识>`）和这条外部身份，同一个事务。
 *   · 标识已经被别的主体占着、却没有绑定这个外部身份：不自动认领（那等于让一个外来账号顶替已有的主体），不认。
 *   · 「占着」按规范化之后的值算（comparisonKey，即 Unicode 的 NFKC_Casefold）：只差大小写、全角半角、夹零宽字符的写法算撞上，同样不认、不另建。
 *     只拒不并——两个写法到底是不是同一个人，这里判断不了，交给管理员。
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

/**
 * 比较用的规范化值：Unicode 的 NFKC_Casefold（NFKC_CF）。
 *
 * 出处：Unicode 标准第 3.13 节的「兼容大小写无关匹配」（D146、D147：NFKC(toCasefold(NFKC(NFD(X))))），
 * 加上去掉 Default_Ignorable_Code_Point——两者合起来就是 Unicode 派生属性 NFKC_Casefold 的定义（UAX #15、UAX #31 用它做标识符的大小写无关比较）。
 * 为什么是这一种：
 *   · 大小写要用「完整折叠」（CaseFolding.txt 的 C+F），ß、ẞ、SS、ss 才归到一处；只转小写或只做简单折叠都会漏。
 *   · 要带兼容规范化（NFKC），全角、连字、数学字母这些写法才归到一处；NFC 不管这些。
 *   · 不用土耳其语那一类（T）：默认折叠里 İ、ı 和 i 不相等，按语言改规则会让同一个名字在不同部署里比出不同结果。
 *   · 迭代到不动点：一轮的结果再做一轮不变才算数（全部码位实测一轮即收敛，这里是兜底）。
 *
 * JS 没有现成的完整折叠函数，toCasefold 这样拼出来，每一步都对着 Node 自带的 Unicode 数据：
 *   · 哪些字符折叠会变：属性 Changes_When_Casefolded（由 CaseFolding.txt 派生）；不变的原样保留。
 *   · 会变的：取「先转大写再转小写」；结果是一个字符时，要求它和原字符在 /iu 下等价才用
 *     （ECMA-262 规定 /iu 的等价就是 CaseFolding.txt 的简单折叠 C+S），不等价就取同一类里的大写形式（切罗基文）。
 *     结果是多个字符时就是完整折叠的展开（ß → ss，ﬁ → fi），直接用。
 * 核对（scripts/principal-fold-test.mjs，全部 1,112,064 个码位）：折出来会不会变，和 Changes_When_Casefolded、
 * Changes_When_NFKC_Casefolded 两个属性逐个一致；每个码位都是不动点。
 *
 * 只用来判「撞没撞」，原值照存。折不出来（不收敛、规范化之后是空的）就抛错，调用方按不可用处理，不放行。
 */
const CWCF = /^\p{Changes_When_Casefolded}$/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const foldCache = new Map<string, string>();
const escapeChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const simplyEqual = (a: string, b: string): boolean => new RegExp(`^${escapeChar(a)}$`, 'iu').test(b);

/** 一个码位的完整大小写折叠（CaseFolding.txt 的 C+F），拼法见上 */
export function caseFoldChar(c: string): string {
  const hit = foldCache.get(c);
  if (hit !== undefined) return hit;
  let f: string;
  if (!CWCF.test(c)) f = c;
  else {
    const full = c.toUpperCase().toLowerCase(), up = c.toUpperCase(), lo = c.toLowerCase();
    if ([...full].length > 1) f = full;
    else if (full !== c && simplyEqual(c, full)) f = full;
    else if (lo !== c && [...lo].length > 1) f = lo;
    else if (up !== c && [...up].length === 1 && simplyEqual(c, up)) f = up;
    else throw new Error(`折叠不出 U+${c.codePointAt(0)!.toString(16)}`);
  }
  if (foldCache.size > 10_000) foldCache.clear();
  foldCache.set(c, f);
  return f;
}

const nfkcCasefoldOnce = (s: string): string =>
  [...s.normalize('NFD').normalize('NFKC').replace(IGNORABLE, '')].map(caseFoldChar).join('').normalize('NFKC').replace(IGNORABLE, '');

export function comparisonKey(value: string): string {
  let x = value;
  for (let i = 0; i < 8; i++) {
    const y = nfkcCasefoldOnce(x);
    if (y === x) return x;
    x = y;
  }
  throw new Error('规范化不收敛');
}

/** 列表和详情交出去的列：比较用的规范化值不交出去 */
const COLUMNS = 'id, kind, display_name, owner, status, status_changed_at, status_changed_by, status_reason, created_at';

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

    const id = `user:${externalId}`, idKey = comparisonKey(id), externalKey = comparisonKey(externalId);
    if (!externalKey) throw new Error('外部身份规范化之后是空的');
    db.exec('BEGIN IMMEDIATE');
    try {
      // 拿到写锁之后再看一眼：共用数据目录的另一个实例可能刚建好
      const again = this.boundTo(provider, externalId);
      let out: Admission;
      if (again) out = verdict(again);
      // 等价写法已经有了（同一个提供方下的外部身份，或者任何一个主体标识）：不认、不建
      else if (db.prepare('SELECT 1 FROM principal_identities WHERE provider = ? AND external_key = ?').get(provider, externalKey)) out = { ok: false, reason: 'unbound' };
      else if (db.prepare('SELECT 1 FROM principals WHERE id_key = ?').get(idKey)) out = { ok: false, reason: 'unbound' };
      else {
        db.prepare("INSERT INTO principals (id, id_key, kind, display_name) VALUES (?, ?, 'person', ?)").run(id, idKey, text(identity.displayName, 256));
        db.prepare('INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES (?, ?, ?, ?)').run(provider, externalId, externalKey, id);
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
    const row = db.prepare(`SELECT ${COLUMNS} FROM principals WHERE id = ?`).get(id) as PrincipalRow | undefined;
    if (!row) return null;
    return { ...row, identities: db.prepare('SELECT provider, external_id, created_at FROM principal_identities WHERE principal_id = ? ORDER BY provider, external_id').all(id) as PrincipalIdentity[] };
  }

  /** 全部主体，连同各自的外部身份。按标识排序 */
  list(): PrincipalView[] {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM principals ORDER BY id`).all() as PrincipalRow[];
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
