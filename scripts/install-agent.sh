#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="/opt/koyun-relay"
config_dir="/etc/koyun-agent"
state_dir="/var/lib/koyun-agent"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "请使用 root 运行此脚本" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "缺少 Node.js 22+" >&2; exit 1; }
node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
(( node_major >= 22 )) || { echo "Node.js 版本过低，需要 22+" >&2; exit 1; }
command -v realm >/dev/null 2>&1 || { echo "缺少 Realm，请先把 realm 二进制安装到 /usr/local/bin/realm" >&2; exit 1; }

install -d -m 0755 "$install_dir" "$config_dir"
install -d -m 0750 "$state_dir"
cp -a "$project_dir/package.json" "$project_dir/src" "$install_dir/"
install -m 0644 "$project_dir/deploy/koyun-agent.service" /etc/systemd/system/koyun-agent.service

if [[ ! -f "$config_dir/agent.env" ]]; then
  install -m 0600 "$project_dir/deploy/agent.env.example" "$config_dir/agent.env"
  echo "已创建 $config_dir/agent.env，请填写 CONTROLLER_URL 和 AGENT_TOKEN 后再启动。"
else
  echo "保留已有 $config_dir/agent.env"
fi

systemctl daemon-reload
systemctl enable koyun-agent.service
echo "安装完成。配置后运行：systemctl restart koyun-agent"
