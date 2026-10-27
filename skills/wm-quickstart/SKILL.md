---
name: wm-quickstart
description: 工作台市场·快速开始构建——builder/agent 视角 15 分钟从零建台：登记外部工作台、发布自产台（全量+patch 增量）、文件/数据双通道、交付空间模式、发布纪律（served+1/60s 锁）、三闸。当需要「在市场上建一个台」「发布页面/交付物」「app_publish 怎么用」时加载。
---

# 工作台市场·快速开始构建（builder 15 分钟）

## 路线一：登记现成服务（1 分钟）
MCP `workbench_register({name, url, type:'web'})` → 自动探活入册 → /use/<id> 即用

## 路线二：发布自产台（核心·app_publish）
```
MCP app_publish({
  slug: 'my-app', title: '我的台',
  files: [{path:'index.html', content:'<h1>hello</h1>'}]
})
```
- 单文件静态托管 /apps/<slug>/ ·同 slug 重发=新版本快照
- **patch 增量**（省力·30KB 台别全量重发）：`base_version: N, patch: {set:[{path,content}], delete:[path]}` → 响应带 diff{added,modified,removed}
- SOP 台：kind:'sop'+sop.yaml+changelog

## 交付空间模式（数据+文件双通道·实战验证）
1. 页面表单 → /api/apps/<slug>/data（哑存储任意 JSON）
2. 文件上传 → /api/apps/<slug>/files（≤50MB/个+note 可改）
3. agent 读回 → MCP app_data_list / app_files_list
4. 页面引用资源用相对路径或 /go/<id>/ 前缀（iframe 代理坑）

## 发布纪律（血泪五条）
1. 发布前 GET served 基线 diff → 版本号 served+1
2. 60s 同 slug 异会话锁（409·hint 指引）
3. 发布门禁：空 content/体积骤降>50%/div 不配对=拒
4. 删除/回滚走 change_requests 人审（MCP 只能提）
5. 变更写 changelog

## 草稿流（大改走三分支）

## 快查
- 工具全景/鉴权/坑：`wm-market-guide`（深度参考）
- 判据：写读全链见 references/write-read.md


## sandbox 运行约束（#170 P11 / #198）

自产台页面在 `/apps/<slug>/` 下带 `CSP: sandbox`（**不助 allow-same-origin**）= 不透明源。后果：

- `localStorage/sessionStorage/IndexedDB` 抛 `SecurityError`——**不要用浏览器存储承载状态**（try/catch 降级）
- `self.origin === "null"`；跨源请求带 `Origin: null`、**无 Referer**
- `window.open` 弹窗继承 sandbox；`postMessage` 目标源只能 `'*'`，接收方用 `e.source === opener` 防冒充
- 下载（`allow-downloads`）正常

**交付空间模式（#198 恢复）**：页面调本台数据/文件接口需带注入的按台令牌——

```html
<meta name="wm-app-token" content="…">   <!-- 平台自动注入 -->
<script>window.WM_APP_TOKEN</script>     <!-- 也可读 -->
```

```js
fetch('/api/apps/<slug>/data', { headers: { 'X-App-Token': window.WM_APP_TOKEN } })
```

令牌与 slug 绑定、不可跨台复用；不带令牌的 `Origin: null` 请求会被浏览器侧拒绝。

## 单文件打包三步（推荐）

1. **环境注入不分叉源码**：页面读可选 `window.XX_ENV`（根路径/外链/内联资产），仓库内直开用默认值
2. **内联打包**：样式与脚本按原加载顺序内联进 `index.html`；校验脚本无 `</script`、样式无 `</style`；独立页（弹窗报告）作第二个文件
3. **本地预跑门禁 → 发布后冒烟**：空文件/div 配对/≤64 文件/≤2MB/路径合法，不通过不发；发布后 CDP 冒烟（数据量/样式/图片/弹窗 postMessage/无脚本异常·`/apps/<slug>/`、`/go/<id>/`、`file://` 各一遍）

> 发布门禁细节：div 配对按**正则计数整个 .html**（内联 JS 模板串里的 `<div` 也算）；v1 只收 UTF-8 文本——图片用 base64 `data:` URI 内联（体积 ×1.33，计入 2MB）。
