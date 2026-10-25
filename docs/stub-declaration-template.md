# 替身声明模板（Stub Declaration Template）

> 适用：凡集成验证使用**替身**（stub/fixture/mock server）的冒烟与 E2E（origin：评审席 PR#49 深度抽检关缝件 ③，direct-65206a7e）。随件入仓，逐项填写；未声明的替身不得作为唯一验证依据进 PR。

```yaml
# ── 替身声明（每替身一份）──
stub_id: <唯一标识，如 omni-a2a-smoke/state-stub>
stand_in_for: <被替身的真实面，如 dsh-open-a2a-net /__dsh_a2a/state（X-API-Key 守护）>
replaces:
  scope: <替身覆盖的行为面，如 tasks[] 在途 + archived[] ≤64 newest-first>
  not_covered: <明确不覆盖的，如 鉴权失败路径以外的 5xx 语义 / 真实 ledger 状态机>
fixture_shape: <夹具形状与来源锚，如 PR#32/#35 合并版 src/index.ts archived 行字段；66 行 cap 边界>
gap_seams:                       # 关缝条件（替身与真实面的缝）
  - seam: <缝的描述，如 真实 /state 的 tasksRecent→archived 改名>
    closed_by: <关缝动作，如 FIELD 校准 d7573ca + 真实端到端 2026-10-25（a2a ok=true count=64 信封 128）>
    status: closed | open        # open 的缝必须列入 PR 描述的已知边界
real_e2e:                        # 真实端到端（有则填）
  when: <日期>
  env: <如 A2A_STATE_URL=http://127.0.0.1:3080 隔离实例>
  evidence: <观测值，如 sources.a2a.ok=true · count=64 · 信封 128 · 真实标题>
```

## 使用规约

1. **每个替身一份声明**，随引入替身的 PR 入仓（脚本头注释或本目录 yaml 附档）。
2. `gap_seams.status: open` 的缝 = PR 描述「已知边界」必列项；不得静默。
3. 真实端到端（`real_e2e`）是关缝的最强证据——替身全绿 + 真实端到端 = 完整；仅替身绿 = 不完整，评审席有权按「环境假绿」质询。
4. 夹具形状必须锚定上游真实源（版本/commit/行号），上游变更时本声明即差异排查起点。
