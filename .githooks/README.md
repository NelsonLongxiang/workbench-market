# git hooks（机械化防线）

- `pre-push`：拒非 gavel 流直推 main（`ALLOW_MAIN_PUSH=1` 显式放行并留痕）
- 安装（每克隆一次）：`git config core.hooksPath .githooks`
