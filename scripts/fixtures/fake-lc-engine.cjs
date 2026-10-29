#!/usr/bin/env node
/** 替身 ygl-trees 引擎（只给 lifecycle-board-smoke 用）：--version 报钉版；lc board 回合成样例信封。
 *  行为由同目录 mode 文件控制（子进程环境被工作台白名单裁掉，只能走文件）：ok | rc2 | garbage | nolanes | slow；
 *  每次调用把 argv 与是否收到 LC_ASSERTION 追加到同目录 calls.jsonl。 */
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.116.1'); process.exit(0); }
const dir = __dirname; // 冒烟把本文件连同样例拷到临时目录再跑，mode/calls 落在那里，不进仓库
let mode = 'ok';
try { mode = readFileSync(join(dir, 'mode'), 'utf8').trim() || 'ok'; } catch {}
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, assertion: 'LC_ASSERTION' in process.env, home: process.env.YGL_HOME ?? null, mode }) + '\n');
const sample = JSON.parse(readFileSync(join(__dirname, 'lc-board-sample.json'), 'utf8'));
const out = (o, rc = 0) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(rc); };
if (args[0] !== 'lc' || args[1] !== 'board') out({ status: 'error', data: null, checks: [], error: { code: 'USAGE', message: `fake 只认 lc board：${args.join(' ')}` }, trace_id: null, next: [] }, 2);
if (mode === 'rc2') out({ status: 'error', data: null, checks: [], error: { code: 'USAGE', message: '未知旗标 --bogus' }, trace_id: 'tr-fake', next: [] }, 2);
if (mode === 'garbage') { process.stdout.write('not json\n'); process.exit(1); }
if (mode === 'nolanes') out({ ...sample, data: { ...sample.data, products: [], summary: { ...sample.data.summary, products: 0 } }, next: ['树里没有泳道登记 reg-lanes'] });
const pd = args.indexOf('--pd') >= 0 ? args[args.indexOf('--pd') + 1] : null;
const env = pd ? { ...sample, data: { ...sample.data, products: sample.data.products.filter((p) => p.pd === pd) } } : sample;
if (mode === 'slow') setTimeout(() => out(env), 600); else out(env);
