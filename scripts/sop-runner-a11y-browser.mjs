#!/usr/bin/env node
// #436 SOP 执行页可访问性回归：合成 manifest 渲染真实执行页，交给 Chromium（Python Playwright）核
//   A1 每个 data-field 都有可访问名称（label / aria-label），且有唯一 id
//   A2 紧跟的 <small> 说明与执行页插入的错误提示都关联到 aria-describedby
//   A3 点「完成」被拦时，顶部出现可聚焦的错误汇总，逐项列字段名与原因，点一项跳到对应控件
//   A4 条件必填（#435）切换后，说明与错误的关联不丢
// 不起服务、不连网络：页面在合成源上打开，所有 /api 请求被拦截（打开页面本就不建 run）。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { renderSopRunner } from '../server/src/sop-runner.ts';

const out = resolve('tmp/sop-runner-a11y-' + Date.now());
mkdirSync(out, { recursive: true });
const manifest = { title: 'A11y SOP', steps: [
  { key: 'scope', title: '定界', body: `
    <p>任务类型：<select data-field="task_type" data-label="任务类型" required><option value="">—</option><option>单商品研究</option><option>跨任务分类</option></select><br><small class="muted">选了类型，下面的字段按类型必填</small></p>
    <p>本次商品：<input data-field="product" data-required-if="task_type=单商品研究" maxlength="200"></p>
    <p>锚 ASIN：<input data-field="anchor" data-label="锚 ASIN" pattern="B0[A-Z0-9]{8}" data-error="ASIN 为 B0 开头的 10 位"><br><small>B0 开头 10 位</small></p>
    <label>备注<textarea data-field="note"></textarea></label>` },
  { key: 'deliver', title: '交付', body: `<p><input data-field="period" type="month" data-required-if="scope.task_type=单商品研究"></p>` },
] };
const html = renderSopRunner(manifest, { id: 1, slug: 'a11y-sop', title: 'A11y SOP', kind: 'sop', active_version: 1, code: 'SOP-A11Y' });
writeFileSync(join(out, 'runner.html'), html);
const config = join(out, 'config.json');
writeFileSync(config, JSON.stringify({ html: join(out, 'runner.html'), result: join(out, 'browser.json') }));
const child = spawn(process.env.PYTHON || 'python3', ['scripts/sop-runner-a11y-browser.py', config], { stdio: 'inherit' });
const code = await new Promise((r) => child.once('exit', r));
console.log({ out, code });
process.exit(code ?? 1);
