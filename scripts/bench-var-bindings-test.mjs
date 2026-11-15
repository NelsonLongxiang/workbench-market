#!/usr/bin/env node
/** Data-view variable references: pure contract and resolution checks; no database or network. */
import assert from 'node:assert/strict';
import { validateViewDoc } from '../server/src/bench-views.ts';
import { resolveViewVars } from '../server/src/bench-bindings.ts';
const doc = (blocks) => ({ title: '合成台', views: [{ key: 'board', title: '总览', blocks }] });
const blocks = [
 { type: 'stat', title: '已完成', value: { var: 'completed' } },
 { type: 'progress', value: { var: 'hot.completed' }, total: { var: 'target' } },
];
assert.deepEqual(validateViewDoc(doc(blocks), new Map()), []);
assert.deepEqual(validateViewDoc(doc([{ type: 'stat', value: { var: 'completed' }, tone_rules: [{ col: 'value', op: '<', value: { var: 'target' }, tone: 'warning' }] }]), new Map()), []);
assert.notEqual(validateViewDoc(doc([{ type: 'stat', value: { var: 'completed' }, query: { dataset: 'ignored' } }]), new Map()).length, 0);
for (const ref of [{ var: 'completed', bench: 2 }, { var: 'completed', path: '/x' }, { var: '$vars.completed' }, { var: 'x[0]' }, { var: '../x' }, { var: '' }, { var: 'x + y' }]) {
 assert.notEqual(validateViewDoc(doc([{ type: 'stat', value: ref }]), new Map()).length, 0);
}
const calls = [];
const values = new Map([['completed', { value: 0, revision: 3 }], ['hot.completed', { value: 37, revision: 9 }], ['target', { value: 100, revision: 2 }], ['secret', { value: 987654, revision: 1 }]]);
const result = { title: '合成', version: 1, blocks: blocks.map(b => ({ ...b, data: { columns: [], rows: [{}], truncated: false } })) };
const out = await resolveViewVars(result, async key => { calls.push(key); return values.get(key); });
assert.deepEqual(calls, ['completed', 'hot.completed', 'target']);
assert.equal(out.blocks[0].data.rows[0][out.blocks[0].value], 0);
assert.equal(out.blocks[1].data.rows[0][out.blocks[1].value], 37);
assert.equal(out.blocks[1].total, 100);
assert.deepEqual(out.blocks[1].var_revisions, { 'hot.completed': 9, target: 2 });
assert.ok(!JSON.stringify(out).includes('secret') && !JSON.stringify(out).includes('987654'));
const same = { blocks: [blocks[0], blocks[0]].map(b => ({ ...b, data: { columns: [], rows: [{}] } })) };
let reads = 0;
await resolveViewVars(same, async () => { reads++; return { value: 1, revision: reads }; });
assert.equal(reads, 1);
for (const value of [null, '1', {}, [], false, NaN, Infinity]) {
 const got = await resolveViewVars(result, async () => ({ value, revision: 1 }));
 assert.equal(got.blocks[0].error.code, 'invalid');
 assert.equal(got.blocks[0].data, undefined);
}
const missing = await resolveViewVars(result, async () => undefined);
assert.equal(missing.blocks[0].error.code, 'not_found');
const unavailable = await resolveViewVars(result, async () => { throw Object.assign(new Error('private upstream details'), { status: 503 }); });
assert.equal(unavailable.blocks[0].error.code, 'unavailable');
assert.equal(unavailable.blocks[0].data, undefined);
assert.ok(!JSON.stringify(unavailable).includes('private upstream details'));
const invalidTotal = await resolveViewVars(result, async key => ({ value: key === 'target' ? 0 : 10, revision: 1 }));
assert.equal(invalidTotal.blocks[1].error.code, 'invalid');
const denied = await resolveViewVars(result, async () => { throw Object.assign(new Error('secret denied'), { status: 403 }); });
assert.equal(denied.blocks[0].error.code, 'forbidden');
assert.equal(denied.blocks[0].data, undefined);
const old = { blocks: [{ type: 'stat', value: 'n', data: { columns: [{ name: 'n', type: 'integer' }], rows: [{ n: 4 }] } }] };
assert.equal(await resolveViewVars(old, async () => { throw new Error('not called'); }), old);
const threshold = { blocks: [{ type: 'bar', data: { columns: [{ name: 'n', type: 'integer' }], rows: [{ n: 30 }] }, tone_rules: [{ col: 'n', op: '<', value: { var: 'target' }, tone: 'warning' }] }] };
const resolvedThreshold = await resolveViewVars(threshold, async () => ({ value: 50, revision: 4 }));
assert.equal(resolvedThreshold.blocks[0].tone_rules[0].value, 50);
assert.deepEqual(resolvedThreshold.blocks[0].var_revisions, { target: 4 });
console.log('bench-var-bindings: contract, finite scalars, selected keys, revisions, errors, thresholds, old views PASS');
