# 05 · Token v2

> 阶段 0 草稿。v2 在 `DESIGN.md` v1.0.0 上扩展，不推翻；生成器 `scripts/gen-design-tokens.mjs` 与 `--check` 门禁照旧，对比度审计照旧。

## 一、现状与差距

| 维度 | v1.0.0（本仓） | DSH `ui-theme` | LobeHub（参照） |
|---|---|---|---|
| 分层 | 一层：直接写值 | 三层：`--dsw-static-*` 色板 → `--dsw-alias-*` 语义 → 组件局部 | 三层：色板（13 色 × 10 级）→ 语义 → 组件 |
| 主题 | 仅浅色 | 明暗两套 alias | 明暗 |
| 状态色 | 主值 / 写字 / 浅底三档 | primary / secondary / tertiary / label | 十来档：bg、bg-hover、border、border-hover、四档 fill、text、text-hover、text-active |
| 交互态 | 无 | `interactive-bg-hover` / `-active` / `-hover-accent` / `-hover-danger` | 每个状态色都有 hover / active |
| 文字层级 | text / text-secondary / text-disabled | label primary / secondary / tertiary / dimmed / caption | text / secondary / tertiary / quaternary |
| 面层级 | page / surface | bg base / layer-1 / layer-2 / layer-3 / overlay / mask | layout / container / elevated / spotlight |
| 线 | border / border-strong | border l1–l4（0.5px 发丝线） | border / border-secondary |
| 圆角 | 4 / 6 / 8 / full | 4 / 8 / 12 / 16 / 20 / panel 28 | 4 / 6 / 8 / 12 |
| 阴影 | 0–3 | soft / panel / prominent（高层表面用阴影不用描边） | 3 级 |
| 控件高度 | 只在组件里写 32px | — | xs 18 / sm 27 / 默认 / lg 45 |
| 字号 | caption 12 / body 14 / subtitle 16 / title 20 / display 24 | 11 / 12 / 13 / 14 / 16 / 18 / 20 / 24，字号与行高成对 | 12 / 14 / 16 / 20 / 24 / 30 / 38 |
| 动效 | fast 120 / base 200 / ease | 有（主题包管理） | 三档时长 + 多条缓动 + 三条弹簧曲线 |
| 图表配色 | 无 | — | 有色板 |
| 密度 | 无 | — | — |

## 二、v2 的结构

```
static（色板，只给 alias 引用）
  └─ alias（语义，组件和台只许用这一层）  ← 主题在这一层切换：light / dark / dsh
        └─ component（组件局部，可选）
```

- **台和市场前端只许用 alias 层**（`--wm-*` 语义名）。不许直接引用 static 色板，也不许写颜色字面量（沿用 v1 规则，扩到所有面）。
- **三套主题**，都在 alias 层切换：
  - `light`：默认，保留市场品牌主色 `#1E3A5F`；
  - `dark`：可选；
  - `dsh`：随 DSH 宿主。市场的台嵌进 DSH 右栏、或 DSH 会话嵌进驾驶舱时用，alias 取 DSH 同名语义的值。由 `?wm_theme=dsh` 或驾驶舱下发选择（iframe 不继承父页的 CSS 变量，所以要显式选）。
- **两档密度**：`comfortable`（默认）与 `compact`（驾驶舱面板模式用），只影响控件高度、行高和留白，不影响字号层级。

## 三、要补齐的档位

| 组 | 新增 |
|---|---|
| 面 | `bg-layer-1/2/3`、`bg-overlay`、`bg-mask` |
| 文字 | `label-tertiary`（介于 secondary 与 disabled 之间，可写有效信息，对比度 ≥ 4.5:1） |
| 线 | `border-l1..l4`；嵌入 DSH 时用 0.5px |
| 交互 | `interactive-bg-hover`、`-active`、`-hover-danger`、`focus-ring` |
| 状态 | 每个状态（success / warning / danger / info）补 `-border`、`-hover`、`-active`、`-fill` |
| 控件高度 | `control-xs 24` / `control-sm 28` / `control-md 32` / `control-lg 40` |
| 动效 | 时长 fast / base / slow；缓动 standard / emphasized；`prefers-reduced-motion` 时全部降为 0 |
| 层级 | `z-base` / `z-sticky` / `z-dock` / `z-float` / `z-popover` / `z-modal` / `z-toast` |
| 图表 | 8 色分类色板 + 顺序色板 + 发散色板（各自过色觉与对比度校验） |

具体数值在阶段 1 第一周定，过对比度审计后写进 `DESIGN.md`（P2）。

## 四、与 DSH `--dsw-alias-*` 的映射

命名对齐，值按主题取。`dsh` 主题下左列取右列的值；`light` / `dark` 下取市场自己的值。

| 市场 v2（`--wm-*`） | DSH（`--dsw-*`） | 备注 |
|---|---|---|
| `bg-page` | `alias-bg-base` | |
| `bg-surface` | `alias-bg-layer-1` | 卡片、表格 |
| `bg-elevated` | `alias-bg-layer-2` | 抽屉、下拉 |
| `bg-overlay` | `alias-bg-overlay` | |
| `bg-mask` | `alias-bg-mask-1` | 模态遮罩，不模糊 |
| `text` | `alias-label-primary` | |
| `text-secondary` | `alias-label-secondary` | |
| `text-tertiary` | `alias-label-tertiary` | |
| `text-disabled` | `alias-label-dimmed` | |
| `text-caption` | `alias-label-caption` | |
| `border` | `alias-border-l2` | |
| `border-subtle` | `alias-border-l1` | |
| `border-strong` | `alias-border-l3` | |
| `primary` | `alias-brand-primary` | DSH 的品牌主色是中性深色；`dsh` 主题下市场主按钮随之变为中性 |
| `link` | `alias-link` | |
| `interactive-hover` | `alias-interactive-bg-hover` | |
| `interactive-active` | `alias-interactive-bg-active` | |
| `interactive-hover-danger` | `alias-interactive-bg-hover-danger` | |
| `success` / `success-bg` | `alias-state-success-primary` / `-tertiary` | |
| `warning` / `warning-text` / `warning-bg` | `alias-state-warn-primary` / `-label` / `-tertiary` | |
| `danger` / `danger-bg` | `alias-state-error-primary` / `-secondary` | |
| `idle` | `alias-state-idle-primary` | 离线、未探测 |
| `elevation-1` / `-2` / `-3` | `elevation-soft` / `-panel` / `-prominent` | |
| `radius-sm` / `-md` / `-lg` | `radius-xs` / `-sm` / `-md` | DSH 圆角大一档；`dsh` 主题下按右列取值 |
| `font-caption` / `-body` / `-subtitle` / `-title` / `-display` | `font-xxs-12` / `-s-14` / `-base-16` / `-l-20` / `-xl-24` | 字号与行高成对 |

DSH 侧的 token 值由 DSH 源码生成，会随 DSH 升级变化。`dsh` 主题的取值表由生成器从钉住版本的 DSH `ui-theme` 读出，不手抄；版本进系统清单。

## 五、迁移

1. 阶段 1：`DESIGN.md` 升 v2.0.0，生成器输出 `tokens.css`（三套主题 × 两档密度）与 `design-tokens.ts`；v1 变量名保留为别名一个版本。
2. 体验版先用 v2。
3. 市场前端：antd `ConfigProvider` 的主题映射改由 v2 生成；`style={{…}}` 内联色值逐步替换（不在阶段 1 强求清零）。
4. 自产台：沿用「只用 `--wm-*` 语义名」，旧名在别名期内继续有效。
5. MCP `design_standard` 自动返回 v2（它读 `DESIGN.md`）。

## 待决

- 品牌主色是否保留 `#1E3A5F`（P2，默认保留）。
- `dsh` 主题是否下发给所有嵌入 DSH 的台，还是只给面板模式（P2，默认只给面板模式）。
