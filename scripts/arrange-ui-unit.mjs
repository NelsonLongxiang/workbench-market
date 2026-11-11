#!/usr/bin/env node
/** 「安排一件事」的纯函数单测（web/src/arrange-view.ts）：页面先挡的校验、请求体、幂等键（同内容重试同一个键）、结果和失败的说法。
 *  接口形状照 #577（GET /api/work-items/teams、POST /api/work-items）；全是合成值。 */
import { EMPTY_FORM, buildBody, errorText, keyFor, newKey, resultText, teamOption, teamsBlockedText, validate } from '../web/src/arrange-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const teams = [{ team: 'zone/canvas/purchase', name: 'zone/canvas/purchase' }, { team: 'zone/t1', name: '采购部' }];
const good = { ...EMPTY_FORM, title: '比价', intent: '三家报价比一比', deliverable: '一张比价表', team: 'zone/t1' };

ok('团队：name 等于 team 时只写一遍；有名字时「名字（句柄）」', teamOption(teams[0]) === 'zone/canvas/purchase' && teamOption(teams[1]) === '采购部（zone/t1）');
ok('校验：填齐了没有错', Object.keys(validate(good, teams)).length === 0);
{
  const e = validate(EMPTY_FORM, teams);
  ok('校验：标题、要做什么、交什么、团队必填', !!e.title && !!e.intent && !!e.deliverable && !!e.team, JSON.stringify(e));
}
ok('校验：团队不在可派清单里', validate({ ...good, team: 'zone/other' }, teams).team === '这个团队现在不能派');
ok('校验：标题超长、期限格式', !!validate({ ...good, title: 'x'.repeat(201) }, teams).title && !!validate({ ...good, due: '11/30' }, teams).due && !validate({ ...good, due: '2026-11-30' }, teams).due);
ok('校验：全是空白当没填', !!validate({ ...good, intent: '   ' }, teams).intent);
{
  const b = buildBody({ ...good, title: ' 比价 ', object: '', phase: 'st_2', due: '' }, 'k'.repeat(20));
  ok('请求体：去空白、空的可选项不带、review 缺省为真、带键', b.title === '比价' && !('object' in b) && b.phase === 'st_2' && !('due' in b) && b.review === true && b.idempotency_key === 'k'.repeat(20), JSON.stringify(b));
}
ok('幂等键：16～64 位 [A-Za-z0-9_-]', /^[A-Za-z0-9_-]{16,64}$/.test(newKey()));
{
  let n = 0; const make = () => `key_${++n}_aaaaaaaaaaaa`;
  const a = keyFor(null, good, make);
  const b = keyFor(a, good, make);
  const c = keyFor(b, { ...good, title: '比价二' }, make);
  ok('幂等键：同内容重试用同一个键，改了内容换新键', a.key === b.key && c.key !== a.key, `${a.key} ${b.key} ${c.key}`);
}
ok('结果：等放行', resultText({ held: true }).includes('等管理员放行'));
ok('结果：选了不过目但策略要求过目', resultText({ held: true, reason: 'review_required_by_policy' }).includes('会先给管理员过目'));
ok('结果：直派、重放', resultText({ held: false }).includes('派出去了') && resultText({ duplicate: true }).includes('已经安排过'));
ok('失败：400 按 error 说人话', errorText(400, { error: 'team_not_assignable' }).includes('不能派') && errorText(400, { error: 'unknown_x' }) === '没安排成，稍后再试');
ok('失败：401 / 403 / 404 / 409', errorText(401, null) === '请先登录' && errorText(403, null).includes('不能安排') && errorText(404, null).includes('还没上线') && errorText(409, {}).includes('再点一次'));
ok('失败：429 分分钟和天', errorText(429, { window: 'minute', limit: 5 }).includes('过一分钟') && errorText(429, { window: 'day', limit: 50 }).includes('每天最多 50 件'));
ok('失败：断网说明重试不会重复', errorText(0, null).includes('不会重复'));
ok('读团队：没上线（旧路由答 400 或 404）、未登录、无权限、其他', teamsBlockedText(400).text.includes('还没上线') && teamsBlockedText(404).type === 'info' && teamsBlockedText(401).text === '请先登录' && teamsBlockedText(403).text.includes('不能安排') && teamsBlockedText(500).text.includes('读不到'));

console.log(`\narrange-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
