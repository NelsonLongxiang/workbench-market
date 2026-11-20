/**
 * 一人一助理第 1 期补充用例对应的变异：**草稿**，开工时并进 scripts/identity-seam-mutation.mjs 的变异表。
 *
 * 每一条的 find 是第 1 期实现里要写成的那一行守卫（写法照这里，实现时以实际代码为准，改 find 跟上）。
 * 现在的 main 上这些行还不存在，锚点核对不过是预期的；PR 1、PR 3 实现之后要满足：每条锚点只命中一处，变异后对应用例变红。
 * 形状和 identity-seam-mutation.mjs 的变异表一致：{ id, what, file, suites, find, replace }。
 */
const GRANT = 'server/src/services/grant.ts', DB = 'server/src/db.ts', JUDGE = 'server/src/judgment.ts';
const IDENT = 'assistant-identity-extra-test.mjs', CONFIRM = 'assistant-confirm-extra-test.mjs';

export const ASSISTANT_PHASE1_MUTANTS = [
  // —— PR 1 · 助理主体 ——
  { id: 'assistant-grant-rule-removed', what: 'A7a/A7d/A7e：check() 里不拦助理（只剩触发器兜底，拒绝码变了）', file: GRANT, suites: [IDENT],
    find: "    if (isAssistant(g.principal_id)) return refuse(422, 'assistant_no_grants',", replace: "    if (false) return refuse(422, 'assistant_no_grants'," },
  { id: 'assistant-grant-rule-after-area', what: 'A7a 次序：助理那一条挪到 area: 核对之后，不存在的 area: 先回 area_unknown', file: GRANT, suites: [IDENT],
    // 实现时：把 check() 第一行的助理判断删掉，原样插到 area: 核对那一段之后；工具不支持跨位置挪，开工时写成两条 find/replace（删、插）或改用 plant 的自定义函数
    find: "    if (isAssistant(g.principal_id)) return refuse(422, 'assistant_no_grants',", replace: "    if (false && isAssistant(g.principal_id)) return refuse(422, 'assistant_no_grants'," },
  { id: 'grants-no-assistant-trigger-removed', what: 'A7b：去掉授予表上拒绝助理的触发器', file: DB, suites: [IDENT],
    find: 'CREATE TRIGGER IF NOT EXISTS grants_no_assistant BEFORE INSERT ON grants', replace: 'CREATE TRIGGER IF NOT EXISTS grants_no_assistant_off BEFORE INSERT ON grants_never' },
  { id: 'migrate-any-kind', what: "A7c：migrate() 不看 kind = 'person'", file: GRANT, suites: [IDENT],
    find: "    if (!p || p.kind !== 'person' || p.status !== 'active') return null;\n    const actor = { by: 'system:migration', principal: null };", replace: "    if (!p || p.status !== 'active') return null;\n    const actor = { by: 'system:migration', principal: null };" },
  { id: 'principal-kind-mutable', what: 'A23：去掉「kind 建好就不能改」的触发器', file: DB, suites: [IDENT],
    find: 'CREATE TRIGGER IF NOT EXISTS principal_kind_fixed BEFORE UPDATE ON principals', replace: 'CREATE TRIGGER IF NOT EXISTS principal_kind_fixed_off BEFORE UPDATE ON principals_never' },
  { id: 'judge-assistant-borrows-owner', what: 'A24：判定在主体是助理时改查责任人的授予', file: JUDGE, suites: [IDENT],
    find: "  if (actor.kind === 'assistant') return { verdict: 'deny', rule: 'assistant-no-grants', grant: null };", replace: "  if (actor.kind === 'assistant') actor = { ...actor, id: actor.owner, kind: 'person' };" },
  { id: 'area-migrate-any-kind', what: 'A25：部门 → 领域迁移去掉只看人的条件（入口等领域第 1 步 PR3 定形后改锚点）', file: 'server/src/services/area.ts', suites: [IDENT],
    find: "p.kind = 'person'", replace: '1 = 1' },
  { id: 'team-lead-any-kind', what: 'A26：团队负责人不核「启用的人」', file: 'server/src/services/team.ts', suites: [IDENT],
    find: "    if (!this.personActive(principal)) return refuse(422, 'lead_not_person',", replace: "    if (false) return refuse(422, 'lead_not_person'," },
  { id: 'names-any-kind', what: 'A27（回归守护）：名字解析去掉 kind = person', file: 'server/src/attention-names.ts', suites: ['attention-names 的用例（PR 1 时补）'],
    find: "    if (!p || p.kind !== 'person' || p.status !== 'active') return null;\n    const sees", replace: "    if (!p || p.status !== 'active') return null;\n    const sees" },

  // —— PR 3 · 确认门 ——
  { id: 'confirm-ignores-renewed-session', what: 'C27：确认门认人不用续期之后的会话（改成只认请求进来时的旧 cookie 记录）', file: 'server/src/confirm-gate.ts', suites: [CONFIRM],
    find: '  const who = await identity().resolveCaller(cookieHeader);', replace: "  const who = { ok: false, http: 401, error: 'stale' } as const;" },
  { id: 'confirm-page-skips-login-next', what: 'C28：确认页不走登录门的 next（没登录时直接 401，不送去登录页）', file: 'server/src/index.ts', suites: [CONFIRM],
    find: "app.get('/assistant/confirm/:id', loginGate.page,", replace: "app.get('/assistant/confirm/:id'," },
  { id: 'confirm-read-skips-origin-check', what: 'C29：读接口只核写、不核来源', file: 'server/src/routes/assistant.ts', suites: [CONFIRM],
    find: '    if (!sameSiteOnly(req, res)) return; // 读也核来源', replace: '    // 读不核来源' },
];
