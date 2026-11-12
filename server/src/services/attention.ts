/**
 * 「关注」域（阶段八 8c）：等这个人处理的条目，从各来源汇到一处读。规格见产品化文档 02 附录 8c。
 *
 * 不合并表。每个来源注册一个提供方：给定这次请求（谁在看），列出等他处理的条目。
 *   · 可见性用各来源旧接口现有的守卫：提供方只返回这个人本来就能在旧页面看到的；看不到的不计数。
 *   · 注册是调用方上下文里的一个 effect（和 HTTP 服务注册路由同一个写法）：返回撤销函数；
 *     调用方是插件时，插件卸载自动撤销，它的条目就不再出现。
 *   · 一个提供方出错不拖垮别的：那个来源记成不可用，别的照常返回。
 * 阶段六切换之后，提供方不再自己判，改由统一判定决定能不能答（另排）。
 *
 * 8d「关注」的答：提供方再给一个 answer(这次请求, 条目 id, 答法, 要填的东西)。答复入口只认来源、确认这一条此刻在这个人的
 * 列表里（看不到的，用 deny 回旧入口无权时的那个拒绝），然后调 answer。answer 现在多半是「进程内转给原路由」，
 * 阶段三把处理函数抽出来之后逐个换成直接调用，接口不变。重复答、并发答的语义由这里的记账（once）统一给出。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    attention: AttentionService;
  }
}

/** 类别：提问、审核、验收、过目、授权 */
export const CATEGORIES = ['ask', 'review', 'accept', 'glance', 'grant'] as const;
export type Category = typeof CATEGORIES[number];

/** 每条的统一形状 */
export type AttentionItem = {
  source: string;
  source_id: string;
  category: Category;
  title: string;
  /** 谁在等（发起这件事的人或席位） */
  waiting_for: string;
  /** 从什么时候开始等（来源里的时间，SQLite UTC「YYYY-MM-DD HH:MM:SS」或 ISO） */
  since: string;
  /** 可选的答法（8d 的答复入口按这些分发） */
  answers: string[];
  object: string;
  phase: string;
  /** 原件在旧页面上的链接（站内路径） */
  link: string | null;
  /** 审核卡片当场办所需的最少内容（变更申请：要动什么、从第几版到第几版、谁为什么申请、删除连带几个版本几个文件、不可恢复） */
  detail?: Record<string, unknown>;
  /** 统一待办条目是哪一类：task（任务中心任务）、sop-run（SOP 执行）、ygl、a2a、other。前端据此不把它们放进「等你审核」 */
  kind?: string;
  /** 是不是轮到看的这个人（只增）：事项的验收、席位的提问轮到建立人；过目放行轮到有放行权限的人（和事项详情的 turn 同一个函数）。
   *  别的来源本来就只给负责的人看，一律为真。为假就是「你能代办的别人的事」 */
  mine?: boolean;
  /** 事项和席位提问条目上的建立人（只增）：主体和显示名，没有显示名是 null；建立人空着是 null */
  creator?: { principal: string; display_name: string | null } | null;
};

/**
 * 提供方。list 返回 null 表示这个人在这个来源的旧接口上看不到任何东西（守卫没过）：不报错、不计数。
 * 返回数组时，就是这个人在旧接口上能看到的、等他处理的条目。
 */
export type AttentionProvider<R = unknown> = {
  source: string;
  label: string;
  /** req 是这次请求（谁在看）。领域服务不认 HTTP 框架，这里不定它的类型，提供方自己知道 */
  list: (req: R) => Promise<AttentionItem[] | null> | AttentionItem[] | null;
  /** 答一条。返回来源给的状态码和正文（转给原路由的，就是原路由的应答，原样）。不提供就是这个来源没有答法 */
  answer?: (req: R, sourceId: string, answer: string, input: Record<string, unknown>) => Promise<AnswerOutcome>;
  /** 这个人在这个来源看不到任何东西时，旧入口会怎么拒（状态码和正文）。不提供就回 403 */
  deny?: (req: R) => Promise<AnswerOutcome> | AnswerOutcome;
  /** 记账用的键：缺省就是条目 id。同一个 id 先后可能是不同的待决（席位在同一个投递上又问了一次）时，键要能分开它们 */
  key?: (sourceId: string) => string;
};

export type AnswerOutcome = { status: number; body: unknown; duplicate?: boolean };

/** 答复占位的期限：转给原路由一次用不了这么久；过了还没收尾的就是卡死或被杀了 */
export const PENDING_TTL_SECONDS = 120;

export type AttentionSourceMeta = { label: string; visible: boolean; count: number; error?: string };
export type AttentionView = {
  items: AttentionItem[];
  counts: { total: number; by_category: Record<Category, number>; by_source: Record<string, number> };
  sources: Record<string, AttentionSourceMeta>;
};

export class AttentionService extends Service {
  private readonly providers = new Map<string, AttentionProvider<never>>();

  constructor(ctx: Context) {
    super(ctx, 'attention');
    // 上次运行时答到一半就退出（占了位、没来得及记结果或删掉）：这些占位不会再有人收尾，启动时清掉，那几条可以再答
    const stale = db.prepare("DELETE FROM attention_answers WHERE state = 'pending'").run();
    if (Number(stale.changes) > 0) console.log(`[attention] 启动时清掉 ${stale.changes} 条上次没答完的占位`);
  }

  /** 注册一个来源的提供方。同名的来源只能有一个。挂在调用方的作用域上，返回撤销函数。 */
  provide<R>(provider: AttentionProvider<R>): () => void {
    const revoke = this.ctx.effect(() => {
      if (this.providers.has(provider.source)) throw new Error(`attention：来源 ${provider.source} 已经有提供方了`);
      this.providers.set(provider.source, provider as AttentionProvider<never>);
      return () => { if (this.providers.get(provider.source) === (provider as AttentionProvider<never>)) this.providers.delete(provider.source); };
    }, `ctx.attention.provide(${provider.source})`);
    return () => { void revoke(); };
  }

  sources(): string[] {
    return [...this.providers.keys()];
  }

  provider<R>(source: string): AttentionProvider<R> | undefined {
    return this.providers.get(source) as AttentionProvider<R> | undefined;
  }

  /** 某个条目按「条目 id@序号」分轮记过的账里，序号最大的那一个键（答完、不在清单里之后，重复答靠它认出是哪一轮）；没有返回 null */
  latestKey(source: string, base: string): string | null {
    const rows = db.prepare("SELECT source_id FROM attention_answers WHERE source = ? AND source_id LIKE ? ESCAPE '\\'")
      .all(source, `${base.replace(/[\\%_]/g, '\\$&')}@%`) as { source_id: string }[];
    let best: { n: number; key: string } | null = null;
    for (const r of rows) {
      const n = Number(r.source_id.slice(base.length + 1));
      if (Number.isInteger(n) && (!best || n > best.n)) best = { n, key: r.source_id };
    }
    return best?.key ?? null;
  }

  /**
   * 这个人用这种答法答成过这一条（答完它就不在列表里了，重复答时用它认出来）。键里带答的人和答法：
   * 别人答的、换了答法的都不算，入口对它们回「没有这一条」，和这一条从没存在过一样
   */
  answered(source: string, sourceId: string, by: string, answer: string): boolean {
    return Boolean(db.prepare("SELECT 1 FROM attention_answers WHERE source = ? AND source_id = ? AND state = 'done' AND answered_by = ? AND answer = ?").get(source, sourceId, by, answer));
  }

  /**
   * 记账着答一次：
   *   · 同一个人用同一种答法答成过：返回第一次的应答（duplicate），不再生效；
   *   · 别人答成过、或换了答法：409，不带上一次的应答（调用方已经判过权，这里只是不把别人的结果给他）；
   *   · 正有人在答：409，告诉他已在处理（并发的两个人，一个生效、另一个被告知）；
   *   · 否则先占住这一条，再 run；成功（2xx）记下应答，失败删掉占位、原样返回失败（不吞），可以再答。
   */
  async once(source: string, sourceId: string, answer: string, by: string, run: () => Promise<AnswerOutcome>): Promise<AnswerOutcome> {
    // 占位有期限：超过 PENDING_TTL_SECONDS 还没收尾的（进程在答的途中卡死、或被杀了），当它不存在
    db.prepare(`DELETE FROM attention_answers WHERE source = ? AND source_id = ? AND state = 'pending' AND at < datetime('now', '-${PENDING_TTL_SECONDS} seconds')`).run(source, sourceId);
    type Row = { state: string; status: number; body: string; answer: string; answered_by: string };
    const prior = () => db.prepare('SELECT state, status, body, answer, answered_by FROM attention_answers WHERE source = ? AND source_id = ?').get(source, sourceId) as Row | undefined;
    const seen = (row: Row): AnswerOutcome => row.state !== 'done'
      ? { status: 409, body: { error: 'attention_answer_in_progress', message: '这一条正在被别人处理' } }
      : row.answered_by === by && row.answer === answer
        ? { status: row.status, body: JSON.parse(row.body || 'null'), duplicate: true }
        : { status: 409, body: { error: 'attention_already_answered', message: '这一条已经处理过了' } };
    const before = prior();
    if (before) return seen(before);
    const claimed = db.prepare("INSERT OR IGNORE INTO attention_answers (source, source_id, answer, state, answered_by) VALUES (?, ?, ?, 'pending', ?)").run(source, sourceId, answer, by);
    if (Number(claimed.changes) === 0) return seen(prior()!);
    let out: AnswerOutcome;
    try { out = await run(); } catch (e) { db.prepare("DELETE FROM attention_answers WHERE source = ? AND source_id = ? AND state = 'pending'").run(source, sourceId); throw e; }
    if (out.status >= 200 && out.status < 300) {
      db.prepare("UPDATE attention_answers SET state = 'done', status = ?, body = ?, at = datetime('now') WHERE source = ? AND source_id = ?").run(out.status, JSON.stringify(out.body ?? null), source, sourceId);
    } else {
      db.prepare("DELETE FROM attention_answers WHERE source = ? AND source_id = ? AND state = 'pending'").run(source, sourceId);
    }
    return out;
  }

  /** 汇总这个人的全部条目和各类条数。按「从什么时候开始等」从早到晚排。 */
  async collect<R>(req: R): Promise<AttentionView> {
    const items: AttentionItem[] = [];
    const sources: Record<string, AttentionSourceMeta> = {};
    for (const p of this.providers.values()) {
      try {
        const got = await (p as AttentionProvider<R>).list(req);
        sources[p.source] = { label: p.label, visible: got !== null, count: got?.length ?? 0 };
        if (got) items.push(...got);
      } catch (e) {
        sources[p.source] = { label: p.label, visible: false, count: 0, error: `${p.source}_source_unavailable` };
        console.error(`[attention] 来源 ${p.source} 取不到（只影响它自己）：${(e as Error)?.message ?? e}`);
      }
    }
    items.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.source.localeCompare(b.source) || a.source_id.localeCompare(b.source_id)));
    const by_category = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
    const by_source: Record<string, number> = {};
    for (const it of items) { by_category[it.category]++; by_source[it.source] = (by_source[it.source] ?? 0) + 1; }
    return { items, counts: { total: items.length, by_category, by_source }, sources };
  }
}
