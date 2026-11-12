#!/usr/bin/env node
/** 工作台市场页的纯函数单测（web/src/market-view.ts）：三个来源合成卡片、分类计数、读不到和空着时怎么说。数据都是合成的。 */
import { NO_DESCRIPTION, benchSlugFor, viewTitles, cardTags, connectorCards, detailProblem, manageHref, tabsFor, workbenchIdOf, cardsOf, emptyText, extraTags, healthLabel, initialOf, runningBySlug, skillCards, sopCards, sourceProblem, tabFromQuery, usableIcon, workbenchCards } from '../web/src/market-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

const wb = (id, name, more = {}) => ({ id, name, url: 'http://wb.example/', type: 'web', icon: '', description: '', category: '', tags: [], enabled: true, last_status: 'up', sort: 0, ...more });
const sop = (slug, more = {}) => ({ id: 1, slug, title: slug, description: '', created_by: '', active_version: 1, status: 'published', kind: 'sop', versions: [], ...more });
const skill = (slug, more = {}) => ({ slug, name: slug, layer: 1, layer_name: '业务角色', family_parent: '', description: '', legacy: false, versions: 1, active_version: 1, ...more });

// 头一个字、图标
ok('头一个字：汉字、英文转大写、emoji 不切坏；空的给一个点', initialOf('合成台') === '合' && initialOf('alpha') === 'A' && initialOf('🧪实验') === '🧪' && initialOf('  ') === '·');
ok('图标：emoji 直接用；网址、英文图标名、长串、非字符串都不用', usableIcon('💹') === '💹' && usableIcon('https://x/a.png') === null && usableIcon('AppstoreOutlined') === null && usableIcon('很长的一串文字') === null && usableIcon(3) === null && usableIcon('') === null);
ok('健康：在线、离线、还没检查过；认不出的当还没检查过', healthLabel('up') === '在线' && healthLabel('down') === '离线' && healthLabel('unknown') === '还没检查过' && healthLabel('weird') === '还没检查过');

// 工作台
const wbs = workbenchCards([wb(2, '乙台', { sort: 1 }), wb(1, '甲台', { icon: '💹', category: '分类一', tags: ['a', '', 'b', 'c', 'd'], last_status: 'down' }), wb(3, '停用台', { enabled: false }), { id: 'x', name: 'bad' }, null]);
ok('工作台：停用的、形状不对的不列；按 sort 再按名字排', J(wbs.map((c) => c.name)) === '["甲台","乙台"]', J(wbs.map((c) => c.name)));
ok('工作台：图标、分类、标签最多三个、健康、去处 /use/<id>、「打开」', wbs[0].icon === '💹' && !wbs[0].initial && wbs[0].caption === '分类一' && J(wbs[0].tags) === '["a","b","c"]' && wbs[0].usage === '离线' && wbs[0].href === '/use/1' && wbs[0].action === '打开');
ok('工作台：没有图标用名字的头一个字', wbs[1].icon === '乙' && wbs[1].initial === true);
const checked = workbenchCards([wb(5, '有检测', { last_checked_at: '2026-11-11 10:00:00' }), wb(6, '空检测', { last_checked_at: '  ' })]);
ok('工作台：带最近一次检测时间（页面接相对时间）；空的不带', checked.find((c) => c.name === '有检测').checkedAt === '2026-11-11 10:00:00' && !('checkedAt' in checked.find((c) => c.name === '空检测')));
ok('工作台：应答不是数组按空处理，不抛', workbenchCards({ error: 'x' }).length === 0 && workbenchCards(null).length === 0);

// 流程
const running = runningBySlug([{ sop_slug: 'p-a', status: 'running' }, { sop_slug: 'p-a', status: 'running' }, { sop_slug: 'p-a', status: 'finished' }, { sop_slug: 7, status: 'running' }, null]);
ok('在办：只数 running，按流程分', running.get('p-a') === 2 && running.size === 1);
ok('在办：应答不是数组就是空的', runningBySlug({}).size === 0);
const sops = sopCards([sop('p-b', { title: '乙流程', active_version: 3 }), sop('p-a', { title: '甲流程', description: ' 说明 ' }), sop('draft', { status: 'draft' }), sop('old', { status: 'deprecated' }), sop('task-center', { title: '任务中心' })], running);
ok('流程：只列已发布的；草稿、停用的、任务中心的录入模板不进市场', J(sops.map((c) => c.name)) === '["甲流程","乙流程"]', J(sops.map((c) => c.name)));
ok('流程：版本、在办数、去处 /sops/<slug>', sops[1].caption === '第 3 版' && sops[0].usage === '在办 2 件' && sops[1].usage === '现在没有在办的' && sops[0].href === '/sops/p-a' && sops[0].description === '说明');
ok('流程：在办数读不到时不写，不说成 0', sopCards([sop('p-a')], null)[0].usage === '');
ok('流程：slug 里的怪字符编码进地址', sopCards([sop('a b')], null)[0].href === '/sops/a%20b');

// 技能
const sks = skillCards([skill('s-2', { name: '乙技能', layer: 2, layer_name: '开发运维', family_parent: '族一', legacy: true, versions: 3 }), skill('s-1', { name: '甲技能' }), skill('s-0', { versions: 0 })]);
ok('技能：没有版本的不列；按层再按名字排', J(sks.map((c) => c.name)) === '["甲技能","乙技能"]', J(sks.map((c) => c.name)));
ok('技能：层、族和「旧版」标签、版本数、「查看」', sks[1].caption === '开发运维' && J(sks[1].tags) === '["族一","旧版"]' && sks[1].usage === '3 个版本' && sks[1].action === '查看' && sks[1].href === '/skills');
ok('技能：应答是 { items } 也认；别的形状按空', skillCards({ items: [skill('s-1')] }).length === 1 && skillCards({ error: 'x' }).length === 0);

// 标签行、说明
ok('标签行：只放类别以外的标签；只有类别时是空的（页面不显示这一行）', J(extraTags({ kind: '工作台', tags: ['工作台', '财务'] })) === '["财务"]' && extraTags({ kind: '流程', tags: [] }).length === 0);
ok('没有说明的卡片写一句中性的话', NO_DESCRIPTION === '还没有说明');

// 分类
const all = [...wbs, ...sops, ...sks];
ok('分类：全部原样，别的只留那一类', cardsOf(all, '全部').length === 6 && cardsOf(all, '流程').length === 2 && cardsOf(all, '流程').every((c) => c.kind === '流程'));
ok('地址里的分类：认得的照用（连接器也认，不是管理员时页面再落「全部」），认不出、没写的当全部', tabFromQuery('技能') === '技能' && tabFromQuery('连接器') === '连接器' && tabFromQuery('乱写') === '全部' && tabFromQuery(null) === '全部');
ok('卡片的 key 各不相同', new Set(all.map((c) => c.key)).size === all.length);

// 说法
ok('读不到：401 请先登录、403 不能查看、404 没上线、500 和断网读不到', sourceProblem('工作台', { status: 401, body: {} }).text.startsWith('请先登录') && sourceProblem('流程', { status: 403, body: {} }).text === '你的账号现在不能查看流程。' && sourceProblem('技能', { status: 404, body: {} }).type === 'info' && sourceProblem('技能', { status: 500, body: {} }).text === '读不到技能，稍后再试。' && sourceProblem('工作台', { status: 0, body: null }).type === 'warning');
ok('读到了、还没读：没有说法', sourceProblem('工作台', { status: 200, body: [] }) === null && sourceProblem('工作台', null) === null);
ok('空着：每一类说为什么空、下一步做什么；工作台对管理员指到「管理工作台」', emptyText('工作台', true).includes('管理工作台') && !emptyText('工作台', false).includes('管理工作台') && emptyText('流程', false).includes('SOP 交付空间') && emptyText('全部', false).length > 0);
ok('说法里没有开发用语', [emptyText('全部', true), emptyText('工作台', true), emptyText('流程', true), emptyText('技能', true), sourceProblem('工作台', { status: 500 }).text].every((t) => !/接口|字段|暂无数据|待实现|slug/.test(t)));

// 连接器只给管理员；类别标签只在「全部」补；详情页的说法
ok('分类页签：不是管理员没有「连接器」，管理员有、排最后', tabsFor(false).join() === '全部,工作台,流程,技能' && tabsFor(true).join() === '全部,工作台,流程,技能,连接器');
ok('卡片标签：「全部」里第一个补类别；某一类的页签里不重复类别（#584）', cardTags({ kind: '工作台', tags: ['财务', '工作台'] }, '全部').join() === '工作台,财务' && cardTags({ kind: '工作台', tags: ['财务', '工作台'] }, '工作台').join() === '财务' && cardTags({ kind: '技能', tags: [] }, '技能').length === 0);
const conns = connectorCards([{ prefix: 'zz', reachable: false }, { prefix: 'aa', kind: 'ygl-trees', reachable: true, tools: 4, last_checked_at: '2026-11-12 08:00:00' }, { prefix: 'mm', enabled: false, reachable: true, tools: 2 }, { prefix: 'nn' }, { prefix: '' }, null]);
ok('连接器卡片：按名字排；连得上写几个工具，连不上、停用、还没检查过各说各的；去 MCP 网关管理页', conns.map((c) => `${c.name}:${c.usage}`).join('|') === 'aa:连得上 · 4 个工具|mm:已停用|nn:还没检查过|zz:连不上' && conns.every((c) => c.kind === '连接器' && c.href === '/mcp-gateways') && conns[0].caption === '经验库连接' && conns[0].checkedAt && !conns[1].checkedAt, JSON.stringify(conns.map((c) => [c.name, c.usage])));
ok('连接器应答形状不对：按空处理', connectorCards(null).length === 0 && connectorCards({ upstreams: [] }).length === 0);
ok('详情页读不到：不在了 / 请先登录 / 没权限 / 读不到 各说各的；读到了是 null', detailProblem(200) === null && detailProblem(404).kind === 'gone' && detailProblem(401).kind === 'login' && detailProblem(403).kind === 'denied' && detailProblem(500).kind === 'error' && detailProblem(0).kind === 'error');
ok('地址里的台号：正整数才认', workbenchIdOf('12') === 12 && workbenchIdOf('0') === null && workbenchIdOf('abc') === null && workbenchIdOf('1.5') === null && workbenchIdOf(undefined) === null && workbenchIdOf('-3') === null);
ok('「编辑」回管理页那一行：?q=台名（编码过）', manageHref('采购 台&x') === '/market/manage?q=' + encodeURIComponent('采购 台&x'));

// 这个台的数据视图（#674 的 workbench_id）：只按台号对，不按名字；取不到都当没有
{
  const list = { benches: [{ slug: 'pricing', title: '定价台', workbench_id: 7 }, { slug: 'ops', title: '运营台', workbench_id: null }, { slug: 'same-name', title: '任务中心', workbench_id: 9 }] };
  ok('数据视图的台：只认 workbench_id 正好是这个台号的那一项', benchSlugFor(200, list, 7) === 'pricing' && benchSlugFor(200, list, 8) === null && benchSlugFor(200, list, 9) === 'same-name');
  ok('清单没取到（401 / 403 / 404 / 出错）或形状不对：当没有', benchSlugFor(403, list, 7) === null && benchSlugFor(404, { error: 'bench_views_off' }, 7) === null && benchSlugFor(200, { benches: 'x' }, 7) === null && benchSlugFor(200, null, 7) === null && benchSlugFor(200, { benches: [{ slug: 'x', workbench_id: '7' }] }, 7) === null);
  const doc = { view: { content: { views: [{ key: 'board', title: '利润看板' }, { key: 'rows', title: ' 商品明细 ' }, { key: 'nokey' }] } } };
  ok('视图的名字：取 view.content.views[].title；没写名字的不拿键顶替；没取到都是空', viewTitles(200, doc).join() === '利润看板,商品明细' && viewTitles(403, doc).length === 0 && viewTitles(200, { view: null }).length === 0);
}

console.log(`\nmarket-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
