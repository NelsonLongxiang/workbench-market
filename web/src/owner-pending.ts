/** 待属主看板（纯逻辑，页面与单测共用）：数据全在一张外部台的工作台变量里，靠常量的作者认人——
 *  config.owner  属主本人用 Odoo 管理员身份建的常量：{ owner_login, writers: ['mcp:<会话名>'] }，作者须是 odoo:<owner_login>
 *  item.<NN>     登记身份（writers 之一）建的常量：事项本身
 *  answer.<NN>   属主本人建的常量：答复
 *  作者对不上的记录一律不采信，列进 anomalies 点名作者，不静默丢弃。 */

export const BOARD_PATH = '/owner-pending';

export type BoardVar = { key: string; kind: string; value: unknown; revision: number; owner: string; updated_by: string; updated_at: string };
export type BoardConfig = { ownerLogin: string; writers: string[]; revision: number };
/** history：迁移时由登记身份记入的历史答复，未经本页属主确认，和属主答复分开 */
export type ItemStatus = 'open' | 'history' | 'answered' | 'withdrawn';
export type BoardRow = {
  no: string;
  question: string;
  checked: string;
  waitingFor: string;
  firstRaised: string;
  lastChange: string;
  source: string;
  status: ItemStatus;
  answer: { summary: string; date: string; by: string; revision: number | null; historical: boolean } | null;
  itemRevision: number;
  /** 撤回原因（item.withdraw_reason）与撤回者（item 的最后写入者） */
  withdrawn: { reason: string; by: string } | null;
  /** answer.<NN> 已被别人建成常量：属主在这个编号上写不进去，要部署机本机命令行清理 */
  answerTakenBy: string | null;
};
export type Anomaly = { key: string; reason: string };

const NO_RE = /^\d{1,4}$/;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** SQLite 的 updated_at 是 UTC「YYYY-MM-DD HH:MM:SS」：按北京时间取日期，凌晨 0–8 点写入的不会差一天 */
export function bjDate(sqliteUtc: string): string {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqliteUtc) ? sqliteUtc.replace(' ', 'T') + 'Z' : sqliteUtc);
  return isNaN(t) ? '' : new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 看板台：登记 URL 路径为 /owner-pending 的卡片；没有或多于一张都要人处理，不猜 */
export function findBoardWorkbench(list: Array<{ id: number; url: string }>, base: string): { id: number } | { error: string } {
  const hits = list.filter((w) => {
    try { return new URL(w.url, base).pathname.replace(/\/+$/, '') === BOARD_PATH; } catch { return false; }
  });
  if (hits.length === 1) return { id: hits[0].id };
  if (!hits.length) return { error: `还没有登记看板台：请登记一张外部台卡片，地址填本站的 ${BOARD_PATH}` };
  return { error: `登记了 ${hits.length} 张看板台卡片（id ${hits.map((w) => w.id).join('、')}），请删到只剩一张` };
}

/** config.owner 只在作者正是它写的 owner_login 时才算数 */
export function parseConfig(v: BoardVar | undefined): BoardConfig | { error: string } | null {
  if (!v) return null;
  const val = obj(v.value);
  const ownerLogin = str(val.owner_login);
  const writers = Array.isArray(val.writers) ? val.writers.map(str).filter((w) => /^mcp:[^\s]{1,128}$/.test(w)) : [];
  if (v.kind !== 'const') return { error: 'config.owner 不是常量，不采信' };
  if (!ownerLogin) return { error: 'config.owner 缺 owner_login' };
  if (v.owner !== `odoo:${ownerLogin}`) return { error: `config.owner 的作者是「${v.owner || '无'}」，与登记的属主 odoo:${ownerLogin} 不符，不采信` };
  if (!writers.length) return { error: 'config.owner 缺 writers（登记身份，形如 mcp:<会话名>）' };
  return { ownerLogin, writers, revision: v.revision };
}

/** 事项与答复按作者核验后合成看板行；状态：撤回 > 已答复（属主答复或历史答复）> 待办 */
export function buildBoard(vars: BoardVar[], config: BoardConfig): { rows: BoardRow[]; anomalies: Anomaly[] } {
  const owner = `odoo:${config.ownerLogin}`;
  const anomalies: Anomaly[] = [];
  const answers = new Map<string, BoardVar>();
  const taken = new Map<string, string>();
  const items: BoardVar[] = [];
  for (const v of vars) {
    const m = /^(item|answer)\.(.+)$/.exec(v.key);
    if (!m) continue;
    if (!NO_RE.test(m[2])) { anomalies.push({ key: v.key, reason: '编号须为 1–4 位数字' }); continue; }
    if (v.kind !== 'const') { anomalies.push({ key: v.key, reason: '不是常量，不采信' }); continue; }
    if (m[1] === 'item') {
      if (!config.writers.includes(v.owner)) { anomalies.push({ key: v.key, reason: `作者「${v.owner || '无'}」不是登记身份，不采信` }); continue; }
      items.push(v);
    } else {
      if (v.owner !== owner) { anomalies.push({ key: v.key, reason: `作者「${v.owner || '无'}」不是属主 ${owner}，不当作答复；这个编号属主写不进去，要在部署机本机用命令行清理` }); taken.set(m[2], v.owner || '无'); continue; }
      answers.set(m[2], v);
    }
  }
  const rows = items.map((v): BoardRow => {
    const no = v.key.slice('item.'.length);
    const val = obj(v.value);
    const a = answers.get(no);
    const hist = obj(val.history_answer);
    const answer = a
      ? { summary: str(obj(a.value).summary), date: str(obj(a.value).date) || bjDate(a.updated_at), by: a.owner, revision: a.revision, historical: false }
      : str(hist.summary) ? { summary: str(hist.summary), date: str(hist.date), by: '历史答复（迁移时由登记身份记入）', revision: null, historical: true } : null;
    answers.delete(no);
    return {
      no,
      question: str(val.question),
      checked: str(val.checked),
      waitingFor: str(val.waiting_for),
      firstRaised: str(val.first_raised),
      lastChange: str(val.last_change),
      source: str(val.source),
      status: str(val.status) === 'withdrawn' ? 'withdrawn' : !answer ? 'open' : answer.historical ? 'history' : 'answered',
      answer,
      itemRevision: v.revision,
      withdrawn: str(val.status) === 'withdrawn' ? { reason: str(val.withdraw_reason), by: v.updated_by || v.owner } : null,
      answerTakenBy: taken.get(no) ?? null,
    };
  });
  for (const [no] of answers) anomalies.push({ key: `answer.${no}`, reason: '没有对应的事项 item.' + no });
  const order: Record<ItemStatus, number> = { open: 0, history: 1, answered: 2, withdrawn: 3 };
  rows.sort((x, y) => order[x.status] - order[y.status] || Number(x.no) - Number(y.no));
  return { rows, anomalies };
}

/** 属主答复写入体：新建是常量；已有答复带 override 与 revision 修订（常量只有作者本人能改） */
export function answerBody(summary: string, date: string, existingRevision: number | null): Record<string, unknown> {
  const value = { summary: summary.trim(), date };
  return existingRevision
    ? { value, kind: 'const', override: true, revision: existingRevision, reason: '属主修订答复' }
    : { value, kind: 'const', reason: '属主答复' };
}

/** 属主修订登记身份（轮换会话）：config.owner 是属主本人的常量，带 override、当前 revision 与 reason；owner_login 不变 */
export function configRevisionBody(cfg: BoardConfig, writers: string[]): Record<string, unknown> | { error: string } {
  const list = [...new Set(writers.map((w) => w.trim()).filter(Boolean))];
  if (!list.length || !list.every((w) => /^mcp:[^\s]{1,128}$/.test(w))) return { error: '登记身份写成 mcp:<会话名>，多个用逗号隔开，至少一个' };
  return { value: { owner_login: cfg.ownerLogin, writers: list }, kind: 'const', override: true, revision: cfg.revision, reason: `属主修订登记身份：${list.join('、')}` };
}
