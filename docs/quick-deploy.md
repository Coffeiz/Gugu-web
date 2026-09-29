# Gugu 部署指南

这是一份面向普通使用者的简版部署说明。生产环境的反向代理、权限、备份和故障排查见[运维部署文档](ops/deploy.md)。

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

正式部署建议将 `latest` 换成固定版本标签（例如 `v<版本号>`）。单容器部署直接选择拉取后的 `gugu-web` 镜像；默认 Compose 使用 Docker Hub 镜像，也可在根目录 `.env` 中设置 `GUGU_WEB_IMAGE=ghcr.io/coffeiz/gugu-web:<版本号>` 改用 GHCR。

若 NAS 面板不能直接拉取镜像，可在有 Docker 的电脑或服务器上拉取后导出为 fnOS 可导入的未压缩 tar，再将文件导入 NAS：

```bash
docker save -o gugu-web.tar coffeiz/gugu-web:latest
```

若从 GHCR 拉取，请先将镜像标记为 `coffeiz/gugu-web:latest` 再导出。显式使用 DaoCloud 或 1ms 前缀只影响 `gugu-web`；Compose 额外使用的 SearXNG 是否能拉取，取决于 NAS Docker daemon 的镜像源配置。

## 前置要求

- 单容器部署：Docker 20+；Compose 部署：Docker Compose v2.20+
- 一个可访问的模型 Provider，或准备好的 BYOK 配置
- 能访问镜像仓库和模型服务的网络

## Gugu-web 单容器部署

直接使用 `coffeiz/gugu-web` 一体化镜像，不需要 Compose。配置容器端口 `9595`，将宿主机持久化目录分别映射到容器 `/data` 和 `/config`，并启用 privileged（特权容器）模式。数据库密码等环境变量可在容器设置中填写；未设置 `ADMIN_PASSWORD` 时，首次启动会生成随机管理员密码并持久化，同时把管理员账号和密码打印到容器日志中（可用 `docker logs <容器名>` 查看）。未设置 `ADMIN_USERNAME` 时账号默认为 `admin`。

单容器镜像包含完整站点、内置 PostgreSQL/Redis、内部 Rootless Docker、沙盒管理器和 Shell 执行镜像。Shell 沙盒默认启用，不需要单独部署 `sandboxd`、导入执行镜像或挂载宿主 Docker Socket。SearXNG 不包含在单容器镜像中，因此联网搜索功能不可用。

单容器更新分为两层：Admin「版本更新」可下载并验签 Gugu 应用包，在容器内安全切换应用代码并重启服务；它不会更新基础系统或替换 Docker 镜像。Docker 镜像、Rootless Docker、Shell 执行镜像及其他基础运行时更新，仍在 fnOS/群晖等 Docker 管理器中拉取新镜像并重建容器。请保留原有 `/data`、`/config` 映射；数据库迁移由新应用启动时执行，应用代码回滚不会自动逆转数据库迁移。旧版镜像需先通过 Docker 管理器更新到包含应用包更新运行时的版本。

> **安全提示：**privileged 会显著提高外层应用容器被攻破后的宿主机风险。内部 Rootless 只隔离其创建的 Shell 执行容器，不能消除外层应用的宿主风险；此部署方式面向可信个人单用户使用，不建议用于多租户、公网或业务服务器。

## 默认 Compose 部署

默认 `docker-compose.yml` 使用同一个 `coffeiz/gugu-web` 一体化应用镜像，并额外拉取 SearXNG 镜像提供联网搜索。Compose 不部署独立 updater 服务，也不挂载宿主 Docker Socket；app 在 privileged 外层容器内运行 Rootless Docker。

因此，默认 Compose 相比单容器增加联网搜索，但不提供 Admin 一键镜像更新；由 Docker/Compose 管理器更新整套镜像。Shell 沙盒仍由 `gugu-web` 内置 runtime 提供。**默认 Compose 没有独立 `updater` 或 `sandboxd` 服务，也不拉取独立 `gugu-sandbox` 执行镜像。**首次启动会初始化内置数据库并执行迁移，用户数据保存在 `Gugu-data`。

部署时保留 `docker-compose.yml` 与根目录 `.env`，并设置 `GUGU_DB_PASSWORD`。可以设置管理员账号密码、端口和镜像版本；未设置 `ADMIN_PASSWORD` 时，首次启动会生成随机密码并持久化，同时将管理员账号和密码打印到 app 容器日志（可用 `docker compose logs app` 查看）。未设置 `ADMIN_USERNAME` 时账号默认为 `admin`。`SECRET_KEY` 可留空，由首次启动生成并持久化。启动后通过 <http://localhost:9595> 访问，管理后台为 <http://localhost:9595/admin/>。不要删除 `Gugu-data` 或用模板覆盖已有 `.env`。

如需前后端拆分部署，请使用 `docker-compose.prod.yml`；该部署拓扑及其额外服务见[运维部署文档](ops/deploy.md)，不要与默认一体化 Compose 混用配置。

## fnOS / 群晖 NAS 配置

在 NAS 的容器高级设置中启用 privileged（特权容器），并配置 `9595` 端口映射、`/data` 与 `/config` 持久化目录。该选项等价于 Docker 的 `--privileged`，是容器内 Rootless Docker 启动 Shell 沙盒所需；**无需映射宿主 `/var/run/docker.sock`**。NAS 文件夹权限还需允许容器读写映射目录。

- **fnOS：**Docker 容器高级设置的“功能”中勾选“使用最高权限执行容器”。可参考[飞牛 fnOS 帮助中心](https://help.fnnas.com/)；该具体开关名称以 fnOS 容器界面为准。
- **群晖 DSM 7：**Container Manager 建立/编辑容器时，在“能力机制”中启用“使用更高权限执行容器”（不同语言版本可能译作“使用高权限执行容器”）。详见[群晖官方容器设置文档](https://kb.synology.com/index.php/zh-hk/DSM/help/ContainerManager/docker_container?version=7)。

fnOS 已实测单镜像 Shell 沙盒可正常运行。部署后确认打开的是该容器实际映射的宿主端口；Admin 页面应显示内置 Rootless daemon 已就绪。

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

# Shell 沙盒默认随一体化应用镜像启用，不需要配置独立执行镜像。

# 默认 Compose 应用镜像
GUGU_WEB_IMAGE=coffeiz/gugu-web:latest
```

默认 Compose 使用 `GUGU_WEB_IMAGE` 和 `GUGU_DB_PASSWORD`。只有需要分别管理前后端时才使用 `docker-compose.prod.yml`；从源码开发并热更新时使用 `docker-compose.dev.yml`。

默认一体化部署的持久化运行配置为 `Gugu-data/.env`；分体部署的应用配置放在 `backend/.env`，模板见 [`backend/.env.example`](../backend/.env.example)。根目录 `.env.example` 提供 Compose 编排变量模板。

`GUGU_PUBLIC_APP_URL` 是 Nginx 公开入口与后端外部链接生成共用的配置。邮箱验证、密码重置等邮件链接都使用它；不要填写 `backend:8000`、`localhost:9595` 等容器内部地址。Nginx 会向后端转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Port` 和 `X-Forwarded-Proto`。

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

## 生产部署补充

默认 Compose 通常只需使用 `docker compose up -d`。正式部署建议固定 release tag 或镜像 digest，并在升级前备份数据库和用户文件。环境变量和持久化目录的完整说明见[运维部署文档](ops/deploy.md)。

需要分别部署前后端时，使用 `docker-compose.prod.yml` 和对应的 backend/frontend 镜像。它是独立的分体拓扑，不是默认 Compose 的必需组件；切换部署方式前，按运维文档迁移配置与数据，不要直接复用另一种拓扑的 `.env`。

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
