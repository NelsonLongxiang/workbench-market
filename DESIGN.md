---
name: workbench-market
version: 1.0.0
description: 工作台 design token 标准——市场前端、SOP 执行页与自产台共用的唯一事实源（仅浅色）
colors:
  # 品牌
  primary: "#1E3A5F"          # 主按钮、链接、选中态、info
  on-primary: "#FFFFFF"       # 11.50:1
  primary-subtle: "#EEF2F7"   # 选中行/浅底强调；primary 文字其上 10.23:1
  # 文字（只许用这三档写字）
  text: "#0F172A"             # 正文/标题；白底 17.85:1
  text-secondary: "#5A6577"   # 次级说明；白底 5.89:1、page 底 5.50:1
  text-disabled: "#94A3B8"    # 仅禁用态与占位符（2.56:1，豁免 WCAG 1.4.3，不得写有效信息）
  # 面与线
  page: "#F6F7F9"             # 页面底
  surface: "#FFFFFF"          # 卡片、表格、抽屉、弹窗
  border: "#E2E8F0"           # 默认分隔线/卡片边
  border-strong: "#CBD5E1"    # 输入框边、强调分隔（非文字，1.48:1 仅作线）
  # 状态（*-text 用于写字，*-bg 用于浅底条，主值用于图标/边/实心按钮）
  success: "#047857"          # 实心按钮白字 5.48:1（原 #059669 白字仅 3.77:1，弃用）
  success-text: "#047857"
  success-bg: "#ECFDF5"       # success-text 其上 5.21:1
  warning: "#F59E0B"          # 仅图标/边/徽标底，不写字
  warning-text: "#B45309"     # 白底 5.02:1、warning-bg 上 4.84:1
  warning-bg: "#FFFBEB"
  danger: "#DC2626"           # 实心按钮白字 4.83:1；白底文字 4.83:1
  danger-text: "#B91C1C"
  danger-bg: "#FEF2F2"        # danger-text 其上 5.91:1
  # 侧栏（唯一的深色区域）
  nav-bg: "#0F172A"
  nav-text: "#CBD5E1"         # nav-bg 上 12.02:1
  nav-text-active: "#FFFFFF"
  nav-item-active-bg: "#1E3A5F" # 白字 11.50:1
  info: "{colors.primary}"
  info-bg: "{colors.primary-subtle}"
typography:
  family-sans: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif"
  family-mono: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace"
  caption:  { fontSize: 12px, lineHeight: 20px, fontWeight: 400 }   # 辅助说明、表格次列、标签
  body:     { fontSize: 14px, lineHeight: 22px, fontWeight: 400 }   # 正文与表格（密度 8/10 基线）
  body-strong: { fontSize: 14px, lineHeight: 22px, fontWeight: 600 }
  subtitle: { fontSize: 16px, lineHeight: 24px, fontWeight: 600 }   # 卡片标题、抽屉标题
  title:    { fontSize: 20px, lineHeight: 28px, fontWeight: 600 }   # 页标题
  display:  { fontSize: 24px, lineHeight: 32px, fontWeight: 600 }   # 统计大数（配 tabular-nums）
  stat-label: { fontSize: 12px, lineHeight: 20px, fontWeight: 600, letterSpacing: 0.05em, textTransform: uppercase }
spacing:
  # 4px 栅格；只许用这些值
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "6": 24px
  "8": 32px
  "12": 48px
rounded:
  sm: 4px      # 徽标、标签
  md: 6px      # 按钮、输入框（= antd borderRadius）
  lg: 8px      # 卡片、弹窗、抽屉
  full: 9999px # 头像、状态点
elevation:
  "0": none
  "1": "0 1px 2px rgba(15, 23, 42, 0.05)"    # 卡片静态
  "2": "0 4px 12px rgba(15, 23, 42, 0.10)"   # 卡片悬停、下拉
  "3": "0 12px 32px rgba(15, 23, 42, 0.16)"  # 弹窗
motion:
  fast: 120ms
  base: 200ms
  easing: ease
components:
  button-primary:   { backgroundColor: "{colors.primary}", textColor: "{colors.on-primary}", rounded: "{rounded.md}", height: 32px, padding: "0 16px", typography: "{typography.body}" }
  button-danger:    { backgroundColor: "{colors.danger}", textColor: "{colors.on-primary}", rounded: "{rounded.md}", height: 32px, padding: "0 16px" }
  input:            { backgroundColor: "{colors.surface}", textColor: "{colors.text}", rounded: "{rounded.md}", height: 32px, padding: "0 12px" }
  card:             { backgroundColor: "{colors.surface}", textColor: "{colors.text}", rounded: "{rounded.lg}", padding: "{spacing.3}" }
  tag-success:      { backgroundColor: "{colors.success-bg}", textColor: "{colors.success-text}", rounded: "{rounded.sm}", typography: "{typography.caption}" }
  tag-warning:      { backgroundColor: "{colors.warning-bg}", textColor: "{colors.warning-text}", rounded: "{rounded.sm}", typography: "{typography.caption}" }
  tag-danger:       { backgroundColor: "{colors.danger-bg}", textColor: "{colors.danger-text}", rounded: "{rounded.sm}", typography: "{typography.caption}" }
---

# 工作台 Design Token 标准（v1.0.0）

## Overview

本文件是工作台视觉的**唯一事实源**。三类页面都从这里取值：

| 面 | 怎么拿到 token | 现状 |
|---|---|---|
| 市场前端（`web/`，antd 5） | `ConfigProvider` 的 theme token 由本文件映射；自写样式用 `--wm-*` CSS 变量 | 主题只配了 6 项；`style={{…}}` 213 处、散落色值 46 种 |
| SOP 执行页（`server/src/sop-runner.ts` 服务端渲染） | 页内注入同一份 `--wm-*` 变量 | 自带 11 个硬编码色 |
| 自产台（他人开发、经市场门户打开） | 链接市场提供的 `tokens.css`，只用 `--wm-*` 变量名 | 无约定，各台自定 |

裁定（属主 2026-11-01，同日定稿 v1.0.0）：覆盖以上三面；**只做浅色**；**只写规范、CI 不拦**，靠评审把关。

菜单与目录、页面骨架、SOP 交付空间、任务清单与列表、数据看板的规则见 [`design-system/workbench-market/PATTERNS.md`](design-system/workbench-market/PATTERNS.md)。「只做浅色」指内容区；侧栏是唯一的深色区域，用 `nav-*` token。

风格基调沿用 `design-system/workbench-market/MASTER.md` 的“瑞士风·高密度仪表台”（Variance 4 / Motion 3 / Density 8）与离线字体决定（零 webfont）。MASTER.md 中与本文件冲突的部分（深色底配色表、`.btn-*`/`.card` 示例 CSS、营销页 Page Pattern、GSAP 滚动动效）以本文件为准。

## Colors

- **写字只许用 `text` / `text-secondary`**，以及状态色的 `*-text`。`text-disabled` 只给禁用态和占位符。
- 状态色分三档：主值（图标、边、实心按钮底）/ `*-text`（写字）/ `*-bg`（浅底提示条、标签）。`warning` 主值是琥珀色，对比度不够写字，写字一律用 `warning-text`。
- **success 改为 `#047857`**：现行 antd `colorSuccess: #059669` 上白字只有 3.77:1，不达 WCAG AA（4.5:1）。迁移时一并替换。
- 所有写字组合都已算过对比度，见 front matter 注释；新增组合必须 ≥ 4.5:1（大字 ≥ 3:1）。

## Typography

- 只有 6 档：caption 12 / body 14 / body-strong 14·600 / subtitle 16 / title 20 / display 24，外加统计标签 `stat-label`。
- 现有代码里的 **11px 和 13px 不再使用**：11→12（caption），13→12 或 14，按信息层级选。
- 机器值（URL、端口、路径、ID、令牌前缀）用 `family-mono`；统计数字、表格数字加 `font-variant-numeric: tabular-nums`。
- 中文不加 letter-spacing；`stat-label` 的 0.05em 只对拉丁字母生效。

## Layout

- 间距只走 4px 栅格：4 / 8 / 12 / 16 / 24 / 32 / 48（token 名 `spacing.1`…`spacing.12`，数字 = 4px 的倍数）。原 MASTER 的 2px 档取消。
- 卡片内边距 12，卡片间距 12；页面左右边距 24；表单项纵向间距 16。
- 优先用 antd 的 `Space` / `Flex` 的 `gap` 与 `Row gutter`，而不是逐个写 margin。

## Elevation

三档：`1` 卡片静态，`2` 悬停和下拉，`3` 弹窗。不叠加、不自造阴影。

## Shapes

圆角四档：sm 4（标签、徽标）/ md 6（按钮、输入框，= antd 默认）/ lg 8（卡片、弹窗、抽屉）/ full（圆点、头像）。

## Components

- **按钮**：一屏最多一个 primary；危险操作用 `danger`，不用红色 primary。高度统一 32（antd middle）。
- **状态标签**：用 `tag-success` / `tag-warning` / `tag-danger`，不手写 `color`/`background`。`StatusBadge` 组件是唯一入口。
- **卡片**：`surface` 底 + `border` 边 + `elevation.1`，悬停升到 `elevation.2`，边框不变色。
- **空态、加载、错误**：统一用 antd `Empty` / `Spin` / `Result`，文字用 `text-secondary`。

### CSS 变量契约（给 SOP 执行页与自产台）

变量名 = `--wm-` + 分组 + 名，例如：

```css
--wm-color-primary  --wm-color-text-secondary  --wm-color-danger-bg
--wm-font-sans      --wm-font-size-body        --wm-line-height-body
--wm-space-3        --wm-radius-lg             --wm-shadow-2
--wm-motion-base
```

- **名字稳定、值可变**：小版本只改值；改名或删名要升主版本，并保留旧名一个版本做别名。
- 市场以固定路径提供 `tokens.css`（带版本号），自产台 `<link>` 引入后只用变量，不抄色值。
- 自产台可以加自己的品牌色，但正文、状态、面与线必须用 `--wm-*`，保证在门户里打开时观感一致。

## Do's and Don'ts

| Do | Don't |
|---|---|
| 用 `--wm-*` 变量或 antd theme token | 在 `.tsx` 里写 `#xxxxxx`、`rgba(…)` |
| 间距用 4px 栅格值，优先 `gap` | `margin: 7px`、`fontSize: 13` 这类栅格外数值 |
| 写字用 `text` / `text-secondary` / `*-text` | 用 `text-disabled`（#94A3B8）写有效信息 |
| 状态用 `StatusBadge` / tag 组件 | 每页各写一套红绿黄 |
| 机器值用等宽字体 | 引入 webfont 或外链字体 |
| 尊重 `prefers-reduced-motion` | 位移动画、滚动触发动效 |

## 落地（不在本文件，另开 issue 分步做）

1. 由本文件生成 `web/src/tokens.css` 与 antd theme 映射，替换 `main.tsx` 里的手写 6 项。
2. SOP 执行页改用 `--wm-*` 变量，去掉 11 个硬编码色。
3. 市场提供带版本号的 `tokens.css` 给自产台，README 写明引入方式。
4. 按页迁移 213 处内联样式与 46 种散落色值（Sops / McpGateways / Lifecycle / Cockpit / Dashboard 最多）。
5. 本标准按属主裁定**不进 CI 门禁**；评审时对照上表 Do's and Don'ts。
