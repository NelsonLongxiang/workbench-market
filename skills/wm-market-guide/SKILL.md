---
name: wm-market-guide
description: 工作台市场（workbench-market）使用指南——agent 经 MCP 面板操作市场（27 工具）与可视化界面（驾驶舱/门户/交付空间/技能市场）的完整实践：工具选型、UI/UX token 规范、可视化组件模式、常见坑。当需要通过 MCP 操作工作台、发布自产台、跑 SOP、管技能、搭驾驶舱或排查门户 iframe/代理问题时加载。
---

# 工作台市场使用指南（MCP 面板 × 可视化）

工作台市场 = 单进程 Express+React 应用（默认 9800）：/api/* REST · /mcp MCP StreamableHTTP · 其余路径托管前端 SPA。

## 一、两条操作面（先选面）

| 面 | 入口 | 适用 |
|---|---|---|
| MCP 面板（推荐给 agent）| /mcp（StreamableHTTP·Bearer 可选）| 全部 27 工具·幂等·结构化回执 |
| REST | /api/* | 浏览器/脚本直调·部分需要 admin 口令 |

鉴权边界（踩坑过）：远程（非回环）写面走 adminGuard（X-Admin-Token）；loopback 免。本地开发用 127.0.0.1 即免口令；远程调用需带令牌。MCP 工具没有能直接删除/回滚的——那两类走 change_requests 人审门（见 §四）。

## 二、MCP 工具地图（25 个·按用途分）

看：workbench_summary（全局统计）/ workbench_list（列表+状态）/ workbench_check（探活·单个或 all）/ use_url（取门户/直连地址）/ skills_list / skill_versions / app_data_list / app_files_list / sop_run_list / sop_run_get / change_requests

建/改：workbench_register（登记外部服务）/ workbench_update / workbench_unregister / app_publish（自产台发布·版本自动快照）/ app_draft_open|edit|submit（P3 草稿三分支·按差异改·提交走发布门禁）/ sop_publish（发布 SOP 台）/ skills_list→skill_install_plan（技能钉装计划）

跑：sop_run_start（建 run）→ sop_run_step_save（步数据·Redis 热态+30s checkpoint）→ sop_run_sandbox（VM 沙箱执行·commit_hash 交付物）→ sop_run_finish（终态）

人审：change_request_create（提回滚/删除请求·批准前不执行）→ 人经 REST（口令+reviewed_by）批准。

## 三、自产台可视化（delivery space 模式·实战验证）

agent 交付件的标准组合（finance-workbench v17 实测）：
1. 文件通道：POST /api/apps/:slug/files（multer·单文件 ≤50MB）——2026-10-27 起支持 note 字段（列表返 note/created_by/created_at·PATCH 可更新）+软删（deleted_at 隐+原行留审计）
2. 数据通道：app_data_list（表单/登记记录）·三态说明（缺口/留空/待确认）
3. 静态烘焙兜底：交付空间页面图/文件引用加 base href="/go/<id>/" 或全用 /go/<id>/ 前缀（门户 iframe 内的相对路径坑）
4. 回铃：表单提交→绑定 agent 推送（app_bindings notify 向）——不再轮询

## 四、发布纪律（血泪）

- 先拉 served 基线：GET 台详情看 served_version→与本地 diff→版本号 served+1（防双写互踩）
- 发布门禁（S1 三闸+）：空 content 拒、体积骤降>50% 拒（force 可越）、div 配对拒
- 删除/回滚=人审：MCP 只能提 change_requests；人批准才执行
- changelog 归档：version 记录含 changelog 列

## 五、UI/UX token 规范（市场同源·画界面照抄）

antd theme（main.tsx ConfigProvider）：colorPrimary #1E3A5F · colorSuccess #059669 · colorError #DC2626 · colorTextSecondary #5A6577（WCAG AA 达标）· borderRadius 6 · fontFamily Inter/-apple-system/Segoe UI/PingFang SC/Microsoft YaHei

CSS 类体系（index.css·35 类）：卡片 .wm-card（白底/1px rgba(30,58,95,.1)/8px 圆角/12px 内距）、驾驶舱 .wm-cockpit-grid+.wm-panel（白底 flex 列）、面板头 .wm-panel-head+.wm-panel-grip（拖拽柄）、侧栏 .wm-sider-collapse、数字 .wm-num/.wm-mono（等宽）、使用条 .wm-use-bar/.wm-use-frame、统计卡 .wm-stat-card/.wm-stat-label

色板：主 #1E3A5F · 深字 #0F172A/#1E293B · 次字 #64748B/#5A6577/#94A3B8 · 边框 #E2E8F0/#CBD5E1 · 底 #F8FAFC/#F5F5F5 · 白 #FFFFFF

UX 硬规（ui-ux-pro-max 检索实证）：表格移动端 overflow-x-auto 包裹；错误 role="alert"+aria-live；加载保留布局焦点+accessible busy；触控 ≥8px 间距；空态给行动指引。

## 六、可视化组件模式（驾驶舱面板）

- 面板=react-grid-layout 项（可拖拽·layout_config 存 panel 数组）
- 数据卡：wm-stat-card 统计卡（label+num+trend）/ .wm-num 等宽数字（财务/预算场景）
- 状态色：up=#059669 · down=#DC2626 · 未知=#94A3B8
- 图表：antd/echarts 内置主题；配色用主色系（#1E3A5F→#64748B 梯度）不用彩虹色
- iframe 台（/go/<id>/）：注入 base 或标准绝对前缀（§三.3）

## 七、常见坑（实测）

1. 门户 iframe 白屏：目标 SPA 的绝对路径资产（/assets/*）未被 /go/ 前缀改写→市场根 404。市场侧已三层修（HTML/JS 字面/Vite helper）；自建台用相对路径+base。
2. REST 403 vs MCP 成功：远程写需 X-Admin-Token；README 有鉴权表。
3. 技能安装：skill_install_plan 只出计划（expected sha256+命令），不自动落盘——由人/agent 执行安装。
4. legacy 技能（jf:* versions:0）：仅展示不可装。
5. 上传 500：先确认 multipart 有 file 字段；服务端已统一 400（缺 file）/413（超限）。
6. 删台：人审批准后五步 cascade（市场行→服务 project/volume→物化目录→备份）——不可逆。

## 八、快速上手（三条）

1. 看市场：workbench_summary → workbench_list → use_url（取门户地址）
2. 建台：app_publish（首发）→ 后续 app_draft_open/edit/submit（按差异改）→ 人批准发布
3. 跑 SOP：sop_run_start → step_save ×N → sandbox（真执行）→ finish
