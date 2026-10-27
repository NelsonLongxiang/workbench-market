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
