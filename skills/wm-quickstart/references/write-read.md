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
MCP app_files_list({slug,ticket_for_id:<文件id>,max_uses?}) → {download_url,ticket_ref,file:{sha256,size,name},expires_in_seconds:120,max_uses}
  短时下载票：交给只管取件的工具（curl）用，GET download_url 即得这一份文件，不用会话令牌；2 分钟、默认 1 次（最多 5，Range 和条件请求各算一次），
  只绑这一份文件和发票的会话，不能列文件、读台数据或上传；会话吊销、授权收回、台重建、文件删了或换了，票立刻不能用（统一 404）；
  不要把票写进日志或回执；用完不再需要：app_files_list({slug,revoke_ticket:ticket_ref}) 撤销。取完拿应答里的 file.sha256 对一下
```
## SOP run 面
sop_run_start → step_save(任意键值·Redis 热+30s 沉淀) → run_get 读 → finish 封存
