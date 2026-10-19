# UX 校对报告 · workbench-market

日期：2026-10-19 · 依据：ui-ux-pro-max 本地准则检索（5 主题）+ Playwright 截图（5 页桌面 1440×900 + 2 页移动 390×844）+ E2E 自动化 14 用例全绿

## 方法

1. **准则检索**（`search.py`，domain=ux）：accessibility focus keyboard / form validation error / contrast ratio / data table / loading empty state —— 取 High 级条目逐条对照实现。
2. **截图巡检**：evidence/ux-*.png 7 张，桌面+移动双视口。
3. **DOM 探针**（Playwright evaluate）：工具栏结构、选择器误报核查（表格 checkbox）、徽章 markup。
4. **修复后回归**：重建 → 复截图 → E2E 14/14 PASS。

## 发现与处置

| # | 严重度 | 准则来源 | 问题 | 处置 |
|---|--------|----------|------|------|
| 1 | P1 High | Error Messages（aria-live/role=alert）+ E2E 实际暴露 | 编辑保存 500 时表单静默吞错，用户无任何反馈 | ✅ 修复：WorkbenchForm onFinish catch 加 message.error（含真实根因修复见 #5） |
| 2 | P1 High | Contrast Readability（darker text on light bg） | antd 默认次级文字 rgba(0,0,0,.45) 白底对比度 3.36:1 < 4.5:1（延迟数字、统计标签、说明文字、占位提示全局中招） | ✅ 修复：ConfigProvider token `colorTextSecondary: '#5A6577'`（白底 5.9:1，#F6F7F9 底约 5.5:1） |
| 3 | P1 High | Table Handling（横向滚动或卡片布局） | 移动端 390px 下市场表格列横向溢出被裁切（服务地址/分类/标签列不可达） | ✅ 修复：ProTable `scroll={{ x: 'max-content' }}` + 列宽锚定（名称 200 / 类型 130 / 地址 260） |
| 4 | P1 High | Table Handling / Focus Not Obscured | 移动端工具栏全部按钮溢出视口（匿名包裹 DIV nowrap 904px > 视口 390） | ✅ 修复：index.css 双类选择器压过 pro-components css-hash，对工具栏容器及其匿名包裹 DIV 两层 flex-wrap；scrollWidth 复测 390=390 |
| 5 | P1 High | （E2E 暴露的真实后端 bug） | PUT /api/workbenches/:id 把非 SQL 命名参数（last_status 等）传入 node:sqlite → Unknown named parameter 'last_status' 500 | ✅ 修复：index.ts:99 显式绑定 UPDATE 命名字段（node:sqlite 严格性教训：better-sqlite3 会忽略多余键） |
| 6 | P2 Medium | 布局/内容完整性 | 仪表盘卡片 h=2（144px）放不下标题+URL+状态+按钮行，底部被裁切 | ✅ 修复：默认布局 h:3/minH:3（216px），LAYOUT_KEY 升 v2 重置旧布局 |
| 7 | P2 Medium | Empty States | 空搜索有「暂无工作台」文案 | ✅ 已符合（E2E 断言覆盖），无需改动 |
| 8 | P2 Medium | Color Only（不许颜色单一编码状态） | 状态指示 = 色点+文字+延迟+Tooltip 四重冗余，未违规 | 无需改动 |
| 9 | P2 Medium | Loading Indicators | 表格请求走 ProTable 自带 loading；Dashboard ahooks 轮询 15s | 符合；建议项（骨架屏）记入 backlog |
| 10 | P2 Medium | 触控目标 44px | 表格行内 small 按钮 ~24px 高，小于 44px 触控准则 | **遗留**：桌面优先的内网工具，记 backlog；如移动使用占比上升再处理 |
| 11 | P2 Medium | Focusable Error Summary | 表单校验失败仅有行内错误+toast，无顶部错误摘要 | **遗留**：antd ModalForm 行内错误已满足最小可用；多字段复杂表单场景再引入摘要区 |
| 12 | P3 Low | Bulk Actions（多选批量） | 无批量操作（探针确认：表格无 selection checkbox，截图小方块为渲染伪影） | 无需改动（未提供死 affordance） |

## 对比度实测记录

| 元素 | 颜色 | 背景 | 对比度 | 结论 |
|------|------|------|--------|------|
| 错误链接文字 #DC2626 | red-600 | #fff | 4.83:1 | ✅ ≥4.5 |
| 成功状态点 #059669（图形元素，阈值 3:1） | emerald-600 | #fff | 3.77:1 | ✅（仅点/开关等非文字用途） |
| 「在线」文字 | antd 主文字 rgba(0,0,0,.88) | #fff | ~15:1 | ✅ |
| 次级文字（修复前默认） | rgba(0,0,0,.45) | #fff | 3.36:1 | ❌ → 已改 #5A6577 = 5.9:1 |
| 卡片 URL #64748b | slate-500 | #fff | 4.75:1 | ✅ |
| 深色侧栏菜单文字（白 .85/.65） | — | #0F172A | >7:1 | ✅ |
| 主按钮 #1E3A5F 文字白 | navy | — | >10:1 | ✅ |

## 误报闭环

- 「市场表格有多选 checkbox」→ DOM 探针 `.ant-checkbox` = 0，截图方块为列分隔渲染伪影，撤销。
- 「状态文字绿色 3.77:1 不达标」→ 探针 markup 确认状态文字走 antd 主文字色（深色达标），绿色仅点元素；真正不达标的是延迟数字用的次级 token → 已由 #2 一并修复。

## 遗留 backlog（不阻断交付）

1. 移动端触控目标 ≥44px（行内操作按钮 small → 视移动占比决策）
2. 复杂表单顶部错误摘要区（Focusable Error Summary, High 级）
3. 表格加载骨架屏
4. use 页「刷新」icon-only 按钮视觉偏淡（浅色 icon on 深色栏，实测可辨，记观察项）

## 证据

- 修复前截图：evidence/ux-*.png（本轮覆盖更新为修复后版本，修复前形态见 git 前次提交记录）
- E2E：14/14 PASS（两轮，修复前后）
- antd lint：0 issues（11 files）
- typecheck / vite build：✅
