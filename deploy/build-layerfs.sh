#!/usr/bin/env bash
# #215 真镜像构建（本地检出·免 clone 凭证障）——两段：base(context=layerfs 检出) → final(context=market)
# 用法：bash deploy/build-layerfs.sh [layerfs 检出路径·默认 D:/workspace/layerfs]
set -euo pipefail
CTX="${1:-D:/workspace/layerfs}"
TAG="${LAYERFS_IMAGE:-wm-x-layerfs:test}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[build-layerfs] context=$CTX tag=$TAG"
(cd "$CTX" && git rev-parse HEAD) >/dev/null || { echo "context 不是 layerfs 检出"; exit 2; }
docker build -f "$DIR/Dockerfile.layerfs-base" "$CTX" -t wm-x-layerfs:base
docker build -f "$DIR/Dockerfile.layerfs" "$DIR/.." -t "$TAG"
echo "[build-layerfs] 完成。测试容器/卷用 wm-x- 前缀·跑完清理（docker ps -aq --filter name=wm-x- | xargs -r docker rm -f；docker volume ls -q --filter label=layerfs.role=store | xargs -r docker volume rm）"
