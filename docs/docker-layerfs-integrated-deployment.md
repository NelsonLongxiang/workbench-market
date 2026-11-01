# Docker 部署规范：Workbench + 必需 LayerFS

状态：设计稿，待属主确认权限与存储契约；当前没有部署到任何节点。

## 目标 / 非目标

- 同一 Compose project 管理 Workbench 与真实 LayerFS 服务；正常 profile 必须同时启动，两者有健康依赖，缺配置/服务时 fail closed，不允许静默退化为“LayerFS 已部署”。
- LayerFS 只暴露在 Compose 私有网络，不发布宿主端口；Workbench 与 LayerFS 使用同一 LAYERFS_SERVICE_URL=http://layerfs:8067 和同一专用令牌。
- Web 与 LayerFS 数据分别持久化；备份、还原演练、版本/源 pin、SBOM 与 smoke 命令统一由 deploy 脚本执行。
- 不对 192.168.3.88 预备役生产节点进行 build/up、改配置或数据迁移，除非属主本人另行排期授权。

## 当前基线与阻断

1. workbench-market deploy/docker-compose.yml 中 LayerFS 在可选 layerfs profile；lifecycle-os 的生产工作台 overlay 没有 LayerFS service，Workbench 的 LAYERFS_SERVICE_URL 和 token 未注入。客户端代码已部署，但 LayerFS 没接通。
2. 真服务镜像固定 LayerFS commit 9f97a7ec95b662e9cb288704afa165feff132cfa，按 deploy/build-layerfs.sh 从独立 NelsonLongxiang/layerfs checkout 准备精确 pin context。源仓库体量很大；普通全量 clone 在本机失败，不能用未钉点/替身冒充真服务验收。
3. 现有 deploy/layerfs-svc.mjs 调 Docker Engine API 创建、删除每项目卷，当前 Compose 把 docker.sock 挂给 LayerFS；Docker socket 等价宿主 root。不得无提示地带进正式 Compose。
4. Workbench 当前 bridge 网络；LayerFS 只应加入同一内部网络，宿主不暴露 8067。9800 入口不改变；9801 控制面保持 loopback 设计。
5. 服务 token 当前可由环境变量注入，应改为 Docker secret 文件（至少 32 随机字节），禁止进入仓库、命令历史或日志。服务增加独立 /healthz（不回显 token）。

## 必须先裁决的安全选项：项目卷管理

### A. 首选：目录型项目隔离，取消 Docker API/socket

每项目存储放在 LayerFS 自己的 named volume 下（例如 /var/lib/layerfs/projects/<slug>/global/store.sqlite），项目删除只清理经过严格 slug 校验的 LayerFS 子目录和项目元数据，不删除 Docker volume。整套持久化由 layerfs-data 一个 named volume 承担。

- 优点：服务无 Docker socket、无宿主 Docker 数据目录挂载；备份恢复单卷可做一致性停机快照，Compose 简单。
- 影响：须经 LayerFS 上游/契约 owner 明确同意改变“每项目 Docker volume/volume_removed”语义，并验证 SDK 支持独立项目 Store 路径、删除后可重建、同名项目不复用残留；需新增回归测试。

### B. 可接受的过渡：受限 Docker API proxy

如每项目 Docker volume 是不能改的契约，增加独立 socket-proxy，只允许 volume create/delete 且 LayerFS 只能访问 proxy。不可直接把 docker.sock 挂给 LayerFS；proxy 镜像必须 digest pin，验证 API 白名单真实生效。

- 标准代理的 volumes API 可能操作任意宿主卷；需自建/审核细粒度代理，强制卷名 wm-<slug>-store 且只许 layerfs.role=store。无法独立审计就不得启用正式 profile。
- 没有属主裁决前不擅自改变现有卷契约或开放 Docker API。

## 目标 Compose 结构

- market：bridge network；仅发布 LC_LAN_BIND:9800。加入 Compose default（含 layerfs）与现有 Odoo jf-frontend；只挂 workbench-data 与生命周期所需密钥卷。LAYERFS_SERVICE_URL=http://layerfs:8067；令牌通过 secret 文件读取。depends_on.layerfs.condition=service_healthy。
- layerfs：从精确钉点 build context 构建；restart unless-stopped、非 root、只监听容器网络面 8067、不设 host port；挂 layerfs-data:/var/lib/layerfs；Secret 只读挂 /run/secrets/layerfs_service_token；healthcheck GET /healthz；无 Docker socket，除非采用审核方案 B。
- layerfs-data：命名卷，含 LayerFS Store、SDK project home 和 wm-adapter.sqlite；不与 workbench-data 或生命周期账本卷混用。
- workbench-data：独立保存市场 SQLite、活动 app 内容；禁用 down -v。
- .env 只提供 pin/context 路径和 bind IP 等非秘密值；secret 在宿主 deploy/secrets/layerfs_service_token，权限 0600、备份单独记录，不提交 Git。

## 部署与回滚命令契约

单入口脚本 deploy/wm-stack.sh 提供 config-check、build、up、health、smoke、backup、restore-check、rollback。所有子命令打印 Compose project、git SHA、镜像 digest，不输出 secret。up 拒绝脏树、未钉 LayerFS source、secret 缺失/弱口令或两服务不健康。

- 构建先执行 build-layerfs.sh <source> <new-context> --prepare-only，核验 manifest commit 等于 pin，再 docker compose build --pull；产出两镜像 digest 和 SBOM。
- up 需显式确认 release target，不允许脚本默认指向预备役生产节点。先 LayerFS healthy，再 Workbench；最后核对 API 到 LayerFS 的真实读写往返。
- 备份前停止所有写 LayerFS Store 的容器（至少 market 与 layerfs），打包 layerfs-data 与 workbench-data；记录镜像 digest、LayerFS pin、迁移版本。备份置于仓库外且至少一份异机。
- 还原到隔离 project/空卷，运行 SQLite integrity_check，做服务回读，并比较项目列表/commit/files hash；通过后才可切 active volume。回滚镜像不能降级/覆盖不兼容的数据 schema；有不兼容迁移先拒绝回滚并从备份恢复。

## 验收门槛

1. docker compose config --quiet；Compose graph 含两个必需服务、两个 healthcheck、无 8067 host publish、无 secret 明文 env。
2. docker inspect 证明 market/layerfs 均非 root；market 无 Docker socket、LayerFS 无 socket（A），或只连接已审核 proxy（B）。
3. anonymous 与错误 token 请求 LayerFS 都返回 401；正确 token 做 publish → 冷读 commit/files → draft/apply/merge；服务重启后仍读回相同 hash。
4. 在 Workbench app/version、skill 两条业务路径各做一个隔离 canary；确认 commit_id 持久化且从 LayerFS 冷读恢复。不得在生产业务项目造测试对象。
5. 删除测试项目后核对只删除该项目数据、其他项目可读；重启后同名项目可以重建。
6. 运行 layerfs-p0/p1/p2/s2/s3/s4、gateway-default、control-surface、market typecheck、security/adversarial 与 Compose 集成 smoke；全部通过才申请发布。
7. 进行真实 backup/restore-check；备份和检查通过才满足 release gate。

## 下一步

- 属主确认 A（优先，取消 socket）还是 B（限权代理并承担风险）。
- LayerFS 上游 owner 确认项目存储生命周期契约与固定 pin。
- 准备固定 LayerFS source checkout 和不触碰生产的候选 Docker 环境后，实现 Compose overlay、脚本与端到端测试，提 PR；当前节点不作候选环境。
