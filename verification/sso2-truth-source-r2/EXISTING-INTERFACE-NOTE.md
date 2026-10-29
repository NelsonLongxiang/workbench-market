# 受控确认包与最新revision：最小既有取件接口说明（含不可得点）

状态：**NEEDS-MATERIAL：治理输入未交付**。总工direct-a5a3cd3e已实答：无已核可交付的宿主raw确认包、受控人工确认包或revision取件定位。本轮查找结束，不再全机搜索/MCP重试/猜endpoint；只待属主受控确认或可核导出实际交付。这是能力事实与人工交付契约，不是新API实现或现成endpoint承诺。

## 1. 本轮实际核查（不读敏感宿主存储）

| 已声明接口 | 当前可拿到 | 不能据此证明 |
|---|---|---|
| a2a_whoami | 本席身份/在线/团队门 | 他席review原sender身份、审批独立性、最新治理revision |
| a2a_tasks | task定位、team/peer、brief、status、相关回执摘要 | raw入站字节hash、可核认证信封、治理授权/撤销台账最新性；taskID非签名 |
| a2a_status | 路由活动/健康 | 原始批准内容认证与revision |
| a2a_route | 可向已有治理角色发请求；有context/task定位 | Delivered不是批准/到件核验；返回正文team字段不是认证原证 |
| GitHub API固定comment/blob读 | 内容原件、仓库归属、版本时间/hash | 同login背后是哪席、身份独立、是否root治理确认、撤销revision最新 |
| ygl-trees kb show | KB规则全文与content_hash | KB自身不是审批认证或334控APPROVE |
| MCP resources/templates srv-41660f5da1860ed7 | 本轮返回server disconnected | 未取得工具/资源清单，不能断言未知服务有认证导出能力；不擅自改连接配置恢复 |

因此**未发现并未获给出**可机读的宿主入站原证导出＋受控最新revision读取接口。不是断言整个系统永远没有；只是本会话已声明工具/本轮文档没有提供该能力。

不去猜 /__dsh_a2a/* URL、不绕GUI鉴权直调、不读宿主session数据库或私钥；部署文档提到的内部路由名也不是本任务授权的稳定导出契约。

## 2. 目前最小实际可行入口：治理请求→受控固定交付（未到件）

### 2.1 请求接口（现在可用）

通过现有a2a_route向总工dsh/414d2b90发**来源确认请求**，或由属主在既有GUI/API直接确认。监督可以代转/保管，但不被默认为认证者。请求仅含：issue221、review引用与rawhash、作者源commit、contract/source_set/controls manifest hash、拟批probe/control清单、独立评审原件定位；不含secret。

该步骤只获得delivery/task/context定位。**本轮尚未收到具体受控确认包或revision指针**，不得生成verified entry。

### 2.2 治理方需要实际返回的最小交付内容（待交，不是作者自填）

- 确认包定位：受控只读文件交付/既有GUI/API记录定位，交付者与逐件来源确认者的不同职责。
- 属主GUI/API直确或宿主A2A原入站记录的可核定位、实际sender/角色/独立性，以及总工逐件确认原件引用。
- receipt rawhash、reviewed commit、contract/source_set/controls hashes、批准probe与完整control集合。
- 当前显式revision、有序前链/累计撤销适用范围、REVOKE/内容编辑/hash改变记录；revision是谁从哪个已有治理入口确认的。
- “这是当前最新受控清单”的本次开始/终结确认取件方式；不能只提供一个可能过期的repo/KB hash。
- 如果外部review没有宿主可核sender原证，给属主既有人工渠道对**该件**review/hash/独立性的直接确认，不创造自动映射。

固定文件可以存repo/KB或受限交付目录，但**认证来自治理入口的确认，不是其存放位置或hash**。runtime不能自己挑一个文件认作信任根。

## 3. 最新revision读取契约（只有人工/治理流程可请求，暂无机读实现）

开始时：请求“issue221 CONTROL_COMPLETENESS_ONLY、目标包与源控hash，给当前最新revision和适用撤销链”。取得具体治理确认后，由受控保管者交固定快照；记录原件hash、revision、前revision、确认定位。

终结时：沿同一治理入口再请求当前latest确认。若比开始revision新增撤销、修改被批内容或source/controls变动，结果失效/重审；不能以开始缓存当终结最新。若终结无法取证，保业务观察但不生成fresh批准/冻结结论。

此流程有人工成本，不是已实现的“自动轮询最新revision”服务；若后续要机读导出/装载，先具名接口与权限窄实现计划，不能本轮造新平台。不能用sleep/定时任务/自选TTL替代不可得最新性证明。

## 4. 具体不可得点与所需下一原件

| 缺项 | 影响 | 谁应给原件/确认 |
|---|---|---|
| 可核host入站record及rawhash/sender绑定的导出定位 | 路由摘要不能认证review来源 | 宿主治理方/总工；或属主本件人工直确 |
| 逐件角色映射/独立性确认 | login/team/前缀不能区分作者与独审 | 属主/总工依原证逐件确认 |
| 本件受控确认包固定清单 | runtime不能选择作者自填JSON | 治理方固定；监督仅保管转交 |
| 最新有序revision与撤销真源的实际获取方式 | 开始/终结无法证最新 | 属主/总工通过同一治理入口；未给前NEEDS |
| 完整334控的实际独立review批准 | 规则指定不是批准全控 | wm-review仅批实审范围，TEST审反例 |

本轮可完成的是准确记录规则并提出具体请求；**无可机读接口/安全交付尚未落实时首阻塞就是取不到受控已确认原件与最新revision**。不要把材料中字段齐全、schema静态校验通过、文件SHA一致叫“接口已打通”。

## 5. 审计与误用拒绝

收到新原件后，记录取件时间/来源定位/全部hash；不收新旧secret、私钥或签名材料。无源/无最新revision=NEEDS；工具/网络失败保ERROR。REVOKE同入口追加，旧原件留存；监督回执done表示收件，不代表认证/批准。本文未调用未知业务API，也未改宿主/连接/权限。
