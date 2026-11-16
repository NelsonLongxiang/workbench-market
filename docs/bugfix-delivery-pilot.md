# Bugfix 交付预检（试点）

这个入口只回答：**当前交付包是否仍是冻结判据指定的那一版，原生验证报告和归档是否可核对。**

它不会派工、修改事项、替人验收或部署。输出 PRECHECK_PASSED 只能作为送独立复验的材料，不能作为业务验收完成。

## 前置

- 已安装可用的 ygl-trees CLI；继续复用市场已有的 WM_YGL_CLI 入口配置，不自动安装。
- 一个已有且明确指定的隔离 ygl 工作区（包含 ygl-trees.db），不能拿个人或生产工作区做试验。
- 已通过现有 verify submit/prepare 冻结的**单一 file 身份判据**：一条 assert，checker 只允许 type、glob、sha256 以及严格等价的可选 require/min/max。glob 必须等于目标相对路径；sha256 必须为普通对象，且唯一自有键就是该路径。可选 require 只能为 [该路径]、min/max 只能为数字 1；其他字段、额外哈希键或 ignore 一律在调用 CLI 前拒绝，不通过删字段改写冻结判据。该判据不运行 command、agent、SQL 或业务模型。
- 调用方从经复核的材料取得交付 SHA、spec id/version 及 spec.json 字节 SHA；不得临时从可变文件算出新期望值来规避变化。
- 使用本地 SQLite。存在 YGL_DB_URL／YGL_PG_URL 时直接拒绝，不触及远端后端。

## 执行

从仓库根运行，尖括号内容替换为已核实输入：

~~~sh
node scripts/ops/bugfix-delivery-preflight.mjs \
  --home <已存在隔离工作区的绝对路径> \
  --submission <交付目录> --file delivery.tar \
  --sha256 <冻结的交付包SHA256> \
  --spec <已冻结spec_id> --spec-version 1 \
  --spec-sha256 <已复核spec.json的SHA256> \
  --db <只读业务快照.sqlite>
~~~

目录和快照可用相对路径；home 必须绝对路径。文件名相对 submission，使用正斜杠，不能含父目录、盘符、流名、glob 表达式或控制字符。路径有空格时用当前shell的正确引号；不复制未经检查的外部命令。

每次重新调用现有 ygl CLI 的 verify run（指定spec版本、快照与submission），核对持久报告及native扫描结果，再运行 verify archive verify。新报告、扫描记录和归档写入显式home，这是预期副作用；不写市场数据库、不访问网络、不运行交付包内容。

## 输出与退出码

stdout 为一个 JSON 对象，contract=bugfix-delivery-precheck/1：

| 状态 | 退出码 | 含义 |
|---|---:|---|
| PRECHECK_PASSED | 0 | 此时的包、spec版本、快照、报告及归档核对一致 |
| NOT_READY | 1 | 输入缺失／变化、判定非PASS、证据不匹配；不能送作当前通过依据 |
| INVALID_ARGUMENTS | 2 | 参数形状错误，未执行verify |
| UNAVAILABLE | 3 | CLI、运行过程或验证证据读取失败；不是业务FAIL |

成功结果给出 spec_id/spec_version、delivery_sha256、run_id、archive_id。所有结果均明确 human_acceptance=false、work_item_changed=false。不能仅看原生run退出0，也不能只看旧report的overall=PASS。

## 人与系统怎样配合

1. 开发席提交不可变交付包和引用；不把工作目录的Git提交号当作全部未提交字节的身份。
2. 预检通过后交非作者运维复验业务判据。运维复验结论绑定同一交付版本。
3. 真实有权限的人继续经现有工作台入口验收或退回；本脚本不替代其权限或决定。
4. 交付变更需要新版本、新证据；旧报告原样保留，不改写旧包／报告以假装仍通过。

## 限制

- 只证明版本一致，不证明交付业务正确、安全、来自谁，或存在独立评审。spec hash应来自可信复核材料，hash本身不是身份认证。
- 这是可信本地CLI的组合工具，不是沙箱或权限围栏。与同用户恶意进程竞争、核验后再修改的可变文件、目录重绑等不能靠前后hash消除。正式消费者仍应引用不可变制品，并在决定消费点复核；不得宣称已解决通用事项验收的原子性。
- 不接受多用途spec，避免“身份预检”顺带运行其他检查；不自动挑旧版本目录，当前spec.json与显式版本不一致时拒绝。
- 只能从配置的原生CLI取得报告；独立运维／人的最终验收需要另外真实完成，不能由脚本字段冒充。

## 开发验证

~~~sh
node scripts/bugfix-delivery-preflight-test.mjs
~~~

这是注入式原生结果的合成正反测试，不访问外部服务；覆盖改包、缺包、spec变化、旧版本、FAIL却exit0、错报告、错扫描、坏归档、运行中变更、外部后端与非法参数。真实CLI往返需另在经授权的隔离工作区运行上面的入口，不能用注入测试冒充。
