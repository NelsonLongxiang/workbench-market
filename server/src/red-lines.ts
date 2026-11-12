/**
 * 红线清单（角色预设 ②）：不管谁、不管授了什么角色都越不过去的规则。界面上「谁能做什么」的页面列出来给人看，
 * 读接口 GET /api/access/red-lines 原样给出。
 *
 * 每一条都写清：规则是什么、在代码里哪儿管着、哪一个对抗组的哪一项盯着它。盯着它的那一项的标题里带 `[red-line:<id>]`，
 * scripts/red-lines-test.mjs 核对每一条都找得到（找不到 CI 红）：新加红线要同时加对抗例，删红线要说清为什么。
 * 这里只列「市场自己管着」的；节点那边的规矩（凭据、跑在哪个系统用户）不在这里。
 */
export type RedLine = {
  /** 稳定的标识（小写字母、数字、连字符），对抗例的标题里引用它 */
  id: string;
  /** 一句话：给人看的规则 */
  title: string;
  /** 补一句：为什么，或者边界在哪 */
  detail: string;
  /** 在代码里哪儿管着（文件，给评审看） */
  enforced_in: string;
  /** 盯着它的对抗组脚本 */
  test: string;
};

export const RED_LINES: readonly RedLine[] = [
  {
    id: 'no-self-grant', title: '不能给自己授予',
    detail: '起草、提交、放行的人都不能是被授予的主体；库里也有约束。',
    enforced_in: 'server/src/services/grant.ts、server/src/db.ts', test: 'scripts/grants-smoke.mjs',
  },
  {
    id: 'owner-approves-admin-grants', title: '管理员级的授予只有属主能放行',
    detail: '属主、系统管理员，或者权限里带管理类的角色；口令管理员、不是属主的管理员都放行不了。',
    enforced_in: 'server/src/services/grant.ts', test: 'scripts/grants-smoke.mjs',
  },
  {
    id: 'decide-person-only', title: '决定只认人',
    detail: '带决定类权限的角色不授予给不是人的主体（席位、AI 员工、系统）；不是人的做决定一律转成先问人。',
    enforced_in: 'server/src/services/grant.ts、server/src/judgment.ts', test: 'scripts/grants-smoke.mjs',
  },
  {
    id: 'non-person-needs-responsible', title: '不是人的主体要有在职的责任人',
    detail: '席位、AI 员工这类主体，责任人不存在或停用了就不能被授予。',
    enforced_in: 'server/src/services/grant.ts', test: 'scripts/grants-smoke.mjs',
  },
  {
    id: 'guest-needs-expiry', title: '访客的授予必须有期限',
    detail: '没写期限的访客授予起草不了。',
    enforced_in: 'server/src/services/grant.ts', test: 'scripts/role-presets-test.mjs',
  },
  {
    id: 'ai-staff-non-person-only', title: 'AI 员工这个角色只授予不是人的主体',
    detail: '给人授 AI 员工会被拒；人要的权限用别的预设。',
    enforced_in: 'server/src/services/grant.ts', test: 'scripts/role-presets-test.mjs',
  },
  {
    id: 'ai-copies-no-decide', title: '从 AI 员工复制出来的角色不能带决定类权限',
    detail: '复制几层都算（沿来源链判），删掉中间一层也不断。',
    enforced_in: 'server/src/routes/grants.ts、server/src/services/custom-role.ts', test: 'scripts/custom-roles-smoke.mjs',
  },
  {
    id: 'custom-roles-owner-approval', title: '带来管理类或决定类权限的自定义角色要属主放行',
    detail: '建的先待核，改的先记成提议；放行之前不能授予。',
    enforced_in: 'server/src/routes/grants.ts', test: 'scripts/custom-roles-smoke.mjs',
  },
  {
    id: 'business-roles-owner-approval', title: '碰业务的自定义角色要属主放行',
    detail: '系统管理员缺省看不到业务数据，也不能自己复制、改出一个带业务权限的角色转给别人：建的先待核、改的先记成提议，属主放行之前不生效。',
    enforced_in: 'server/src/routes/grants.ts、server/src/roles.ts', test: 'scripts/custom-roles-smoke.mjs',
  },
  {
    id: 'business-grants-business-approval', title: '带业务写的授予要管理层或属主放行',
    detail: '角色带业务域的写（普通员工那几个提需求的写除外），授给人或席位要业务侧放行：只有系统管理员身份的、管理口令放行不了。普通员工、访客照旧由系统管理员一步完成。',
    enforced_in: 'server/src/services/grant.ts、server/src/roles.ts', test: 'scripts/grants-smoke.mjs',
  },
  {
    id: 'system-admin-no-business', title: '系统管理员缺省看不到业务数据',
    detail: '系统管理员只有系统域的读写管，业务域（事项、工作台数据、关注……）要另外授予。',
    enforced_in: 'server/src/roles.ts', test: 'scripts/role-presets-test.mjs',
  },
  {
    id: 'settings-no-secret-values', title: '设置的出口不带凭据类的值',
    detail: '设置读、导出、改设置的应答里，令牌、密码、密钥只说有没有；启动时自检，漏了拒绝启动。',
    enforced_in: 'server/src/settings-view.ts、server/src/index.ts', test: 'scripts/settings-read-smoke.mjs',
  },
  {
    id: 'export-reveal-admin-only', title: '导出真值只给管理员',
    detail: '带 reveal 的导出要管理口令或管理员登录（浏览器来的要同源）；不满足 403，不降级成掩码。',
    enforced_in: 'server/src/routes/export-import.ts', test: 'scripts/export-reveal-smoke.mjs',
  },
];
