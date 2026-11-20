#!/usr/bin/env node
/** 一人一助理的页面说法和整形（web/src/assistant-view.ts）：接口形状按 docs/assistant-phase1.md 第六节（#829）。全是合成值。 */
const { ANSWER_TEXT, STATUS_TEXT, showEntry, STATUS_TONE, actionError, actionsOf, assistantOf, pageKind, tokenLine } = await import('../web/src/assistant-view.ts');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const J = JSON.stringify;

const BODY = { assistant: 'assistant:syn-a', status: 'active', enabled_by_deployment: true, has_token: true, token_created_at: '2026-11-18T08:00:00Z', token_last_used_at: null, mcp_url: 'https://market.example/mcp', actions_30d: 4, pending_confirms: 1 };
const a = assistantOf(BODY);
ok('助理信息整形：状态、部署开没开、有没有令牌、接入地址、近 30 天件数、等你确认件数', a && a.status === 'active' && a.enabled && a.hasToken && a.tokenLastUsedAt === null && a.mcpUrl === 'https://market.example/mcp' && a.actions30d === 4 && a.pendingConfirms === 1, J(a));
ok('助理的主体标识（assistant:…）不进整形结果，页面拿不到也就写不出来', !J(a).includes('assistant:'));
ok('部署方没开：enabled 为假（只认严格的 true）', assistantOf({ ...BODY, enabled_by_deployment: 'true' }).enabled === false && assistantOf({ ...BODY, enabled_by_deployment: undefined }).enabled === false);
ok('状态不是 active / disabled、不是对象：当看不懂（null）', assistantOf({ ...BODY, status: 'paused' }) === null && assistantOf(null) === null && assistantOf('x') === null);
ok('件数不是非负整数的当 0', assistantOf({ ...BODY, actions_30d: -1, pending_confirms: '3' }).actions30d === 0 && assistantOf({ ...BODY, pending_confirms: '3' }).pendingConfirms === 0);

ok('页面状态：200 看得懂 → 正常；看不懂 → 出错', pageKind(200, BODY).kind === 'ok' && pageKind(200, { status: 'x' }).kind === 'error');
ok('页面状态：401 去登录；403 只认本人会话（口令、令牌）；404 服务端还没上线；断网、别的出错', pageKind(401, {}).kind === 'login' && pageKind(403, { error: 'session_only' }).kind === 'session-only' && pageKind(403, { error: 'session_only' }).text.includes('管理员口令') && pageKind(404, {}).kind === 'missing' && pageKind(0, null).text.includes('连不上') && pageKind(500, {}).kind === 'error');
ok('动作没办成：404 是本站没开放；跨站、不是本人、没登录、断网各一句', actionError(404, {}).includes('没开放') && actionError(403, { error: 'cross_site' }).includes('本站页面') && actionError(403, { error: 'session_only' }).includes('本人') === false && actionError(403, { error: 'session_only' }).includes('站内账号') && actionError(401, {}) === '请先登录' && actionError(0, null).includes('连不上'));

ok('读的 403：session_only 才算「只认本人」；跨站、别的 403 各说各的（当出错）', pageKind(403, { error: 'cross_site' }).kind === 'error' && pageKind(403, { error: 'cross_site' }).text.includes('本站打开') && pageKind(403, {}).kind === 'error' && pageKind(403, {}).text.includes('没有权限'));
ok('动作 404：取令牌说不能取令牌；停用启用说不能停用或启用（不再都说令牌）', actionError(404, {}, 'token').includes('取令牌') && actionError(404, {}, 'power').includes('停用或启用') && !actionError(404, {}, 'power').includes('令牌'));
ok('动作 403：别的 403 说没有权限，不按「只认本人」说', actionError(403, {}).includes('没有权限') && !actionError(403, {}).includes('站内账号'));
ok('用户卡入口：只在 200、看得懂、部署方开放时出', showEntry(200, BODY) === true);
ok('用户卡入口：没开放、没登录、口令或令牌、服务端没有接口、出错、看不懂，都不出',
  showEntry(200, { ...BODY, enabled_by_deployment: false }) === false && showEntry(401, {}) === false && showEntry(403, { error: 'session_only' }) === false && showEntry(404, {}) === false && showEntry(500, {}) === false && showEntry(0, null) === false && showEntry(200, { status: 'x' }) === false);

ok('九种确认状态都有人话和颜色（服务端 #829 第三节）', ['pending', 'confirming', 'done', 'failed', 'declined', 'expired', 'stale', 'denied', 'cancelled'].every((s) => STATUS_TEXT[s] && STATUS_TONE[s]));
ok('人话里没有英文代号', Object.values(STATUS_TEXT).concat(Object.values(ANSWER_TEXT)).every((t) => !/[A-Za-z]/.test(t)));
ok('五种回答都有人话：确认、不办、超时、待确认、作废', ['confirm', 'decline', 'timeout', 'pending', 'cancelled'].every((s) => ANSWER_TEXT[s]));

const acts = actionsOf({ items: [
  { id: 'c-syn-1', at: '2026-11-18T09:00:00Z', tool: 'work_item_set_due', tool_label: '改期限', description: '把「合成事项」的期限改成 11 月 20 日', answer: 'confirm', status: 'done', result: {}, link: '/work-items/wi-syn-1' },
  { id: 'c-syn-2', at: '2026-11-18T08:00:00Z', tool: 'x', tool_label: '', description: '合成：另一件', answer: 'timeout', status: 'expired', link: 'https://evil.example/x' },
  { id: 'c-syn-3', description: '状态认不出', status: 'weird' }, { id: '', description: '没编号', status: 'done' }, null,
], next_cursor: 'cur-2' });
ok('办过的事整形：形状不对的丢掉（状态认不出、没编号）', acts.items.length === 2 && acts.next === 'cur-2', J(acts));
ok('工具写中文说法；没给说法写「一件事」，不露工具代号', acts.items[0].toolLabel === '改期限' && acts.items[1].toolLabel === '一件事' && !J(acts.items.map((r) => r.toolLabel)).includes('work_item'));
ok('结果链接只认站内页面：站外的不给', acts.items[0].link === '/work-items/wi-syn-1' && acts.items[1].link === null);
ok('没有下一页：next 为 null', actionsOf({ items: [] }).next === null && actionsOf(null).items.length === 0);
ok('令牌那一行：取过的说原文只显示一次，没取过的照实说', tokenLine({ hasToken: true }).includes('只在取的那一次') && tokenLine({ hasToken: false }) === '还没取过令牌');

console.log(`\nassistant-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
