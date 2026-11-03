# 自产台统一层

把市场里的自产台（`/apps/<slug>/`）统一到 [DESIGN.md](../../DESIGN.md) token 与 [PATTERNS.md §7](../../design-system/workbench-market/PATTERNS.md)（菜单、焦点、状态持久化、应用外壳、只给业务看）。

台的源码在私有仓库 [`NelsonLongxiang/workbench-market-apps`](https://github.com/NelsonLongxiang/workbench-market-apps)，每台一个根目录；市场只从它的 main 同步（README「来源：GitHub main」）。

| 文件 | 作用 |
|---|---|
| `restyle.py` | 改写台源码：色值按语义映射到 `--wm-color-*`（`<style>` 内写 `var()`，内联/脚本写字面值，因为 canvas/SVG 属性不认 `var()`）；字号吸附 12/14/16/20/24；字体族换 `--wm-font-sans/mono`；圆角吸附 4/6/8；深色台转浅色、去 `prefers-color-scheme: dark`；深色条带归 `nav-*`；写死的 `192.168.3.156:9800` 改同源；`<head>` 起始注入统一层。已统一过的页面只换统一层（换层），正文不动 |
| `wm-ux.js` | 统一层交互（内联进每个台）：页签语义与方向键、焦点补全、视图状态持久化 |
| `wm-nav.js` | 应用外壳（按 `restyle.py` 的 `NAV` 表内联）：菜单分组、左侧目录、分组/全部视图；按台声明隐藏工程内容（`hideSections` / `hideNodes` / `hideColumns` / `hideFields` / `scrub`）、本台样式（`css`）和默认落点（`fallback`） |
| `audit.js` | 预览页内审计：每个可见文字的实际对比度（含半透明叠底）、非栅格字号、菜单/页签/焦点计数 |
| `proxy.py` | 本地预览：`/new|old/apps/<slug>/` 用改后/改前文件，其余**只读**转发生产（POST 一律 403） |

## 改一个台

```bash
# 1) 检出 apps 仓库，开分支
gh repo clone NelsonLongxiang/workbench-market-apps ../workbench-market-apps
git -C ../workbench-market-apps switch -c restyle/<slug>
# 2) 就地改写（--only 限定范围；不带就处理全部自产台，SOP 台与数据文件不动）
python3 -I scripts/market-app-restyle/restyle.py web/src/tokens.css --repo ../workbench-market-apps --only <slug>
# 3) 看 diff：已统一过的页面应只有 <head> 统一层那几行；新页面才是全套转换
git -C ../workbench-market-apps diff --stat
# 4) 桌面宽屏（1440×900）预览 + wmAudit() 对比度/字号审计，通过后提 PR、合 main
# 5) 上线：MCP app_sync（已绑定来源的台）或本机 CLI POST /api/apps/<slug>/sync
```

- 预览：把改后的文件按 `out/<slug>/<path>`、改前按 `apps/<slug>.html` + `extra/<slug>/<path>` 放进一个目录，`python3 -I proxy.py <该目录>`，打开 `http://127.0.0.1:8791/new/apps/<slug>/`，控制台执行 `wmAudit()`。
- 只按桌面宽屏设计与验收，不做手机视角。
- 页面的读者是业务人员：验证器、运维台账、task list、表单自查、技术说明不进页面（PATTERNS §7.4）。

## 人工裁定

`restyle.py` 里的 `DARK`（深色台名单）、`OVERRIDE`（品牌色裁定）、`PATCH`（定点修正）、`NAV`（各台分组表与隐藏清单）是每台的人工裁定，新台接入时按审计结果补。

- 换层识别统一层时容 `\r\n`：有的台在 Windows 上另存过，整页是 CRLF；换层后保持该页原有换行风格。读写一律 `newline=''`，不做换行转换。
- **报告类页面不改**（属主 2026-11-03）：`REPORT` 集合里的工厂报告（huashengweike-v1、liangchong-v5、pickleball-v3、verify-hswk）`--repo` 直接跳过。报告是排好版的成品文档，统一字号/配色会撑破版式。
- 渐变只压平全不透明的（按钮、横幅）；带 `transparent` / `rgba` 色标的是图片遮罩或线纹，原样保留——压平会让白字露在照片上。
- 写在自定义属性里的字号（如 `--vh-l0-size:22px`）同样吸附到六档。
