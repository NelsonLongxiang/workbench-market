#!/usr/bin/env node
/**
 * 身份接缝的变异测试：「先红后绿」里的红。
 *
 * 把 server/src 和 scripts 抄一份，每次只改坏一处（一种真实会犯的错），然后在那份副本上跑契约单测和对抗组：
 * 必须变红。一处都不改的副本必须是绿的。有哪个改坏了还全绿，就说明对抗组守不住那一处，本脚本失败。
 *
 * 副本只抄 server/src 和 scripts，其余（依赖、前端产物、设计文件）用符号链接指回本仓库；跑完删掉。
 *
 *   node scripts/identity-seam-mutation.mjs             全部变体，三个一起跑
 *   node scripts/identity-seam-mutation.mjs --jobs 1    一个一个跑
 *   node scripts/identity-seam-mutation.mjs --list      只列出变体
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `identity-mutation-${process.pid}`);
const jobsArg = process.argv.indexOf('--jobs');
const JOBS = Math.max(1, Number(jobsArg >= 0 ? process.argv[jobsArg + 1] : 3) || 3);

const CONTRACT = 'identity-contract-test.mjs', SMOKE = 'identity-seam-smoke.mjs';
const IDENTITY = 'server/src/identity.ts';

const INDEX = 'server/src/index.ts';
const PRELOAD = 'scripts/identity-fake-preload.mjs', FAKE = 'scripts/identity-fake-provider.mjs';

/** 变体：file 里的 find 恰好出现一次，换成 replace。suites 里的每一套都必须变红。 */
const MUTANTS = [
  // —— 接缝本身：身份服务对提供方的回答收得不严 ——
  { id: 'admin-flag-default-true', what: '管理员标记缺失就当管理员', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'admin: admin === true } };', replace: 'admin: admin !== false } };' },
  { id: 'subject-not-checked', what: '不核对主体和登录名是否一致（冒名）', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: '      if (sub !== `user:${login}`) return unrecognized();\n', replace: '' },
  { id: 'login-shape-not-checked', what: '不校登录名的形状', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: '      if (!loginOk(login)) return unrecognized();\n', replace: '' },
  { id: 'uid-type-not-checked', what: '不校 uid 是不是数', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: "      if (typeof uid !== 'number') return unrecognized();\n", replace: '' },
  { id: 'name-type-not-checked', what: '不校显示名的类型', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: "      if (name !== null && typeof name !== 'string') return unrecognized();\n", replace: '' },
  { id: 'missing-viewer-filled-in', what: '回答里没有查看者就补一个', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'const v = a.viewer;', replace: "const v = a.viewer ?? { login: 'anonymous', uid: 0, sub: 'user:anonymous', name: null, admin: false };" },
  { id: 'refusal-turned-into-guest', what: '提供方说认不出，服务却放一个访客进来', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'return { ok: false, http, error };', replace: "return { ok: true, viewer: { login: 'guest', uid: 0, sub: 'user:guest', name: null, admin: false } };" },
  { id: 'refusal-status-floor-removed', what: '拒绝应答的状态码不设下限（说 200 也照传）', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'http < 400 || ', replace: '' },
  { id: 'refusal-without-reason-accepted', what: '拒绝应答没有说法也照传', file: IDENTITY, suites: [CONTRACT],
    find: "      if (typeof error !== 'string') return unrecognized();\n", replace: '' },
  { id: 'answer-accessor-not-guarded', what: '读回答时抛的错不接住', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: '  } catch { /* 读回答的时候抛错：按认不出 */ }', replace: '  } catch (e) { throw e; }' },
  { id: 'provider-error-not-caught', what: '提供方抛错不接住', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'try { answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs); } catch { return { ok: false, http: 502, error: UNAVAILABLE }; }',
    replace: 'answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs);' },
  { id: 'deadline-removed', what: '认人不设期限（提供方不回答就一直等）', file: IDENTITY, suites: [CONTRACT],
    find: 'await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs)', replace: 'await Promise.resolve(provider.resolveViewer(cookieHeader, source))' },
  { id: 'provider-deadline-ignored', what: '不理会提供方自报的期限', file: IDENTITY, suites: [CONTRACT],
    find: 'this.deadlineMs = deadline ?? DEFAULT_DEADLINE_MS;', replace: 'this.deadlineMs = DEFAULT_DEADLINE_MS;' },
  { id: 'no-provider-recognizes-someone', what: '没装提供方也认出一个人', file: IDENTITY, suites: [CONTRACT],
    find: 'if (!provider) return { ok: false, http: 503, error: NO_PROVIDER };', replace: "if (!provider) return { ok: true, viewer: { login: 'nobody', uid: 0, sub: 'user:nobody', name: null, admin: false } };" },
  { id: 'identity-accessor-unguarded', what: '身份服务不在时 identity() 交出 undefined', file: IDENTITY, suites: [CONTRACT],
    find: "  if (!service) throw new Error('身份服务没有装上');\n", replace: '' },
  // —— 核心的入口：绕开身份服务，或者拿到结果之后判错 ——
  { id: 'core-bypasses-service', what: '待办读权绕开身份服务，直接调实现', file: 'server/src/tasks-read-access.ts', suites: [SMOKE],
    find: 'const who = await identity().resolveViewer(cookie);', replace: "const who = await (await import('./login-providers/odoo/odoo-viewer.ts')).resolveOdooViewer(cookie);" },
  { id: 'any-viewer-is-admin', what: '管理员认定（缓存那一支）：认得出人就当管理员', file: INDEX, suites: [SMOKE],
    find: 'try { const who = await identity().resolveViewer(cookieHeader); login = who.ok && who.viewer.admin ? who.viewer.login : null; } catch { login = null; }',
    replace: 'try { const who = await identity().resolveViewer(cookieHeader); login = who.ok ? who.viewer.login : null; } catch { login = null; }' },
  { id: 'relay-any-viewer-is-admin', what: '管理员认定（登录中继那一支）：认得出人就当管理员', file: INDEX, suites: [SMOKE],
    find: 'try { const who = await identity().resolveViewer(cookieHeader); return who.ok && who.viewer.admin ? who.viewer.login : null; } catch { return null; }',
    replace: 'try { const who = await identity().resolveViewer(cookieHeader); return who.ok ? who.viewer.login : null; } catch { return null; }' },
  { id: 'gate-admits-unrecognized', what: '登录门：认不出也放进来', file: INDEX, suites: [SMOKE],
    find: 'return who.ok ? { login: who.viewer.login, admin: who.viewer.admin } : null;', replace: "return { login: who.ok ? who.viewer.login : 'guest', admin: false };" },
  { id: 'relay-gate-admits-unrecognized', what: '登录门（登录中继那一支）：认不出也放进来', file: 'server/src/login-gate.ts', suites: [SMOKE],
    find: 'try { return await deps.odooViewer(cookie); } catch { return null; }', replace: "try { return (await deps.odooViewer(cookie)) ?? { login: 'guest', admin: false }; } catch { return null; }" },
  { id: 'run-read-ignores-grant', what: 'run 私有读：认得出人就给，不看授权', file: 'server/src/sop-read-auth.ts', suites: [SMOKE],
    find: "if (viewer.ok && runGrantActive(runId, 'user:' + viewer.viewer.login)) return", replace: 'if (viewer.ok) return' },
  { id: 'extension-viewer-unchecked', what: '交给扩展的认人：认不出也说认得出', file: INDEX, suites: [SMOKE],
    find: 'resolveViewer: (cookie) => identity().resolveViewer(cookie), loginUrl',
    replace: "resolveViewer: async (cookie) => { const r = await identity().resolveViewer(cookie); return r.ok ? r : { ok: true as const, viewer: { login: 'guest', uid: 0, sub: 'user:guest', name: null, admin: false } }; }, loginUrl" },
  { id: 'extension-admin-guard-open', what: '交给扩展的管理员门：谁都放', file: INDEX, suites: [SMOKE],
    find: 'adminGuard: async (req, res) => { await markOdooAdmin(req); return adminGuard(req, res); },', replace: 'adminGuard: async () => true,' },
  // —— 夹具：假提供方不该在测试环境之外装得上 ——
  { id: 'fixture-preload-guard-removed', what: '预加载不看环境', file: PRELOAD, suites: [CONTRACT, SMOKE],
    find: "if (process.env.NODE_ENV !== 'test') {", replace: 'if (false) {' },
  { id: 'fixture-guard-removed', what: '夹具的函数不看环境', file: FAKE, suites: [CONTRACT],
    find: "  if (process.env.NODE_ENV !== 'test') throw new Error(", replace: '  if (false) throw new Error(' },
];

if (process.argv.includes('--list')) {
  for (const m of MUTANTS) console.log(`${m.id}\t${m.file}\t${m.what}`);
  process.exit(0);
}

/** 一棵副本目录树：server/src 和 scripts 是真抄的，别的都链回本仓库。 */
function plant(name, mutant) {
  const tree = join(OUT, name);
  mkdirSync(join(tree, 'server'), { recursive: true });
  const link = (from, to) => symlinkSync(from, to, statSync(from).isDirectory() ? 'junction' : 'file');
  for (const n of readdirSync(ROOT)) if (!['server', 'scripts', 'tmp'].includes(n) && !n.startsWith('.')) link(join(ROOT, n), join(tree, n));
  cpSync(join(ROOT, 'scripts'), join(tree, 'scripts'), { recursive: true });
  for (const n of readdirSync(join(ROOT, 'server'))) if (!['src', 'data'].includes(n) && !n.startsWith('.')) link(join(ROOT, 'server', n), join(tree, 'server', n));
  cpSync(join(ROOT, 'server', 'src'), join(tree, 'server', 'src'), { recursive: true });
  if (mutant) {
    const file = join(tree, mutant.file);
    const text = readFileSync(file, 'utf8');
    const hits = text.split(mutant.find).length - 1;
    if (hits !== 1) throw new Error(`变体 ${mutant.id} 过期了：${mutant.file} 里要找的那一句出现了 ${hits} 次（应为 1）`);
    writeFileSync(file, text.replace(mutant.find, () => mutant.replace));
  }
  return tree;
}

// 跑的是副本里的脚本：夹具也在副本里，改坏夹具的变体才作数
const run = (script, tree) => new Promise((done) => {
  execFile(process.execPath, [join(tree, 'scripts', script), '--root', tree], { cwd: tree, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60 * 1000 },
    (err, stdout, stderr) => done({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});
const failedLines = (r) => r.stdout.split('\n').filter((l) => l.trim().startsWith('✗')).map((l) => l.trim().slice(2).split('（')[0].split(' → ')[0]);
/** 脚本自己没跑成（实例没起来、超时、崩了），不是「有检查没过」：这种不算变红 */
const broken = (r) => r.status !== 0 && (r.status !== 1 || failedLines(r).length === 0 || r.stdout.includes('没跑完'));
/** 没跑成就再跑一次；两次都没跑成，交给调用方当作失败 */
async function runTwice(script, tree) {
  const first = await run(script, tree);
  return broken(first) ? run(script, tree) : first;
}
async function pool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]); } }));
  return out;
}
const tailOf = (r) => (r.stdout + r.stderr).trim().split('\n').slice(-8).join('\n');

let bad = 0;
const note = (ok, text, detail = '') => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); if (!ok && detail) console.log(detail); };
rmSync(OUT, { recursive: true, force: true });
try {
  // 绿：没改过的副本，两套都过。先证明「抄一份」这件事本身不会把测试弄红。
  const clean = plant('unchanged', null);
  for (const script of [CONTRACT, SMOKE]) {
    const r = await runTwice(script, clean);
    note(r.status === 0, `没改过的副本：${script} 通过`, r.status === 0 ? '' : tailOf(r));
  }
  rmSync(clean, { recursive: true, force: true });
  // 红：每个变体，指定的每一套都必须失败，并且是因为有检查没过（不是脚本自己没跑成）
  const results = await pool(MUTANTS, JOBS, async (m) => {
    const tree = plant(m.id, m);
    const runs = [];
    for (const script of m.suites) runs.push({ script, r: await runTwice(script, tree) });
    rmSync(tree, { recursive: true, force: true });
    return { m, runs };
  });
  for (const { m, runs } of results) {
    for (const { script, r } of runs) {
      const caught = failedLines(r);
      const red = r.status === 1 && caught.length > 0 && !broken(r);
      note(red, `${m.id}（${m.what}）：${script} ${red ? `变红，${caught.length} 项没过，如「${caught[0]}」` : broken(r) ? '没跑成（不算变红）' : '还是绿的：没被抓住'}`, red ? '' : tailOf(r));
    }
  }
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(bad ? `identity-seam-mutation: ${bad} 处不符合预期（有变体没被抓住，或者没改过的副本不绿）` : `identity-seam-mutation: ${MUTANTS.length} 个变体全部被抓住，没改过的副本全绿`);
process.exit(bad ? 1 : 0);
