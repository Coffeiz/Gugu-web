# 咕咕 部署文档（部署教程 + 运维手册）

从零把咕咕跑起来，再到日常运维排错。**全文分两部分**：

- **第一部分 · 部署教程（§1–§5）**：顺着读，从开发环境到生产上线（nginx + systemd + HTTPS + IM）。
- **第二部分 · 运维手册（§6–§10）**：按操作查——重启哪个进程、怎么更新、备份、调优、出问题怎么排。

## 易读概述（不懂运维也能看懂）

咕咕不是一个程序，是**好几个程序配合着跑**：一个负责网页和 API（web），一个负责在飞书/QQ 里聊天时"思考"（worker，咕咕的"大脑"其实在这），一个负责管理各平台的连接（gateway）。这三个是核心服务；启用生产 Shell 沙盒时，还要运行独立的 `gugu-sandboxd`，由它承接 Rootless Docker 执行。三个核心服务都要活着，IM 才能正常收发消息；只用网页版，可以只跑 web。

生产服务器上这些服务一般交给 **systemd** 管——相当于给每个程序配一个"看护人"，程序崩了自动拉起来，开机自动启动，不用人盯着。开发机则可以用前台热重载：web 用 Uvicorn reload，worker 用 `watchfiles` 监听代码后自动重启；gateway 和 sandboxd 按需单独重启。开发热重载与生产 systemd 是两套互斥的启动方式，不能让同一个进程同时跑两份。

日常最容易迷糊的两件事：
1. **改了代码该重启哪个**——大脑逻辑在 worker，不在 web，改错了重启等于没改，见 §6.1。
2. **改了数据库表结构，必须跑迁移**——不是重启就完事，见 §7.1。

不熟悉运维也没关系，下面每章节先有一段大白话，跳过命令细节也能明白在干什么；要动手操作时再回来看命令块。

## 快速导航

| 我想…                                            | 去看                                        |
| ---------------------------------------------- | ----------------------------------------- |
| 搞清楚要跑哪些进程                                      | §1 架构总览                                   |
| 第一次在本地把咕咕跑起来                                   | §2 环境要求 → §3 开发环境部署                       |
| 上线到生产服务器                                       | §4 生产环境部署（nginx + systemd + HTTPS）        |
| 接入飞书 / QQ / 微信                                 | §5 接入 IM 频道                               |
| **改了代码，该重启哪个进程？**（最常踩）                         | **§6.1 重启决策表**                            |
| 启停 / 重启 backend·worker·gateway·sandboxd              | §6.2 / §6.3                               |
| 增删启停某个 IM bot                                   | §6.4                                      |
| 更新线上代码（scp / zip / git）                        | §7 更新线上代码                                 |
| **改了数据库模型 / 加字段（schema 更新流程）**                  | **§7.1 Schema / 版本更新流程**                  |
| 备份数据                                           | §8 备份                                     |
| 服务器卡死 / OOM / 内存紧（2C/2G 机）                     | §9 低配服务器调优                               |
| 多台机器拆分网关 / worker                              | §5.2 多机部署                                 |
| 出问题了（500 / SSE 断 / IM 收不到 / 迁移报错 / 401 …）      | §10 故障排查                                  |

---

# 第一部分 · 部署教程

## 1. 架构总览：要跑哪些进程

> **大白话**：咕咕 = 一个网页前端 + 三个核心后端"常驻程序" + 一个按需启用的 Shell 沙盒执行服务 + 两个基础服务（数据库、消息队列）。前端只是个展示界面；web 接网页/API 请求，worker 是"大脑"，gateway 是"门卫"，sandboxd 是不让业务进程直接碰 Docker 的"执行闸门"。只用网页聊天不接 IM 的话，后两个核心进程和 Redis 都可以不开；不启用 Shell 沙盒时也不需要启动 sandboxd。

咕咕分前端 + 后端，后端由 **3 个核心常驻进程**、**1 个按需启用的沙盒执行进程** 和 **2 个依赖服务**组成：


| 角色             | 是什么                                | 命令（在 `backend/`，用 `.venv`）                      | 何时需要   |
| -------------- | ---------------------------------- | ----------------------------------------------- | ------ |
| **web**        | FastAPI（API + Admin），uvicorn :8000 | `make start` / `./start.sh start`               | 必须     |
| **worker**     | 消费 IM 队列 → 跑咕咕大脑 → 发回平台            | `.venv/bin/python -m worker`                    | 接 IM 时 |
| **gateway** | 频道管家：按 Admin 频道面板起停各平台网关子进程        | `.venv/bin/python -m agent.gateway.gateway` | 接 IM 时 |
| **sandboxd**   | 通过 Unix Socket 承接 Rootless Docker 沙盒执行；不接受调用方传入 Docker 参数 | `.venv/bin/python -m agent.sandbox.sandboxd --socket ... --allowed-root ...` | 启用生产 Shell 沙盒时 |
| PostgreSQL     | 主数据库                               | 系统服务 / Docker                                   | 必须     |
| Redis          | IM 消息队列（Streams）                   | 系统服务 / Docker                                   | 接 IM 时 |
| SearXNG        | 自建通用搜索（`web_search`，省 Tavily 配额）   | Docker / 1Panel                                 | 可选     |


> 前端：开发用 `npm run dev`（:5173）；生产 `npm run build` 出 `dist/`，由 nginx 托管。
> 不接 IM（飞书/QQ/微信）时，worker / gateway / Redis 可以不跑。
>
> 💡 **「咕咕的大脑跑在 worker，不在 web」**——记住这条，能省掉一半运维困惑（改大脑代码要重启 worker 而非 backend，详见 §6.1）。

---

## 2. 环境要求


| 依赖              | 版本    | 用途                                                                  |
| --------------- | ----- | ------------------------------------------------------------------- |
| Python          | 3.11+ | 后端                                                                  |
| Node.js         | 18+   | 前端构建                                                                |
| PostgreSQL      | 15+   | 数据库                                                                 |
| Redis           | 8+    | IM 队列（接 IM 才需）                                                      |
| **LibreOffice** | 任意    | 咕咕生成 Word/PDF/Excel（`create_document`）靠 `libreoffice --headless` 转换 |
| **CJK 字体** | `fonts-noto-cjk` | LibreOffice 生成 PDF 时提供中文/日文/韩文字形；浏览器字体另由前端构建产物提供 |
| **ffmpeg**      | 任意    | IM 语音理解：把 QQ/飞书语音（SILK/opus）转成 mp3 喂 mimo（配合 pip 的 `pilk` 解 SILK）。只装在跑 IM 网关的机器；没装则语音退文字提示 |
| **Docker Rootless** | Docker CLI + Rootless daemon | Shell 沙盒的固定镜像、断网容器和资源限制；只在启用生产 Shell 沙盒时需要 |


系统包（Debian/Ubuntu 示例）：

```bash
sudo apt update
sudo apt install -y python3-venv python3-dev build-essential \
                    postgresql redis-server libreoffice fonts-noto-cjk ffmpeg nginx
# Node 用 nvm 或 nodesource 装 18+

# 部署后只读检查 PDF 转换器和中文字体
python3 backend/scripts/check_pdf_fonts.py
```

检查结果应能看到 LibreOffice 版本，并且中文字体匹配到 CJK 字体；如果只匹配到
`Noto Sans` 或显示「未匹配到」，不要上线 PDF 生成功能。

启用生产 Shell 沙盒时，还要确认运行用户的 Rootless Docker 已可用，并准备 `uidmap`、`rootlesskit`、`slirp4netns`、`fuse-overlayfs` 和 user lingering。沙盒默认使用 `network=none`，不需要开放 Docker TCP socket。固定镜像必须预先加载，运行时使用 `--pull=never`；Docker、Rootless daemon 或固定镜像未就绪时，Shell 应失败，不会回退到宿主机执行。

Docker 日志必须启用轮转，避免 `json-file` 日志占满系统盘。仓库提供的开发/生产 Compose
服务统一使用 `50m × 3`；Rootless Docker 主机还应在
`~/.config/docker/daemon.json` 设置同样的全局默认值：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
```

修改 Rootless Docker 配置后执行 `systemctl --user restart docker.service`。这只会重启容器进程，
不会删除 Docker 数据卷；已有容器若要继承新的 Compose 日志选项，需要由对应项目重新创建，
不能只依赖普通 `restart`。

Docker Compose 同时提供一个受控的临时公网出口：`egress-proxy` 使用 `squid/egress.conf`，沙盒只加入内部网络 `gugu-sandbox-egress`，不能直接加入默认网络绕过代理。Admin 的“临时公网访问”开关只切换会话请求的网络 profile；每次实际 egress 执行仍由 sandboxd 校验内部网络、代理和用户确认，缺少任一条件都会保持断网。不要把沙盒改成 Docker `bridge` 或给业务进程开放 Docker socket。

---

## 3. 开发环境部署

### 3.1 拿代码

本项目部署**不依赖 git**，`scp`/`rsync` 传整个目录即可。开发就是本地目录。

### 3.2 后端：venv + 依赖

```bash
cd backend
python3 -m venv .venv                 # 建虚拟环境（脚本/Makefile 默认找 .venv）
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt
```

> 全程用 `.venv/bin/xxx` 绝对路径，**不用 `activate`**，避开 PEP 668 / 系统包污染。`make deps` 等价于上面最后一步。

### 3.3 配置

Compose 部署使用两份环境文件：项目根目录 `.env` 仅保存 Compose 编排变量，`backend/.env` 保存后端应用运行配置；两者都由 Admin 面板写入的 `config.override.json`（优先级最高，运行时热合并）补充或覆盖。

最小可跑：建 `backend/.env`（嵌套用双下划线 `__`）：

```
# 数据库（也可在 Admin 配）
DB__HOST=localhost
DB__PORT=5432
DB__NAME=gugu_web
DB__USER=gugu
DB__PASSWORD=gugu

# JWT 密钥（生产务必改）— 生成随机值：python3 -c "import secrets; print(secrets.token_urlsafe(48))"
SECRET_KEY=换成上面命令生成的随机长串

# 后台管理员账号（必须显式配置；改后重启后端生效）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成强密码

# Redis（接 IM 才需要）
REDIS__HOST=localhost
REDIS__PORT=6379

# AI / 存储 / 飞书等：建议启动后在 Admin 面板配（写入 config.override.json）
```

> 根目录 `.env`、`backend/.env` 和 `config.override.json` 都已 gitignore，不入库。AI key、飞书凭据等敏感配置**优先用 Admin 面板**填。

### 3.4 数据库

建库 + 用户（与上面 `.env` 对应）：

```bash
sudo -u postgres psql -c "CREATE USER pm WITH PASSWORD 'pm123';"
sudo -u postgres psql -c "CREATE DATABASE gugu_web OWNER pm;"
```

表结构：后端启动时自动 `create_all` 建表 + 跑内置 schema 迁移；也可手动 `make migrate`（`alembic upgrade head`）。

### 3.5 启动后端

```bash
# 开发用前台 + 热重载（改代码自动重启）
make dev-web       # = ./start.sh foreground，监听 app/agent/onboarding

# 接 IM 时另开终端；先停止同机 systemd worker，再启动 watcher
sudo systemctl stop gugu-worker  # 如果这台开发机由 systemd 管 worker
make dev-worker    # 监听 app/agent/onboarding/worker.py，Ctrl+C 停止

# 或后台跑
make start         # 后台 uvicorn :8000，日志 logs/gugu.log
make status        # 状态 + 健康检查
make logs          # 实时日志
```

健康检查：`curl http://127.0.0.1:8000/health` → `{"status":"ok"}`。

开发机如果要实际测试 Shell 沙盒，不要只启动 web/worker，还要以同一运行用户启动 sandboxd，并让 web/worker 继承同一个 Socket 环境变量：

```bash
export GUGU_SANDBOXD_SOCKET="/run/user/$(id -u)/gugu-sandboxd.sock"
.venv/bin/python -m agent.sandbox.sandboxd \
  --socket "$GUGU_SANDBOXD_SOCKET" \
  --allowed-root "$(realpath ../Gugu-data/users)"
```

前提是 Rootless Docker daemon 已启动、固定 digest 镜像已经加载，且 `../Gugu-data/users` 已存在。Socket 不存在或 Docker 不可用时，Shell 应明确失败；不要通过清空 Socket 或改成宿主机执行来“修复”。

> `make dev-worker` 需要先执行一次 `make deps-dev` 安装开发依赖。watcher 只适合开发机；生产仍使用 `systemctl restart gugu-worker`。停止 watcher 后，可执行 `sudo systemctl start gugu-worker` 恢复常驻 worker。

### 3.6 前端

```bash
cd frontend
corepack pnpm install --filter gugu-web...
corepack pnpm --filter gugu-web dev        # Vite :5173，已设 host:true 可局域网访问
```

浏览器开 `http://localhost:5173`。

### 3.7 IM 频道进程（接飞书才需要）

确保 Redis 在跑，然后两个进程（各开一个终端，或后台）：

```bash
cd backend
.venv/bin/python -m agent.gateway.gateway   # 频道管家
.venv/bin/python -m worker                        # 队列消费 worker
```

频道在 **Admin → Agent 配置 → 频道** 里加（详见 `[22-飞书接入指南.md](../agent/22-飞书接入指南.md)`）。

> ⚠️ 改了 `agent/` 大脑代码后要重启 **worker**（不是 web、也不是 gateway）——「改了什么、重启哪个」的完整决策表见 **§6.1**。

### 3.8 Admin 初始化

- Admin 后台：`http://localhost:5173/admin/login`
- Admin 没有公开默认密码；在 `.env` 设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 后重启后端，再登录后台。
- 登录后在「系统配置 / Agent 配置」里设 DB / Redis / AI provider / 存储 / 频道。

### 3.9 SearXNG 自建搜索（Compose 默认内置）

咕咕的 `web_search`（通用搜索）走自建 **SearXNG**，免费、不计配额；`deep_research`（外部资料研究）走 Admin 选择的 Tavily、百度搜索或 You.com。百度分支使用普通 `/v2/ai_search/web_search`，不调用 DeepResearch Agent。
根目录 `docker-compose.yml` 已默认包含 SearXNG，执行 `docker compose up -d` 后，后端自动使用
Compose 内网地址 `http://searxng:8080`，不需要在 Admin 页面手填地址。

Compose 还会自动执行一次数据库迁移，并把用户文件、缩略图、记忆和工作区统一保存到
`gugu_data` 持久卷的 `/data/users`。重建容器不会删除该卷；删除卷才会删除用户数据。

注意：`backend/config.override.json` 是应用的最高优先级配置。若是从已有部署迁移到
Compose，请检查其中是否还保留旧的 `db`、`storage` 或 `search.searxng_url`；这些字段会
覆盖 Compose 注入的服务地址。AI provider 等需要保留的 Admin 配置不受影响。

如果不使用 Docker，或希望使用另一台机器上的 SearXNG，再按下面的独立部署方式配置地址。

**推荐用 compose**（配置文件挂出来可改、重建不丢；1Panel → 容器 → 编排 直接贴）。⚠️ 两个最常踩的坑：① 必须开 `formats: json`，否则后端拿到 **403 Forbidden**；② SearXNG 与后端**不在同一台机**时，端口要发布到 `0.0.0.0`、地址填 `http://内网IP:端口`（不能填 127.0.0.1）。

```yaml
# docker-compose.yml
services:
  searxng:
    image: searxng/searxng:latest        # 国内拉不动换 docker.m.daocloud.io/searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    ports:
      - "8888:8080"                       # 跨机访问发布到 0.0.0.0；仅同机用可写 127.0.0.1:8888:8080
    volumes:
      - ./searxng:/etc/searxng:rw         # 配置挂出来，可编辑、重建不丢
    environment:
      - SEARXNG_BASE_URL=http://内网IP:8888/
      - UWSGI_WORKERS=1
      - UWSGI_THREADS=2
    mem_limit: 350m                       # 内存紧 / 与 DB 同机时限死，OOM 也只杀它、不拖垮别人
```

**配 settings.yml**（两选一）：
- **A 先启动再改**：`docker compose up -d` 后，编排目录的 `searxng/` 下会生成默认 `settings.yml` → 改两处：`server.limiter: false`、`search.formats` 加 `json` → 重启容器。
- **B 先放好再启动**：在编排目录建 `searxng/settings.yml`：
  ```yaml
  use_default_settings: true
  server:
    secret_key: "改成随机串：openssl rand -hex 32"
    limiter: false
  search:                      # ← 独立顶层段，和 server 平级
    formats:
      - html
      - json
  ```
  ⚠️ **`formats` 属于 `search:` 段，别误塞进 `server:`**——`search:` 是和 `server:` 平级的独立顶层段；放错位置 JSON 不生效、测试仍 403（常见错误）。

**配置 + 验证**：Docker Compose 环境可在宿主机用 `http://127.0.0.1:8888` 测试；后端实际使用
`http://searxng:8080`。非 Docker 环境在 Admin → Agent → 联网搜索填写同机
`http://127.0.0.1:8888`，跨机填写 `http://内网IP:8888`，然后点击「测试」。

Compose 自带配置位于 `searxng/settings.yml`，已经包含 `search.formats: [html, json]` 和
`server.limiter: false`。默认 secret key 只适用于本地/内网开发；生产环境必须替换它，并通过
防火墙或反向代理限制 8888 访问，不能把这个无认证 JSON 接口直接暴露到公网。

#### Compose 沙箱

沙箱不能仅靠 Compose 自动创建出安全的 Docker 运行时。它依赖宿主机已经配置好的 Rootless
Docker daemon 和固定 digest 镜像。Compose 已提供独立 `sandboxd` 服务，但默认不启动：

```bash
GUGU_DOCKER_SOCKET=/run/user/$(id -u)/docker.sock \
GUGU_SANDBOX_ENABLED=true \
docker compose --profile sandbox up -d
```

Web/Worker 不会挂载 Docker Socket，只通过共享的 `sandboxd.sock` 请求执行；如果 Rootless
daemon、固定镜像或 Socket 不满足要求，Shell 会拒绝执行，不会回退到宿主机命令。开发机若使用
rootful Docker，必须明确设置 `GUGU_SANDBOX_ROOTLESS_REQUIRED=false`，不建议用于生产。

### 3.10 生产构建物 Compose（默认端口 9595）

生产环境不要使用前面的开发 Compose。生产 Compose 只消费已经构建好的
`GUGU_BACKEND_IMAGE` 和 `GUGU_FRONTEND_IMAGE`，不挂载源码，也不启动 Vite 或 Uvicorn
热重载；前端由独立镜像提供静态 `dist`，入口 Nginx 负责页面、API 和 SSE 反代。

```bash
export GUGU_BACKEND_IMAGE=ghcr.io/coffeiz/gugu-web-backend:版本号
export GUGU_FRONTEND_IMAGE=ghcr.io/coffeiz/gugu-web-frontend:版本号
export GUGU_DB_PASSWORD='生产数据库密码'
docker compose -f docker-compose.prod.yml up -d
```

生产 Compose 默认把数据库配置为内部 PostgreSQL 服务 `postgres`，因此只需设置
`GUGU_DB_PASSWORD`。如果部署者已经有外部 PostgreSQL，可覆盖以下变量，后端会改连外部
数据库：`GUGU_DB_HOST`、`GUGU_DB_PORT`、`GUGU_DB_NAME`、`GUGU_DB_USER`、
`GUGU_DB_PASSWORD`。镜像和业务代码不需要修改；内部 `postgres` 服务仍会被 Compose
创建，但不会被后端使用。

Redis 采用相同规则：默认连接 Compose 内部的 `redis:6379`，可用
`GUGU_REDIS_HOST`、`GUGU_REDIS_PORT`、`GUGU_REDIS_PASSWORD` 覆盖为外部 Redis。
如果使用内部 Redis，设置 `GUGU_REDIS_PASSWORD` 后 Compose 会同时给内部 Redis
启用密码认证；不设置则保持开发默认的无密码内网连接。

构建镜像示例（在仓库根目录执行；前端 Runtime 从 npm 安装）：

```bash
docker build -f backend/Dockerfile.prod \
  -t ghcr.io/coffeiz/gugu-web-backend:版本号 .
docker build -f frontend/Dockerfile.prod \
  -t ghcr.io/coffeiz/gugu-web-frontend:版本号 .
docker push ghcr.io/coffeiz/gugu-web-backend:版本号
docker push ghcr.io/coffeiz/gugu-web-frontend:版本号
```

正式版本发布工作流会同时推送 GHCR 和 Docker Hub。Docker Hub 对应镜像为
`docker.io/coffeiz/gugu-web-backend` 和 `docker.io/coffeiz/gugu-web-frontend`；自动更新清单默认
仍使用 GHCR 的不可变 digest。手工发布到 Docker Hub 前，先使用具有推送权限的账号登录：

```bash
docker login docker.io
docker tag ghcr.io/coffeiz/gugu-web-backend:版本号 docker.io/coffeiz/gugu-web-backend:版本号
docker tag ghcr.io/coffeiz/gugu-web-frontend:版本号 docker.io/coffeiz/gugu-web-frontend:版本号
docker push docker.io/coffeiz/gugu-web-backend:版本号
docker push docker.io/coffeiz/gugu-web-frontend:版本号
```

访问地址为 `http://服务器地址:9595`。如需改端口，设置 `GUGU_HTTP_PORT`。
同时在项目根目录 `.env` 设置 `GUGU_PUBLIC_APP_URL` 为用户实际访问的完整地址；域名部署示例为 `https://gugugu.site`。该值会注入后端，用于生成邮箱验证、密码重置等外部链接，不能填写 `localhost:8000` 或 Compose 服务名。
生产 Compose 会自动执行数据库迁移，并持久化 PostgreSQL、用户文件、记忆、工作区和
Admin 的 `config.override.json`；不要删除 `pgdata`、`gugu_data` 或 `gugu_config` 卷。

生产部署目录仍需要提供 `backend/.env`（非代码构建物，用于 AI/IM 等运行配置）和
`searxng/settings.yml`。当前项目统一使用 `latest` 跟随基础服务和应用镜像的最新版本；
如需可复现发布，再通过环境变量覆盖应用镜像为具体版本或 Git SHA。
Shell 沙盒仍需额外提供宿主机 Rootless Docker Socket，并通过 `--profile sandbox` 启用。Compose 会同时启动受控 `egress-proxy` 和内部网络 `gugu-sandbox-egress`：

```bash
GUGU_DOCKER_SOCKET=/run/user/$(id -u)/docker.sock \
GUGU_SANDBOX_ENABLED=true \
docker compose -f docker-compose.prod.yml --profile sandbox up -d
```

Compose 已自动向 backend、worker 和 sandboxd 注入：

```text
SANDBOX__EGRESS_PROXY_URL=http://egress-proxy:3128
SANDBOX__EGRESS_NETWORK_NAME=gugu-sandbox-egress
SANDBOX__EGRESS_ISOLATION_ENABLED=true
```

检查受控出口：

```bash
docker compose -f docker-compose.prod.yml ps egress-proxy sandboxd
docker network inspect gugu-sandbox-egress
```

> **⚠️ 沙盒跑在 Rootless daemon 时（backend 通过 `GUGU_DOCKER_SOCKET` 指向
> `/run/user/<uid>/docker.sock`），egress 必须在 rootless daemon 里也有一份**——
> Compose 的 `egress-proxy` 容器和 `gugu-sandbox-egress` 网络建在 rootful daemon，
> 沙盒容器看不见，执行时报「受控 egress Docker 网络不存在」。
>
> **现在 compose 已自动处理**：`--profile sandbox` 启动时会先跑一次性服务
> `sandbox-bootstrap`，幂等确保目标 daemon 上有 egress 内部网络、squid 代理
> 和沙盒基础镜像；rootful 单 daemon 部署下各项已由 compose 提供，脚本自动
> 全部跳过（compose 管理的代理按 `com.docker.compose.service` 标签识别）。
> 日志出现「沙盒环境就绪」即通过
> （`docker logs gugu-web-main-sandbox-bootstrap-1`）。bootstrap 失败不阻塞
> sandboxd 启动（`required: false`），但 egress 会不可用，需查日志。
>
> **Rootless-only 主机**（没有 `/var/run/docker.sock`）：bootstrap 默认不再挂
> 宿主 rootful socket，缺失镜像时由 rootless daemon 直接 pull。若 rootless
> daemon 拉不到镜像，可在 `docker-compose.override.yml` 里把 rootful socket
> 只读挂进 bootstrap 的 `/var/run/docker.sock`，脚本会自动改走
> `docker save | load` 从宿主搬运。
>
> 手动等效操作（不依赖 bootstrap 服务时）：
>
> ```bash
> D='docker -H unix:///run/user/<uid>/docker.sock'
> $D network create --internal gugu-sandbox-egress
> docker save ubuntu/squid:latest | $D load
> $D run -d --name egress-proxy --network gugu-sandbox-egress \
>   --restart unless-stopped -v ./squid/egress.conf:/etc/squid/squid.conf:ro ubuntu/squid:latest
> $D network connect bridge egress-proxy   # squid 自己要走默认桥出网，沙盒侧仍是内部网
> $D run --rm --network=gugu-sandbox-egress -e HTTPS_PROXY=http://egress-proxy:3128 \
>   curlimages/curl:latest -sI https://www.baidu.com   # 端到端验证
> ```

检查通过后，可以在 Admin → Shell 沙盒直接填写并保存受控代理地址，再打开“临时公网访问”。这不会把沙盒默认网络改成公网；
只有当前会话显式选择 `network=egress` 且通过确认门时，sandboxd 才会使用内部 egress 网络。
代理配置文件为 `squid/egress.conf`，禁止改为普通 `bridge`，也不要给 backend/worker 挂载
Docker socket。非 Compose 部署需在 `config.override.json` 的 `sandbox` 中配置
`egress_proxy_url`、`egress_network_name` 和 `egress_isolation_enabled`，并确保这些配置对
sandboxd 可见；配置变更后重启 `gugu-sandboxd gugu-backend gugu-worker`。

- 测试返回 **403** = 没开 `formats: json`；**0 结果** = 引擎被限/不可达；**连不上** = 端口没发布到 0.0.0.0 或地址填错。
- **引擎**：国内服务器 google/bing/ddg 多会超时，一般只有 `sogou,quark,360search` 可达——按「测试」结果里列出的「超时引擎」调整「SearXNG 引擎」那栏。
- **安全**：`0.0.0.0` + `limiter: false` = 内网无认证可用；要更严可用防火墙只放行后端那台访问 8888。
- 关掉 SearXNG（清空地址）后，`web_search` 不可用；需要深度总结时使用 Admin 配置的 `deep_research` Provider。

---

## 4. 生产环境部署

> **大白话**：生产部署比本地多三件事：① 前端要"编译打包"成静态文件，交给 nginx（网页服务器软件）托管，而不是像开发时那样跑一个热更新的开发服务器；② 后端进程要交给 systemd 托管而不是手动跑在终端里（终端一关进程就没了）；③ 要配 HTTPS，否则浏览器会警告不安全。下面按顺序来。

生产 = 前端静态托管 + 后端常驻服务 + nginx 反代 + HTTPS。

### 4.1 系统依赖 + venv + 依赖

同 §2、§3.2（装系统包、建 `.venv`、`make deps`）。

### 4.2 配置（生产）

- `backend/.env`：填 DB / Redis / `SECRET_KEY` / 管理员账号（见 §3.3）。`SECRET_KEY` **务必换随机值**：
  ```bash
  python3 -c "import secrets; print(secrets.token_urlsafe(48))"
  ```
  > JWT（登录 Token）就是用 `SECRET_KEY` 签名的，**线上用默认值 = 任何人能伪造管理员/用户 Token**，必须换。改 `SECRET_KEY` 后所有已签发的 Token 失效（需重新登录），重启后端生效。
- 其余（AI key、OSS、飞书凭据）登录 Admin 面板配，落到 `config.override.json`。
- **公开站点地址**：在 `backend/.env` 设置 `PUBLIC_APP_URL=https://你的域名`。它是邮箱验证、密码重置等外部链接的唯一生成基址；若通过 Compose 启动，则用项目根目录 `.env` 的 `GUGU_PUBLIC_APP_URL` 注入同一值。
- **存储**：默认本地为仓库根目录下的 `Gugu-data/users/`（与 `backend/` 同级）；运行时不再创建或维护 `backend/uploads/`。历史迁移只由 `migrate_storage_root.py` 读取旧目录。

### 4.3 数据库迁移

```bash
cd backend && make migrate     # alembic upgrade head
```

本次 Shell 沙盒收口会应用两条新迁移：创建用户存储配额账本，并删除不再使用的
`conversation_sessions.shell_scope` 字段。迁移完成后可用下面的方式核对单一 head：

```bash
cd backend
.venv/bin/alembic current
.venv/bin/alembic heads
```

后端启动时会幂等扫描活跃用户，创建 `Gugu-data/users/<user-id>/shell`，登记文件库、
Shell 持久空间和临时空间三类配额；文件写入、`web_download`、构建和 Shell 执行事件
统一写入 `storage_quota_events`。不要手动删除账本行，异常用量应通过对账流程修复。

### 4.4 前端构建 → nginx 托管

```bash
cd frontend
corepack pnpm install --filter gugu-web...
corepack pnpm --filter gugu-web build                  # 产物在 frontend/dist/
```

nginx 配置（`/etc/nginx/sites-available/gugu`）：

```nginx
server {
    listen 80;
    server_name gugugu.site;

    # 前端静态（主站 + 后台是两个独立 SPA，共用 dist/ 根）
    root /path/to/Gugu-web/frontend/dist;
    index index.html;

    # 后台 SPA：路由 base 为 /admin，深链/刷新均回退到 admin/index.html（必须在 location / 之前）
    location /admin {
        try_files $uri $uri/ /admin/index.html;
    }

    # 字体是静态二进制资源，缺失时不能回退到 index.html，否则浏览器只会静默放弃字体。
    location ^~ /fonts/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # 主站 SPA
    location / {
        try_files $uri $uri/ /index.html;     # SPA 路由回退
    }

# 后端 API（主站 + 后台共用这一套反代）
location /api/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE（咕咕聊天流式）：关缓冲
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    client_max_body_size 100m;   # 文件上传
}
```

```bash
sudo ln -s /etc/nginx/sites-available/gugu /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> HTTPS：用 `certbot --nginx -d gugugu.site` 自动配 Let's Encrypt。

#### 4.4.1 1Panel 面板部署（对应上面 nginx，拆成面板几处填）

1Panel 不手写 nginx server 块，把上面那套拆进面板：

- **数据库 / Redis**：应用商店一键装 PostgreSQL + Redis（设密码）→「数据库」菜单建库，记下**库名/用户/密码/端口**填进 `.env`。⚠️ 1Panel 的 Postgres/Redis 端口常**不是默认** 5432/6379，在应用详情里看。
- **网站根目录** → 指向 `Gugu-web/frontend/dist`（网站设置里改根目录）。
- **反向代理**（网站 → 反向代理 → 添加）：代理路径 `**/api`**（⚠️ **不是 `/`**），目标 `http://127.0.0.1:8000`。SSE 在反代的「自定义/附加配置」框里补：
  ```nginx
  proxy_http_version 1.1;
  proxy_set_header  Connection '';
  proxy_buffering   off;
  proxy_read_timeout 3600s;
  ```
- **伪静态**（网站 → 配置 → 伪静态）：SPA 路由回退（主站 + 后台两个独立入口，顺序不能颠倒）
  ```nginx
  location /admin { try_files $uri $uri/ /admin/index.html; }
  location /      { try_files $uri $uri/ /index.html; }
  ```
  > 后台路由 base 为 `/admin`，所有 admin 页面 URL 形如 `/admin/config`、`/admin/login`，刷新时命中第一条规则。本地 admin dev server（`npm run dev:admin`）也需从 `localhost:5174/admin/` 访问。

**踩过的坑（按出现频率）：**

- `**nginx: [emerg] duplicate location "/"` 启动失败**：反向代理路径填成了 `/`（把整站都代理给后端）→ 和伪静态的 `location /` 撞车。**反代路径必须是 `/api`**——前端静态归 nginx，只有 `/api` 走后端。
- `**[Errno 98] address already in use`（8000 被占）**：多半上一次前台 uvicorn 没停。`ss -ltnp | grep :8000` 看谁占，`pkill -f "uvicorn app.main"` 杀掉；或换端口（记得同步改反代目标）。注意：能看到 `Application startup complete` 再报 bind 失败，说明**后端/DB 没问题，纯粹端口冲突**。
- **硬刷偶发 503（596 字节固定错误页）**：1Panel OpenResty vhost 的 `limit_conn perip 25` 太小——浏览器每个页签挂一条 `/api/v1/live/stream` SSE 长连接，硬刷再并发拉几十个 assets，同 IP 连接数冲破 25，limit_conn 超限默认返回 503（error.log 会写 `limiting connections by zone "perip"`）。2026-09-03 已放宽到 `perip 100` 解决。**判据**：access.log 503 与 error.log 的 limiting 记录一一对应即为此因；单发 curl 复现不了是正常的，必须算上长连接基数。
- **入口反代开启缓存导致"操作不生效、刷新后归位"**：1Panel/OpenResty 站点的 `location /` 若开 `proxy_cache`，会把 `/api` 的 GET 响应一并缓存（默认 `proxy_cache_valid 200 ... 10m`，key 只有 host+uri+args）——写入实际成功，但后续读取命中旧缓存，表现为用户操作后界面不变；且 key 不含 Authorization/Cookie，**不同用户命中同一 URL 会共享缓存响应，有跨用户泄露风险**。规则：`/api` 一律 `proxy_cache off`；静态资源可缓存但 `index.html` 不能长缓存（发版后会引用旧 hash 资源）。另：1Panel 改 vhost 可能被面板覆写，reload 前后各 `cat` 一次确认。排障口诀：接口日志正常、库里数据正确、客户端读到旧值 → 先查入口链路缓存。
- 私有仓库 clone：服务器生成 SSH key → GitHub 仓库 Settings → Deploy keys 加只读公钥 → `git clone git@github.com:...`（国内服务器连不上 GitHub 时走代理 / 镜像）。

### 4.5 后端服务（systemd · 一次装全 4 个）

> **大白话**：生产服务器上，咕咕的三个核心后端进程和一个沙盒执行服务交给 systemd（Linux 自带的服务管理器）托管——进程崩了它自动拉起来、服务器重启它自动跟着启动，不用人守着敲命令。前提是**一次性**先跑 `make install` 把四个单元注册给 systemd。没有启用 Shell 沙盒时，`gugu-sandboxd` 可以保持关闭，但模板仍会一并安装。
>
> **本项目部署现状**：生产环境和 dev 机的三个核心服务**都走 systemd**。`gugu-sandboxd` 的单元模板和安装入口已经加入，但某台机器只有在 Rootless Docker、固定镜像和用户数据根目录都准备好后，才应启用它。两种启动方式**不能同时用在同一台机器的同一个端口上**，选一个当唯一主人（详见下文「铁律」）；`scripts/dev-restart.sh` 仍保留在仓库供以后需要免 sudo 快速迭代的场景参考。
>
> ⚠️ **首次上线必须跑 `make install`，绝不能跳过直接 `make restart`。**
>
> `make install` 是一次性动作（把 service 注册到 systemd、设好显式的 `RUN_USER`、建好目录权限）。**跳过它**、直接用 `make restart` 或 `./start.sh start` 起 uvicorn：你是 root SSH 进去的，uvicorn 就以 **root** 身份跑，`Gugu-data/users/` 下创建或修改的文件 / 目录会变成 root:root —— 下次改成服务用户运行后，这些 root 目录 **写不进去** (`[Errno 13] Permission denied`)，咕咕移动文件、写临时文件都会报错。
>
> **判断是否漏跑过 install**：
> ```bash
> ps aux | grep uvicorn   # 看 USER 列：应是安装时指定的 RUN_USER，root = 漏了
> ls -la ../Gugu-data/users/ # 用户目录 owner 应与 RUN_USER 一致，有 root 的说明服务曾以 root 跑过
> ```
> **修复**（已有 root 目录时）：
> ```bash
> chown -R youruser:youruser /opt/1panel/www/sites/www.gugugu.site/Gugu-data/users/
> # 然后用同一个 RUN_USER 补跑 make install，再 systemctl restart gugu-backend
> ```

项目自带四个单元模板（`gugu-sandboxd.service` / `gugu-backend.service` / `gugu-worker.service` / `gugu-gateway.service`，均用 `__APP_DIR__`/`__RUN_USER__` 占位符）。`make install` 会安装并立即重启四个单元，因此启用前必须先准备 Rootless Docker、固定镜像和用户数据根目录：

```bash
cd backend && RUN_USER=youruser make install
sudo systemctl status gugu-sandboxd gugu-backend gugu-worker gugu-gateway
```

`gugu-sandboxd` 通过 `/run/user/<uid>/gugu-sandboxd.sock` 接收受限 JSON Lines 请求，业务进程不会直接持有 Docker socket。systemd 模板会自动注入 `DOCKER_HOST` 和 `GUGU_SANDBOXD_SOCKET`，不需要把它们配置成 TCP 地址，也不要把 Unix Socket 暴露给外部网络。

### Rootless 用户目录 ACL（可选初始化）

Rootless Docker 容器内的 `65532:65532` 需要通过宿主机 ACL 访问 `Gugu-data/users/*/shell`。ACL 初始化默认不执行，避免普通启动流程意外修改宿主机权限。

先查看计划：

```bash
cd backend
make sandbox-acl-plan ROOTLESS_LOGIN=gugu-sandbox
```

确认路径和映射无误后，显式执行：

```bash
cd backend
SANDBOX_ACL=1 sudo make sandbox-acl-apply ROOTLESS_LOGIN=gugu-sandbox
```

安装 systemd 服务时也可以选择同步执行：

```bash
cd backend
SANDBOX_ACL=1 sudo RUN_USER=gugu-sandbox make install
```

已经安装过服务时，也可以只在启动或重启前执行一次：

```bash
SANDBOX_ACL=1 RUN_USER=gugu-sandbox make start
SANDBOX_ACL=1 RUN_USER=gugu-sandbox make restart
```

不传 `SANDBOX_ACL=1` 时，`make start`、`make restart` 和 `make install` 都不会修改 ACL。

Compose 使用同一套宿主机初始化入口：

```bash
cd backend
make compose-up                         # 普通 Compose，不修改 ACL
SANDBOX_ACL=1 make compose-up           # 先应用 ACL，再启用 sandbox profile
```

直接执行 `docker compose up` 不会自动应用 ACL；`--profile sandbox` 只负责启动 sandboxd，不能替代宿主机权限初始化。初始化脚本只处理用户 Shell 持久目录，不会修改业务容器、镜像或数据库目录。

启用沙盒前先检查 Rootless Docker 和固定镜像：

```bash
systemctl --user status docker  # 或按本机 Rootless Docker 服务名检查
docker info
docker image ls
test -S "/run/user/$(id -u)/gugu-sandboxd.sock" || true
```

然后在 Admin → Shell 沙盒打开总开关。若 Docker daemon、固定 digest 镜像或 `sandboxd` 不可用，Shell 会返回明确失败，**不会回退到本机执行器**。部署代码已包含 sandboxd 接入，但在 devserver/生产执行 `make install` 并完成真实容器验证前，不应把它宣称为已启用。

> ⚠️ **`gugu-backend` 一直重启（`activating → failed → activating` 循环）/ `systemctl restart` 起不来、每次都要手动 pkill？根因永远是「8000 有两个主人」。**
> systemd 的 gugu-backend 想绑 8000，但端口被**另一个非 systemd 的 uvicorn**占着（你手动前台跑的、或 dev 机的手动启动器没停）→ systemd 绑不上「address already in use」→ `Restart=on-failure` 每 3s 拉起 → 死循环。`systemctl restart` 也停不掉那个手动进程（它不归 systemd 管）→ 你只能手动 pkill。
>
> **铁律：一台机器上 8000 只能有一个主人——要么 systemd、要么手动，绝不并存。** 生产用 systemd，dev 机用手动（见下「dev 机重启」）。
>
> 一次性清干净 + 让 systemd 接管：
> ```bash
> pkill -9 -f "uvicorn app.main"; fuser -k 8000/tcp 2>/dev/null   # 杀掉所有手动跑的旧后端
> ss -ltnp | grep :8000 || echo 空了
> sudo systemctl enable --now gugu-backend
> ```
>
> **强烈建议给 `gugu-backend.service` 加「启动前自愈腾端口」**——以后 `systemctl restart` 哪怕有野进程占着 8000 也能起来，再不用手动 pkill。在 `[Service]` 段、`ExecStart` 之前加两行：
> ```ini
> ExecStartPre=-/usr/bin/fuser -k -n tcp 8000
> ExecStartPre=/bin/sleep 1
> ```
> （`-` 前缀 = 没进程可杀也不算失败；service 的 `User=` 决定只能杀本用户的进程，正好杀掉手动那个。）改完 `sudo systemctl daemon-reload && sudo systemctl restart gugu-backend`。
>
> 注意：托管后**别再用 `pkill` 停 gugu-backend**（会被 `Restart` 立刻拉起、像「关不掉」），用 `systemctl stop`；`journalctl -u gugu-backend -n 30 --no-pager` 看真错。

> **备选方案（不走 systemd、免 sudo，目前没有环境在用）**：想避开 sudo、图快速迭代的场合，`scripts/dev-restart.sh` 提供了另一条路——把 `gugu-backend` 保持 `disable`，用脚本一条命令干净重启（自带腾端口，不撞冲突、不用手动 pkill）：
> ```bash
> bash scripts/dev-restart.sh          # 全部：web + worker + gateway
> bash scripts/dev-restart.sh web      # 也可只重启某一个
> ```
> ⚠️ 若某台机器要切到这条路，先 `sudo systemctl disable --now gugu-backend` 再用脚本，避免两边抢 8000。

`make install` 会：

- 按**当前 backend 目录**(`APP_DIR`)填好四个单元的 `WorkingDirectory`/`ExecStart`/`ReadWritePaths`（占位符，不写死路径——换部署目录不用手改）；
- 建出 `Gugu-data/users/`、`logs/`、`config.override.json` 并 `chown` 给运行用户（`ReadWritePaths` 要求路径**真实存在**，否则 systemd 报 `226/NAMESPACE`）；
- `daemon-reload` + `enable` + `restart` 四个单元；因此执行完整 `make install` 前必须先让 Rootless Docker、固定镜像和用户数据根目录就绪。只跑网页开发环境时，使用 §3 的本地启动方式，不要把完整 systemd 安装当成免 Docker 的安装路径。
- 运行用户必须显式指定：`RUN_USER=youruser make install`（须已存在、能读 `.venv` 与项目目录；项目在 `/home/<user>` 下时通常应使用该 user）。卸载：`make uninstall`（一并清四个）。

四个服务：


| 服务                | 进程                  | Restart                               | 日志                         |
| ----------------- | ------------------- | ------------------------------------- | -------------------------- |
| `gugu-backend`    | uvicorn 网页          | on-failure                            | `logs/gugu.log`            |
| `gugu-worker`     | IM 大脑（消费队列、跑 agent） | **always**                            | `logs/gugu-worker.log`     |
| `gugu-gateway` | IM 网关管家（拉飞书/QQ 子进程） | **always** + `KillMode=control-group` | `logs/gugu-gateway.log` |
| `gugu-sandboxd`   | Rootless Docker 沙盒执行服务 | **always** | `logs/` 或 systemd journal |


- **worker/gateway/sandboxd 用 `Restart=always`**：IM 进程死了必须秒拉起；sandboxd 退出后也应尽快恢复，否则生产 Shell 请求会明确失败。这是安全优先的失败方式，不会回退到宿主机执行。
- 三个核心单元的 `StandardOutput` 都 **append 到 `logs/gugu*.log`**（不走 journald）；sandboxd 的 systemd 日志以 `journalctl -u gugu-sandboxd` 为准。建议给 `logs/` 配 logrotate，免得 append 文件无限涨。

> 1Panel 部署：backend 一般在 `/opt/1panel/www/sites/<域名>/backend`，直接在该目录 `make install`，路径自动对上。

> ⚠️ **ProtectSystem=strict 沙箱 + LibreOffice**（2026-07-07 实测踩过、已修）：单元开了 `ProtectSystem=strict`，`$HOME/.config` 对进程只读，LibreOffice 转 Office（docx/xlsx/pptx 预览、`read_file` 读 Office）默认要在那建用户 profile，建不了直接 `returncode=1` 失败（PDF 走 pdftotext 不受影响，stderr 只留一条不相关的 `javaldx` 警告，真实原因不会自己冒出来）。**已在代码里修好，不用改 systemd 配置**：`app/api/v1/files.py` 的 `_office_to_pdf` 和 `app/core/doctext.py` 的 `_lo_convert` 调 LibreOffice 时都带了 `-env:UserInstallation=file://<本次临时目录>/loprofile`，把 profile 指到 `PrivateTmp=true` 保证可写的临时目录，不用放宽 `ProtectSystem=strict`、也不用碰 HOME。

> worker 想扩吞吐可起多个实例（共享 Redis 消费组自动负载均衡）；gateway 一台机一个即可。多机拆分见 §5.2。

### 4.6 Admin 安全

- **设置管理员账号**——在 `backend/.env` 显式设置：
  ```
  ADMIN_USERNAME=你的新用户名      # 不填默认 admin
  ADMIN_PASSWORD=你的强随机密码
  ```
  > 管理员账号是**配置驱动**的（不存数据库）：登录时按 `.env` 里的 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 校验。改完**重启后端**（`systemctl restart gugu-backend`）生效，用新用户名+新密码登录 `/admin/login`。
- `SECRET_KEY` 用强随机值（`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`）。
- CORS：`main.py` 默认只开 localhost:5173，生产改成实际域名。

---

## 5. 接入 IM 频道（飞书 / QQ / 微信）

> **大白话**：咕咕除了网页版，还能接到飞书、QQ、微信里当机器人用。接入靠 gateway（门卫）+ worker（大脑）两个进程配合：gateway 负责按 Admin 后台的开关去连/断某个平台，worker 负责真正处理消息、想回复内容。不接 IM 就不需要看这一节。

### 5.1 接入步骤

飞书 bot 创建、权限、长连接事件订阅、凭据填写、频道面板原理，**完整步骤见 `[22-飞书接入指南.md](../agent/22-飞书接入指南.md)`**。QQ / 微信（个人微信 iLink）走 Admin 面板扫码自连。

生产前提：确保 `gugu-gateway` + `gugu-worker` 两个服务在跑（§4.5），频道在 Admin 面板增删启停**即时生效**（日常增删启停、重启管家见 §6.4 / §6.3）。

网关 = `gateway` 按 Admin「频道」面板里**启用的 bot** 动态 `spawn` 的子进程（每个 bot 一条 WS 长连，飞书 `lark.ws` / QQ `botpy`），凭据由 gateway 以**环境变量注入**子进程（不进 argv，`ps` 看不到）。

### 5.2 多机部署：把网关 / worker 拆到独立服务器（可选，非默认）

> **默认单机部署**（web + worker + gateway + 网关同机）——一套配置管全部、Admin 配置/重启全生效、扩量靠单机内手段就够（见 `[并发优化ROADMAP.md](并发优化ROADMAP.md)` 部署形态决策）。**以下拆机为可选路径**，仅当确有多机需求时用。

> 网关/worker 和后台**不直接通信**，只在 **Redis + DB** 这条共享总线上碰头。所以拆机要配的就这两个 IP——**没有「web 的 IP」要填**。

那台新机的 `backend/.env`：

```bash
REDIS__HOST=<共享 Redis IP>      REDIS__PASSWORD=...
DB__HOST=<共享 DB IP>            DB__PASSWORD=...
```

起 worker + gateway（这台不必跑 web）：

```bash
./start.sh install                         # 装 systemd 三单元
sudo systemctl disable --now gugu-backend   # 只做网关/worker，不跑网页
# 或手动：.venv/bin/python -m worker  &  .venv/bin/python -m agent.gateway.gateway
```

起来即**自动接入**：worker 加入共享 Redis 消费组 `agent-workers` 分摊队列；gateway 读共享 DB 的 `user_bots` 拉网关。后台（在另一台）零改动，**「服务状态」页直接显示这台机**（host = 它的 hostname）。

**三条铁律：**

1. **全网只能一个 gateway** —— 两个会给每个 bot 各拉一条 WS → 同 bot 双连接、平台冲突。网关机只此一台跑 gateway，其余机器只跑 worker。
2. **worker 可多台**（消费组自动分摊），但同用户并发目前会乱序/串取消——多机前先做 `user_gate`/分片（见 `[并发优化ROADMAP.md](并发优化ROADMAP.md)` ①/③）。
3. **周期清理任务只一处跑**（web 那台），别在网关机重复（见 roadmap 进程优化 A）。

#### 跨主机的 Admin 限制

- **能看**：服务状态 / 队列水位 / 网关列表（心跳走共享 Redis，全局可见）。
- **不能配 / 重启**：Admin 改配置写的是**本机** `config.override.json`、重启只杀**本机** pid → 推不到另一台。远端机要改配置/重启，需 **ssh 上那台改 `.env` + 重启**。
- 想「Admin 填个 IP 就配好/重启远端」需建 Redis 控制面（共享配置 + pub/sub 失效 + 命令频道），暂未做。

---

# 第二部分 · 运维手册

## 6. 进程管理与重启

> **大白话**：改完代码，程序不会自己感知到变化，得手动"重启"对应的进程它才会用上新代码。咕咕最容易踩的坑是**重启错了进程**——比如改了聊天大脑的逻辑，却只重启了网页服务（web），结果 IM 里的行为完全没变，因为大脑代码其实跑在 worker 里。下面 §6.1 那张表就是用来对照「我改了什么 → 该重启谁」的，建议收藏。

### 6.1 改了什么 → 重启哪个进程（最常踩，先看这张表）

**咕咕的「大脑」跑在 worker，不在 web。** 改了什么、重启谁，对照下表（命令为生产 systemd；开发环境可用 `make dev-web` / `make dev-worker` 热重载）：


| 你改了…                                                              | 要重启                                    | 命令（生产）                            |
| ----------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| API / Admin 接口、`app/`、`main.py`、路由、新接口                            | **backend (web)**                      | `systemctl restart gugu-backend`  |
| 咕咕大脑：`agent/` 下 runner / core / skills / tools / 上下文 / 记忆 / prompts | **worker**                             | 开发：`make dev-worker`；生产：`systemctl restart gugu-worker`   |
| IM 网关代码：`agent/gateway/`（feishu / qq / wechat）、`router.py`        | **gateway**（连带重起所有网关子进程）            | `systemctl restart gugu-gateway` |
| Shell 沙盒：`agent/sandbox/`、固定镜像或 sandboxd 配置                  | **sandboxd + worker**                         | `systemctl restart gugu-sandboxd gugu-worker` |
| 前端 `frontend/`                                                    | 重新构建（不必重启服务）                           | `cd frontend && npm run build`    |
| 配置 `.env`（含 `SECRET_KEY` / 管理员账号）                                 | **backend**                            | `systemctl restart gugu-backend`  |
| **新增了模型字段 / 数据库列**                                                | **不是重启，是迁移！**                          | `make migrate`（见 §7）              |
| 启用 / 停用 / 增删某个 IM bot                                             | 都不用重启                                  | Admin 面板即时生效（见 §6.4）             |


⚠️ **三个最常见的错**：

- **只重启了 web、漏了 worker**：改了大脑代码却只 `make restart` / `systemctl restart gugu-backend`，结果「网页/IM 行为没按新代码变」（实时事件不发、新字段不写）——因为大脑在 worker。见 `../DEVLOG.md` 2026-06-23「漏重启 worker」。
- **以为 `make restart` 管全部**：它**只重启 web（uvicorn）**，不动 worker/gateway。IM 相关改动要单独重启对应进程。
- **改了 DB 模型只重启没迁移**：`create_all` 只建新表、**不给旧表加列** → 写入报「列不存在」。要 `make migrate`（见 §7 的 ⚠️）。

### 6.2 启停 / 重启 backend（web）

**已装 systemd（生产正途）** —— 直接 `systemctl`，别 `pkill`（`Restart=` 会把你杀的进程自动拉起）：
```bash
systemctl restart gugu-backend      # 重启 web；root 无需 sudo
systemctl stop    gugu-backend      # 停
systemctl status  gugu-backend
```

**手动前台跑（测试阶段）/ 端口被占卡住** —— 强杀进程再起：
```bash
pkill -9 -f "uvicorn app.main"      # 杀掉所有 uvicorn 实例
fuser -k 8000/tcp 2>/dev/null       # 兜底：谁占 8000 就杀谁（换成实际端口）
sleep 1
ss -ltnp | grep :8000 || echo "8000 已空闲"
# 再重新启动（前台测试用；常驻请走 systemd，见 §4.5）
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

> ⚠️ 进程已被 systemd 托管时**别用 `pkill`**——杀了会被 `Restart` 立刻拉起、看着像「关不掉」，用 `systemctl stop/restart`。
> ⚠️ 改了 `agent/` 大脑代码要重启的是 **worker**，不是 backend（见 §6.1）。
> ⚠️ **生产别用 `make start/stop/restart` 控制 backend**：生产的 web 是 systemd `gugu-backend.service` 在跑，而 `make start/stop` 管的是 Makefile 另起的「手动 uvicorn」——两者不是同一个进程。曾出现 `make stop` 报「未运行」但 `systemctl status` 显示服务正跑的迷惑现象，还可能两份一起起来抢 8000 端口。**生产一律 `systemctl`，`make` 留给开发机。**

### 6.3 启停 / 重启 worker / gateway

**开发机 Worker 热重载：**
```bash
make deps-dev       # 首次安装 watchfiles
sudo systemctl stop gugu-worker  # 若 worker 由 systemd 托管
make dev-worker     # 前台监听代码，Ctrl+C 停止
sudo systemctl start gugu-worker # 不再开发时恢复常驻 worker
```

`make dev-worker` 监听 `app/`、`agent/`、`onboarding/` 和 `worker.py`，每次 Python 文件变化都会重启 Worker。不要在 systemd worker 仍运行时启动它，否则会出现两个消费者同时处理 Redis 队列。

```bash
# 生产（systemd）
sudo systemctl restart gugu-worker       # 改了 agent/ 大脑代码后
sudo systemctl restart gugu-gateway   # 改了 adapters(feishu/qq/wechat)/router 后；KillMode=control-group 连带重起全部网关子进程
sudo systemctl stop gugu-gateway      # 停掉所有网关（连带子进程）
journalctl -u gugu-gateway -f         # 或 tail logs/gugu-gateway.log

# 开发（无 systemd）
.venv/bin/python -m worker                       # 前台 worker
.venv/bin/python -m agent.gateway.gateway   # 前台 gateway；Ctrl+C 停、连带杀子进程
```

也可在 **Admin → 服务状态** 页点「重启」（仅同主机有效，靠 kill + systemd 自愈）。

> ⚠️ `**systemctl stop gugu-gateway` 报 `Unit not loaded`**：说明这台机的 worker/gateway 是**手动 `python -m ...` 起的、没装成 systemd**，systemctl 自然不认。两条路：
>
> ```bash
> # A. 手动停（按进程，gateway 收 TERM 会连带杀网关子进程）
> ps aux | grep -E "agent\.adapters\.gateway|python -m worker" | grep -v grep   # 先看 pid
> pkill -TERM -f "agent.gateway.gateway"
> pkill -TERM -f "python -m worker"
> # B. 装成 systemd（推荐，之后 systemctl 可用 + 崩溃自拉 + 开机自启）
> cd backend && RUN_USER=youruser make install
> ```
>
> 手动起的进程：`systemctl` 管不了、服务页「重启」也指望不上、重启机器/崩溃不自拉——所以生产建议一律 `make install` 走 systemd。

### 6.4 增删 / 启停单个 IM 网关（不用重启服务）

- **增 / 删 / 开 / 关某个 bot**：在 **Admin → Agent 配置 → 频道** 里操作（或扫码自连）→ 写 `user_bots` 表 → gateway **每 ~1s 对账自动 spawn/kill** → **无需重启任何服务，秒级生效**。
- 凭据由 gateway 以**环境变量注入**子进程（不进 argv，`ps` 看不到）。
- 要重启整个网关管家（改了 adapters 代码时）见 §6.3。

### 6.5 看状态 / 日志

```bash
cd backend
make status              # web 状态 + 健康检查；完整 systemd 状态见下一行
make logs                # web 实时日志
sudo systemctl status gugu-sandboxd gugu-backend gugu-worker gugu-gateway
sudo journalctl -u gugu-sandboxd -f                      # 沙盒执行服务
sudo journalctl -u gugu-gateway -f                    # 看频道起停日志
```

---

## 7. 更新线上代码

> **大白话**：本项目不强制用 git 部署，更新代码的方式很朴素——把改好的文件传上服务器（scp/rsync/zip 都行），然后跑几条命令让新代码生效：装可能新增的依赖包、跑数据库迁移（如果改了数据库表结构）、重启对应的进程。**最容易漏的一步是数据库迁移**——只传代码不迁移，新加的字段在数据库里根本不存在，一写入就报错。

### 7.0.1 Docker Compose 生产镜像更新

生产 Docker 部署不需要下载 Git 源码或在用户服务器重新构建。正式版本由 GitHub Actions 构建并推送到 GHCR，GitHub Release 附带 `update-manifest.json` 和签名 bundle。更新前先下载这两个资产，再使用仓库内的安全入口：

```bash
scripts/release/compose-update.sh \
  --manifest /path/to/update-manifest.json \
  --bundle /path/to/update-manifest.json.bundle \
  --confirm
```

脚本会验证 manifest、Release 签名和 backend/frontend 镜像签名，备份 `backend/.env` 与数据库，拉取 manifest 指定的不可变 digest，并重建业务容器。它不会执行 `docker compose down -v`、无范围 `docker system prune`，也不会删除 `pgdata`、`gugu_data`、`gugu_config` 或 `sandbox_socket` 卷。

普通更新不带 `--profile sandbox`，因此不会因为更新业务镜像而拉取 egress proxy 或其他沙盒专用镜像。若当前已有 `sandboxd` 在运行，脚本只会同步使用中的业务镜像，不会自动改变沙盒开关。

部署安全约束：Compose 文件统一固定 project name 为 `gugu-web-compose`，从而保证数据库始终使用同一个 `gugu-web-compose_pgdata` 卷。不要通过改 project name、`-p` 参数或 `docker compose down -v` 启动/清理生产环境；更新前应先确认 `docker inspect gugu-web-compose-postgres-1` 的挂载卷仍为该卷。systemd/源码部署使用 `backend/deploy.sh` 时，会在迁移前生成包含 PostgreSQL custom-format dump 的完整备份，并在迁移后检查关键表和 Alembic 版本；数据库备份失败会直接中止部署。

更新脚本依赖环境中已有的 `GUGU_DB_PASSWORD`，并从 `backend/.env` 校验 `ADMIN_PASSWORD`，不会从仓库文件或命令参数打印这些凭据。`COSIGN_IDENTITY_REGEXP` 和 `COSIGN_OIDC_ISSUER` 可用于企业部署时收紧签名发布者范围。

```bash
# scp/rsync 传新代码后：
cd backend
make update              # = deps + migrate（装依赖 + 跑迁移）
sudo systemctl restart gugu-backend   # 重启 web（生产走 systemd，别用 make restart，见 §6.2）
sudo systemctl restart gugu-worker gugu-gateway   # 重启 IM（若改了 agent 代码，见 §6.1）
# 若更新了 sandboxd / Docker 执行策略，再重启沙盒执行服务
sudo systemctl restart gugu-sandboxd
cd .. && corepack pnpm install --filter gugu-web... && corepack pnpm --filter gugu-web build        # 前端重新构建
# 或一键：make deploy（备份 + 依赖 + 迁移 + 前端 build + 重启）
```

> ⚠️ **务必 `make migrate`，别只 restart**：启动时的 `create_all` **只建缺失的表、不会给已有表加新列**。所以凡是新增了模型列（如 `conversation_messages.files` 文件卡片、`conversation_sessions.source` 会话来源、`conversation_sessions.summary` 会话总结），只重启不跑迁移 → 相关写入会因「列不存在」报错。`make update` / `make deploy` 已含 migrate；手动更新记得补 `make migrate`。
>
> 🔥 **scp / rsync 单传文件最易踩**（devserver 实战）：单传了带新列的模型代码、却忘了 `make migrate` → **每次对话一查 `conversation_sessions` 就崩，连带反思 / 感知遥测全不跑**。排查时表面像「某功能没数据」，根因其实在这。**传了模型改动 = 立刻补 `make migrate` + 重启。**

`backend/backup.sh` 生成的归档包含 `database.dump`、`config.override.json`、用户持久目录和迁移文件。恢复数据库时使用 `pg_restore` 到确认过的目标库，禁止直接删除生产卷后重建；恢复前必须另做一次当前库备份。

### 7.1 数据库 Schema / 版本更新流程（改了模型后必看）

咕咕没有版本号概念，「版本更新」= **代码 + 数据库 schema 一起往前推**。只改代码（不动表结构）按上面 §7 走即可；**一旦改了数据库模型（`app/models.py` 加/删字段），分两侧，作者侧那步最容易漏**：

**① 作者侧（本地，改完模型立刻做）：新建一条迁移**

1. 改 `app/models.py`（加/删字段）。
2. 在 `backend/alembic/versions/` 建迁移文件 `YYYYMMDDNNNNNN_描述.py`：
   - `revision` = 时间戳 ID；`down_revision` = **上一条迁移的 revision**（链式串起来，别断链——`alembic heads` 应始终只有一个 head）。
   - 写 `upgrade()` / `downgrade()`，**一律用幂等 DDL**（本项目铁律）：
     ```python
     def upgrade():
         op.execute("ALTER TABLE 表 ADD COLUMN IF NOT EXISTS 列 类型 ...")     # 加列
         op.execute("CREATE INDEX IF NOT EXISTS ix_xx ON 表 (列)")            # 加索引
         # 删废弃列：op.execute("ALTER TABLE 表 DROP COLUMN IF EXISTS 列")
         # 建新表：  op.execute("CREATE TABLE IF NOT EXISTS ...")
     ```
     > 为什么必须幂等：生产库的表常是后端启动时 `create_all` 直接建的，列**早已存在**；迁移用裸 `op.add_column`（无 `IF NOT EXISTS`）在 `upgrade head` 从 base 重放时会撞 `DuplicateColumnError`（§10.2 的根因）。`IF [NOT] EXISTS` 让「已存在就跳过」，全新 DB / 老库重放都安全。
   - 嫌手写麻烦：`.venv/bin/alembic revision --autogenerate -m 描述` 让它扫「模型 vs 库」差异自动生成 —— 但 **autogenerate 有假阳性**（`alter_column` 类型/server_default/索引命名多是噪音），生成后**逐条核对、改成幂等 DDL**，别整份照用。
3. 本地 `make migrate` 验证能升上去（`alembic current` 应显示到你这条）。

**② 部署侧（服务器，上线）：** 就是 §7 那套 —— `make deploy`（含迁移）或 `make update` 后重启。迁移 = `alembic upgrade head`，只补 `down_revision` 链上还没应用的那几条。

**谁负责建 schema（记这张表就够）：**

| 改动                | 谁来建                          | 漏跑迁移的后果                                    |
| ----------------- | ---------------------------- | ----------------------------------------- |
| **新表**            | 启动时 `create_all` 自动建（迁移可省，仍建议写） | 一般没事                                       |
| **给旧表加 / 删列**     | **只能靠迁移**（`create_all` 不碰已有表）  | INSERT 报「列不存在」/「not-null 违约」→ 建项目/任务直接崩 |

> 铁律一句话：**改了已有表的列，必须有配套（幂等）迁移，且上线时真的跑了。** 出 `DuplicateColumnError` / `null value violates not-null` 这类，按 §10.2 恢复。

### 7.2 zip 打包上传更新（无 git 时）

没在生产配 git 的话，可以本地打 zip → 传服务器解压。**关键：打包必须排除服务器独有的状态文件，否则解压会覆盖掉它们。**

| 文件/目录 | 被覆盖的后果 |
|---|---|
| `backend/.env` | **丢生产 DB 密码 + `ADMIN_USERNAME`/`ADMIN_PASSWORD`**（最致命） |
| `backend/config.override.json` | 丢 Admin 配的 AI key / 飞书凭据 / 存储设置 |
| `backend/.venv` | venv 是按本机平台编译的，Mac→Linux 覆盖后**跑不起来** |
| `Gugu-data/users/` | **抹掉所有用户文件、Shell 沙盒持久目录 + 咕咕 `.agent/` 记忆** |

本地打包（排除上述 + 缓存）：
```bash
cd <项目根>
zip -r backend.zip backend \
  -x 'backend/.venv/*' -x 'backend/.env' -x 'backend/config.override.json' \
  -x 'backend/logs/*' -x 'Gugu-data/users/*' -x '*/__pycache__/*' -x '*.pyc'
```
服务器解压 + 收尾：
```bash
cd <项目目录> && unzip -o backend.zip       # -o 覆盖代码；.env/.venv 没打进 zip 故不受影响
cd backend
.venv/bin/pip install -r requirements.txt   # requirements 变了才需要
make migrate                                 # 有新模型列时（见上 ⚠️）
systemctl restart gugu-backend               # 改了 web/后端
systemctl restart gugu-worker                # 改了 agent/ 大脑代码
systemctl restart gugu-sandboxd              # 改了 agent/sandbox 或 sandboxd 配置
systemctl restart gugu-gateway            # 改了 IM 网关代码
```

> **更稳的做法**：生产配一次 git deploy key（见 §4.4.1），以后更新就 `git pull` + 重启——git 只动跟踪文件，`.env`/`.venv`/`Gugu-data/users` 都不应被代码更新覆盖，天然无「覆盖状态」风险，省去每次手动排除。
>
> ⚠️ 但 `git reset --hard` / `git clean -fdx` / 重新解压 zip **会**冲掉这些 gitignore 的状态文件（`.venv` 被删 → 服务 `203/EXEC`；`.env`/`config.override.json` 被删 → DB 密码丢、`password authentication failed for user "pm"`）。**任何代码刷新后，启动/迁移前先确认三样都在**：`.venv` 能跑（`.venv/bin/python -V`）、`.env` + `config.override.json` 里 DB 密码正确。缺了先补（重建 venv 见 §3.2，恢复 DB 密码见 §3.3/§3.4），再 migrate / 启动。

> **配置缺失保护**：`deploy.sh`、`start.sh install` 和存储迁移不会再因缺少 `config.override.json` 静默创建空配置；这样可避免 `RUN_USER=...` 安装时把 Admin 设置误判为被清空。应先从 `.deploy-backups` 或正式备份恢复。只有全新部署确认没有历史配置时，才显式使用 `INIT_EMPTY_CONFIG=1 RUN_USER=<用户> make install` 创建空文件。
>
> ⚠️ **重建 `.env` 时务必沿用原来的 `SECRET_KEY`,别重新生成。** `SECRET_KEY` 一变,**所有已签发的登录 token 立刻失效** → 部署后用户访问任何需登录的接口都 `401`，前端表现为「数据页全部加载失败 / summary 401」。这不是数据/权限 bug，**重新登录即恢复**（旧 token 用旧 key 签的，新 key 验不过）。根治:`SECRET_KEY` 当成长期不变的密钥存在 `.env` 里，跨部署保持同一个值；每次部署重新随机生成 = 每次把全员登出。有旧值备份就填回旧值，连用户重登都省了。

---

## 8. 备份

> **大白话**：一条命令把「数据库 + 用户数据 + Admin 后台配置」打包备份好。这三样丢了就真的丢了（没有云端自动备份），建议定期跑或配 crontab 定时跑。

```bash
cd backend && make backup     # 备份数据库 + Gugu-data/users + config.override.json
```

> 用户文件和 Shell 沙盒持久目录统一位于仓库根目录下的 `Gugu-data/users/`。旧 `backend/uploads/` 只由一次性迁移脚本读取，不参与运行时和备份。`config.override.json` 含所有 Admin 配置（含明文凭据），两者都要备。Docker 镜像和临时容器不属于应用备份，固定镜像应由部署清单或镜像仓库单独保留，不能依赖 `docker system prune` 后仍存在。

---

## 9. 低配服务器调优（2C/2G 这类）

> **大白话**：便宜的云服务器常见配置是 2 核 CPU + 2G 内存。咕咕同时要跑好几个 Python 进程 + 数据库 + Redis，这点内存**跑得起来但很紧张**，稍微多几个人同时用就可能被系统"内存不够杀进程"（OOM）强制干掉，表现为服务莫名其妙掉线。下面几条是从紧到松的调优手段：加交换空间兜底、别在这台机上开耗资源的管理工具、把咕咕自己的进程数调小。都是配置层面的调整，不用改代码。

咕咕 = Python web + worker + gateway + 可选 sandboxd + 网关 + PostgreSQL + Redis，2C/2G 上跑得起来但**很紧**，容易 OOM / CPU 打满。启用 Shell 沙盒时还要给 Rootless Docker daemon 和容器预留内存、临时空间与 PID 配额。按这套调：

**① 加 swap（2G 内存必配，防 OOM 杀进程）**
```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab     # 开机自动挂
free -h                                              # 确认 Swap 行有值
```
> swap 不替代内存，但内存峰值有它兜底，不至于直接被 OOM killer 杀掉（咕咕 backend 被 `code=killed status=9` 多半就是 OOM）。

swap 配了但使用率一直 0？多半是 `vm.swappiness` 太低（云服务器默认常为 0，内存耗尽前不动 swap）。2G 这类内存紧的机器推荐调到 **40**，让内核提前把冷页换出、给活跃进程留 RAM（10 太保守，60 是桌面默认太激进）：
```bash
sudo sysctl vm.swappiness=40                          # 立即生效
echo 'vm.swappiness=40' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p                                        # 重载确认（最后一行应显示 vm.swappiness = 40）
# 若 /etc/sysctl.conf 里原本有旧的 vm.swappiness 行，清掉避免歧义：
sudo sed -i '/^vm\.swappiness/d' /etc/sysctl.conf && echo 'vm.swappiness=40' | sudo tee -a /etc/sysctl.conf
```

**② 别在这台机跑非必要的重应用**：pgAdmin、其它面板应用等很吃 CPU/内存（pgAdmin 曾崩溃重启循环把 CPU 烧到 100% 整机卡死）。看库用 1Panel 自带的数据库管理或本地客户端远程连，**别在生产机常驻 pgAdmin**。

**③ 降咕咕自身占用**：
- **web 改单进程**（⚠️ **2G 机最容易踩的 OOM 坑**）：`make install` 装的 `gugu-backend.service` 模板默认 **`--workers 2`** —— 两个完整 app 进程各 ~250M，2G 机上加 Postgres/Redis 直接顶爆，反复被 OOM 杀（日志 `oom-kill` / `code=killed status=9`）。改成 1 个 worker，内存减半（uvicorn 异步 IO 密集，单 worker 够用）：
  ```bash
  sed -i 's/--workers 2/--workers 1/' /etc/systemd/system/gugu-backend.service
  systemctl daemon-reload && systemctl restart gugu-backend
  ```
- worker 并发度调小：后台 → Agent → `worker_concurrency` 设 **4**（默认 16，小核机器吃不消）；
- 不用 IM 就在后台**停用 bot**，gateway 不拉网关子进程，每个省 ~60–80M。

**④（可选）systemd 给服务设资源上限**，防单个吃爆整机（`systemctl edit gugu-worker`，drop-in 里写——**不能写行内注释**）：
```ini
[Service]
CPUQuota=50%
MemoryMax=512M
```
保存后 `systemctl daemon-reload && systemctl restart gugu-worker`，`systemctl show gugu-worker -p CPUQuota -p MemoryMax` 验证。

> **排查整机卡死**：先 `ps aux --sort=-%cpu | head` 看**谁**在烧 CPU（常常不是咕咕，而是别的应用）、`free -h` 看内存、`journalctl -u gugu-backend -n 40` 看有没有 OOM 杀。别一上来就以为是自己代码。

> **真要稳 + 扩用户：升 4G**。Python + Postgres + Redis + IM 多进程，4G 才舒服，2G 一波并发就贴 OOM 线。

---

## 10. 故障排查

> **大白话**：这一章是"对症下药"速查表——先看 §10.1 的表格，把你看到的现象（比如网页打不开、发消息没反应、后台报 401）对照左栏找到对应行，右栏就是解法。大部分问题的根因逃不出这几类：**忘了重启该重启的进程**（§6.1）、**忘了跑数据库迁移**（§7.1）、**端口被占用/两个进程抢一个端口**（§4.5「铁律」）、**权限问题**（用 root 而不是 www-data 启动过服务）。§10.2 是数据库迁移报错时更详细的抢救步骤，遇到 `DuplicateColumnError` 这类再去看。

### 10.1 常见问题速查表


| 现象                                     | 解法                                                      |
| -------------------------------------- | ------------------------------------------------------- |
| 后端 500 / 启动失败                          | 必须从 `backend/` 目录起（否则 `.env` 不加载）；查 `logs/gugu.log`     |
| 生成 Word/PDF/Excel 失败                   | 没装 **LibreOffice**（`apt install libreoffice`）           |
| 聊天流式（SSE）被截断                           | nginx 要 `proxy_buffering off` + 拉长 `proxy_read_timeout` |
| IM 收不到/回不出                             | Redis 没起；或 gateway/worker 没跑；详见 飞书接入指南排错表        |
| 「改了代码但行为没变」                            | 多半漏重启 worker（大脑在 worker，不在 web）——见 §6.1 重启决策表          |
| worker `Timeout reading from ...:6379` | 已修：`app/core/redis.py` `socket_timeout=None`（旧版本需更新代码）  |
| Admin 频道保存「消失」                         | 后端加了 `/admin/agent/bots` 接口后要 `make restart`            |
| `pip install` 报 externally-managed     | 用 `.venv/bin/pip`（绝对路径），别用系统 pip                        |
| 登录/接口报 `ERR_SSL_UNRECOGNIZED_NAME_ALERT`（页面能开、API 失败） | **SSL 证书没覆盖该域名**（如证书只签了 `gugugu.site`，没含 `www.gugugu.site`）。1Panel 网站→证书 重签 Let's Encrypt，**域名列表同时勾 `gugugu.site` + `www.gugugu.site`**（或通配 `*.gugugu.site`）；前提是该域名 DNS 已解析到本机。验证：`echo \| openssl s_client -servername www.gugugu.site -connect www.gugugu.site:443 2>/dev/null \| openssl x509 -noout -ext subjectAltName` 看 SAN 里有没有该域名 |
| `make install` 后 gugu-backend 一直重启   | 旧的手动 `uvicorn :8000` 没停、占着端口 → systemd 版绑不上崩 → `Restart` 循环。`systemctl stop gugu-backend` + `pkill -9 -f "uvicorn app.main"` + `fuser -k 8000/tcp` 清掉再 `systemctl start`（详见 §4.5 / §6.2） |
| nginx `duplicate location "/"` 启动失败 | 反向代理路径填成了 `/`（整站代理给后端）和伪静态 `location /` 撞 → 反代路径必须是 `/api`（详见 §4.4.1） |
| `gugu-backend` 反复被 OOM 杀（`oom-kill` / `code=killed status=9`） | 小内存机（2G）上 systemd 模板默认 `--workers 2` 太吃内存 → 改单 worker：`sed -i 's/--workers 2/--workers 1/' /etc/systemd/system/gugu-backend.service && systemctl daemon-reload && systemctl restart gugu-backend`；并加 swap（详见 §9） |
| 整机 CPU 100% / 卡死 | 先 `ps aux --sort=-%cpu \| head` 看**谁**在烧（常是 pgAdmin 等第三方应用，不是咕咕）；`free -h` 看内存、`journalctl -u gugu-backend` 看 OOM（详见 §9 + devlog 2026-06-25） |
| 服务 `status=203/EXEC` 起不来 | systemd 执行不了 ExecStart 里的 `.venv/bin/...` → **venv 缺失/损坏**（多半被 `reset --hard`/`clean`/重新解压冲掉）。重建 venv + 装依赖（§3.2），并确认 `.env`/`config.override.json` 也在再启动 |
| `gugu-sandboxd` 起不来 / Shell 报 Socket 不可用 | 先看 `systemctl status gugu-sandboxd` 和 `journalctl -u gugu-sandboxd -n 50 --no-pager`；再检查 `DOCKER_HOST` 指向当前运行用户的 Rootless Socket、固定 digest 镜像已加载，以及 `/run/user/<uid>/gugu-sandboxd.sock` 是否存在。不要清空 Socket 让业务回退宿主机执行 |
| Shell 报固定镜像未找到或 Docker 不可用 | 生产沙盒使用 `--pull=never`，必须由部署流程预先加载固定 digest 镜像；确认 Rootless daemon 属于和 systemd 单元相同的 `RUN_USER`，并用该用户执行 `docker info`。Docker/镜像未就绪时应保持 Shell 失败，不得切换到 direct Docker 或本机执行 |
| `gugu-sandboxd` 与 backend/worker 使用的 Socket 不一致 | systemd 安装会自动注入同一个 `/run/user/<uid>/gugu-sandboxd.sock`。检查四个 unit 的 `Environment=`，不要在 `config.override.json` 写入另一条 `sandboxd_socket` 覆盖它；修改后执行 `systemctl daemon-reload` 并重启 `gugu-sandboxd gugu-backend gugu-worker` |
| `password authentication failed for user "pm"` | DB 配置被部署冲掉、密码退回占位值。把 `.env`/`config.override.json` 里的 DB 密码恢复成生产真实值（1Panel→数据库 可看/重置），与 Postgres 里 `pm` 用户密码一致（详见 §7 ⚠️ / §3.4） |
| `alembic upgrade head` 报 `DuplicateColumnError`（从 base 重放撞已有列） | 生产库由 `create_all` 建、`alembic_version` 空 → 重放撞车。`alembic stamp head` 认账停止重放，再手动补本次新迁移的幂等 DDL（新表靠 `create_all`，新列手动 `ADD COLUMN IF NOT EXISTS`）。详见 §10.2 |
| 建项目/任务报 `null value in column "xxx" violates not-null constraint`（如 `notes`） | 新代码删了该字段、INSERT 不再带它，但旧库那列还是 `NOT NULL` 无默认 → 必须把废弃列删掉：`ALTER TABLE 表 DROP COLUMN IF EXISTS 列`。用 `alembic revision --autogenerate` 全量核对漏补/漏删（详见 §10.2） |
| `make stop` 说「未运行」但 `systemctl` 显示服务在跑 | 生产 backend 由 systemd `gugu-backend.service` 托管，`make start/stop` 管的是另起的手动 uvicorn → 两者不是一个进程。生产一律用 `systemctl`（详见 §6.2） |
| 部署后数据页全部「加载失败 / summary 401」 | 重建 `.env` 时 `SECRET_KEY` 变了 → 旧登录 token 全失效。**重新登录即恢复**；根治:`SECRET_KEY` 跨部署保持同一值，别每次重新生成（详见 §7 ⚠️ / §4.2） |
| 咕咕移动文件报权限错误 | 首次部署漏跑了 `make install`，服务用户没有 `Gugu-data/users/` 的写权限。确认 `gugu-backend.service` 的 `User`、`ls -la Gugu-data/users/` 的属主和 `ReadWritePaths`，修复后重启 backend（详见 §4.5）|


### 10.2 数据库迁移恢复：alembic 与 create_all 不同步（生产实战）

**症状**：生产 `make migrate`（`alembic upgrade head`）**从 base 从头重放**、第一条迁移就炸：
`asyncpg.exceptions.DuplicateColumnError: column "description" of relation "calendar_events" already exists`。

**成因**：生产库的表结构是后端启动时 **`create_all` 按当前模型直接建的**，而 `alembic_version` 表是空的 / 从没 stamp 过 → alembic 以为一条都没迁，从头重放每一条，撞上 `create_all` 早就建好的列。凡是用**非幂等** `op.add_column` 写的老迁移（如 `add_description`），一撞即死。**这跟 DB 里有没有数据无关，数据是好的，纯粹是版本表没记账。**

**恢复（不丢数据，绝不从头重放）**：

1. **先盖章、让 alembic 停止重放**——`stamp` 只写版本号、不动任何表：
   ```bash
   .venv/bin/alembic stamp head        # 认定「库已是最新」，跳过全部重放
   # 想更精细：stamp 到「上次部署那版代码」的 alembic head，再 upgrade head 只补其后的新迁移
   #   git ls-tree -r --name-only <上次部署的commit> -- backend/alembic/versions | sort | tail
   #   取最新那个文件里的 revision = <OLD_HEAD>，再 alembic stamp <OLD_HEAD> && alembic upgrade head
   ```
2. **`stamp head` 会连本次真正该跑的新迁移一起跳过** → 它们加的「新列 / 新表」可能没建，得手动补。本项目新迁移都写成**幂等**（`IF NOT EXISTS`），**直接在生产库跑零风险**（已存在跳过）：
   - **新表**（如 `onboarding_state`）：后端启动 `create_all` 会自动建；或手动 `CREATE TABLE IF NOT EXISTS ...`（从迁移文件抄）。
   - **给已有表加的新列**（⚠️ `create_all` 不补列！只能手动）：`ALTER TABLE 表 ADD COLUMN IF NOT EXISTS 列 ...`，DDL 从对应迁移文件抄。例：本次 `site_notifications` 的 `bubble`/`persist`/`bubble_expire_at`。
   - **删废弃列的迁移**（⚠️ 订正：**不是「非必需」，很多时候必须删**）：新代码从模型里删掉某字段后，INSERT 就不再带它；如果旧库里那列是 **`NOT NULL` 且没有 DB 默认值**（典型:列的默认是 ORM 在 Python 侧给的，删字段后没人给了），新代码每次 INSERT 都会 `NotNullViolationError`、整个建项目/建任务直接崩。**这种废弃列必须删**（就是 `DROP COLUMN IF EXISTS`，新代码本就不用它、数据已弃用）。本次实战:`projects.notes`、`scheduled_tasks.action_type` 没删 → `create_project` 一直 `null value in column "notes" violates not-null constraint`。删了才好。
3. **全量核对（强烈推荐）**：手动补/删难免漏。用 `alembic revision --autogenerate` 把**当前模型 vs 实际库**的所有差异一次性扫出来——**只读库、不改库，只生成一个文件当对照清单**：
   ```bash
   .venv/bin/alembic revision --autogenerate -m schema_audit
   sed -n '/def upgrade/,/^def downgrade/p' alembic/versions/*_schema_audit.py   # 看 upgrade() 里的 op.*
   rm alembic/versions/*_schema_audit.py    # ⚠️ 看完务必删：它是 head 之上的游离迁移，留着会被后续 upgrade 整份应用
   ```
   - `upgrade()` 只有 `pass` → 库已和模型完全一致，收工。
   - 有 `op.add_column`/`op.create_table` → 真要补；`op.drop_column`（NOT NULL 无默认那种）→ 真要删；`op.alter_column`（类型/server_default/索引命名）→ **多为假阳性噪音，逐条看、别整份 apply**。
   - 挑出真要动的，写成幂等 DDL 在库上跑。**这是排查全量 schema 差异的标准手段，比逐个撞错快且全。**
4. 补完启动 + 验证：`systemctl restart gugu-sandboxd gugu-backend gugu-worker gugu-gateway` → `curl 127.0.0.1:8000/health`；若未启用 Shell 沙盒，只重启三个核心服务即可。

**预防（迁移作者）**：删模型字段时，配套的 `DROP COLUMN` 迁移要写成幂等并**确实部署执行**；列的「非空 + 默认」尽量用 DB 级 `server_default`（而非纯 Python 侧 `default=`），这样即使迁移漏跑，旧列也有默认值兜底、不会卡 INSERT。

**预防**：① 迁移一律写**幂等**（`ADD/DROP COLUMN IF [NOT] EXISTS`、`CREATE TABLE IF NOT EXISTS`）——本项目新迁移已遵守，老的 `add_description` 没遵守才会撞；② 生产从第一天就 `alembic stamp`、保持版本表有值，别让 `create_all` 和 alembic 各建各的、`alembic_version` 长期为空。

---

## 附：关键路径


| 路径                             | 内容                                |
| ------------------------------ | --------------------------------- |
| `backend/.venv/`               | Python 虚拟环境                       |
| `.env`                         | Compose 编排配置（gitignore）           |
| `backend/.env`                 | 后端应用配置（gitignore）               |
| `backend/config.override.json` | Admin 写入的配置，含频道/AI 凭据（gitignore）  |
| `backend/logs/gugu.log`        | web 日志                            |
| `Gugu-data/users/`             | 用户文件 + Shell 沙盒 + 咕咕 `.agent/` 记忆（gitignore） |
| `frontend/dist/`               | 前端构建产物（nginx 托管）                  |
