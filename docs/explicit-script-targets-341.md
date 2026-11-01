# #341 首批：HTTP 写脚本必须显式指定目标

范围只包括演示 SOP 种子和 LayerFS 迁移编排脚本，以及它们的合成测试/E2E 调用者。禁止将此首批改动称为全部危险缺省值已修；39处应用库快照源、技能导入与监督入口等仍由 issue #341 跟踪。现网 clean-r1 和冻结启动器不改。

## 调用契约

- scripts/seed-demo-sop.py：必须显式设置 SEED_BASE，且 CLI 指定 --target-mode isolated 或 production。没有9800回落。
- scripts/migrate-layerfs-p1.mjs：必须显式 --api 和 --target-mode；--dry 仍会读列表，因此不豁免目标检查。
- origin 必须是 http(s)://host:port，允许一个末尾/，不允许URL凭据、路径前缀、query、fragment或首尾空白；端口1–65535。
- isolated 只接受规范回环 127.0.0.1/localhost/[::1]，并拒绝9800/9801/3080。其它目标必须显式 production 加 --ack-production-target；此旗标只是防误触技术确认，**不是属主授权**。
- 目标或模式缺失、模式未知、未知/拼错CLI旗标，在任何HTTP前非零退出。Node迁移脚本拒绝重复选项，Python不接受缩写选项。
- 两个脚本都拒绝重定向，不把第一次请求的目标确认延伸到Location。迁移请求有10秒超时，脚本不自动重试或回退目标。
- Python种子直连显式目标，不继承HTTP代理；不从环境补Cookie、Bearer或管理口令。

隔离例（仅说明，未在生产运行）：

    SEED_BASE=http://127.0.0.1:<隔离端口> python scripts/seed-demo-sop.py --target-mode isolated
    node scripts/migrate-layerfs-p1.mjs --api http://127.0.0.1:<隔离端口> --target-mode isolated --dry

生产还须绑定真实目标与属主批准，显式 production/ack 不构成读写许可，也不自动证明端口对应已批准服务。isolated 是调用者声明加静态地址限制，并非通过端口就能证明没有业务数据；隔离实例仍由调用者自建专用 DATA_DIR/home。

## 验证

scripts/explicit-script-targets-test.mjs 实际运行脚本：所有否定用例替换HTTP入口，任何尝试打印HTTP_ATTEMPT，因此不会真正连接保留端口或远端；合法正例用自建回环随机端口服务。生产模式正例也只对合成服务，不发送生产请求。

87项包含：缺目标/模式/生产确认、保留端口、非回环、URL凭据/path/query/fragment/奇异IP/端口、未知参数、迁移重复目标、合法隔离发布与迁移、dry只读列表、显式production+ack合成正例、两脚本redirect拒绝且对端零请求。红先原件 tmp/explicit-script-targets-red.log；首绿因Windows Node强退活HTTP句柄触发UV assertion的失败保留，迁移改process.exitCode自然收尾后87/87且exit0。

E2E runner 已给 seed 显式 --target-mode isolated，仍用自己的 SEED_BASE/TMP data/home，不透传宿主工作区；新增回归接tsc-and-syntax CI，Python只用标准库。

## 事故与不确定项

所述seed事件已更正：报告的Node执行.py在新隔离复现时前置语法失败，没有证据表明发出生产POST；不因静态危险默认推定生产已被写。此PR不查生产日志/DB，不回滚/清理业务数据。

未完成清单不因本PR关闭：其他implicit server/data读取、用户目录技能导入、监督脚本点火、宿主YGL_HOME继承等须继续小批整改。没有安装服务/账号/计划任务，没有改PATH/profile或DSH源码。无新增业务口味判断点。
