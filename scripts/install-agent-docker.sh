#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "请使用 root 运行此脚本" >&2
  exit 1
fi

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

command -v docker >/dev/null 2>&1 || { echo "缺少 Docker" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "缺少 Docker Compose v2" >&2; exit 1; }

controller_url="${CONTROLLER_URL:-}"
agent_token="${AGENT_TOKEN:-}"
if [[ -z "$controller_url" ]]; then
  read -r -p "控制端 HTTPS 地址：" controller_url
fi
if [[ -z "$agent_token" ]]; then
  read -r -s -p "面板生成的 Agent Token：" agent_token
  echo
fi
[[ "$controller_url" == https://* ]] || { echo "控制端地址必须以 https:// 开头" >&2; exit 1; }
[[ "$agent_token" == kya_* ]] || { echo "Agent Token 格式无效" >&2; exit 1; }

if [[ ! -x /usr/local/bin/realm ]]; then
  "$project_dir/scripts/install-realm.sh"
fi

umask 077
cat > .env.agent <<EOF
CONTROLLER_URL=$controller_url
AGENT_TOKEN=$agent_token
ENGINE=realm
REALM_BIN=/usr/local/bin/realm
STATE_DIR=/var/lib/koyun-agent
POLL_INTERVAL_MS=10000
ALLOW_INSECURE_HTTP=false
EOF

install -d -m 0700 agent-data
docker compose -f compose.agent.yml up -d --build
docker compose -f compose.agent.yml ps
echo "Agent 已启动。查看日志：docker compose -f compose.agent.yml logs -f --tail=100"
