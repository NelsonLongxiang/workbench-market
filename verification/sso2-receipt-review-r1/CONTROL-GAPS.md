# #221 子控缺口矩阵 r1（仅提案，未批准／未执行）

原49单元不减：47本期、2延期。每项control_id及完整expected在CONTROL-GAPS.json。现有completion-policy仍49 PENDING、仅3条已有部分名字；本材料不写回可执行policy、不改变checker/handler。
历史状态仅引用d6ba8b0，不套v6或当前目标。单元入口存在、旧机制通过、此处列了清单均不证明产品已实现或子控已完成。

| 单元 | 来源 | 拟定子控数 | 原policy子控数 | 历史状态（非当前） | 当前缺口 |
|---|---|---:|---:|---|---|
| boot | §0 | 6 | 0 | PASS | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| switch_defaults | D1/D4 | 6 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| http_gate | D1/D2 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| ws_gate | D1/D2 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| internal_target | D1 | 6 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| machine_no_ticket | D2 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| machine_unavailable | D3 | 6 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| legacy_machine_config | D3 | 6 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| register_guard | D4 | 7 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| register_schema | D4 | 7 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| register_ui | D4 | 6 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| login_session | A1 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| me_invalid | A6 | 7 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| absolute_ttl | A4 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| multi_device_logout | A3/A5 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| password_storage | A1/A2 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| failure_same_bytes | A2/D5 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| lock_bucket | D5 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| proxy_direct | D5 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| proxy_chain | D5 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| proxy_invalid | D5 | 6 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| invalid_config | D4/D5/D6 | 8 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| canonical_origin | D6 | 8 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| secure_cookie | 补充1 | 5 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| next_validation | 补充4/B5 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| admin_disable | D7 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| disable_replay | D7 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| users_paging | D7 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_read | D8 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_append | D8 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_patch_invalid | 补充3 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_patch_valid | 补充3 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| json_parser_boundary | 补充3 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_navigation | D8 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_upgrade | D8 | 6 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_upstream | D8 | 6 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| mapping_modes | C1/C3 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| cookie_mapping | C1 | 8 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| odoo_compat | C2/D6 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| scope_preserve | D1/D2 | 7 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| config_guard | D1/D3 | 9 | 0 | FAIL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_update_rejected | D8/TEST-a | 5 | 4 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| audit_delete_rejected | D8/TEST-a | 5 | 4 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| patch_missing_disabled | 补充3/TEST-b | 6 | 5 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| proxy_P1_direct | D5/P1 | 5 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| proxy_P2_trusted | D5/P2 | 6 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| proxy_P3_forged | D5/P3 | 5 | 0 | NEEDS-MATERIAL | 独立审完整清单；name→control_id映射；前置；批准来源；执行/complete证据 |
| deferred_validator | D3延期 | 4 | 0 | DEFERRED | 延期域，不能计PASS |
| deferred_internal | D1延期 | 4 | 0 | DEFERRED | 延期域，不能计PASS |

## 共通缺口与依赖
- 可信确认者/宿主原件定位和装载规则须先定，不能Github前缀或同账号充身份。
- 所有control_id只是拟定稳定标识，落到实际handler与check.complete是后续具名实现任务，未经非作者核不设APPROVED。
- 历史register404仍阻账号/会话→HTTP-WS/锁桶/禁用/审计子行为；本轮不重跑或手造服务审计。
- DB物理映射/legacy迁移源/keyless正向发行/真实浏览器/合法机器scope/完整映射需独立夹具审验，不缩成已有负控。
- 49个执行完整性守卫继承v6机制域；其独立核通过不等49产品断言通过。
- 完整子控审核→trusted receipt→实现控映射/fixture→构造盲审红队/guard→new spec自检/meta→先红。任何缺门保持NOT_FREEZE_READY。
