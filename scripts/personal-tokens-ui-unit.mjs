#!/usr/bin/env node
/** 设置页「个人令牌」（#1063）的纯函数单测（web/src/personal-tokens-view.ts），加上原文不落地、不带管理口令的源码检查。数据都是合成的。 */
import { readFileSync } from 'node:fs';
import { FALLBACK_SCOPES, ONE_TIME_NOTE, actionProblem, benchesLabel, draftProblem, expiryLabel, issueBody, issuedOf, lastUsedLabel, listProblem, maxDaysOf, newDraft, scopesLabel, scopesOf, stateTag, tagLabel, tokenRowOf, tokenState, tokensOf } from '../web/src/personal-tokens-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + extra); } };
const J = (x) => JSON.stringify(x);
const NOW = Date.parse('2026-11-25T12:00:00Z'), DAY = 86400000;
const row = (id, more = {}) => ({ id, name: '令牌' + id, scopes: ['bench:read'], benches: ['ecom'], prefix: 'ab12', created_at: NOW - 5 * DAY, expires_at: NOW + 25 * DAY, last_used_at: null, revoked_at: null, ...more });

ok('一行：形状对才收；原文、哈希即使给了也不留', J(Object.keys(tokenRowOf(row('a', { token: 'wmu_secret', hash: 'x' })))) === J(['id', 'name', 'scopes', 'benches', 'tag', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt']) && tokenRowOf({ id: 'a' }) === null && tokenRowOf(null) === null);
ok('台：all 表示全部，数组表示选中的；别的形状不收', tokenRowOf(row('a', { benches: 'all' })).benches === 'all' && tokenRowOf(row('a', { benches: '' })) === null && tokenRowOf(row('a', { benches: [1] })) === null);
ok('辨认标记只认短字母数字尾巴', tagLabel(tokenRowOf(row('a'))) === 'wmu_…ab12' && tagLabel(tokenRowOf(row('a', { prefix: 'wmu_whole-secret-value' }))) === '');
const list = tokensOf({ tokens: [row('old', { created_at: NOW - 9 * DAY }), row('rev', { revoked_at: NOW - DAY }), row('exp', { expires_at: NOW - 1 }), row('new'), { bad: 1 }] }, NOW);
ok('清单：可用在前（新签在上）、过期次之、撤销最后；坏行跳过', J(list.map((t) => t.id)) === '["new","old","exp","rev"]' && tokensOf(null, NOW).length === 0);
ok('状态：可用、已过期、已撤销（撤销优先于过期）', J(list.map((t) => tokenState(t, NOW))) === '["active","active","expired","revoked"]' && tokenState(tokenRowOf(row('x', { revoked_at: 1, expires_at: 0 })), NOW) === 'revoked' && stateTag(list[0], NOW).text === '可用' && stateTag(list[3], NOW).tone === 'default');
ok('期限：还剩几天向上取整；过期、撤销各说各的', /到期（还剩 25 天）$/.test(expiryLabel(list[0], NOW)) && / 已过期$/.test(expiryLabel(list[2], NOW)) && / 撤销$/.test(expiryLabel(list[3], NOW)));
ok('最近使用：没用过写「还没用过」，用过写到分钟', lastUsedLabel(list[0]) === '还没用过' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(lastUsedLabel(tokenRowOf(row('u', { last_used_at: NOW })))));
ok('作用域：服务端给了就用，给了怪东西或没给用兜底五项', scopesOf({ scopes: [{ key: 'k', label: '甲' }] })[0].label === '甲' && scopesOf({ scopes: [{ key: 1 }] }) === FALLBACK_SCOPES && scopesOf(null).length === 5);
ok('作用域说法：认得的写中文，认不得的只说有几项、不露代号', scopesLabel(tokenRowOf(row('s', { scopes: ['bench:read', 'secret:x'] })), FALLBACK_SCOPES) === '读台数据、另有 1 项');
ok('台说法：全部、标题、没有标题用标识', benchesLabel(tokenRowOf(row('b', { benches: 'all' })), new Map()) === '你进得去的全部台' && benchesLabel(tokenRowOf(row('b', { benches: ['a', 'z'] })), new Map([['a', '甲台']])) === '甲台、z');
ok('有效期上限：服务端给了整数就用，缺省 90', maxDaysOf({ max_days: 365 }) === 365 && maxDaysOf({ max_days: 0 }) === 90 && maxDaysOf(null) === 90);
const d = (more) => ({ ...newDraft(), name: '笔记本', scopes: ['bench:read'], benches: ['ecom'], ...more });
ok('新表单：缺省 30 天，名字作用域台都空', J(newDraft()) === J({ name: '', scopes: [], benches: [], days: 30 }));
ok('表单核对：名字、作用域、台、天数逐项说；都好是 null', draftProblem(d({ name: '  ' }), 90).includes('名字') && draftProblem(d({ name: '字'.repeat(65) }), 90).includes('名字') && draftProblem(d({ scopes: [] }), 90).includes('能做的事')
  && draftProblem(d({ benches: [] }), 90).includes('台') && draftProblem(d({ benches: 'all' }), 90) === null && draftProblem(d({ days: 91 }), 90).includes('90') && draftProblem(d({ days: 1.5 }), 90) !== null && draftProblem(d({}), 90) === null);
ok('签发请求体：名字去空白、作用域和台去重排序、天数原样', J(issueBody(d({ name: ' 甲 ', scopes: ['view', 'bench:read', 'view'], benches: ['z', 'a', 'z'], days: 7 }))) === J({ name: '甲', scopes: ['bench:read', 'view'], benches: ['a', 'z'], expires_in_days: 7 }));
ok('签发应答：只认 wmu_ 开头够长的原文；没有原文当没签成', issuedOf({ token: 'wmu_' + 'a'.repeat(32), row: row('n') }).row.id === 'n' && issuedOf({ token: 'short' }) === null && issuedOf({ row: row('n') }) === null);
ok('清单读不到：401 请先登录、403 只有属主、404 还没上线、别的稍后再试；读到了没有问题', listProblem({ status: 401 }).text.includes('请先登录') && listProblem({ status: 403 }).text.includes('属主') && listProblem({ status: 404 }).type === 'info' && listProblem({ status: 500 }).text.includes('稍后') && listProblem({ status: 200 }) === null && listProblem(null) === null);
ok('操作没办成：服务端中文句子照说（缺哪项作用域），代号不露；断网、401、403 各有说法', actionProblem({ status: 403, body: { error: 'scope_missing', message: '缺少作用域：批授权' } }) === '缺少作用域：批授权' && actionProblem({ status: 403, body: { error: 'forbidden' } }) === '你的账号现在不能做这一步。' && actionProblem({ status: 0, body: null }).includes('连不上') && actionProblem({ status: 200 }) === null);
ok('只显示一次的说明写明了离开就没了、怎么存', ONE_TIME_NOTE.includes('只显示这一次') && ONE_TIME_NOTE.includes('0600'));

// 源码检查：原文不落地、不带管理口令、不进地址
const src = ['web/src/personal-tokens-api.ts', 'web/src/personal-tokens-view.ts', 'web/src/components/PersonalTokensCard.tsx'].map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 只看代码，注释里说明「不带管理口令」不算
ok('不写本地存储、会话存储，不打日志', !/localStorage|sessionStorage|console\./.test(src));
ok('不带管理口令（只认本人登录会话）', !/X-Admin-Token|getAdminToken|admin-token/.test(src));
ok('原文不进地址栏和历史', !/history\.|location\.|searchParams|pushState|replaceState/.test(src));

console.log('\npersonal-tokens-ui-unit: ' + pass + ' 过 / ' + fail + ' 败');
process.exit(fail ? 1 : 0);
