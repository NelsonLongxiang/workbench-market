# 数据面语义（#164 P2 三件）

## 1. 发布元数据语义（明确二选一：继承）

`POST /api/apps` 重发（不带 `title/description/created_by/code`）时：

| 字段 | 未传时 |
|---|---|
| `title` / `created_by` / `code` | **继承**自有值 |
| `description` | **继承**自有值（历史文案保留） |

要保持「清空」，必须**显式传空串**（`"description": ""`）——空串不是缺失。

## 2. `enabled` 语义（明确：仅列表可见性）

`enabled=false` **只影响市场列表与门户索引**（下架呈现），不阻断：

- 直接 URL `/apps/<slug>/`、`/go/<id>/` 仍可访问
- 健康巡检按配置仍会探测（可按需关闭）

**硬下线**=停掉上游服务/撤 URL 后删台（`DELETE /api/apps/:slug` 级联清理注册）。

## 3. SOP 数据面 = 哑存储（官方口径）

SOP Runner 的步骤字段是**哑存储**：市场只保证

- `PUT /api/sop/runs/:id`（`{stepKey, value}`）写入原值、`GET` 读回原值（JSON 任意形状）
- MCP `sop_run_step_save` 与人机同链（同一 Redis 热态 + SQLite 真源）
- **不做 schema 校验、不做语义解释**——校验与解释由 agent/消费端负责

推荐模式：

1. 步骤里写结构化 JSON（如 `{"rows":[…],"checksum":"…"}`）
2. agent 读回后按业务规范自校验（对账/阈值/计数）
3. 校验结果再落一个审计步骤（`_verify` 键），形成可复核链
4. 交付文件走文件面（`/files` 或 MCP `app_files_upload`），不在步骤字段里塞大文本
