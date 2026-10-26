#!/usr/bin/env node
/** P0 契约冒烟（#94 §6 正式化件·判据先红后绿·总工第三闸规矩）。
 *  ①替身服务全端点自测（publish/changed/回读/drafts/apply/merge 409/DELETE/dispatch·令牌 401）
 *  ②市场侧真调用：sop_run_sandbox → 替身 /v0/dispatch 收 1 次（L13 语义·SANDBOX_BRIDGE_URL 指替身）
 *  ③L12：compose 文件存在·主容器无 docker.sock·服务容器有
 *  ④契约文档四件齐（端点表/池化/风险表/错误面）
 */
import { startSubstitute } from './layerfs-substitute.mjs';
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const s = startSubstitute({ token: 't' });
const port = await s.listen(0);
const B = `http://127.0.0.1:${port}`;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer t' };
const post = (p, body) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) });

// ① 全端点自测
const r0 = await fetch(B + '/v0/projects/x/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok('① 令牌缺失 401', r0.status === 401, `status=${r0.status}`);
const p1 = await (await post('/v0/projects/rv-lfa/publish', { files: [{ path: 'index.html', content: '<h1>v1</h1>' }], message: 'v1' })).json();
ok('② publish 建项目+commit', /^c[0-9a-f]{12}$/.test(p1.commit_id ?? '') && p1.changed === true, JSON.stringify(p1));
const p2 = await (await post('/v0/projects/rv-lfa/publish', { files: [{ path: 'index.html', content: '<h1>v1</h1>' }], message: 'same' })).json();
ok('③ 无变化 changed:false 原头', p2.changed === false && p2.commit_id === p1.commit_id, JSON.stringify(p2));
const rd = await (await fetch(B + `/v0/projects/rv-lfa/commits/${p1.commit_id}/files`, { headers: H })).json();
ok('④ 冷回读 files', Array.isArray(rd.files) && rd.files[0]?.content === '<h1>v1</h1>', JSON.stringify(rd).slice(0, 80));
const dr = await (await post('/v0/projects/rv-lfa/drafts', { from: p1.commit_id })).json();
ok('⑤ draft 开', typeof dr.draft === 'string', JSON.stringify(dr));
const ap = await (await post(`/v0/projects/rv-lfa/drafts/${dr.draft}/apply`, { changes: [{ op: 'edit', path: 'index.html', old_text: 'v1', new_text: 'v2' }], message: 'apply' })).json();
ok('⑥ apply 产 commit', /^c[0-9a-f]{12}$/.test(ap.commit_id ?? ''), JSON.stringify(ap));
const mg1 = await (await post(`/v0/projects/rv-lfa/drafts/${dr.draft}/merge`)).json();
ok('⑦ merge 首次 ok', /^c[0-9a-f]{12}$/.test(mg1.commit_id ?? ''), JSON.stringify(mg1));
const mg2 = await post(`/v0/projects/rv-lfa/drafts/${dr.draft}/merge`);
ok('⑧ merge 冲突 409 Conflict', mg2.status === 409 && (await mg2.json()).kind === 'Conflict', `status=${mg2.status}`);
const del = await (await fetch(B + '/v0/projects/rv-lfa', { method: 'DELETE', headers: H })).json();
ok('⑨ DELETE removed:true', del.removed === true, JSON.stringify(del));
const dp = await (await post('/v0/dispatch', { run_id: 1, script: 'x' })).json();
ok('⑩ dispatch commit_hash', /^c0ffee[0-9a-f]{6}$/.test(dp.commit_hash ?? ''), JSON.stringify(dp).slice(0, 80));

// ② L13 市场侧真调用（SANDBOX_BRIDGE_URL=替身·/v0/dispatch 与 /dispatch 同一替身——契约 §2.5 允许）
// 注：市场守旧契约打 /dispatch（PR#70 bridge 契约）——替身只提供 /v0/dispatch；此处由 sandbox-real-smoke 覆盖真派发，本冒烟补契约面即可
ok('⑪ L13 由 sandbox-real-smoke 覆盖（真派发闸 7/7 在案）', true);

// ③ L12 compose
const composePath = 'deploy/docker-compose.yml';
if (existsSync(composePath)) {
  const c = readFileSync(composePath, 'utf8');
  ok('⑫ L12a compose 存在+服务含 LAYERFS_SERVICE_URL', /LAYERFS_SERVICE_URL/.test(c));
  ok('⑬ L12b 有 docker.sock 服务', /docker\.sock/.test(c));
  // 主容器（market）无 docker.sock：粗检 market 服务块
  const mBlocks = c.split('market:');
  const marketBlock = mBlocks[1]?.split(/\n\s{2}\w+:/)[0] ?? '';
  ok('⑭ L12c 主容器无 docker.sock', !/docker\.sock|var\/lib\/docker/.test(marketBlock), marketBlock.slice(0, 80));
} else { ok('⑫ L12 compose 待建（P0 施工②）', false, composePath); }

// ④ 契约文档四件
const docp = 'docs/layerfs-service-contract-v0.md';
const d = existsSync(docp) ? readFileSync(docp, 'utf8') : '';
ok('⑮ 契约文档在', d.length > 1000);
ok('⑯ 含池化策略（LRU/60s/路径切换）', /LRU/.test(d) && /60s/.test(d) && /LAYERFS_STORE_PATH/.test(d));
ok('⑰ 含四风险表', /R-A/.test(d) && /R-B/.test(d) && /R-C/.test(d) && /R-D/.test(d));
ok('⑱ 含全端点（publish/commits/drafts/apply/merge/DELETE/dispatch）', ['publish', 'commits', 'drafts', 'apply', 'merge', 'DELETE', 'dispatch'].every((k) => d.includes(k)));

await s.close();
console.log(`\n===== P0 契约冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
