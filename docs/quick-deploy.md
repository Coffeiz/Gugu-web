# Gugu 部署指南

这是一份面向普通使用者的简版部署说明。主路径直接使用 Docker Hub 的一体化镜像；生产环境的反向代理、权限、备份和故障排查见[运维部署文档](ops/deploy.md)。

## 获取镜像

`gugu-web` 一体化镜像发布在 Docker Hub 和 GitHub Container Registry（GHCR），可任选其一：

```bash
docker pull docker.io/coffeiz/gugu-web:latest
# 或
docker pull ghcr.io/coffeiz/gugu-web:latest
```

国内网络可尝试使用 DaoCloud 或 1ms 镜像加速站拉取 Docker Hub 镜像，任选一种：

```bash
# DaoCloud
docker pull m.daocloud.io/docker.io/coffeiz/gugu-web:latest
# 1ms
docker pull docker.1ms.run/coffeiz/gugu-web:latest
```

如果用于本地 Compose 或导出给 NAS，把拉取结果按所用加速站重新标记为标准镜像名（任选对应的一条）：

```bash
# DaoCloud
docker tag m.daocloud.io/docker.io/coffeiz/gugu-web:latest coffeiz/gugu-web:latest
# 1ms
docker tag docker.1ms.run/coffeiz/gugu-web:latest coffeiz/gugu-web:latest
```

DaoCloud 和 1ms 都是第三方加速服务，可能未收录该镜像或未及时同步新标签；拉取失败或版本不确定时，改用 Docker Hub/GHCR 官方地址。用法见[DaoCloud 镜像加速站文档](https://docs.daocloud.io/tf/community/mirror/)和[1ms 使用文档](https://1ms.run/guide)。

快速部署使用 Docker Hub 的 `gugu-web` 一体化镜像。正式部署建议将 `latest` 换成固定版本标签（例如 `v<版本号>`）。GHCR 可作为 Docker Hub 不可达时的显式替代来源；使用 Compose 时可在根目录 `.env` 中设置 `GUGU_WEB_IMAGE=ghcr.io/coffeiz/gugu-web:<版本号>`。

若 NAS 面板不能直接拉取镜像，可在有 Docker 的电脑或服务器上拉取后导出为 fnOS 可导入的未压缩 tar，再将文件导入 NAS：

```bash
docker save -o gugu-web.tar coffeiz/gugu-web:latest
```

若从 GHCR 拉取，请先将镜像标记为 `coffeiz/gugu-web:latest` 再导出。显式使用 DaoCloud 或 1ms 前缀只影响 `gugu-web`；Compose 额外使用的 SearXNG 是否能拉取，取决于 NAS Docker daemon 的镜像源配置。

## 前置要求

- 一体化镜像：Docker 20+，Linux `amd64` Docker Engine
- Compose 路径：Docker Compose v2.20+
- 一个可访问的模型 Provider，或准备好的 BYOK 配置
- 能访问镜像仓库和模型服务的网络

## 推荐：直接运行 Docker Hub 一体化镜像

在 Linux 主机上创建并进入部署目录，再拉取、运行官方 Docker Hub 镜像：

```bash
mkdir -p gugu/Gugu-data gugu/Gugu-config
cd gugu
docker pull docker.io/coffeiz/gugu-web:latest
docker run -d --name gugu-web \
  --restart unless-stopped \
  --privileged \
  --publish 9595:9595 \
  --volume "$PWD/Gugu-data:/data" \
  --volume "$PWD/Gugu-config:/config" \
  docker.io/coffeiz/gugu-web:latest
```

访问 <http://localhost:9595>；Admin 位于 <http://localhost:9595/admin/>。首次启动会初始化数据库并执行迁移。未设置 `ADMIN_PASSWORD` 时，系统会生成随机管理员密码，保存到 `Gugu-data/.env` 并在容器日志中打印一次；用 `docker logs gugu-web` 查看并保存。未设置 `ADMIN_USERNAME` 时账号默认为 `admin`。模型 Provider 和 API Key 可在登录后通过 Admin 页面配置。

`Gugu-data` 保存用户数据和运行配置，`Gugu-config` 保存 Admin 配置。升级前备份这两个目录和数据库；拉取目标镜像后先停止旧容器，完成下面要求的离线迁移，再删除旧容器并用原端口和目录映射运行新容器。不要删除数据目录。正式部署应使用固定版本标签或 digest，避免 `latest` 在两次部署间指向不同版本。

单容器镜像包含完整站点、内置 PostgreSQL/Redis、内部 Rootless Docker、沙盒管理器和 Shell 执行镜像。Shell 沙盒默认启用，不需要单独部署 `sandboxd`、导入执行镜像或挂载宿主 Docker Socket。SearXNG 不包含在单容器镜像中，因此联网搜索功能不可用。

单容器更新分为两层：Admin「版本更新」只允许下载并验签不含数据库迁移、且明确支持安全代码回滚的 Gugu 应用包，在容器内切换应用代码并重启服务；包含数据库迁移的 Release 必须通过 Docker/NAS 管理器更新完整镜像。应用包更新失败时，只有在数据库 schema 未变化且 Release 声明支持回滚时才恢复旧代码，避免新旧代码与数据库 schema 不兼容。基础系统、Rootless Docker、Shell 执行镜像及其他基础运行时也由 Docker 管理器更新。请保留原有 `/data`、`/config` 映射。旧版镜像需先通过 Docker 管理器更新到包含应用包更新运行时的版本。

> **安全提示：**privileged 会显著提高外层应用容器被攻破后的宿主机风险。内部 Rootless 只隔离其创建的 Shell 执行容器，不能消除外层应用的宿主风险；此部署方式面向可信个人单用户使用，不建议用于多租户、公网或业务服务器。

### 1.5 → 1.6：先运行一体化离线迁移

已有用户的旧工作区必须离线迁移，不能直接用新镜像接流量。先保留旧容器和镜像、备份 `Gugu-data` 与 `Gugu-config`，再在原部署目录执行（把 `<目标版本>` 换为实际 release tag）：

```bash
docker pull docker.io/coffeiz/gugu-web:<目标版本>
docker stop gugu-web
docker run --rm --name gugu-offline-migration --privileged \
  --volume "$PWD/Gugu-data:/data" \
  --volume "$PWD/Gugu-config:/config" \
  docker.io/coffeiz/gugu-web:<目标版本> \
  gugu-offline-migrate --services-stopped
```

使用旧容器原有的数据/配置映射和自定义数据库设置；不要另建空数据目录，不要用 `--entrypoint` 绕过入口。该命令只启动内置 PostgreSQL/Redis，在数据卷 `migration-backups/` 中保留时间戳数据库归档和 `users.tar`，然后执行 Alembic、工作区迁移与校验，关闭依赖并退出；不启动 Web、Worker、Gateway、RAG 或 Sandbox。**仅命令退出码为 0 后**，才删除旧容器并按上面的正常运行命令用目标镜像重新创建。

默认 Compose 使用同一入口：固定目标 `GUGU_WEB_IMAGE`，执行 `docker compose pull app`、`docker compose stop app`，然后 `docker compose run --rm --no-deps app gugu-offline-migrate --services-stopped`；成功后执行 `docker compose up -d --no-deps --force-recreate app`。`scripts/release/compose-update.sh` 已在停止 app 后自动执行该迁移步骤。

失败时不要只换回旧镜像启动：文件和 schema 可能已部分迁移。保留 `migration-backups/`、迁移清单与旧镜像，继续停服；布局迁移可在排除错误后续跑。需要回滚时必须把同一次备份的数据库与整个 `users` 目录一起恢复，步骤见[部署文档](ops/deploy.md#工作区布局迁移失败后的恢复)。

## 可选：使用 Compose 并启用联网搜索

`docker-compose.yml` 同样使用 Docker Hub 的一体化应用镜像，并额外拉取 SearXNG 提供联网搜索。Compose 不部署独立 updater 服务，也不挂载宿主 Docker Socket；app 在 privileged 外层容器内运行 Rootless Docker。

如需此路径，从 GitHub 下载 Compose 文件和环境变量模板，填写 `GUGU_DB_PASSWORD` 后启动：

```bash
mkdir -p gugu-compose && cd gugu-compose
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Coffeiz/Gugu-web/main/.env.example -o .env
# 编辑 .env，至少设置 GUGU_DB_PASSWORD
docker compose up -d
```

Compose 相比直接运行单容器增加联网搜索和编排管理，但不提供 Admin 一键镜像更新；使用 Docker/Compose 管理器更新整套镜像。Shell 沙盒仍由 `gugu-web` 内置 runtime 提供。**该 Compose 没有独立 `updater` 或 `sandboxd` 服务，也不拉取独立 `gugu-sandbox` 执行镜像。**首次启动会初始化内置数据库并执行迁移，用户数据保存在 `Gugu-data`。

部署时保留 `docker-compose.yml` 与根目录 `.env`，并设置 `GUGU_DB_PASSWORD`。可以设置管理员账号密码、端口和镜像版本；未设置 `ADMIN_PASSWORD` 时，首次启动会生成随机密码并持久化，同时将管理员账号和密码打印到 app 容器日志（可用 `docker compose logs app` 查看）。未设置 `ADMIN_USERNAME` 时账号默认为 `admin`。`SECRET_KEY` 可留空，由首次启动生成并持久化。启动后通过 <http://localhost:9595> 访问，管理后台为 <http://localhost:9595/admin/>。不要删除 `Gugu-data` 或用模板覆盖已有 `.env`。

如需前后端拆分部署，请使用 `docker-compose.prod.yml`；该部署拓扑及其额外服务见[运维部署文档](ops/deploy.md)，不要与一体化 Compose 混用配置。

## fnOS / 群晖 NAS 配置

在 NAS 的容器高级设置中启用 privileged（特权容器），并配置 `9595` 端口映射、`/data` 与 `/config` 持久化目录。该选项等价于 Docker 的 `--privileged`，是容器内 Rootless Docker 启动 Shell 沙盒所需；**无需映射宿主 `/var/run/docker.sock`**。NAS 文件夹权限还需允许容器读写映射目录。

- **fnOS：**Docker 容器高级设置的“功能”中勾选“使用最高权限执行容器”。可参考[飞牛 fnOS 帮助中心](https://help.fnnas.com/)；该具体开关名称以 fnOS 容器界面为准。
- **群晖 DSM 7：**Container Manager 建立/编辑容器时，在“能力机制”中启用“使用更高权限执行容器”（不同语言版本可能译作“使用高权限执行容器”）。详见[群晖官方容器设置文档](https://kb.synology.com/index.php/zh-hk/DSM/help/ContainerManager/docker_container?version=7)。

fnOS 已实测单镜像 Shell 沙盒可正常运行。部署后确认打开的是该容器实际映射的宿主端口；Admin 页面应显示内置 Rootless daemon 已就绪。

## Compose 配置

一体化 Compose 从项目根目录 `.env` 读取编排变量，并把运行配置持久化到 `Gugu-data/.env`（挂载到容器 `/data`）。直接运行镜像时，运行配置同样保存在 `Gugu-data/.env`。分体生产部署仍使用 `backend/.env`。这些部署拓扑都可由 Admin 面板的 `config.override.json`（优先级最高，运行时热合并）补充或覆盖。

可以直接在项目根目录创建 `.env`，按需填写下面的 Compose 配置：

```dotenv
# PostgreSQL
# 一体化 Compose 使用 app 内置 PostgreSQL；外部数据库部署时再改成实际地址
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

# Shell 沙盒默认随一体化应用镜像启用，不需要配置独立执行镜像。

# 一体化 Compose 应用镜像
GUGU_WEB_IMAGE=coffeiz/gugu-web:latest
```

一体化 Compose 使用 `GUGU_WEB_IMAGE` 和 `GUGU_DB_PASSWORD`。只有需要分别管理前后端时才使用 `docker-compose.prod.yml`；从源码开发并热更新时使用 `docker-compose.dev.yml`。

默认一体化部署的持久化运行配置为 `Gugu-data/.env`；分体部署的应用配置放在 `backend/.env`，模板见 [`backend/.env.example`](../backend/.env.example)。根目录 `.env.example` 提供 Compose 编排变量模板。

`GUGU_PUBLIC_APP_URL` 是 Nginx 公开入口与后端外部链接生成共用的配置。邮箱验证、密码重置等邮件链接都使用它；不要填写 `backend:8000`、`localhost:9595` 等容器内部地址。Nginx 会向后端转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Port` 和 `X-Forwarded-Proto`。

## 配置模型和功能

大部分运行配置可以在 Admin 页面中修改。首次登录后，进入系统配置或 Agent 配置，填写模型 Provider、BYOK、联网搜索、邮件和 IM 等信息。

常用配置文件：

- `.env`：一体化 Compose 编排变量，包括可选的管理员初始账号密码
- `Gugu-data/.env`：默认一体化部署生成并持久化的运行配置
- `backend/.env`：分体生产部署配置
- `docker-compose.yml`：需要联网搜索时使用的一体化 Compose 部署入口
- `docker-compose.dev.yml`：源码开发 Compose 服务
- `docker-compose.prod.yml`：生产环境前后端分体部署

不要把真实密码、Token 或 API Key 提交到 Git。

## 生产部署补充

直接运行镜像的部署由 `docker run` 管理；Compose 路径通常使用 `docker compose up -d`。正式部署建议固定 release tag 或镜像 digest，并在升级前备份数据库和用户文件。环境变量和持久化目录的完整说明见[运维部署文档](ops/deploy.md)。

需要分别部署前后端时，使用 `docker-compose.prod.yml` 和对应的 backend/frontend 镜像。它是独立的分体拓扑，不是快速部署的必需组件；切换部署方式前，按运维文档迁移配置与数据，不要直接复用另一种拓扑的 `.env`。

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
