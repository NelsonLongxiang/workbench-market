#!/usr/bin/env node
/** #436 SOP 执行页无障碍回归（Python Playwright/Chromium，CI browser-security job）。
 *  合成 SOP：每个 data-field 控件要有唯一 id 与可访问名称，说明 <small> 与错误提示经 aria-describedby 关联；
 *  完成被拦时错误汇总出现并获焦，点一项跳到对应控件，改好后汇总收起。只渲染执行页，不起服务。 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderSopRunner } from '../server/src/sop-runner.ts';

const manifest = { title: 'a11y', steps: [
  { key: 'scope', title: '定界', body: `
    <p>商品：<input data-field="product" data-label="商品" required maxlength="20"><br><small>写中文或日文名称</small></p>
    <p>报告期：<input data-field="period" data-label="报告期" type="month" required></p>
    <p><label for="own">自带 label：</label><input id="own" data-field="own" required></p>
    <p><label>包在 label 里：<input data-field="wrapped" required></label></p>
    <p>无 data-label：<textarea data-field="note"></textarea></p>` },
  { key: 'deliver', title: '交付', body: `<p>商品（同名字段，不同步骤）：<input data-field="product" data-label="交付商品" required></p>` },
] };
const out = resolve('tmp/sop-runner-a11y-' + Date.now().toString(36));
mkdirSync(out, { recursive: true });
const html = join(out, 'runner.html');
writeFileSync(html, renderSopRunner(manifest, { id: 1, slug: 'a11y', title: 'a11y', kind: 'sop' }));
const r = spawnSync(process.env.PYTHON || 'python', ['scripts/sop-runner-a11y-browser.py', html], { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
process.exit(r.status ?? 1);
