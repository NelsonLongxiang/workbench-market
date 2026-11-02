#!/usr/bin/env node
/** 来源收敛冒烟（属主 2026-11-02）：非挂载类工作台（自产台 / SOP 台）只接受 GitHub 仓库 main 分支。
 *  判据：直接传文件 / patch / MCP app_publish 一律拒；/api/apps/<slug>/sync 从 main 头拉取、版本记 commit；
 *  独立仓库与集中仓库子目录两种组织都行；同 commit 重拉不出新版；来源非法拒；发布门禁照旧；MCP 只能重拉已登记来源。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const PORT = 9871;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-github-source-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(j);
const sync = (slug, body, headers) => post(`/api/apps/${slug}/sync`, body, headers);
const mcp = (name, args) => post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { Accept: 'application/json, text/event-stream' });
const page = (n) => `<!doctype html><html><body><div>v${n}</div><div>${'x'.repeat(200)}</div></body></html>`;

const gh = await startFakeGithub();
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, PUBLISH_LOCK_MS: '1', WM_GITHUB_API: gh.api, WM_GITHUB_TOKEN: 'fixture-read-token' },
  stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  console.log('实例就绪', BASE, '替身', gh.api);

  // ① 旧入口全关
  const d1 = await post('/api/apps', { slug: 'direct-app', title: 'x', files: [{ path: 'index.html', content: page(1) }] });
  ok('① 直接传文件发布 app → 410', d1.status === 410, `status=${d1.status}`);
  ok('①b 拒因指向 GitHub main', /GitHub/.test(String(d1.body?.error)) && /main/.test(String(d1.body?.error)), String(d1.body?.error).slice(0, 80));
  const d2 = await post('/api/apps', { slug: 'direct-sop', kind: 'sop', title: 'x', changelog: 'c', files: [{ path: 'sop.yaml', content: 'title: x\nsteps: []\n' }] });
  ok('①c 直接传文件发布 SOP → 410', d2.status === 410, `status=${d2.status}`);
  const d3 = await post('/api/apps', { slug: 'direct-app', patch: { set: [{ path: 'index.html', content: page(2) }] } });
  ok('①d patch 发布 → 410', d3.status === 410, `status=${d3.status}`);
  const tc = await post('/api/apps', { slug: 'task-center', kind: 'sop', changelog: 'x', files: [] });
  ok('①e task-center 内置元台不走 410（仍只认管理员人工面）', tc.status !== 410, `status=${tc.status}`);

  // ② 首次同步：必须带来源
  const n0 = await sync('gh-solo', { title: '独立仓库台' });
  ok('② 新台不带 source_repo → 400', n0.status === 400, `status=${n0.status}`);
  for (const [label, repo, path] of [['URL 以外的乱写', 'not a repo', ''], ['路径穿越', 'acme/solo', '../etc'], ['多级 owner', 'a/b/c', '']]) {
    const r = await sync('gh-solo', { title: 't', source_repo: repo, source_path: path });
    ok(`②b 非法来源（${label}）→ 400`, r.status === 400, `status=${r.status} ${r.body?.error ?? ''}`);
  }
  const nf = await sync('gh-solo', { title: 't', source_repo: 'acme/missing' });
  ok('②c 仓库不存在 → 404', nf.status === 404, `status=${nf.status}`);

  // ③ 独立仓库：main 头同步出 v1，记 commit
  const c1 = gh.commit('acme/solo', [{ path: 'index.html', content: page(1) }, { path: 'app.js', content: 'console.log(1)' }]);
  const s1 = await sync('gh-solo', { title: '独立仓库台', source_repo: 'https://github.com/acme/solo.git', source_branch: 'dev' });
  ok('③ 绑定独立仓库并同步 → 201', s1.status === 201, `status=${s1.status} ${JSON.stringify(s1.body).slice(0, 160)}`);
  ok('③b 来源规范化为 owner/repo、分支固定 main', s1.body?.source?.repo === 'acme/solo' && s1.body?.source?.branch === 'main', JSON.stringify(s1.body?.source));
  ok('③c 版本记下 main 头 commit', s1.body?.source?.commit === c1 && s1.body?.app?.versions?.[0]?.source_commit === c1, JSON.stringify(s1.body?.app?.versions?.[0]));
  ok('③d 台记下来源仓库', s1.body?.app?.source_repo === 'acme/solo' && s1.body?.app?.source_path === '', JSON.stringify([s1.body?.app?.source_repo, s1.body?.app?.source_path]));
  const served1 = await fetch(`${BASE}/apps/gh-solo/`).then((r) => r.text());
  ok('③e 托管内容 = 仓库 main 内容', served1.includes('<div>v1</div>'), served1.slice(0, 80));
  ok('③f 私有仓库令牌经 WM_GITHUB_TOKEN 带上', gh.requests.some((q) => q.auth === 'Bearer fixture-read-token'));

  // ④ 同 commit 重拉不出新版；main 前进后出新版
  const s2 = await sync('gh-solo', {});
  ok('④ 同 commit 重拉 → unchanged，不出新版', s2.status === 200 && s2.body?.unchanged === true && s2.body?.version === 1, JSON.stringify(s2.body).slice(0, 120));
  const c2 = gh.commit('acme/solo', [{ path: 'index.html', content: page(2) }, { path: 'app.js', content: 'console.log(2)' }]);
  const s3 = await sync('gh-solo', {});
  ok('④b main 前进后按已登记来源重拉 → v2', s3.status === 200 && s3.body?.version === 2 && s3.body?.source?.commit === c2, JSON.stringify(s3.body).slice(0, 160));
  ok('④c changelog 缺省写明仓库与短 sha', String(s3.body?.app?.versions?.[0]?.changelog).includes(`acme/solo@main ${c2.slice(0, 7)}`), s3.body?.app?.versions?.[0]?.changelog);

  // ⑤ 集中仓库：每台一个子目录，各取各的
  gh.commit('acme/apps', [{ path: 'index.html', content: page(10) }], 'apps/alpha');
  gh.commit('acme/apps', [{ path: 'index.html', content: page(20) }, { path: 'lib/x.js', content: '1' }], 'apps/beta');
  const sa = await sync('gh-alpha', { title: 'A', source_repo: 'acme/apps', source_path: '/apps/alpha/' });
  const sb = await sync('gh-beta', { title: 'B', source_repo: 'acme/apps', source_path: 'apps/beta' });
  ok('⑤ 集中仓库子目录 alpha → 201', sa.status === 201 && sa.body?.app?.source_path === 'apps/alpha', JSON.stringify([sa.status, sa.body?.app?.source_path]));
  ok('⑤b 子目录 beta → 201，只收自己目录的文件', sb.status === 201 && sb.body?.app?.versions?.[0]?.file_count === 2, JSON.stringify([sb.status, sb.body?.app?.versions?.[0]?.file_count]));
  const sa2 = await fetch(`${BASE}/apps/gh-alpha/`).then((r) => r.text());
  ok('⑤c alpha 托管的是自己目录的内容', sa2.includes('<div>v10</div>'));
  const empty = await sync('gh-gamma', { title: 'C', source_repo: 'acme/apps', source_path: 'apps/gamma' });
  ok('⑤d 子目录不存在 → 400', empty.status === 400, `status=${empty.status}`);

  // ⑥ 发布门禁照旧
  gh.commit('acme/solo', [{ path: 'index.html', content: '' }]);
  const g1 = await sync('gh-solo', {});
  ok('⑥ main 上是空文件 → 门禁 400', g1.status === 400 && /空/.test(String(g1.body?.error)), JSON.stringify(g1.body).slice(0, 100));
  gh.commit('acme/solo', [{ path: 'index.html', content: '<p>tiny</p>' }]);
  const g2 = await sync('gh-solo', {});
  ok('⑥b 体积骤降 → 400；force 可越', g2.status === 400 && (await sync('gh-solo', { force: true })).status === 200, `status=${g2.status}`);

  // ⑦ SOP 台同样从仓库来
  gh.commit('acme/sops', [{ path: 'sop.yaml', content: 'title: 仓库 SOP\nsteps:\n  - key: s1\n    title: 第一步\n    body: <p>a</p>\n' }]);
  const so = await sync('gh-sop', { title: '仓库 SOP', kind: 'sop', code: 'SOP-GH-1', source_repo: 'acme/sops' });
  ok('⑦ SOP 台从仓库同步 → 201 draft', so.status === 201 && so.body?.kind === 'sop' && so.body?.status === 'draft', JSON.stringify(so.body).slice(0, 160));

  // ⑧ 浏览器来的同步不带口令 → 403（写总门照旧）
  const br = await sync('gh-solo', {}, { Origin: BASE });
  ok('⑧ 浏览器无管理员身份同步 → 403', br.status === 403, `status=${br.status}`);

  // ⑨ MCP：app_publish / 草稿工具已移除，app_sync 只重拉已登记来源
  const list = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Accept: 'application/json, text/event-stream' });
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  ok('⑨ tools/list 有 app_sync，没有 app_publish / app_draft_*', names.includes('app_sync') && !names.some((n) => n === 'app_publish' || n.startsWith('app_draft_')), names.join(','));
  const mp = await mcp('app_publish', { slug: 'gh-solo', files: [{ path: 'index.html', content: page(9) }] });
  ok('⑨b 调 app_publish → 报错', !!(mp.body?.error || mp.body?.result?.isError), JSON.stringify(mp.body).slice(0, 120));
  const c3 = gh.commit('acme/solo', [{ path: 'index.html', content: page(3) + '<div>' + 'y'.repeat(300) + '</div>' }]);
  const ms = await mcp('app_sync', { slug: 'gh-solo', changelog: 'mcp 同步' });
  const msText = JSON.stringify(ms.body);
  ok('⑨c MCP app_sync 拉到新 commit', msText.includes(c3) && !ms.body?.result?.isError, msText.slice(0, 160));
  const mn = await mcp('app_sync', { slug: 'gh-nobody' });
  ok('⑨d MCP app_sync 未登记的台 → 报错', !!(mn.body?.error || mn.body?.result?.isError), JSON.stringify(mn.body).slice(0, 120));
  const mr = await mcp('app_sync', { slug: 'gh-solo', source_repo: 'evil/repo' });
  ok('⑨e MCP app_sync 不收改来源参数', !!(mr.body?.error || mr.body?.result?.isError), JSON.stringify(mr.body).slice(0, 120));
  const after = await fetch(`${BASE}/api/apps/gh-solo`).then((r) => r.json());
  ok('⑨f 来源仍是 acme/solo', after.source_repo === 'acme/solo');
} finally {
  child.kill();
  await gh.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 来源收敛冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
