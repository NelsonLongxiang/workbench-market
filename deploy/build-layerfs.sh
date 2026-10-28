#!/usr/bin/env bash
# #215 真镜像构建（本地检出·免 clone 凭证障）——两段：base(context=layerfs 检出) → final(context=market)
# 用法：bash deploy/build-layerfs.sh [layerfs 检出路径·默认 D:/workspace/layerfs]
set -euo pipefail
CTX="${1:-D:/workspace/layerfs}"
TAG="${LAYERFS_IMAGE:-wm-x-layerfs:test}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[build-layerfs] context=$CTX tag=$TAG"
if [ "${LAYERFS_COMMIT:-9f97a7ec}" != "9f97a7ec" ]; then
  echo "[build-layerfs] WARN override: LAYERFS_COMMIT=${LAYERFS_COMMIT} (pin 9f97a7ec; source=env:LAYERFS_COMMIT)"
  mkdir -p "$DIR/../tmp"
  node -e 'console.log(JSON.stringify({override: process.argv[1], tag: process.argv[2], source: "env:LAYERFS_COMMIT"}))' "$LAYERFS_COMMIT" "$TAG" >> "$DIR/../tmp/layerfs-commit-overrides.jsonl"
fi
PIN="${LAYERFS_COMMIT:-9f97a7ec}" # #215 X3：钉点校验（判据『ARG LAYERFS_COMMIT=9f97a7ec 且按它 checkout』）
HEAD_SHA="$(cd "$CTX" && git rev-parse HEAD 2>/dev/null)" || { echo "context 不是 layerfs 检出"; exit 2; }
case "$HEAD_SHA" in "$PIN"*) ;; *) echo "[build-layerfs] ✗ 检出 HEAD=$HEAD_SHA 非钉点 $PIN——请 (cd $CTX && git checkout $PIN) 后重跑"; exit 3 ;; esac
docker build -f "$DIR/Dockerfile.layerfs-base" "$CTX" -t wm-x-layerfs:base
docker build -f "$DIR/Dockerfile.layerfs" "$DIR/.." -t "$TAG"
echo "[build-layerfs] 完成。测试容器/卷用 wm-x- 前缀·跑完清理（docker ps -aq --filter name=wm-x- | xargs -r docker rm -f；docker volume ls -q --filter label=layerfs.role=store | xargs -r docker volume rm）"
