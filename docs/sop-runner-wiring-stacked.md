# SOP真实接线·叠加候选（默认关闭）

基于#296固定361e6719；新Draft叠加到feat/content-target-gate，不修改/合并原待属主审PR。首段只读真实index+Runner接线，后续每段另固定head复核。

## 显式配置

WM_SOP_CHANNEL_MODE缺省off，仅off/readonly有效，其他值拒启动。readonly要求WM_SOP_CHANNEL_MARKET_ORIGIN、WM_SOP_CHANNEL_ODOO_ORIGIN精确源（Odoo必须已在部署trusted origins），WM_SOP_CHANNEL_TARGETS=[{slug,targetId}]有限且无重复。WM_CONTENT_PORT缺省0及migrateBrowser缺省false不变；配置off不调用授权工厂、不新增其表或路由。

选中slug的GET/HEAD /sop/<slug>/?run=<id>&step=<key>在legacy Runner/parser/CORS前终结：核真实market surface/可信Host、如有Origin须精确匹配；run与step显式单值、闭集query，run归属slug匹配，随后新鲜Odoo与持久run ACL再核；未绑定旧run拒，不从started_by/node猜权。只发readonly preview，shell不带read能力、admin/上传/其他step值；正文opaque srcdoc、CSP禁网络。HEAD同授权逻辑。附件/POST以及选中target或实时登记URL投向已选slug的所有旧/go别名明确拒绝，不回legacy HTML/token注入，不把它称已启浏览器迁出开关。未选目标和modeoff保旧逻辑。

固定版本读取来自appsRoot/slug/v<runversion>/sop.yaml，不取active_version；slug/版本硬校，逐段lstat拒link/junction+realpath包含，open句柄有界1MiB/前后stat一致/UTF8 fatal，后端校已登记manifestSHA。不支持LayerFS冷物化；本地恶意写者TOCTOU/hardlink不是该读器OS级证明。

## 首段范围与未交

实际index已调用factory/handler，但仅在显式readonly开启；不挂save/upload/finish路由，不接运营授权登记入口、不迁移真实run、无自动登录回程/无缺run新建。file/write schema目前readonly renderer默认拒，不静默降权限或扩schema。模式已开但配置未登记run会403，是权威缺失明确拒，不拿fallback刷可用。

后续计划：受控后端登记target与可信Odoo主体/指派人、记录来源与权限；旧run迁移先方案+合成dry-run，不以用户可填标签猜身份。真实写路由/旧Redis共写与完成后受控回读另段实现。即使选中旧/go拒，原市场其他旧API仍未纳该新ACL治理，不宣全入口源隔离或旧写面已收口。

## ecbd旧门户别名修复

ecbd独立反例：target4已选但重复workbench5同/sop/slug/可匿名/go/5回旧active Runner，identity请求0；不是已证保存值泄漏。作者alias-before.log先红后改shared handler：每次/go/id查询当前workbenches.url，按legacy SOP解析匹配已选slug即拒，同时保配置ID拒，不关未选台；登记新别名/更新指向已选slug立即生效，移回未选台仍保正例。modeoff保原入口。

## 验证

sop-runner-wiring-test在自己生成的DATA_DIR/YGL_HOME/回环端口起完整index和fake Odoo，off核原Runner未变，受控合成ACL登记后readonly核run v3对active v9、other/unbound拒、schema/currentstep投影、Origin/null、portal/附件/POST拒；真实HTTP Chromium验证READY/disabled回填/opaque/script拒/HYDRATE/TEARDOWN。不是拦截页面，但身份/数据库全部合成，不是现网Odoo/生产验收。所有子进程仅保留句柄停止，不碰186180/3080/网络/LC/.88。
