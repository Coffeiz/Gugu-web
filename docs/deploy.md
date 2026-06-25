# 咕咕 部署文档（开发 + 生产完整教程）

从零把咕咕跑起来：开发环境一步步起服务，生产环境上 nginx + systemd。含 venv、数据库、AI、IM 频道（飞书）的完整配置。

---

## 0. 架构总览：要跑哪些进程

咕咕分前端 + 后端，后端又有 **3 个常驻进程** + **2 个依赖服务**：


| 角色             | 是什么                                | 命令（在 `backend/`，用 `.venv`）                      | 何时需要   |
| -------------- | ---------------------------------- | ----------------------------------------------- | ------ |
| **web**        | FastAPI（API + Admin），uvicorn :8000 | `make start` / `./start.sh start`               | 必须     |
| **worker**     | 消费 IM 队列 → 跑咕咕大脑 → 发回平台            | `.venv/bin/python -m worker`                    | 接 IM 时 |
| **supervisor** | 频道管家：按 Admin 频道面板起停各平台网关子进程        | `.venv/bin/python -m agent.adapters.supervisor` | 接 IM 时 |
| PostgreSQL     | 主数据库                               | 系统服务 / Docker                                   | 必须     |
| Redis          | IM 消息队列（Streams）                   | 系统服务 / Docker                                   | 接 IM 时 |


> 前端：开发用 `npm run dev`（:5173）；生产 `npm run build` 出 `dist/`，由 nginx 托管。
> 不接 IM（飞书/QQ/微信）时，worker / supervisor / Redis 可以不跑。

---

## 1. 环境要求


| 依赖              | 版本    | 用途                                                                  |
| --------------- | ----- | ------------------------------------------------------------------- |
| Python          | 3.11+ | 后端                                                                  |
| Node.js         | 18+   | 前端构建                                                                |
| PostgreSQL      | 15+   | 数据库                                                                 |
| Redis           | 7+    | IM 队列（接 IM 才需）                                                      |
| **LibreOffice** | 任意    | 咕咕生成 Word/PDF/Excel（`create_document`）靠 `libreoffice --headless` 转换 |


系统包（Debian/Ubuntu 示例）：

```bash
sudo apt update
sudo apt install -y python3-venv python3-dev build-essential \
                    postgresql redis-server libreoffice nginx
# Node 用 nvm 或 nodesource 装 18+
```

---

## 2. 开发环境部署

### 2.1 拿代码

本项目部署**不依赖 git**，`scp`/`rsync` 传整个目录即可。开发就是本地目录。

### 2.2 后端：venv + 依赖

```bash
cd backend
python3 -m venv .venv                 # 建虚拟环境（脚本/Makefile 默认找 .venv）
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt
```

> 全程用 `.venv/bin/xxx` 绝对路径，**不用 `activate`**，避开 PEP 668 / 系统包污染。`make deps` 等价于上面最后一步。

### 2.3 配置

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

### 2.4 数据库

建库 + 用户（与上面 `.env` 对应）：

```bash
sudo -u postgres psql -c "CREATE USER pm WITH PASSWORD 'pm123';"
sudo -u postgres psql -c "CREATE DATABASE gugu_web OWNER pm;"
```

表结构：后端启动时自动 `create_all` 建表 + 跑内置 schema 迁移；也可手动 `make migrate`（`alembic upgrade head`）。

### 2.5 启动后端

```bash
# 开发用前台 + 热重载（改代码自动重启）
make fg            # = ./start.sh foreground，带 --reload

# 或后台跑
make start         # 后台 uvicorn :8000，日志 logs/gugu.log
make status        # 状态 + 健康检查
make logs          # 实时日志
```

健康检查：`curl http://127.0.0.1:8000/health` → `{"status":"ok"}`。

### 2.6 前端

```bash
cd frontend
npm install
npm run dev        # Vite :5173，已设 host:true 可局域网访问
```

浏览器开 `http://localhost:5173`。

### 2.7 IM 频道进程（接飞书才需要）

确保 Redis 在跑，然后两个进程（各开一个终端，或后台）：

```bash
cd backend
.venv/bin/python -m agent.adapters.supervisor   # 频道管家
.venv/bin/python -m worker                        # 队列消费 worker
```

频道在 **Admin → Agent 配置 → 频道** 里加（详见 `[feishu接入指南.md](feishu接入指南.md)`）。

> ⚠️ **改了 `agent/` 大脑代码（runner / skills / core / 上下文 / 记忆等）后，worker 必须重启**——咕咕的大脑跑在 **worker** 进程里，不是 web（uvicorn）、也不是 supervisor。
>
> - `supervisor` + 各平台网关（qq/feishu）只负责**收消息入队**；改它们（adapters）才需重启 supervisor。
> - `make restart` 只重启 web（uvicorn），**不动 worker/supervisor**。
> - 只重启 supervisor 而漏了 worker，会出现「网页/IM 行为没按新代码变」的诡异现象（如实时事件不发、新字段不写）——见 `devlog.md` 2026-06-23「漏重启 worker」。

### 2.8 Admin 初始化

- Admin 后台：`http://localhost:5173/admin/login`
- 默认账号 **admin / admin123**——改用户名/密码在 `.env` 设 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（⚠️ 上线前必改，改后重启后端）
- 登录后在「系统配置 / Agent 配置」里设 DB / Redis / AI provider / 存储 / 频道。

---

## 3. 生产环境部署

生产 = 前端静态托管 + 后端常驻服务 + nginx 反代 + HTTPS。

### 3.1 系统依赖 + venv + 依赖

同 §1、§2.2（装系统包、建 `.venv`、`make deps`）。

### 3.2 配置（生产）

- `backend/.env`：填 DB / Redis / `SECRET_KEY` / 管理员账号（见 §2.3）。`SECRET_KEY` **务必换随机值**：
  ```bash
  python3 -c "import secrets; print(secrets.token_urlsafe(48))"
  ```
  > JWT（登录 Token）就是用 `SECRET_KEY` 签名的，**线上用默认值 = 任何人能伪造管理员/用户 Token**，必须换。改 `SECRET_KEY` 后所有已签发的 Token 失效（需重新登录），重启后端生效。
- 其余（AI key、OSS、飞书凭据）登录 Admin 面板配，落到 `config.override.json`。
- **存储**：默认本地 `uploads/`；多机/对象存储用 Admin 切到阿里云 OSS。

### 3.3 数据库迁移

```bash
cd backend && make migrate     # alembic upgrade head
```

### 3.4 前端构建 → nginx 托管

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

    # 后台 SPA：深链/刷新回退到 admin 自己的 index.html（必须在 location / 之前/之外单列）
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

#### 3.4.1 1Panel 面板部署（对应上面 nginx，拆成面板几处填）

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
- **伪静态**（网站 → 配置 → 伪静态）：SPA 路由回退（主站 + 后台两个独立入口）
  ```nginx
  location /admin { try_files $uri $uri/ /admin/index.html; }
  location /      { try_files $uri $uri/ /index.html; }
  ```

**踩过的坑（按出现频率）：**

- `**nginx: [emerg] duplicate location "/"` 启动失败**：反向代理路径填成了 `/`（把整站都代理给后端）→ 和伪静态的 `location /` 撞车。**反代路径必须是 `/api`**——前端静态归 nginx，只有 `/api` 走后端。
- `**[Errno 98] address already in use`（8000 被占）**：多半上一次前台 uvicorn 没停。`ss -ltnp | grep :8000` 看谁占，`pkill -f "uvicorn app.main"` 杀掉；或换端口（记得同步改反代目标）。注意：能看到 `Application startup complete` 再报 bind 失败，说明**后端/DB 没问题，纯粹端口冲突**。
- 私有仓库 clone：服务器生成 SSH key → GitHub 仓库 Settings → Deploy keys 加只读公钥 → `git clone git@github.com:...`（国内服务器连不上 GitHub 时走代理 / 镜像）。

### 3.5 后端服务（systemd · 一次装全 3 个）

项目自带三个单元模板（`gugu-backend.service` / `gugu-worker.service` / `gugu-supervisor.service`，均用 `__APP_DIR__`/`__RUN_USER__` 占位符）。一条命令全装：

```bash
cd backend && RUN_USER=youruser make install
sudo systemctl status gugu-backend gugu-worker gugu-supervisor
```

> ⚠️ **装完 `gugu-backend` 一直重启（`activating → failed → activating` 循环）？最常见是端口被旧进程占着。**
> 装 systemd 之前你多半手动前台跑过 `uvicorn ...:8000` 测试，那个**没停**——systemd 的 gugu-backend 起来绑不上 8000 → 崩 → `Restart` 拉起 → 死循环。
> 先停服务再清野进程，最后让 systemd 干净启动：
> ```bash
> systemctl stop gugu-backend
> pkill -9 -f "uvicorn app.main"        # 杀手动跑的旧后端
> fuser -k 8000/tcp 2>/dev/null         # 兜底
> ss -ltnp | grep :8000 || echo 空了
> systemctl start gugu-backend
> journalctl -u gugu-backend -n 30 --no-pager   # 还崩就看这里：端口/配置/路径/缺依赖
> ```
> 注意：托管后**别再用 `pkill` 停 gugu-backend**（会被 `Restart` 立刻拉起、像「关不掉」），用 `systemctl stop`。

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

> ⚠️ **ProtectSystem=strict 沙箱 + LibreOffice**：单元开了 `ProtectSystem=strict`，LibreOffice 转 Office（docx/xlsx/pptx 预览、`read_file` 读 Office）可能写不了配置目录而失败（PDF 走 pdftotext 不受影响）。真遇到：给对应单元加可写 HOME（`Environment=HOME=__APP_DIR__/logs` + 相应 `ReadWritePaths`）或去掉 `ProtectSystem=strict`。

> worker 想扩吞吐可起多个实例（共享 Redis 消费组自动负载均衡）；supervisor 一台机一个即可。

### 3.7 Admin 安全

- **改默认管理员账号**（默认 `admin / admin123`）——在 `backend/.env` 设：
  ```
  ADMIN_USERNAME=你的新用户名      # 不填默认 admin
  ADMIN_PASSWORD=你的新密码        # 不填默认 admin123
  ```
  > 管理员账号是**配置驱动**的（不存数据库）：登录时按 `.env` 里的 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 校验。改完**重启后端**（`systemctl restart gugu-backend`）生效，用新用户名+新密码登录 `/admin/login`。
- `SECRET_KEY` 用强随机值（`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`）。
- CORS：`main.py` 默认只开 localhost:5173，生产改成实际域名。

### 3.8 低配服务器调优（2C/2G 这类）

咕咕 = Python web + worker + supervisor + 网关 + PostgreSQL + Redis，2C/2G 上跑得起来但**很紧**，容易 OOM / CPU 打满。按这套调：

**① 加 swap（2G 内存必配，防 OOM 杀进程）**
```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab     # 开机自动挂
free -h                                              # 确认 Swap 行有值
```
> swap 不替代内存，但内存峰值有它兜底，不至于直接被 OOM killer 杀掉（咕咕 backend 被 `code=killed status=9` 多半就是 OOM）。

**② 别在这台机跑非必要的重应用**：pgAdmin、其它面板应用等很吃 CPU/内存（pgAdmin 曾崩溃重启循环把 CPU 烧到 100% 整机卡死）。看库用 1Panel 自带的数据库管理或本地客户端远程连，**别在生产机常驻 pgAdmin**。

**③ 降咕咕自身占用**：
- web 单进程：uvicorn **别加 `--workers N`**；
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

## 4. IM 频道（飞书）

飞书 bot 创建、权限、长连接事件订阅、凭据填写、频道面板原理，**完整步骤见 `[feishu接入指南.md](feishu接入指南.md)`**。生产上确保 `gugu-supervisor` + `gugu-worker` 两个服务在跑，频道在 Admin 面板增删启停即时生效。

### 4.1 增删 / 启停单个网关（不用重启服务）

网关 = `supervisor` 按 Admin「频道」面板里**启用的 bot** 动态 `spawn` 的子进程（每个 bot 一条 WS 长连，飞书 `lark.ws` / QQ `botpy`）。

- **增 / 删 / 开 / 关某个 bot**：在 **Admin → Agent 配置 → 频道** 里操作（或扫码自连）→ 写 `user_bots` 表 → supervisor **每 ~1s 对账自动 spawn/kill** → **无需重启任何服务，秒级生效**。
- 凭据由 supervisor 以**环境变量注入**子进程（不进 argv，`ps` 看不到）。

### 4.2 启停 / 重启网关管家（supervisor）

```bash
# 生产（systemd）
sudo systemctl restart gugu-supervisor   # 改了 adapters(feishu/qq)/router 后；KillMode=control-group 连带重起全部网关子进程
sudo systemctl stop gugu-supervisor      # 停掉所有网关（连带子进程）
journalctl -u gugu-supervisor -f         # 或 tail logs/gugu-supervisor.log

# 开发（无 systemd）
.venv/bin/python -m agent.adapters.supervisor   # 前台；Ctrl+C 停、连带杀子进程
```

也可在 **Admin → 服务状态** 页点「重启」（仅同主机有效，靠 kill + systemd 自愈）。

> ⚠️ `**systemctl stop gugu-supervisor` 报 `Unit not loaded`**：说明这台机的 worker/supervisor 是**手动 `python -m ...` 起的、没装成 systemd**，systemctl 自然不认。两条路：
>
> ```bash
> # A. 手动停（按进程，supervisor 收 TERM 会连带杀网关子进程）
> ps aux | grep -E "agent\.adapters\.supervisor|python -m worker" | grep -v grep   # 先看 pid
> pkill -TERM -f "agent.adapters.supervisor"
> pkill -TERM -f "python -m worker"
> # B. 装成 systemd（推荐，之后 systemctl 可用 + 崩溃自拉 + 开机自启）
> cd backend && RUN_USER=youruser make install
> ```
>
> 手动起的进程：`systemctl` 管不了、服务页「重启」也指望不上、重启机器/崩溃不自拉——所以生产建议一律 `make install` 走 systemd。

### 4.3 把网关 / worker 拆到独立服务器（可选，非默认）

> **默认单机部署**（web + worker + supervisor + 网关同机）——一套配置管全部、Admin 配置/重启全生效、扩量靠单机内手段就够（见 `[并发优化ROADMAP.md](并发优化ROADMAP.md)` 部署形态决策）。**以下拆机为可选路径**，仅当确有多机需求时用；跨主机的 Admin 配置/重启不生效（§4.4）。

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
# 或手动：.venv/bin/python -m worker  &  .venv/bin/python -m agent.adapters.supervisor
```

起来即**自动接入**：worker 加入共享 Redis 消费组 `agent-workers` 分摊队列；supervisor 读共享 DB 的 `user_bots` 拉网关。后台（在另一台）零改动，**「服务状态」页直接显示这台机**（host = 它的 hostname）。

**三条铁律：**

1. **全网只能一个 supervisor** —— 两个会给每个 bot 各拉一条 WS → 同 bot 双连接、平台冲突。网关机只此一台跑 supervisor，其余机器只跑 worker。
2. **worker 可多台**（消费组自动分摊），但同用户并发目前会乱序/串取消——多机前先做 `user_gate`/分片（见 `[并发优化ROADMAP.md](并发优化ROADMAP.md)` ①/③）。
3. **周期清理任务只一处跑**（web 那台），别在网关机重复（见 roadmap 进程优化 A）。

### 4.4 跨主机的 Admin 限制

- **能看**：服务状态 / 队列水位 / 网关列表（心跳走共享 Redis，全局可见）。
- **不能配 / 重启**：Admin 改配置写的是**本机** `config.override.json`、重启只杀**本机** pid → 推不到另一台。远端机要改配置/重启，需 **ssh 上那台改 `.env` + 重启**。
- 想「Admin 填个 IP 就配好/重启远端」需建 Redis 控制面（共享配置 + pub/sub 失效 + 命令频道），暂未做。

---

## 5. 日常运维

```bash
cd backend
make status              # web 状态 + 健康检查
make logs                # web 实时日志
sudo systemctl status gugu-worker gugu-supervisor    # IM 进程
sudo journalctl -u gugu-supervisor -f                # 看频道起停日志
```

### 5.1 强制关闭 / 重启后端

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
# 再重新启动（前台测试用；常驻请走 systemd，见 §3.5）
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

> ⚠️ 进程已被 systemd 托管时**别用 `pkill`**——杀了会被 `Restart` 立刻拉起、看着像「关不掉」，用 `systemctl stop/restart`。
> ⚠️ 改了 `agent/` 大脑代码要重启的是 **worker**，不是 backend（见 §2.7 注）。

## 6. 更新部署

```bash
# scp/rsync 传新代码后：
cd backend
make update              # = deps + migrate（装依赖 + 跑迁移）
make restart             # 重启 web
sudo systemctl restart gugu-worker gugu-supervisor   # 重启 IM（若改了 agent 代码）
cd ../frontend && npm install && npm run build        # 前端重新构建
# 或一键：make deploy（备份 + 依赖 + 迁移 + 前端 build + 重启）
```

> ⚠️ **务必 `make migrate`，别只 restart**：启动时的 `create_all` **只建缺失的表、不会给已有表加新列**。所以凡是新增了模型列（如 `conversation_messages.files` 文件卡片、`conversation_sessions.source` 会话来源），只重启不跑迁移 → 相关写入会因「列不存在」报错。`make update` / `make deploy` 已含 migrate；手动更新记得补 `make migrate`。

### 6.1 zip 打包上传更新（无 git 时）

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

> **更稳的做法**：生产配一次 git deploy key（见 §3.4.1），以后更新就 `git pull` + 重启——git 只动跟踪文件，`.env`/`.venv`/`uploads` 都 gitignore、永不被碰，天然无「覆盖状态」风险，省去每次手动排除。

## 7. 备份

```bash
cd backend && make backup     # 备份数据库 + uploads + config.override.json
```

> `uploads/` 含用户文件 + 咕咕 `.agent/` 记忆；`config.override.json` 含所有 Admin 配置（含明文凭据）。两者都要备。

---

## 8. 常见问题


| 现象                                     | 解法                                                      |
| -------------------------------------- | ------------------------------------------------------- |
| 后端 500 / 启动失败                          | 必须从 `backend/` 目录起（否则 `.env` 不加载）；查 `logs/gugu.log`     |
| 生成 Word/PDF/Excel 失败                   | 没装 **LibreOffice**（`apt install libreoffice`）           |
| 聊天流式（SSE）被截断                           | nginx 要 `proxy_buffering off` + 拉长 `proxy_read_timeout` |
| IM 收不到/回不出                             | Redis 没起；或 supervisor/worker 没跑；详见 feishu接入指南排错表        |
| worker `Timeout reading from ...:6379` | 已修：`app/core/redis.py` `socket_timeout=None`（旧版本需更新代码）  |
| Admin 频道保存「消失」                         | 后端加了 `/admin/agent/bots` 接口后要 `make restart`            |
| `pip install` 报 externally-managed     | 用 `.venv/bin/pip`（绝对路径），别用系统 pip                        |
| 登录/接口报 `ERR_SSL_UNRECOGNIZED_NAME_ALERT`（页面能开、API 失败） | **SSL 证书没覆盖该域名**（如证书只签了 `gugugu.site`，没含 `www.gugugu.site`）。1Panel 网站→证书 重签 Let's Encrypt，**域名列表同时勾 `gugugu.site` + `www.gugugu.site`**（或通配 `*.gugugu.site`）；前提是该域名 DNS 已解析到本机。验证：`echo \| openssl s_client -servername www.gugugu.site -connect www.gugugu.site:443 2>/dev/null \| openssl x509 -noout -ext subjectAltName` 看 SAN 里有没有该域名 |
| `make install` 后 gugu-backend 一直重启   | 旧的手动 `uvicorn :8000` 没停、占着端口 → systemd 版绑不上崩 → `Restart` 循环。`systemctl stop gugu-backend` + `pkill -9 -f "uvicorn app.main"` + `fuser -k 8000/tcp` 清掉再 `systemctl start`（详见 §3.5 / §5.1） |
| nginx `duplicate location "/"` 启动失败 | 反向代理路径填成了 `/`（整站代理给后端）和伪静态 `location /` 撞 → 反代路径必须是 `/api`（详见 §3.4.1） |


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


