# Koyun Relay V1

Koyun Relay V1 是一个可实际测试的最小转发闭环：网页控制端创建入口节点与 TCP 规则，Agent 拉取版本化配置并驱动 Realm。它不会修改现有 Nyanpass，可以独立部署验证。

## 第一版范围

已实现：

- 中文响应式管理面板；
- 管理员登录、登录限速和安全 Cookie；
- SQLite WAL 持久化；
- 创建入口节点后直接生成一键安装命令；
- 30 分钟短时效安装凭证，永久 Agent Token 不进入 Shell 历史；
- TCP 单跳规则创建、启用、停用与删除；
- Agent 每 10 秒同步配置并上报心跳；
- Agent Token 只保存 SHA-256 摘要；
- Realm TCP-only 配置生成；
- 配置临时文件、原子替换、启动观察和失败回滚；
- Agent 或容器重启后强制重新拉起 Realm；
- 内置 TCP 测试引擎和端到端自动测试。

暂不实现：UDP、多跳、反向隧道、负载均衡、在线流量统计、用户计费和 Nyanpass 数据迁移。这些留给 V2，避免扩大第一次测试范围。

## 架构

```text
浏览器 ──HTTPS──> Koyun Controller ──HTTPS + Agent Token──> Koyun Agent
                         │                                  │
                       SQLite                         Realm 子进程
                                                            │
用户 ─────────────────────────TCP───────────────────────────┴──> 目标地址
```

第一版的 Agent 部署在“入口 VPS”。规则中的目标地址可以直接填写国外 VPS 的 IP/域名和端口。

## 环境要求

- 控制端：Docker Compose，或 Node.js 22+；
- Agent：支持主流 Linux，使用 root 执行面板生成的一键命令；
- 生产环境控制端必须使用 HTTPS；
- 第一轮测试建议使用 10000 以上的监听端口，确认无冲突后再迁移正式端口。

## 启动控制端

### 推荐：Docker 自动安装

```bash
apt update && apt install -y git curl ca-certificates openssl
git clone https://github.com/xiaofujie369/koyun-Realm.git
cd koyun-Realm
chmod +x scripts/*.sh
PUBLIC_URL=https://relay.example.com bash scripts/install-controller-docker.sh
```

脚本会自动生成管理员密码和 Session 密钥、构建控制端并启动容器。执行结束时只显示一次管理员密码。

### 手动安装

```bash
cp deploy/controller.env.example .env.controller
```

编辑 `.env.controller`，至少修改：

```env
ADMIN_PASSWORD=一个至少16位的随机密码
SESSION_SECRET=一个至少48位的随机字符串
PUBLIC_URL=https://你的控制端域名
```

生成随机值可以使用：

```bash
openssl rand -base64 36
```

启动：

```bash
docker compose -f compose.controller.yml up -d --build
docker compose -f compose.controller.yml ps
```

控制端只映射到 `127.0.0.1:18890`，需要由现有 Caddy/Nginx 提供 HTTPS。Caddy 示例：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:18890
}
```

登录后创建入口节点，面板会立即显示 30 分钟有效的一键安装命令。

## 一键安装 Agent

安装过程不再要求用户手动安装 Git、Docker、Realm、Node.js或填写配置文件：

1. 登录控制端；
2. 创建入口节点，只填写服务器名称；
3. 点击“复制安装命令”；
4. 使用 root 登录目标 VPS，粘贴命令；
5. 等待约 10 秒，节点自动上线。

面板生成的命令类似：

```sh
tmp="$(mktemp /tmp/koyun-install.XXXXXX)" && (command -v curl >/dev/null 2>&1 && (curl -4fL --retry 2 --connect-timeout 8 --max-time 45 -o "$tmp" 'https://relay.example.com/install/kye_...' || curl -fL --retry 1 --connect-timeout 8 --max-time 45 -o "$tmp" 'https://relay.example.com/install/kye_...') || wget -T 15 -t 3 -O "$tmp" 'https://relay.example.com/install/kye_...') && sh "$tmp"; rc=$?; rm -f "$tmp"; exit $rc
```

安装器会自动完成：

- 识别 Debian、Ubuntu、Alpine、CentOS、RHEL、Rocky、AlmaLinux、Fedora、Arch Linux 和 openSUSE；
- 识别 `x86_64` 与 `ARM64`；
- 通过 `apt`、`apk`、`dnf`、`yum`、`pacman` 或 `zypper` 安装必要依赖；
- 安装并启动 Docker 与 Docker Compose v2；
- 自动下载适合当前架构的 Realm；
- 优先从控制面板域名下载 Koyun Agent，GitHub 仅作为备用源；
- 写入凭据并启动容器；
- 安装结束后检查 Agent 容器是否正常运行。

安装命令默认 30 分钟后失效。过期、重装或更换 VPS 时，在入口节点列表点击“安装命令”即可重新生成。只有新命令真正被执行时才会轮换旧 Agent 凭据。

安装日志和状态：

```bash
cd /opt/koyun-realm-agent
docker compose -f compose.agent.yml ps
docker compose -f compose.agent.yml logs -f --tail=100
```

## 第一次转发测试

假设：

- Agent 位于国内入口 VPS；
- 国外目标为 `203.0.113.20:443`；
- 准备用入口端口 `18443`。

在面板创建规则：

| 字段 | 值 |
| --- | --- |
| 入口节点 | 刚创建并部署 Agent 的节点 |
| 监听地址 | `0.0.0.0` |
| 监听端口 | `18443` |
| 目标地址 | `203.0.113.20` |
| 目标端口 | `443` |

约 10 秒后，节点的“应用版本/目标版本”应一致。然后从另一台机器测试：

```bash
nc -vz 国内入口IP 18443
```

如果目标是 TLS 服务：

```bash
openssl s_client -connect 国内入口IP:18443 -servername 目标域名
```

## 本机无 Realm 演示

内置引擎仅用于开发测试，不作为正式生产内核：

```bash
ADMIN_PASSWORD=test-password SESSION_SECRET=test-secret-please-change COOKIE_INSECURE=true npm run controller
```

另一个终端设置 Agent 环境，并使用 `ENGINE=builtin`。远程 HTTP 默认会被拒绝，只有本机或显式设置 `ALLOW_INSECURE_HTTP=true` 才允许。

## 验证

```bash
npm run check
npm test
```

自动测试包含真实 TCP 字节往返、端口冲突回滚，以及完整的“控制端 → Agent → TCP 目标”链路。

## 安全边界

- 不要把 `.env.agent`、`.env.controller` 或节点 Token 提交到仓库；
- 生产环境不要设置 `ALLOW_INSECURE_HTTP=true` 或 `COOKIE_INSECURE=true`；
- 控制端端口保持仅监听本机，通过 Caddy/Nginx 暴露 HTTPS；
- Agent Token 泄露时，V1 的处理方式是删除旧节点并创建新节点；
- 第一版 Agent 需要管理监听端口和 Realm 子进程，因此默认以 root 运行；systemd 已启用文件系统保护与 `NoNewPrivileges`。

## V2 预留方向

数据库与 Agent 协议已经保留 `desiredVersion/appliedVersion`，下一版可以在不推翻 V1 的前提下加入：出口节点、线路池、健康探测、最少连接调度、流量统计、Token 轮换和 Nyanpass API 适配器。
