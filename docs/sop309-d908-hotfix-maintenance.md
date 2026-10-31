# #309 d908窄热修候选与维护预案（未上线）

## 版本与代码边界

精确d9080a61cd5c6ca7e070cfa64971ffdb342f6f58新分支，只回移#310已验列表metadata白名单/steps、A2A status-note不重发token、管理页取消私有展开与随机新token签发。index仅三个局部：randomBytes签发、MCP list选择源后显式metadata、附件Content-Type固定application/octet-stream；原attachment/nosniff保。没有整覆index，不带main的R3 URL准入/驾驶舱/其他行为变化，不带#296/#308。

单项字段、附件list/download/HEAD匿名读权限本段仍旧，metadata修复不等#309全关闭。附件字节保持/原下载名保持，固定octet-stream不内联解释上传MIME，用户原本attachment下载方式不变；文件内容/MIME只能作为不可信元数据。

## 维护工具（默认dry-run）

scripts/sop309-maintenance.mjs强制显式绝对已有DB文件，不导入db.ts、默认readOnly/query_only；只输出strict状态摘要/行数/plan，不输出token明文或逐tokenhash。apply须当前plan及--ack-service-stopped-and-uploads-drained；该旗标不是批准或停机证明，必须人类批准和真实排空另证。

apply在BEGIN IMMEDIATE重读全部id/status/token及strict后比plan，**同一事务**设strict字符串1、给所有running run新32字节随机token、清nonrunning，故障整体rollback。不改data/status/业务时间。读WAL可触SHM元数据，dryrun只承诺无逻辑写，不宣物理零写。

使用方式（仅持权批准窗口执行，本轮不执行真实库）：


drain and stop approved old process first
node scripts/sop309-maintenance.mjs --db <ABSOLUTE_OFFLINE_DB>
node scripts/sop309-maintenance.mjs --db <ABSOLUTE_OFFLINE_DB> --apply --expected-plan <PLAN> --ack-service-stopped-and-uploads-drained


## 新冻结包与启动前置

scripts/sop309-freeze.mjs只从已提交干净source构建新tmp/sop309-frozen-candidates子目录，拒覆盖旧包；git archive source、复制原d908锁一致runtime依赖（不改原包）、单独新UI build，逐文件hash与包内link containment形成FROZEN-MANIFEST/sourceSHA/manifest摘要。不是发布或系统安装。

sop309-package-start.mjs默认只做包完整性/DB strict1/格式有效running token/端口空闲预检；--start另须owner批准ack，但ack字符串仍不是平台人类授权。只保前台自有子句柄，control0/MCPgatewayon/Redis空，拒已占业务和相邻端口，不杀外部PID、不写DB，不注册服务/WinSW。真实启动还需明确owner-approved existing HOME、安全admin-token DB-only记录，未验证管理员原客户端延续，不能冒连通已验。

**安全顺序细化：排空→停旧→离线strict1与重签同事务→预检→起新→现场核验。**派单描述先strict1、起新、再重签会出现旧暴露token仍有效的窗口；本候选选择在所有上传处理停下时一次完成strict+rotation，再起新。若属主必须按原顺序，应由外层继续封所有上传直到重签完成，不能开着业务窗口做“快速重签”。这是代码安全顺序，不扩授权；最终窗口确认会写清，不悄然执行。

## 失败与回退

15–30分钟窗口为估计、需本人另批并避开白天。停186180前需核固定原包/创建时间/端口owner、确认没有待提交上传；不凭旧PID盲杀。此脚本**不停止186180**。如果新包起不来或现场核失败，只停止本次候选自有进程，保持业务停机报告。保strict1及已重签token，不还原旧外露值、不降strict0、不自动起旧易受影响包；不覆盖/restore业务DB。原包/安全备份保留只供审计与人工回退决策，凭证不倒退。

对正在填SOP：已保存字段与历史附件保留；旧页/脚本缓存token上传401/403，刷新不会领新token，未提交附件需重新选择。字段保存合同本次不变，但维护停机期间请求失败；本地未提交内容需先自行保存/导出。没有匿名补领端点，受控补发/新run方案另定，不能在不可信页面输入管理员口令兜底。单项字段/附件匿名残余仍需第二阶段，轮换不是权限范围治理。

## 合成预演与限制

只在新合成DATA_DIR/HOME/回环随机端口预演control0、metadata、single残余、附件octet-stream/attachment/nosniff、strict0→1、old401/403/new201、UI双模式与失败停新/strict不降/新token保。BEGIN期间/末端故障回滚用内存SQLite，不连真实Redis/真实Odoo，不读生产库/token/backup。

完整旧E2E若断言依赖data展开必须对齐metadata；本分支不借main三绿/175章，专属CI与非作者包复核另读；本机不跑密集全E2E。所有包摘要需绑定最终source和UI构建来源。批准前没有生产动作、真实配置/真实令牌轮换、186180停止、网络/LC/.88/WinSW变更。
