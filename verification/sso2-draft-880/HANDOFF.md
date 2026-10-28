# SSO2 草稿交接（检查点，不是冻结）
目标远端main d90f81abca809a48a893544d0bdd4c409be78526；源码归档来自此SHA，未切共享树。
原件单一源=本目录；TEST只审验/给反例，wm-review独立核后导入验证器库；不得复制后各改无版本。

## a/b/c 修订差分
- a: 新增audit_update_rejected、audit_delete_rejected两个独立AST候选与probe占位，要求真实快照DB触发器拒绝，非HTTP缺路由；映射#029 D8 / contract §8、§9补充行。
- b: 新增patch_missing_disabled独立AST候选，固定有效admin+合法Origin+{}→400、user_state_update deny恰1、零状态写；映射补充KBc3e0917349 / contract §7、§11。
- c: 冻结前固定proxy_P1_direct、proxy_P2_trusted、proxy_P3_forged三个ID，与D5三组逐项映射，不冻后换anchor。
a/b/c已进material/candidates/coverage；**对应真实子handler/fixture还没实现**，不是“已核证”。

## 门状态
- 完整#029+补充及contract固定blob原文已读并保留；49条映射（47本期/2延期），不缩scope。
- lint-candidates真实跑：{"checked":49,"ok":true,"p1_skipped":false,"schema_skipped":false,"issues":[]}；只证候选结构/锚点/DB schema，不证完整性/非空转守卫。
- node --check通过；隔离归档真实启动，listener PID核对；观测PASS1(boot)/FAIL12/NEEDS-MATERIAL34+DEFERRED2。
- 尚无reviews.json（禁止作者自签）、无submit/prepare/spec冻结、无check-construction/selfcheck/meta/归档完成。
- 候选每条独立sso2_eval_<id>空域给NM，good/bad/empty checker实际语义需独立核，当前不能报已通过。

## 已知失败与剩余
- 初次boot依赖express缺（测试归档pnpm相对链接），补server/root依赖junction后实跑；未动生产依赖。第二次重复close顶层await13已修；不会把过程错算业务红。
- probe中多数handler仅有部分负向断言，全部子控尚缺时任何全绿group强制NM；boot是唯一可以PASS的已完整handler。
- 缺：双闸完整矩阵/HTTP-WS正负/期限重启/锁桶代理/安全next完整组/DB口令和审计快照/禁用重启/映射/Odoo/旧面回归/正反空夹具。
- 材料草稿检查点已交；下一交付承诺 **2026-10-29 03:25+08**：补可执行子handler与夹具manifest到独立审可接状态；独立冻结时间由wm-review另估，不代承诺。
零SSO业务实现/生产env/部署；未冻结不能开工。
