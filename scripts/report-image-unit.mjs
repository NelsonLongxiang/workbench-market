#!/usr/bin/env node
/**
 * 报告的图片节点（docs/image-step1.md 用例 8，图片第 1 步 PR C）：编排这一层的纯函数单测（server/src/services/report-compile.ts）。
 * 取图、冻结哈希、按报告作来源判权在 scripts/bench-image-test.mjs 的 I11、I12（起隔离实例和本机假图库）。数据都是合成的，不碰库、不外发。
 *
 *   U1 参数的类型契约：month、image 两种；image 参数的值要是合规的图片链接
 *   U2 槽列的类型契约：image 列；取回的格子要是合规链接，绑到别的类型的列拒
 *   U3 image 节点：引用参数、字段、数据行都能解析出链接，冻结前哈希留空，正文里只有链接、替代文字、哈希
 *   U4 拒收：引用的参数不是 image 类型、引用的列不是 image 类型、行引用不在 repeat 里、引用拼字、多写键、替代文字不合、字段值不是链接、超过个数
 *   U5（#1081）栅格里放图；张数上限和 repeat 一致并写明超的是张数；冻结取图的总字节上限（hashImages，假的取图函数）写明超的是字节
 *
 *   node scripts/report-image-unit.mjs
 */
import { IMAGE_BYTES_MAX, IMAGE_NODES_MAX, ReportError, checkBinding, hashImages, imageNodesOf, materialize, prepareInputs } from '../server/src/services/report-compile.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); } };
const J = (x) => JSON.stringify(x);
const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e instanceof ReportError ? e.code : 'throw:' + e?.message; } };
const R = (scope, name) => ({ ref: { scope, name } });
const IMG = (id, src, alt = '图') => ({ id, type: 'image', src, alt });
const T = (body, over = {}) => ({
  schema_version: 2, title: '合成·图片报告',
  parameters: { period: { type: 'month', required: true }, hero: { type: 'image', required: true } },
  fields: { extra: { required: true, max_length: 2048 }, note: { required: false, max_length: 100 } },
  slots: { shots: { columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'image', label: '图片' }, { name: 'name', type: 'text', label: '名字' }], key: ['id'], max_rows: 10, completeness: 'all' } },
  body, claims: [{ kind: 'conclusion', label: '结论', min: 0, max: 1 }], ...over,
});
const B = { shots: { view: 'v', block: 0, params: {}, columns: { id: 'id', pic: 'pic', name: 'name' } } };
const ROWS = [{ id: 1, pic: 'photos/r1.png', name: '甲' }, { id: 2, pic: 'https://example.com/r2.webp', name: '乙' }];
const DATA = (rows = ROWS, picType = 'image') => [{ slot: 'shots', view: 'v', block: 0, view_version: 1, view_sha256: 'x', truncated: false, rows, columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: picType, label: '图片' }, { name: 'name', type: 'text', label: '名字' }] }];
const IN = { parameters: { period: '2026-11', hero: 'photos/hero.png' }, fields: { extra: 'https://example.com/extra.jpg' } };
const run = (body, { input = IN, data = DATA(), over = {} } = {}) => { const t = T(body, over); return materialize(t, checkBinding(t, B), data, prepareInputs(t, input), []); };
const EACH = (child) => ({ id: 'each', type: 'repeat', data: 'shots', row_key: ['id'], max_items: 10, children: [child] });

console.log('U1 参数的类型契约');
{
  const t = T([{ id: 'c', type: 'text', content: ['x'] }]);
  const inp = (hero) => codeOf(() => prepareInputs(t, { parameters: { period: '2026-11', hero }, fields: { extra: 'photos/x.png' } }));
  const good = ['photos/a.png', 'https://example.com/a.png', 'http://example.com/a/b.webp'].map(inp);
  const bad = Object.fromEntries(Object.entries({ js: 'javascript:alert(1)', dotdot: 'photos/../a.png', enc: 'photos/%2e%2e/a.png', abs: '/a.png', ftp: 'ftp://example.com/a.png', userinfo: 'https://u:p@example.com/a.png', space: 'photos/a b.png', long: 'a'.repeat(2049), num: 7, empty: '' }).map(([k, v]) => [k, inp(v)]));
  ok('U1 image 参数：图库相对路径、http(s) 完整链接都收', good.every((c) => c === 'ok'), good);
  ok('U1 image 参数：javascript:、..（含编码的 %2e%2e）、以 / 开头、ftp:、带账号口令、带空白、超长、不是文本、空串：都拒（invalid_image_ref）', Object.values(bad).every((c) => c === 'invalid_image_ref'), bad);
  ok('U1 month 参数照旧：只认 YYYY-MM', codeOf(() => prepareInputs(t, { parameters: { period: '2026-13', hero: 'photos/a.png' }, fields: { extra: 'x' } })) === 'invalid_month');
  ok('U1 参数类型只认 month、image：写成 color、text 拒（invalid_parameter）',
    codeOf(() => prepareInputs(T([], { parameters: { p: { type: 'color', required: false } } }), { parameters: {}, fields: { extra: 'x' } })) === 'invalid_parameter'
    && codeOf(() => prepareInputs(T([], { parameters: { p: { type: 'text', required: false } } }), { parameters: {}, fields: { extra: 'x' } })) === 'invalid_parameter');
  ok('U1 选填的 image 参数不给照过', codeOf(() => prepareInputs(T([], { parameters: { hero: { type: 'image', required: false } } }), { parameters: {}, fields: { extra: 'x' } })) === 'ok');
}

console.log('U2 槽列的类型契约');
{
  const body = [EACH(IMG('shot', R('row', 'pic')))];
  ok('U2 槽里的 image 列、绑到视图块的 image 列：收', codeOf(() => run(body)) === 'ok');
  ok('U2 槽的 image 列绑到块里的文本列：拒（incompatible_column）', codeOf(() => run(body, { data: DATA(ROWS, 'text') })) === 'incompatible_column');
  ok('U2 取回的格子不是合规链接（ftp:、javascript:、非文本）：拒（invalid_cell）',
    ['ftp://example.com/a.png', 'javascript:alert(1)', 7].every((pic) => codeOf(() => run(body, { data: DATA([{ id: 1, pic, name: '甲' }]) })) === 'invalid_cell'));
  ok('U2 槽列类型不认识（video）：拒（invalid_column）',
    codeOf(() => run(body, { over: { slots: { shots: { columns: [{ name: 'id', type: 'integer', label: '编号' }, { name: 'pic', type: 'video', label: '图片' }, { name: 'name', type: 'text', label: '名字' }], key: ['id'], max_rows: 10, completeness: 'all' } } } })) === 'invalid_column');
}

console.log('U3 image 节点：引用参数、字段、数据行');
{
  const out = run([IMG('hero', R('parameter', 'hero'), '头图'), { id: 'sec', type: 'section', title: ['现场'], children: [EACH(IMG('shot', R('row', 'pic'), '现场'))] }, IMG('extra', R('field', 'extra'), '附图')]);
  const imgs = imageNodesOf(out.body.body);
  ok('U3 参数、字段、两行数据各解析出一张：链接是原值，按出现顺序，section 里 repeat 展开的也找得到',
    J(imgs.map((n) => [n.id, n.src, n.alt])) === J([['hero', 'photos/hero.png', '头图'], ['shot/%5B1%5D', 'photos/r1.png', '现场'], ['shot/%5B2%5D', 'https://example.com/r2.webp', '现场'], ['extra', 'https://example.com/extra.jpg', '附图']]), imgs);
  ok('U3 冻结前哈希留空（由取图那一步填）；节点只有 id、type、src、alt、sha256 这几个键，不带图的内容',
    imgs.every((n) => n.sha256 === '' && J(Object.keys(n).sort()) === J(['alt', 'id', 'sha256', 'src', 'type'])));
  ok('U3 imageNodesOf 对不是数组、空的正文给空', J(imageNodesOf(null)) === '[]' && J(imageNodesOf([])) === '[]');
  ok(`U3 正好 ${IMAGE_NODES_MAX} 个图片节点照收`, codeOf(() => run(Array.from({ length: IMAGE_NODES_MAX }, (_, i) => IMG('i' + i, R('parameter', 'hero'))))) === 'ok');
}

console.log('U4 拒收');
{
  const c = (body, opts) => codeOf(() => run(body, opts));
  const got = {
    monthParam: c([IMG('a', R('parameter', 'period'))]),
    textColumn: c([EACH(IMG('a', R('row', 'name')))]),
    integerColumn: c([EACH(IMG('a', R('row', 'id')))]),
    rowOutsideRepeat: c([IMG('a', R('row', 'pic'))]),
    unknownParam: c([IMG('a', R('parameter', 'ghost'))]),
    unknownField: c([IMG('a', R('field', 'ghost'))]),
    unknownColumn: c([EACH(IMG('a', R('row', 'ghost')))]),
    unknownScope: c([IMG('a', R('slot', 'shots'))]),
    fragments: c([IMG('a', ['photos/', R('parameter', 'hero')])]),
    literal: c([IMG('a', 'photos/a.png')]),
    refExtraKey: c([IMG('a', { ref: { scope: 'parameter', name: 'hero', fallback: 'x' } })]),
    nodeExtraKey: c([{ ...IMG('a', R('parameter', 'hero')), width: 100 }]),
    optionalFieldAbsent: c([IMG('a', R('field', 'note'))]),
    fieldNotLink: c([IMG('a', R('field', 'extra'))], { input: { ...IN, fields: { extra: 'javascript:alert(1)' } } }),
    tooMany: c(Array.from({ length: IMAGE_NODES_MAX + 1 }, (_, i) => IMG('i' + i, R('parameter', 'hero')))),
    tooManyByRepeat: c([...Array.from({ length: IMAGE_NODES_MAX - 1 }, (_, i) => IMG('i' + i, R('parameter', 'hero'))), EACH(IMG('shot', R('row', 'pic')))]),
    gridBadSrc: c([{ id: 'g', type: 'grid', columns: [6, 6], items: [IMG('a', 'photos/a.png'), { id: 't', type: 'text', content: ['x'] }] }]),
    gridTable: c([{ id: 'g', type: 'grid', columns: [12], items: [{ id: 'tb', type: 'data-view', component: 'table', data: 'shots', props: { columns: ['id'] } }] }]),
  };
  const want = {
    monthParam: 'image_source_type', textColumn: 'image_source_type', integerColumn: 'image_source_type', rowOutsideRepeat: 'missing_reference',
    unknownParam: 'missing_reference', unknownField: 'missing_reference', unknownColumn: 'missing_reference', unknownScope: 'missing_reference',
    fragments: 'invalid_reference', literal: 'invalid_reference', refExtraKey: 'unknown_key', nodeExtraKey: 'unknown_key', optionalFieldAbsent: 'missing_reference',
    fieldNotLink: 'invalid_image_ref', tooMany: 'image_limit', tooManyByRepeat: 'image_limit', gridBadSrc: 'invalid_reference', gridTable: 'grid_split_unsupported',
  };
  const diff = Object.keys(want).filter((k) => got[k] !== want[k]).map((k) => `${k}: ${got[k]} ≠ ${want[k]}`);
  ok('U4 引用 month 参数、文本列、整数列 → image_source_type；行引用不在 repeat 里、引用不存在的参数字段列、没值的选填字段 → missing_reference；拼字、直接写链接 → invalid_reference；多写键 → unknown_key；字段值不是链接 → invalid_image_ref；超过个数（含 repeat 展开的）→ image_limit；栅格里的图 src 直接写链接 → invalid_reference；表格拆进栅格仍 → grid_split_unsupported', diff.length === 0, diff.join('；'));
  const alts = { missing: c([{ id: 'a', type: 'image', src: R('parameter', 'hero') }]), empty: c([IMG('a', R('parameter', 'hero'), '')]), blank: c([IMG('a', R('parameter', 'hero'), '   ')]),
    long: c([IMG('a', R('parameter', 'hero'), 'x'.repeat(201))]), control: c([IMG('a', R('parameter', 'hero'), '头\u0007图')]), notText: c([IMG('a', R('parameter', 'hero'), ['头图'])]),
    max: c([IMG('a', R('parameter', 'hero'), 'x'.repeat(200))]) };
  ok('U4 替代文字：缺、空、全空白、超过 200 字、带控制字符、不是文本都拒（invalid_alt）；正好 200 字照收',
    Object.entries(alts).every(([k, v]) => (k === 'max' ? v === 'ok' : v === 'invalid_alt')), alts);
}

console.log('U5 栅格里放图、张数上限、总字节上限（#1081）');
{
  const detailOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e instanceof ReportError ? e.code + ':' + (e.detail ?? '') : 'throw:' + e?.message; } };
  const THUMBS = { id: 'thumbs', type: 'grid', columns: [4, 4, 4], items: [IMG('t1', R('row', 'pic'), '小图一'), IMG('t2', R('parameter', 'hero'), '小图二'), IMG('t3', R('field', 'extra'), '小图三')] };
  const out = run([EACH(IMG('main', R('row', 'pic'), '主图')), EACH(THUMBS)].map((n, i) => ({ ...n, id: 'each' + i })));
  const imgs = imageNodesOf(out.body.body);
  ok('U5 一行一张主图，外加一个三列小图栅格：栅格里的 image 照编排，链接来自行、参数、字段，冻结前哈希留空',
    imgs.length === 8 && J(imgs.slice(2, 5).map((n) => [n.id, n.src])) === J([['t1/%5B1%5D', 'photos/r1.png'], ['t2/%5B1%5D', 'photos/hero.png'], ['t3/%5B1%5D', 'https://example.com/extra.jpg']]) && imgs.every((n) => n.sha256 === ''), imgs.map((n) => n.id));
  ok(`U5 张数上限是 ${IMAGE_NODES_MAX}（和 repeat 的 max_items 上限一致）：正好收，多一张报 image_limit 并写明 count`,
    IMAGE_NODES_MAX === 100 && detailOf(() => run(Array.from({ length: IMAGE_NODES_MAX }, (_, i) => IMG('i' + i, R('parameter', 'hero'))))) === 'ok'
    && detailOf(() => run(Array.from({ length: IMAGE_NODES_MAX + 1 }, (_, i) => IMG('i' + i, R('parameter', 'hero'))))) === 'image_limit:count');
  const nodes = () => [{ id: 'a', type: 'image', src: 'photos/a.png', alt: 'a', sha256: '' }, { id: 'b', type: 'image', src: 'photos/b.png', alt: 'b', sha256: '' }, { id: 'a2', type: 'image', src: 'photos/a.png', alt: 'a', sha256: '' }];
  const fetched = [];
  const fake = async (src) => { fetched.push(src); return Buffer.alloc(src.endsWith('a.png') ? 600 : 400, 1); };
  const same = nodes(); await hashImages(same, fake, 1000);
  ok('U5 hashImages：同一链接只取一次、只算一次字节；正好等于总字节上限照收，三个节点都填上哈希',
    J(fetched) === J(['photos/a.png', 'photos/b.png']) && same.every((n) => /^[0-9a-f]{64}$/.test(n.sha256)) && same[0].sha256 === same[2].sha256, fetched);
  fetched.length = 0;
  let err = null; try { await hashImages([...nodes(), { id: 'c', type: 'image', src: 'photos/c.png', alt: 'c', sha256: '' }], fake, 999); } catch (e) { err = e; }
  ok('U5 hashImages：总字节超过上限报 image_limit 并写明 bytes，指到超限那张图的节点，之后的图不再取',
    err instanceof ReportError && err.code === 'image_limit' && err.detail === 'bytes' && err.path === '/body/b' && J(fetched) === J(['photos/a.png', 'photos/b.png']), err?.message);
  ok('U5 缺省总字节上限 64MB，单张仍受代取的 5MB 限', IMAGE_BYTES_MAX === 64 * 1024 * 1024);
}

console.log(`\nreport-image-unit: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
