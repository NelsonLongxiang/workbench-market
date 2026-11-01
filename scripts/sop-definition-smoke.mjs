#!/usr/bin/env node
/** #318 GET /api/sops/:slug/definition 冒烟（独立实例、合成数据）：
 *  published 匿名可读且只有步骤 key/标题（不带步骤正文）· draft / deprecated 匿名 403、管理员 200 ·
 *  ?version 读指定版本 · 不存在的版本 404 · 坏 version 400 · 冷版本（目录不在）404 version_not_materialized · 非 SOP 404。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const TMP = resolve('tmp/sop-definition-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN = 'synthetic-sopdef-admin';
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: ADMIN };
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const call = async (method, path, body, admin = true) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': ADMIN } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const yaml = (v) => `title: 定义冒烟 v${v}\ncode: DEF-${v}\nsteps:\n  - key: a\n    title: 第一步\n    body: <p>STEP-BODY-SECRET-${v}</p>\n${v > 1 ? '  - key: b\n    title: 第二步\n' : ''}`;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  await call('POST', '/api/apps', { slug: 'def-sop', kind: 'sop', title: '定义冒烟', changelog: 'v1', files: [{ path: 'sop.yaml', content: yaml(1) }] });
  const d0 = await call('GET', '/api/sops/def-sop/definition', undefined, false);
  ok('draft 匿名 → 403', d0.status === 403, JSON.stringify(d0));
  const d1 = await call('GET', '/api/sops/def-sop/definition');
  ok('draft 管理员 → 200', d1.status === 200 && d1.body?.status === 'draft');
  await call('POST', '/api/sops/def-sop/publish', {});
  await call('POST', '/api/apps', { slug: 'def-sop', kind: 'sop', title: '定义冒烟', changelog: 'v2', files: [{ path: 'sop.yaml', content: yaml(2) }] });
  const p = await call('GET', '/api/sops/def-sop/definition', undefined, false);
  ok('published 匿名 → 200，读当前生效版本', p.status === 200 && p.body?.version === p.body?.active_version, JSON.stringify(p.body));
  ok('只回步骤 key/标题，不带步骤正文', Array.isArray(p.body?.steps) && p.body.steps.every((s) => Object.keys(s).sort().join() === 'key,title') && !JSON.stringify(p.body).includes('STEP-BODY-SECRET'), JSON.stringify(p.body?.steps));
  const v1 = await call('GET', '/api/sops/def-sop/definition?version=1', undefined, false);
  ok('?version=1 读指定版本', v1.status === 200 && v1.body?.version === 1 && v1.body.steps.length === 1 && v1.body.code === 'DEF-1', JSON.stringify(v1.body));
  ok('不存在的版本 → 404', (await call('GET', '/api/sops/def-sop/definition?version=99', undefined, false)).status === 404);
  ok('坏 version → 400', (await call('GET', '/api/sops/def-sop/definition?version=abc', undefined, false)).status === 400);
  rmSync(join(TMP, 'data', 'apps', 'def-sop', 'v1'), { recursive: true, force: true });
  const cold = await call('GET', '/api/sops/def-sop/definition?version=1', undefined, false);
  ok('冷版本（目录不在）→ 404 version_not_materialized', cold.status === 404 && cold.body?.code === 'version_not_materialized', JSON.stringify(cold));
  await call('POST', '/api/sops/def-sop/deprecate', {});
  ok('deprecated 匿名 → 403', (await call('GET', '/api/sops/def-sop/definition', undefined, false)).status === 403);
  ok('deprecated 管理员 → 200', (await call('GET', '/api/sops/def-sop/definition')).status === 200);
  await call('POST', '/api/apps', { slug: 'plain-app', kind: 'app', title: 'plain', changelog: 'x', files: [{ path: 'index.html', content: '<p>x</p>' }] });
  ok('非 SOP → 404', (await call('GET', '/api/sops/plain-app/definition')).status === 404);
  ok('不存在的 slug → 404', (await call('GET', '/api/sops/nope-sop/definition')).status === 404);
} catch (e) {
  fail++; console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 300));
  if (fail && serverErr) console.log(serverErr.slice(-1200));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`sop-definition-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
