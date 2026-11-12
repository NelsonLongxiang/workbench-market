/** MCP 工具注册表（S3 抽离）：纯数据，供 /mcp 与网关授权面共用。
 *  category：read 只读 / write 写业务数据 / admin 改市场配置或发布——供 access_info 目录与管理员审批参考。
 *  exempt：任何已认证会话都能调、不受 grants 限制（与 initialize、tools/list 同级），tools/list 始终列出。 */
import { BENCH_TOOL_DEFS } from './bench-mcp-tools.ts';

export type McpToolCategory = 'read' | 'write' | 'admin';
/** benchScoped：数据视图的工具，必须限定到台——授予不走会话的 grants，见 services/bench-mcp.ts */
export interface McpToolDef { name: string; description: string; category: McpToolCategory; exempt?: boolean; benchScoped?: boolean; inputSchema: Record<string, unknown> }
export const MCP_TOOLS: McpToolDef[] = [
  // ── 权限自助（免 grants）：看清自己能调什么、缺什么，再提申请等管理员批 ──
  {
    name: 'access_info',
    category: 'read',
    exempt: true,
    description: '查本会话的权限：会话名、已授权工具、完整工具目录（本地 + 上游聚合，每项带 category=read/write/admin 与 granted）、本会话提过的权限申请及状态。任何已认证会话都能调，不受授权限制——调用工具被拒或 tools/list 里找不到想要的工具时先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'access_request',
    category: 'write',
    exempt: true,
    description: '申请把目录里的工具授权给本会话（管理员在「MCP 网关」页批准后立即生效，批准是并入现有授权，不会收走已有工具）。tools 必须是 access_info 目录里的工具名；reason 必填（≤500 字），写清要做什么。同一组工具已有待批申请时返回那条，不重复建；每会话每小时最多 10 条。会话不能自己批准。',
    inputSchema: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string' }, description: '要申请的工具名（来自 access_info 目录）' },
        reason: { type: 'string', description: '用途说明（必填·≤500 字）' },
      },
      required: ['tools', 'reason'],
      additionalProperties: false,
    },
  },

  {
    name: 'workbench_list',
    category: 'read',
    description: '列出市场中的工作台（可按关键词/类型/状态过滤），返回 id/名称/类型/状态/延迟/地址/分类/启用——找台的入口。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（名称/地址/描述子串，不区分大小写）' },
        type: { type: 'string', description: '类型 key，如 web / ollama / market-app' },
        status: { type: 'string', enum: ['up', 'down', 'unknown'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_summary',
    category: 'read',
    description: '市场总览统计：总数/启用/在线/离线/未探测/平均延迟/分类聚合。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_check',
    category: 'write',
    description: '立即健康探测并回写状态：传 id 探测单个台；all=true 并发探测全部启用台。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '工作台 id' }, all: { type: 'boolean', description: '探测全部启用台' } },
      additionalProperties: false,
    },
  },
  {
    name: 'use_url',
    category: 'read',
    description: '取某工作台的访问入口：portal（/go/<id>/ 同源代理，自动带凭据/剥禁嵌头）与 direct 直连地址。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'app_sync',
    category: 'admin',
    description:
      '从 GitHub 仓库 main 分支同步自产台/SOP 台（属主 2026-11-02 来源收敛：自产台只接受仓库 main，不再收直接上传的文件）。先把改动合进该台登记的仓库 main，再调本工具；市场拉 main 头生成新版本并记下 commit。只能重拉已登记来源的台，绑定或改来源须本机 CLI 或管理员走 REST POST /api/apps/<slug>/sync。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '已登记 GitHub 来源的台' },
        changelog: { type: 'string', description: '本版说明（缺省为 [github] 仓库@main 短 sha）' },
        force: { type: 'boolean', description: '体积骤降 >50% 时显式确认' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'change_request_create',
    category: 'write',
    description: '#94 v3 S1 人审门：创建台或技能的回滚/删除请求（K10——批准前状态不变·批准经 REST 口令面）。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['app', 'skill'] }, op: { type: 'string', enum: ['rollback', 'delete'] }, slug: { type: 'string' }, target_version: { type: 'integer', description: 'op=rollback 时必填：要回滚到的版本号' }, reason: { type: 'string' }, requested_by: { type: 'string' } }, required: ['kind', 'op', 'slug'] },
  },
  {
    name: 'change_requests',
    category: 'read',
    description: '#94 v3 S1：列人审请求（默认 pending）',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } },
  },
  {
    name: 'sop_publish',
    category: 'admin',
    description: 'SOP 台上架：draft/deprecated → published（首次入册市场；note 记入当前版本 changelog）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, note: { type: 'string', description: '发布说明（可选）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'sop_run_start',
    category: 'write',
    description: '开一次 SOP 执行 run（钉当前版本；仅 published）——agent 更新持久化执行数据的入口，不触发版本发布。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, started_by: { type: 'string', description: '执行者标识（如 agent 会话名）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'sop_run_step_save',
    category: 'write',
    description: '更新 run 的持久化数据（stepKey→value 任意键值；与人在 Runner 页填数据同一条链：Redis 热写+30s checkpoint 沉淀 SQLite）。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' }, step_key: { type: 'string', description: '字母/数字/_/-（不必是 sop.yaml 里的步骤——数据面哑存储）' }, value: { description: '任意 JSON 值' } }, required: ['run_id', 'step_key'], additionalProperties: false },
  },
  {
    name: 'sop_run_get',
    category: 'read',
    description: '读 run 详情（热读优先，miss 回 SQLite 真源）——恢复执行现场。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' }, read_capability: { type: 'string', description: '#309 phase2 机器迁移：创建 run 时 sop_run_start/A2A start 响应返回的 run 级读能力（一次性明文）。无有效能力或授权时只回元数据（不含 data）。' } }, required: ['run_id'], additionalProperties: false },
  },
  {
    name: 'sop_run_list',
    category: 'read',
    description: '列 SOP 执行记录（可按 slug/status 过滤；按更新时间倒序，limit 缺省 50、最大 200，offset 翻页：回满 limit 条就继续取下一页）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, status: { type: 'string', enum: ['running', 'finished'] }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  },
  // ── LayerFS 沙箱（第十域 · 步骤 4）──
  {
    name: 'sop_run_sandbox',
    category: 'write',
    description: '派发 SOP 步骤到 VM sandbox 容器执行（LayerFS）——返回 commit_hash（交付物=LayerFS Commit 引用）+ exit_code/stdout_tail/stderr_tail/duration_ms。bridge 不可达时 retryable。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'number', description: 'SOP run id' }, script: { type: 'string', description: '执行的 JS 脚本' }, image_tag: { type: 'string', description: '容器镜像（缺省 node:22-slim）' }, timeout_ms: { type: 'number', description: '超时毫秒（缺省 300000）' } }, required: ['run_id'] },
  },
  {
    name: 'sop_run_finish',
    category: 'write',
    description: '归档 run（热态全量沉淀 SQLite，Redis 条目平滑淘汰）。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' } }, required: ['run_id'], additionalProperties: false },
  },
  {
    name: 'app_data_list',
    category: 'read',
    description: '读自产台的表单提交数据（倒序游标分页）——台页面经 /api/apps/<slug>/data 提交的数据，agent 在这里消费。只读；可以按台授权（app_data_list@台id 这种写法，台 id 是这个自产台在市场里的卡片）。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '自产台 slug' },
        limit: { type: 'integer', description: '条数（默认 50，上限 200）' },
        before_id: { type: 'integer', description: '游标：只取 id 小于它的记录（翻页用上一页的 next_before_id）' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'app_data_submit',
    category: 'write',
    description: '向自产台写一条表单数据（与台页面 POST /api/apps/<slug>/data 同一条写入链：1MB 上限、按台的 data-contract.json 校验、写入后照常推送事件）。不符合契约时返回 400 与逐条 violations。附件先用 app_files_upload 上传，再把返回的 id 放进 data.file_ids。带 idempotency_key 重试不会重复写：同键同内容返回原记录（duplicate=true），同键不同内容 409。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '自产台 slug' },
        data: { type: 'object', description: '记录内容（JSON 对象·≤1MB）' },
        created_by: { type: 'string', description: '提交者标识（≤128 字符·缺省为 mcp:<会话名>）' },
        idempotency_key: { type: 'string', description: '幂等键（1–128 个字母/数字/_ . : -）' },
      },
      required: ['slug', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'app_files_list',
    category: 'read',
    description: '读自产台的文件提交列表（倒序游标分页，含下载 url），用来找文件；验证刚上传的文件不需要它，上传应答自带核对结果。只读；可以按台授权（app_files_list@台id 这种写法，台 id 是这个自产台在市场里的卡片）。大文件用 REST 下载：GET /api/mcp-rest/apps/<slug>/files/<id>（同一会话令牌，二进制直出，支持 Range/ETag；入口见 access_info 的 rest_base 与 openapi_url）。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        limit: { type: 'integer', description: '条数（默认 50，上限 200）' },
        before_id: { type: 'integer' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'app_files_upload',
    category: 'write',
    description: '向自产台上传一个文件：content_base64 放文件内容（原始 ≤100MB），存进台的文件面，返回 id/url/mime/size/sha256/note/integrity/next。带上 sha256（推荐）或 size，服务端核对，不符就拒收、不保存（防客户端把长参数截短，base64 恰好 65536 字符又都没带时按疑似截断拒收）。成功应答的 sha256 是服务端对已保存字节算的，和本地文件一致就是完整的，不要为了验证再下载；integrity 为 sha256-verified 时服务端已替你核对过。超过几十 KB 的文件优先用 REST 原始字节上传：PUT /api/mcp-rest/apps/<slug>/files/<文件名>（同一会话令牌，不经 base64，可带请求头 X-Content-SHA256；入口见 access_info 的 rest_base 与 openapi_url）。剩余文件数看 app_files_list 的 quota。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        name: { type: 'string', description: '原始文件名（含扩展名）' },
        content_base64: { type: 'string', description: '文件内容 base64（≤100MB 原始）' },
        size: { type: 'integer', description: '原始字节数（与收到的内容不符即拒收；能带 sha256 就带 sha256）' },
        sha256: { type: 'string', description: '原始内容 sha256（64 位十六进制，推荐带：带了就由服务端替你核对，不符即拒收、不保存）' },
        mime: { type: 'string', description: 'MIME（缺省 application/octet-stream）' },
        note: { type: 'string', description: '备注（≤500 字·可 PATCH 更新）' },
        created_by: { type: 'string', description: '创建者标识（≤128 字符）' },
      },
      required: ['slug', 'name', 'content_base64'],
      additionalProperties: false,
    },
  },
  // ── 工作台变量与常量（#336：按 workbench id 隔离，SQLite 持久化，revision 乐观锁） ──
  {
    name: 'workbench_vars_get',
    category: 'read',
    description: '读某工作台的看板变量/常量：带 key 取单个（含 revision），不带 key 列全部（可按 prefix 过滤）。各台按 workbench id 隔离，自产台/SOP 台/外部台通用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '工作台 id' },
        key: { type: 'string', description: '变量键（缺省=列全部）' },
        prefix: { type: 'string', description: '列举时按键前缀过滤' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_vars_set',
    category: 'write',
    description: '写某工作台的看板变量（JSON 值）。新建可不带 revision（或 revision=0 表示仅在不存在时创建）；改已存在的键必须带当前 revision，不符返回 revision 冲突与当前值。kind=const 写入后不能直接改：谁写的谁维护——新建常量的会话是作者，作者本人带 override=true 与 reason 可修订；别人的常量改不了（作者缺失时由部署机本机命令行兜底）。作者本人修订时带 owner="*" 可把常量设成公共：之后任何 MCP 会话或 Odoo 登录带 override 与 reason 都能修订，台令牌仍不能写。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '工作台 id' },
        key: { type: 'string', description: '字母/数字/下划线开头，字母/数字/_ . : -，≤128 字符' },
        value: { description: '任意 JSON 值（≤64KB）' },
        kind: { type: 'string', enum: ['var', 'const'], description: '缺省 var；新建时给 const 即锁定' },
        revision: { type: 'integer', description: '期望的当前 revision（乐观锁）' },
        reason: { type: 'string', description: '变更说明（记入审计，≤200 字；修订常量时必填）' },
        override: { type: 'boolean', description: '修订常量时给 true（作者本人，或公共常量的任一会话）' },
        owner: { type: 'string', enum: ['*'], description: '只接受 "*"：作者本人把自己的常量设成公共（须同时带 override 与 reason）' },
      },
      required: ['id', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_register',
    category: 'admin',
    description: '登记外部工作台入册（agent 发现内网新服务时自主登记；门户/市场即刻可用）。凭据不接受——需人工经市场页配置（安全边界）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, url: { type: 'string', description: 'http(s) 地址（自产台走 GitHub main 同步 app_sync）' },
        type: { type: 'string', description: '类型 key，默认 web' }, category: { type: 'string' }, description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, health_path: { type: 'string' }, sort: { type: 'integer' },
      },
      required: ['name', 'url'], additionalProperties: false,
    },
  },
  {
    name: 'workbench_update',
    category: 'admin',
    description: '更新工作台配置（name/category/tags/description/enabled/health_path/sort/url）。不接受 auth——凭据变更人工操作；掩码 url 回传视为未变更。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, url: { type: 'string' }, category: { type: 'string' },
        description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' },
        health_path: { type: 'string' }, sort: { type: 'integer' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'workbench_unregister',
    category: 'admin',
    description: '解除工作台注册（不删服务本体；驾驶舱面板引用联动清理）。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
  // ── 技能市场（P1-a · 方案 PR#57 §1：只读+计划生成，分发薄做） ──
  {
    name: 'skills_list',
    category: 'read',
    description: '列出市场技能（可按 layer 1-5 过滤：1业务角色/2开发运维/3工作流/4架构设计/5AI原生运营），返回 slug/name/layer/族/版本数/active_version/current_version——市场技能目录入口。两个版本字段别混：active_version＝市场当前版本（回滚指针，不带版本号的取装/导出/下载/安装计划都取它，未回滚即最新版）；current_version＝本机钉装记录里的版本（未钉装为 null）。',
    inputSchema: { type: 'object', properties: { layer: { type: 'number', description: '分层过滤 1-5（缺省全量）' }, q: { type: 'string', description: '名称/描述关键词' } } },
  },
  {
    name: 'skill_versions',
    category: 'read',
    description: '查某技能版本链（newest-first）：version/changelog/breaking/tree_digest/snapshot_path/reviewed_by——版本不可变审计面；active=true 的是市场当前版本（active_version，回滚指针；回滚只移这个指针，不新增版本）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '技能 slug（如 agents:brand）' } }, required: ['slug'] },
  },
  {
    name: 'skill_file_put',
    category: 'admin',
    description: '技能上传第一步：一次上传一个文件（不收压缩包），暂存在市场上，返回 sha256/size/integrity/next。文本文件 content 直接给；二进制文件（图片/字体/模板）content 给 base64 并带 encoding:"base64"。带上 sha256（推荐），服务端核对，不符就拒收、不暂存。成功应答的 sha256 是服务端对暂存字节算的，和本地文件一致就是完整的，不要为了验证再取回；integrity 为 sha256-verified 时服务端已替你核对过。单文件上限 10MB。同内容重复上传幂等并续期，暂存 24 小时后清掉。全部文件传完后调 skill_publish 按 sha256 引用成版。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '缺省 utf8' },
        sha256: { type: 'string', description: '原始内容 sha256（64 位十六进制，推荐带：带了就由服务端替你核对，不符即拒收、不暂存）' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_publish',
    category: 'admin',
    description: '技能上传第二步（发版/更新）：用 skill_file_put 返回的 sha256 列出整棵文件树，一次成版。slug 不存在时建技能并发 v1，已存在时发新版本 N+1（旧版本不变）。有文件没上传或暂存已过期时报 400 并点名路径。SKILL.md 的 name/description/argument-hint 自动同步到技能信息。同一技能已有内容完全相同的版本时报 409。审计人记为本会话。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '小写字母数字开头·仅 [a-z0-9:_-]·≤64 字符' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string', description: '相对路径（/ 分隔，不许绝对路径或 . / .. 段）' }, sha256: { type: 'string', description: 'skill_file_put 返回的 sha256' } },
            required: ['path', 'sha256'],
            additionalProperties: false,
          },
        },
        changelog: { type: 'string', description: '本版说明（≤2000 字）' },
      },
      required: ['slug', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_download',
    category: 'read',
    description: '获取技能（安装/更新）：签发某版本（缺省市场当前版本 active_version：回滚后即回滚到的版本，未回滚即最新）的技能包下载链接，10 分钟有效、至多下载 5 次，过期或用满重新调用。包是 .tar.gz，顶层目录 package_dir（slug 的 : 换成 .），内含技能文件、清单 .wm-skill.json（逐文件 sha256 与整版 tree_digest）和校验脚本 .wm-skill-verify.mjs。安装步骤（经用户同意后执行）：下载到临时目录，先核对整包 sha256 等于应答的 package_sha256（不等就停，不解压）；解压后核对 .wm-skill-verify.mjs 的 sha256 等于应答的 verify_script_sha256（不等就停，不执行它）；再运行 `node <package_dir>/.wm-skill-verify.mjs --install --expect <应答的 tree_digest>`——包里清单的指纹与 --expect 不符、或文件与清单不一致、有符号链接/硬链接/设备文件、清单路径或目录名不合规，就整包拒绝、什么都不动；一致则把 ~/.workbench-market/skills/<package_dir> 的旧版本移进 ~/.workbench-market/skills/.backups/<package_dir>/（每个技能最多留 3 个），再整体换上新版本。返回里的 install_command 是这套步骤的一行 shell 写法。之后随时运行 verify_command 可列出本地被改动的文件。没设 MARKET_PUBLIC_URL 且请求主机不规范时不签发。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, version: { type: 'integer', description: '缺省市场当前版本 active_version（回滚指针，未回滚即最新版）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'skill_install_plan',
    category: 'read',
    description: '生成安装计划（薄分发：不自动落盘）——返回目标版本 digest（expected sha256 钉装锚）+ 快照路径 + 手工安装指引。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, version: { type: 'number', description: '缺省市场当前版本 active_version（回滚指针，未回滚即最新版）' } }, required: ['slug'] },
  },
  {
    name: 'skill_search',
    category: 'read',
    description: '语义搜技能：只描述需求（自然语言），评估模型按 P(true) 打分返回 ≤3 个置信度严格 >0.7 的技能（降序）。只读；不可用时**报错不降级**。',
    inputSchema: {
      type: 'object',
      properties: {
        need: { type: 'string', description: '需求描述（1–2000 字·自然语言）' },
        layer: { type: 'integer', description: '可选层过滤 1..5（缺省全层）' },
        top_n: { type: 'integer', description: '预筛 top-N（总工决策 #007 C 案·缺省 30·无硬上限·全并列不截断）' },
      },
      required: ['need'],
      additionalProperties: false,
    },
  },

  // ── 设计标准（DESIGN.md + PATTERNS.md 只读；agent 开发台/页面前先取） ──
  {
    name: 'design_standard',
    category: 'read',
    description: '读取工作台 design token 标准与页面模式（只读·唯一事实源 DESIGN.md + design-system/workbench-market/PATTERNS.md）：part=tokens 取结构化 token（颜色/字号/间距/圆角/阴影/动效/组件）；guide 取 DESIGN.md 各节规则；patterns 取菜单与目录、页面骨架、SOP 交付空间、列表、数据看板；all（缺省）全给。section 按标题关键词只取命中章节。返回含 version 与两份源文件 sha256。',
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'string', enum: ['all', 'tokens', 'guide', 'patterns'], description: '取哪部分（缺省 all）' },
        section: { type: 'string', description: '按章节标题关键词过滤，如「数据看板」「Colors」' },
      },
      additionalProperties: false,
    },
  },
  // ── 数据视图（必须限定到台；定义在 bench-mcp-tools.ts，入口 WM_BENCH_VIEWS 关着时不出现在目录里） ──
  ...BENCH_TOOL_DEFS,
];
