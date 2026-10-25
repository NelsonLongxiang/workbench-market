# 技能市场（Skill Market）可行动实施方案 v1

> 派单 direct-f6c33264（监督席·主人令）· 事实源摸底：`~/.agents/skills`（101 目录，SKILL.md frontmatter：name/description/argument-hint/metadata{author,version}）· `jf-tech-expert-agents`（384 SKILL.md 散布 .agents/.claude/docs/packages；role bundle JSON 形态已见 apollo：bundle_version+roster_anchor sha256+prompt_stack soul）
> 主人裁定基线：版本管理先行、分发薄做（portal 浏览+手工落盘）；N+1 快照+changelog breaking 标记；promote 手动发布；发布口令门+首版人审。

## ① PR 切分（四轮，每轮独立可合并）

| PR | 内容 | 体量预估 | 依赖 |
|---|---|---|---|
| **P0-a 数据模型+导入器** | 四表 DDL + SkillService + 双源导入脚本（scripts/skill-import.mjs）+ 种子导入跑通 | ~600 行（含 DDL 150） | 无 |
| **P0-b 版本/发布面** | skill_versions 不可变写入门（发布口令+首版人审 flag）+N+1 快照+digest 计算 + promote 手动入仓（文件复制→发布流） | ~350 行 | P0-a |
| **P1-a MCP+管理页** | skills_list/skill_versions/skill_install_plan 三工具（只读+计划生成，不自动落盘——分发薄做）+ /skills 管理页（分层过滤/搜索/版本链/digest 展示） | ~700 行（web 为主） | P0-a/b |
| **P1-b 钉装与审计** | install_ledger 写入（expected sha256）+ @installed.json manifest 生成 + 装载校验命令（校验已装技能 digest 漂移）+ role-pack 装配（bundle→技能清单展开） | ~400 行 | P1-a |

一轮过大风险拆分说明：原案「P0+P1 一轮」≈2000 行，超单 PR 可审面——拆四轮，每轮冒烟+判据独立先红后绿。

## ② Schema（四表 DDL 草案）

```sql
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,                -- 市场内唯一（导入时 <source>:<name> 去重后定）
  name TEXT NOT NULL,                       -- frontmatter.name
  layer INTEGER NOT NULL,                   -- 1..5（业务角色/开发运维/工作流/架构设计/AI原生运营）
  layer_name TEXT NOT NULL,
  family_parent TEXT NOT NULL DEFAULT '',   -- 族父 slug（gitnexus 族：同族共享 parent，见③）
  description TEXT NOT NULL DEFAULT '',
  argument_hint TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,                     -- 'agents-skills' | 'jf-tech' | 'promote'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_skills_layer ON skills(layer);
CREATE INDEX idx_skills_family ON skills(family_parent);

CREATE TABLE skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  version INTEGER NOT NULL,                 -- N+1 单调递增（不 semver）
  changelog TEXT NOT NULL DEFAULT '',
  breaking INTEGER NOT NULL DEFAULT 0,      -- breaking 标记（装载校验时强提示）
  tree_digest TEXT NOT NULL,                -- 全树 sha256（身份锚，#42 铁律：同 digest=同内容）
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  snapshot_path TEXT NOT NULL,              -- DATA_DIR/skill-snapshots/<slug>/v<N>/（快照本体）
  reviewed_by TEXT NOT NULL DEFAULT '',     -- 首版人审者（首版必填，发布门）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(skill_id, version)
);
CREATE UNIQUE INDEX idx_skill_versions_digest ON skill_versions(tree_digest); -- 不可变+去重锚

CREATE TABLE role_bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id TEXT NOT NULL, member_name TEXT NOT NULL,
  bundle_version INTEGER NOT NULL,
  roster_digest TEXT NOT NULL,              -- 原 manifest sha256（对齐 jf 现有锚）
  prompt_soul TEXT NOT NULL DEFAULT '',     -- prompt_stack.soul（身份随包）
  skill_slugs TEXT NOT NULL DEFAULT '[]',   -- JSON 数组：上岗即装的技能清单
  snapshot_json TEXT NOT NULL,              -- bundle 快照原文（收编，不再回读活文件）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pack_id, member_name, bundle_version)
);

CREATE TABLE install_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL, version_id INTEGER NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expected_digest TEXT NOT NULL,            -- 钉装锚
  installed_path TEXT NOT NULL,             -- 实际落盘路径（~/.agents/skills/<name>）
  installed_by TEXT NOT NULL DEFAULT '',    -- 席位/会话
  status TEXT NOT NULL DEFAULT 'installed'  -- installed|revoked
);
```

**frontmatter 吸收映射**：name→skills.name；description→description；argument-hint→argument_hint；metadata.author→author；metadata.version→**不进 version**（导入首版 v1，此后 N+1 由市场管——外源版本号仅记 changelog 头行）。

## ③ 双源导入器（scripts/skill-import.mjs）

- **源 A `~/.agents/skills`**：逐目录读 SKILL.md frontmatter（灰度容错：无 frontmatter 目录跳过+报告）；layer=5（AI 原生运营 42 件按主人清点的白名单映射，其余归 5 待人审）；tree_digest=目录全文件 sha256 树（复用 #42 锚算法）。
- **源 B `jf-tech`**：`.agents/skills`（主）+`.claude/skills`（去重 by name）+ packages 子包（标 source=jf-tech:package）；**layer=1 业务角色层**；role_bundles 从 `.agents/role-*.json` 直读收编（apollo/dionysus 神谱束）。
- **family 关系（gitnexus 族）**：族判定=name 前缀/目录分组（导入器 `--family-map family.json` 人工维护映射，首版从目录名推断+人审修正）——同族 skills.family_parent 指族父 slug，族父自身也是 skills 行（virtual=1 不导入文件，仅聚合点——用 family_parent='' + 特殊 author='family-anchor' 标记）。
- 幂等：重复导入 by (source,name)→已存在则比 digest，同→skip，异→**不自动升版**（报 diff 待人走发布门）。

## ④ E2E/判据计划（先红后绿，逐 PR）

- **P0-a 判据（红→绿）**：四表存在；导入后 skills 计数=双源白名单和；slug 唯一；layer∈[1,5]；family_parent 环检测（导入器 validate）。
- **P0-b**：同 slug 二次发布→409（版本不可变）；digest 重复内容→复用行不新增；首版无 reviewed_by→发布门拒；N+1 严格递增。
- **P1-a**：MCP tools/list 含三工具；/skills 页分层过滤命中；版本链 changelog 展示。
- **P1-b**：install→ledger 行 expected=version digest；篡改已装文件→装载校验红；role-pack 展开清单=skill_slugs。
- **P1-b 装载校验边界（显式）**：市场侧=manifest 生成+校验 API+巡检（GET /api/skills/installed/verify 类），**不动 DSH catalog 消费端**——DSH 侧装载钩子属厚 P2，待真需求（薄分发裁定）。
- 冒烟：skill-import --dry-run 报告 + skill-smoke（发布/版本/钉装/校验各分支）；E2E 组 C17。

## ⑤ 边界与风险（如实）

1. **快照体积**：101+384 技能全量快照——估 300-800MB（部分技能带 scripts/templates/assets）。缓解：P0 只导**白名单五层清点件**（~100），jf 全量 384 中 docs/packages 遗产**只登记元数据不快照**（snapshot_path=''，标 legacy=1），promote 时才落快照。
2. **双源重名冲突**（如两仓都有 brand）：slug 规则 source 前缀（jf:brand）+ 白名单人审定夺，导入器报告冲突单。
3. **market 页挂载点**：/skills 新路由+菜单（App.tsx），与现五页并列；管理页只读为主（发布走 CLI/口令，不做页面写面——薄分发裁定）。
4. **digest 算法跨平台**（路径分隔符/换行）：树摘要按**排序后相对路径+内容**归一（#42 实现可直接复用市场的 tarball 锚思路）。
5. **与 #20 网关关系**：skill MCP 三工具挂现有 /mcp 面（loopback 免鉴/网关 Bearer 同规则），不另起面。
6. **主人裁定四条的落点**：分发薄=P1-a 只生成 install plan（含命令+expected digest），不自动写 ~/.agents；N+1=skill_versions.version；promote 手动=导入器只登记 promote 源，发布门同人审；口令门=复用 X-Admin-Token。

## 验收口径（建议）

P0-a 合并即可向主人交「市场有数据可看」；P1-b 合并交「信任链六环闭环演示」（发布→钉装→篡改→校验红→回撤）。
