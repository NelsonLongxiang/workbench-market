/** 领域页（/areas，领域第 1 步的前端）的纯函数：不碰 React，scripts/areas-ui-unit.mjs 直接测。
 *  接口契约由后端（领域第 1 步 PR2b、PR3a）给：GET /api/areas、GET /api/areas/:id、POST /api/areas、POST /api/areas/migrate；
 *  负责人走授予接口（area-lead，起草 → 提交 → 放行，属主一路放行到底）。
 *  原型里没有「负责人」：属主 11-18「有团队就一定会有负责人」，服务端加了 area-lead，前端照服务端做（统筹 11-20 认可）。
 *  不露代号：主体标识（user:…）、授予编号不写在页面的字上；领域标识是属主自己起的名字，照写。 */

export type AreaStatus = 'pending-lead' | 'active' | 'retired';
export type Area = { id: string; name: string; status: AreaStatus; fromDepartment: boolean; specVersion: number | null };
export type AreasCan = { create: boolean; migrate: boolean; assignLead: boolean };
export type Lead = { grant: number; principal: string; name: string; status: 'active' | 'pending' | 'disabled' };
export type PersonPick = { id: string; name: string };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isStatus = (v: unknown): v is AreaStatus => v === 'pending-lead' || v === 'active' || v === 'retired';
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/** 领域的状态各一句人话和标签颜色 */
export const STATUS_TEXT: Record<AreaStatus, string> = { 'pending-lead': '等负责人', active: '在用', retired: '已撤' };
export const STATUS_TONE: Record<AreaStatus, string> = { 'pending-lead': 'warning', active: 'success', retired: 'default' };
/** 等负责人的领域还不能用：一句话说清 */
export const PENDING_LEAD_HINT = '还没有负责人：在这之前不能在这个领域安排事、验收';

function areaOf(v: unknown): Area | null {
  const a = obj(v);
  const id = str(a.id), name = str(a.name);
  if (!id || !name || !isStatus(a.status)) return null;
  return { id, name, status: a.status, fromDepartment: a.source === 'department', specVersion: typeof a.spec_version === 'number' && Number.isInteger(a.spec_version) && a.spec_version > 0 ? a.spec_version : null };
}

/** GET /api/areas 的应答：领域（形状不对的丢掉），按「等负责人、在用、已撤」排，同一组按名字；can 只认严格的 true，没给就都不能 */
export function areasOf(body: unknown): { areas: Area[]; can: AreasCan } {
  const b = obj(body);
  const order: Record<AreaStatus, number> = { 'pending-lead': 0, active: 1, retired: 2 };
  const areas = (Array.isArray(b.areas) ? b.areas : []).flatMap((v) => { const a = areaOf(v); return a ? [a] : []; })
    .sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name, 'zh-CN'));
  const c = obj(b.can);
  return { areas, can: { create: c.create === true, migrate: c.migrate === true, assignLead: c.assign_lead === true } };
}

/** 人的说法：有显示名用显示名，没有就去掉主体前缀（user:）——页面上不写主体标识 */
export const personLabel = (principal: string, displayName: unknown): string => str(displayName) || principal.replace(/^[a-z]+:/, '') || '一位同事';

/** GET /api/areas/:id 的 leads：生效的在前，再待放行的，停用的最后 */
export function leadsOf(body: unknown): Lead[] {
  const order = { active: 0, pending: 1, disabled: 2 };
  return (Array.isArray(obj(body).leads) ? obj(body).leads as unknown[] : []).flatMap((v): Lead[] => {
    const l = obj(v);
    const principal = str(l.principal);
    if (!principal || typeof l.grant !== 'number' || !(l.status === 'active' || l.status === 'pending' || l.status === 'disabled')) return [];
    return [{ grant: l.grant, principal, name: personLabel(principal, l.display_name), status: l.status }];
  }).sort((a, b) => order[a.status] - order[b.status]);
}

/** 负责人那一行：生效的写名字；待放行的标「待放行」；人被停用的标出来、不算负责人 */
export function leadLine(leads: Lead[]): string {
  if (!leads.length) return '还没有';
  return leads.map((l) => (l.status === 'active' ? l.name : l.status === 'pending' ? `${l.name}（待放行）` : `${l.name}（人已停用，不算）`)).join('、');
}

/** 指定负责人时可选的人：只列在用的人（不是席位、节点）；已经是这个领域生效或待放行负责人的不再列；
 *  也不列自己（不能给自己授予，服务端回 self_grant——实机走查时属主出现在名单里、点了才被拒，11-20） */
export function leadCandidates(principalsBody: unknown, leads: Lead[], self: string | null = null): PersonPick[] {
  const taken = new Set(leads.filter((l) => l.status !== 'disabled').map((l) => l.principal));
  if (self) taken.add(self);
  return (Array.isArray(obj(principalsBody).principals) ? obj(principalsBody).principals as unknown[] : []).flatMap((v): PersonPick[] => {
    const p = obj(v);
    const id = str(p.id);
    if (!id || p.kind !== 'person' || p.status !== 'active' || taken.has(id)) return [];
    return [{ id, name: personLabel(id, p.display_name) }];
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((c, _i, all) => {
    // 同名的人（同一个人的两个账号，或两位同名同事）：名字后面带上登录名，下拉框里分得清，搜登录名也搜得到（#999）
    const login = c.id.replace(/^[a-z]+:/, '');
    return all.some((o) => o !== c && o.name === c.name) && login !== c.name ? { ...c, name: `${c.name}（${login}）` } : c;
  });
}

/** 建领域的表单：和服务端同样的规则先核一遍（标识：小写字母开头，字母、数字、连字符，最多 48 个字；名字 1～64 个字、不带控制字符；标识不能和已有的重，撤了的也占着） */
export const AREA_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export function areaFormProblem(id: string, name: string, existing: Pick<Area, 'id'>[]): string | null {
  const n = name.trim(), i = id.trim();
  if (!n) return '写一个领域名字，比如 利润核算';
  if ([...n].length > 64 || /[\u0000-\u001f\u007f]/.test(n)) return '名字要 1～64 个字，不带换行之类的控制字符';
  if (!i) return '写一个标识，比如 fin（以后不能改）';
  if (!AREA_ID_RE.test(i)) return '标识要小写字母开头，只用小写字母、数字、连字符，最多 48 个字';
  if (existing.some((a) => a.id === i)) return `标识 ${i} 已经有领域在用了（撤了的领域也占着标识），换一个`;
  return null;
}

/** 写操作没办成怎么说：先认后端的错误代号，没认出来的用后端给的 message，再不行按状态码 */
const CODES: Record<string, string> = {
  areas_owner_only: '只有属主能做这一步',
  area_owner_only: '领域负责人只有属主能指定',
  area_exists: '这个标识已经有领域在用了（撤了的领域也占着标识），换一个',
  area_id_invalid: '标识要小写字母开头，只用小写字母、数字、连字符，最多 48 个字',
  area_name_invalid: '名字要 1～64 个字，不带控制字符',
  area_unknown: '这个领域不存在了，刷新看看',
  area_retired: '这个领域已经撤了，不能再指定负责人',
  area_pending_lead: '这个领域还没有负责人，先指定负责人',
  self_grant: '不能给自己授予，换一个人',
  area_last_lead: '领域至少要有一位负责人：先补一位再收回',
  areas_cross_origin_denied: '只能在本站的页面上操作',
  areas_auth_required: '请先登录',
  credentials_set_by_system_admin: '这个人的凭据是系统管理员设的：到「谁能做什么」里确认是本人后再放行',
};
export function actionError(status: number, body: unknown): string {
  const b = obj(body);
  const code = str(b.error);
  if (status === 0) return '连不上服务器，没办成';
  if (Object.hasOwn(CODES, code)) return CODES[code];
  const msg = str(b.message);
  if (msg && !/[a-z_]{6,}/.test(msg)) return msg;
  if (status === 401) return '请先登录';
  if (status === 403) return '你没有权限做这一步（要用属主的站内账号登录）';
  if (status === 404) return '服务端还没有这个接口，稍后再试';
  return '没办成，稍后再试';
}

/** 列表是空的时候怎么说。服务端只列这个人看得到的领域：不是属主的人列表是空的，分不清「还没有领域」和「有、但没给你」，
 *  所以不说「还没有领域」（领域可能已经有了，只是他看不到——阶段七验收 #915 指出会误导），说中性的「还没有你能看到的领域」；
 *  属主看得到全部，空就是真的还没有，照旧说「还没有领域」并指出两条路。判别只看服务端给的 can（建领域只有属主为真） */
export function emptyText(can: Pick<AreasCan, 'create'>): string {
  return can.create ? '还没有领域：建一个，或者把部门迁成领域' : '还没有你能看到的领域：被授予某个领域后，它会出现在这里';
}

/** 读列表的页面状态：401 去登录；403 跨站或没权限；200 看得懂；别的出错 */
export function pageKind(status: number): { kind: 'ok' | 'login' | 'forbidden' | 'error'; text: string } {
  if (status === 200) return { kind: 'ok', text: '' };
  if (status === 401) return { kind: 'login', text: '请先登录' };
  if (status === 403) return { kind: 'forbidden', text: '你看不了领域：要用站内账号登录、在本站页面上打开' };
  if (status === 0) return { kind: 'error', text: '连不上服务器，稍后再试' };
  return { kind: 'error', text: '读不到领域，稍后再试' };
}

/** 迁移（POST /api/areas/migrate）的结果：建了几个、起草了几条待放行、跳过的各说为什么 */
const SKIP_WHY: Record<string, string> = {
  lead_without_grant: '部门负责人只写了名字、没有授予，没起草',
  lead_not_active: '部门负责人已停用，没起草',
  id_invalid: '部门标识不合领域标识的写法，没迁',
  self_grant: '部门负责人就是你自己，不能给自己授予，没起草',
};
export function migrateResult(body: unknown): { created: number; drafted: number; summary: string; skipped: string[] } {
  const b = obj(body);
  const created = Array.isArray(b.created) ? b.created.length : 0;
  const drafted = Array.isArray(b.drafted) ? b.drafted.length : 0;
  const skipped = (Array.isArray(b.skipped) ? b.skipped : []).flatMap((v) => {
    const s = obj(v);
    const d = str(s.department);
    return d ? [`部门 ${d}：${SKIP_WHY[str(s.reason)] ?? '没迁（服务端拒了）'}`] : [];
  });
  const summary = created || drafted
    ? `建了 ${created} 个领域，起草了 ${drafted} 条负责人授予待你放行`
    : skipped.length ? '这次没有新建领域，也没有起草授予' : '部门都已经迁过了：这次没有新建领域，也没有起草授予';
  return { created, drafted, summary, skipped };
}

/** 指定负责人是三步（起草、提交、放行）：停在哪一步、怎么说 */
export type LeadStep = 'draft' | 'submit' | 'approve';
export function leadStepText(stopped: LeadStep | null, name: string, error: string): string {
  if (stopped === null) return `已指定 ${name} 为负责人，授予已放行`;
  if (stopped === 'draft') return `没指定上：${error}`;
  return `${name} 的负责人授予已起草${stopped === 'approve' ? '并提交' : ''}，但${stopped === 'submit' ? '提交' : '放行'}没成：${error}。到「谁能做什么」里接着办`;
}
