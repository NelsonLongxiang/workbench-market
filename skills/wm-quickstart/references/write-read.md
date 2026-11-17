# 写读全链（实测）

## 写
```
POST /api/apps/<slug>/data  body:{任意JSON}     → 201 {id}
POST /api/apps/<slug>/files multipart(file+note) → 201 {id,url,note}
MCP app_files_upload({slug,name,content_base64,sha256,note}) → 201 {id,sha256,integrity,next}
  带 sha256 → integrity=sha256-verified，服务端已核对，不用下载回读；没带 → 比对应答的 sha256 与本地即可
```
## 读
```
GET /api/apps/<slug>/data?limit=50   → {items:[{data,...}]}
GET /api/apps/<slug>/files?limit=50   → {items:[{name,url,note,...}]}
MCP app_data_list / app_files_list（agent 面·同库同源；用来找数据和文件，不是用来验证上传）
```
## SOP run 面
sop_run_start → step_save(任意键值·Redis 热+30s 沉淀) → run_get 读 → finish 封存
