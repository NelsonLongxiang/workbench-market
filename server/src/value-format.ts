/**
 * #1085 + #1095 数字显示格式：报告冻结时（服务端）和数据视图的块（浏览器）共用这一个实现，不各写一套。
 * 纯函数、不引任何模块；浏览器那边按相对路径引这个文件，构建时打进包里（服务端运行时不依赖 web/src）。
 *  · reportNumberSpec：报告里 $format 和统计卡 format 的写法（style + locale、currency、两个小数位）；
 *  · columnNumberSpec：数据视图列定义里 format 的写法（decimals、thousands、percent、currency、unit）；
 *  · formatNumber：按规格写；plainNumber：没配格式的数字（原样，只加千分位，不截断、不补零）。
 */

export type NumberStyle = 'decimal' | 'percent' | 'currency';
export interface NumberSpec { style: NumberStyle; locale: string; currency?: string; minFrac?: number; maxFrac?: number; grouping: boolean; divisor: number; suffix: string }
export type SpecResult = { ok: true; spec: NumberSpec } | { ok: false; error: string };

/** 小数位上限 */
export const MAX_FRACTION_DIGITS = 6;
/** unit 换算：写了哪个单位，就按它的除数换算后接在后面 */
export const UNIT_DIVISORS: Readonly<Record<string, number>> = { 千: 1e3, 万: 1e4, 百万: 1e6, 亿: 1e8 };
const LOCALE_RE = /^[a-zA-Z0-9-]{2,35}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const digits = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_FRACTION_DIGITS;

/** 试着建一次 Intl.NumberFormat：组合不合法（Intl 会抛错）就算格式不对 */
function probe(spec: NumberSpec): boolean {
  try { nf(spec); return true; } catch { return false; }
}
function nf(spec: NumberSpec): Intl.NumberFormat {
  const o: Intl.NumberFormatOptions = { style: spec.style };
  if (spec.style === 'currency') o.currency = spec.currency ?? 'CNY';
  if (spec.minFrac !== undefined) o.minimumFractionDigits = spec.minFrac;
  if (spec.maxFrac !== undefined) o.maximumFractionDigits = spec.maxFrac;
  if (!spec.grouping) o.useGrouping = false;
  return new Intl.NumberFormat(spec.locale, o);
}

/** 报告的写法：{ style: number|percent|currency, locale?, currency?, minimum_fraction_digits?, maximum_fraction_digits? }。
 *  不写小数位时和以前一模一样（Intl 的默认），已有模板的输出不变。不合格回 invalid_format */
export function reportNumberSpec(o: { style: unknown; locale?: unknown; currency?: unknown; minimum_fraction_digits?: unknown; maximum_fraction_digits?: unknown }, has: (k: string) => boolean): SpecResult {
  const bad: SpecResult = { ok: false, error: 'invalid_format' };
  if (o.style !== 'number' && o.style !== 'percent' && o.style !== 'currency') return bad;
  const locale = has('locale') ? o.locale : 'zh-CN';
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) return bad;
  const currency = has('currency') ? o.currency : 'CNY';
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency) || (o.style !== 'currency' && has('currency'))) return bad;
  const min = has('minimum_fraction_digits') ? o.minimum_fraction_digits : undefined;
  const max = has('maximum_fraction_digits') ? o.maximum_fraction_digits : undefined;
  if ((min !== undefined && !digits(min)) || (max !== undefined && !digits(max))) return bad;
  if (min !== undefined && max !== undefined && (min as number) > (max as number)) return bad;
  const spec: NumberSpec = { style: o.style === 'number' ? 'decimal' : o.style, locale, ...(o.style === 'currency' ? { currency } : {}),
    ...(min !== undefined ? { minFrac: min as number } : {}), ...(max !== undefined ? { maxFrac: max as number } : {}), grouping: true, divisor: 1, suffix: '' };
  return probe(spec) ? { ok: true, spec } : bad;
}

/** 列定义的写法：{ decimals?: 0～6, thousands?: 是否千分位（缺省是）, percent?: true, currency?: 'CNY' 这样的币种, unit?: '万' 这样的单位 }。
 *  decimals 写了就是固定位数（补零）；percent 是值 ×100 加 %；percent、currency、unit 三者至多一个。不合格回一句中文说法 */
export function columnNumberSpec(f: unknown): SpecResult {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: 'format 须为对象，比如 { "decimals": 2 }' };
  const o = f as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !['decimals', 'thousands', 'percent', 'currency', 'unit'].includes(k));
  if (extra.length) return { ok: false, error: `format 有不认识的键：${extra.join('、')}（只认 decimals、thousands、percent、currency、unit）` };
  if (own(o, 'decimals') && !digits(o.decimals)) return { ok: false, error: `format.decimals 须为 0～${MAX_FRACTION_DIGITS} 的整数` };
  if (own(o, 'thousands') && typeof o.thousands !== 'boolean') return { ok: false, error: 'format.thousands 须为 true 或 false' };
  if (own(o, 'percent') && o.percent !== true && o.percent !== false) return { ok: false, error: 'format.percent 须为 true 或 false' };
  if (own(o, 'currency') && (typeof o.currency !== 'string' || !CURRENCY_RE.test(o.currency))) return { ok: false, error: 'format.currency 须为三个大写字母的币种，比如 CNY、USD' };
  if (own(o, 'unit') && (typeof o.unit !== 'string' || !own(UNIT_DIVISORS, o.unit))) return { ok: false, error: `format.unit 只认 ${Object.keys(UNIT_DIVISORS).join('、')}` };
  const kinds = [o.percent === true, own(o, 'currency'), own(o, 'unit')].filter(Boolean).length;
  if (kinds > 1) return { ok: false, error: 'format 里 percent、currency、unit 至多写一个' };
  const d = own(o, 'decimals') ? (o.decimals as number) : undefined;
  const spec: NumberSpec = {
    style: o.percent === true ? 'percent' : own(o, 'currency') ? 'currency' : 'decimal', locale: 'zh-CN',
    ...(own(o, 'currency') ? { currency: o.currency as string } : {}),
    ...(d !== undefined ? { minFrac: d, maxFrac: d } : {}),
    grouping: o.thousands !== false, divisor: own(o, 'unit') ? UNIT_DIVISORS[o.unit as string] : 1, suffix: own(o, 'unit') ? (o.unit as string) : '',
  };
  return probe(spec) ? { ok: true, spec } : { ok: false, error: 'format 的组合不合法' };
}

/** 按规格写一个数；不是有限的数回 null（调用方各自决定写「-」还是报错） */
export function formatNumber(v: unknown, spec: NumberSpec): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return nf(spec).format(spec.divisor === 1 ? v : v / spec.divisor) + spec.suffix;
}

/** 没配格式的数：原样（JS 存下来是几位就写几位），整数部分加千分位；不截断、不补零。不是有限的数回 null */
export function plainNumber(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const s = String(Math.abs(v));
  if (/e/i.test(s)) return String(v);
  const [int, frac] = s.split('.');
  return `${v < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}
