#!/usr/bin/env bash
# A-Team 首次部署引导脚本（在目标服务器上以 root 执行）
#
# 职责：
#   1. 安装运行时依赖（Node.js 24、pnpm；不安装 nginx、不占用 80 端口）
#   2. 创建低权限服务账号与数据目录
#   3. 从 GitHub 初始化 /opt/ateam（兼容「已有旧部署、目录里没有 .git」的情况）
#   4. 安装 systemd unit 与 /etc/ateam/ateam.env
#   5. 安装依赖、构建前后端、启动服务并做健康检查
#
# 与 CloudNine 的差异：
#   - A-Team 直接监听 0.0.0.0:3002 对外提供服务，不引入 nginx 反代，
#     因此可以和同机的 CloudNine（占用 80）共存。
#   - Node 24 装到独立目录，不覆盖系统 /usr/bin/node，避免影响同机其他服务。
#   - data/ 与 workspaces/ 是 gitignore 的持久化数据，任何步骤都不得删除。
#
# 用法：sudo bash scripts/bootstrap.sh
set -euo pipefail

# ---------- 可覆盖配置 ----------
DEPLOY_DIR="${DEPLOY_DIR:-/opt/ateam}"
REPO_URL="${REPO_URL:-https://github.com/bytesfloow/ateam.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3002}"
SERVICE_USER="${SERVICE_USER:-ateam}"
SERVICE_NAME="${SERVICE_NAME:-ateam}"
SERVICE_HOME="${SERVICE_HOME:-/home/ateam}"
NODE_VERSION="${NODE_VERSION:-v24.21.0}"          # node:sqlite 需要 Node >= 24
NODE_DIR="${NODE_DIR:-/usr/local/lib/nodejs/node-${NODE_VERSION}-linux-x64}"
PNPM_VERSION="${PNPM_VERSION:-8.6.8}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo "[bootstrap $(date '+%H:%M:%S')] $*"; }
fail() { echo "[bootstrap ✗] $*" >&2; exit 1; }

node_major() {
  local v
  v="$("$1" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  echo "${v:-0}"
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

# ---------- 0. 前置检查 ----------
[ "$(id -u)" -eq 0 ] || fail "请以 root 运行（sudo bash scripts/bootstrap.sh）"

# 端口预检：服务自身在跑时端口由自己占用，属正常（后面会 restart）
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  log "$PORT 由已有 $SERVICE_NAME 服务占用，属正常"
elif port_in_use "$PORT"; then
  echo "[bootstrap ✗] 端口 $PORT 已被其他进程占用：" >&2
  ss -tlnp 2>/dev/null | grep ":$PORT " >&2 || true
  fail "请先停止占用进程，或修改 /etc/ateam/ateam.env 里的 PORT 后重跑"
else
  log "端口 $PORT 空闲"
fi

# ---------- 1. 系统包 ----------
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates build-essential python3 xz-utils >/dev/null

# ---------- 2. Node.js 24（独立目录，不动系统 node）----------
if [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge 24 ]; then
  log "Node $( "$NODE_DIR/bin/node" -v ) 已安装，跳过"
else
  log "安装 Node.js $NODE_VERSION (npmmirror 镜像)"
  mkdir -p /usr/local/lib/nodejs
  tgz="/tmp/node-${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL --retry 3 -o "$tgz" \
    "$NODE_MIRROR/$NODE_VERSION/node-${NODE_VERSION}-linux-x64.tar.xz" \
    || fail "Node 下载失败"
  tar -xJf "$tgz" -C /usr/local/lib/nodejs/
  rm -f "$tgz"
fi
[ -x "$NODE_DIR/bin/node" ] || fail "找不到 $NODE_DIR/bin/node"
ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
ln -sf "$NODE_DIR/bin/npm"  /usr/local/bin/npm
ln -sf "$NODE_DIR/bin/npx"  /usr/local/bin/npx
log "Node $(node -v)  npm $(npm -v)"

# ---------- 3. pnpm ----------
if command -v pnpm >/dev/null 2>&1 && pnpm --version 2>/dev/null | grep -q "^${PNPM_VERSION%%.*}\."; then
  log "pnpm $(pnpm --version) 已安装，跳过"
else
  log "安装 pnpm@$PNPM_VERSION"
  "$NODE_DIR/bin/npm" install -g "pnpm@$PNPM_VERSION" --registry="$NPM_REGISTRY" --no-audit --no-fund
  ln -sf "$NODE_DIR/bin/pnpm"  /usr/local/bin/pnpm
  ln -sf "$NODE_DIR/bin/pnpx"  /usr/local/bin/pnpx 2>/dev/null || true
fi
command -v pnpm >/dev/null 2>&1 || fail "pnpm 不可用"
log "pnpm $(pnpm --version)"

# ---------- 4. 服务账号与目录 ----------
log "创建服务账号与目录"
id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --home-dir "$SERVICE_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
# 只创建，绝不 rm -rf：data/ 与 workspaces/ 里是用户数据与任务工作区
mkdir -p "$DEPLOY_DIR" "$DEPLOY_DIR/data" "$DEPLOY_DIR/workspaces" "$SERVICE_HOME" /etc/ateam
chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR" "$SERVICE_HOME"

# ---------- 5. 代码（兼容旧 SFTP 部署留下的无 .git 目录）----------
# 目录属主是服务账号，root 跑任何 git 命令都会触发 dubious ownership 拦截，
# 必须在 git init / remote / fetch 之前放行，否则 exit 128。
git config --global --add safe.directory "$DEPLOY_DIR" 2>/dev/null || true
cd "$DEPLOY_DIR" || fail "无法进入 $DEPLOY_DIR"
if [ ! -d .git ]; then
  log "在 $DEPLOY_DIR 初始化 git 仓库（保留 data/、workspaces/、node_modules）"
  git init -q || fail "git init 失败"
fi
# 幂等：上次引导可能在 remote add 之前就失败了，这里补齐/纠正 origin
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL" || fail "git remote add 失败"
fi
git fetch --all --prune --quiet || fail "git fetch 失败（服务器能否访问 GitHub？）"
# -f：允许覆盖旧部署留下的同名未跟踪文件（package.json / pnpm-lock.yaml 等）
# gitignore 的 data/ workspaces/ dist/ web/dist/ node_modules/ 不受影响
git checkout -f -B "$BRANCH" "origin/$BRANCH" --quiet || fail "git checkout 失败"
git reset --hard --quiet "origin/$BRANCH" || fail "git reset 失败"
log "代码版本: $(git rev-parse --short HEAD)"

# ---------- 6. 运行参数 ----------
log "生成环境变量文件 /etc/ateam/ateam.env"
if [ ! -f /etc/ateam/ateam.env ]; then
  cat > /etc/ateam/ateam.env <<EOF
# A-Team 运行参数（systemd EnvironmentFile）
# 对外直接监听 3002；如需改端口，同步修改云安全组与部署脚本的 --app-port
PORT=$PORT
HOST=0.0.0.0
# 保持默认数据目录（\$DEPLOY_DIR/data 与 \$DEPLOY_DIR/workspaces），
# 与旧版 SFTP 部署一致，升级不会丢数据
EOF
  chmod 640 /etc/ateam/ateam.env
  chown root:"$SERVICE_USER" /etc/ateam/ateam.env
else
  log "已存在，保留不覆盖"
fi

# ---------- 7. systemd unit ----------
log "安装 systemd unit"
NODE_BIN="$NODE_DIR/bin/node"
[ -x "$NODE_BIN" ] || fail "找不到 node 可执行文件: $NODE_BIN"
sed \
  -e "s#@SERVICE_USER@#$SERVICE_USER#g" \
  -e "s#@DEPLOY_DIR@#$DEPLOY_DIR#g" \
  -e "s#@NODE_BIN@#$NODE_BIN#g" \
  "$SCRIPT_DIR/systemd/ateam.service" > "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

# ---------- 8. 依赖与构建 ----------
# 旧部署用 npm install 生成 node_modules；pnpm 遇到非自己管理的目录会报错或重装，
# 这里显式清理（构建产物可安全重建，数据目录不在其中）
if [ -d "$DEPLOY_DIR/node_modules" ] && [ ! -f "$DEPLOY_DIR/node_modules/.modules.yaml" ]; then
  log "清理非 pnpm 管理的 node_modules（旧部署遗留）"
  rm -rf "$DEPLOY_DIR/node_modules"
fi
log "安装依赖（含 devDependencies，构建需要）"
pnpm install --frozen-lockfile --registry="$NPM_REGISTRY" || fail "依赖安装失败"
log "构建前后端"
pnpm build || fail "构建失败"
[ -f "$DEPLOY_DIR/dist/server/src/index.js" ] || fail "缺少服务端产物 dist/server/src/index.js"
[ -f "$DEPLOY_DIR/web/dist/index.html" ]     || fail "缺少前端产物 web/dist/index.html"

chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR" 2>/dev/null || true

# ---------- 9. 启动与健康检查 ----------
log "启动服务 $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
# 健康检查用 /etc/ateam/ateam.env 里的真实端口（文件可能已存在且被改过）
APP_PORT="$(grep -E '^PORT=' /etc/ateam/ateam.env 2>/dev/null | cut -d= -f2 | tr -d '\r' || true)"
APP_PORT="${APP_PORT:-$PORT}"
HEALTH_URL="http://127.0.0.1:$APP_PORT/api/health"
ok=0
for i in $(seq 1 15); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    ok=1
    log "健康检查通过（第 $i 次尝试）"
    break
  fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  systemctl --no-pager --lines=15 status "$SERVICE_NAME" || true
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  fail "健康检查失败：$HEALTH_URL"
fi

systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true
log "引导完成。访问：http://<服务器公网IP>:$PORT/  （数据目录 $DEPLOY_DIR/data 已保留）"
