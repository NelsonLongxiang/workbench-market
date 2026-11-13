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
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `identity-mutation-${process.pid}`);
const jobsArg = process.argv.indexOf('--jobs');
// 并行跑的套数：每一套自己还要起好几个隔离实例，CI 机器上开满核数会让实例的启动自检超时（拒绝启动，按没跑成算）。上限 2
const JOBS = Math.min(2, Math.max(1, Number(jobsArg >= 0 ? process.argv[jobsArg + 1] : 2) || 2));

const CONTRACT = 'identity-contract-test.mjs', SMOKE = 'identity-seam-smoke.mjs', SERVICE = 'principal-service-test.mjs', FOLD = 'principal-fold-test.mjs', FEISHU = 'feishu-login-smoke.mjs', OFFBOARD = 'feishu-offboard-smoke.mjs', GRANTS = 'grants-smoke.mjs', JUDGE = 'judgment-compare-smoke.mjs', ZERO = 'judgment-compare-zero-test.mjs', SWEEP = 'judgment-compare-sweep-test.mjs', PRESETS = 'role-presets-test.mjs', CUSTOM = 'custom-roles-smoke.mjs';
const IDENTITY = 'server/src/identity.ts';
const SESSIONS_SVC = 'server/src/services/login-session.ts', FLOWS = 'server/src/routes/login-flows.ts', EVENTS = 'server/src/routes/login-events.ts', GRANT_SVC = 'server/src/services/grant.ts', GRANT_ROUTES = 'server/src/routes/grants.ts', ROLES = 'server/src/roles.ts', COMPARE = 'server/src/judgment-compare.ts', BUILTINS_FILE = 'server/src/judgment-builtins.ts', JUDGE_FILE = 'server/src/judgment.ts', GRANT_SVC2 = 'server/src/services/grant.ts', FEISHU_PLUGIN = 'server/src/login-providers/feishu/index.ts';
const PRINCIPAL = 'server/src/services/principal.ts', ROUTES = 'server/src/routes/principals.ts', DB = 'server/src/db.ts', GATE = 'server/src/login-gate.ts', GATE_ROUTES = 'server/src/routes/login-gate.ts'; // 登录门的四条路由搬进了 routes/（阶段三）

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
    find: 'try { answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs); } catch (e) {',
    replace: 'answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs); if (Date.now() < 0) { const e: unknown = null;' },
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
    find: "const who = loginRelay().relayLogin() ? await identity().resolveViewer(cookieHeader) : await odooAdminViewer(cookieHeader);", replace: 'const who = await odooAdminViewer(cookieHeader);' },
  { id: 'relay-gate-uses-cache', what: '登录门：要求现查时装配方照样给缓存的', file: INDEX, suites: [SMOKE],
    find: 'const who = fresh ? await identity().resolveViewer(cookie) : await loginGateViewer(cookie);', replace: 'const who = await loginGateViewer(cookie);' },
  { id: 'gate-admits-unrecognized', what: '登录门：认不出也放进来', file: INDEX, suites: [SMOKE],
    find: "    if (!who.ok) return who.held ? { held: true as const } : sourceDown(who) ? { down: true as const } : null;", replace: "    if (!who.ok) return { login: 'guest', admin: false };" },
  // —— 上线当天「我进不去了」：登录成功、卡在主体那一步的人给等待页，对不上主体的进待对接清单 ——
  { id: 'held-sent-to-login', what: '登录门：登录成功、卡在主体那一步的人照旧跳回登录页', file: GATE, suites: [SMOKE],
    find: "      if (held.has(req) && wantsPage(req) && !p.startsWith('/api/')) return holdPage(res);\n", replace: '' },
  { id: 'held-gets-identity', what: '登录门：卡住的人被当成有身份放进去', file: GATE, suites: [SMOKE],
    find: "      if (who && 'held' in who) held.add(req);\n      else if (who && 'down' in who)", replace: "      if (who && 'held' in who) id = { via: 'odoo', login: 'held', admin: false };\n      else if (who && 'down' in who)" },
  { id: 'held-page-tells-disabled', what: '等待页按停用和没对到分开说（透露这个人被停用了）', file: IDENTITY, suites: [SMOKE],
    find: "          if (reason === 'disabled') return { ok: false, http: 403, error: DISABLED, held: true };", replace: "          if (reason === 'disabled') return { ok: false, http: 403, error: DISABLED };" },
  { id: 'held-unauthenticated', what: '没通过提供方认证的（门户账号）也给等待页', file: IDENTITY, suites: [SMOKE],
    find: "    if (!result.ok) return { ...result }; // 副本", replace: "    if (!result.ok) return result.http === 403 ? { ...result, held: true } : { ...result }; // 副本" },
  { id: 'pending-only-from-flows', what: '只有登录方式的回调记待对接，现有登录对不上主体的进不了清单', file: PRINCIPAL, suites: [SMOKE],
    find: "    if (out.ok === false && out.reason === 'unbound') {\n", replace: "    if (false) {\n" },
  { id: 'pending-takes-disabled', what: '停用的也进待对接清单', file: PRINCIPAL, suites: [SMOKE],
    find: "    if (out.ok === false && out.reason === 'unbound') {\n", replace: "    if (out.ok === false) {\n" },
  { id: 'pending-seat-reason-dropped', what: '绑在席位上的账号进清单时不单列原因（管理员以为点对接就行）', file: PRINCIPAL, suites: [SERVICE],
    find: "held && held.kind !== 'person' ? 'bound-to-non-person' : 'unbound'", replace: "'unbound'" },
  { id: 'pending-email-overwritten', what: '待对接清单再来时拿空邮箱盖掉原来的', file: PRINCIPAL, suites: [SERVICE],
    find: "        email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE principal_pending.email END,\n", replace: "        email = excluded.email,\n" },
  { id: 'gate-falls-back-to-guest', what: '登录门：认人的结果是空的就补一个访客', file: GATE, suites: [SMOKE],
    find: 'try { return await deps.odooViewer(cookie, loginRelay().relayLogin()); } catch { return null; }',
    replace: "try { return (await deps.odooViewer(cookie, loginRelay().relayLogin())) ?? { login: 'guest', admin: false }; } catch { return null; }" },
  { id: 'gate-never-asks-fresh', what: '登录门：登录中继开着也不要求现查', file: GATE, suites: [SMOKE],
    find: 'try { return await deps.odooViewer(cookie, loginRelay().relayLogin()); } catch { return null; }', replace: 'try { return await deps.odooViewer(cookie, false); } catch { return null; }' },
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
    find: "if (reason === 'disabled') return { ok: false, http: 403, error: DISABLED, held: true };", replace: "if (reason === 'disabled') return { ok: true, viewer };" },
  { id: 'unbound-identity-admitted', what: '外部身份对不到主体也照样认', file: IDENTITY, suites: [CONTRACT, SMOKE],
    find: "if (reason === 'unbound') return { ok: false, http: 403, error: UNBOUND, held: true };", replace: "if (reason === 'unbound') return { ok: true, viewer };" },
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
    find: "(b.kind !== 'person' ? { ok: false, reason: 'unbound' } : b.status === 'active' ? { ok: true, principal: b.id } : { ok: false, reason: 'disabled' })", replace: "(b.kind !== 'person' ? { ok: false, reason: 'unbound' } : { ok: true, principal: b.id })" },
  { id: 'non-person-can-log-in', what: '主体服务：绑在席位上的外部身份也能登录', file: PRINCIPAL, suites: [SERVICE],
    find: "b.kind !== 'person' ? { ok: false, reason: 'unbound' } : ", replace: '' },
  { id: 'squatted-id-claimed', what: '主体服务：标识被占着就把外部身份绑上去（外来账号顶替已有主体）', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "else if (db.prepare('SELECT 1 FROM principals WHERE id_key = ?').get(idKey)) out = { ok: false, reason: 'unbound' };",
    replace: "else if (db.prepare('SELECT 1 FROM principals WHERE id_key = ?').get(idKey)) { db.prepare('INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES (?, ?, ?, ?)').run(provider, externalId, externalKey, id); out = { ok: true, principal: id }; }" },
  { id: 'identity-lookup-ignores-provider', what: '主体服务：查外部身份不分提供方', file: PRINCIPAL, suites: [SERVICE],
    find: 'WHERE i.provider = ? AND i.external_id = ?', replace: 'WHERE ? IS NOT NULL AND i.external_id = ?' },
  { id: 'disable-is-a-no-op', what: '主体服务：停用其实没改状态', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: '.run(status, text(by, 256), text(reason, 500), id, status).changes === 1;', replace: ".run('active', text(by, 256), text(reason, 500), id, status).changes === 1;" },
  { id: 'identity-shape-not-checked', what: '主体服务：不校外部身份的形状', file: PRINCIPAL, suites: [SERVICE],
    find: "    if (!providerOk(provider) || !externalIdOk(externalId)) throw new Error('外部身份的形状不对');\n    // 登录认出来的只能是人", replace: '    // 登录认出来的只能是人' },
  { id: 'half-built-principal', what: '主体服务：建了主体却没建外部身份', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "        db.prepare('INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES (?, ?, ?, ?)').run(provider, externalId, externalKey, id);\n", replace: '' },
  // —— 等价写法：比较按规范化之后的值（验收 M1）——
  { id: 'identity-key-collision-ignored', what: '主体服务：不看外部身份的等价写法', file: PRINCIPAL, suites: [SERVICE],
    find: "      else if (db.prepare('SELECT 1 FROM principal_identities WHERE provider = ? AND external_key = ?').get(provider, externalKey)) out = { ok: false, reason: 'unbound' };\n", replace: '' },
  { id: 'principal-key-collision-ignored', what: '主体服务：主体标识按原值比，不按规范化之后的值', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "get(idKey)) out = { ok: false, reason: 'unbound' };", replace: "get(idKey) && false) out = { ok: false, reason: 'unbound' };" },
  { id: 'fold-lower-only', what: '规范化：大小写只转小写，不做完整折叠（ß、ẞ、ς、ſ 漏网）', file: PRINCIPAL, suites: [FOLD, SERVICE, SMOKE],
    find: '  if (!CWCF.test(c)) f = c;\n  else {', replace: '  if (true) f = c.toLowerCase();\n  else {' },
  { id: 'fold-one-case-round', what: '规范化：只转一轮大写再小写（ẞ 漏网，验收 M1′ 那种；外层迭代到不动点会把它补回来，所以只有成批测试抓得到这一层）', file: PRINCIPAL, suites: [FOLD],
    find: '  if (!CWCF.test(c)) f = c;\n  else {', replace: '  if (true) f = c.toUpperCase().toLowerCase();\n  else {' },
  { id: 'fold-no-casefold-guard', what: '规范化：不看 Changes_When_Casefolded，切罗基文折反方向', file: PRINCIPAL, suites: [FOLD],
    find: '  if (!CWCF.test(c)) f = c;\n', replace: '  if (false) f = c;\n' },
  { id: 'fold-no-full-expansion', what: '规范化：不用完整折叠的展开（ß 不折成 ss）', file: PRINCIPAL, suites: [FOLD],
    find: '    if ([...full].length > 1) f = full;\n', replace: '    if (false) f = full;\n' },
  { id: 'fold-turkic-dotless-i', what: '规范化：土耳其语的 ı 也折成 i（把不同的人算成撞上）', file: PRINCIPAL, suites: [FOLD],
    find: '  if (!CWCF.test(c)) f = c;\n', replace: "  if (c === '\\u0131') f = 'i';\n  else if (!CWCF.test(c)) f = c;\n" },
  { id: 'key-no-nfkc', what: '规范化：不做 NFKC（全角半角、连字算两个）', file: PRINCIPAL, suites: [FOLD, SERVICE, SMOKE],
    find: "[...s.normalize('NFD').normalize('NFKC').replace(IGNORABLE, '')].map(caseFoldChar).join('').normalize('NFKC').replace(IGNORABLE, '')",
    replace: "[...s.normalize('NFD').replace(IGNORABLE, '')].map(caseFoldChar).join('').normalize('NFC').replace(IGNORABLE, '')" },
  { id: 'key-keeps-ignorables', what: '规范化：不去零宽一类的字符', file: PRINCIPAL, suites: [FOLD, SERVICE, SMOKE],
    find: "const IGNORABLE = /\\p{Default_Ignorable_Code_Point}/gu;", replace: 'const IGNORABLE = /(?!)/gu;' },
  { id: 'principal-key-not-unique', what: '表：主体标识的规范化值不唯一', file: DB, suites: [SERVICE],
    find: "  id_key TEXT NOT NULL UNIQUE CHECK (id_key <> ''),", replace: "  id_key TEXT NOT NULL CHECK (id_key <> '')," },
  { id: 'identity-key-not-unique', what: '表：外部身份的规范化值不唯一', file: DB, suites: [SERVICE],
    find: "  PRIMARY KEY (provider, external_id),\n  UNIQUE (provider, external_key)\n", replace: "  PRIMARY KEY (provider, external_id)\n" },
  { id: 'kind-prefix-loose', what: '表：外部节点的前缀不看类别（席位也能用 node: 前缀）', file: DB, suites: [SERVICE],
    find: "(kind = 'node' AND id GLOB 'node:?*')", replace: "(id GLOB 'node:?*')" },
  { id: 'status-change-not-logged', what: '停用、恢复不写日志', file: ROUTES, suites: [SMOKE],
    find: "    if (out.changed) console.log(", replace: "    if (false) console.log(" },
  { id: 'content-ignores-disable', what: '内容面：主体停用也当认得出', file: INDEX, suites: [SMOKE],
    find: "return result.ok ? { subject: result.viewer.sub + ':' + result.viewer.uid, internal: true } : null;",
    replace: "return result.ok || result.http === 403 ? { subject: 'user:alpha:11', internal: true } : null;" },
  { id: 'owner-not-required', what: '表：不是人的主体不要求责任人', file: DB, suites: [SERVICE],
    find: "  CHECK (kind = 'person' OR owner <> '')\n", replace: '  CHECK (1)\n' },
  { id: 'id-prefix-unchecked', what: '表：标识的前缀不必和类别对上', file: DB, suites: [SERVICE],
    find: "  CHECK ((kind = 'person' AND id GLOB 'user:?*')", replace: "  CHECK (1 OR (kind = 'person' AND id GLOB 'user:?*')" },
  { id: 'identity-not-unique', what: '表：同一个外部身份可以挂到两个主体上', file: DB, suites: [SERVICE],
    find: "  PRIMARY KEY (provider, external_id),\n  UNIQUE (provider, external_key)\n", replace: "  PRIMARY KEY (provider, external_id, principal_id)\n" },
  // —— 主体管理接口 ——
  { id: 'principal-list-open', what: '列出主体不要管理员', file: ROUTES, suites: [SMOKE],
    find: '    if (!(await admin(req, res))) return;\n    res.json({ principals: principals().list() });', replace: '    res.json({ principals: principals().list() });' },
  { id: 'everyone-is-cli', what: '主体管理接口：把所有请求都当成本机命令行', file: ROUTES, suites: [SMOKE],
    find: "    if (!browserMarked(req) && rawLoopback(req)) return 'cli'; // 本机命令行", replace: "    if (rawLoopback(req) || true) return 'cli';" },
  { id: 'browser-counts-as-cli', what: '主体管理接口：带浏览器标记的本机请求也算命令行', file: ROUTES, suites: [SMOKE],
    find: "    if (!browserMarked(req) && rawLoopback(req)) return 'cli'; // 本机命令行", replace: "    if (rawLoopback(req)) return 'cli';" },
  { id: 'self-disable-allowed', what: '管理员可以停用自己', file: ROUTES, suites: [SMOKE],
    find: "      if (self === id) throw new HttpError(409, '不能停用自己');\n", replace: '' },
  // —— 管理员对一次外部身份 ——
  { id: 'bind-steals-identity', what: '绑定：外部身份已经绑在别人身上也照样改绑', file: PRINCIPAL, suites: [SERVICE, SMOKE],
    find: "        if (held) return { ok: false, reason: 'conflict', principal: held.principal_id };\n", replace: "        if (held) db.prepare('DELETE FROM principal_identities WHERE provider = ? AND principal_id = ?').run(provider, held.principal_id);\n" },
  { id: 'bind-to-disabled', what: '绑定：可以绑到停用的人身上', file: PRINCIPAL, suites: [SERVICE],
    find: "        if (target.status !== 'active') return { ok: false, reason: 'disabled' };\n", replace: '' },
  { id: 'bind-create-ignores-clash', what: '绑定：新建的标识和已有的等价也照建', file: PRINCIPAL, suites: [SERVICE],
    find: "          if (clash) return { ok: false, reason: 'taken', principal: clash.id };\n", replace: '' },
  { id: 'bind-to-self', what: '管理员可以往自己身上绑外部身份', file: ROUTES, suites: [SMOKE],
    find: "    if (selfOf(actor) === target) throw new HttpError(409, '不能往自己身上绑外部身份');\n", replace: '' },
  { id: 'unbind-own', what: '管理员可以解绑自己名下的外部身份', file: ROUTES, suites: [SMOKE],
    find: "    if (self && principals().principalOf(provider, externalId) === self) throw new HttpError(409, '不能解绑自己名下的外部身份');\n", replace: '' },
  { id: 'bind-open', what: '绑定不要管理员', file: ROUTES, suites: [SMOKE],
    find: "    const actor = await admin(req, res);\n    if (!actor) return;\n    const { provider, externalId } = identityOf(req.body);\n    const target", replace: "    const actor = 'nobody';\n    const { provider, externalId } = identityOf(req.body);\n    const target" },
  // —— 飞书登录和市场会话（5b）——
  { id: 'state-not-bound-to-browser', what: 'state 不核对浏览器半边（回调链接换个浏览器也能用）', file: SESSIONS_SVC, suites: [FEISHU],
    find: " || !sameHex(row.browser_sha256, sha(browser))) return null;\n    const taken = db.prepare('DELETE FROM login_states WHERE state_sha256 = ? AND browser_sha256 = ? AND flow = ? AND expires_at > ? RETURNING next').get(sha(state), sha(browser), flow, now)",
    replace: ") return null;\n    const taken = db.prepare('DELETE FROM login_states WHERE state_sha256 = ? AND ? <> \\'\\' AND flow = ? AND expires_at > ? RETURNING next').get(sha(state), sha(browser), flow, now)" },
  { id: 'state-reusable', what: 'state 核对之后不作废（可以重放）', file: SESSIONS_SVC, suites: [FEISHU],
    find: "db.prepare('DELETE FROM login_states WHERE state_sha256 = ? AND browser_sha256 = ? AND flow = ? AND expires_at > ? RETURNING next')", replace: "db.prepare('SELECT next FROM login_states WHERE state_sha256 = ? AND ? <> \\'\\' AND flow = ? AND expires_at > ?')" },
  { id: 'next-not-sanitized', what: 'next 不过防外跳', file: FLOWS, suites: [FEISHU],
    find: '    const next = safeNext(req.query.next);', replace: "    const next = String(req.query.next ?? '/');" },
  { id: 'union-shape-unchecked', what: '飞书给的 union_id 不校形状（缺失、被篡改照样认）', file: FEISHU_PLUGIN, suites: [FEISHU],
    find: "    if (typeof unionId !== 'string' || !UNION_ID.test(unionId)) return fail(502, '飞书返回的用户标识缺失或形状不对');", replace: "    if (typeof unionId !== 'string' || !unionId) return fail(502, '飞书返回的用户标识缺失或形状不对');" },
  { id: 'auto-bind-default-on', what: '按邮箱自动对上缺省就开着', file: FEISHU_PLUGIN, suites: [FEISHU],
    find: "    autoBind: autoBind === 'on',", replace: "    autoBind: autoBind !== 'off'," },
  { id: 'session-ignores-status', what: '会话不看主体停没停用', file: SESSIONS_SVC, suites: [FEISHU],
    find: " AND p.status = 'active' AND p.kind = 'person'`", replace: "`" },
  { id: 'session-ignores-expiry', what: '会话不看期限', file: SESSIONS_SVC, suites: [FEISHU],
    find: 'WHERE s.token_sha256 = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND', replace: 'WHERE s.token_sha256 = ? AND s.revoked_at IS NULL AND ? > 0 AND' },
  { id: 'logout-keeps-session', what: '注销不注销市场会话', file: GATE_ROUTES, suites: [FEISHU],
    find: '    const marketSession = identityService().endSession(cookie);', replace: '    const marketSession = false;' },
  { id: 'disable-keeps-sessions', what: '停用不注销这个人的会话（恢复之后旧会话复活）', file: ROUTES, suites: [FEISHU],
    find: "    if (status === 'disabled') svc<LoginSessionService>('loginSessions').revokeAllFor(id);", replace: '' },
  { id: 'secret-to-userinfo', what: '应用密钥也发给取用户信息那一步', file: FEISHU_PLUGIN, suites: [FEISHU],
    find: "{ method: 'GET', headers: { authorization: `Bearer ${accessToken}` } }", replace: "{ method: 'GET', headers: { authorization: `Bearer ${accessToken}`, 'x-app-secret': cred.secret } }" },
  { id: 'odoo-before-session', what: '两种会话都带着时先认 Odoo（优先顺序反了）', file: IDENTITY, suites: [FEISHU],
    find: "      const fromSession = this.sessionViewer(cookieHeader); // 市场会话不进缓存，每次现查\n      if (fromSession?.ok) { this.noteMismatch(cookieHeader, fromSession.viewer); return fromSession; }\n      const credential = this.credentialOf(cookieHeader);",
    replace: "      const credential = this.credentialOf(cookieHeader);\n      if (!credential) { const fromSession = this.sessionViewer(cookieHeader); if (fromSession?.ok) return fromSession; }" },
  { id: 'mismatch-not-logged', what: '两种会话认出不同的人时不留痕', file: IDENTITY, suites: [FEISHU],
    find: "        if (other.ok && other.viewer.sub !== session.sub) {", replace: '        if (false) {' },
  { id: 'pending-kept-forever', what: '待对接清单不清过期的', file: PRINCIPAL, suites: [FEISHU],
    find: "export const PENDING_DAYS = 30;", replace: 'export const PENDING_DAYS = 3650;' },
  { id: 'disabled-page-differs', what: '停用的人看到的等待页和没对到主体的不一样（透露这个人被停用了）', file: FLOWS, suites: [FEISHU],
    find: "displayName: who.displayName, email: who.email });\n      return holdPage(res);\n    }\n    const session", replace: "displayName: who.displayName, email: who.email });\n      if (admitted.reason === 'disabled') return page(res, 403, '等管理员处理', '账号已停用。');\n      return holdPage(res);\n    }\n    const session" },
  { id: 'auto-bind-over-existing', what: '自动对上时不管那个人是不是已经有别的飞书身份', file: PRINCIPAL, suites: [FEISHU],
    find: ' && !held && !already) {', replace: ' && !held) {' },
  { id: 'session-ignores-binding', what: '会话不核对凭的那条外部身份还绑没绑着', file: SESSIONS_SVC, suites: [FEISHU],
    find: '      JOIN principal_identities i ON i.provider = s.provider AND i.external_id = s.external_id AND i.principal_id = s.principal_id\n', replace: '' },
  { id: 'unbind-keeps-sessions', what: '解绑不注销凭这条身份发出的会话（绑回去之后旧会话复活）', file: ROUTES, suites: [FEISHU],
    find: "    svc<LoginSessionService>('loginSessions').revokeForIdentity(provider, externalId);\n", replace: '' },
  { id: 'auto-bind-without-tenant', what: '没配租户也能打开按邮箱自动对上', file: FEISHU_PLUGIN, suites: [FEISHU],
    find: "  if (autoBind === 'on' && !tenant) throw new Error(", replace: "  if (false) throw new Error(" },
  { id: 'auto-bind-ignores-trust', what: '核心自动对上时不看邮箱是不是来自本组织', file: FLOWS, suites: [FEISHU],
    find: ' && who.email && who.emailTrusted && ', replace: ' && who.email && ' },
  { id: 'outsider-admitted', what: '核心不看「不是本组织的人」，照常对主体、发会话', file: FLOWS, suites: [FEISHU],
    find: '    if (who.outsider) {', replace: '    if (false) {' },
  { id: 'tenant-mismatch-not-flagged', what: '插件租户不符也不标外人', file: FEISHU_PLUGIN, suites: [FEISHU],
    find: '    const outsider = Boolean(config.tenant) && data.tenant_key !== config.tenant;', replace: '    const outsider = false;' },
  // —— 离职即时失效（5c）——
  { id: 'event-signature-unchecked', what: '事件不验签', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return reject(401, 'event_unauthorized');\n", replace: '' },
  { id: 'event-timestamp-unchecked', what: '事件不看时间戳新旧（旧请求能重放）', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "  if (Math.abs(Date.now() / 1000 - Number(ts)) > EVENT_SKEW_S) return reject(401, 'event_unauthorized');\n", replace: '' },
  { id: 'event-token-unchecked', what: '事件不核对 Verification Token', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: " || h.token !== verificationToken || ", replace: ' || ' },
  { id: 'event-app-unchecked', what: '事件不核对 App ID', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: " || h.app_id !== cred.id) return reject(401, 'event_unauthorized');", replace: ") return reject(401, 'event_unauthorized');" },
  { id: 'event-replay-not-deduped', what: '事件不按事件号去重（重放会再处理一次）', file: SESSIONS_SVC, suites: [OFFBOARD],
    find: "      if (!this.firstSeen(flow, eventId, now)) { db.exec('ROLLBACK'); return { seen: true }; }\n", replace: '' },
  { id: 'event-dedupe-outside-tx', what: '先提交事件号再停用（停用出错时事件号不撤回，重推被当成重复跳过）', file: SESSIONS_SVC, suites: [OFFBOARD],
    find: '      const result = work();', replace: "      db.exec('COMMIT'); db.exec('BEGIN IMMEDIATE');\n      const result = work();" },
  { id: 'event-error-leaks', what: '事件接口出错时把内部原因回给对方', file: EVENTS, suites: [OFFBOARD],
    find: "res.status(503).json({ error: 'event_unavailable' });", replace: 'res.status(503).json({ error: String((e as Error)?.message ?? e) });' },
  { id: 'reconcile-unknown-not-listed', what: '对账留痕不列查不清的外部身份（人工复核无从下手）', file: EVENTS, suites: [OFFBOARD],
    find: 'unknown_ids: unknownIds.slice(0, 100), ', replace: '' },
  { id: 'event-updated-any', what: '「员工信息被修改」不看状态一律停用', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "h.event_type === 'contact.user.updated_v3' && gone(object.status)", replace: "h.event_type === 'contact.user.updated_v3'" },
  { id: 'offboard-keeps-sessions', what: '离职停用时不注销会话（恢复之后旧会话复活）', file: EVENTS, suites: [OFFBOARD],
    find: '  if (id) sessions().revokeAllFor(id);\n', replace: '' },
  { id: 'event-other-tenant-processed', what: '配了租户也处理别的租户的事件', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "  if (config.tenant && h.tenant_key !== config.tenant) return { http: 200, body: {}, eventId, offboard: [] };\n", replace: '' },
  { id: 'url-verification-token-unchecked', what: 'URL 校验不看 Token', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "return payload.token === verificationToken && typeof payload.challenge === 'string'", replace: "return typeof payload.challenge === 'string'" },
  { id: 'event-when-off', what: '没打开飞书登录也收事件（不先看这个登录方式收不收）', file: EVENTS, suites: [OFFBOARD],
    find: "if (!FLOW_RE.test(flow) || !identity().flowCapabilities(flow).events) return res.status(401).json({ error: 'event_unauthorized' });", replace: "if (!FLOW_RE.test(flow)) return res.status(401).json({ error: 'event_unauthorized' });\n    if (!identity().flowCapabilities(flow).events) return res.status(200).json({});" },
  { id: 'reconcile-unknown-as-gone', what: '对账把查不清的当成离职', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: '      if (!user) out.unknown.push(id);', replace: '      if (!user) out.gone.push(id);' },
  { id: 'reconcile-error-disables-all', what: '对账时飞书出错就把所有人当离职', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "  if (typeof tenantToken !== 'string' || !tenantToken) return { gone: [], unknown: externalIds };", replace: "  if (typeof tenantToken !== 'string' || !tenantToken) return { gone: externalIds, unknown: [] };" },
  { id: 'event-status-truthy', what: '「员工信息被修改」的状态字段只看真假（字符串 "true" 也算离职）', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: 'return s?.is_resigned === true || s?.is_frozen === true || s?.is_exited === true;', replace: 'return !!(s?.is_resigned || s?.is_frozen || s?.is_exited);' },
  { id: 'event-plaintext-accepted', what: '签名对的明文事件（没有加密）也处理', file: FEISHU_PLUGIN, suites: [OFFBOARD],
    find: "typeof outer?.encrypt === 'string' ? decrypt(encryptKey, outer.encrypt) as Record<string, any> | null : null;", replace: "typeof outer?.encrypt === 'string' ? decrypt(encryptKey, outer.encrypt) as Record<string, any> | null : outer as Record<string, any>;" },
  // —— 角色声明与授予（6b）——
  { id: 'grant-self-unchecked', what: '服务不查自授（只剩库里的约束）', file: GRANT_SVC, suites: [GRANTS],
    find: "    if (actor.principal && actor.principal === g.principal_id) return refuse(403, 'self_grant', '不能给自己授予');\n", replace: '' },
  { id: 'grant-self-db-check', what: '库里不约束起草人不能是被授予的主体', file: DB, suites: [GRANTS],
    find: '  CHECK (created_by_principal IS NULL OR created_by_principal <> principal_id),\n', replace: '' },
  { id: 'grant-owner-unchecked', what: '管理员级的授予谁都能放行', file: GRANT_SVC, suites: [GRANTS],
    find: " && !actor.owner) return refuse(403, 'owner_required',", replace: " && false) return refuse(403, 'owner_required'," },
  { id: 'grant-admin-level-by-id-only', what: '管理员级只认 owner、admin 两个 id（带管理类权限的组织角色漏掉）', file: ROLES, suites: [GRANTS],
    find: "adminLevel: r.id === 'owner' || r.id === 'admin' || kindsIn.has('admin')", replace: "adminLevel: r.id === 'owner' || r.id === 'admin'" },
  // 授予的放行入口（L19 起走 approverOf）
  { id: 'grant-owner-any-admin', what: '放行时管理员登录一律当属主', file: GRANT_ROUTES, suites: [GRANTS],
    find: 'return { by, principal, owner: grants().isOwner(principal), admin: true };', replace: 'return { by, principal, owner: !!principal, admin: true };' },
  { id: 'grant-cli-not-owner', what: '放行时本机命令行不当属主（管理员级的授予没人能放行）', file: GRANT_ROUTES, suites: [GRANTS],
    find: "return { by: 'cli', principal: null, owner: true, admin: true };", replace: "return { by: 'cli', principal: null, owner: false, admin: true };" },
  // 管理面（actorOf）：自定义角色的放行、迁移授予的整批撤销只认属主
  { id: 'grant-admin-owner-any-admin', what: '管理面上管理员登录一律当属主（自定义角色放行、整批撤销）', file: GRANT_ROUTES, suites: [GRANTS],
    find: 'return { by, principal, owner: grants().isOwner(principal) };', replace: 'return { by, principal, owner: !!principal };' },
  { id: 'grant-admin-cli-not-owner', what: '管理面上本机命令行不当属主（自定义角色、整批撤销没人能做）', file: GRANT_ROUTES, suites: [CUSTOM, JUDGE],
    find: "return { by: 'cli', principal: null, owner: true };", replace: "return { by: 'cli', principal: null, owner: false };" },
  { id: 'grant-owner-ignores-revoke', what: '属主身份不看授予状态（撤销了的 owner 还算）', file: GRANT_SVC, suites: [GRANTS],
    find: "return !!principal && this.activeFor(principal, now).some((g) => g.role === 'owner');", replace: "return !!principal && !!db.prepare(\"SELECT 1 FROM grants WHERE principal_id = ? AND role = 'owner' AND approved_by IS NOT NULL\").get(principal);" },
  { id: 'grant-owner-ignores-expiry', what: '属主判断不看期限（过期了的 owner 还算属主）', file: GRANT_SVC, suites: [GRANTS],
    find: "return !!principal && this.activeFor(principal, now).some((g) => g.role === 'owner');", replace: "return !!principal && !!db.prepare(\"SELECT 1 FROM grants WHERE principal_id = ? AND role = 'owner' AND status = 'active'\").get(principal);" },
  { id: 'grant-active-ignores-expiry', what: '判断生效不看期限（只看库里的状态）', file: GRANT_SVC, suites: [GRANTS],
    find: "WHERE principal_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY id\").all(principal, now)", replace: "WHERE principal_id = ? AND status = 'active' AND ? IS NOT NULL ORDER BY id\").all(principal, now)" },
  { id: 'grant-browser-local-is-cli', what: '带浏览器标记的本机请求也当本机命令行（属主）：起草、角色这些管理面', file: GRANT_ROUTES, suites: [GRANTS],
    find: 'if (!browserMarked(req) && rawLoopback(req)) return { by: \'cli\', principal: null, owner: true };', replace: 'if (rawLoopback(req)) return { by: \'cli\', principal: null, owner: true };' },
  { id: 'grant-approver-browser-local-is-cli', what: '带浏览器标记的本机请求也当本机命令行（属主）：授予的读和放行入口（L19）', file: GRANT_ROUTES, suites: [GRANTS],
    find: 'if (!browserMarked(req) && rawLoopback(req)) return { by: \'cli\', principal: null, owner: true, admin: true };', replace: 'if (rawLoopback(req)) return { by: \'cli\', principal: null, owner: true, admin: true };' },
  { id: 'roles-refusal-exits-zero', what: '角色声明不合格时只抛错不退出（被全局兜底接住，进程以 0 结束）', file: INDEX, suites: [GRANTS],
    find: "  console.error(`[grants] 拒绝启动：${String((e as Error)?.message ?? e)}`);\n  process.exit(1);\n", replace: '  throw e;\n' },
  { id: 'grant-no-responsible-unchecked', what: '非人主体不查在职责任人', file: GRANT_SVC, suites: [GRANTS],
    find: "      if (!o || o.kind !== 'person' || o.status !== 'active') return refuse(422, 'no_responsible',", replace: "      if (!o) return refuse(422, 'no_responsible'," },
  { id: 'grant-decide-to-seat', what: '决定类权限也授予给非人主体', file: GRANT_SVC, suites: [GRANTS],
    find: "      if (role.decides) return refuse(422, 'decide_non_person',", replace: "      if (false) return refuse(422, 'decide_non_person'," },
  { id: 'grant-includes-not-expanded', what: '判决定类不展开 includes（经包含带进来的漏掉）', file: ROLES, suites: [GRANTS],
    find: '    for (const inc of r.includes ?? []) out.push(...expand(inc, [...path, id]));\n', replace: '    for (const inc of r.includes ?? []) expand(inc, [...path, id]);\n' },
  { id: 'grant-scope-unchecked', what: '角色里的范围不和授予的比', file: ROLES, suites: [GRANTS],
    find: "  return inner === undefined || inner === 'self' || outer === '*' || inner === outer;", replace: '  return true;' },
  { id: 'grant-forward-only-relaxed', what: '库里允许生效退回待核', file: DB, suites: [GRANTS],
    find: "OR (OLD.status = 'active' AND NEW.status IN ('revoked','expired')))", replace: "OR (OLD.status = 'active' AND NEW.status IN ('revoked','expired','pending')))" },
  { id: 'grant-fields-mutable', what: '库里允许改授予的角色和范围', file: DB, suites: [GRANTS],
    find: 'OR NEW.role IS NOT OLD.role OR NEW.scope IS NOT OLD.scope', replace: 'OR 0' },
  { id: 'grant-not-expired', what: '到期的不标过期', file: GRANT_SVC, suites: [GRANTS],
    find: "    for (const { id } of due) if (this.move(id, ['active'], 'expired', 'expire',", replace: "    for (const { id } of due.slice(0, 0)) if (this.move(id, ['active'], 'expired', 'expire'," },
  { id: 'roles-platform-overridable', what: '外部声明能覆盖平台角色（同名不拒）', file: ROLES, suites: [GRANTS],
    find: "    if (platformIds.has(r.id) || platformNames.has(r.name)) {\n", replace: "    if (false) {\n" },
  { id: 'roles-unknown-action-ok', what: '角色引用不存在的动作也放行', file: ROLES, suites: [GRANTS],
    find: '    for (const p of r.permissions) for (const a of p.actions ?? []) if (!catalog.has(a)) fail(', replace: '    for (const p of r.permissions) for (const a of p.actions ?? []) if (false) fail(' },
  // —— 判定的并行比对（6c）——
  { id: 'compare-default-on', what: '比对缺省开', file: COMPARE, suites: [JUDGE],
    find: "return { on: raw === 'on', out: out || null, tagSteps: env.NODE_ENV === 'test' };", replace: "return { on: raw !== 'off', out: out || null, tagSteps: env.NODE_ENV === 'test' };" },
  { id: 'compare-judges-404', what: '404 也判（把藏起来的「没权限」当成允许或拒绝）', file: COMPARE, suites: [JUDGE],
    find: "  if (status === 404) return 'skip-404';\n", replace: '' },
  { id: 'compare-uncertain-as-allow', what: '400 这类当成允许', file: COMPARE, suites: [JUDGE],
    find: "  if (status >= 200 && status < 400) return 'allow';", replace: "  if (status >= 200 && status < 500) return 'allow';" },
  { id: 'compare-migrates-again', what: '迁移不看迁没迁过（撤掉的会被补回来）', file: GRANT_SVC2, suites: [JUDGE],
    find: "      if (db.prepare(\"SELECT 1 FROM grants WHERE principal_id = ? AND role = ? AND source = 'migration'\").get(principal, role)) { db.exec('ROLLBACK'); return null; }", replace: "      if (db.prepare(\"SELECT 1 FROM grants WHERE principal_id = ? AND role = ? AND source = 'migration' AND status = 'active'\").get(principal, role)) { db.exec('ROLLBACK'); return null; }" },
  { id: 'compare-records-real-path', what: '比对记录记实际路径（带查询串和 id）', file: COMPARE, suites: [JUDGE],
    find: '    const pattern = `${req.method} ${String(route.path)}`;', replace: '    const pattern = `${req.method} ${req.originalUrl}`;' },
  { id: 'compare-error-uncaught', what: '判定出错不接住（抛到进程里）', file: COMPARE, suites: [JUDGE],
    find: "    const result = judge({ actor, action: spec.action, kind: spec.kind, declared: true });", replace: "    let result; try { result = judge({ actor, action: spec.action, kind: spec.kind, declared: true }); } catch (e) { setImmediate(() => { throw e; }); return; }" },
  { id: 'compare-actor-after-response', what: '身份在应答之后才认（改口令的请求认错人）', file: COMPARE, suites: [JUDGE],
    find: "    const { actor, admin } = await actorAtStart;", replace: "    const { actor, admin } = await actorOf(req);" },
  // —— 判定比对的登记（6c 第二轮）：改了放行范围却没改登记，零不一致门槛就红 ——
  { id: 'builtin-anon-missing-read', what: '匿名清单漏了一个今天开放的读面', file: BUILTINS_FILE, suites: [ZERO, SWEEP],
    find: "  'setting.read',\n  'skill.list',\n", replace: "  'setting.read',\n" },
  // —— 6c 验收 M1：按身份 × 路由铺满才抓得到的清单漂移 ——
  { id: 'local-page-own-list', what: '本机页面另抄一份短清单，不由匿名的推出来', file: BUILTINS_FILE, suites: [SWEEP],
    find: "    actions: [...new Set([...ANONYMOUS_ACTIONS, 'admin-token.first-set'])].sort(),", replace: "    actions: ['admin-token.first-set', 'admin-token.state', 'agent-card.read', 'design-token.read']," },
  { id: 'anonymous-floor-dropped', what: '登录的人判不过时不按匿名兜底（匿名能做的，只有访客授予的人反而不能）', file: JUDGE_FILE, suites: [PRESETS],
    find: "  if (ANONYMOUS_ACTIONS.includes(action)) return { verdict: 'allow', rule: 'anonymous-floor' };\n", replace: '' },
  { id: 'narrowed-observation-dropped', what: '门户观测状态不再只认口令（迁移出来的 admin 能读）', file: BUILTINS_FILE, suites: [SWEEP],
    find: "  { action: 'content.observation', only: ['admin-token'],", replace: "  { action: 'content.observation-off', only: ['admin-token']," },
  { id: 'revoke-migration-for-admins', what: '整批撤销迁移授予放给管理口令（处理函数只认属主）', file: BUILTINS_FILE, suites: [SWEEP],
    find: "  { action: 'grant.revoke-migration', only: ['owner', 'local-cli'],", replace: "  { action: 'grant.revoke-migration', only: ['owner', 'local-cli', 'admin-token']," },
  // —— 角色预设：两处有意的改变、迁移和口令的原样、授予的规则、自定义角色的放行 ——
  { id: 'sysadmin-sees-business', what: '系统管理员的读写不圈在系统域里（默认看得到业务数据）', file: ROLES, suites: [PRESETS],
    find: "permissions: [{ kinds: ['read', 'write', 'admin'], domains: [...SYSTEM_DOMAINS] }, { kinds: ['admin'] }] },", replace: "permissions: [{ kinds: ['read', 'write', 'admin'] }] }," },
  { id: 'management-has-admin', what: '管理层也有管理类', file: ROLES, suites: [PRESETS],
    find: "{ id: 'management', name: '管理层', permissions: [{ kinds: ['read', 'write', 'decide'] }, { actions: ['cockpit.create', 'cockpit.update', 'cockpit.delete'] }] },", replace: "{ id: 'management', name: '管理层', permissions: [{ kinds: ['read', 'write', 'decide', 'admin'] }, { actions: ['cockpit.create', 'cockpit.update', 'cockpit.delete'] }] }," },
  { id: 'token-sysadmin-only', what: '管理口令只照系统管理员算（今天口令能看的业务数据，新判定拒绝）', file: BUILTINS_FILE, suites: [PRESETS, SWEEP],
    find: "roles: ['admin', 'management'],", replace: "roles: ['admin']," },
  { id: 'migration-adds-management', what: '比对迁移又自动给现有管理员管理层（团队分配、认领直接落、数据视图跟着放宽，L6）', file: COMPARE, suites: [JUDGE],
    find: "    if (admin) grants().migrate(actor.id, 'admin', ", replace: "    if (admin) grants().migrate(actor.id, 'management', '');\n    if (admin) grants().migrate(actor.id, 'admin', " },
  { id: 'guest-without-expiry', what: '访客的授予可以没有期限', file: GRANT_SVC, suites: [PRESETS],
    find: "    if (EXPIRY_REQUIRED_ROLES.includes(g.role) && (g.expires_at === null || g.expires_at === undefined)) return refuse(", replace: "    if (false) return refuse(" },
  { id: 'ai-staff-to-person', what: 'AI 员工也能授予人', file: GRANT_SVC, suites: [PRESETS],
    find: "    if (NON_PERSON_ONLY_ROLES.includes(g.role) && p.kind === 'person') return refuse(", replace: "    if (false) return refuse(" },
  { id: 'domain-unclassified', what: '业务域清单漏了一个域（两边都不算）', file: ROLES, suites: [PRESETS],
    find: "'sop-run', 'summary', 'task-center',", replace: "'sop-run', 'task-center'," },
  { id: 'custom-approve-by-admin', what: '自定义角色的放行不核属主（口令管理员也能放行）', file: GRANT_ROUTES, suites: [CUSTOM],
    find: "    if (!actor.owner) return res.status(403).json({ error: 'owner_required', message: '带管理类或决定类权限的自定义角色只有属主能放行' });\n", replace: '' },
  { id: 'custom-pending-skipped', what: '口令管理员建带决定类的自定义角色直接生效（不等属主放行）', file: GRANT_ROUTES, suites: [CUSTOM],
    find: "    const pending = (shape.adminLevel || shape.decides || shape.business) && !actor.owner;", replace: "    const pending = false;" },
  { id: 'custom-ai-decide', what: '从 AI 员工复制出来的能加决定类', file: GRANT_ROUTES, suites: [CUSTOM],
    find: "    if (customRoles().descendsFrom(id, 'ai-staff') && shape.decides) return res", replace: "    if (false) return res" },
  { id: 'custom-ai-decide-one-level', what: '从 AI 员工复制的只看一层来源（复制两层就能加决定类）', file: GRANT_ROUTES, suites: [CUSTOM],
    find: "    if (customRoles().descendsFrom(id, 'ai-staff') && shape.decides) return res", replace: "    if (cur.based_on === 'ai-staff' && shape.decides) return res" },
  { id: 'custom-delete-in-use', what: '有授予在用的自定义角色也能删', file: GRANT_ROUTES, suites: [CUSTOM],
    find: "    if (using.length) return res.status(409)", replace: "    if (false) return res.status(409)" },
  { id: 'builtin-cli-extra', what: '本机命令行清单多列了一个今天要口令的管理面', file: BUILTINS_FILE, suites: [ZERO],
    find: "      'auth.me',\n      'cockpit.create',\n", replace: "      'auth.me',\n      'binding.list',\n      'cockpit.create',\n" },
  { id: 'acts-for-owner-dropped', what: '去掉「口令代属主行事」的登记', file: BUILTINS_FILE, suites: [ZERO],
    find: "      'attention.answer',\n      'change-request.approve',\n      'change-request.reject',\n      'mcp.access-approve',\n      'mcp.access-reject',\n", replace: '' },
  { id: 'integrity-not-separate', what: '被完整性门拦下的不单列，拿去和判定比', file: COMPARE, suites: [ZERO, JUDGE],
    find: "    if (old === 'deny' && crossMarked(req)) {", replace: "    if (false && old === 'deny' && crossMarked(req)) {" },
  { id: 'not-verdict-ignored', what: '不看「状态码不代表授权」的声明', file: COMPARE, suites: [ZERO, JUDGE],
    find: "    if (spec.statusNotVerdict) {", replace: "    if (false && spec.statusNotVerdict) {" },
  { id: 'refine-ignored', what: '不看路由按请求细分的动作', file: COMPARE, suites: [ZERO, JUDGE],
    find: "    const refined = declared?.refine?.find(", replace: "    const refined = undefined && declared?.refine?.find(" },
  { id: 'local-page-any-origin', what: '本机页面不看 Origin 是不是本站', file: COMPARE, suites: [ZERO],
    find: "      if (sameSiteOrigin(req)) return { actor: { type: 'builtin', name: 'local-page' }, admin: false };", replace: "      return { actor: { type: 'builtin', name: 'local-page' }, admin: false };" },
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

// 每一套在自己的进程组里跑（detached）。套件结束之后（包括超时、自己崩了、没收好它起的实例），把整组收掉，
// 确认都退出了再删副本：不然实例还在往副本里写，删目录会撞上（ENOTEMPTY）
const groups = new Set();
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
async function reap(pgid) {
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* 组里已经没有进程了 */ }
  for (let i = 0; i < 100 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 50));
  if (groupAlive(pgid)) console.warn(`  ⚠ 进程组 ${pgid} 5 秒内没退干净（不影响结果）`);
  groups.delete(pgid);
}
process.on('exit', () => { for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* 已退出 */ } } });
/** 删副本：带重试；还是删不掉只打一行警告，不把检查全过的结果改成失败 */
function removeTree(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { console.warn(`  ⚠ 临时目录没删干净（不影响结果）：${dir}：${e?.code ?? e?.message ?? e}`); }
}

// 跑的是副本里的脚本：夹具也在副本里，改坏夹具的变体才作数
const run = (script, tree) => new Promise((done) => {
  const child = spawn(process.execPath, [join(tree, 'scripts', script), '--root', tree], { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  groups.add(child.pid);
  const out = [], err = [];
  child.stdout.on('data', (b) => out.push(b));
  child.stderr.on('data', (b) => err.push(b));
  // 超时：整组杀掉（不只是套件本身）
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } }, 5 * 60 * 1000);
  child.on('close', (code) => {
    clearTimeout(timer);
    const r = { status: typeof code === 'number' ? code : null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
    reap(child.pid).then(() => done(r));
  });
});
const failedLines = (r) => r.stdout.split('\n').filter((l) => l.trim().startsWith('✗')).map((l) => l.trim().slice(2).split('（')[0].split(' → ')[0]);
/** 脚本自己没跑成（实例没起来、超时、崩了），不是「有检查没过」：这种不算变红 */
const broken = (r) => r.status !== 0 && (r.status !== 1 || failedLines(r).length === 0 || r.stdout.includes('没跑完'));
/** 没跑成（实例没起来、超时，多半是机器忙）就再跑，最多共 3 次；都没跑成，交给调用方当作失败 */
async function runTwice(script, tree) {
  let r = await run(script, tree);
  for (let i = 1; i < 3 && broken(r); i++) r = await run(script, tree);
  return r;
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
removeTree(OUT);
try {
  // 绿：没改过的副本，两套都过。先证明「抄一份」这件事本身不会把测试弄红。
  const clean = plant('unchanged', null);
  for (const script of [CONTRACT, SERVICE, FOLD, SMOKE, FEISHU, OFFBOARD, GRANTS, JUDGE, ZERO]) {
    const r = await runTwice(script, clean);
    note(r.status === 0, `没改过的副本：${script} 通过`, r.status === 0 ? '' : tailOf(r));
  }
  removeTree(clean);
  // 红：每个变体，指定的每一套都必须失败，并且是因为有检查没过（不是脚本自己没跑成）
  const results = await pool(SELECTED, JOBS, async (m) => {
    const tree = plant(m.id, m);
    const runs = [];
    for (const script of m.suites) runs.push({ script, r: await runTwice(script, tree) });
    removeTree(tree);
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
  removeTree(OUT);
}
console.log(bad ? `identity-seam-mutation: ${bad} 处不符合预期（有变体没被抓住，或者没改过的副本不绿）` : `identity-seam-mutation: ${SELECTED.length} 个变体全部被抓住，没改过的副本全绿${ONLY ? `（只跑了点名的，共 ${MUTANTS.length} 个）` : ''}`);
process.exit(bad ? 1 : 0);
