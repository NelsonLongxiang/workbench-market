#!/usr/bin/env node
/** 报告页（/use/<卡片 id>/reports，报告第 1 步 PR D）的纯函数单测（web/src/report-page-view.ts）：地址、分组、并排取哪几份、回应接在谁后面、错误说法。数据都是合成的。 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { REPORT_IMAGE_TEXT, loadReportImage, reportImageSrc, reportImageState, STANCE_TEXT, UNNAMED, actorKindText, basisText, gateText, nameOr, positionText, sourceText, groupBySubject, headsOf, kindLabel, myHead, replacedIds, reportError, reportRoute, respondProblem, stanceText } from '../web/src/report-page-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);
const Q = (s) => new URLSearchParams(s);
const R = (id, dimension_id, subject, at, extra = {}) => ({ id, dimension_id, subject, created_at: at, superseded_by: null, supersedes: null, template_version: 1, binding_version: 1, content_sha256: 'x', producer: 'user:alpha', producer_kind: 'human', ...extra });
const resp = (id, claim_key, stance, extra = {}) => ({ id, report_id: 1, claim_key, stance, reason: '合成', responder: 'user:alpha', responder_kind: 'human', position: '', supersedes: null, created_at: id, mine: true, ...extra });

// 地址
ok('地址：?report=<编号> 看一份；?subject=<事物> 并排；都没有是清单', J(reportRoute(Q('report=12'))) === J({ kind: 'one', id: 12 }) && J(reportRoute(Q('subject=item:7'))) === J({ kind: 'subject', subject: 'item:7' }) && reportRoute(Q('')).kind === 'list');
ok('地址：认不出的当没写（编号不是正整数、事物写法不对）；report 和 subject 都写了以 report 为准', reportRoute(Q('report=0')).kind === 'list' && reportRoute(Q('report=1e3')).kind === 'list' && reportRoute(Q('subject=Item:7')).kind === 'list' && reportRoute(Q('subject=item')).kind === 'list' && reportRoute(Q('report=3&subject=item:7')).kind === 'one');

// 分组与并排
const list = [
  R(1, 'finance', 'item:7', 100, { superseded_by: 3 }),
  R(2, 'risk', 'item:7', 110),
  R(3, 'finance', 'item:7', 120, { supersedes: 1 }),
  R(4, 'finance', 'item:9', 90),
  R(5, 'risk', 'item:7', 105),
];
const g = groupBySubject(list);
ok('分组：按事物分，最近有新报告的事物排前面', J(g.map((x) => x.subject)) === J(['item:7', 'item:9']) && g[0].latest === 120);
ok('并排：一件事物下每个维度一份，按维度标识排；被更正过的不选，选更正后的那份', J(g[0].dims.map((d) => [d.dimension_id, d.head.id])) === J([['finance', 3], ['risk', 5]]));
ok('并排：同一维度有几份各自独立生成的链头，取编号最大的，另有几份记在 others', g[0].dims.find((d) => d.dimension_id === 'risk').others === 1 && g[0].dims.find((d) => d.dimension_id === 'finance').others === 0);
ok('并排：全部被更正（链头不在这批里）的维度不出；没有一份能看的事物整组不出', J(headsOf([R(1, 'a', 's:1', 1, { superseded_by: 2 })])) === '[]' && J(groupBySubject([R(1, 'a', 's:1', 1, { superseded_by: 2 })])) === '[]');

// 回应接在谁后面
const rs = [
  resp(10, 'conclusion-1', 'dispute'),
  resp(11, 'conclusion-1', 'agree', { supersedes: 10 }),
  resp(12, 'conclusion-1', 'dispute', { mine: false, responder: 'mcp:seat', responder_kind: 'ai' }),
  resp(13, '', 'supplement'),
  resp(14, 'risk-1', 'agree', { mine: false, responder: 'user:beta' }),
];
ok('改主意接在自己的链头：自己这条论断上没被接掉的最新一条（不是别人的、不是别的论断的）', myHead(rs, 'conclusion-1')?.id === 11 && myHead(rs, '')?.id === 13 && myHead(rs, 'risk-1') === null);
ok('自己没回应过、或者没标 mine（读接口没给读的人）：没有链头，回应是新起一条', myHead([], 'conclusion-1') === null && myHead(rs.map((r) => ({ ...r, mine: undefined })), 'conclusion-1') === null);
ok('被接掉（改过主意）的回应：划掉显示', J([...replacedIds(rs)]) === '[10]');

// 回应框、说法
ok('回应框：立场要是模板允许的；理由必填（空白不算）、最多 4000 字', respondProblem(['agree', 'dispute'], 'supplement', '理由') === '先选一个立场' && respondProblem(['agree'], '', '理由') === '先选一个立场' && respondProblem(['agree'], 'agree', '  ') === '理由必填' && respondProblem(['agree'], 'agree', '理'.repeat(4001)).includes('4000') && respondProblem(['agree'], 'agree', '理'.repeat(4000)) === '');
ok('没成的说法：400、404、409 照服务端说，它没说给一句默认的；401、403、断网各一句；500 不透露原文',
  reportError(400, { message: '理由必填：1～4000 个字' }) === '理由必填：1～4000 个字' && reportError(409, { message: '只能接在你自己回应链的链头上' }).includes('链头') && reportError(409, null).includes('刷新')
  && reportError(404, {}) === '没有这份报告' && reportError(401, null) === '请先登录' && reportError(403, { message: 'x' }).includes('权限') && reportError(0, null).includes('连不上') && reportError(500, { message: 'SQLITE_ERROR raw' }) === '这次没成，稍后再试');
ok('立场、类别、人或 AI、验收声明的说法（认不出的立场、模板里没有的类别写「未命名」，不显示键）', STANCE_TEXT.dispute === '反驳' && stanceText('agree') === '认可' && stanceText('other') === UNNAMED && kindLabel([{ kind: 'conclusion', label: '结论' }], 'conclusion') === '结论' && kindLabel([], 'risk') === UNNAMED
  && actorKindText('ai') === 'AI' && actorKindText('human') === '人' && gateText(null) === '' && gateText({ open_dispute_blocks_acceptance: true }).includes('不能验收') && gateText({ open_dispute_blocks_acceptance: false }).includes('也可以验收'));

// 不露内部标识（#937 统筹）：名字由服务端给，取不到写「未命名」，不退回去显示维度键、主体串、授予串、槽名、视图键
ok('名字：有就用；null、空白、没给都写「未命名」', nameOr('月度经营') === '月度经营' && nameOr(null) === UNNAMED && nameOr('  ') === UNNAMED && nameOr(undefined) === UNNAMED && UNNAMED === '未命名');
ok('位置：「角色名（范围名）」顿号连；取不到的那一半写「未命名」；MCP 会话、内置身份各一个说法；没有位置是空串',
  positionText([{ role: '管理层', scope: '全公司' }, { role: '领域成员', scope: null }]) === '管理层（全公司）、领域成员（未命名）' && positionText([{ role: null, scope: '合成领域' }]) === '未命名（合成领域）'
  && positionText('mcp') === 'MCP 会话' && positionText('builtin') === '内置身份' && positionText([]) === '' && positionText(undefined) === '');
ok('来源一行：视图名（块名）第几版、几行；名字取不到写「未命名」，不写视图键、槽名',
  sourceText({ slot: 'orders', view: '订单总览', block: '本月订单' }, { view_version: 3, rows: 12 }) === '订单总览（本月订单） 第 3 版，12 行'
  && sourceText({ slot: 'orders', view: null, block: null }, { view_version: 3, rows: 12 }) === '未命名 第 3 版，12 行' && !sourceText(undefined, { view_version: 1, rows: 0 }).includes('orders'));
ok('依据：按槽找到视图名，后面是行键的值；找不到写「未命名」，不写槽名',
  basisText([{ slot: 'orders', view: '订单总览', block: null }], { slot: 'orders', key: ['A-1', 2] }) === '订单总览：A-1 / 2' && basisText([], { slot: 'orders', key: ['A-1'] }) === '未命名：A-1');

// 纯文本（#937 统筹，照 #939）：带 <script>、<img onerror> 的值原样当文字给出；页面不用 innerHTML
const XSS = '<script>window.__xss=1</script><img src=x onerror="window.__xss=2">';
ok('XSS：名字、来源、依据、位置里的 <script>、<img onerror> 原样当文字给出，不转换',
  nameOr(XSS) === XSS && basisText([{ slot: 's', view: XSS, block: null }], { slot: 's', key: [XSS] }) === `${XSS}：${XSS}` && positionText([{ role: XSS, scope: XSS }]) === `${XSS}（${XSS}）`
  && kindLabel([{ kind: 'k', label: XSS }], 'k') === XSS && reportError(400, { message: XSS }) === XSS);
const pageSrc = readFileSync(new URL('../web/src/pages/BenchReports.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../web/src/report-page-view.ts', import.meta.url), 'utf8');
ok('源码：报告页和它的纯函数里不出现 dangerouslySetInnerHTML、innerHTML、outerHTML、insertAdjacentHTML、document.write', !/dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/.test(pageSrc));

// I1（#965）：按字段名查，不靠前缀。用 TypeScript 解析报告页：凡是画成文字的 JSX 表达式（元素的子节点，含其中的模板字符串），
// 里面读到这几个内部字段的，只许是 names.<类>[…] 的下标；属性值（attr={…}）不显示，不算
const ts = createRequire(new URL('../web/package.json', import.meta.url))('typescript');
const INTERNAL = new Set(['dimension_id', 'producer', 'responder', 'position', 'claim_key', 'slot', 'view']);
function internalReadsInText(src) {
  const sf = ts.createSourceFile('BenchReports.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const inNamesIndex = (n) => { for (let p = n; p; p = p.parent) { if (ts.isElementAccessExpression(p) && p.expression.getText(sf).startsWith('names.') && n.pos >= p.argumentExpression.pos && n.end <= p.argumentExpression.end) return true; if (ts.isJsxExpression(p)) return false; } return false; };
  const isJsx = (m) => ts.isJsxElement(m) || ts.isJsxFragment(m) || ts.isJsxSelfClosingElement(m);
  // 先解构再用（#965 统筹）：const { producer } = r、({ responder: who }) => …——记下解构出来的本地名，画成文字时读到它也算
  const bound = new Set();
  const collect = (n) => {
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.name)) {
      const key = n.propertyName ?? n.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && INTERNAL.has(key.text)) bound.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const hit = (n) => hits.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf)}`);
  // scan：一段画成文字的表达式；里面嵌着的 JSX 交回 visit（它的属性值不算、子节点再按文字查）
  const scan = (n) => {
    if (isJsx(n)) return visit(n);
    if (ts.isPropertyAccessExpression(n) && INTERNAL.has(n.name.text) && !inNamesIndex(n)) hit(n);
    // 下标写法 d['dimension_id']（#965 统筹）
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && INTERNAL.has(n.argumentExpression.text) && !inNamesIndex(n)) hit(n);
    else if (ts.isIdentifier(n) && bound.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !inNamesIndex(n)) hit(n);
    ts.forEachChild(n, scan);
  };
  // 属性值不显示：只找其中嵌着的 JSX（如 message={<>…</>}），交回 visit
  const jsxIn = (m) => (isJsx(m) ? visit(m) : ts.forEachChild(m, jsxIn));
  const visit = (n) => {
    if (ts.isJsxAttribute(n)) { if (n.initializer) jsxIn(n.initializer); return; }
    if (ts.isJsxExpression(n) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) { if (n.expression) scan(n.expression); return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}
const pageOnly = readFileSync(new URL('../web/src/pages/BenchReports.tsx', import.meta.url), 'utf8');
const hits = internalReadsInText(pageOnly);
ok('源码（按字段名，I1）：报告页画成文字的地方不读 dimension_id、producer、responder、position、claim_key、slot、view，除非是 names[…] 的下标（属性值不算）', hits.length === 0, hits.join('；'));
ok('源码检查自证：直接写 {d.dimension_id}、经别的前缀或拼进模板字符串都抓得到；names[d.dimension_id]、属性值 data-x={d.dimension_id} 不算',
  internalReadsInText('const A = () => <li data-x={d.dimension_id}>{d.dimension_id}</li>;').length === 1
  && internalReadsInText('const A = () => <p>{`${g.head.producer} 写的`}</p>;').length === 1
  && internalReadsInText('const A = () => <p>{nameOr(names.dimensions[d.dimension_id])}{x.y.slot ?? 1}</p>;').length === 1
  && internalReadsInText('const A = () => <Alert message={<>来自 {r.responder}</>} />;').length === 1
  && internalReadsInText('const A = () => <p key={c.claim_key}>{nameOr(names.actors[r.responder])}</p>;').length === 0);
ok('源码检查自证（#965 统筹补）：下标写法 d[\'dimension_id\']、先解构再用（含改名）都抓得到；解构出来的名字放进 names[…] 下标、或只用在属性值里不算',
  internalReadsInText("const A = () => <p>{d['dimension_id']}</p>;").length === 1
  && internalReadsInText('const A = ({ producer }) => <p>{producer} 写的</p>;').length === 1
  && internalReadsInText('const { responder: who } = r; const A = () => <p>{`来自 ${who}`}</p>;').length === 1
  && internalReadsInText('const { producer } = r; const A = () => <p data-p={producer}>{nameOr(names.actors[producer])}</p>;').length === 0
  && internalReadsInText("const A = () => <p>{nameOr(names.dimensions[d['dimension_id']])}</p>;").length === 0);

// 图片节点（docs/image-step1.md 用例 8，图片第 1 步 PR C）：地址经代取、来源是这份报告；应答码 → 显示、「图片已变」、「图片取不到」
{
  const src = reportImageSrc('synth-rep', 12, 'photos/a b&c.png');
  const q = new URL(src, 'http://x').searchParams;
  ok('图片：地址是本台的代取路由，带原链接（编码）和 report=编号，不带 view；浏览器不直接访问链接',
    src.startsWith('/api/bench-views/synth-rep/image?') && q.get('u') === 'photos/a b&c.png' && q.get('report') === '12' && !q.has('view') && !src.includes('photos/a b'));
  ok('图片：没有链接、编号不是正整数、没有台：给 null（页面画「图片取不到」）',
    [reportImageSrc('synth-rep', 12, ''), reportImageSrc('synth-rep', 12, null), reportImageSrc('synth-rep', 0, 'a.png'), reportImageSrc('synth-rep', 1.5, 'a.png'), reportImageSrc('', 1, 'a.png')].every((x) => x === null));
  ok('图片：200 照显示；409（冻结哈希对不上）「图片已变」；401、403、404、415、502、503、504 都「图片取不到」',
    reportImageState(200) === 'ok' && reportImageState(409) === 'changed' && [401, 403, 404, 415, 502, 503, 504, 0].every((s) => reportImageState(s) === 'missing')
    && REPORT_IMAGE_TEXT.changed === '图片已变' && REPORT_IMAGE_TEXT.missing === '图片取不到');
  const page = readFileSync(new URL('../web/src/pages/BenchReports.tsx', import.meta.url), 'utf8');
  const comp = page.slice(page.indexOf('function ReportImage'), page.indexOf('/** 台页面顶栏'));
  ok('源码：正文按 image 节点画 ReportImage，地址取 reportImageSrc、取图与状态经 loadReportImage；显示的是取到的那份（blob），不写链接原文、不写内联样式和写死的颜色',
    /n\.type === 'image'\) return <ReportImage/.test(page) && /reportImageSrc\(img\.bench, img\.report, node\.src\)/.test(comp) && /loadReportImage\(/.test(comp)
    && /URL\.createObjectURL/.test(comp) && !/\{node\.src\}/.test(comp) && !/style=\{\{/.test(comp) && !/#[0-9A-Fa-f]{3,6}\b|rgba?\(/.test(comp));
}

// #1033 评审 B1：取图的每一步失败都闭合成「图片取不到」，不留在加载中、不产生未处理的拒绝（合成响应，不起浏览器）
{
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const res = (status, body = async () => blob) => async () => ({ status, blob: body });
  const urls = [];
  const toUrl = (b) => { urls.push(b); return 'blob:synthetic/' + urls.length; };
  const got = {
    fetchRejects: await loadReportImage('/x', async () => { throw new TypeError('synthetic network down'); }, toUrl),
    bodyRejects: await loadReportImage('/x', res(200, async () => { throw new TypeError('synthetic body interrupted'); }), toUrl),
    urlThrows: await loadReportImage('/x', res(200), () => { throw new Error('synthetic createObjectURL failed'); }),
    ok: await loadReportImage('/x', res(200), toUrl),
    changed: await loadReportImage('/x', res(409), toUrl),
    forbidden: await loadReportImage('/x', res(403), toUrl),
    noSrc: await loadReportImage(null, res(200), toUrl),
  };
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  ok('图片取一次的各条路：请求失败、200 之后读 body 失败、建 blob 地址失败都「图片取不到」；200 显示 blob 地址；409「图片已变」；403、没有地址「图片取不到」；全程没有未处理的拒绝',
    got.fetchRejects.phase === 'missing' && got.bodyRejects.phase === 'missing' && got.urlThrows.phase === 'missing'
    && got.ok.phase === 'shown' && got.ok.url === 'blob:synthetic/1' && got.changed.phase === 'changed' && got.forbidden.phase === 'missing' && got.noSrc.phase === 'missing' && unhandled === 0,
    J({ got, unhandled }));
  const page = readFileSync(new URL('../web/src/pages/BenchReports.tsx', import.meta.url), 'utf8');
  const comp = page.slice(page.indexOf('function ReportImage'), page.indexOf('/** 台页面顶栏'));
  ok('源码：ReportImage 只经 loadReportImage 取图（自己不读 r.blob()、不写 then 的第二个回调），卸载后取到的 blob 地址要收回',
    /loadReportImage\(src, \(u\) => fetch\(u, \{ credentials: 'same-origin' \}\), \(b\) => URL\.createObjectURL\(b\)\)/.test(comp) && !/\.blob\(\)/.test(comp) && !/\}, \(\) => \{ if \(live\)/.test(comp)
    && /if \(!live\) \{ if \(out\.phase === 'shown'\) URL\.revokeObjectURL\(out\.url\)/.test(comp));
}

console.log(`\nreport-page-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
