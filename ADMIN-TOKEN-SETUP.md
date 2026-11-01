# ADMIN_TOKEN 接入程序（主人操作指南——#17 修订 3 诚实约束）

值只能由主人放进启动环境，不进任何 agent 可读文件/配置/API。

## 步骤（约 2 分钟）

1. **生成强随机值**（任选其一）：
   ```powershell
   # PowerShell（Base64 约 44 字符）
   [Convert]::ToBase64String((1..32 | %{Get-Random}))
   # 或 cmd（hex 64 字符）
   powershell -Command "[Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')"
   ```

2. **设入机器级环境**（所有后续进程继承）：
   ```cmd
   setx ADMIN_TOKEN "<你生成的值>" /M
   setx MCP_GATEWAY "on" /M   （可选——#284 起不设也是开；只有显式 off 才关并启动告警，生产勿设 off；OFF/false/0 等其它写法拒绝启动）
   ```

3. **重启 9800 服务**（新进程才继承新 env）：
   - 守护拉起：等下一轮或手动触发
   - 或管理员终端跑 `schtasks /Run /TN workbench-market-9800`

4. **验证**（行为面）：
   ```bash
   # 无口令→403
   curl -X POST http://127.0.0.1:9800/api/mcp/sessions -d '{"name":"probe"}' -H 'Content-Type: application/json'
   # 带口令→201（token 出现一次）
   curl -X POST http://127.0.0.1:9800/api/mcp/sessions -d '{"name":"probe"}' \
     -H 'Content-Type: application/json' -H 'X-Admin-Token: <你的值>'
   ```

## 三处启动路径的插槽状态

| 路径 | 插槽形态 | 说明 |
|---|---|---|
| `tmp/make-tasks.cmd` | ✅ `if not "%AT%"=="" set ADMIN_TOKEN=...` | 从机器级 env 读值传给 node 进程（值不进 cmd 文件） |
| 守护脚本 `tmp/guard-9800.cmd` | 监督席领地 | 建议：node 启动行前加 `if defined ADMIN_TOKEN set "GWT=%ADMIN_TOKEN%"`（同模式）——请监督席同步 |
| managed job（监督席） | 监督席领地 | 同上——监督席确认其 job 启动环境从进程 env 继承 |

## DSH 连接器升级（网关开启后·#284 起升级即缺省开）

1. 市场管理页 `/mcp-gateways` → 建会话（token 只显示一次，立即复制）
2. grants 编辑器勾选授权工具
3. 各 DSH 连接器配置 headers 加：
   ```json
   { "Authorization": "Bearer <token>" }
   ```
   （dsh-mcp-connector 的自定义连接 headers 字段支持）

## 安全注意

- ADMIN_TOKEN 泄露=可建任意 MCP 会话/绑定 SOP/写一切控制面——请主人妥善保管
- 与 SOP 绑定口令共用同一 ADMIN_TOKEN（P1 设计）
- 撤销一个泄露的会话令牌：管理页吊销即可（令牌即时失效，无需改 ADMIN_TOKEN）
- 改 ADMIN_TOKEN 本身：重新 setx /M + 重启（所有旧会话令牌仍有效直到各自吊销——令牌与 ADMIN_TOKEN 是两套）


## 轮换步骤（监督席派单·控制面单点缓解）

1. **生效面**：设置页/顶栏钥匙图标改口令 → 立即生效（库存 sha256·不可取回·见 /api/admin/token）
2. **旧会话失效**：轮换后**清理全部 mcp_sessions**（`DELETE FROM mcp_sessions;`）——Bearer 会话令牌随旧口令作废面失效（agent 需重新建会话）
3. **验证**：改后旧 token 调 /mcp → 401；新口令建会话 → 200
4. **判据**：token 以 sha256 库存·**不进任何可读配置/日志/导出**（提交物/快照不含口令）
