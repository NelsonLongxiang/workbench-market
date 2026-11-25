#!/usr/bin/env node
/** 设置页「个人令牌」（#1063）的纯函数单测（web/src/personal-tokens-view.ts）与接口适配层实发请求，加上原文不落地、不带管理口令的源码检查。数据都是合成的。 */
import { readFileSync } from 'node:fs';
import { PERSONAL_TOKENS_PATH, issuePersonalToken, listPersonalTokens, personalTokenPath, revokePersonalToken } from '../web/src/personal-tokens-api.ts';
import { MAX_DAYS, ONE_TIME_NOTE, SCOPES, actionProblem, benchesLabel, draftProblem, expiryLabel, issueBody, issuedOf, lastUsedLabel, listProblem, needsBench, newDraft, scopesLabel, stateTag, tokenRowOf, tokenState, tokensOf } from '../web/src/personal-tokens-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + ' ' + extra); } };
const J = (x) => JSON.stringify(x);
const NOW = Date.parse('2026-11-25T12:00:00Z'), DAY = 86400000;
const TOKEN = 'wmu_' + 'Ab9_-'.repeat(8) + 'xyz';
const row = (id, more = {}) => ({ id, principal: 'user:owner', name: '令牌' + id, scopes: ['bench:read'], benches: ['ecom'], created_at: NOW - 5 * DAY, expires_at: NOW + 25 * DAY, last_used_at: null, revoked_at: null, ...more });

ok('一行：只挑认得的字段，原文、哈希、principal 不留', J(Object.keys(tokenRowOf(row('a', { token: 'wmu_secret', token_sha256: 'x' })))) === J(['id', 'name', 'scopes', 'benches', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt']) && tokenRowOf({ id: 'a' }) === null && tokenRowOf(null) === null);
ok('一行：台必须是数组（后端没有「全部台」）', tokenRowOf(row('a', { benches: 'all' })) === null && tokenRowOf(row('a', { benches: [] })).benches.length === 0);
const list = tokensOf({ personal_tokens: [row('old', { created_at: NOW - 9 * DAY }), row('rev', { revoked_at: NOW - DAY }), row('exp', { expires_at: NOW - 1 }), row('new'), { bad: 1 }] }, NOW);
ok('清单读 personal_tokens：可用在前（新签在上）、过期次之、撤销最后；坏行跳过；旧键 tokens 不认', J(list.map((t) => t.id)) === '["new","old","exp","rev"]' && tokensOf({ tokens: [row('x')] }, NOW).length === 0 && tokensOf(null, NOW).length === 0);
ok('状态：可用、已过期、已撤销（撤销优先于过期）', J(list.map((t) => tokenState(t, NOW))) === '["active","active","expired","revoked"]' && tokenState(tokenRowOf(row('x', { revoked_at: 1, expires_at: 0 })), NOW) === 'revoked' && stateTag(list[0], NOW).text === '可用' && stateTag(list[3], NOW).tone === 'default');
ok('期限：还剩几天向上取整；过期、撤销各说各的', /到期（还剩 25 天）$/.test(expiryLabel(list[0], NOW)) && / 已过期$/.test(expiryLabel(list[2], NOW)) && / 撤销$/.test(expiryLabel(list[3], NOW)));
ok('最近使用：没用过写「还没用过」，用过写到分钟', lastUsedLabel(list[0]) === '还没用过' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(lastUsedLabel(tokenRowOf(row('u', { last_used_at: NOW })))));
ok('作用域：正好是契约五项，只有报告维度不按台', J(SCOPES.map((s) => s.key)) === J(['bench:read', 'bench:write', 'view', 'grants', 'report-dimensions']) && J(SCOPES.filter((s) => !s.perBench).map((s) => s.key)) === '["report-dimensions"]');
ok('作用域说法：认得的写中文，认不得的只说有几项、不露代号', scopesLabel(tokenRowOf(row('s', { scopes: ['bench:read', 'secret:x'] }))) === '读台数据、另有 1 项');
ok('台说法：标题、没标题用标识、空的说只有报告维度', benchesLabel(tokenRowOf(row('b', { benches: ['a', 'z'] })), new Map([['a', '甲台']])) === '甲台、z' && benchesLabel(tokenRowOf(row('b', { benches: [] })), new Map()).includes('报告维度'));
const d = (more) => ({ ...newDraft(), name: 'laptop wm', scopes: ['bench:read'], benches: ['ecom'], ...more });
ok('新表单：缺省 30 天，名字作用域台都空；上限 90 天', J(newDraft()) === J({ name: '', scopes: [], benches: [], days: 30 }) && MAX_DAYS === 90);
ok('名字和服务端同一条：1～48、字母数字开头、前后无空格、只收空格点短横下划线', draftProblem(d({ name: '' })).includes('名字') && draftProblem(d({ name: ' a' })).includes('名字') && draftProblem(d({ name: 'a ' })).includes('名字') && draftProblem(d({ name: '_a' })).includes('名字')
  && draftProblem(d({ name: 'a'.repeat(49) })).includes('名字') && draftProblem(d({ name: 'a/b' })).includes('名字') && draftProblem(d({ name: '笔记本 wm_1.x-2' })) === null && draftProblem(d({ name: 'a'.repeat(48) })) === null);
ok('作用域与台：至少一项；按台的必须选台，只有报告维度可以不选', draftProblem(d({ scopes: [] })).includes('能做的事') && draftProblem(d({ benches: [] })).includes('台') && draftProblem(d({ scopes: ['report-dimensions'], benches: [] })) === null && needsBench(['report-dimensions', 'view']) && !needsBench(['report-dimensions']));
ok('有效期：1～90 整数', draftProblem(d({ days: 91 })).includes('90') && draftProblem(d({ days: 0 })) !== null && draftProblem(d({ days: 1.5 })) !== null && draftProblem(d({ days: 90 })) === null);
ok('签发请求体：作用域去重按契约次序、台去重排序、天数原样、名字不改', J(issueBody(d({ name: '甲', scopes: ['view', 'bench:read', 'view'], benches: ['z', 'a', 'z'], days: 7 }))) === J({ name: '甲', scopes: ['bench:read', 'view'], benches: ['a', 'z'], expires_in_days: 7 }));
ok('签发应答：只认 wmu_ 加 43 位的原文，读 personal_token；没有原文当没签成', issuedOf({ token: TOKEN, personal_token: row('n') }).row.id === 'n' && issuedOf({ token: TOKEN + 'x', personal_token: row('n') }) === null && issuedOf({ token: 'wmu_short' }) === null && issuedOf({ personal_token: row('n') }) === null);
ok('清单读不到：401 请先登录、403 分清非属主/非 HTTPS/非同源会话、404 还没上线、别的稍后再试', listProblem({ status: 401 }).text.includes('请先登录') && listProblem({ status: 403, body: { error: 'personal_token_owner_required' } }).text.includes('属主') && listProblem({ status: 403, body: { error: 'personal_token_surface_denied' } }).text.includes('HTTPS')
  && listProblem({ status: 403, body: { error: 'personal_token_owner_session_required' } }).text.includes('本人的登录') && listProblem({ status: 404 }).type === 'info' && listProblem({ status: 500 }).text.includes('稍后') && listProblem({ status: 200 }) === null && listProblem(null) === null);
ok('操作没办成：服务端中文句子照说（名字重了），代号不露；撤销 404、断网各有说法；204 算办成', actionProblem({ status: 409, body: { error: 'personal_token_name_taken', message: '此令牌名称已使用，请换一个名字' } }) === '此令牌名称已使用，请换一个名字'
  && actionProblem({ status: 404, body: { error: 'personal_token_missing' } }).includes('找不到') && actionProblem({ status: 403, body: { error: 'forbidden' } }) === '你的账号现在不能做这一步。' && actionProblem({ status: 0, body: null }).includes('连不上') && actionProblem({ status: 204, body: null }) === null);
ok('只显示一次的说明写明了离开就没了、怎么存', ONE_TIME_NOTE.includes('只显示这一次') && ONE_TIME_NOTE.includes('0600'));
ok('路径：/api/owner/personal-tokens，撤销按 id 编码拼路径', PERSONAL_TOKENS_PATH === '/api/owner/personal-tokens' && personalTokenPath('a/b c') === '/api/owner/personal-tokens/a%2Fb%20c');

// 适配层实发的请求：换掉 fetch，看方法、路径、请求体、凭据，以及不带管理口令；撤销 204 没有应答体
const calls = [];
globalThis.fetch = async (url, init = {}) => { calls.push({ url, method: init.method ?? 'GET', body: init.body ?? null, credentials: init.credentials, headers: init.headers ?? {} });
  const status = init.method === 'DELETE' ? 204 : init.method === 'POST' ? 201 : 200;
  return { status, json: async () => (status === 204 ? (() => { throw new Error('no body'); })() : {}) }; };
const lr = await listPersonalTokens(); const ir = await issuePersonalToken({ name: '甲', scopes: ['view'], benches: ['a'], expires_in_days: 30 }); const rr = await revokePersonalToken('t/1');
ok('适配层：清单 GET、签发 POST 带 JSON 体、撤销 DELETE 按 id 编码', J(calls.map((c) => c.method + ' ' + c.url)) === J(['GET /api/owner/personal-tokens', 'POST /api/owner/personal-tokens', 'DELETE /api/owner/personal-tokens/t%2F1']) && JSON.parse(calls[1].body).name === '甲' && calls[0].body === null && calls[2].body === null);
ok('适配层：都带本人会话（same-origin），都不带管理口令与 Authorization', calls.every((c) => c.credentials === 'same-origin' && !Object.keys(c.headers).some((h) => ['x-admin-token', 'authorization'].includes(h.toLowerCase()))));
ok('适配层：状态码原样交回，撤销 204 不读应答体', lr.status === 200 && ir.status === 201 && rr.status === 204 && rr.body === null);
globalThis.fetch = async () => { throw new Error('offline'); };
ok('适配层：断网交回状态 0，不抛', (await listPersonalTokens()).status === 0);

// 源码检查（只看代码，注释里的说明不算）：原文不落地、不带管理口令、不进地址
const src = ['web/src/personal-tokens-api.ts', 'web/src/personal-tokens-view.ts', 'web/src/components/PersonalTokensCard.tsx'].map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ok('不写本地存储、会话存储，不打日志', !/localStorage|sessionStorage|console\./.test(src));
ok('不带管理口令（只认本人登录会话）', !/X-Admin-Token|getAdminToken|admin-token/.test(src));
ok('原文不进地址栏和历史', !/history\.|location\.|searchParams|pushState|replaceState/.test(src));

console.log('\npersonal-tokens-ui-unit: ' + pass + ' 过 / ' + fail + ' 败');
process.exit(fail ? 1 : 0);
