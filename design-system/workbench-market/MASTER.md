# Design System Master File

> **2026-11-01 起 token 以仓库根 [`DESIGN.md`](../../DESIGN.md) 为唯一事实源。** 本文件只保留风格基调、离线字体决定与设计档位；下方深色配色表、`.btn-*`/`.card`/`.modal` 示例 CSS、营销页 Page Pattern、GSAP 动效均已作废，与 DESIGN.md 冲突时以 DESIGN.md 为准。

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Workbench Market
**Generated:** 2026-10-19 14:11:58
**Category:** Password Manager
**Design Dials:** Variance 4/10 (Balanced / Modern) | Motion 3/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#1E3A5F` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#334155` | `--color-secondary` |
| On Secondary | `#FFFFFF` | `--color-on-secondary` |
| Accent/CTA | `#059669` | `--color-accent` |
| On Accent/CTA | `#000000` | `--color-on-accent` |
| Background | `#0F172A` | `--color-background` |
| Foreground | `#FFFFFF` | `--color-foreground` |
| Card | `#192134` | `--color-card` |
| Card Foreground | `#FFFFFF` | `--color-card-foreground` |
| Muted | `#10192E` | `--color-muted` |
| Muted Foreground | `#94A3B8` | `--color-muted-foreground` |
| Border | `rgba(255,255,255,0.08)` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| On Destructive | `#FFFFFF` | `--color-on-destructive` |
| Ring | `#FFFFFF` | `--color-ring` |

**Color Notes:** Vault dark blue + secure green

### Typography

> **实现校正（2026-10-19）**：本工具为内网离线环境，**不使用 Google Fonts / 任何 webfont**（原生成稿的 `@import url(...)` 作废，禁止恢复）。字体一律走本地系统栈，零网络请求、零渲染阻塞。

- **UI / Body Font（实际栈）：**
  `"Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif"`
  —— Windows 落 Segoe UI（已装全套字重 300–700），macOS 落 PingFang SC，若机器装有 Inter 自动优先。
- **Mono Font（机器值：URL / 端口 / 路径 / 标识符）：**
  `'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace`（Windows 内置 Cascadia，零 webfont）
- **数字：** `font-variant-numeric: tabular-nums`（`.wm-num`，表格/统计/延迟一律等宽数字防跳动）
- **统计标签（瑞士风）：** `.wm-stat-label` = 12px / 600 / `letter-spacing: 0.05em` / `text-transform: uppercase` / 次级色
- **CJK 注意：** 不加汉字 tracking（0.05em 仅作用于拉丁标签的空气感）；标题字重 600。
- **可读性基线：** body 14px（密度 8/10 的仪表台准则；移动端指引 16px 为内容站标准，本工具记为已接受的偏差）；次级文字 token `#5A6577`（白底 5.9:1，WCAG AA ≥4.5:1，替代 antd 默认 3.36:1 不达标的 rgba(0,0,0,.45)）。

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #059669;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #1E3A5F;
  border: 2px solid #1E3A5F;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #0F172A;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #1E3A5F;
  outline: none;
  box-shadow: 0 0 0 3px #1E3A5F20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Page Pattern

**Pattern Name:** Trust & Authority + Conversion

- **Conversion Strategy:** Security badges. Case studies. Transparent pricing. Low-friction form. Provide pause/stop and stop the logo carousel on focus, hover, and reduced motion. Previous/next controls provide the keyboard equivalent; pause offscreen/hidden and render a static logo set under reduced motion.
- **CTA Placement:** Contact Sales / Get Quote (primary) + Nav
- **Section Order:** Hero (mission/credibility) > Proof (logos, certs, stats) > Solution overview > Clear CTA path

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## 实现校正记录（Implementation Truth）

> 本节优先级高于上文生成稿中与实现冲突的部分。

- **主题形态：** 亮色主题 + 深色侧栏（`#0F172A`）与深色嵌入顶栏；上表 Palette 中 Background/Card 等深色值仅用于侧栏/顶栏/使用页，主内容区背景 `#F6F7F9`、卡片 `#FFFFFF`。
- **色板补充：** 选中/悬停强调边 `rgba(5,150,105,.45)`（emerald 微光）；统计色 在线 `#059669` / 离线 `#DC2626` / 未探测灰。
- **字体：** 见 Typography 节实现校正——系统栈 + Cascadia Mono，无 webfont。
- **对比度实测（2026-10-19 校对）：** 主文字 ~15:1 ✅；次级 `#5A6577` 5.9:1 ✅；错误红 `#DC2626` 4.83:1 ✅；成功绿 `#059669` 3.77:1 仅限图形点/开关（非文字）✅；卡片 URL `#64748b` 4.75:1 ✅。
- **移动端：** 表格 `scroll.x` 横向滚动；工具栏双层 flex-wrap；详见 `evidence/ux-audit.md`。

---

## Anti-Patterns (Do NOT Use)

- ❌ Excessive decoration
- ❌ Color-only indicators

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
