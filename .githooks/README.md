# git hooks（机械化防线）

- `pre-push`：拒非 gavel 流直推 main（`ALLOW_MAIN_PUSH=1` 显式放行并留痕）
- 安装（每克隆一次）：`git config core.hooksPath .githooks`

## 安全旗标 PR 必带对抗例组（总工 F5 新规·2026-10-28·#242 根因）

**任何安全面 PR（鉴权/CORS/SSRF/注入/令牌面）**在闸审时必须给出：
1. **对抗例组**（≥5 例·先红后绿）：现成件=`scripts/security-adversarial-smoke.mjs`（S1=SSRF 组：公网 CIDR/元数据 169.254/IPv6 字面量/数值 label/nip.io 变形/公网域名 + 内网对照放行）
2. **单例绿≠谓词对**：安全谓词必须正反双向覆盖（#242 教训：8.8.8.8 单例过闸→生产 6 例洞）
3. CI 已挂线（security-adversarial 步）· 新增安全面按组扩展该脚本
