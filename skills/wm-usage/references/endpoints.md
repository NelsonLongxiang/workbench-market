# 常用端点（用户面）

| 动作 | 端点 |
|---|---|
| 首页/市场 | / |
| 使用台 | /use/<id> |
| 统一门户 | /go/<id>/ |
| 驾驶舱 | /cockpit |
| 技能市场 | /skills |
| 表单提交 | POST /api/apps/<slug>/data |
| 文件上传 | POST /api/apps/<slug>/files (multipart: file+note) |
| 文件列表 | GET /api/apps/<slug>/files |
| 文件下载 | GET /api/apps/<slug>/files/<id> |
| 数据列表 | GET /api/apps/<slug>/data |
