# 归档

不再随代码维护、或已被别的文档取代的文档放在这里。原则（属主 2026-11-18）：删除不是首选，先考虑同类合并和归档，历史时间线要能还原。

- 归档的文档**原文不改**，只在开头加一行状态：已归档、日期、原因、被哪篇取代（有的话）、原位置。要核原文：去掉前两行，和归档前的提交逐字相同。
- 原位置留一个一行的占位文件指到这里，旧的 PR 和外部链接点进去还能找到；仓库内的引用改到新位置。
- 合并：几篇同一主题的合成一篇，合并后的那篇开头写「由哪几篇合并而来、日期」，并进去的段落注明出处；被并掉的原文照样归档。
- 下面这张表按时间记每一步。表加 git 历史，就能还原「当时是怎么想的、后来为什么变了」。

## 时间线

| 日期 | 文档（原位置） | 动作 | 去向 | 原因 | 相关 PR 或裁定 |
|---|---|---|---|---|---|
| 2026-11-18 | `docs/verifier-v69-portal-chain.md` | 归档 | [`docs/archive/verifier-v69-portal-chain.md`](verifier-v69-portal-chain.md)；取代：scripts/gen-verifier.mjs（现行判据） | 开发验证器 v69 的判据钉位迁移记录；迁移已经做完，后面的 v69.3～v69.6 依次接着改 | — |
| 2026-11-18 | `docs/verifier-v693-masked-import.md` | 归档 | [`docs/archive/verifier-v693-masked-import.md`](verifier-v693-masked-import.md)；取代：scripts/gen-verifier.mjs（现行判据） | 开发验证器 v69.3 的判据钉位迁移记录；迁移已经做完 | — |
| 2026-11-18 | `docs/verifier-v694-design-tokens.md` | 归档 | [`docs/archive/verifier-v694-design-tokens.md`](verifier-v694-design-tokens.md)；取代：scripts/gen-verifier.mjs（现行判据） | 开发验证器 v69.4 的判据钉位迁移记录；迁移已经做完 | — |
| 2026-11-18 | `docs/verifier-v695-dashboard.md` | 归档 | [`docs/archive/verifier-v695-dashboard.md`](verifier-v695-dashboard.md)；取代：scripts/gen-verifier.mjs（现行判据） | 开发验证器 v69.5 的判据钉位迁移记录；迁移已经做完 | — |
| 2026-11-18 | `docs/verifier-v696-css.md` | 归档 | [`docs/archive/verifier-v696-css.md`](verifier-v696-css.md)；取代：scripts/gen-verifier.mjs（现行判据） | 开发验证器 v69.6 的判据钉位迁移记录；迁移已经做完 | — |
| 2026-11-18 | `docs/stub-declaration-template.md` | 归档 | [`docs/archive/stub-declaration-template.md`](stub-declaration-template.md) | 评审席时期（PR #49）的替身声明模板；现在没有流程要求填它 | PR #49 |
| 2026-11-18 | `docs/market-foreground-adapter.md` | 归档 | [`docs/archive/market-foreground-adapter.md`](market-foreground-adapter.md) | 前台托管方案的草案，没有实现、没有部署，代码里没有它 | — |
| 2026-11-18 | `docs/sso2-contract-v2.md` | 归档 | [`docs/archive/sso2-contract-v2.md`](sso2-contract-v2.md)；取代：docs/local-accounts.md | SSO v2 设计材料，停在待评审（2026-10-28）没有实现；登录的目标形态后来定为站内账号（属主 2026-11-16） | #221；属主 11-16 裁定 |
| 2026-11-18 | `docs/a2a-plugin-integration.md` | 归档 | [`docs/archive/a2a-plugin-integration.md`](a2a-plugin-integration.md)；取代：docs/productization/07-a2a-adapter-refactor.md 与阶段七的实现 | 2026-10-23 的调查，文中已写明不再随代码更新 | 阶段七 |
| 2026-11-18 | `docs/skill-market-plan.md` | 归档 | [`docs/archive/skill-market-plan.md`](skill-market-plan.md)；取代：skills/（现行用法） | 技能市场的早期实施方案；技能市场已经做出来 | — |
| 2026-11-18 | `docs/sop-state-durability-337-338.md` | 归档 | [`docs/archive/sop-state-durability-337-338.md`](sop-state-durability-337-338.md) | #337、#338 的实现说明；两个 issue 已关、实现已合 | #337 #338 |
| 2026-11-18 | `docs/explicit-script-targets-341.md` | 归档 | [`docs/archive/explicit-script-targets-341.md`](explicit-script-targets-341.md) | #341 的实现说明；issue 已关、实现已合 | #341 |
| 2026-11-18 | `docs/redis-ready-recovery-351.md` | 归档 | [`docs/archive/redis-ready-recovery-351.md`](redis-ready-recovery-351.md) | #351 的实现说明；issue 已关、实现已合 | #351 |
| 2026-11-18 | `docs/sop309-phase1-list-privacy.md` | 归档 | [`docs/archive/sop309-phase1-list-privacy.md`](sop309-phase1-list-privacy.md) | #309 第一段的实现说明；issue 已关、实现已合 | #309 |
| 2026-11-18 | `docs/sop309-phase1-boundaries.drawio` | 归档 | [`docs/archive/sop309-phase1-boundaries.drawio`](sop309-phase1-boundaries.drawio) | #309 第一段的边界图，配套上一篇 | #309 |
| 2026-11-18 | `docs/sop309-phase2-read-auth.md` | 归档 | [`docs/archive/sop309-phase2-read-auth.md`](sop309-phase2-read-auth.md) | #309 第二段的实现说明；已经 #312 合入，代码在 server/src/sop-read-auth.ts、server/src/sop-run-access.ts | #309 #312 |
| 2026-11-18 | `docs/execution-origin-isolation-plan-288.md` | 归档 | [`docs/archive/execution-origin-isolation-plan-288.md`](execution-origin-isolation-plan-288.md) | 生命周期写面的实施方案（修订稿）；属主 2026-11-10 定生命周期是观测层、不在公开仓，这一篇不再在本仓推进 | #288；属主 11-10 裁定 |
| 2026-11-18 | `docs/workbench-market-arch-sources.md` | 归档 | [`docs/archive/workbench-market-arch-sources.md`](workbench-market-arch-sources.md)；取代：docs/productization/08-technical-route.md、docs/productization/10-boundary-and-norms.md | 2026-11-05～11-06 钉在当时提交上的架构图来源说明 | — |
| 2026-11-18 | `docs/workbench-market-arch.drawio` | 归档 | [`docs/archive/workbench-market-arch.drawio`](workbench-market-arch.drawio)；取代：docs/productization/08-technical-route.md、docs/productization/10-boundary-and-norms.md | 2026-11-05～11-06 钉在当时提交上的可编辑架构图，配套上一篇 | — |
| 2026-11-18 | `docs/tenant-boundary-review.md` | 归档 | [`docs/archive/tenant-boundary-review.md`](tenant-boundary-review.md)；取代：docs/productization/08-technical-route.md | 2026-10-25 的多租户边界评审件；路线后来定为「一个组织一个实例」，不做一库多租户（产品化 08 不做清单） | 产品化 08 |
| 2026-11-18 | `docs/productization/04-dsh-gui-relationship.md` | 归档 | [`docs/archive/productization/04-dsh-gui-relationship.md`](productization/04-dsh-gui-relationship.md)；取代：docs/productization/06-a2a-superagent-fusion.md「一之三」 | 前提是人在 DSH Web GUI 和市场之间切换；属主 2026-11-11 定「人只用市场」 | 属主 11-11 裁定 |
| 2026-11-18 | `docs/productization/14-team-and-assignment.md` | 合并（并入第 15 篇）后归档 | [`docs/archive/productization/14-team-and-assignment.md`](productization/14-team-and-assignment.md)；取代：docs/productization/15-two-layer-org.md（第八节） | 两层组织（属主 2026-11-17）改掉了部门、负责人、成员分给员工这套；仍然成立的四节已并进第 15 篇 | #819；属主 11-17 裁定 |
| 2026-11-18 | `docs/productization/15-two-layer-org.md` | 合并（14 的四小节并入第八节） | 原位置不变 | 14 仍然成立的：卡住的事往上冒、改派、数字从事项来、编制变更由市场提节点确认 | #819；属主 11-17 裁定 |

## 这一批没动、以后再处理的

- `design-system/workbench-market/MASTER.md`：原计划并进 `PATTERNS.md`。但开发验证器（`scripts/gen-verifier.mjs` 判据 33、44、45，`scripts/make-submission.mjs`）钉着这个文件的路径和两个色值，挪走会让验证器失败，等验证器的判据改了再并。
- Odoo 三篇（`docs/odoo-browser-origin.md`、`docs/odoo-login-relay.md`、`docs/odoo-operator-setup.md`）：等 Odoo 全面下线（#823）合并之后归档。
- `docs/productization/README.md` 里指向 04、14 的链接、第 12 篇：#825 正在改它们，那边合并之后再改到新位置；在那之前，原路径的占位文件指到归档。
