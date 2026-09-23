# Gugu 部署指南

这是一份面向普通使用者的简版部署说明。生产环境的反向代理、权限、备份和故障排查见[运维部署文档](ops/deploy.md)。

## 前置要求

- Docker 20+
- Docker Compose v2.20+
- 一个可访问的模型 Provider，或准备好的 BYOK 配置
- 能访问镜像仓库和模型服务的网络

## 快速启动（默认一体化 Compose）

在仓库根目录执行：

```bash
git clone https://github.com/Coffeiz/Gugu-web.git
cd Gugu-web
cp .env.example .env
mkdir -p backend && touch backend/.env
```

编辑根目录 `.env`，至少修改 `GUGU_DB_PASSWORD`；`SECRET_KEY` 可以留空，首次启动会自动生成并持久化：

```dotenv
# SECRET_KEY 可省略；首次启动自动生成并保存到 backend/.env
GUGU_DB_PASSWORD=请替换为数据库密码
```

管理员账号和密码可以写入 `backend/.env`；不设置密码时首次启动自动生成随机密码（写入 `backend/.env` 并打印在容器日志里），镜像不内置任何公开默认密码：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为管理员密码
```

根目录 `.env` 只放 Compose 编排变量，例如 `GUGU_DB_PASSWORD`、端口和镜像地址；不要在根目录重复配置管理员账号密码。

拉取并启动服务：

```bash
docker compose up -d
```

默认 Compose 拉取包含前端、Nginx、Uvicorn、worker、IM gateway、PostgreSQL 和 Redis 的统一应用镜像；它不挂载源码，也不运行开发服务器。SearXNG、egress-proxy 和 sandboxd 由同一 Compose 项目提供。首次启动会初始化数据库并执行迁移。

打开：<http://localhost:9595>

管理后台：<http://localhost:9595/admin/>

升级请在同一部署目录执行 `docker compose pull && docker compose up -d`。不要删除 `Gugu-data` 和配置卷；PostgreSQL、Redis 数据也保存在 `Gugu-data` 中。

**管理员密码不设默认值**：首次启动未设置 `ADMIN_PASSWORD` 时，会生成随机密码并写入 `backend/.env`，同时在容器日志打印一次。公网部署务必在 `backend/.env` 设置自己的强密码。

fnOS、群晖等支持 Compose 项目的面板，请导入仓库根目录的 `docker-compose.yml` 并在同一项目中更新服务。数据目录仍可通过 `GUGU_DATA_HOST_DIR` 指定，但不要求填写宿主机绝对路径；sandboxd 启动时会从当前 `/data` 挂载自动解析实际路径。

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

打开 <http://localhost:9595> 即可使用。**请绑定宿主机目录**：`/data` 保存数据库、用户文件与记忆，`/config` 保存 Admin 配置，`-v` 绑定后升级镜像、重建容器数据都不丢。镜像虽然声明了 `/data`、`/config` 卷（不绑时会自动创建匿名卷兜底），但匿名卷跟容器实例走——NAS 面板「更新镜像」重建容器时会拿到全新的空卷，数据库回到出厂状态（旧数据滞留在旧卷里，fnOS 单容器部署实测踩过）。因此入口默认**拒绝在匿名卷上启动**，并给出绑卷指引；只想先临时试用可加环境变量 `GUGU_ALLOW_ANONYMOUS_DATA=1` 显式放行（日志会持续警告）。完全未挂卷（数据落在容器临时层）时无论任何配置都拒绝启动。

不设置 `SECRET_KEY` 时，镜像会在首次启动生成高强度随机密钥并保存到持久化配置文件；后续重启和升级会复用原密钥。未显式指定 `ADMIN_PASSWORD` 时首启自动生成随机密码写入 `/data/.env` 并在容器日志打印一次（`docker logs gugu` 查看），重建容器不丢失；公网部署务必用 `-e ADMIN_PASSWORD=...` 指定强密码。

注意事项：

- **联网搜索不内置**：SearXNG 依赖较多、内置会显著增大镜像体积并带来依赖冲突风险，单容器模式下搜索相关工具不可用；需要搜索请改用上面的 Compose 方式。
- **不提供 Shell 沙盒**：纯 Docker 单容器不会启动 sandboxd，也不包含沙盒执行镜像。需要 Shell 沙盒时必须使用上面的默认 Compose 部署。
- 默认 Compose 设置 `GUGU_EMBEDDED_DEPS=1`，PostgreSQL/Redis 由 app 内置托管；SearXNG、egress-proxy 和 sandboxd 仍保持独立运行边界。
- 已在用 Compose 的部署不要切回单容器模式；从旧单容器版本迁移见下一节。

## 从旧单容器版本升级

当前一体化镜像继续内置 PostgreSQL/Redis。旧版 `docker run` 或 NAS 单容器部署只需保留原来的 `/data`、`/config` 挂载，停止旧容器后用新镜像重建；数据库、用户文件、BYOK 主密钥和管理员凭据会继续从持久化目录读取，不需要执行跨容器数据库迁移。

若旧部署使用匿名卷，先在面板中把匿名卷导出或改为显式宿主机目录，再进行升级；不要在未确认数据备份前执行 `docker compose down -v` 或删除旧容器卷。

## Compose 配置

Compose 会读取项目根目录的 `.env` 和当前 Shell 环境变量。`backend/.env` 是唯一的应用运行配置，容器通过 `env_file` 读取；根目录 `.env` 只用于 Compose 变量替换和基础设施配置。

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

完整的应用配置仍放在 `backend/.env`，模板见 [`backend/.env.example`](../backend/.env.example)；根目录 `.env.example` 只包含 Compose 编排变量。

`GUGU_PUBLIC_APP_URL` 是 Nginx 公开入口与后端外部链接生成共用的配置。邮箱验证、密码重置等邮件链接都使用它；不要填写 `backend:8000`、`localhost:9595` 等容器内部地址。Nginx 会向后端转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Port` 和 `X-Forwarded-Proto`。

## Shell 沙盒

默认 `docker compose up -d` 会一起启动 sandboxd 和受控 egress 代理；在线模式自动拉取官方 `gugu-sandbox` 并固定 digest。离线部署请使用发布包中的 `gugu-compose-bundle.tar` 和 `docker-compose.offline.yml`：一次 `docker load` 后，Compose 只使用本地镜像，不访问外部 registry。执行镜像独立于 `gugu-web` 运行，但与应用、代理和搜索镜像一起打包分发。默认允许宿主机 Rootful Docker，方便普通用户开箱即用；生产环境建议在 `.env` 设置 `GUGU_SANDBOX_ROOTLESS_REQUIRED=true` 强制要求 Rootless。宿主机 Docker Socket 必须可用且对 Compose 有访问权限，默认是 `/var/run/docker.sock`；Rootless Docker 用户需在 `.env` 配置 `GUGU_DOCKER_SOCKET`。不需要沙盒时在 `.env` 设置 `GUGU_SANDBOX_ENABLED=false`，并停止 `sandboxd` 与 `egress-proxy` 即可。不要把宿主机敏感目录挂载给沙盒容器。

若自行覆盖 `GUGU_SANDBOX_IMAGE`，同时设置匹配的 `GUGU_SANDBOX_IMAGE_DIGEST`。默认自动解析仅适用于官方发布的执行镜像。

## 配置模型和功能

大部分运行配置可以在 Admin 页面中修改。首次登录后，进入系统配置或 Agent 配置，填写模型 Provider、BYOK、联网搜索、邮件和 IM 等信息。

常用配置文件：

- `backend/.env`：部署环境变量和敏感配置
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

数据库、镜像地址和标签等 Compose 变量可以写入项目根目录的 `.env`，管理员密码仍只写入 `backend/.env`。

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

拆分路径与一体化镜像共享同一份数据卷和 `backend/.env`，可在两种部署间互切（前提是同一版本号）。

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
