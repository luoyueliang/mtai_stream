#!/usr/bin/env bash
# ============================================================
# aistudio_stream 生产环境部署脚本
# 目标服务器: 47.94.7.102:15922 (ecs-user)
# 部署目录: /app/mtai_stream/  (PM2 管理，应用名 mtai-stream)
# 服务端口: 3100 (Nginx /stream/ → 127.0.0.1:3100)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_KEY="${HOME}/.ssh/mtai.pem"
SSH_HOST="47.94.7.102"
SSH_PORT="15922"
SSH_USER="ecs-user"
SSH="ssh -i ${SSH_KEY} -p ${SSH_PORT} -o StrictHostKeyChecking=no ${SSH_USER}@${SSH_HOST}"
RSYNC_E="ssh -i ${SSH_KEY} -p ${SSH_PORT} -o StrictHostKeyChecking=no"
EXCLUDE_FILE="${SCRIPT_DIR}/rsync-exclude.txt"
DEPLOY_DIR="/app/mtai_stream"
PM2_APP="mtai-stream"

# ---- 检查 SSH 密钥 ----
if [ ! -f "$SSH_KEY" ]; then
  echo "❌ SSH 密钥不存在: $SSH_KEY"
  exit 1
fi

# ---- Git 安全检查 ----
echo "🔍 [0/5] Git 安全检查..."
cd "$SCRIPT_DIR"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "❌ 当前分支是 '$CURRENT_BRANCH'，生产部署必须在 main 分支"
  echo "   请先: git checkout main && git pull"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作区有未提交的修改:"
  git status --short
  echo "   请先提交或暂存: git stash"
  exit 1
fi

echo "  📥 拉取远程最新代码..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "  ⚠️  本地落后于远程，自动合并..."
  git pull --ff-only origin main || {
    echo "❌ 无法快进合并，请手动解决冲突后重试"
    exit 1
  }
fi
echo "  ✅ Git 状态正常 ($(git log --oneline -1))"

# ---- 本地构建 ----
echo ""
echo "🔨 [1/5] 本地构建 TypeScript..."
cd "$SCRIPT_DIR"
npm run build
echo "  TypeScript 编译完成 → dist/"

if [ ! -d "$SCRIPT_DIR/dist" ]; then
  echo "❌ dist/ 目录不存在，构建失败"
  exit 1
fi

# ---- rsync 源码到服务器 ----
echo ""
echo "📦 [2/5] rsync 源码到服务器 ${DEPLOY_DIR}/..."
rsync -avz --progress -e "${RSYNC_E}" \
    --exclude-from="${EXCLUDE_FILE}" \
    --delete \
    "${SCRIPT_DIR}/" \
    "${SSH_USER}@${SSH_HOST}:${DEPLOY_DIR}/"

# ---- 上传编译产物 ----
echo ""
echo "📦 [3/5] 上传 dist/..."
rsync -avz --progress -e "${RSYNC_E}" \
    --delete \
    "${SCRIPT_DIR}/dist/" \
    "${SSH_USER}@${SSH_HOST}:${DEPLOY_DIR}/dist/"

# ---- 服务器端：同步 .env、安装依赖 ----
echo ""
echo "⚙️  [4/5] 服务器：同步 .env、安装依赖..."

if [ -f "${SCRIPT_DIR}/.env.production" ]; then
  rsync -az -e "${RSYNC_E}" \
      "${SCRIPT_DIR}/.env.production" \
      "${SSH_USER}@${SSH_HOST}:${DEPLOY_DIR}/.env.production"
  echo "  .env.production 模板已同步"
fi

${SSH} << 'REMOTE'
set -e
cd /app/mtai_stream

ENV_TEMPLATE="/app/mtai_stream/.env.production"
ENV_FILE="/app/mtai_stream/.env"

# 合并策略：保留服务端现有值，仅将模板中新引入的键追加进去
echo "  合并 .env（已有键保持不变，仅追加模板中新建的键）"
if [ ! -f "${ENV_FILE}" ]; then
  sed 's/[[:space:]]*#.*$//' "${ENV_TEMPLATE}" | grep -v '^$' > "${ENV_FILE}"
  echo "  .env 不存在，已从模板初始化"
else
  ADDED=0
  while IFS= read -r LINE; do
    STRIPPED=$(echo "$LINE" | sed 's/[[:space:]]*#.*//')
    [ -z "$STRIPPED" ] && continue
    KEY="${STRIPPED%%=*}"
    [ -z "$KEY" ] && continue
    if ! grep -q "^${KEY}=" "${ENV_FILE}" 2>/dev/null; then
      echo "${STRIPPED}" >> "${ENV_FILE}"
      echo "    + 新增键: ${KEY}"
      ADDED=$((ADDED + 1))
    fi
  done < <(sed 's/[[:space:]]*#.*$//' "${ENV_TEMPLATE}")
  if [ "${ADDED}" -eq 0 ]; then
    echo "  .env 无新键需要追加"
  else
    echo "  共追加 ${ADDED} 个新键"
  fi
fi

# 安装生产依赖
npm install --omit=dev
echo "  依赖安装完成"
REMOTE

# ---- 重启 stream 服务 ----
echo ""
echo "🔄 [5/5] 重启 PM2 进程 ${PM2_APP}..."
${SSH} << 'REMOTE'
set -e

pm2 restart mtai-stream
sleep 3
pm2 show mtai-stream | head -20

# 健康检查
sleep 2
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/health || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "  ✅ 健康检查通过 (HTTP $HTTP_CODE)"
else
  echo "  ⚠️  健康检查失败 (HTTP $HTTP_CODE)，查看最近日志："
  pm2 logs mtai-stream --lines 20 --nostream
fi
REMOTE

echo ""
echo "========================================"
echo "✅ aistudio_stream 生产部署完成！"
echo ""
echo "  版本:     $(node -p "require('./package.json').version")"
echo "  服务器:   ${SSH_USER}@${SSH_HOST} (port ${SSH_PORT})"
echo "  部署路径: ${DEPLOY_DIR}/"
echo "  服务端口: 3100"
echo "  外部访问: https://ai.mtedu.com/stream/"
echo ""
echo "  验证方式："
echo "    curl https://ai.mtedu.com/stream/health"
echo "========================================"
