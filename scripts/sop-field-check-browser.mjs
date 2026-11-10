#!/usr/bin/env node
// #471 字段间数值关系 data-check：执行页（真实 Chromium）与服务端完成校验同一结论
//   K1 每个用例：页面上每个 data-check 字段的违约提示，与服务端 checkRunData 对同一份数据给出的提示逐字相同（含「跳过」）
//   K2 改了被引用的字段，依赖它的字段立即重算（错误出现与消失）
//   K3 点「完成」被拦时，错误汇总列出关系违约
// 不起服务、不连网络：页面在合成源上打开，所有 /api 请求被拦截。
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { renderSopRunner } from '../server/src/sop-runner.ts';
import { checkRunData, extractFieldRules } from '../server/src/sop-field-rules.ts';

const out = resolve('tmp/sop-field-check-' + Date.now());
mkdirSync(out, { recursive: true });
const manifest = { title: 'Check SOP', steps: [
  { key: 'samples', title: '样本', body: `
    <p>实际条数：<input data-field="count" data-label="实际条数" type="number" step="any" data-check="count <= target"></p>
    <p>应取条数：<input data-field="target" data-label="应取条数" type="number" step="any"></p>
    <p>交集：<input data-field="overlap" data-label="交集" type="number" step="any" data-check="overlap + only = count" data-check-error="交集＋独有应等于实际条数"></p>
    <p>独有：<input data-field="only" data-label="独有" type="number" step="any"></p>
    <p>比例：<input data-field="ratio" data-label="比例" data-check="ratio * 2 = 1"></p>` },
  { key: 'verify', title: '验证', body: `<p>已核条数：<input data-field="checked" data-label="已核条数" data-check="checked <= samples.count"></p>` },
] };
const rules = extractFieldRules(manifest);
const fields = { samples: ['count', 'target', 'overlap', 'only', 'ratio'], verify: ['checked'] };
const checkFields = rules.filter((r) => r.check).map((r) => ({ step: r.step, field: r.field, label: r.label }));
const cases = [
  { samples: { count: '64', target: '100', overlap: '40', only: '24' }, verify: { checked: '64' } },
  { samples: { count: '101', target: '100', overlap: '', only: '' }, verify: { checked: '' } },
  { samples: { count: '100', target: '100', overlap: '40', only: '61' }, verify: { checked: '' } },
  { samples: { count: '64', target: '', overlap: '0.1', only: '' }, verify: { checked: '65' } },
  { samples: { count: '64', target: '100', overlap: '', only: '24' }, verify: { checked: '64.5' } },
  { samples: { count: '', target: '100', overlap: '1', only: '2' }, verify: { checked: '3' } },
  { samples: { count: '0.3', target: '0.3', overlap: '0.1', only: '0.2' }, verify: { checked: '0.3' } },
  { samples: { count: '-5', target: '-6', overlap: '', only: '' }, verify: { checked: '' } },
].map((data) => {
  const errs = checkRunData(rules, data);
  // 服务端提示形如「步骤.标签：内容」；按字段取内容，没有就是空串（通过或跳过）
  const expect = {};
  for (const f of checkFields) expect[`${f.step}.${f.field}`] = (errs.find((e) => e.startsWith(`${f.step}.${f.label}：`)) ?? '').replace(`${f.step}.${f.label}：`, '');
  return { data, expect };
});
const html = renderSopRunner(manifest, { id: 1, slug: 'check-sop', title: 'Check SOP', kind: 'sop', active_version: 1, code: 'SOP-CHECK' });
writeFileSync(join(out, 'runner.html'), html);
const config = join(out, 'config.json');
writeFileSync(config, JSON.stringify({ html: join(out, 'runner.html'), result: join(out, 'browser.json'), fields, checkFields, cases }));
const child = spawn(pythonBin(), ['scripts/sop-field-check-browser.py', config], { stdio: 'inherit' });
const code = await new Promise((r) => child.once('exit', r));
console.log({ out, code });
process.exit(code ?? 1);
