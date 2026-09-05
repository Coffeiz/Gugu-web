# Gugu 部署指南

这是一份面向普通使用者的简版部署说明。生产环境的反向代理、权限、备份和故障排查见[运维部署文档](ops/deploy.md)。

## 前置要求

- Docker 20+
- Docker Compose v2.20+
- 一个可访问的模型 Provider，或准备好的 BYOK 配置
- 能访问镜像仓库和模型服务的网络

## 快速启动（默认 Compose 单容器模式）

在仓库根目录执行：

```bash
git clone https://github.com/Coffeiz/Gugu-web.git
cd Gugu-web
cp .env.example .env
mkdir -p backend && touch backend/.env
```

编辑根目录 `.env`，至少修改 `SECRET_KEY` 和 `GUGU_DB_PASSWORD`：

```dotenv
SECRET_KEY=请替换为随机长字符串
GUGU_DB_PASSWORD=请替换为数据库密码
```

管理员账号和密码可以写入 `backend/.env`；不设置密码时首次启动自动生成：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为管理员密码
```

根目录 `.env` 只放 Compose 编排变量，例如 `GUGU_DB_PASSWORD`、端口和镜像地址；不要在根目录重复配置管理员账号密码。

拉取并启动服务：

```bash
docker compose up -d
```

默认 Compose 会拉取包含前端、Nginx、Uvicorn、worker、IM gateway 的单容器应用镜像；它不挂载源码，也不运行开发服务器。它会启动 Gugu、PostgreSQL、Redis 和内置的 SearXNG 搜索服务。首次启动会初始化数据库并执行迁移。

打开：<http://localhost:9595>

管理后台：<http://localhost:9595/admin/>

## Compose 配置

Compose 会读取项目根目录的 `.env` 和当前 Shell 环境变量。`backend/.env` 是唯一的应用运行配置，容器通过 `env_file` 读取；根目录 `.env` 只用于 Compose 变量替换和基础设施配置。

可以直接在项目根目录创建 `.env`，按需填写下面的 Compose 配置：

```dotenv
# PostgreSQL
# 默认 Compose 使用容器名 postgres；跨主机部署时改成实际地址
GUGU_DB_HOST=postgres
GUGU_DB_PORT=5432
GUGU_DB_NAME=gugu
GUGU_DB_USER=gugu
GUGU_DB_PASSWORD=请替换为数据库密码

# Redis
GUGU_REDIS_HOST=redis
GUGU_REDIS_PORT=6379
# 没有密码时可以留空
GUGU_REDIS_PASSWORD=

# Web 入口端口
GUGU_HTTP_PORT=9595

# 用户可访问的公开站点根地址；域名部署时改为 https://你的域名
GUGU_PUBLIC_APP_URL=http://localhost:9595

# Shell 沙盒
# 只有执行 `docker compose --profile sandbox up -d` 时才会启动 sandboxd
GUGU_SANDBOX_ENABLED=true
GUGU_SANDBOX_NETWORK_PROFILE=egress

# 默认 Compose 应用镜像
GUGU_WEB_IMAGE=coffeiz/gugu-web:latest
```

生产 Compose 仍要求填写 `GUGU_BACKEND_IMAGE`、`GUGU_FRONTEND_IMAGE` 和 `GUGU_DB_PASSWORD`。需要从源码启动并热更新时使用 Dev Compose。

完整的应用配置仍放在 `backend/.env`，模板见 [`backend/.env.example`](../backend/.env.example)；根目录 `.env.example` 只包含 Compose 编排变量。

`GUGU_PUBLIC_APP_URL` 是 Nginx 公开入口与后端外部链接生成共用的配置。邮箱验证、密码重置等邮件链接都使用它；不要填写 `backend:8000`、`localhost:8000` 等容器内部地址。Nginx 会向后端转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Port` 和 `X-Forwarded-Proto`。

## 启用 Shell 沙盒

默认部署不启动 Shell 沙盒。确认需要后执行：

```bash
docker compose --profile sandbox up -d
```

沙盒会运行在独立的受控环境中。不要把宿主机敏感目录挂载给沙盒容器。

## 配置模型和功能

大部分运行配置可以在 Admin 页面中修改。首次登录后，进入系统配置或 Agent 配置，填写模型 Provider、BYOK、联网搜索、邮件和 IM 等信息。

常用配置文件：

- `backend/.env`：部署环境变量和敏感配置
- `docker-compose.yml`：默认单容器一键部署入口
- `docker-compose.dev.yml`：源码开发 Compose 服务
- `docker-compose.prod.yml`：生产构建物 Compose 服务

不要把真实密码、Token 或 API Key 提交到 Git。

## 生产启动

正式生产环境使用构建产物和统一的 `9595` 入口：

```bash
export GUGU_BACKEND_IMAGE='请填写后端镜像地址:latest'
export GUGU_FRONTEND_IMAGE='请填写前端镜像地址:latest'
export GUGU_DB_PASSWORD='请设置数据库密码'
docker compose -f docker-compose.prod.yml up -d
```

数据库、镜像地址和标签等 Compose 变量可以写入项目根目录的 `.env`，管理员密码仍只写入 `backend/.env`。

需要沙盒时：

```bash
docker compose -f docker-compose.prod.yml --profile sandbox up -d
```

生产部署前请准备持久化数据卷，并备份数据库和用户文件。正式部署请使用固定版本或 digest，不要依赖 `latest`。

如需把用户数据放到其他宿主机目录，在项目根目录 `.env` 设置绝对路径；默认、Dev、Prod
三份 Compose 都使用同一个变量：

```dotenv
GUGU_DATA_HOST_DIR=/srv/gugu-data
```

Compose 首次启动会自动创建目录；自定义目录需要保证运行 Docker 的用户可读写，启用 Shell
沙盒时也必须使用宿主机 daemon 可见的绝对路径。

> **⚠️ 沙盒与 `Gugu-data` 的部署前置**（默认/Dev/Prod 三个 Compose 相同）：沙盒容器由
> backend 通过 docker.sock 作为兄弟容器启动，`--mount src=.../users/<uid>/shell`
> 由**宿主机 daemon** 解析，所以宿主机必须存在与容器内一致的 `Gugu-data` 路径。Compose
> 已用 `GUGU_DATA_HOST_DIR`（未设置时按 Compose 文件目录解析为 `Gugu-data`）直接 bind；从旧版本
> 升级时先停止旧业务容器（`docker compose stop`，不删卷），再执行 `docker compose up -d`，
> 由 `data-migrate` 自动把旧 `gugu-web-compose_gugu_data` named volume 内容拷到新目录，
> 源卷保留不删除，不需要手工执行第二套迁移。自定义旧 Compose 项目名时设置
> `GUGU_LEGACY_DATA_VOLUME` 为实际卷名。启用 sandbox profile 时 compose 还会跑一次性
> `sandbox-bootstrap`，自动在沙盒实际运行的 daemon（含 rootless）上准备 egress 网络、
> squid 代理、沙盒镜像和用户 `shell`/文件目录 ACL，并用真实沙盒 UID 做写入探针；rootful
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
