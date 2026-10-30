# skills 目录（仓库内技能源）

市场自有技能的**仓库内单一事实源**——发布链以此为准（`.agents/skills` 为本机装载面·两处同步）。

| 技能 | 用途 |
|---|---|
| wm-usage | 如何使用市场（用户视角 5 分钟）|
| wm-quickstart | 快速开始构建（builder 视角 15 分钟）|
| wm-market-guide | 深度参考（25 工具全景/token/坑）|

## 市场技能聚合（三源·`node scripts/skill-import.mjs` 幂等重跑=漂移自动升版）

| 源（环境变量覆盖） | slug 前缀 | 层 | 说明 |
|---|---|---|---|
| `~/.agents/skills`（`SKILL_SRC_A`） | `agents:` | 5 AI 原生运营 | 用户装载面 |
| `~/.dsh/skills`（`SKILL_SRC_C`） | `dsh:` | 2 开发运维 | DSH 平台技能（2026-10-30 起·WM-SKILL-SRC-LAYER-1） |
| `jf-tech-expert-agents`（`SKILL_SRC_B`） | `jf:` | 1 业务角色 | 遗产只登记不快照 |

无 frontmatter 目录跳过并记 `tmp/skill-import-report.json`；设 `DATA_DIR` 可隔离试跑（快照随 DATA_DIR 落位，不碰产库）。冒烟：`node scripts/skill-import-smoke.mjs`（隔离实例 15 判据）。

## 更新流程
1. 改本目录 → PR → 合并
2. 同步 `.agents/skills/<name>`（本机装载）
3. `node scripts/skill-import.mjs` 入市场库
