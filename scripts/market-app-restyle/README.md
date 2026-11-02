# 自产台统一层

把市场里的自产台（`/apps/<slug>/`）统一到 [DESIGN.md](../../DESIGN.md) token 与 [PATTERNS.md §7](../../design-system/workbench-market/PATTERNS.md)（菜单、焦点、状态持久化）。

| 文件 | 作用 |
|---|---|
| `restyle.py` | 改写台源码：色值按语义映射到 `--wm-color-*`（`<style>` 内写 `var()`，内联/脚本写字面值，因为 canvas/SVG 属性不认 `var()`）；字号吸附 12/14/16/20/24；字体族换 `--wm-font-sans/mono`；圆角吸附 4/6/8；深色台转浅色、去 `prefers-color-scheme: dark`；深色条带归 `nav-*`；写死的 `192.168.3.156:9800` 改同源；`<head>` 起始注入统一层 |
| `wm-ux.js` | 统一层的交互部分（随 `restyle.py` 内联进每个台）：页签语义与方向键、焦点补全、视图状态持久化 |
| `audit.js` | 预览页内审计：每个可见文字的实际对比度（含半透明叠底）、非栅格字号、菜单/页签/焦点计数 |
| `make_edits.py` | 把「线上源 → 产物」拆成 `app_draft_edit` 的 old_text→new_text 清单（相邻差异块合并、old_text 保证唯一），本地按序模拟应用必须逐字节还原产物 |
| `proxy.py` | 本地预览：`/new|old/apps/<slug>/` 用改后/改前文件，其余**只读**转发生产（POST 一律 403） |

## 用法

```bash
# 1) 抓线上台（首页 + 附属文件）到 apps/ 与 extra/<slug>/
# 2) 生成
python3 -I restyle.py web/src/tokens.css apps extra out
# 3) 预览与审计：python3 -I proxy.py <含 apps/ extra/ out/ audit.js 的目录>，打开 http://127.0.0.1:8791/new/apps/<slug>/，控制台执行 wmAudit()
```

## 发布（9800 本机 CLI，现行做法）

生产未部署 LayerFS，草稿通道不可用。在 9800 主机上运行 `publish_local.py`（默认演练，`--apply` 才发布，`--only` 限定范围）：本机非浏览器请求走回环信任写面，不需要管理口令。脚本按 `expected.json` 核对源与产物哈希，不一致即跳过。

Windows 上导出工具链用 `git -c core.autocrlf=false archive -o <tar> <提交> scripts/market-app-restyle web/src/tokens.css`，再 `tar -xf`；不要走 PowerShell 管道，也不要让 autocrlf 改写脚本与 token 文件（会使产物哈希失配）。

## 发布（生产 MCP 草稿通道，待 LayerFS 部署后可用）

前提：该台激活版已有 LayerFS Commit 锚（管理员 `POST /api/apps/<slug>/migrate-layerfs`），且属主已授权。

1. 发布前重新抓线上源再跑 `restyle.py` 与 `make_edits.py`（线上可能已更新，旧清单会对不上）。
2. 每台：`app_draft_open` → 按清单顺序逐条 `app_draft_edit`（任一条失败即停，不提交）→ `app_draft_submit`。
3. 发布后在门户入口上执行 `wmAudit()` 复测。

`restyle.py` 里的 `DARK`（深色台名单）、`OVERRIDE`（品牌色裁定）、`PATCH`（定点修正）是每台的人工裁定，新台接入时按审计结果补。

已知取舍：`factory-report-huashengweike-v1` 是按 A4 排版的报告文档，内部用缩放后的字号（非 6 档），只统一了色值与字体族。
