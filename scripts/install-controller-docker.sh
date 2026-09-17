#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

command -v docker >/dev/null 2>&1 || { echo "缺少 Docker" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "缺少 Docker Compose v2" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "缺少 openssl" >&2; exit 1; }

public_url="${PUBLIC_URL:-}"
if [[ -z "$public_url" ]]; then
  read -r -p "控制端 HTTPS 地址（例如 https://relay.example.com）：" public_url
fi
[[ "$public_url" == https://* ]] || { echo "生产环境控制端地址必须以 https:// 开头" >&2; exit 1; }

admin_user="${ADMIN_USERNAME:-admin}"
admin_password="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n')}"
session_secret="${SESSION_SECRET:-$(openssl rand -hex 48)}"

umask 077
cat > .env.controller <<EOF
ADMIN_USERNAME=$admin_user
ADMIN_PASSWORD=$admin_password
SESSION_SECRET=$session_secret
PUBLIC_URL=$public_url
PORT=18890
LISTEN_ADDR=0.0.0.0
DATA_DIR=/app/data
EOF

docker compose -f compose.controller.yml up -d --build
docker compose -f compose.controller.yml ps

echo
echo "控制端已启动在 127.0.0.1:18890"
echo "管理员账号：$admin_user"
echo "管理员密码：$admin_password"
echo "请立即保存密码，并配置 Caddy/Nginx HTTPS 反向代理。"
