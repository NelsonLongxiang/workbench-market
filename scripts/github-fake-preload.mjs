/**
 * 录制回放用的夹具（--import 预加载）：在市场进程里起一个假 GitHub（scripts/github-fixture.mjs，只听 127.0.0.1），
 * 预先在两个仓库的 main 上放好固定的文件，把 WM_GITHUB_API 指过去。自产台、SOP 台的同步（POST /api/apps/:slug/sync）就有东西可拉。
 *
 * 仓库和目录（同步时用 source_path 选目录；仓库根下是全部目录，别拿根同步）：
 *   replay/app   v1（正常的台）、v2（换了内容、多一个文件）、tiny（比 v1 小一半以上）、empty（空文件）、
 *                unbalanced（div 开闭不配对）、bad-contract（数据契约不是 JSON）
 *   replay/sop   v1（正常的 sop.yaml）、bad-yaml（解析不了）、no-steps（没有步骤）、meta（带了 meta）、no-yaml（没有 sop.yaml）
 *   replay/root  仓库根下只有一个 index.html（不带 source_path 同步）
 * commit 号由「仓库、第几次提交」算出来，每次都一样（假 GitHub 原本还掺了当时的毫秒数，这里提交时把 Date.now 定成 0）。
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里把 GitHub 指到假的上。
 */
import { startFakeGithub } from './github-fixture.mjs';

if (process.env.NODE_ENV !== 'test') {
  console.error('[github-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const page = (label, pad) => `<!doctype html>\n<div class="app"><h1>${label}</h1><p>${'回放'.repeat(pad)}</p></div>\n`;
const SOP_V1 = 'title: 回放 SOP\ncode: RP-1\ndescription: 录制回放用\nsteps:\n  - key: a\n    title: 第一步\n    body: <p>一</p>\n  - key: b\n    title: 第二步\n';
const REPOS = [
  ['replay/root', '', [{ path: 'index.html', content: page('根目录的台', 40) }]],
  ['replay/app', 'v1', [{ path: 'index.html', content: page('回放台 v1', 60) }]],
  ['replay/app', 'v2', [{ path: 'index.html', content: page('回放台 v2', 64) }, { path: 'app.js', content: 'console.log("v2");\n' }]],
  ['replay/app', 'tiny', [{ path: 'index.html', content: '<div>t</div>\n' }]],
  ['replay/app', 'empty', [{ path: 'index.html', content: '' }]],
  ['replay/app', 'unbalanced', [{ path: 'index.html', content: page('少一个闭合', 60).replace('</div>', '') }]],
  ['replay/app', 'bad-contract', [{ path: 'index.html', content: page('契约坏了', 60) }, { path: 'data-contract.json', content: 'not json' }]],
  ['replay/sop', 'v1', [{ path: 'sop.yaml', content: SOP_V1 }]],
  ['replay/sop', 'bad-yaml', [{ path: 'sop.yaml', content: 'title: [没有闭合\n' }]],
  ['replay/sop', 'no-steps', [{ path: 'sop.yaml', content: 'title: 没有步骤\nsteps: []\n' }]],
  ['replay/sop', 'meta', [{ path: 'sop.yaml', content: SOP_V1 + 'meta: task-center\n' }]],
  ['replay/sop', 'no-yaml', [{ path: 'index.html', content: page('不是 SOP', 10) }]],
];

const gh = await startFakeGithub();
const realNow = Date.now;
Date.now = () => 0;
try { for (const [repo, dir, files] of REPOS) gh.commit(repo, files, dir); }
finally { Date.now = realNow; }
process.env.WM_GITHUB_API = gh.api;
