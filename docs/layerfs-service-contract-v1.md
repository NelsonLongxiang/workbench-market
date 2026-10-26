# layerfs 服务契约 v1（#94 S2·项目+分支两级）

> v0（docs/layerfs-service-contract-v0.md）的修订版——D3 映射裁定：市场全量入 **单项目 `wm-skills`**
> （台=分支 `release`·技能=分支 `skill/<slug>`——数百技能每技能一项目开销太大·跨技能去重有用）。
> v0 端点保留一版过渡；新面一律 v1。

## 1. 两级路由

所有端点 `/v1/projects/{project}/branches/{branch}/…`（project/branch 均 URL 编码——`skill/` 斜杠必须 encodeURIComponent）。

| 分支 | 归属 |
|---|---|
| `release` | 台（app）物化版本链 |
| `skill/<slug>` | 技能版本链（rename 时随动） |

## 2. 端点

- `POST …/branches/{b}/publish` 体 `{files, message}` → `{commit_id, changed}`（同 v0 语义：同内容 changed:false 原头）
- `GET …/branches/{b}/commits/{id}/files` → `{files}`（冷回读）
- `POST …/branches/{b}/rename` 体 `{to}` → `{renamed}`（技能 slug 改名随动）
- `POST …/branches/{b}/merge` 体 `{into: "release"}` → `{commit_id}`；同路径冲突 `409 {kind:"Conflict", conflicts}`（草稿合并目标分支）
- `GET …/branches/{b}/commits/{id}/export` → 导出包面（**S3 预留**——v1 只占位）

## 3. 接入/鉴权/错误面

同 v0 §1/§7（Bearer·单次尝试·500/409/404 语义不变）。

## 4. 判据映射

- S2 承接：**K13**（技能入 LayerFS·摘要一致）+ L1/L2/L3/L7 的 v1 路径修正
- 后续：export→S3·rename→技能改名面·merge→草稿工作区（P3）
