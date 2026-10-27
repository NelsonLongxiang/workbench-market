/** MCP 工具注册表（S3 抽离）：纯数据，供 /mcp 与网关授权面共用。 */
export const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [

  {
    name: 'workbench_list',
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
    description: '市场总览统计：总数/启用/在线/离线/未探测/平均延迟/分类聚合。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_check',
    description: '立即健康探测并回写状态：传 id 探测单个台；all=true 并发探测全部启用台。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '工作台 id' }, all: { type: 'boolean', description: '探测全部启用台' } },
      additionalProperties: false,
    },
  },
  {
    name: 'use_url',
    description: '取某工作台的访问入口：portal（/go/<id>/ 同源代理，自动带凭据/剥禁嵌头）与 direct 直连地址。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'app_publish',
    description:
      '发布/更新自产台（市场自己长台）：files=[{path,content}] 发上来即静态托管 /apps/<slug>/ 并自动入册，门户/市场立即可用；同 slug 重发=新版本快照。kind="sop" 走 SOP 台（须含 sop.yaml + changelog，首发 draft，需再调 sop_publish 上架）。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '小写字母/数字/连字符，≤64 字符' },
        title: { type: 'string', description: '显示名（首次发布必填）' },
        description: { type: 'string' },
        created_by: { type: 'string', description: '发布者标识（如 AI 会话名）' },
        code: { type: 'string', description: 'SOP 编号（如 SOP-OPS-001，kind=sop 时用）' },
        kind: { type: 'string', enum: ['app', 'sop'] },
        changelog: { type: 'string', description: '本版改了什么（kind=sop 必填）' },
        files: {
          type: 'array',
          description: '文件集（UTF-8 文本，单文件 ≤2MB；app 类须含根 index.html，sop 类须含 sop.yaml）',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      },
      required: ['slug', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'app_draft_open',
    description: '#94 P3 agent 工作区：从台当前头开草稿（LayerFS draft）',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  {
    description: '#94 P3：编辑草稿（old_text→new_text·apply 到草稿）',
    name: 'app_draft_edit',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, draft: { type: 'string' }, path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['slug', 'draft', 'path', 'old_text', 'new_text'] },
  },
  {
    name: 'app_draft_submit',
    description: '#94 P3：草稿合并回发布线→走发布门禁生成新版本并激活（同路径冲突 409 Conflict）',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, draft: { type: 'string' }, changelog: { type: 'string' } }, required: ['slug', 'draft'] },
  },
  {
    name: 'change_request_create',
    description: '#94 v3 S1 人审门：创建台回滚/删除请求（K10——批准前状态不变·批准经 REST 口令面）',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['app_rollback', 'app_delete'] }, target_type: { type: 'string' }, target_slug: { type: 'string' }, payload: { type: 'object' }, reason: { type: 'string' }, requested_by: { type: 'string' } }, required: ['kind', 'target_slug'] },
  },
  {
    name: 'change_requests',
    description: '#94 v3 S1：列人审请求（默认 pending）',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } },
  },
  {
    name: 'sop_publish',
    description: 'SOP 台上架：draft/deprecated → published（首次入册市场；note 记入当前版本 changelog）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, note: { type: 'string', description: '发布说明（可选）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'sop_run_start',
    description: '开一次 SOP 执行 run（钉当前版本；仅 published）——agent 更新持久化执行数据的入口，不触发版本发布。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, started_by: { type: 'string', description: '执行者标识（如 agent 会话名）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'sop_run_step_save',
    description: '更新 run 的持久化数据（stepKey→value 任意键值；与人在 Runner 页填数据同一条链：Redis 热写+30s checkpoint 沉淀 SQLite）。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' }, step_key: { type: 'string', description: '字母/数字/_/-（不必是 sop.yaml 里的步骤——数据面哑存储）' }, value: { description: '任意 JSON 值' } }, required: ['run_id', 'step_key'], additionalProperties: false },
  },
  {
    name: 'sop_run_get',
    description: '读 run 详情（热读优先，miss 回 SQLite 真源）——恢复执行现场。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' } }, required: ['run_id'], additionalProperties: false },
  },
  {
    name: 'sop_run_list',
    description: '列 SOP 执行记录（可按 slug/status 过滤）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, status: { type: 'string', enum: ['running', 'finished'] } }, additionalProperties: false },
  },
  // ── LayerFS 沙箱（第十域 · 步骤 4）──
  {
    name: 'sop_run_sandbox',
    description: '派发 SOP 步骤到 VM sandbox 容器执行（LayerFS）——返回 commit_hash（交付物=LayerFS Commit 引用）+ exit_code/stdout_tail/stderr_tail/duration_ms。bridge 不可达时 retryable。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'number', description: 'SOP run id' }, script: { type: 'string', description: '执行的 JS 脚本' }, image_tag: { type: 'string', description: '容器镜像（缺省 node:22-slim）' }, timeout_ms: { type: 'number', description: '超时毫秒（缺省 300000）' } }, required: ['run_id'] },
  },
  {
    name: 'sop_run_finish',
    description: '归档 run（热态全量沉淀 SQLite，Redis 条目平滑淘汰）。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' } }, required: ['run_id'], additionalProperties: false },
  },
  {
    name: 'app_data_list',
    description: '读自产台的表单提交数据（倒序游标分页）——台页面经 /api/apps/<slug>/data 提交的数据，agent 在这里消费。只读，与 GET 同权。',
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
    name: 'app_files_list',
    description: '读自产台的文件提交列表（倒序游标分页，含下载 url）——任意类型文件（≤50MB/个）。只读，与 GET 同权。',
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
  }  {
    name: 'app_files_upload',
    description: '向自产台上传文件（base64 内容·≤50MB/个）——agent 侧交付物直接入台文件面（与 REST multipart 同表同链）。返回 id/url/mime/note。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        name: { type: 'string', description: '原始文件名（含扩展名）' },
        content_base64: { type: 'string', description: '文件内容 base64（≤50MB 原始）' },
        mime: { type: 'string', description: 'MIME（缺省 application/octet-stream）' },
        note: { type: 'string', description: '备注（≤500 字·可 PATCH 更新）' },
        created_by: { type: 'string', description: '创建者标识（≤128 字符）' },
      },
      required: ['slug', 'name', 'content_base64'],
      additionalProperties: false,
    },
  },
,
  {
    name: 'workbench_register',
    description: '登记外部工作台入册（agent 发现内网新服务时自主登记；门户/市场即刻可用）。凭据不接受——需人工经市场页配置（安全边界）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, url: { type: 'string', description: 'http(s) 地址（自产台内部路径请用 app_publish）' },
        type: { type: 'string', description: '类型 key，默认 web' }, category: { type: 'string' }, description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, health_path: { type: 'string' }, sort: { type: 'integer' },
      },
      required: ['name', 'url'], additionalProperties: false,
    },
  },
  {
    name: 'workbench_update',
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
    description: '解除工作台注册（不删服务本体；驾驶舱面板引用联动清理）。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
  // ── 技能市场（P1-a · 方案 PR#57 §1：只读+计划生成，分发薄做） ──
  {
    name: 'skills_list',
    description: '列出市场技能（可按 layer 1-5 过滤：1业务角色/2开发运维/3工作流/4架构设计/5AI原生运营），返回 slug/name/layer/族/版本数——市场技能目录入口。',
    inputSchema: { type: 'object', properties: { layer: { type: 'number', description: '分层过滤 1-5（缺省全量）' }, q: { type: 'string', description: '名称/描述关键词' } } },
  },
  {
    name: 'skill_versions',
    description: '查某技能版本链（newest-first）：version/changelog/breaking/tree_digest/snapshot_path/reviewed_by——版本不可变审计面。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string', description: '技能 slug（如 agents:brand）' } }, required: ['slug'] },
  },
  {
    name: 'skill_install_plan',
    description: '生成安装计划（薄分发：不自动落盘）——返回目标版本 digest（expected sha256 钉装锚）+ 快照路径 + 手工安装指引。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, version: { type: 'number', description: '缺省最新' } }, required: ['slug'] },
  },

];