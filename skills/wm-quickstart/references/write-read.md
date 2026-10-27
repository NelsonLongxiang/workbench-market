# 写读全链（实测）

## 写
```
POST /api/apps/<slug>/data  body:{任意JSON}     → 201 {id}
POST /api/apps/<slug>/files multipart(file+note) → 201 {id,url,note}
MCP app_files_upload({slug,name,content_base64,note}) → 201
```
## 读
```
GET /api/apps/<slug>/data?limit=50   → {items:[{data,...}]}
GET /api/apps/<slug>/files?limit=50   → {items:[{name,url,note,...}]}
MCP app_data_list / app_files_list（agent 面·同库同源）
```
## SOP run 面
sop_run_start → step_save(任意键值·Redis 热+30s 沉淀) → run_get 读 → finish 封存
