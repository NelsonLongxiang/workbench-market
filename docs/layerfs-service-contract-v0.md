# layerfs 服务契约 v0（P0 正式化件·#94 §6 冻结 + 池化/风险增补）

> 来源：#94（评审席·属主 2026-10-26 裁定）。本件把 §6 的散文契约正式化为**可测契约件**；
> 增补项（池化策略/四风险表）经 P0 开发令（direct-5bda787d）要求写入。
> 契约改动流程：#94 回帖 → 评审席先改判据材料 → 重冻。

## 1. 接入

| 项 | 语义 |
|---|---|
| `LAYERFS_SERVICE_URL` | 服务根地址（如 `http://layerfs-svc:8067`） |
| `LAYERFS_SERVICE_TOKEN` | 每请求头 `Authorization: Bearer <token>` |
| 未设置二者 | **不启用 LayerFS**（保持现行为·P0 过渡期灰度开关） |

**部署边界**：市场主容器**不直接调 LayerFS 库**，只经内网调 layerfs 服务容器（#94 §4.6）。
市场主容器无宿主权限：不挂 `docker.sock`、不挂 `/var/lib/docker`（L12 判据）。

## 2. 端点（全部 `/v0` 前缀·JSON）

### 2.1 `POST /v0/projects/{project}/publish`
体：`{ files:[{path, content}], message }` → `200 { commit_id, changed }`
- 项目不存在时**由服务建项目（Init）**；与发布线头比对后一次提交
- 文件与发布线头**完全相同** → `changed:false`，`commit_id`=原头
- 每个调用**只尝试一次**，服务不得自动重试/重放（R7）

### 2.2 `GET /v0/projects/{project}/commits/{commit_id}/files`
→ `200 { files:[{path, content}] }` —— 冷版本回读（服务内部经 Sandbox 挂载打包导出·#94 §4.3）

### 2.3 草稿面
- `POST /v0/projects/{project}/drafts` 体 `{ from: commit_id }` → `200 { draft }`
- `POST /v0/projects/{project}/drafts/{draft}/apply` 体 `{ changes:[{op, path, content?, old_text?, new_text?}], message }` → `200 { commit_id }`
- `POST /v0/projects/{project}/drafts/{draft}/merge` → `200 { commit_id }`；与发布线**同路径冲突** → `409 { kind:"Conflict", conflicts:[path] }`

### 2.4 `DELETE /v0/projects/{project}`
→ `200 { removed:true }` —— 服务删项目、Store 卷与该台全部备份（删台彻底）

### 2.5 `POST /v0/dispatch`
体 `{ run_id, script, image_tag?, timeout_ms? }` → `200 { ok, commit_hash, exit_code, stdout_tail, stderr_tail, duration_ms }`
- PR#70 bridge 契约并入本服务；市场也可经 `SANDBOX_BRIDGE_URL` 的 `/dispatch` 调同一替身

## 3. 市场侧可见面

- `GET /api/apps/:slug` 台详情带 `layerfs_project`；`versions[]` 每项带 `commit_id`
- 物化目录 `DATA_DIR/apps/<slug>/v<N>/`（与现行相同·R1 激活版本另有落盘副本）
- MCP 工具：`app_draft_open {slug}`、`app_draft_edit {slug, draft, path, old_text, new_text}`、`app_draft_submit {slug, draft, changelog}`（合并回发布线并走发布门禁·生成新版本并激活）

## 4. 客户端池化策略（P0 必含·R8 语义）

| 项 | 语义 |
|---|---|
| **LRU 上限** | 市场进程内维护「项目 → 客户端」池，**上限 8 个**；超限逐出最久未用（逐出前 flush） |
| **空闲关闭** | 空闲 **60s** 自动关闭该客户端（timer 清理·关闭前 flush） |
| **路径切换语义** | 客户端创建时读一次 `LAYERFS_STORE_PATH`；**一个进程只加载一份 @layerfs/agent**——切换 Store 路径必须重建客户端（池化层负责：逐出旧客户端 → 设新路径 → 新客户端） |
| **并发安全** | 每项目单客户端串行化调用（服务端 Conflict 语义不受影响）；跨项目并行 |

## 5. 四风险表（P0 必含·随契约）

| # | 风险 | 触发点 | 处置 |
|---|---|---|---|
| R-A | 迁移携带破损 | P1 迁移现有版本入 LayerFS 时文件损坏/编码漂移 | P1 门禁复验：迁移后逐文件 sha256 对账（L2 同款判据） |
| R-B | P2 崩溃窗口 | 影子双写期间：commit 已建、物化未完成（或反之）——重启后状态不一致 | P2 设计「commit 为准·物化可重建」；启动时对账（物化缺失→自 commit 重建） |
| R-C | L4 幂等 | 同一发布请求重放（网络重试/人工重发）→ 重复 commit | 服务端 publish 幂等：同文件集+同发布线头 → `changed:false` 返原头（§2.1）；市场侧不自动重试（R7） |
| R-D | 池化复杂度 | LRU/空闲关闭/路径切换的竞态（逐出时在途调用） | 逐出前 await 在途调用完成；池大小/空闲时长可配（env）；L13 真调用闸覆盖 |

## 6. 判据映射（§7 L0-L13 → P0 范围）

- P0 承接：**L12**（无宿主权限 compose）· **L13**（dispatch 真调用闸）· L0（探测执行）
- P1-P4 承接其余：L1-L3（发布/物化/无变化）· L4（写失败无半截）· L5-L6（3 版/冷回读）· L7（单次尝试）· L8（草稿冲突）· L9（隔离）· L10（删台彻底）· L11（托管不碰服务）

## 7. 错误面

| 状态 | 语义 |
|---|---|
| 400 | 请求体非法（模型校验失败） |
| 401 | 令牌缺失/错误 |
| 409 | Conflict（草稿 merge 冲突·§2.3） |
| 500 | 服务内部错误——**市场侧不得自动重试**，失败即报 |
| 502/504 | 市场↔服务通道故障（超时/拒连） |
