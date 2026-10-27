# skills 目录（仓库内技能源）

市场自有技能的**仓库内单一事实源**——发布链以此为准（`.agents/skills` 为本机装载面·两处同步）。

| 技能 | 用途 |
|---|---|
| wm-usage | 如何使用市场（用户视角 5 分钟）|
| wm-quickstart | 快速开始构建（builder 视角 15 分钟）|
| wm-market-guide | 深度参考（25 工具全景/token/坑）|

## 更新流程
1. 改本目录 → PR → 合并
2. 同步 `.agents/skills/<name>`（本机装载）
3. `node scripts/skill-import.mjs` 入市场库
