# 开发验证器 v69.5：总览看板化后的 4 条色值钉位改锚

基线 main 2a2ea09。#320 把总览重做成 PATTERNS.md §6 的看板卡片。卡片颜色一律取 `DESIGN.md` 的 `--wm-*` 变量，`Dashboard.tsx` 里不再写死色值，所以原来钉在 `Dashboard.tsx` 上的判据 46–49 会提取为 0。这次和 #320 同一个 PR 改锚，不再像 v69.4 那样事后补。

| 判据 | 旧钉位（Dashboard.tsx） | 新钉位（index.css） |
|---|---|---|
| 46 统计标签次级色 | `#5A6577` | `color: var(--wm-color-text-secondary);` |
| 47 在线图形成功色 | `#059669` | `.wm-fill-success { background: var(--wm-color-success); }` |
| 48 离线数字错误色 | `#DC2626` | `.wm-tone-danger { color: var(--wm-color-danger-text); }` |
| 49 辅助轴色 | `#94A3B8` | `border-left: 1px solid var(--wm-color-border-strong);` |

- 46 的取值不变（`text-secondary` 就是 `#5A6577`）。
- 47 跟随属主定稿的成功色 `#047857`；在线环改成了趋势卡的柱条。
- 48 改为写字用的 `danger-text`（DESIGN.md：写字用 `*-text`）。
- 49 改为轴线用 `border-strong`。DESIGN.md 规定 `#94A3B8` 只用于禁用态和占位符，不能写有效信息。

v69.5 supersedes v69.4，175 条编号保持，changed_criteria=[46,47,48,49]。

## 验证边界

- make-submission 文本事实表 129 条全部命中。gen-verifier 生成 175 条，三处逐字一致。
- portal-call-chain-test、verifier-masked-import-test 通过，版本断言改为 v69.5。
- 文本事实只证明规则在源码里。卡片是否真的用到这些规则，由 dashboard-browser 和 E2E 渲染层对比度探针覆盖。
- 新材料需要验证席重新 submit/prepare/run/archive，旧 run 不改写。
