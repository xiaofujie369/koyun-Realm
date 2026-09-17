# Koyun Relay V1

Koyun Relay V1 是一个可实际测试的最小转发闭环：网页控制端创建入口节点与 TCP 规则，Agent 拉取版本化配置并驱动 Realm。它不会修改现有 Nyanpass，可以独立部署验证。

## 第一版范围

已实现：

- 中文响应式管理面板；
- 管理员登录、登录限速和安全 Cookie；
- SQLite WAL 持久化；
- 入口节点创建与一次性 Agent Token；
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
- Agent：Node.js 22+ 与已安装的 Realm；
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

登录后先创建入口节点。节点 Token 只显示一次，应立即保存。

## 启动 Agent

### 推荐：Docker 自动安装

先在控制端面板创建入口节点并复制只显示一次的 Agent Token，然后在入口 VPS 执行：

```bash
apt update && apt install -y git curl ca-certificates python3
git clone https://github.com/xiaofujie369/koyun-Realm.git
cd koyun-Realm
chmod +x scripts/*.sh
bash scripts/install-agent-docker.sh
```

安装脚本会提示输入：

1. 控制端 HTTPS 地址；
2. 面板生成的 `kya_` Agent Token。

如果本机尚未安装 Realm，脚本会根据 CPU 架构自动下载最新 Linux 版本并安装到 `/usr/local/bin/realm`。

也可以使用环境变量进行非交互安装：

```bash
CONTROLLER_URL=https://relay.example.com \
AGENT_TOKEN='kya_替换为真实Token' \
bash scripts/install-agent-docker.sh
```

### Docker 手动方式

确认宿主机已有 `/usr/local/bin/realm`，然后：

```bash
cp deploy/agent.env.example .env.agent
```

填写面板显示的控制端地址与 Token：

```env
CONTROLLER_URL=https://relay.example.com
AGENT_TOKEN=kya_...
ENGINE=realm
```

启动：

```bash
docker compose -f compose.agent.yml up -d --build
docker compose -f compose.agent.yml logs -f --tail=100
```

Agent 使用 host 网络，因此 Realm 可以直接监听面板中配置的宿主机端口。

### systemd 方式

在项目目录中执行：

```bash
chmod +x scripts/install-agent.sh
sudo ./scripts/install-agent.sh
sudo nano /etc/koyun-agent/agent.env
sudo systemctl restart koyun-agent
sudo journalctl -u koyun-agent -f
```

systemd 方式要求宿主机已经安装 Node.js 22+。Docker 方式不需要宿主机安装 Node.js。

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
