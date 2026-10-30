# 开发验证器 v69：判据65显式材料迁移

## 旧结论保留
固定产品e791057在旧v68正式run_77d4eeb3c83e410f为174 PASS/1 FAIL，归档arc_056468a4ebf3已验。唯一失败是判据65要求UseWorkbench.tsx内有字面/go/${w.id}/；M4已将门户构造移到components/GoFrame.tsx。不能往产品加注释字符串骗过提取，不改旧spec/snapshot/report或强写present=1。原e791启动包不变，不重包。

## 新口径与限度
175编号/条数不变，仅65的材料、候选及review逐字同步。新材料描述受限TSX结构：默认导入GoFrame、使用页顶层最终JSX return中的唯一GoFrame(wid=w.id)、组件顶层const src模板/go/${wid}/、组件顶层最终return内唯一iframe(src=src)。支持当前顶层变量声明和仅返回非门户JSX的early if guard；额外顶层return、嵌套block shadow/unreachable decoy等不支持形状拒绝。不是全CFG/通用数据流或运行行为证明，未尝试证明任意JS表达式的可达性；实际iframe/noopener/令牌拦截需E2E和浏览器冒烟互证。

源码事实键为版本化path链与needle，由scripts/portal-call-chain-fact.mjs计算；make-submission在全新快照从当前源计算present，不改产品或手工造事实。旧物理路径字符串不再是成功条件；comments、unused JSX或无用模板不能替代返回结构。

## 材料/冻结纪律
scripts/gen-verifier.mjs生成material/candidates/reviews及material-version.json（v69、supersedes v68、changed_criteria=[65]）。生成目录verify仍是忽略产物，PR提交源生成器，不手改已冻结spec。独立验证席对新材料重新submit→prepare产生新material/spec版本→新run→archive verify；新run只能说针对新材料通过，不能把旧174/1原样改口成175绿。

## 回归
node scripts/portal-call-chain-test.mjs：实际源码正例、raw URL iframe/移除GoFrame调用/组件不经/go三必红，另comments/unused/wrong import/id/spread/嵌套src遮蔽/提前return死代码反例；真实make-submission在独立synthetic DB与源码副本上分别提取0/1，检查175编号及三件套逐字一致。TypeScript用现有web依赖，无新增运行时产品依赖。测试不读取活库，不复制生产SQLite/WAL，不覆盖旧run和包。

测试fixture没有运行真实E2E，不能用其空构建/合成库宣完整175正式PASS；完整新版验收由独立席用真实提交物执行。最初解析依赖junction不足和CRLF导致mutation未命中是测试驱动故障，修正保留本机旧日志；独立预审发现shadow/deadreturn假绿后收紧，不改期望凑绿。
