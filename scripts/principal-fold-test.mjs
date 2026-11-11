#!/usr/bin/env node
/**
 * 主体标识的规范化（NFKC_Casefold）成批测试。进程内，开一个临时数据目录里的库；不起服务，不访问任何外部系统。
 *
 * 一、全部 1,112,064 个码位（不含代理区），对着 Node 自带的 Unicode 数据：
 *     · 「完整大小写折叠会不会变」和属性 Changes_When_Casefolded 逐个一致；
 *     · 「NFKC_Casefold 会不会变」和属性 Changes_When_NFKC_Casefolded 逐个一致；
 *     · 每个码位的结果都是不动点（再做一遍不变）。
 * 二、走真的主体服务：每一个 NFKC_Casefold 会变的字符 c，先用折好的写法建一个主体，再用含 c 的写法来——
 *     必须被拒（unbound），不另建主体；把先建的主体停用之后再来，同样被拒。对照：折出来不一样的写法照常建。
 * 三、数一数「不只差大小写、也算撞上」的写法有哪几类（兼容等价、默认可忽略字符），各举几个例子。
 *     撞上了只拒不并，所以这些写法的后果是「后来的那个进不来，要管理员处理」，不会被并成一个人。
 *
 *   node scripts/principal-fold-test.mjs              测本仓库
 *   node scripts/principal-fold-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `principal-fold-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const hex = (s) => [...s].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const CWCF = /^\p{Changes_When_Casefolded}$/u, CWKCF = /^\p{Changes_When_NFKC_Casefolded}$/u, DI = /^\p{Default_Ignorable_Code_Point}$/u;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { comparisonKey, caseFoldChar } = await import(at('server/src/services/principal.ts'));
  if (typeof caseFoldChar !== 'function') check(false, '服务没有导出 caseFoldChar：完整大小写折叠那一项没法单独核对', '其余照跑');
  const { root } = await import(at('server/src/root-context.ts'));
  const { PrincipalService } = await import(at('server/src/services/principal.ts'));
  const { db } = await import(at('server/src/db.ts'));
  await root.plugin(PrincipalService);
  const principals = root.get('principals');
  /** 主体服务抛错（折不出来）也接住：算成没过，不让整批中断 */
  const admit = (x) => { try { return principals.admit(x); } catch (e) { return { ok: false, threw: String(e?.message ?? e) }; } };

  // ---------- 一、全部码位 ----------
  const all = [];
  for (let cp = 0; cp < 0x110000; cp++) if (cp < 0xd800 || cp > 0xdfff) all.push(String.fromCodePoint(cp));
  const bad = { cwcf: [], cwkcf: [], fixed: [], threw: [] };
  const changing = [];
  for (const c of all) {
    // 逐个接住异常：折不出来会抛错（服务按不可用处理、朝拒绝的方向），但在这里要算成没过，不能让整批中断
    try {
      const d = c.normalize('NFD');
      if (typeof caseFoldChar === 'function' && ([...d].map(caseFoldChar).join('') !== d) !== CWCF.test(c)) bad.cwcf.push(c);
      const k = comparisonKey(c);
      if ((k !== c) !== CWKCF.test(c)) bad.cwkcf.push(c);
      if (comparisonKey(k) !== k) bad.fixed.push(c);
      if (k !== c) changing.push(c);
    } catch { bad.threw.push(c); }
  }
  check(bad.threw.length === 0, '全部码位：没有一个折不出来（抛错）', `${bad.threw.length} 个抛错：${bad.threw.slice(0, 6).map(hex).join('、')}`);
  const first = (list) => list.slice(0, 6).map(hex).join('、');
  check(bad.cwcf.length === 0, `全部 ${all.length} 个码位：完整大小写折叠会不会变，和 Changes_When_Casefolded 逐个一致`, `${bad.cwcf.length} 个不一致：${first(bad.cwcf)}`);
  check(bad.cwkcf.length === 0, `全部码位：NFKC_Casefold 会不会变，和 Changes_When_NFKC_Casefolded 逐个一致（${changing.length} 个会变）`, `${bad.cwkcf.length} 个不一致：${first(bad.cwkcf)}`);
  check(bad.fixed.length === 0, '全部码位：结果是不动点（再做一遍不变）', `${bad.fixed.length} 个不是：${first(bad.fixed)}`);
  {
    // 几个出过问题、或者容易弄错的：大写的 ß、长 s、希腊语末尾的 σ、切罗基文、带点的 İ 和无点的 ı（默认折叠里它们和 i 不相等）
    const same = [['straẞe', 'strasse'], ['STRAẞE', 'straße'], ['ſtrasse', 'STRASSE'], ['ΣΟΦΟΣ', 'σοφος'], ['ΣΟΦΟΣ', 'σοφοσ'], ['ꭰꭱ', 'ᎠᎡ'], ['ǅ', 'ǆ'], ['Ǆ', 'dž'], ['ﬁle', 'FILE'], ['ＡＬＰＨＡ', 'alpha'], ['al​pha', 'ALPHA'], ['é', 'É'], ['KelvinK', 'kelvink']];
    const differ = [['İrmak', 'irmak'], ['ırmak', 'irmak'], ['İrmak', 'ırmak'], ['alpha', 'аlpha'], ['al pha', 'alpha'], ['alphá', 'alpha']];
    const keyOf = (v) => { try { return comparisonKey(v); } catch { return `（抛错）${v}`; } };
    const wrong = [...same.filter(([a, b]) => keyOf(a) !== keyOf(b)).map((p) => `应相等 ${p.join(' / ')}`), ...differ.filter(([a, b]) => keyOf(a) === keyOf(b)).map((p) => `应不等 ${p.join(' / ')}`)];
    check(wrong.length === 0, `点名的 ${same.length} 对相等、${differ.length} 对不等（ẞ、ſ、ς、切罗基文、ǅ、连字、全角、零宽、组合符相等；İ、ı、西里尔字母、中间加空格、多一个组合符不等）`, wrong.join('；'));
  }

  // ---------- 二、走真的主体服务 ----------
  const loginOk = (v) => v.length > 0 && v.length <= 128 && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
  let tried = 0, skipped = 0;
  const leaked = [], wronglyRefused = [], disabledLeaked = [];
  for (const c of changing) {
    const tag = c.codePointAt(0).toString(36);
    const variant = `v${tag}${c}z`; // 夹在两个字母中间：首尾空白类的字符不会让登录名不合法
    let folded;
    try { folded = comparisonKey(variant); } catch { wronglyRefused.push(`${hex(c)} 折不出来`); continue; }
    if (!loginOk(variant) || !loginOk(folded) || folded === variant) { skipped++; continue; }
    tried++;
    let owner;
    try { owner = principals.admit({ provider: 'fold', externalId: folded, displayName: null }); } catch (e) { owner = { threw: String(e?.message ?? e) }; }
    if (!owner.ok) { wronglyRefused.push(`${hex(c)} 折好的写法建不出`); continue; }
    let again;
    try { again = principals.admit({ provider: 'fold', externalId: variant, displayName: null }); } catch (e) { again = { threw: String(e?.message ?? e) }; }
    if (again.ok !== false || again.reason !== 'unbound') leaked.push(`${hex(c)}：${JSON.stringify(again)}`);
    principals.setStatus(owner.principal, 'disabled', 'cli', '成批测试');
    let off;
    try { off = principals.admit({ provider: 'fold', externalId: variant, displayName: null }); } catch (e) { off = { threw: String(e?.message ?? e) }; }
    if (off.ok !== false) disabledLeaked.push(`${hex(c)}：${JSON.stringify(off)}`);
  }
  const extra = db.prepare("SELECT COUNT(*) AS n FROM principal_identities WHERE provider = 'fold'").get().n;
  check(tried > 5000 && leaked.length === 0 && wronglyRefused.length === 0, `NFKC_Casefold 会变的字符逐个过主体服务（${tried} 个，${skipped} 个放进登录名不合法、跳过）：先建折好的写法，再用原写法来，一律被拒（unbound）`, [...wronglyRefused, ...leaked].slice(0, 6).join('；'));
  check(disabledLeaked.length === 0, '同一批：先建的主体停用之后再用原写法来，同样被拒（停用绕不过去）', disabledLeaked.slice(0, 6).join('；'));
  check(extra === tried, `同一批：外部身份正好 ${tried} 条（每个字符只有折好的那一条），没有多建`, `实际 ${extra} 条`);
  {
    // 对照：折出来不一样的写法照常建（规范化没有把不同的名字算成撞上）
    const pairs = [['İrmak', 'irmak'], ['ırmak', 'irmak'], ['аlpha', 'alpha'], ['alphá', 'alpha'], ['alpha2', 'alpha']];
    const refused = [];
    for (const [a, b] of pairs) {
      const x = admit({ provider: 'ctl', externalId: b, displayName: null });
      const y = admit({ provider: 'ctl', externalId: a, displayName: null });
      if (!(x.ok || x.reason === 'unbound') || !y.ok) refused.push(`${a} / ${b}：${JSON.stringify(y)}`);
    }
    check(refused.length === 0, '对照：折出来不一样的写法（İ、ı 对 i，西里尔 а 对拉丁 a，多一个组合符，多一个字符）各建各的', refused.join('；'));
  }

  // ---------- 三、哪些「不只是大小写」的写法也算撞上 ----------
  const kinds = { 大小写: [], 兼容等价: [], 默认可忽略: [] };
  for (const c of changing) {
    if (DI.test(c)) kinds.默认可忽略.push(c);
    else if (c.normalize('NFKC') !== c.normalize('NFC')) kinds.兼容等价.push(c);
    else kinds.大小写.push(c);
  }
  const sample = (list) => list.filter((c) => /^[\p{L}\p{N}\p{S}]$/u.test(c)).filter((_, i, a) => i % Math.ceil(a.length / 12) === 0).map((c) => `${c}→${(() => { try { return comparisonKey(c) || '（去掉）'; } catch { return '（抛错）'; } })()}`).join(' ');
  console.log(`  · 会变的 ${changing.length} 个字符：只差大小写 ${kinds.大小写.length} 个；兼容等价 ${kinds.兼容等价.length} 个（全角、连字、上下标、带圈、数学字母、罗马数字、单位符号……）；默认可忽略 ${kinds.默认可忽略.length} 个（零宽、软连字符、变体选择符……）`);
  console.log(`    兼容等价举例：${sample(kinds.兼容等价)}`);
  check(kinds.大小写.length + kinds.兼容等价.length + kinds.默认可忽略.length === changing.length && kinds.兼容等价.length > 0, '三类加起来就是全部会变的字符（列在上面，PR 里说明）');
  db.close();
} catch (e) {
  fail++;
  console.log(`  ✗ 成批测试没跑完：${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`principal-fold-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
