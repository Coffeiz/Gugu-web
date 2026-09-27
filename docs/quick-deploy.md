# Gugu 部署指南

这是一份面向普通使用者的简版部署说明。生产环境的反向代理、权限、备份和故障排查见[运维部署文档](ops/deploy.md)。

## 前置要求

- Docker 20+
- Docker Compose v2.20+
- 一个可访问的模型 Provider，或准备好的 BYOK 配置
- 能访问镜像仓库和模型服务的网络

## 快速启动（默认一体化 Compose）

不需要克隆源码仓库。在服务器上创建一个部署目录，只下载 Compose 编排文件和环境变量模板：

```bash
mkdir -p gugu && cd gugu
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/.env.example -o .env.example
cp .env.example .env
```

Compose 会从 Docker Hub 拉取 `coffeiz/gugu-web` 应用镜像，并自动拉取 SearXNG、egress 代理和沙盒镜像；部署目录不需要包含项目源码或 Git 元数据。保留 `docker-compose.yml` 和 `.env`，它们分别是服务编排与本机部署配置。

编辑根目录 `.env`，至少修改 `GUGU_DB_PASSWORD`；`SECRET_KEY` 可以留空，首次启动会自动生成并持久化：

```dotenv
# SECRET_KEY 可省略；首次启动自动生成并保存到 Gugu-data/.env
GUGU_DB_PASSWORD=请替换为数据库密码
```

管理员账号和密码可在根目录 `.env` 设置；不设置密码时首次启动自动生成随机密码（写入 `Gugu-data/.env` 并打印在容器日志里），镜像不内置任何公开默认密码：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为管理员密码
```

根目录 `.env` 用于 Compose 变量替换，包括数据库密码、管理员账号密码、端口和镜像地址。

拉取并启动服务：

```bash
docker compose up -d
```

默认 Compose 拉取包含前端、Nginx、Uvicorn、worker、IM gateway、PostgreSQL 和 Redis 的统一应用镜像；它不挂载源码，也不运行开发服务器。SearXNG、egress-proxy、sandboxd 和仅持有 Docker Socket 的 updater 由同一 Compose 项目提供。app 本身不接触 Docker Socket。首次启动会初始化数据库并执行迁移。

打开：<http://localhost:9595>

管理后台：<http://localhost:9595/admin/>

不要删除 `Gugu-data` 和配置卷；PostgreSQL、Redis 数据也保存在 `Gugu-data` 中。`.env` 是本机配置，不要用模板覆盖它。

### fnOS、群晖等 NAS：直接粘贴完整 Compose

如果 NAS 的 Compose 页面支持直接输入 YAML，选择项目目录后，将下面完整配置粘贴到编辑器。它包含 app、SearXNG、egress-proxy、sandboxd 和 updater，保留联网搜索与 Shell 沙盒功能。

先在项目目录的 `.env` 中设置数据库密码，并把数据目录改为 NAS 上的绝对路径；如果 Docker Socket 路径不同，也设置 `GUGU_DOCKER_SOCKET`：

```dotenv
GUGU_DB_PASSWORD=请替换为长随机密码
GUGU_DATA_HOST_DIR=/你的NAS项目绝对路径/Gugu-data
GUGU_DOCKER_SOCKET=/var/run/docker.sock
```

如果面板支持项目环境变量，也可以在那里填写这些值。未设置管理员密码时，首次启动会生成随机密码并打印到容器日志。

```yaml
# Gugu 默认一键部署：一体化应用镜像、搜索与沙盒服务。
# Docker Socket 仅授予 sandboxd 和受限 updater，不直接暴露给 Web app。

name: gugu-web-compose

x-json-file-logging: &json-file-logging
  driver: json-file
  options:
    max-size: "50m"
    max-file: "3"

x-squid-config-command: &squid-config-command
  - |
    cat > /etc/squid/squid.conf <<'SQUID_CONF'
    http_port 3128
    cache deny all
    acl SSL_ports port 443
    acl Safe_ports port 80 443
    acl CONNECT method CONNECT
    acl private_dst dst 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 0.0.0.0/8
    acl private_dst6 dst ::1/128 fc00::/7 fe80::/10
    http_access deny !Safe_ports
    http_access deny CONNECT !SSL_ports
    http_access deny private_dst
    http_access deny private_dst6
    http_access allow all
    via off
    forwarded_for delete
    request_header_access X-Forwarded-For deny all
    request_header_access Via deny all
    SQUID_CONF
    exec /usr/sbin/squid -N -d 1

configs:
  searxng-settings:
    content: |
      # Compose 内置 SearXNG 配置；JSON 是 Gugu web_search/image_search 的必需格式。
      use_default_settings: true

      server:
        secret_key: "gugu-compose-dev-change-me"
        limiter: false

      search:
        formats:
          - html
          - json

x-gugu-data-mount: &gugu-data-mount
  type: bind
  source: ${GUGU_DATA_HOST_DIR:-./Gugu-data}
  target: /data
  bind:
    create_host_path: true

x-app-environment: &app-environment
  GUGU_UNIFIED_APP: "1"
  # PostgreSQL/Redis 由应用镜像内置托管，避免与 Compose 重复启动同类服务。
  GUGU_EMBEDDED_DEPS: "1"
  GUGU_APP_PORT: "8001"
  GUGU_ENABLE_WORKER: "1"
  GUGU_ENABLE_GATEWAY: "1"
  GUGU_ENV_FILE: /data/.env
  GUGU_DATA_DIR: /data
  # 用于启动失败时生成宿主机侧可执行的目录修复提示；实际挂载仍由 x-gugu-data-mount 控制。
  GUGU_DATA_HOST_DIR: ${GUGU_DATA_HOST_DIR:-${PWD}/Gugu-data}
  SECRET_KEY: ${SECRET_KEY:-}
  ADMIN_USERNAME: ${ADMIN_USERNAME:-}
  ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}
  GUGU_DB_PASSWORD: ${GUGU_DB_PASSWORD:-}
  DB__PASSWORD: ${GUGU_DB_PASSWORD:-}
  DB__HOST: 127.0.0.1
  DB__PORT: 5432
  DB__NAME: ${GUGU_DB_NAME:-gugu}
  DB__USER: ${GUGU_DB_USER:-gugu}
  REDIS__HOST: 127.0.0.1
  REDIS__PORT: 6379
  REDIS__PASSWORD: ${GUGU_REDIS_PASSWORD:-}
  PUBLIC_APP_URL: ${GUGU_PUBLIC_APP_URL:-http://localhost:9595}
  STORAGE__LOCAL_PATH: /data/users
  CREDENTIALS_MASTER_KEY_FILE: /data/byok/.byok-master-key
  GUGU_CONFIG_OVERRIDE_FILE: /config/config.override.json
  SEARCH__SEARXNG_URL: http://searxng:8080
  GUGU_LOG_FILE: /app/logs/gugu.log
  # 默认 Compose 同时启动独立 sandboxd；单容器镜像本身不托管它。
  SANDBOX__ROOTLESS_REQUIRED: ${GUGU_SANDBOX_ROOTLESS_REQUIRED:-false}
  SANDBOX__IMAGE: ${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}
  SANDBOX__IMAGE_DIGEST: ${GUGU_SANDBOX_IMAGE_DIGEST:-resolved}
  GUGU_SANDBOX_IMAGE_DIGEST_FILE: /run/gugu/sandbox-image-digest
  SANDBOX__EGRESS_PROXY_URL: http://egress-proxy:3128
  SANDBOX__EGRESS_NETWORK_NAME: ${GUGU_SANDBOX_EGRESS_NETWORK_NAME:-gugu-sandbox-egress}
  SANDBOX__EGRESS_ISOLATION_ENABLED: "true"
  GUGU_SANDBOXD_SOCKET: /run/gugu/sandboxd.sock

services:
  searxng:
    image: searxng/searxng:latest
    logging: *json-file-logging
    configs:
      - source: searxng-settings
        target: /etc/searxng/settings.yml
    environment:
      SEARXNG_BASE_URL: ${SEARXNG_BASE_URL:-http://searxng:8080/}
      UWSGI_WORKERS: 2
      UWSGI_THREADS: 4
    mem_limit: 512m
    restart: unless-stopped

  app:
    image: ${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}
    logging: *json-file-logging
    ports:
      - "${GUGU_HTTP_PORT:-9595}:9595"
    # 首次启动生成的密钥、数据库密码和管理员密码保存到 Gugu-data/.env。
    # 自更新通过独立 updater RPC 执行；app 不持有 Docker Socket。
    environment:
      <<: *app-environment
      GUGU_SELF_UPDATE: ${GUGU_SELF_UPDATE:-on}
      GUGU_UPDATE_DEPLOYMENT_MODE: integrated_compose
      GUGU_UPDATER_RPC_SOCKET: /run/gugu-updater/updater.sock
      GUGU_UPDATER_COMPOSE_DIR: /workspace
      GUGU_UPDATER_COMPOSE_FILE: docker-compose.yml
      GUGU_UPDATER_STATE_DIR: ${GUGU_UPDATER_STATE_DIR:-/data/updater}
    volumes:
      - *gugu-data-mount
      - legacy_pgdata:/legacy-pgdata:ro
      - legacy_redisdata:/legacy-redisdata:ro
      - gugu_config:/config
      - gugu_logs:/app/logs
      - sandbox_socket:/run/gugu
      - updater_socket:/run/gugu-updater
      - ${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}:/workspace:ro
    depends_on:
      searxng:
        condition: service_started
      updater:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://127.0.0.1:9595/health"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
    restart: unless-stopped

  updater:
    image: ${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}
    logging: *json-file-logging
    entrypoint: ["python", "-m", "updater.rpc_server"]
    environment:
      GUGU_UPDATE_DEPLOYMENT_MODE: integrated_compose
      GUGU_UNIFIED_APP: "1"
      GUGU_EMBEDDED_DEPS: "1"
      GUGU_SELF_UPDATE: ${GUGU_SELF_UPDATE:-on}
      GUGU_UPDATER_COMPOSE_DIR: ${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}
      GUGU_UPDATER_COMPOSE_FILE: docker-compose.yml
      GUGU_UPDATER_STATE_DIR: /data/updater
      GUGU_UPDATER_RPC_SOCKET: /run/gugu-updater/updater.sock
      GUGU_DOCKER_SOCKET: /run/gugu-updater/docker.sock
      DOCKER_HOST: unix:///run/gugu-updater/docker.sock
    volumes:
      - *gugu-data-mount
      - updater_socket:/run/gugu-updater
      - ${GUGU_DOCKER_SOCKET:-/var/run/docker.sock}:/run/gugu-updater/docker.sock
      - ${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}:${GUGU_UPDATER_COMPOSE_DIR:-${PWD}}:ro
    healthcheck:
      test: ["CMD-SHELL", "test -S /run/gugu-updater/updater.sock"]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 3
    restart: unless-stopped

  egress-proxy:
    image: ubuntu/squid:latest
    logging: *json-file-logging
    # 配置内联生成，避免 NAS 面板未同步 squid/egress.conf 时把缺失文件创建成目录。
    entrypoint: ["/bin/sh", "-c"]
    command: *squid-config-command
    networks:
      - default
      - egress_internal
    restart: unless-stopped

  sandboxd:
    image: ${GUGU_SANDBOXD_IMAGE:-${GUGU_WEB_IMAGE:-coffeiz/gugu-web:latest}}
    logging: *json-file-logging
    pid: "host"
    # sandboxd 不是 web 服务，不应进入默认 Compose 的数据库迁移/worker 入口。
    entrypoint: ["sh", "-c"]
    command:
      - |
        sh /usr/local/bin/gugu-sandbox-init.sh
        exec python -m agent.sandbox.sandboxd --socket /run/gugu/sandboxd.sock --allowed-root /data/users
    # sandboxd 通过 Unix socket 提供服务，不使用一体化 Web 镜像的 HTTP 健康检查。
    healthcheck:
      test: ["CMD-SHELL", "test -S \"$${GUGU_SANDBOXD_SOCKET}\""]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 3
    environment:
      DOCKER_HOST: unix:///run/gugu/docker.sock
      STORAGE__LOCAL_PATH: /data/users
      GUGU_SANDBOXD_SOCKET: /run/gugu/sandboxd.sock
      SANDBOX__ROOTLESS_REQUIRED: ${GUGU_SANDBOX_ROOTLESS_REQUIRED:-false}
      SANDBOX__IMAGE: ${GUGU_SANDBOX_IMAGE:-coffeiz/gugu-sandbox:latest}
      SANDBOX__IMAGE_DIGEST: ${GUGU_SANDBOX_IMAGE_DIGEST:-resolved}
      GUGU_SANDBOX_IMAGE_DIGEST_FILE: /run/gugu/sandbox-image-digest
      SANDBOX__EGRESS_PROXY_URL: http://egress-proxy:3128
      SANDBOX__EGRESS_NETWORK_NAME: ${GUGU_SANDBOX_EGRESS_NETWORK_NAME:-gugu-sandbox-egress}
      SANDBOX__EGRESS_ISOLATION_ENABLED: "true"
      SQUID_CONF_PATH: /opt/gugu/egress.conf
    volumes:
      - *gugu-data-mount
      - gugu_config:/config
      - sandbox_socket:/run/gugu
      - ${GUGU_DOCKER_SOCKET:-/var/run/docker.sock}:/run/gugu/docker.sock
      - /etc/passwd:/host/etc/passwd:ro
      - /etc/subuid:/host/etc/subuid:ro
      - /etc/subgid:/host/etc/subgid:ro
    depends_on:
      egress-proxy:
        condition: service_started
    restart: unless-stopped

volumes:
  gugu_config:
  gugu_logs:
  sandbox_socket:
  updater_socket:
  # 保留旧默认 Compose 的卷名，仅只读挂载以识别尚未迁移的 PostgreSQL 数据。
  # 自定义过旧项目名/卷名的部署可通过 GUGU_LEGACY_PGDATA_VOLUME 指定原卷名。
  legacy_pgdata:
    name: ${GUGU_LEGACY_PGDATA_VOLUME:-gugu-web-compose_pgdata}
  # 旧默认 Compose 的 Redis AOF 卷，迁移时只读探测，防止丢弃未处理的 IM Stream。
  legacy_redisdata:
    name: ${GUGU_LEGACY_REDISDATA_VOLUME:-gugu-web-compose_redisdata}

networks:
  egress_internal:
    name: ${GUGU_SANDBOX_EGRESS_NETWORK_NAME:-gugu-sandbox-egress}
    internal: true
```

如果不需要联网搜索和 Shell 沙盒，可参考下方的纯 Docker 单容器部署方式。
## 纯 Docker 单容器部署（镜像内置数据库）

不想用 Compose 的用户（fnOS、群晖等面板只有单容器部署入口）可以直接拉一体化镜像：镜像内置 PostgreSQL 与 Redis（默认 `GUGU_EMBEDDED_DEPS=1`，只监听容器内 127.0.0.1），数据落在挂载的数据卷里，一条命令即可启动完整站点：

```bash
docker run -d --name gugu \
  -p 9595:9595 \
  -v /你的数据目录:/data \
  -v /你的配置目录:/config \
  -e GUGU_DB_PASSWORD=请替换为数据库密码 \
  coffeiz/gugu-web:latest
```

打开 <http://localhost:9595> 即可使用。**请绑定宿主机目录**：`/data` 保存数据库、用户文件与记忆，`/config` 保存 Admin 配置。绑定目录可在容器重建后保留数据；匿名卷可能随容器替换而变成空卷，使站点看起来像回到初始状态。因此入口默认**拒绝在匿名卷上启动**，并给出绑定目录指引；只想先临时试用可加环境变量 `GUGU_ALLOW_ANONYMOUS_DATA=1` 显式放行（日志会持续警告）。完全未挂卷（数据落在容器临时层）时无论任何配置都拒绝启动。

不设置 `SECRET_KEY` 时，镜像会在首次启动生成高强度随机密钥并保存到持久化配置文件；后续重启或重建容器后仍会复用原密钥。未显式指定 `ADMIN_PASSWORD` 时首启自动生成随机密码写入 `/data/.env` 并在容器日志打印一次（`docker logs gugu` 查看），重建容器不丢失；公网部署务必用 `-e ADMIN_PASSWORD=...` 指定强密码。

注意事项：

- **联网搜索不内置**：SearXNG 依赖较多、内置会显著增大镜像体积并带来依赖冲突风险，单容器模式下搜索相关工具不可用；需要搜索请改用上面的 Compose 方式。
- **不提供 Shell 沙盒**：纯 Docker 单容器不会启动 sandboxd，也不包含沙盒执行镜像。需要 Shell 沙盒时必须使用上面的默认 Compose 部署。
- 默认 Compose 设置 `GUGU_EMBEDDED_DEPS=1`，PostgreSQL/Redis 由 app 内置托管；SearXNG、egress-proxy 和 sandboxd 仍保持独立运行边界。
- 已在用 Compose 的部署应继续使用 Compose，并保留现有数据目录。

## Compose 配置

默认一体化 Compose 从项目根目录 `.env` 读取编排变量，并把运行配置持久化到 `Gugu-data/.env`（挂载到容器 `/data`）。分体生产部署仍使用 `backend/.env`。两种拓扑都可由 Admin 面板的 `config.override.json`（优先级最高，运行时热合并）补充或覆盖。

可以直接在项目根目录创建 `.env`，按需填写下面的 Compose 配置：

```dotenv
# PostgreSQL
# 默认 Compose 使用 app 内置 PostgreSQL；外部数据库部署时再改成实际地址
GUGU_DB_HOST=127.0.0.1
GUGU_DB_PORT=5432
GUGU_DB_NAME=gugu
GUGU_DB_USER=gugu
GUGU_DB_PASSWORD=请替换为数据库密码

# Redis
GUGU_REDIS_HOST=127.0.0.1
GUGU_REDIS_PORT=6379
# 没有密码时可以留空
GUGU_REDIS_PASSWORD=

# Web 入口端口
GUGU_HTTP_PORT=9595

# 用户可访问的公开站点根地址；域名部署时改为 https://你的域名
GUGU_PUBLIC_APP_URL=http://localhost:9595

# Shell 沙盒
# 默认 Compose 会启动 sandboxd；在线模式自动拉取，离线模式使用 bundle 本地镜像
GUGU_SANDBOX_ENABLED=true
GUGU_SANDBOX_NETWORK_PROFILE=egress

# 默认 Compose 应用镜像
GUGU_WEB_IMAGE=coffeiz/gugu-web:latest
```

默认 Compose 使用 `GUGU_WEB_IMAGE` 和 `GUGU_DB_PASSWORD`。只有需要分别管理前后端时才使用 `docker-compose.prod.yml`；从源码开发并热更新时使用 `docker-compose.dev.yml`。

默认一体化部署的持久化运行配置为 `Gugu-data/.env`；分体部署的应用配置放在 `backend/.env`，模板见 [`backend/.env.example`](../backend/.env.example)。根目录 `.env.example` 提供 Compose 编排变量模板。

`GUGU_PUBLIC_APP_URL` 是 Nginx 公开入口与后端外部链接生成共用的配置。邮箱验证、密码重置等邮件链接都使用它；不要填写 `backend:8000`、`localhost:9595` 等容器内部地址。Nginx 会向后端转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Port` 和 `X-Forwarded-Proto`。

## Shell 沙盒

默认 `docker compose up -d` 会一起启动 sandboxd 和受控 egress 代理；在线模式自动拉取官方 `gugu-sandbox` 并固定 digest。离线部署请使用发布包中的 `gugu-compose-bundle.tar` 和 `docker-compose.offline.yml`：一次 `docker load` 后，Compose 只使用本地镜像，不访问外部 registry。执行镜像独立于 `gugu-web` 运行，但与应用、代理和搜索镜像一起打包分发。默认允许宿主机 Rootful Docker，方便普通用户开箱即用；生产环境建议在 `.env` 设置 `GUGU_SANDBOX_ROOTLESS_REQUIRED=true` 强制要求 Rootless。宿主机 Docker Socket 必须可用且对 Compose 有访问权限，默认是 `/var/run/docker.sock`；Rootless Docker 用户需在 `.env` 配置 `GUGU_DOCKER_SOCKET`。不需要沙盒时在 `.env` 设置 `GUGU_SANDBOX_ENABLED=false`，并停止 `sandboxd` 与 `egress-proxy` 即可。不要把宿主机敏感目录挂载给沙盒容器。

若自行覆盖 `GUGU_SANDBOX_IMAGE`，同时设置匹配的 `GUGU_SANDBOX_IMAGE_DIGEST`。默认自动解析仅适用于官方发布的执行镜像。

## 配置模型和功能

大部分运行配置可以在 Admin 页面中修改。首次登录后，进入系统配置或 Agent 配置，填写模型 Provider、BYOK、联网搜索、邮件和 IM 等信息。

常用配置文件：

- `.env`：默认 Compose 编排变量，包括可选的管理员初始账号密码
- `Gugu-data/.env`：默认一体化部署生成并持久化的运行配置
- `backend/.env`：分体生产部署配置
- `docker-compose.yml`：默认一体化应用部署入口，推荐用于常规部署
- `docker-compose.dev.yml`：源码开发 Compose 服务
- `docker-compose.prod.yml`：生产环境前后端分体部署

不要把真实密码、Token 或 API Key 提交到 Git。

## 生产启动

> **推荐：一体化镜像**。绝大多数生产部署使用默认 Compose（`docker compose up -d`）即可，统一的 `9595` 入口覆盖前端、后端、worker、IM gateway：

```bash
export GUGU_WEB_IMAGE='coffeiz/gugu-web:v1.x.y'   # 固定版本，禁用 latest
export GUGU_DB_PASSWORD='请设置数据库密码'
docker compose up -d
```

数据库、镜像地址、标签和管理员账号密码等 Compose 变量可以写入项目根目录 `.env`；一体化镜像生成的密钥和随机密码保存在 `Gugu-data/.env`。

需要 Shell 沙盒时：

```bash
docker compose --profile sandbox up -d
```

生产部署前请准备持久化数据卷，并备份数据库和用户文件。**正式部署请使用固定版本或 digest，不要依赖 `latest`**。

### 拆分场景（备选）

需要分别管理后端与前端镜像（自托管私有仓库按服务拆分、独立扩缩容、灰度发布、自定义反向代理等）时，可改用 `docker-compose.prod.yml`，分别消费 Docker Hub 上的 `coffeiz/gugu-web-backend:<tag>` 与 `coffeiz/gugu-web-frontend:<tag>` 版本镜像：

```bash
export GUGU_BACKEND_IMAGE='docker.io/coffeiz/gugu-web-backend:v1.x.y'
export GUGU_FRONTEND_IMAGE='docker.io/coffeiz/gugu-web-frontend:v1.x.y'
export GUGU_DB_PASSWORD='请设置数据库密码'
docker compose -f docker-compose.prod.yml up -d
```

需要沙盒时：

```bash
docker compose -f docker-compose.prod.yml --profile sandbox up -d
```

拆分路径与一体化镜像共享同一份用户数据目录；切换前必须按部署文档处理两种拓扑的运行配置和数据库，不可直接互换 `.env` 文件。

如需把用户数据放到其他宿主机目录，在项目根目录 `.env` 设置绝对路径；默认、Dev、Prod
三份 Compose 都使用同一个变量：

```dotenv
GUGU_DATA_HOST_DIR=/srv/gugu-data
```

Compose 首次启动会自动创建目录；自定义目录需要保证运行 Docker 的用户可读写。启用 Shell
沙盒时，sandboxd 会在启动阶段解析当前 `/data` 挂载的宿主机源路径，不依赖面板提供的 `PWD`。

> **⚠️ 沙盒与 `Gugu-data` 的部署前置**（默认/Dev/Prod 三个 Compose 相同）：沙盒容器由
> backend 通过 docker.sock 作为兄弟容器启动，`--mount src=.../users/<uid>/shell`
> 由**宿主机 daemon** 解析。sandboxd 启动时通过 Docker API 读取自身 `/data` bind mount 的真实
> 宿主机源，再统一翻译用户目录；因此不依赖 Compose 面板的 `PWD`，旧单容器
> 部署必须先按上面的迁移步骤完成一次数据复制。已经迁移过的部署后续直接执行
> `docker compose up -d`，不再执行旧的 named volume 迁移。默认 Compose 会跑一次性
> `sandboxd` 启动前的幂等初始化流程，自动在沙盒实际运行的 daemon（含 rootless）上准备 egress 网络、
> squid 代理、独立发布的 Sandbox 执行镜像和用户 `shell`/文件目录 ACL，并用真实沙盒 UID 做写入探针；rootful
> 单 daemon 部署下自动使用容器 UID/GID。详见 docs/ops/deploy.md。

## 开发环境

开发者需要源码挂载、Vite 开发服务器和本地构建时，使用独立的 Dev Compose：

```bash
docker compose -f docker-compose.dev.yml up -d
```

启用开发环境沙盒：

```bash
docker compose -f docker-compose.dev.yml --profile sandbox up -d
```

## 查看状态和日志

```bash
docker compose ps
docker compose logs -f app
```

开发环境更新源码后：

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

不要使用 `docker compose down -v`，这会删除 Compose 管理的数据卷。

## 停止服务

```bash
docker compose down
```

这不会删除数据卷。重新启动时再次执行 `docker compose up -d` 即可。
