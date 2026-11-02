# 开发验证器 v69.6：index.css 去色值后的 5 条钉位改锚

基线 main b5b6a83。#322 把 `web/src/index.css` 里所有写死的色值换成了 `DESIGN.md` 的 `--wm-*` 变量，并删掉了总览看板化（#320）后已经没人用的 `.wm-card*` 规则。原先钉在 index.css 色值上的判据 41、42、50、51、58 因此提取为 0，随本 PR 一起改锚。判据 57 钉的是选择器 `.wm-use-bar .ant-badge-status-text`，选择器还在，不改。

| 判据 | 旧钉位 | 新钉位 |
|---|---|---|
| 41 焦点环 | `rgba(5, 150, 105, 0.6)` | `.wm-dash-clickable:focus-visible { outline: 2px solid var(--wm-color-primary); outline-offset: 2px; }` |
| 42 选中/悬停反馈 | `rgba(5, 150, 105, 0.45)` | `.wm-dash-clickable:hover { box-shadow: var(--wm-shadow-2); }` |
| 50 卡片淡边线 | `rgba(30, 58, 95, 0.1)` | `border: 1px solid var(--wm-color-border);` |
| 51 深底 | `#0f172a` | `background: var(--wm-color-nav-bg);` |
| 58 深底浅色文字 | `rgba(255, 255, 255, 0.85)` | `color: var(--wm-color-nav-text) !important;` |

- 41、42 原来用的是 emerald，属主定稿的 DESIGN.md 已弃用它，改为 primary 和 elevation 2。
- 51 的值不变（nav-bg 就是 `#0F172A`）。
- 58 的 nav-text 对 nav-bg 是 12.02:1，高于原来 85% 白的约 11:1。

v69.6 supersedes v69.5，175 条编号保持，changed_criteria=[41,42,50,51,58]。

## 验证边界

- make-submission 文本事实表 129 条全部命中。gen-verifier 生成 175 条。portal-call-chain-test、verifier-masked-import-test 通过，版本断言改为 v69.6。
- 渲染层对比度由 E2E 探针覆盖（含 `.wm-use-bar` 三处）。
- 新材料需要验证席重新 submit/prepare/run/archive，旧 run 不改写。
