#!/usr/bin/env bash
# 共享检出互斥锁（监督席 direct-953ab4c0·总工裁 ③）：checkout/branch-switch 一律走本脚本。
# 协议：取锁（锁文件含 席名|分支|epoch）→ 切换 → 释放；冲突=退避+提示（超 10min 提示报总工）；
#      锁残留=启动清（owner 校验：锁主进程不在且年龄>600s 才清）。
# 用法：scripts/co-checkout.sh <branch> [--seat NAME] [--wait SECS] [--hold SECS] [--release-only]
set -u
LOCK=".git/wm-co-checkout.lock"
LOCK_MAX_AGE=600
BRANCH=""
SEAT="${WM_SEAT:-unknown-seat}"
WAIT=0
HOLD=0
RELONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --seat) SEAT="$2"; shift 2;;
    --wait) WAIT="$2"; shift 2;;
    --hold) HOLD="$2"; shift 2;;
    --release-only) RELONLY=1; shift;;
    *) BRANCH="$1"; shift;;
  esac
done

lock_read() { [ -f "$LOCK" ] && cat "$LOCK" 2>/dev/null || true; }
lock_owner_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
lock_stale_clean() {
  local content owner_pid ts now age
  content="$(lock_read)"
  # 只有目录没有锁文件=上次异常退出残留 → 清目录（无主）
  if [ -z "$content" ] && [ -d "$LOCK.d" ]; then
    echo "[co-checkout] 清理无主锁目录（无锁文件）" >&2
    rmdir "$LOCK.d" 2>/dev/null || true
    return 0
  fi
  [ -z "$content" ] && return 0
  owner_pid="$(printf '%s' "$content" | awk -F'|' '{print $4}')"
  ts="$(printf '%s' "$content" | awk -F'|' '{print $3}')"
  now=$(date +%s)
  age=$(( now - ${ts:-$now} ))
  if lock_owner_alive "$owner_pid"; then return 1; fi
  if [ "$age" -gt "$LOCK_MAX_AGE" ]; then
    echo "[co-checkout] 清理残留锁（owner pid=${owner_pid:-?} 不在·age=${age}s）: $content" >&2
    rm -f "$LOCK"
    rmdir "$LOCK.d" 2>/dev/null || true
    return 0
  fi
  return 1
}
lock_acquire() {
  if mkdir "$LOCK.d" 2>/dev/null; then
    printf '%s|%s|%s|%s\n' "$SEAT" "${BRANCH:-?}" "$(date +%s)" "$$" > "$LOCK"
    return 0
  fi
  return 1
}
lock_release() { rm -f "$LOCK"; rmdir "$LOCK.d" 2>/dev/null || true; }

if [ "$RELONLY" = "1" ]; then lock_release; echo "[co-checkout] 锁已释放"; exit 0; fi
[ -z "$BRANCH" ] && { echo "用法: scripts/co-checkout.sh <branch> [--seat NAME] [--wait SECS] [--hold SECS]" >&2; exit 2; }

lock_stale_clean || true
deadline=$(( $(date +%s) + WAIT ))
while :; do
  if lock_acquire; then break; fi
  cur="$(lock_read)"
  echo "[co-checkout] 锁被占用：$cur（等待中…）" >&2
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[co-checkout] 取锁超时（占用：$cur）——请催办占锁席；超 10 分钟未释放请报总工" >&2
    exit 3
  fi
  sleep 2
done
trap 'lock_release' EXIT INT TERM
echo "[co-checkout] 锁获取成功（$SEAT → $BRANCH）"
git checkout "$BRANCH" || { echo "[co-checkout] checkout 失败" >&2; exit 4; }
if [ "$HOLD" -gt 0 ]; then echo "[co-checkout] 持锁 ${HOLD}s（测试/长操作演示）"; sleep "$HOLD"; fi
echo "[co-checkout] 切换完成：$(git branch --show-current)"
