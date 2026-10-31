# SOP真实接线·叠加候选（默认关闭）

基于#296固定361e6719；新Draft叠加到feat/content-target-gate，不修改/合并原待属主审PR。首段只读真实index+Runner接线，后续每段另固定head复核。

## 显式配置

WM_SOP_CHANNEL_MODE缺省off，支持off/readonly/显式editable，其他值拒启动。readonly要求WM_SOP_CHANNEL_MARKET_ORIGIN、WM_SOP_CHANNEL_ODOO_ORIGIN精确源（Odoo必须已在部署trusted origins），WM_SOP_CHANNEL_TARGETS=[{slug,targetId}]有限且无重复。WM_CONTENT_PORT缺省0及migrateBrowser缺省false不变；配置off不调用授权工厂、不新增其表或路由。

选中slug的GET/HEAD /sop/<slug>/?run=<id>&step=<key>在legacy Runner/parser/CORS前终结：核真实market surface/可信Host、如有Origin须精确匹配；run与step显式单值、闭集query，run归属slug匹配，随后新鲜Odoo与持久run ACL再核；未绑定旧run拒，不从started_by/node猜权。只发readonly preview，shell不带read能力、admin/上传/其他step值；正文opaque srcdoc、CSP禁网络。HEAD同授权逻辑。附件/POST以及选中target或实时登记URL投向已选slug的所有旧/go别名明确拒绝，不回legacy HTML/token注入，不把它称已启浏览器迁出开关。未选目标和modeoff保旧逻辑。

固定版本读取来自appsRoot/slug/v<runversion>/sop.yaml，不取active_version；slug/版本硬校，逐段lstat拒link/junction+realpath包含，open句柄有界1MiB/前后stat一致/UTF8 fatal，后端校已登记manifestSHA。不支持LayerFS冷物化；本地恶意写者TOCTOU/hardlink不是该读器OS级证明。

## 首段范围（37f固定head）与后续登记增量

实际index已调用factory/handler，但仅在显式readonly开启；不挂save/upload/finish路由，不接运营授权登记入口、不迁移真实run、无自动登录回程/无缺run新建。file/write schema目前readonly renderer默认拒，不静默降权限或扩schema。模式已开但配置未登记run会403，是权威缺失明确拒，不拿fallback刷可用。

后续计划：受控后端登记target与可信Odoo主体/指派人、记录来源与权限；旧run迁移先方案+合成dry-run，不以用户可填标签猜身份。真实写路由/旧Redis共写与完成后受控回读另段实现。即使选中旧/go拒，原市场其他旧API仍未纳该新ACL治理，不宣全入口源隔离或旧写面已收口。

## 新run属主登记增量（仍默认关闭）

另有WM_SOP_RUN_REGISTRATION缺省0，只有在mode=readonly或editable且显式1时才启POST /api/sop/channel/runs。真实market+精确Host/Origin（拒null）+JSON4KiB+自定义X-Sop-Channel-Request=create-owned-run+单头Cookie，body只准slug；targetId由部署allowlist决定，属主只来自同一个session epoch/generation识别的新鲜Odoo sub+uid。无admin凭据传frame、无客户端owner/assignee/runId/version/digest选择。

createOwnedRun仅创建NEW run，先核enabled target/ published SOP和当前materialized版本、原始YAML只读schema，BEGIN IMMEDIATE内run+ownerACL+manifestSHA+revision摘要同事务；不填started_by作授权，不初始派给他人。返回id/target/version/step/authorized与固定Runner路径，不回主体明细/cap。失败回滚，无现有run认领、绑定覆盖或任意binder HTTP/MCP面。

本入口给有效内部用户创建自己run的能力，开关仍属部署者显式控制；不是管理员指派他人的授权入口。assignee权威目录/受控指派链尚未接，旧run仅按sop-legacy-run-migration-plan方案+纯dry-run与合成测试，不触真实库；不能报全部归属运营治理已交。后端只读壳与绑定仍不等旧所有API/Redis写链收口。

## ecbd旧门户别名修复

ecbd独立反例：target4已选但重复workbench5同/sop/slug/可匿名/go/5回旧active Runner，identity请求0；不是已证保存值泄漏。作者alias-before.log先红后改shared handler：每次/go/id查询当前workbenches.url，按legacy SOP解析匹配已选slug即拒，同时保配置ID拒，不关未选台；登记新别名/更新指向已选slug立即生效，移回未选台仍保正例。modeoff保原入口。

## editable真实写接线与回读恢复（默认关闭）

显式editable才将save/upload/finish/recover四个固定端点挂到真实index前置路由，均精确market面/Host/Origin与独立能力头，真实Odoo/session/ACL/run/step/version逐次核。新run只在新存储登记后才有写能力；readonly不挂写，off仍零初始化。新创建模式schema可由服务器mode允许read/save/file声明，不允许客户端自选操作。旧归属迁移仍无apply，指派权威仍不接。

每次页面加载从fresh Odoo+绑定+SQLite固定版本重新投影已存字段/文件引用并签短期壳能力；重连online无本地dirty才自动回读，有dirty显示recovery_available不静默丢。显式“从服务端恢复（替换本地未保存值）”按钮才允许丢本地pending，独立recover能力向固定端点POST只读值；revision变化明确notice，采用server值与revision后发HYDRATE，ACK前iframe inert。file引用按服务端对象表去重，恢复同时清本地尚未上传选择；不重放旧File/旧写body。409/网络写失败有recovery能力时保frame/待存值但冻结自动写直到明确回读，不显示saved。过期/撤权拒恢复，需要重新受控加载，不滑动续期。

完成事务另记sop_channel_completions(run_id,acl_revision)，原run全部写/读cap仍吊销；同owner/assignee新鲜会话可在精确完成ACL revision上重新签只读recover，恢复已finished并禁全部控件，不重新发写cap。后续显式ACL撤销再推进revision使完成marker不匹配，连完成只读也拒；不把完成撤cap等同永久剥夺本人历史读权，也不恢复已撤写权。已提交但丢响应可刷新得到finished，不猜网络失败数据库未提交。

## 单写围栏与Redis边界

启用channel配置后，仅sop_run_access存在登记的run由新SQL通道持有；即使binding被撤销/finished也不回旧写。旧REST/MCP共core的step-save/finish、A2A note域服务SQL sink、旧附件SQL入库均拒409；core在Redis await前与后核，SopService runSaveData/runUpdateData/runFinish/runFileInsert同步写SQL前再核。旧run GET对这类run也拒，不能拿旧Redis值覆盖新通道快照。modeoff/未登记run保原链，不停用全部旧台。

redis.ts的runStateSave/Restore前与data hSet前围栏，managed load不读hot；旧active集合可以残留但不能成为新通道真源。极窄竞态中已经发送到真实Redis的旧命令不可撤回，本实现不声称Redis原子跨DB fencing；**安全边界是所有旧SQL sink拒入、回读永远SQLite+revision，新cap写不读取Redis**。Redis故障降级也不能绕SQL围栏。此处单进程map/generation和shared SQLite顺序不是多worker分布式一致性证明，不引入真实Redis配置/flush/生产迁移。

验证采用实际AST core、实际SopService同步方法与redis.ts转译后注入内存替身：注册前旧写正例、登记后前置拒、await中途登记阻checkpoint、旧hot读拒、off保原；替身只模拟方法/延迟，不证明真实Redis性能/协议/网络故障。完整隔离index用fake Odoo/新SQLite+真实HTTP/Chromium验证save/upload/重载、双页面revision读回notice/HYDRATE、finish/刷新finished、旧REST写拒与未登记正例。不是生产真实身份/部署验收。

## 验证

sop-runner-wiring-test在自己生成的DATA_DIR/YGL_HOME/回环端口起完整index和fake Odoo，off核原Runner未变，受控合成ACL登记后readonly核run v3对active v9、other/unbound拒、schema/currentstep投影、Origin/null、portal/附件/POST拒；真实HTTP Chromium验证READY/disabled回填/opaque/script拒/HYDRATE/TEARDOWN。不是拦截页面，但身份/数据库全部合成，不是现网Odoo/生产验收。所有子进程仅保留句柄停止，不碰186180/3080/网络/LC/.88。
