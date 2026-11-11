/**
 * 「关注」域（阶段八 8c）：等这个人处理的条目，从各来源汇到一处读。规格见产品化文档 02 附录 8c。
 *
 * 不合并表。每个来源注册一个提供方：给定这次请求（谁在看），列出等他处理的条目。
 *   · 可见性用各来源旧接口现有的守卫：提供方只返回这个人本来就能在旧页面看到的；看不到的不计数。
 *   · 注册是调用方上下文里的一个 effect（和 HTTP 服务注册路由同一个写法）：返回撤销函数；
 *     调用方是插件时，插件卸载自动撤销，它的条目就不再出现。
 *   · 一个提供方出错不拖垮别的：那个来源记成不可用，别的照常返回。
 * 阶段六切换之后，提供方不再自己判，改由统一判定决定能不能答（另排）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';

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
  link: string;
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
};

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
