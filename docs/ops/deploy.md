# 咕咕 部署文档（部署教程 + 运维手册）

从零把咕咕跑起来，再到日常运维排错。**全文分两部分**：

- **第一部分 · 部署教程（§1–§5）**：顺着读，从开发环境到生产上线（nginx + systemd + HTTPS + IM）。
- **第二部分 · 运维手册（§6–§10）**：按操作查——重启哪个进程、怎么更新、备份、调优、出问题怎么排。

## 易读概述（不懂运维也能看懂）

咕咕不是一个程序，是**好几个程序配合着跑**：一个负责网页和 API（web），一个负责在飞书/QQ 里聊天时"思考"（worker，咕咕的"大脑"其实在这），一个负责管理各平台的连接（supervisor）。三个都要活着，IM 才能正常收发消息；只用网页版，可以只跑 web。

生产服务器上这三个一般交给 **systemd** 管——相当于给每个程序配一个"看护人"，程序崩了自动拉起来，开机自动启动，不用人盯着。但也有例外：本项目的 dev 机（`192.168.110.51`）**没有用 systemd 管，而是手动用脚本 `scripts/dev-restart.sh` 起停**（web 走脚本手动起，worker/supervisor 也归 systemd 管，具体见 §4.5「dev 机重启」）。这是刻意选择——dev 机上避免 systemd 和手动进程互相打架（同一个端口 8000 不能有两个"主人"）。

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
| 启停 / 重启 backend·worker·supervisor              | §6.2 / §6.3                               |
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

> **大白话**：咕咕 = 一个网页前端 + 三个后端"常驻程序" + 两个基础服务（数据库、消息队列）。前端只是个展示界面；真正干活的是后端那三个进程，各管一摊：web 接网页/API 请求，worker 是"大脑"（想怎么回复），supervisor 是"门卫"（管哪个 IM 平台的连接开着/关着）。只用网页聊天不接 IM 的话，后两个进程和 Redis 都可以不开。

咕咕分前端 + 后端，后端又有 **3 个常驻进程** + **2 个依赖服务**：


| 角色             | 是什么                                | 命令（在 `backend/`，用 `.venv`）                      | 何时需要   |
| -------------- | ---------------------------------- | ----------------------------------------------- | ------ |
| **web**        | FastAPI（API + Admin），uvicorn :8000 | `make start` / `./start.sh start`               | 必须     |
| **worker**     | 消费 IM 队列 → 跑咕咕大脑 → 发回平台            | `.venv/bin/python -m worker`                    | 接 IM 时 |
| **supervisor** | 频道管家：按 Admin 频道面板起停各平台网关子进程        | `.venv/bin/python -m agent.gateway.supervisor` | 接 IM 时 |
| PostgreSQL     | 主数据库                               | 系统服务 / Docker                                   | 必须     |
| Redis          | IM 消息队列（Streams）                   | 系统服务 / Docker                                   | 接 IM 时 |
| SearXNG        | 自建通用搜索（`web_search`，省 Tavily 配额）   | Docker / 1Panel                                 | 可选     |


> 前端：开发用 `npm run dev`（:5173）；生产 `npm run build` 出 `dist/`，由 nginx 托管。
> 不接 IM（飞书/QQ/微信）时，worker / supervisor / Redis 可以不跑。
>
> 💡 **「咕咕的大脑跑在 worker，不在 web」**——记住这条，能省掉一半运维困惑（改大脑代码要重启 worker 而非 backend，详见 §6.1）。

---

## 2. 环境要求


| 依赖              | 版本    | 用途                                                                  |
| --------------- | ----- | ------------------------------------------------------------------- |
| Python          | 3.11+ | 后端                                                                  |
| Node.js         | 18+   | 前端构建                                                                |
| PostgreSQL      | 15+   | 数据库                                                                 |
| Redis           | 7+    | IM 队列（接 IM 才需）                                                      |
| **LibreOffice** | 任意    | 咕咕生成 Word/PDF/Excel（`create_document`）靠 `libreoffice --headless` 转换 |
| **ffmpeg**      | 任意    | IM 语音理解：把 QQ/飞书语音（SILK/opus）转成 mp3 喂 mimo（配合 pip 的 `pilk` 解 SILK）。只装在跑 IM 网关的机器；没装则语音退文字提示 |


系统包（Debian/Ubuntu 示例）：

```bash
sudo apt update
sudo apt install -y python3-venv python3-dev build-essential \
                    postgresql redis-server libreoffice ffmpeg nginx
# Node 用 nvm 或 nodesource 装 18+
```

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

两层：`.env`（基础值）+ Admin 面板写的 `config.override.json`（优先级最高，运行时热合并）。

最小可跑：建 `backend/.env`（嵌套用双下划线 `__`）：

```
# 数据库（也可在 Admin 配）
DB__HOST=localhost
DB__PORT=5432
DB__NAME=gugu_web
DB__USER=pm
DB__PASSWORD=pm123

# JWT 密钥（生产务必改）— 生成随机值：python3 -c "import secrets; print(secrets.token_urlsafe(48))"
SECRET_KEY=换成上面命令生成的随机长串

# 后台管理员账号（不填默认 admin/admin123，生产务必改；改后重启后端生效）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成强密码

# Redis（接 IM 才需要）
REDIS__HOST=localhost
REDIS__PORT=6379

# AI / 存储 / 飞书等：建议启动后在 Admin 面板配（写入 config.override.json）
```

> `.env` 和 `config.override.json` 都已 gitignore，不入库。AI key、飞书凭据等敏感配置**优先用 Admin 面板**填。

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
make fg            # = ./start.sh foreground，带 --reload

# 或后台跑
make start         # 后台 uvicorn :8000，日志 logs/gugu.log
make status        # 状态 + 健康检查
make logs          # 实时日志
```

健康检查：`curl http://127.0.0.1:8000/health` → `{"status":"ok"}`。

### 3.6 前端

```bash
cd frontend
npm install
npm run dev        # Vite :5173，已设 host:true 可局域网访问
```

浏览器开 `http://localhost:5173`。

### 3.7 IM 频道进程（接飞书才需要）

确保 Redis 在跑，然后两个进程（各开一个终端，或后台）：

```bash
cd backend
.venv/bin/python -m agent.gateway.supervisor   # 频道管家
.venv/bin/python -m worker                        # 队列消费 worker
```

频道在 **Admin → Agent 配置 → 频道** 里加（详见 `[22-飞书接入指南.md](../agent/22-飞书接入指南.md)`）。

> ⚠️ 改了 `agent/` 大脑代码后要重启 **worker**（不是 web、也不是 supervisor）——「改了什么、重启哪个」的完整决策表见 **§6.1**。

### 3.8 Admin 初始化

- Admin 后台：`http://localhost:5173/admin/login`
- 默认账号 **admin / admin123**——改用户名/密码在 `.env` 设 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（⚠️ 上线前必改，改后重启后端）
- 登录后在「系统配置 / Agent 配置」里设 DB / Redis / AI provider / 存储 / 频道。

### 3.9 可选：SearXNG 自建搜索（降低 Tavily 成本）

咕咕的 `web_search`（通用搜索）走自建 **SearXNG**，免费、不计配额；`deep_research`（深度总结）才走 Tavily。不部署 SearXNG 也能跑（普通搜索会自动退到 Tavily）。

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

**配置 + 验证**：Admin → Agent → 联网搜索，填「SearXNG 地址」（同机 `http://127.0.0.1:8888`，跨机填 `http://内网IP:8888`）→ 点「测试」。

- 测试返回 **403** = 没开 `formats: json`；**0 结果** = 引擎被限/不可达；**连不上** = 端口没发布到 0.0.0.0 或地址填错。
- **引擎**：国内服务器 google/bing/ddg 多会超时，一般只有 `sogou,quark,360search` 可达——按「测试」结果里列出的「超时引擎」调整「SearXNG 引擎」那栏。
- **安全**：`0.0.0.0` + `limiter: false` = 内网无认证可用；要更严可用防火墙只放行后端那台访问 8888。
- 关掉 SearXNG（清空地址）后，`web_search` 自动全部退到 Tavily。

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
- **存储**：默认本地 `uploads/`；多机/对象存储用 Admin 切到阿里云 OSS。

### 4.3 数据库迁移

```bash
cd backend && make migrate     # alembic upgrade head
```

### 4.4 前端构建 → nginx 托管

```bash
cd frontend
npm install
npm run build                  # 产物在 frontend/dist/
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

    # 主站 SPA
    location / {
        try_files $uri $uri/ /index.html;     # SPA 路由回退
    }

    # 后端 API（主站 + 后台共用这一套反代）
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
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
- 私有仓库 clone：服务器生成 SSH key → GitHub 仓库 Settings → Deploy keys 加只读公钥 → `git clone git@github.com:...`（国内服务器连不上 GitHub 时走代理 / 镜像）。

### 4.5 后端服务（systemd · 一次装全 3 个）

> **大白话**：生产服务器上，咕咕的三个后端进程交给 systemd（Linux 自带的服务管理器）托管——进程崩了它自动拉起来、服务器重启它自动跟着启动，不用人守着敲命令。前提是**一次性**先跑 `make install` 把三个进程"注册"给 systemd（相当于登记造册），之后才能用 `systemctl restart/stop/status` 这类命令管它们。**这一步千万别漏**，漏了会导致用错身份跑服务、后续权限报错（见下）。
>
> **本项目部署现状**：生产环境（如 gugugu.site）和 dev 机（`192.168.110.51`）三个服务**都走 systemd**（2026-07-07 起统一，此前 dev 机曾用 `scripts/dev-restart.sh` 手动起停 web，现已弃用该例外，全环境一致方便排查）。两种方式**不能同时用在同一台机器的同一个端口上**，选一个当唯一主人（详见下文「铁律」）；`scripts/dev-restart.sh` 仍保留在仓库供以后需要免 sudo 快速迭代的场景参考，但目前没有环境在用它。
>
> ⚠️ **首次上线必须跑 `make install`，绝不能跳过直接 `make restart`。**
>
> `make install` 是一次性动作（把 service 注册到 systemd、设好 `User=www-data`、建好目录权限）。**跳过它**、直接用 `make restart` 或 `./start.sh start` 起 uvicorn：你是 root SSH 进去的，uvicorn 就以 **root** 身份跑，uploads/ 下创建或修改的文件 / 目录会变成 root:root —— 下次改成 www-data 运行后，这些 root 目录 **写不进去** (`[Errno 13] Permission denied`)，咕咕移动文件、写临时文件都会报错。
>
> **判断是否漏跑过 install**：
> ```bash
> ps aux | grep uvicorn   # 看 USER 列：www-data = 正常，root = 漏了
> ls -la uploads/         # 子目录 owner 应全为 www-data，有 root 的说明 uvicorn 曾以 root 跑过
> ```
> **修复**（已有 root 目录时）：
> ```bash
> chown -R www-data:www-data /opt/1panel/www/sites/www.gugugu.site/Gugu-web-main/backend/uploads/
> # 然后补跑 make install，或确认 gugu-backend.service 里有 User=www-data 再 systemctl restart gugu-backend
> ```

项目自带三个单元模板（`gugu-backend.service` / `gugu-worker.service` / `gugu-supervisor.service`，均用 `__APP_DIR__`/`__RUN_USER__` 占位符）。一条命令全装：

```bash
cd backend && RUN_USER=youruser make install
sudo systemctl status gugu-backend gugu-worker gugu-supervisor
```

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
> bash scripts/dev-restart.sh          # 全部：web + worker + supervisor
> bash scripts/dev-restart.sh web      # 也可只重启某一个
> ```
> ⚠️ 若某台机器要切到这条路，先 `sudo systemctl disable --now gugu-backend` 再用脚本，避免两边抢 8000。

`make install` 会：

- 按**当前 backend 目录**(`APP_DIR`)填好三个单元的 `WorkingDirectory`/`ExecStart`/`ReadWritePaths`（占位符，不写死路径——换部署目录不用手改）；
- 建出 `uploads/`、`logs/`、`config.override.json` 并 `chown` 给运行用户（`ReadWritePaths` 要求路径**真实存在**，否则 systemd 报 `226/NAMESPACE`）；
- `daemon-reload` + `enable` + `restart` 全部三个。
- 运行用户默认 `www-data`，可覆盖：`RUN_USER=youruser make install`（须已存在、能读 `.venv` 与项目目录；**项目在 `/home/<user>` 下时必须用该 user**，www-data 进不去家目录）。卸载：`make uninstall`（一并清三个）。

三个常驻服务：


| 服务                | 进程                  | Restart                               | 日志                         |
| ----------------- | ------------------- | ------------------------------------- | -------------------------- |
| `gugu-backend`    | uvicorn 网页          | on-failure                            | `logs/gugu.log`            |
| `gugu-worker`     | IM 大脑（消费队列、跑 agent） | **always**                            | `logs/gugu-worker.log`     |
| `gugu-supervisor` | IM 网关管家（拉飞书/QQ 子进程） | **always** + `KillMode=control-group` | `logs/gugu-supervisor.log` |


- **worker/supervisor 用 `Restart=always`**：IM 进程死了必须秒拉起，否则消息无限排队（网页死了有 web 兜，IM 没人管就一直收不到）。这是早期漏配、IM 偶发「很慢/收不到」的根因。
- 三个单元的 `StandardOutput` 都 **append 到 `logs/gugu*.log`**（不走 journald）——后台「Debug 实时日志」面板正是 tail 这三个文件；`journalctl -u gugu-worker` 仍能看进程启停。建议给 `logs/` 配 logrotate，免得 append 文件无限涨。

> 1Panel 部署：backend 一般在 `/opt/1panel/www/sites/<域名>/backend`，直接在该目录 `make install`，路径自动对上。

> ⚠️ **ProtectSystem=strict 沙箱 + LibreOffice**（2026-07-07 实测踩过、已修）：单元开了 `ProtectSystem=strict`，`$HOME/.config` 对进程只读，LibreOffice 转 Office（docx/xlsx/pptx 预览、`read_file` 读 Office）默认要在那建用户 profile，建不了直接 `returncode=1` 失败（PDF 走 pdftotext 不受影响，stderr 只留一条不相关的 `javaldx` 警告，真实原因不会自己冒出来）。**已在代码里修好，不用改 systemd 配置**：`app/api/v1/files.py` 的 `_office_to_pdf` 和 `app/core/doctext.py` 的 `_lo_convert` 调 LibreOffice 时都带了 `-env:UserInstallation=file://<本次临时目录>/loprofile`，把 profile 指到 `PrivateTmp=true` 保证可写的临时目录，不用放宽 `ProtectSystem=strict`、也不用碰 HOME。

> worker 想扩吞吐可起多个实例（共享 Redis 消费组自动负载均衡）；supervisor 一台机一个即可。多机拆分见 §5.2。

### 4.6 Admin 安全

- **改默认管理员账号**（默认 `admin / admin123`）——在 `backend/.env` 设：
  ```
  ADMIN_USERNAME=你的新用户名      # 不填默认 admin
  ADMIN_PASSWORD=你的新密码        # 不填默认 admin123
  ```
  > 管理员账号是**配置驱动**的（不存数据库）：登录时按 `.env` 里的 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 校验。改完**重启后端**（`systemctl restart gugu-backend`）生效，用新用户名+新密码登录 `/admin/login`。
- `SECRET_KEY` 用强随机值（`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`）。
- CORS：`main.py` 默认只开 localhost:5173，生产改成实际域名。

---

## 5. 接入 IM 频道（飞书 / QQ / 微信）

> **大白话**：咕咕除了网页版，还能接到飞书、QQ、微信里当机器人用。接入靠 supervisor（门卫）+ worker（大脑）两个进程配合：supervisor 负责按 Admin 后台的开关去连/断某个平台，worker 负责真正处理消息、想回复内容。不接 IM 就不需要看这一节。

### 5.1 接入步骤

飞书 bot 创建、权限、长连接事件订阅、凭据填写、频道面板原理，**完整步骤见 `[22-飞书接入指南.md](../agent/22-飞书接入指南.md)`**。QQ / 微信（个人微信 iLink）走 Admin 面板扫码自连。

生产前提：确保 `gugu-supervisor` + `gugu-worker` 两个服务在跑（§4.5），频道在 Admin 面板增删启停**即时生效**（日常增删启停、重启管家见 §6.4 / §6.3）。

网关 = `supervisor` 按 Admin「频道」面板里**启用的 bot** 动态 `spawn` 的子进程（每个 bot 一条 WS 长连，飞书 `lark.ws` / QQ `botpy`），凭据由 supervisor 以**环境变量注入**子进程（不进 argv，`ps` 看不到）。

### 5.2 多机部署：把网关 / worker 拆到独立服务器（可选，非默认）

> **默认单机部署**（web + worker + supervisor + 网关同机）——一套配置管全部、Admin 配置/重启全生效、扩量靠单机内手段就够（见 `[并发优化ROADMAP.md](并发优化ROADMAP.md)` 部署形态决策）。**以下拆机为可选路径**，仅当确有多机需求时用。

> 网关/worker 和后台**不直接通信**，只在 **Redis + DB** 这条共享总线上碰头。所以拆机要配的就这两个 IP——**没有「web 的 IP」要填**。

那台新机的 `backend/.env`：

```bash
REDIS__HOST=<共享 Redis IP>      REDIS__PASSWORD=...
DB__HOST=<共享 DB IP>            DB__PASSWORD=...
```

起 worker + supervisor（这台不必跑 web）：

```bash
./start.sh install                         # 装 systemd 三单元
sudo systemctl disable --now gugu-backend   # 只做网关/worker，不跑网页
# 或手动：.venv/bin/python -m worker  &  .venv/bin/python -m agent.gateway.supervisor
```

起来即**自动接入**：worker 加入共享 Redis 消费组 `agent-workers` 分摊队列；supervisor 读共享 DB 的 `user_bots` 拉网关。后台（在另一台）零改动，**「服务状态」页直接显示这台机**（host = 它的 hostname）。

**三条铁律：**

1. **全网只能一个 supervisor** —— 两个会给每个 bot 各拉一条 WS → 同 bot 双连接、平台冲突。网关机只此一台跑 supervisor，其余机器只跑 worker。
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

**咕咕的「大脑」跑在 worker，不在 web。** 改了什么、重启谁，对照下表（命令为生产 systemd；开发环境的启停见 §6.2 / §6.3）：


| 你改了…                                                              | 要重启                                    | 命令（生产）                            |
| ----------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| API / Admin 接口、`app/`、`main.py`、路由、新接口                            | **backend (web)**                      | `systemctl restart gugu-backend`  |
| 咕咕大脑：`agent/` 下 runner / core / skills / tools / 上下文 / 记忆 / prompts | **worker**                             | `systemctl restart gugu-worker`   |
| IM 网关代码：`agent/gateway/`（feishu / qq / wechat）、`router.py`        | **supervisor**（连带重起所有网关子进程）            | `systemctl restart gugu-supervisor` |
| 前端 `frontend/`                                                    | 重新构建（不必重启服务）                           | `cd frontend && npm run build`    |
| 配置 `.env`（含 `SECRET_KEY` / 管理员账号）                                 | **backend**                            | `systemctl restart gugu-backend`  |
| **新增了模型字段 / 数据库列**                                                | **不是重启，是迁移！**                          | `make migrate`（见 §7）              |
| 启用 / 停用 / 增删某个 IM bot                                             | 都不用重启                                  | Admin 面板即时生效（见 §6.4）             |


⚠️ **三个最常见的错**：

- **只重启了 web、漏了 worker**：改了大脑代码却只 `make restart` / `systemctl restart gugu-backend`，结果「网页/IM 行为没按新代码变」（实时事件不发、新字段不写）——因为大脑在 worker。见 `../devlog.md` 2026-06-23「漏重启 worker」。
- **以为 `make restart` 管全部**：它**只重启 web（uvicorn）**，不动 worker/supervisor。IM 相关改动要单独重启对应进程。
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

### 6.3 启停 / 重启 worker / supervisor

```bash
# 生产（systemd）
sudo systemctl restart gugu-worker       # 改了 agent/ 大脑代码后
sudo systemctl restart gugu-supervisor   # 改了 adapters(feishu/qq/wechat)/router 后；KillMode=control-group 连带重起全部网关子进程
sudo systemctl stop gugu-supervisor      # 停掉所有网关（连带子进程）
journalctl -u gugu-supervisor -f         # 或 tail logs/gugu-supervisor.log

# 开发（无 systemd）
.venv/bin/python -m worker                       # 前台 worker
.venv/bin/python -m agent.gateway.supervisor   # 前台 supervisor；Ctrl+C 停、连带杀子进程
```

也可在 **Admin → 服务状态** 页点「重启」（仅同主机有效，靠 kill + systemd 自愈）。

> ⚠️ `**systemctl stop gugu-supervisor` 报 `Unit not loaded`**：说明这台机的 worker/supervisor 是**手动 `python -m ...` 起的、没装成 systemd**，systemctl 自然不认。两条路：
>
> ```bash
> # A. 手动停（按进程，supervisor 收 TERM 会连带杀网关子进程）
> ps aux | grep -E "agent\.adapters\.supervisor|python -m worker" | grep -v grep   # 先看 pid
> pkill -TERM -f "agent.gateway.supervisor"
> pkill -TERM -f "python -m worker"
> # B. 装成 systemd（推荐，之后 systemctl 可用 + 崩溃自拉 + 开机自启）
> cd backend && RUN_USER=youruser make install
> ```
>
> 手动起的进程：`systemctl` 管不了、服务页「重启」也指望不上、重启机器/崩溃不自拉——所以生产建议一律 `make install` 走 systemd。

### 6.4 增删 / 启停单个 IM 网关（不用重启服务）

- **增 / 删 / 开 / 关某个 bot**：在 **Admin → Agent 配置 → 频道** 里操作（或扫码自连）→ 写 `user_bots` 表 → supervisor **每 ~1s 对账自动 spawn/kill** → **无需重启任何服务，秒级生效**。
- 凭据由 supervisor 以**环境变量注入**子进程（不进 argv，`ps` 看不到）。
- 要重启整个网关管家（改了 adapters 代码时）见 §6.3。

### 6.5 看状态 / 日志

```bash
cd backend
make status              # web 状态 + 健康检查
make logs                # web 实时日志
sudo systemctl status gugu-worker gugu-supervisor    # IM 进程
sudo journalctl -u gugu-supervisor -f                # 看频道起停日志
```

---

## 7. 更新线上代码

> **大白话**：本项目不强制用 git 部署，更新代码的方式很朴素——把改好的文件传上服务器（scp/rsync/zip 都行），然后跑几条命令让新代码生效：装可能新增的依赖包、跑数据库迁移（如果改了数据库表结构）、重启对应的进程。**最容易漏的一步是数据库迁移**——只传代码不迁移，新加的字段在数据库里根本不存在，一写入就报错。

```bash
# scp/rsync 传新代码后：
cd backend
make update              # = deps + migrate（装依赖 + 跑迁移）
sudo systemctl restart gugu-backend   # 重启 web（生产走 systemd，别用 make restart，见 §6.2）
sudo systemctl restart gugu-worker gugu-supervisor   # 重启 IM（若改了 agent 代码，见 §6.1）
cd ../frontend && npm install && npm run build        # 前端重新构建
# 或一键：make deploy（备份 + 依赖 + 迁移 + 前端 build + 重启）
```

> ⚠️ **务必 `make migrate`，别只 restart**：启动时的 `create_all` **只建缺失的表、不会给已有表加新列**。所以凡是新增了模型列（如 `conversation_messages.files` 文件卡片、`conversation_sessions.source` 会话来源、`conversation_sessions.summary` 会话总结），只重启不跑迁移 → 相关写入会因「列不存在」报错。`make update` / `make deploy` 已含 migrate；手动更新记得补 `make migrate`。
>
> 🔥 **scp / rsync 单传文件最易踩**（devserver 实战）：单传了带新列的模型代码、却忘了 `make migrate` → **每次对话一查 `conversation_sessions` 就崩，连带反思 / 感知遥测全不跑**。排查时表面像「某功能没数据」，根因其实在这。**传了模型改动 = 立刻补 `make migrate` + 重启。**

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
| `uploads/` | **抹掉所有用户文件 + 咕咕 `.agent/` 记忆** |

本地打包（排除上述 + 缓存）：
```bash
cd <项目根>
zip -r backend.zip backend \
  -x 'backend/.venv/*' -x 'backend/.env' -x 'backend/config.override.json' \
  -x 'backend/logs/*' -x 'backend/uploads/*' -x '*/__pycache__/*' -x '*.pyc'
```
服务器解压 + 收尾：
```bash
cd <项目目录> && unzip -o backend.zip       # -o 覆盖代码；.env/.venv 没打进 zip 故不受影响
cd backend
.venv/bin/pip install -r requirements.txt   # requirements 变了才需要
make migrate                                 # 有新模型列时（见上 ⚠️）
systemctl restart gugu-backend               # 改了 web/后端
systemctl restart gugu-worker                # 改了 agent/ 大脑代码
```

> **更稳的做法**：生产配一次 git deploy key（见 §4.4.1），以后更新就 `git pull` + 重启——git 只动跟踪文件，`.env`/`.venv`/`uploads` 都 gitignore、永不被碰，天然无「覆盖状态」风险，省去每次手动排除。
>
> ⚠️ 但 `git reset --hard` / `git clean -fdx` / 重新解压 zip **会**冲掉这些 gitignore 的状态文件（`.venv` 被删 → 服务 `203/EXEC`；`.env`/`config.override.json` 被删 → DB 密码丢、`password authentication failed for user "pm"`）。**任何代码刷新后，启动/迁移前先确认三样都在**：`.venv` 能跑（`.venv/bin/python -V`）、`.env` + `config.override.json` 里 DB 密码正确。缺了先补（重建 venv 见 §3.2，恢复 DB 密码见 §3.3/§3.4），再 migrate / 启动。
>
> ⚠️ **重建 `.env` 时务必沿用原来的 `SECRET_KEY`,别重新生成。** `SECRET_KEY` 一变,**所有已签发的登录 token 立刻失效** → 部署后用户访问任何需登录的接口都 `401`，前端表现为「数据页全部加载失败 / summary 401」。这不是数据/权限 bug，**重新登录即恢复**（旧 token 用旧 key 签的，新 key 验不过）。根治:`SECRET_KEY` 当成长期不变的密钥存在 `.env` 里，跨部署保持同一个值；每次部署重新随机生成 = 每次把全员登出。有旧值备份就填回旧值，连用户重登都省了。

---

## 8. 备份

> **大白话**：一条命令把「数据库 + 用户上传的文件 + Admin 后台配置」打包备份好。这三样丢了就真的丢了（没有云端自动备份），建议定期跑或配 crontab 定时跑。

```bash
cd backend && make backup     # 备份数据库 + uploads + config.override.json
```

> `uploads/` 含用户文件 + 咕咕 `.agent/` 记忆；`config.override.json` 含所有 Admin 配置（含明文凭据）。两者都要备。

---

## 9. 低配服务器调优（2C/2G 这类）

> **大白话**：便宜的云服务器常见配置是 2 核 CPU + 2G 内存。咕咕同时要跑好几个 Python 进程 + 数据库 + Redis，这点内存**跑得起来但很紧张**，稍微多几个人同时用就可能被系统"内存不够杀进程"（OOM）强制干掉，表现为服务莫名其妙掉线。下面几条是从紧到松的调优手段：加交换空间兜底、别在这台机上开耗资源的管理工具、把咕咕自己的进程数调小。都是配置层面的调整，不用改代码。

咕咕 = Python web + worker + supervisor + 网关 + PostgreSQL + Redis，2C/2G 上跑得起来但**很紧**，容易 OOM / CPU 打满。按这套调：

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
- 不用 IM 就在后台**停用 bot**，supervisor 不拉网关子进程，每个省 ~60–80M。

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
| IM 收不到/回不出                             | Redis 没起；或 supervisor/worker 没跑；详见 飞书接入指南排错表        |
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
| `password authentication failed for user "pm"` | DB 配置被部署冲掉、密码退回占位值。把 `.env`/`config.override.json` 里的 DB 密码恢复成生产真实值（1Panel→数据库 可看/重置），与 Postgres 里 `pm` 用户密码一致（详见 §7 ⚠️ / §3.4） |
| `alembic upgrade head` 报 `DuplicateColumnError`（从 base 重放撞已有列） | 生产库由 `create_all` 建、`alembic_version` 空 → 重放撞车。`alembic stamp head` 认账停止重放，再手动补本次新迁移的幂等 DDL（新表靠 `create_all`，新列手动 `ADD COLUMN IF NOT EXISTS`）。详见 §10.2 |
| 建项目/任务报 `null value in column "xxx" violates not-null constraint`（如 `notes`） | 新代码删了该字段、INSERT 不再带它，但旧库那列还是 `NOT NULL` 无默认 → 必须把废弃列删掉：`ALTER TABLE 表 DROP COLUMN IF EXISTS 列`。用 `alembic revision --autogenerate` 全量核对漏补/漏删（详见 §10.2） |
| `make stop` 说「未运行」但 `systemctl` 显示服务在跑 | 生产 backend 由 systemd `gugu-backend.service` 托管，`make start/stop` 管的是另起的手动 uvicorn → 两者不是一个进程。生产一律用 `systemctl`（详见 §6.2） |
| 部署后数据页全部「加载失败 / summary 401」 | 重建 `.env` 时 `SECRET_KEY` 变了 → 旧登录 token 全失效。**重新登录即恢复**；根治:`SECRET_KEY` 跨部署保持同一值，别每次重新生成（详见 §7 ⚠️ / §4.2） |
| 咕咕移动文件报 `[Errno 13] Permission denied: '.../uploads/.../个人文件'` | 首次部署漏跑了 `make install`，uvicorn 以 root 跑过一段时间 → uploads/ 下部分目录 owner 是 root，后续改 www-data 运行后写不进去。`ps aux | grep uvicorn` 看 USER 列；`ls -la uploads/` 看子目录 owner。修复：`chown -R www-data:www-data uploads/` + 确认 `gugu-backend.service` 有 `User=www-data` → `systemctl restart gugu-backend`（详见 §4.5）|


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
4. 补完启动 + 验证：`systemctl restart gugu-backend gugu-worker gugu-supervisor` → `curl 127.0.0.1:8000/health`。

**预防（迁移作者）**：删模型字段时，配套的 `DROP COLUMN` 迁移要写成幂等并**确实部署执行**；列的「非空 + 默认」尽量用 DB 级 `server_default`（而非纯 Python 侧 `default=`），这样即使迁移漏跑，旧列也有默认值兜底、不会卡 INSERT。

**预防**：① 迁移一律写**幂等**（`ADD/DROP COLUMN IF [NOT] EXISTS`、`CREATE TABLE IF NOT EXISTS`）——本项目新迁移已遵守，老的 `add_description` 没遵守才会撞；② 生产从第一天就 `alembic stamp`、保持版本表有值，别让 `create_all` 和 alembic 各建各的、`alembic_version` 长期为空。

---

## 附：关键路径


| 路径                             | 内容                                |
| ------------------------------ | --------------------------------- |
| `backend/.venv/`               | Python 虚拟环境                       |
| `backend/.env`                 | 基础配置（gitignore）                   |
| `backend/config.override.json` | Admin 写入的配置，含频道/AI 凭据（gitignore）  |
| `backend/logs/gugu.log`        | web 日志                            |
| `uploads/`                     | 用户文件 + 咕咕 `.agent/` 记忆（gitignore） |
| `frontend/dist/`               | 前端构建产物（nginx 托管）                  |
