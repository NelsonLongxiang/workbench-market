#!/usr/bin/env node
/**
 * 身份接缝的变异测试：「先红后绿」里的红。
 *
 * 把 server/src 和 scripts 抄一份，每次只改坏一处（一种真实会犯的错），然后在那份副本上跑契约单测、主体服务单测和对抗组：
 * 必须变红。一处都不改的副本必须是绿的。有哪个改坏了还全绿，就说明对抗组守不住那一处，本脚本失败。
 *
 * 副本只抄 server/src 和 scripts，其余（依赖、前端产物、设计文件）用符号链接指回本仓库；跑完删掉。
 *
 *   node scripts/identity-seam-mutation.mjs             全部变体，三个一起跑
 *   node scripts/identity-seam-mutation.mjs --jobs 1    一个一个跑
 *   node scripts/identity-seam-mutation.mjs --only a,b  只跑点名的变体（调试用；CI 跑全部）
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

const CONTRACT = 'identity-contract-test.mjs', SMOKE = 'identity-seam-smoke.mjs', SERVICE = 'principal-service-test.mjs';
const IDENTITY = 'server/src/identity.ts';
const PRINCIPAL = 'server/src/services/principal.ts', ROUTES = 'server/src/routes/principals.ts', DB = 'server/src/db.ts', GATE = 'server/src/login-gate.ts';

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
    find: 'try { answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs); } catch { return { provider, result: { ok: false, http: 502, error: UNAVAILABLE } }; }',
    replace: 'answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs);' },
  { id: 'deadline-removed', what: '认人不设期限（提供方不回答就一直等）', file: IDENTITY, suites: [CONTRACT],
    find: 'await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs)', replace: 'await Promise.resolve(provider.resolveViewer(cookieHeader, source))' },
  { id: 'provider-deadline-ignored', what: '不理会提供方自报的期限', file: IDENTITY, suites: [CONTRACT],
    find: 'this.deadlineMs = deadline ?? DEFAULT_DEADLINE_MS;', replace: 'this.deadlineMs = DEFAULT_DEADLINE_MS;' },
  { id: 'no-provider-recognizes-someone', what: '没装提供方也认出一个人', file: IDENTITY, suites: [CONTRACT],
    find: 'if (!provider) return { provider: null, result: { ok: false, http: 503, error: NO_PROVIDER } };',
    replace: "if (!provider) return { provider: { name: 'none' } as LoginProvider, result: { ok: true, viewer: { login: 'nobody', uid: 0, sub: 'user:nobody', name: null, admin: false } } };" },
  { id: 'identity-accessor-unguarded', what: '身份服务不在时 identity() 交出 undefined', file: IDENTITY, suites: [CONTRACT],
    find: "  if (!service) throw new Error('身份服务没有装上');\n", replace: '' },
  // —— 核心的入口：绕开身份服务，或者拿到结果之后判错 ——
  { id: 'core-bypasses-service', what: '待办读权绕开身份服务，直接调实现', file: 'server/src/tasks-read-access.ts', suites: [SMOKE],
    find: 'const who = await identity().resolveViewer(cookie);', replace: "const who = await (await import('./login-providers/odoo/odoo-viewer.ts')).resolveOdooViewer(cookie);" },
  { id: 'any-viewer-is-admin', what: '管理员认定：认得出人就当管理员', file: INDEX, suites: [SMOKE],
    find: 'return who.ok && who.viewer.admin ? who.viewer.login : null;', replace: 'return who.ok ? who.viewer.login : null;' },
  { id: 'relay-admin-uses-cache', what: '管理员认定：登录中继开着也用缓存（提供方那边登出了还当管理员）', file: INDEX, suites: [SMOKE],
    find: "const who = process.env.WM_ODOO_LOGIN_PROXY === '1' ? await identity().resolveViewer(cookieHeader) : await odooAdminViewer(cookieHeader);", replace: 'const who = await odooAdminViewer(cookieHeader);' },
  { id: 'relay-gate-uses-cache', what: '登录门：要求现查时装配方照样给缓存的', file: INDEX, suites: [SMOKE],
    find: 'const who = fresh ? await identity().resolveViewer(cookie) : await loginGateViewer(cookie);', replace: 'const who = await loginGateViewer(cookie);' },
  { id: 'gate-admits-unrecognized', what: '登录门：认不出也放进来', file: INDEX, suites: [SMOKE],
    find: 'return who.ok ? { login: who.viewer.login, admin: who.viewer.admin } : null;', replace: "return { login: who.ok ? who.viewer.login : 'guest', admin: false };" },
  { id: 'gate-falls-back-to-guest', what: '登录门：认人的结果是空的就补一个访客', file: GATE, suites: [SMOKE],
    find: "try { return await deps.odooViewer(cookie, process.env.WM_ODOO_LOGIN_PROXY === '1'); } catch { return null; }",
    replace: "try { return (await deps.odooViewer(cookie, process.env.WM_ODOO_LOGIN_PROXY === '1')) ?? { login: 'guest', admin: false }; } catch { return null; }" },
  { id: 'gate-never-asks-fresh', what: '登录门：登录中继开着也不要求现查', file: GATE, suites: [SMOKE],
    find: "try { return await deps.odooViewer(cookie, process.env.WM_ODOO_LOGIN_PROXY === '1'); } catch { return null; }", replace: 'try { return await deps.odooViewer(cookie, false); } catch { return null; }' },
  { id: 'run-read-ignores-grant', what: 'run 私有读：认得出人就给，不看授权', file: 'server/src/sop-read-auth.ts', suites: [SMOKE],
    find: 'if (viewer.ok && runGrantActive(runId, viewer.viewer.sub)) return', replace: 'if (viewer.ok) return' },
  { id: 'run-read-keyed-by-login', what: 'run 私有读：拿登录名拼主体去查授权，不用目录给的主体标识', file: 'server/src/sop-read-auth.ts', suites: [SMOKE],
    find: 'runGrantActive(runId, viewer.viewer.sub)', replace: "runGrantActive(runId, 'user:' + viewer.viewer.login)" },
  { id: 'extension-viewer-unchecked', what: '交给扩展的认人：认不出也说认得出', file: INDEX, suites: [SMOKE],
    find: 'resolveViewer: (cookie) => identity().resolveViewer(cookie), loginUrl',
    replace: "resolveViewer: async (cookie) => { const r = await identity().resolveViewer(cookie); return r.ok ? r : { ok: true as const, viewer: { login: 'guest', uid: 0, sub: 'user:guest', name: null, admin: false } }; }, loginUrl" },
  { id: 'extension-admin-guard-open', what: '交给扩展的管理员门：谁都放', file: INDEX, suites: [SMOKE],
    find: 'adminGuard: async (req, res) => { await markOdooAdmin(req); return adminGuard(req, res); },', replace: 'adminGuard: async () => true,' },
  // —— 主体目录这一步：提供方认出的人，对到主体上才算数 ——
  { id: 'principal-directory-skipped', what: '认出来的人不过主体目录就交出去', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: '    return this.admitted(provider.name, result.viewer);', replace: '    return result;' },
  { id: 'missing-directory-admits', what: '主体目录没装上也照样认人', file: IDENTITY, suites: [CONTRACT],
    find: 'if (!directory) return { ok: false, http: 503, error: NO_DIRECTORY };', replace: 'if (!directory) return { ok: true, viewer };' },
  { id: 'directory-error-admits', what: '主体目录抛错就放行', file: IDENTITY, suites: [CONTRACT],
    find: '    } catch { return { ok: false, http: 503, error: DIRECTORY_FAILED }; }', replace: '    } catch { return { ok: true, viewer }; }' },
  { id: 'disabled-principal-admitted', what: '主体停用了照样认', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: "if (reason === 'disabled') return { ok: false, http: 403, error: DISABLED };", replace: "if (reason === 'disabled') return { ok: true, viewer };" },
  { id: 'unbound-identity-admitted', what: '外部身份对不到主体也照样认', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: "if (reason === 'unbound') return { ok: false, http: 403, error: UNBOUND };", replace: "if (reason === 'unbound') return { ok: true, viewer };" },
  { id: 'directory-answer-unchecked', what: '目录给的主体标识不校形状', file: IDENTITY, suites: [CONTRACT],
    find: 'if (personIdOk(principal)) return', replace: 'if (principal) return' },
  { id: 'directory-garbage-admits', what: '目录的回答看不懂就放行', file: IDENTITY, suites: [CONTRACT],
    find: '    } catch { /* 读回答的时候抛错：按不可用 */ }\n    return { ok: false, http: 503, error: DIRECTORY_FAILED };', replace: '    } catch { /* 读回答的时候抛错：按不可用 */ }\n    return { ok: true, viewer };' },
  { id: 'subject-from-provider', what: '主体标识不用目录给的，用提供方自己写的', file: IDENTITY, suites: [CONTRACT],
    find: 'return { ok: true, viewer: { ...viewer, sub: principal } };', replace: 'return { ok: true, viewer };' },
  // —— 带缓存的认人：缓存的只能是提供方的回答 ——
  { id: 'cache-hit-skips-directory', what: '缓存命中时不问主体目录（停用要等缓存过期才生效）', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: 'if (hit && hit.provider === this.provider && Date.now() - hit.at < ttlMs) ({ provider, result } = hit);', replace: 'if (hit && hit.provider === this.provider && Date.now() - hit.at < ttlMs) return { ...hit.result };' },
  { id: 'cache-keeps-directory-verdict', what: '把目录的结论也缓存了（恢复要等缓存过期才生效）', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: '({ provider, result } = await this.recognize(cookieHeader));', replace: '({ provider, result } = await this.recognize(cookieHeader)); result = this.settled(provider, result);' },
  { id: 'cache-ignores-provider-swap', what: '换了提供方，旧提供方的回答还拿来用', file: IDENTITY, suites: [CONTRACT],
    find: 'hit.provider === this.provider && ', replace: '' },
  { id: 'cache-never-expires', what: '缓存不过期', file: IDENTITY, suites: [CONTRACT],
    find: 'Date.now() - hit.at < ttlMs', replace: 'true' },
  { id: 'cache-unbounded', what: '缓存没有容量上限', file: IDENTITY, suites: [CONTRACT],
    find: '          if (cache.size > max) cache.clear();\n', replace: '' },
  // —— 主体服务和两张表 ——
  { id: 'status-not-checked', what: '主体服务：不看主体停没停用', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "b.status === 'active' ? { ok: true, principal: b.id } : { ok: false, reason: 'disabled' }", replace: '{ ok: true, principal: b.id }' },
  { id: 'non-person-can-log-in', what: '主体服务：绑在席位上的外部身份也能登录', file: PRINCIPAL, suites: [SERVICE],
    find: "b.kind !== 'person' ? { ok: false, reason: 'unbound' } : ", replace: '' },
  { id: 'squatted-id-claimed', what: '主体服务：标识被占着就把外部身份绑上去（外来账号顶替已有主体）', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "else if (db.prepare('SELECT 1 FROM principals WHERE id = ?').get(id)) out = { ok: false, reason: 'unbound' };",
    replace: "else if (db.prepare('SELECT 1 FROM principals WHERE id = ?').get(id)) { db.prepare('INSERT INTO principal_identities (provider, external_id, principal_id) VALUES (?, ?, ?)').run(provider, externalId, id); out = { ok: true, principal: id }; }" },
  { id: 'identity-lookup-ignores-provider', what: '主体服务：查外部身份不分提供方', file: PRINCIPAL, suites: [SERVICE],
    find: 'WHERE i.provider = ? AND i.external_id = ?', replace: 'WHERE ? IS NOT NULL AND i.external_id = ?' },
  { id: 'disable-is-a-no-op', what: '主体服务：停用其实没改状态', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: '.run(status, text(by, 256), text(reason, 500), id, status).changes === 1;', replace: ".run('active', text(by, 256), text(reason, 500), id, status).changes === 1;" },
  { id: 'identity-shape-not-checked', what: '主体服务：不校外部身份的形状', file: PRINCIPAL, suites: [SERVICE],
    find: "    if (!providerOk(provider) || !externalIdOk(externalId)) throw new Error('外部身份的形状不对');\n", replace: '' },
  { id: 'half-built-principal', what: '主体服务：建了主体却没建外部身份', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "        db.prepare('INSERT INTO principal_identities (provider, external_id, principal_id) VALUES (?, ?, ?)').run(provider, externalId, id);\n", replace: '' },
  { id: 'owner-not-required', what: '表：不是人的主体不要求责任人', file: DB, suites: [SERVICE],
    find: "  CHECK (kind = 'person' OR owner <> '')\n", replace: '  CHECK (1)\n' },
  { id: 'id-prefix-unchecked', what: '表：标识的前缀不必和类别对上', file: DB, suites: [SERVICE],
    find: "      = CASE kind WHEN 'person' THEN 'user:' WHEN 'seat' THEN 'seat:' WHEN 'app' THEN 'app:' WHEN 'system' THEN 'system:' ELSE 'node:' END),",
    replace: "      = CASE kind WHEN 'person' THEN 'user:' WHEN 'seat' THEN 'seat:' WHEN 'app' THEN 'app:' WHEN 'system' THEN 'system:' ELSE 'node:' END OR 1),"},
  { id: 'identity-not-unique', what: '表：同一个外部身份可以挂到两个主体上', file: DB, suites: [SERVICE],
    find: '  PRIMARY KEY (provider, external_id)\n', replace: '  PRIMARY KEY (provider, external_id, principal_id)\n' },
  // —— 主体管理接口 ——
  { id: 'principal-list-open', what: '列出主体不要管理员', file: ROUTES, suites: [SMOKE],
    find: '    if (!(await admin(req, res))) return;\n    res.json({ principals: principals().list() });', replace: '    res.json({ principals: principals().list() });' },
  { id: 'everyone-is-cli', what: '主体管理接口：把所有请求都当成本机命令行', file: ROUTES, suites: [SMOKE],
    find: "    if (!browserMarked(req) && rawLoopback(req)) return 'cli'; // 本机命令行", replace: "    if (rawLoopback(req) || true) return 'cli';" },
  { id: 'browser-counts-as-cli', what: '主体管理接口：带浏览器标记的本机请求也算命令行', file: ROUTES, suites: [SMOKE],
    find: "    if (!browserMarked(req) && rawLoopback(req)) return 'cli'; // 本机命令行", replace: "    if (rawLoopback(req)) return 'cli';" },
  { id: 'self-disable-allowed', what: '管理员可以停用自己', file: ROUTES, suites: [SMOKE],
    find: "      if (self === id) throw new HttpError(409, '不能停用自己');\n", replace: '' },
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
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg >= 0 ? String(process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean) : null;
if (ONLY) {
  const unknown = ONLY.filter((id) => !MUTANTS.some((m) => m.id === id));
  if (unknown.length || !ONLY.length) { console.error(`--only：没有这些变体：${unknown.join('、') || '（空）'}`); process.exit(2); }
}
const SELECTED = ONLY ? MUTANTS.filter((m) => ONLY.includes(m.id)) : MUTANTS;

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
  for (const script of [CONTRACT, SERVICE, SMOKE]) {
    const r = await runTwice(script, clean);
    note(r.status === 0, `没改过的副本：${script} 通过`, r.status === 0 ? '' : tailOf(r));
  }
  rmSync(clean, { recursive: true, force: true });
  // 红：每个变体，指定的每一套都必须失败，并且是因为有检查没过（不是脚本自己没跑成）
  const results = await pool(SELECTED, JOBS, async (m) => {
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
console.log(bad ? `identity-seam-mutation: ${bad} 处不符合预期（有变体没被抓住，或者没改过的副本不绿）` : `identity-seam-mutation: ${SELECTED.length} 个变体全部被抓住，没改过的副本全绿${ONLY ? `（只跑了点名的，共 ${MUTANTS.length} 个）` : ''}`);
process.exit(bad ? 1 : 0);
