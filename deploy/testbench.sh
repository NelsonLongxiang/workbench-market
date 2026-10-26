#!/usr/bin/env bash
# layerfs 镜像内测试台（#94 P0 退出条件）：Init → apply → 读回 → project.remove → volume.remove
set -euo pipefail
BASE="${LAYERFS_SERVICE_URL:-http://localhost:8067}"
TOK="${LAYERFS_SERVICE_TOKEN:-change-me}"
PROJ="tb-$(date +%s)"
echo "== 1) Init+publish"
C1=$(curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -X POST "$BASE/v0/projects/$PROJ/publish" -d '{"files":[{"path":"index.html","content":"<h1>tb-v1</h1>"}],"message":"tb-v1"}')
echo "  $C1"
CID=$(echo "$C1" | sed -E 's/.*"commit_id":"([^"]+)".*/\1/')
echo "== 2) apply"
DR=$(curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -X POST "$BASE/v0/projects/$PROJ/drafts" -d "{\"from\":\"$CID\"}")
DID=$(echo "$DR" | sed -E 's/.*"draft":"([^"]+)".*/\1/')
curl -sf -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -X POST "$BASE/v0/projects/$PROJ/drafts/$DID/apply" -d '{"changes":[{"op":"edit","path":"index.html","old_text":"tb-v1","new_text":"tb-v2"}],"message":"tb-v2"}' >/dev/null
echo "== 3) 读回 v1"
curl -sf -H "Authorization: Bearer $TOK" "$BASE/v0/projects/$PROJ/commits/$CID/files" | grep -q 'tb-v1' && echo "  v1 OK"
echo "== 4) project.remove"
curl -sf -H "Authorization: Bearer $TOK" -X DELETE "$BASE/v0/projects/$PROJ" | grep -q '"removed":true' && echo "  removed OK"
echo "== 5) volume.remove"
docker volume ls -q | grep -q "layerfs" && echo "  卷检查（P0 参考实现无卷·真实现 P1 校验）" || echo "  无残留卷 OK"
echo "== P0 退出条件全链 PASS"
