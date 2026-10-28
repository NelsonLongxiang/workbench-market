# git hooks（机械化防线）

- `pre-push`：拒非 gavel 流直推 main（`ALLOW_MAIN_PUSH=1` 显式放行并留痕）
- 安装（每克隆一次）：`git config core.hooksPath .githooks`

## 安全旗标 PR 必带对抗例组（总工 F5 新规·2026-10-28·#242 根因）

**任何安全面 PR（鉴权/CORS/SSRF/注入/令牌面）**在闸审时必须给出：
1. **对抗例组**（≥5 例·先红后绿）：现成件=`scripts/security-adversarial-smoke.mjs`（S1=SSRF 组：公网 CIDR/元数据 169.254/IPv6 字面量/数值 label/nip.io 变形/公网域名 + 内网对照放行）
2. **单例绿≠谓词对**：安全谓词必须正反双向覆盖（#242 教训：8.8.8.8 单例过闸→生产 6 例洞）
3. **双面覆盖**：安全对抗=**输入对抗+环境对抗**。S2 Windows 路径形态：A 显式合成错误挂载源（已存在的错误目录），B 直接 argv 保真；不声称 Node 自动触发 MSYS。两侧均先验 setup exit=0、container Running、inspect 的 Type/Source/Destination 三元严格等于期望、exec true=0，再判 A socket test=1/约定退出码42、B socket test=0 + Docker API HTTP 200/OK + exec exit=0。检查器异常43不计作非 socket。原始命令/stdout/stderr/inspect/清理结果留档。
   - `F5_ENV_FACE_DOC=1` 只报 **NEEDS-MATERIAL**，不得产 PASS；Docker 缺失（包括 Linux）报 NEEDS-MATERIAL；非 Windows 且 Docker 可用报具名 **SKIP S2-WINDOWS-PATH-SHAPE**。摘要分列，不计入 PASS；NEEDS-MATERIAL exit=2。
   - 探针仅创建 `wm-x-f5-*` 容器；清理前核对本轮 label 与精确 ID，不动生产容器/卷。
4. CI 已挂线（security-adversarial 步）· 新增安全面按组扩展该脚本
