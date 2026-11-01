# 开发验证器 v69.4：design token 落地后的 8 条文本钉位改锚

基线 main ebad847。#315/#316/#317 已合入：antd 主题与侧栏不再写死色值，改取 `DESIGN.md` 生成的 `web/src/tokens.css` / `design-tokens.ts`；菜单数据挪到 `web/src/nav.tsx`。原有 8 条文本事实因此在 main 上提取为 0：36–40、43、87、132。这是我（开发席）合入 #315–#317 时漏改的验证器回归，CI 不跑本验证器，所以没被拦下。

## 新材料

v69.4 supersedes v69.3，175 条编号保持，只有以下 8 条的 source_clause 和钉位变化：

| 判据 | 旧钉位 | 新钉位 |
|---|---|---|
| 36 主色 | main.tsx `#1E3A5F` | tokens.css `--wm-color-primary: #1E3A5F;` |
| 37 次级文字 | main.tsx `#5A6577` | tokens.css `--wm-color-text-secondary: #5A6577;` |
| 38 成功色 | main.tsx `#059669` | tokens.css `--wm-color-success: #047857;` |
| 39 错误色 | main.tsx `#DC2626` | tokens.css `--wm-color-danger: #DC2626;` |
| 40 侧栏深底 | App.tsx `#0F172A` | tokens.css `--wm-color-nav-bg: #0F172A;` |
| 43 标题图标 | App.tsx `#059669` | App.tsx `color: T.colors.success` |
| 87 SOP 路由 | App.tsx `path: '/sops'` | nav.tsx `path: '/sops'` |
| 132 网关路由 | App.tsx `'/mcp-gateways'` | nav.tsx `'/mcp-gateways'` |

- 36、37、39、40 的色值没变，只是换到唯一来源。
- **38 的值变了**：属主定稿的 DESIGN.md v1.0.0 把成功色从 `#059669`（白字 3.77:1，不达 AA）改为 `#047857`（5.48:1）。这是属主的裁定，不是为了凑 PASS 放宽判据。
- 43 改为钉「图标取成功色 token」，不再钉具体色值。
- 候选、anchor.quote、review source_clause 同步；make-submission 文本事实表同步换路径和子串。

`material-version.json` 里 changed_criteria=[36,37,38,39,40,43,87,132]。不是用同一个 ID 直接覆写旧材料。

## 验证边界

- 本地：make-submission 文本事实表 129 条字面事实全部命中；gen-verifier 在临时目录生成 175 条，source_clause / anchor.quote / review 三者逐字一致。
- portal-call-chain-test（82 项）、verifier-masked-import-test（12 项）通过。两者的版本断言照 v69.3 先例改为 v69.4/changed 8 条，其余突变组不变。
- 文本事实只证明子串在源码里。主题和侧栏确实从 token 取值，由 CI 里的 design-tokens-smoke 与 sider-menu-browser 覆盖。
- 新材料需要新的 submit/prepare/run/archive，不能凭这里的局部检查宣布正式 175 PASS。旧材料上的旧 run 不改写。
