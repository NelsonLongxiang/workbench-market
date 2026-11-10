#!/usr/bin/env node
/**
 * 身份接缝的变异测试：「先红后绿」里的红。
 *
 * 把 server/src 抄一份，每次只改坏一处（一种真实会犯的错），然后对那份副本跑契约单测和对抗组：
 * 必须变红。一处都不改的副本必须是绿的。有哪个改坏了还全绿，就说明对抗组守不住那一处，本脚本失败。
 *
 * 副本只抄 server/src，其余（依赖、前端产物、设计文件）用符号链接指回本仓库；跑完删掉。
 *
 *   node scripts/identity-seam-mutation.mjs           全部变体
 *   node scripts/identity-seam-mutation.mjs --list    只列出变体
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `identity-mutation-${process.pid}`);

const CONTRACT = 'identity-contract-test.mjs', SMOKE = 'identity-seam-smoke.mjs';
const IDENTITY = 'server/src/identity.ts';

/** 变体：file 里的 find 恰好出现一次，换成 replace。suites 里的每一套都必须变红。 */
const MUTANTS = [
  // —— 接缝本身：身份服务对提供方的回答收得不严 ——
  { id: 'admin-flag-default-true', what: '管理员标记缺失就当管理员', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'admin: v.admin === true } };', replace: 'admin: v.admin !== false } };' },
  { id: 'subject-not-checked', what: '不核对主体和登录名是否一致（冒名）', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'v.sub !== `user:${v.login}` || ', replace: '' },
  { id: 'provider-error-not-caught', what: '提供方抛错不接住', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'try { answer = await provider.resolveViewer(cookieHeader, source); } catch { return { ok: false, http: 502, error: UNAVAILABLE }; }',
    replace: 'answer = await provider.resolveViewer(cookieHeader, source);' },
  { id: 'missing-viewer-filled-in', what: '回答里没有查看者就补一个', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'const v = a.viewer;', replace: "const v = a.viewer ?? { login: 'anonymous', uid: 0, sub: 'user:anonymous', name: null, admin: false };" },
  { id: 'refusal-turned-into-guest', what: '提供方说认不出，服务却放一个访客进来', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'return { ok: false, http: a.http, error: a.error };', replace: "return { ok: true, viewer: { login: 'guest', uid: 0, sub: 'user:guest', name: null, admin: false } };" },
  { id: 'no-provider-recognizes-someone', what: '没装提供方也认出一个人', file: IDENTITY, suites: [CONTRACT],
    find: 'if (!provider) return { ok: false, http: 503, error: NO_PROVIDER };', replace: "if (!provider) return { ok: true, viewer: { login: 'nobody', uid: 0, sub: 'user:nobody', name: null, admin: false } };" },
  // —— 核心的入口：绕开身份服务，或者拿到结果之后判错 ——
  { id: 'core-bypasses-service', what: '待办读权绕开身份服务，直接调实现', file: 'server/src/tasks-read-access.ts', suites: [SMOKE],
    find: 'const who = await identity().resolveViewer(cookie);', replace: "const who = await (await import('./login-providers/odoo/odoo-viewer.ts')).resolveOdooViewer(cookie);" },
  { id: 'any-viewer-is-admin', what: '管理员认定：认得出人就当管理员', file: 'server/src/index.ts', suites: [SMOKE],
    find: 'try { const who = await identity().resolveViewer(cookieHeader); login = who.ok && who.viewer.admin ? who.viewer.login : null; } catch { login = null; }',
    replace: 'try { const who = await identity().resolveViewer(cookieHeader); login = who.ok ? who.viewer.login : null; } catch { login = null; }' },
  { id: 'gate-admits-unrecognized', what: '登录门：认不出也放进来', file: 'server/src/index.ts', suites: [SMOKE],
    find: 'return who.ok ? { login: who.viewer.login, admin: who.viewer.admin } : null;', replace: "return { login: who.ok ? who.viewer.login : 'guest', admin: false };" },
  { id: 'run-read-ignores-grant', what: 'run 私有读：认得出人就给，不看授权', file: 'server/src/sop-read-auth.ts', suites: [SMOKE],
    find: "if (viewer.ok && runGrantActive(runId, 'user:' + viewer.viewer.login)) return", replace: 'if (viewer.ok) return' },
];

if (process.argv.includes('--list')) {
  for (const m of MUTANTS) console.log(`${m.id}\t${m.file}\t${m.what}`);
  process.exit(0);
}

/** 一棵副本目录树：server/src 是真抄的，别的都链回本仓库。 */
function plant(name, mutant) {
  const tree = join(OUT, name);
  mkdirSync(join(tree, 'server'), { recursive: true });
  const link = (from, to) => symlinkSync(from, to, statSync(from).isDirectory() ? 'junction' : 'file');
  for (const n of readdirSync(ROOT)) if (!['server', 'tmp'].includes(n) && !n.startsWith('.')) link(join(ROOT, n), join(tree, n));
  for (const n of readdirSync(join(ROOT, 'server'))) if (!['src', 'data'].includes(n) && !n.startsWith('.')) link(join(ROOT, 'server', n), join(tree, 'server', n));
  cpSync(join(ROOT, 'server', 'src'), join(tree, 'server', 'src'), { recursive: true });
  if (mutant) {
    const file = join(tree, mutant.file);
    const text = readFileSync(file, 'utf8');
    const hits = text.split(mutant.find).length - 1;
    if (hits !== 1) throw new Error(`变体 ${mutant.id} 过期了：${mutant.file} 里要找的那一句出现了 ${hits} 次（应为 1）`);
    writeFileSync(file, text.replace(mutant.find, mutant.replace));
  }
  return tree;
}

const run = (script, tree) => spawnSync(process.execPath, [join(HERE, script), '--root', tree], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const failedLines = (r) => (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('✗')).map((l) => l.trim().slice(2).split('（')[0].split(' → ')[0]);

let bad = 0;
const note = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };
rmSync(OUT, { recursive: true, force: true });
try {
  // 绿：没改过的副本，两套都过。先证明「抄一份」这件事本身不会把测试弄红。
  const clean = plant('unchanged', null);
  for (const script of [CONTRACT, SMOKE]) {
    const r = run(script, clean);
    note(r.status === 0, `没改过的副本：${script} 通过`);
    if (r.status !== 0) console.log((r.stdout + r.stderr).trim().split('\n').slice(-12).join('\n'));
  }
  // 红：每个变体，指定的每一套都必须失败，并且是因为有检查没过（不是脚本自己崩了）
  for (const m of MUTANTS) {
    const tree = plant(m.id, m);
    for (const script of m.suites) {
      const r = run(script, tree);
      const caught = failedLines(r);
      note(r.status === 1 && caught.length > 0, `${m.id}（${m.what}）：${script} 变红，${caught.length} 项没过${caught.length ? `，如「${caught[0]}」` : ''}`);
      if (!(r.status === 1 && caught.length > 0)) console.log((r.stdout + r.stderr).trim().split('\n').slice(-8).join('\n'));
    }
    rmSync(tree, { recursive: true, force: true });
  }
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(bad ? `identity-seam-mutation: ${bad} 处不符合预期（有变体没被抓住，或者没改过的副本不绿）` : `identity-seam-mutation: ${MUTANTS.length} 个变体全部被抓住，没改过的副本全绿`);
process.exit(bad ? 1 : 0);
