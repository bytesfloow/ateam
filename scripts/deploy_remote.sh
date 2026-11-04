#!/usr/bin/env bash
# A-Team 远端部署脚本（在目标服务器上执行，通常由 deploy_ateam.py 通过 SSH 调用）
#
# 流程：拉取代码 → 安装依赖 → 构建前后端 → 重启服务 → 健康检查
# 任一步失败都会自动回滚到上一个可用版本（含代码与构建产物）。
# data/ 与 workspaces/ 是 gitignore 的持久化数据，全程不会被删除。
#
# 用法：
#   bash scripts/deploy_remote.sh             # 正常部署
#   bash scripts/deploy_remote.sh --no-build  # 跳过构建，仅重启（改了服务器配置时用）
set -Eeuo pipefail

# ---------- 可覆盖配置 ----------
DEPLOY_DIR="${DEPLOY_DIR:-/opt/ateam}"
SERVICE_NAME="${SERVICE_NAME:-ateam}"
SERVICE_USER="${SERVICE_USER:-ateam}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"
SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

log()  { echo "[deploy $(date '+%H:%M:%S')] $*"; }
# 任何失败都会回滚（含 `cmd || fail` 这种绕过 ERR trap 的写法）
fail() {
  trap - ERR
  echo "[deploy ERROR] $*" >&2
  if [ "${ROLLBACK_DONE:-0}" -eq 0 ] && [ -n "${PREV_COMMIT:-}" ]; then
    log "部署中断，触发自动回滚"
    rollback
  fi
  exit 1
}

cd "$DEPLOY_DIR" || fail "部署目录不存在: $DEPLOY_DIR"

# 部署目录属主是服务账号，以 root 跑 git 会触发 dubious ownership 拦截，
# 必须在任何 git 命令之前放行，否则连 git rev-parse HEAD 都拿不到。
git config --global --add safe.directory "$DEPLOY_DIR" 2>/dev/null || true

# ---------- 1. 记录当前版本（回滚目标）----------
PREV_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo '')"
if [ -z "$PREV_COMMIT" ]; then
  fail "无法读取当前版本（git rev-parse 失败），拒绝部署以免失去回滚能力；请先执行 bootstrap.sh"
fi
log "当前版本: $PREV_COMMIT"
ROLLBACK_DONE=0

rollback() {
  [ "$ROLLBACK_DONE" -eq 1 ] && return 0
  ROLLBACK_DONE=1
  trap - ERR                      # 避免回滚过程再次触发 on_error
  log "开始回滚到 $PREV_COMMIT"
  # 把分支指针也退回旧版本，避免下次部署又从「坏版本」的本地分支起步
  git checkout -f -B "$DEPLOY_BRANCH" "$PREV_COMMIT" --quiet 2>/dev/null || true
  git reset --hard --quiet "$PREV_COMMIT" 2>/dev/null || true
  # 构建产物不在 git 里：回退源码后必须重建，否则服务仍在跑新代码
  pnpm install --frozen-lockfile --registry="$NPM_REGISTRY" >/dev/null 2>&1 || true
  pnpm build >/dev/null 2>&1 || true
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR" 2>/dev/null || true
  systemctl restart "$SERVICE_NAME" || true
  log "回滚完成（服务已重启到 $PREV_COMMIT）"
}

on_error() {
  local rc=$? line=$1
  log "步骤失败（第 $line 行，退出码 $rc），触发自动回滚"
  rollback
  fail "部署失败，已回滚到 $PREV_COMMIT"
}
trap 'on_error $LINENO' ERR

# ---------- 2. 拉取代码 ----------
log "拉取最新代码 (origin/$DEPLOY_BRANCH)"
git fetch --all --prune --quiet || fail "git fetch 失败"
# 直接以远端引用重建分支：服务器上的部署目录不应有本地提交
git checkout -f -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH" --quiet || fail "git checkout 失败"
git reset --hard --quiet "origin/$DEPLOY_BRANCH" || fail "git reset 失败"
NEW_COMMIT="$(git rev-parse HEAD)"
log "部署版本: $NEW_COMMIT"
if [ "$NEW_COMMIT" = "$PREV_COMMIT" ]; then
  log "版本未变化，仍执行重启以确保服务状态干净"
fi

# ---------- 3. 安装依赖 ----------
# pnpm 的 store 缓存让重复安装很快；devDependencies 是构建必需的，不能 --prod
log "安装依赖 (pnpm install --frozen-lockfile)"
pnpm install --frozen-lockfile --registry="$NPM_REGISTRY" || fail "依赖安装失败"

# ---------- 4. 构建 ----------
if [ "$SKIP_BUILD" -eq 0 ]; then
  log "构建前后端 (pnpm build)"
  pnpm build || fail "构建失败"
  [ -f "$DEPLOY_DIR/dist/server/src/index.js" ] || fail "缺少服务端产物 dist/server/src/index.js"
  [ -f "$DEPLOY_DIR/web/dist/index.html" ]     || fail "缺少前端产物 web/dist/index.html"
else
  log "跳过构建（--no-build），使用现有产物"
fi

# ---------- 5. 修正属主 ----------
# node_modules / dist 由 root 写入，服务账号需可读写（智能体要写工作区）
if [ "$(id -u)" -eq 0 ]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR" 2>/dev/null || true
  log "已修正 $DEPLOY_DIR 属主为 $SERVICE_USER"
fi

# ---------- 6. 重启服务 ----------
# 端口预检：若端口被其他进程占用，重启后服务会进入崩溃循环且日志难查
APP_PORT="$(grep -E '^PORT=' /etc/ateam/ateam.env 2>/dev/null | cut -d= -f2 | tr -d '\r' || true)"
APP_PORT="${APP_PORT:-3002}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${APP_PORT}/api/health}"
if ! systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  if command -v ss >/dev/null 2>&1 && ss -tln "sport = :$APP_PORT" 2>/dev/null | grep -q LISTEN; then
    echo "占用者信息：" >&2
    ss -tlnp 2>/dev/null | grep ":$APP_PORT " >&2 || true
    fail "端口 $APP_PORT 已被其他进程占用，拒绝重启服务"
  fi
fi

log "重启服务 $SERVICE_NAME"
if ! systemctl restart "$SERVICE_NAME"; then
  rollback
  fail "服务重启失败，已回滚"
fi

# ---------- 7. 健康检查 ----------
log "健康检查: $HEALTH_URL"
ok=0
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    ok=1
    log "健康检查通过（第 $i 次尝试）"
    break
  fi
  sleep "$HEALTH_INTERVAL"
done

if [ "$ok" -ne 1 ]; then
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  rollback
  fail "健康检查失败，已回滚"
fi

# ---------- 8. 上报实际产物 ----------
MAIN_JS="$(ls -1 "$DEPLOY_DIR"/web/dist/assets/index-*.js 2>/dev/null | head -1 | xargs -r basename || true)"
log "完成。版本=$NEW_COMMIT 前端主包=${MAIN_JS:-<未构建>} 健康=ok 端口=$APP_PORT"
