#!/bin/sh
set -eu

CONTROLLER_URL=__CONTROLLER_URL__
AGENT_TOKEN=__AGENT_TOKEN__
NODE_NAME=__NODE_NAME__
REPOSITORY_URL="https://github.com/xiaofujie369/koyun-Realm.git"
INSTALL_DIR="/opt/koyun-realm-agent"

log() {
  printf '\033[1;36m[Koyun]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[Koyun ERROR]\033[0m %s\n' "$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "请切换到 root 后重新执行安装命令（sudo -i）"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64|aarch64|arm64) ;;
  *) fail "暂不支持 CPU 架构：$ARCH（当前支持 x86_64 和 ARM64）" ;;
esac

if [ -r /etc/os-release ]; then
  . /etc/os-release
  OS_NAME="${PRETTY_NAME:-${ID:-Linux}}"
else
  OS_NAME="Linux"
fi
log "节点：$NODE_NAME"
log "系统：$OS_NAME / $ARCH"

install_dependencies() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y bash ca-certificates curl git python3 tar gzip
    PACKAGE_FAMILY="debian"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache bash ca-certificates curl git python3 tar gzip
    PACKAGE_FAMILY="alpine"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y bash ca-certificates curl git python3 tar gzip
    PACKAGE_FAMILY="rhel"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y bash ca-certificates curl git python3 tar gzip
    PACKAGE_FAMILY="rhel"
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm bash ca-certificates curl git python tar gzip
    PACKAGE_FAMILY="arch"
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install bash ca-certificates curl git python3 tar gzip
    PACKAGE_FAMILY="suse"
  else
    fail "无法识别包管理器；支持 apt、apk、dnf、yum、pacman、zypper"
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "检测到 Docker，跳过安装"
    return
  fi
  log "正在安装 Docker"
  case "$PACKAGE_FAMILY" in
    alpine)
      apk add --no-cache docker docker-cli-compose
      ;;
    arch)
      pacman -S --noconfirm docker docker-compose
      ;;
    suse)
      zypper --non-interactive install docker docker-compose
      ;;
    debian)
      apt-get install -y docker.io || install_docker_official
      ;;
    rhel)
      if command -v dnf >/dev/null 2>&1; then
        dnf install -y docker docker-compose-plugin || install_docker_official
      else
        yum install -y docker docker-compose-plugin || install_docker_official
      fi
      ;;
  esac
}

install_docker_official() {
      docker_script="$(mktemp)"
      curl -fsSL --retry 3 --connect-timeout 15 https://get.docker.com -o "$docker_script"
      sh "$docker_script"
      rm -f "$docker_script"
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  elif command -v rc-service >/dev/null 2>&1; then
    rc-update add docker default >/dev/null 2>&1 || true
    rc-service docker start
  elif command -v service >/dev/null 2>&1; then
    service docker start
  else
    fail "Docker 已安装，但无法识别服务管理器"
  fi
  docker info >/dev/null 2>&1 || fail "Docker 服务没有正常启动"
}

install_compose() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi
  log "正在安装 Docker Compose v2"
  case "$PACKAGE_FAMILY" in
    debian) apt-get install -y docker-compose-plugin >/dev/null 2>&1 || true ;;
    alpine) apk add --no-cache docker-cli-compose >/dev/null 2>&1 || true ;;
    rhel)
      if command -v dnf >/dev/null 2>&1; then dnf install -y docker-compose-plugin >/dev/null 2>&1 || true;
      else yum install -y docker-compose-plugin >/dev/null 2>&1 || true; fi
      ;;
    arch) pacman -S --noconfirm docker-compose >/dev/null 2>&1 || true ;;
    suse) zypper --non-interactive install docker-compose >/dev/null 2>&1 || true ;;
  esac
  if docker compose version >/dev/null 2>&1; then
    return
  fi
  compose_arch="$ARCH"
  case "$compose_arch" in amd64) compose_arch="x86_64" ;; arm64) compose_arch="aarch64" ;; esac
  compose_version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/docker/compose/releases/latest | sed 's#.*/##')"
  [ -n "$compose_version" ] || fail "无法获取 Docker Compose 版本"
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fL --retry 3 --connect-timeout 15 \
    "https://github.com/docker/compose/releases/download/$compose_version/docker-compose-linux-$compose_arch" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 安装失败"
}

install_dependencies
install_docker
start_docker
install_compose

log "正在从控制面板下载 Agent"
bundle_file="$(mktemp)"
if curl -fL --retry 3 --connect-timeout 15 "$CONTROLLER_URL/agent-bundle.tar.gz" -o "$bundle_file" \
  && tar -tzf "$bundle_file" >/dev/null 2>&1; then
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$bundle_file" -C "$INSTALL_DIR"
else
  log "控制面板安装包不可用，切换 GitHub 备用源"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPOSITORY_URL" "$INSTALL_DIR"
fi
rm -f "$bundle_file"

cd "$INSTALL_DIR"
chmod +x scripts/*.sh

if [ ! -x /usr/local/bin/realm ]; then
  log "正在自动安装 Realm"
  bash scripts/install-realm.sh
else
  log "检测到 Realm，跳过安装"
fi

umask 077
cat > .env.agent <<EOF
CONTROLLER_URL=$CONTROLLER_URL
AGENT_TOKEN=$AGENT_TOKEN
ENGINE=realm
REALM_BIN=/usr/local/bin/realm
STATE_DIR=/var/lib/koyun-agent
POLL_INTERVAL_MS=10000
ALLOW_INSECURE_HTTP=false
EOF

mkdir -p agent-data
chmod 700 agent-data

log "正在构建并启动 Agent"
docker compose -f compose.agent.yml up -d --build

sleep 3
if ! docker compose -f compose.agent.yml ps --status running | grep -q koyun-agent; then
  docker compose -f compose.agent.yml logs --tail=100 || true
  fail "Agent 没有正常启动，请将上面的日志发给管理员"
fi

log "安装完成：$NODE_NAME"
log "Agent 将在约 10 秒内显示在线"
log "查看日志：cd $INSTALL_DIR && docker compose -f compose.agent.yml logs -f --tail=100"
